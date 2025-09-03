import yaml from "js-yaml";
import { acquireLock, releaseLock } from "../lib/lock.js";
import { readFile } from "../lib/github.js";
import { synthesizeTasksPrompt } from "../lib/prompts.js";
import { ENV, requireEnv } from "../lib/env.js";

type Task = { id?: string; type?: string; title?: string; desc?: string; content?: string; source?: string; created?: string | number | Date; priority?: number };

function normTitle(t = "") { return t.toLowerCase().replace(/\s+/g, " ").replace(/[`"'*]/g, "").trim(); }
function normType(t = "") { return t.toLowerCase() === "idea" ? "idea" : "task"; }
function yamlBlock(obj: any) { return "```yaml\n" + yaml.dump(obj, { lineWidth: 120 }) + "```"; }
function isMeta(t: Task) { return /batch task synthesis/i.test(t?.title || "") || /```/.test(t?.desc || ""); }

export function compareTasks(a: Task, b: Task) {
  const pa = a.priority ?? 1e9, pb = b.priority ?? 1e9;
  if (pa !== pb) return pa - pb;
  const ca = a.created instanceof Date ? a.created.toISOString() : String(a.created ?? "");
  const cb = b.created instanceof Date ? b.created.toISOString() : String(b.created ?? "");
  if (ca !== cb) return ca.localeCompare(cb);
  return normTitle(a.title!).localeCompare(normTitle(b.title!));
}

export async function synthesizeTasks() {
  if (!(await acquireLock())) { console.log("Lock taken; exiting."); return; }
  try {
    try {
      requireEnv(["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "TARGET_REPO"]);
    } catch (err) {
      if (err instanceof Error && err.message.includes("TARGET_REPO")) {
        throw new Error("Missing env: TARGET_REPO. Set TARGET_REPO before running this command.");
      }
      throw err;
    }

    const vision = (await readFile("roadmap/vision.md")) || "";

    const headers = { apikey: ENV.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${ENV.SUPABASE_SERVICE_ROLE_KEY}` };
    const url = ENV.SUPABASE_URL;
    const res = await fetch(`${url}/rest/v1/roadmap_items?select=*`, { headers });
    if (!res.ok) throw new Error(`Supabase fetch failed: ${res.status}`);
    const rows: Task[] = (await res.json()).map((r: any) => ({
      ...r,
      created: r.created ?? r.created_at,
    }));

    const tasks = rows.filter(r => r.type === "task");
    const bugs  = rows.filter(r => r.type === "bug");
    const ideas = rows.filter(r => r.type === "idea");
    const done  = rows.filter(r => r.type === "done").map(r => r.content || "").join("\n");

    const proposal = await synthesizeTasksPrompt({
      tasks: yamlBlock({ items: tasks }),
      bugs: yamlBlock({ items: bugs }),
      ideas: yamlBlock({ items: ideas }),
      vision,
      done
    });

    // Extract YAML
    const m = proposal.match(/```yaml\s*?\n([\s\S]*?)\n```/);
    const toParse = m ? m[1] : proposal;
    let parsed: any = {};
    try { parsed = yaml.load(toParse) || {}; } catch { parsed = {}; }
    let proposed: Task[] = Array.isArray(parsed.items) ? parsed.items : [];
    proposed = proposed.filter(t => t?.title && !isMeta(t));

    // Merge & dedupe
    const seen = new Set<string>();
    const merged: Task[] = [];
    for (const t of [...tasks, ...proposed]) {
      const key = (t.id && `id:${t.id.toLowerCase().trim()}`) ||
                  `tt:${normType(t.type)}|${normTitle(t.title!)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(t);
    }

    // Unique priorities
    merged.sort(compareTasks);
    const limited = merged.slice(0, 100).map((t, i) => ({ ...t, priority: i + 1 }));

    const toRow = (t: Task) => {
      const created = (t as any).created ?? (t as any).created_at;
      return {
        id: t.id ?? null,
        title: t.title ?? null,
        type: "task",
        content: t.content ?? t.desc ?? null,
        priority: t.priority ?? null,
        created_at: created ? new Date(created).toISOString() : null,
        source: t.source ?? null,
      };
    };

    // Upsert tasks in Supabase only if new tasks were synthesized
    if (proposed.length > 0) {
      const rows = limited.map(toRow);
      const toUpdate = rows.filter(r => r.id !== null);
      const toInsert = rows.filter(r => r.id === null).map(({ id, ...rest }) => rest);

      const hasUniformKeys = (arr: any[]) => {
        if (arr.length <= 1) return true;
        const keys = Object.keys(arr[0]).sort();
        return arr.every(r => {
          const k = Object.keys(r).sort();
          return k.length === keys.length && k.every((v, i) => v === keys[i]);
        });
      };

      if (!hasUniformKeys(toUpdate) || !hasUniformKeys(toInsert)) {
        throw new Error("Non-uniform keys in Supabase task payload");
      }

      if (toUpdate.length) {
        const upsert = await fetch(`${url}/rest/v1/roadmap_items`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
          body: JSON.stringify(toUpdate),
        });
        if (!upsert.ok) {
          const text = (await upsert.text()).slice(0, 200);
          throw new Error(`Supabase upsert tasks failed (${upsert.status}): ${text}`);
        }
      }

      if (toInsert.length) {
        const insert = await fetch(`${url}/rest/v1/roadmap_items`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify(toInsert),
        });
        if (!insert.ok) {
          const text = (await insert.text()).slice(0, 200);
          throw new Error(`Supabase insert tasks failed (${insert.status}): ${text}`);
        }
      }

      const idsToDelete = tasks
        .filter(t => t.id && !limited.some(l => l.id === t.id))
        .map(t => `'${t.id}'`);
      if (idsToDelete.length) {
        const delTasks = await fetch(
          `${url}/rest/v1/roadmap_items?id=in.(${idsToDelete.join(',')})`,
          { method: "DELETE", headers }
        );
        if (!delTasks.ok) throw new Error(`Supabase delete tasks failed: ${delTasks.status}`);
      }

      const delIdeas = await fetch(`${url}/rest/v1/roadmap_items?type=eq.idea`, { method: "DELETE", headers });
      if (!delIdeas.ok) throw new Error(`Supabase delete ideas failed: ${delIdeas.status}`);
    } else {
      console.log("No new tasks synthesized; skipping Supabase task update.");
    }

    console.log(`Synthesis complete. Tasks: ${limited.length}`);
  } finally {
    await releaseLock();
  }
}
