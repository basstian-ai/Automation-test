import yaml from "js-yaml";
import { acquireLock, releaseLock } from "../lib/lock.js";
import { upsertFile } from "../lib/github.js";
import { supabase } from "../lib/supabase.js";

type Task = {
  id?: string;
  type?: "bug" | "improvement" | "feature" | string;
  title?: string;
  desc?: string;
  source?: string;
  created?: string;
  priority?: number;
};

function normTitle(t = "") {
  return t.toLowerCase().replace(/\s+/g, " ").replace(/[`"'*]/g, "").trim();
}
function isMeta(t: Task) {
  return /batch task synthesis/i.test(t?.title || "") || /```/.test(t?.desc || "");
}

export async function normalizeRoadmap() {
  if (!(await acquireLock())) { console.log("Lock taken; exiting."); return; }
  try {
    const { data, error } = await supabase.from("tasks").select("*");
    if (error) throw error;
    let items = (data || []) as Task[];

    // Drop synthetic/meta tasks
    items = items.filter(t => t?.title && !isMeta(t));

    // Dedupe by id else (type+title)
    const seen = new Set<string>();
    const deduped: Task[] = [];
    const dupIds: string[] = [];
    for (const t of items) {
      const key = (t.id && `id:${t.id.toLowerCase().trim()}`) ||
                  `tt:${(t.type||"").toLowerCase()}|${normTitle(t.title!)}`;
      if (seen.has(key)) { if (t.id) dupIds.push(t.id); continue; }
      seen.add(key);
      deduped.push(t);
    }
    if (dupIds.length) await supabase.from("tasks").delete().in("id", dupIds);

    // Sort & assign unique priorities (cap 100)
    deduped.sort((a, b) => {
      const pa = a.priority ?? 1e9, pb = b.priority ?? 1e9;
      if (pa !== pb) return pa - pb;
      const ca = a.created || "", cb = b.created || "";
      if (ca !== cb) return ca.localeCompare(cb);
      return normTitle(a.title!).localeCompare(normTitle(b.title!));
    });
    const updates = deduped.map((t, i) => ({ id: t.id!, priority: i < 100 ? i + 1 : null }));
    if (updates.length) await supabase.from("tasks").upsert(updates, { onConflict: "id" });

    const header = "# Tasks (single source of truth)\n\n";
    const fileTasks = deduped.slice(0, 100).map((t, i) => ({ ...t, priority: i + 1 }));
    const block = "```yaml\n" + yaml.dump({ items: fileTasks }, { lineWidth: 120 }) + "```\n";
    await upsertFile("roadmap/tasks.md", () => header + block, "bot: normalize tasks (supabase source)");

    console.log(`Normalized tasks — enforced priorities for ${Math.min(deduped.length, 100)} items.`);
  } finally {
    await releaseLock();
  }
}

