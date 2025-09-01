import { promises as fs } from "node:fs";
import { join } from "node:path";
import { supabase } from "../src/lib/supabase.js";
import { readYamlBlock } from "../src/lib/md.js";

export type Task = {
  id?: string;
  type?: "bug" | "improvement" | "feature" | string;
  title?: string;
  desc?: string;
  source?: string;
  created?: string;
  priority?: number;
};

async function readTasksFrom(dir: string): Promise<Task[]> {
  let tasks: Task[] = [];
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return tasks;
  }
  for (const file of entries) {
    if (!file.endsWith(".md") || file === "vision.md") continue;
    const fp = join(dir, file);
    try {
      const raw = await fs.readFile(fp, "utf8");
      const parsed = readYamlBlock<{ items?: Task[] }>(raw, { items: [] });
      tasks = tasks.concat(parsed.items || []);
    } catch {
      // ignore bad files
    }
  }
  return tasks;
}

async function main() {
  const dir = join(process.cwd(), "roadmap");
  const tasks = await readTasksFrom(dir);
  if (!tasks.length) {
    console.log("No roadmap files found; nothing to migrate.");
    return;
  }
  const { error } = await supabase.from("tasks").upsert(tasks, { onConflict: "id" });
  if (error) throw error;
  console.log(`Migrated ${tasks.length} tasks to Supabase.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
