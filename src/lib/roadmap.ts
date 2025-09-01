import { supabase } from "./supabase.js";

export type RoadmapItem = {
  id: string;
  type: "bug" | "idea";
  title: string;
  details: string;
  created: string;
};

export async function insertRoadmap(items: RoadmapItem[]) {
  const { error } = await supabase.from("roadmap").insert(items);
  if (error) throw error;
}

export async function upsertRoadmap(items: RoadmapItem[]) {
  const { error } = await supabase
    .from("roadmap")
    .upsert(items, { onConflict: "id" });
  if (error) throw error;
}

