import yaml from "js-yaml";
import { acquireLock, releaseLock } from "../lib/lock.js";
import { readFile } from "../lib/github.js";
import { synthesizeTasksPrompt } from "../lib/prompts.js";
import { requireEnv } from "../lib/env.js";
import { sbRequest } from "../lib/supabase.js";
function normTitle(t = "") { return t.toLowerCase().replace(/\s+/g, " ").replace(/[`"'*]/g, "").trim(); }
function normType(t = "") { return t.toLowerCase() === "idea" ? "idea" : "task"; }
function yamlBlock(obj) { return "```yaml\n" + yaml.dump(obj, { lineWidth: 120 }) + "```"; }
function isMeta(t) { return /batch task synthesis/i.test(t?.title || "") || /```/.test(t?.desc || ""); }
export function compareTasks(a, b) {
    const pa = a.priority ?? 1e9, pb = b.priority ?? 1e9;
    if (pa !== pb)
        return pa - pb;
    const ca = a.created instanceof Date ? a.created.toISOString() : String(a.created ?? "");
    const cb = b.created instanceof Date ? b.created.toISOString() : String(b.created ?? "");
    if (ca !== cb)
        return ca.localeCompare(cb);
    return normTitle(a.title).localeCompare(normTitle(b.title));
}
export async function synthesizeTasks() {
    if (!(await acquireLock())) {
        console.log("Lock taken; exiting.");
        return;
    }
    try {
        requireEnv(["TARGET_OWNER", "TARGET_REPO", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]);
        const vision = (await readFile("roadmap/vision.md")) || "";
        const rows = (await sbRequest(`roadmap_items?select=*`)).map((r) => ({
            ...r,
            created: r.created,
        }));
        const tasks = rows.filter(r => r.type === "task");
        const bugs = rows.filter(r => r.type === "bug");
        const ideas = rows.filter(r => r.type === "idea");
        const done = rows.filter(r => r.type === "done").map(r => r.content || "").join("\n");
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
        let parsed = {};
        try {
            parsed = yaml.load(toParse) || {};
        }
        catch {
            parsed = {};
        }
        let proposed = Array.isArray(parsed.items) ? parsed.items : [];
        proposed = proposed.filter(t => t?.title && !isMeta(t));
        // Merge & dedupe
        const seen = new Set();
        const merged = [];
        for (const t of [...tasks, ...proposed]) {
            const key = (t.id && `id:${t.id.toLowerCase().trim()}`) ||
                `tt:${normType(t.type)}|${normTitle(t.title)}`;
            if (seen.has(key))
                continue;
            seen.add(key);
            merged.push(t);
        }
        // Unique priorities
        merged.sort(compareTasks);
        const limited = merged.slice(0, 100).map((t, i) => ({ ...t, priority: i + 1 }));
        const toRow = (t) => {
            const created = t.created;
            let createdIso = null;
            if (created) {
                const d = new Date(created);
                createdIso = Number.isNaN(d.valueOf()) ? null : d.toISOString();
            }
            return {
                id: t.id ?? null,
                title: t.title ?? null,
                type: "task",
                content: t.content ?? t.desc ?? null,
                priority: t.priority ?? null,
                created: createdIso,
                source: t.source ?? null,
            };
        };
        // Upsert tasks in Supabase only if new tasks were synthesized
        if (proposed.length > 0) {
            const rows = limited.map(toRow);
            const toUpdate = rows.filter(r => r.id !== null);
            const toInsert = rows.filter(r => r.id === null).map(({ id, ...rest }) => rest);
            const hasUniformKeys = (arr) => {
                if (arr.length <= 1)
                    return true;
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
                await sbRequest("roadmap_items", {
                    method: "POST",
                    headers: { Prefer: "resolution=merge-duplicates" },
                    body: JSON.stringify(toUpdate),
                });
            }
            if (toInsert.length) {
                await sbRequest("roadmap_items", {
                    method: "POST",
                    body: JSON.stringify(toInsert),
                });
            }
            const idsToDelete = tasks
                .filter(t => t.id && !limited.some(l => l.id === t.id))
                .map(t => `'${t.id}'`);
            if (idsToDelete.length) {
                await sbRequest(`roadmap_items?id=in.(${idsToDelete.join(',')})`, { method: "DELETE" });
            }
            await sbRequest(`roadmap_items?type=eq.idea`, { method: "DELETE" });
        }
        else {
            console.log("No new tasks synthesized; skipping Supabase task update.");
        }
        console.log(`Synthesis complete. Tasks: ${limited.length}`);
    }
    finally {
        await releaseLock();
    }
}
