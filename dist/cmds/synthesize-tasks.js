import yaml from "js-yaml";
import { acquireLock, releaseLock } from "../lib/lock.js";
import { readFile, upsertFile } from "../lib/github.js";
import { readYamlBlock } from "../lib/md.js";
import { synthesizeTasksPrompt } from "../lib/prompts.js";
import { requireEnv } from "../lib/env.js";
function normTitle(t = "") { return t.toLowerCase().replace(/\s+/g, " ").replace(/[`"'*]/g, "").trim(); }
function yamlBlock(obj) { return "```yaml\n" + yaml.dump(obj, { lineWidth: 120 }) + "```"; }
function isMeta(t) { return /batch task synthesis/i.test(t?.title || "") || /```/.test(t?.desc || ""); }
export async function synthesizeTasks() {
    if (!(await acquireLock())) {
        console.log("Lock taken; exiting.");
        return;
    }
    try {
        requireEnv(["SUPABASE_URL", "SUPABASE_KEY"]);
        async function fetchFreshIdeas() {
            const url = `${process.env.SUPABASE_URL}/rest/v1/roadmap_items?select=id,content&type=eq.new`;
            const resp = await fetch(url, {
                headers: {
                    apikey: process.env.SUPABASE_KEY,
                    Authorization: `Bearer ${process.env.SUPABASE_KEY}`,
                },
            });
            if (!resp.ok)
                return { ideas: "", ids: [] };
            const data = await resp.json();
            return {
                ideas: data.map((r) => r.content).join("\n"),
                ids: data.map((r) => r.id),
            };
        }
        async function clearFreshIdeas(ids) {
            if (ids.length === 0)
                return;
            const inClause = ids.map(id => `"${id}"`).join(",");
            const url = `${process.env.SUPABASE_URL}/rest/v1/roadmap_items?id=in.(${inClause})`;
            await fetch(url, {
                method: "DELETE",
                headers: {
                    apikey: process.env.SUPABASE_KEY,
                    Authorization: `Bearer ${process.env.SUPABASE_KEY}`,
                    "Content-Type": "application/json",
                    Prefer: "return=minimal",
                },
            });
        }
        const vision = (await readFile("roadmap/vision.md")) || "";
        const tasksMd = (await readFile("roadmap/tasks.md")) || "";
        const bugsMd = (await readFile("roadmap/bugs.md")) || "";
        const { ideas: ideasMd, ids: freshIds } = await fetchFreshIdeas();
        const doneMd = (await readFile("roadmap/done.md")) || "";
        const proposal = await synthesizeTasksPrompt({ tasks: tasksMd, bugs: bugsMd, ideas: ideasMd, vision, done: doneMd });
        // Extract YAML (fenced or bare)
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
        // Existing tasks
        const existing = readYamlBlock(tasksMd, { items: [] }).items || [];
        // Merge & dedupe
        const seen = new Set();
        const merged = [];
        for (const t of [...existing, ...proposed]) {
            const key = (t.id && `id:${t.id.toLowerCase().trim()}`) ||
                `tt:${(t.type || "").toLowerCase()}|${normTitle(t.title)}`;
            if (seen.has(key))
                continue;
            seen.add(key);
            merged.push(t);
        }
        // Unique priorities 1..N (≤100)
        merged.sort((a, b) => {
            const pa = a.priority ?? 1e9, pb = b.priority ?? 1e9;
            if (pa !== pb)
                return pa - pb;
            const ca = a.created || "", cb = b.created || "";
            if (ca !== cb)
                return ca.localeCompare(cb);
            return normTitle(a.title).localeCompare(normTitle(b.title));
        });
        const limited = merged.slice(0, 100).map((t, i) => ({ ...t, priority: i + 1 }));
        const header = "# Tasks (single source of truth)\n\n";
        const next = header + yamlBlock({ items: limited }) + "\n";
        await upsertFile("roadmap/tasks.md", () => next, "bot: synthesize tasks (merge + dedupe + single block)");
        // Clear processed ideas from Supabase so items aren't reprocessed
        await clearFreshIdeas(freshIds);
        console.log(`Synthesis complete. Tasks: ${limited.length}`);
    }
    finally {
        await releaseLock();
    }
}
