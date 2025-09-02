import { createClient } from "@supabase/supabase-js";

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Missing Supabase credentials: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  const supabase = createClient(url, key);
  const { count, error } = await supabase
    .from("roadmap_items")
    .select("*", { count: "exact", head: true })
    .eq("type", "task")
    .not("priority", "is", null);
  if (error) throw error;
  if (!count) {
    throw new Error("No prioritized tasks found");
  }
  console.log(`Found ${count} prioritized tasks.`);
}

main();
