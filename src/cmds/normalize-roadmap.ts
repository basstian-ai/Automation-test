import { createClient } from "@supabase/supabase-js";
import { acquireLock, releaseLock } from "../lib/lock.js";
import type { Task } from "../lib/types.js";
import { ENV } from "../lib/env.js";

function normTitle(t = "") {
  return t.toLowerCase().replace(/\s+/g, " ").replace(/[`"'*]/g, "").trim();
}
function isMeta(t: Task) {
  return /batch task synthesis/i.test(t?.title || "") || /```/.test(t?.desc || "");
}

export async function normalizeRoadmap() {
  if (!(await acquireLock())) { console.log("Lock taken; exiting."); return; }
  try {
    const supabase = createClient(ENV.SUPABASE_URL, ENV.SUPABASE_SERVICE_ROLE_KEY);
    const { data, error } = await supabase
      .from("roadmap_items")
      .select("*")
      .eq("type", "task");
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
    if (dupIds.length) await supabase
      .from("roadmap_items")
      .delete()
      .eq("type", "task")
      .in("id", dupIds);

    // Sort & assign unique priorities (cap 100)
    deduped.sort((a, b) => {
      const pa = a.priority ?? 1e9, pb = b.priority ?? 1e9;
      if (pa !== pb) return pa - pb;
      const ca = a.created || "", cb = b.created || "";
      if (ca !== cb) return ca.localeCompare(cb);
      return normTitle(a.title!).localeCompare(normTitle(b.title!));
    });
    const updates = deduped.map((t, i) => ({
      id: t.id!,
      type: "task",
      priority: i < 100 ? i + 1 : null,
    }));
    if (updates.length) await supabase
      .from("roadmap_items")
      .upsert(updates, { onConflict: "id" });

    console.log(
      `Normalized tasks — enforced priorities for ${Math.min(deduped.length, 100)} items in Supabase.`
    );
  } finally {
    await releaseLock();
  }
}

