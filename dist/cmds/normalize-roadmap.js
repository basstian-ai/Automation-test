import { createClient } from "@supabase/supabase-js";
import { acquireLock, releaseLock } from "../lib/lock.js";
import { ENV } from "../lib/env.js";
import yaml from "js-yaml";
function normTitle(t = "") {
    return t.toLowerCase().replace(/\s+/g, " ").replace(/[`"'*]/g, "").trim();
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
        const supabase = createClient(ENV.SUPABASE_URL, ENV.SUPABASE_SERVICE_ROLE_KEY);
        const { data, error } = await supabase
            .from("roadmap_items")
            .select("*")
            .in("type", ["task", "new"]);
        if (error)
            throw error;
        let items = (data || []).map((t) => {
            let item = {
                ...t,
                created: t.created ?? t.created_at,
            };
            if (t.type === "new") {
                try {
                    const parsed = yaml.load(t.content);
                    item = {
                        ...item,
                        type: "task",
                        title: parsed?.title || t.title,
                        desc: parsed?.details || parsed?.desc,
                        created: parsed?.created || item.created,
                    };
                }
                catch {
                    item = { ...item, type: "task" };
                }
            }
            return item;
        });
        // Drop synthetic/meta tasks
        items = items.filter(t => t?.title && !isMeta(t));
        // Dedupe by id else (type+title)
        const seen = new Set();
        const deduped = [];
        const dupIds = [];
        for (const t of items) {
            const key = (t.id && `id:${t.id.toLowerCase().trim()}`) ||
                `tt:${(t.type || "").toLowerCase()}|${normTitle(t.title)}`;
            if (seen.has(key)) {
                if (t.id)
                    dupIds.push(t.id);
                continue;
            }
            seen.add(key);
            deduped.push(t);
        }
        if (dupIds.length)
            await supabase
                .from("roadmap_items")
                .delete()
                .in("id", dupIds);
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
        const updates = deduped.map((t, i) => ({
            id: t.id,
            type: "task",
            priority: i < 100 ? i + 1 : null,
        }));
        if (updates.length)
            await supabase
                .from("roadmap_items")
                .upsert(updates, { onConflict: "id" });
        // Remove any residual "new" entries after conversion
        await supabase.from("roadmap_items").delete().eq("type", "new");
        console.log(`Normalized tasks — enforced priorities for ${Math.min(deduped.length, 100)} items in Supabase.`);
    }
    finally {
        await releaseLock();
    }
}
