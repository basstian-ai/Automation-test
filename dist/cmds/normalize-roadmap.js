import yaml from "js-yaml";
import { acquireLock, releaseLock } from "../lib/lock.js";
import { readFile, upsertFile } from "../lib/github.js";
function normTitle(t = "") {
    return t.toLowerCase().replace(/\s+/g, " ").replace(/[`"'*]/g, "").trim();
}
function yamlBlock(obj) {
    return "```yaml\n" + yaml.dump(obj, { lineWidth: 120 }) + "```";
}
function extractAllItems(md) {
    const blocks = [...md.matchAll(/```yaml\s*?\n([\s\S]*?)\n```/g)];
    const out = [];
    for (const m of blocks) {
        try {
            const parsed = yaml.load(m[1]);
            if (parsed && Array.isArray(parsed.items))
                out.push(...parsed.items);
        }
        catch { /* ignore */ }
    }
    return out;
}
function isMeta(t) {
    return /batch task synthesis/i.test(t?.title || "") || /```/.test(t?.desc || "");
}
export async function normalizeRoadmap() {
    if (!(await acquireLock())) {
        console.log("Lock taken; exiting.");
        return;
    }
    try {
        const path = "roadmap/tasks.md";
        const raw = (await readFile(path)) || "# Tasks (single source of truth)\n\n```yaml\nitems: []\n```";
        let items = extractAllItems(raw);
        // Drop synthetic/meta tasks
        items = items.filter(t => t?.title && !isMeta(t));
        // Dedupe by id else (type+title)
        const seen = new Set();
        const deduped = [];
        for (const t of items) {
            const key = (t.id && `id:${t.id.toLowerCase().trim()}`) ||
                `tt:${(t.type || "").toLowerCase()}|${normTitle(t.title)}`;
            if (seen.has(key))
                continue;
            seen.add(key);
            deduped.push(t);
        }
        // Sort & assign unique priorities (cap 100)
        deduped.sort((a, b) => {
            const pa = a.priority ?? 1e9, pb = b.priority ?? 1e9;
            if (pa !== pb)
                return pa - pb;
            const ca = a.created || "", cb = b.created || "";
            if (ca !== cb)
                return ca.localeCompare(cb);
            return normTitle(a.title).localeCompare(normTitle(b.title));
        });
        const limited = deduped.slice(0, 100).map((t, i) => ({ ...t, priority: i + 1 }));
        const header = "# Tasks (single source of truth)\n\n";
        const next = header + yamlBlock({ items: limited }) + "\n";
        await upsertFile(path, () => next, "bot: normalize tasks (single block, dedupe, unique priorities)");
        console.log(`Normalized tasks.md — kept ${limited.length} items.`);
    }
    finally {
        await releaseLock();
    }
}
