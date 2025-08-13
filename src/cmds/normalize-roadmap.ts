// src/cmds/normalize-roadmap.ts
import yaml from "js-yaml";
import { acquireLock, releaseLock } from "../lib/lock.js";
import { requireEnv } from "../lib/env.js";
import { readFile, upsertFile } from "../lib/github.js";

type Task = {
  id?: string;
  type?: "bug" | "improvement" | "feature" | string;
  title?: string;
  desc?: string;
  source?: string;
  created?: string;
  priority?: number;
};

function normTitle(t: string = "") {
  return t.toLowerCase().replace(/\s+/g, " ").replace(/[`"'*]/g, "").trim();
}

function yamlBlock(obj: any) {
  return "```yaml\n" + yaml.dump(obj, { lineWidth: 120 }) + "```";
}

function extractItems(md: string): Task[] {
  const blocks = [...md.matchAll(/```yaml\s*?\n([\s\S]*?)\n```/g)];
  const items: Task[] = [];
  for (const m of blocks) {
    try {
      const parsed = yaml.load(m[1]) as any;
      if (parsed && Array.isArray(parsed.items)) items.push(...parsed.items);
      if (parsed && Array.isArray(parsed.queue)) {
        // ignore queues (ideas/bugs) in tasks.md if they slipped in
      }
    } catch {
      /* ignore */
    }
  }
  return items;
}

export async function normalizeRoadmap() {
    requireEnv(["PAT_TOKEN", "TARGET_REPO"]);
  if (!(await acquireLock())) { console.log("Lock taken; exiting."); return; }
  try {
    const path = "roadmap/tasks.md";
    const raw = (await readFile(path)) || "# Tasks (single source of truth)\n\n```yaml\nitems: []\n```";
    let items = extractItems(raw);

    // Drop synthetic/meta entries that contain YAML or "Batch task synthesis"
    items = items.filter(t =>
      t && t.title &&
      !/batch task synthesis/i.test(t.title) &&
      !(t.desc && /```yaml/.test(t.desc))
    );

    // Dedupe by id (if present) else by (type + normalized title)
    const seen = new Set<string>();
    const deduped: Task[] = [];
    for (const t of items) {
      const key = (t.id?.toLowerCase()?.trim() && `id:${t.id.toLowerCase().trim()}`) ||
                  `tt:${(t.type||"").toLowerCase()}|${normTitle(t.title)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(t);
    }

    // Sort by existing priority, then created timestamp, then title
    deduped.sort((a, b) => {
      const pa = a.priority ?? 1e9, pb = b.priority ?? 1e9;
      if (pa !== pb) return pa - pb;
      const ca = a.created || "", cb = b.created || "";
      if (ca !== cb) return ca.localeCompare(cb);
      return normTitle(a.title).localeCompare(normTitle(b.title));
    });

   // Reassign unique priorities 1..N and cap at 100
   const limited = deduped.slice(0, 100).map((t, i) => ({ ...t, priority: i + 1 }));

    const header = "# Tasks (single source of truth)\n\n";
    const next = header + yamlBlock({ items: limited }) + "\n";

    await upsertFile(path, () => next, "bot: normalize tasks (dedupe + unique priorities)");
    console.log(`Normalized tasks.md — kept ${limited.length} items with unique priorities.`);
  } finally {
    await releaseLock();
  }
}
