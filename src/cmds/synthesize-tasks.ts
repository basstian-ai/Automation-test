import yaml from "js-yaml";
import { acquireLock, releaseLock } from "../lib/lock.js";
import { readFile } from "../lib/github.js";
import { synthesizeTasksPrompt } from "../lib/prompts.js";
import { ENV, requireEnv } from "../lib/env.js";

type Task = { id?: string; type?: string; title?: string; desc?: string; source?: string; created?: string; priority?: number };

function normTitle(t = "") { return t.toLowerCase().replace(/\s+/g, " ").replace(/[`"'*]/g, "").trim(); }
function normType(t = "") { return t.toLowerCase() === "idea" ? "idea" : "task"; }
function yamlBlock(obj: any) { return "```yaml\n" + yaml.dump(obj, { lineWidth: 120 }) + "```"; }
function isMeta(t: Task) { return /batch task synthesis/i.test(t?.title || "") || /```/.test(t?.desc || ""); }

export async function synthesizeTasks() {
  if (!(await acquireLock())) { console.log("Lock taken; exiting."); return; }
  try {
    requireEnv(["SUPABASE_URL", "SUPABASE_KEY"]);
    const vision = (await readFile("roadmap/vision.md")) || "";
    const doneMd  = (await readFile("roadmap/done.md"))  || "";

    const headers = { apikey: ENV.SUPABASE_KEY, Authorization: `Bearer ${ENV.SUPABASE_KEY}` };
    const url = ENV.SUPABASE_URL;
    const res = await fetch(`${url}/rest/v1/roadmap_items?select=*`, { headers });
    if (!res.ok) throw new Error(`Supabase fetch failed: ${res.status}`);
    const rows: Task[] = await res.json();

    const tasks = rows.filter(r => r.type === "task");
    const bugs  = rows.filter(r => r.type === "bug");
    const ideas = rows.filter(r => r.type === "idea");

    const proposal = await synthesizeTasksPrompt({
      tasks: yamlBlock({ items: tasks }),
      bugs: yamlBlock({ items: bugs }),
      ideas: yamlBlock({ items: ideas }),
      vision,
      done: doneMd
    });

    // Extract YAML (fenced or bare)
    const m = proposal.match(/```yaml\s*?\n([\s\S]*?)\n```/);
    const toParse = m ? m[1] : proposal;
    let parsed: any = {};
    try { parsed = yaml.load(toParse) || {}; } catch { parsed = {}; }
    let proposed: Task[] = Array.isArray(parsed.items) ? parsed.items : [];
    proposed = proposed.filter(t => t?.title && !isMeta(t));

    // Existing tasks
    const existing = tasks;

    // Merge & dedupe
    const seen = new Set<string>();
    const merged: Task[] = [];
    for (const t of [...existing, ...proposed]) {
      const key = (t.id && `id:${t.id.toLowerCase().trim()}`) ||
                  `tt:${normType(t.type)}|${normTitle(t.title!)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(t);
    }

    // Unique priorities 1..N (≤100)
    merged.sort((a, b) => {
      const pa = a.priority ?? 1e9, pb = b.priority ?? 1e9;
      if (pa !== pb) return pa - pb;
      const ca = a.created || "", cb = b.created || "";
      if (ca !== cb) return ca.localeCompare(cb);
      return normTitle(a.title!).localeCompare(normTitle(b.title!));
    });
    const limited = merged.slice(0, 100).map((t, i) => ({ ...t, priority: i + 1 }));

    // Upsert tasks and clear processed ideas in Supabase
    const delTasks = await fetch(`${url}/rest/v1/roadmap_items?type=eq.task`, { method: "DELETE", headers });
    if (!delTasks.ok) throw new Error(`Supabase delete tasks failed: ${delTasks.status}`);
    const upsert = await fetch(`${url}/rest/v1/roadmap_items`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify(limited.map(t => ({ ...t, type: "task" }))),
    });
    if (!upsert.ok) throw new Error(`Supabase upsert tasks failed: ${upsert.status}`);
    const delIdeas = await fetch(`${url}/rest/v1/roadmap_items?type=eq.idea`, { method: "DELETE", headers });
    if (!delIdeas.ok) throw new Error(`Supabase delete ideas failed: ${delIdeas.status}`);

    console.log(`Synthesis complete. Tasks: ${limited.length}`);
  } finally {
    await releaseLock();
  }
}

