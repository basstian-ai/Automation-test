import { supabase } from "./supabase.js";

export type RoadmapItem = {
  id: string;
  type: "bug" | "idea";
  title: string;
  details: string;
  created: string;
};

export async function insertRoadmap(items: RoadmapItem[]) {
  const { data, error } = await supabase
    .from("roadmap_items")
    .insert(items)
    .select();
  if (error) throw error;
  return data ?? [];
}

export async function upsertRoadmap(items: RoadmapItem[]) {
  const { data, error } = await supabase
    .from("roadmap_items")
    .upsert(items, { onConflict: "id" })
    .select();
  if (error) throw error;
  return data ?? [];
}

