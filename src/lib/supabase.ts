
import { createClient } from "@supabase/supabase-js";
import { ENV, requireEnv } from "./env.js";

requireEnv(["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]);
export const supabase = createClient(ENV.SUPABASE_URL, ENV.SUPABASE_SERVICE_ROLE_KEY);
export type RoadmapItem = {
  title: string;
  description: string;
  status: "planned" | "in-progress" | "complete";
};

export async function insertRoadmap(item: RoadmapItem) {
  const { error } = await supabase.from("roadmap").insert(item);
  if (error) throw error;
}
