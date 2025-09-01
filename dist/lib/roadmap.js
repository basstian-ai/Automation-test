import { supabase } from "./supabase.js";
export async function insertRoadmap(items) {
    const { error } = await supabase.from("roadmap").insert(items);
    if (error)
        throw error;
}
export async function upsertRoadmap(items) {
    const { error } = await supabase
        .from("roadmap")
        .upsert(items, { onConflict: "id" });
    if (error)
        throw error;
}
