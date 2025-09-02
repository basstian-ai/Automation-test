import { supabase } from "./supabase.js";
export async function insertRoadmap(items) {
    const { data, error } = await supabase
        .from("roadmap_items")
        .insert(items)
        .select();
    if (error)
        throw error;
    return data ?? [];
}
export async function upsertRoadmap(items) {
    const { data, error } = await supabase
        .from("roadmap_items")
        .upsert(items, { onConflict: "id" })
        .select();
    if (error)
        throw error;
    return data ?? [];
}
