import { supabase } from "./supabase.js";
import { ENV } from "./env.js";

export type RoadmapItem = {
  id: string;
  type: "bug" | "idea";
  title: string;
  content: string;
  created: string;
  repo?: string;
};

export async function insertRoadmap(items: RoadmapItem[]) {
  const withRepo = items.map(i => ({ ...i, repo: ENV.TARGET_REPO }));
  const { data, error } = await supabase
    .from("roadmap_items")
    .insert(withRepo)
    .select();
  if (error) throw error;
  return data ?? [];
}

export async function upsertRoadmap(items: RoadmapItem[]) {
  const withRepo = items.map(i => ({ ...i, repo: ENV.TARGET_REPO }));
  const { data, error } = await supabase
    .from("roadmap_items")
    .upsert(withRepo, { onConflict: "id" })
    .select();
  if (error) throw error;
  return data ?? [];
}

