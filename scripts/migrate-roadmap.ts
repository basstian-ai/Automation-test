import { promises as fs } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { upsertRoadmap, type RoadmapItem } from "../src/lib/roadmap.js";
import { readYamlBlock } from "../src/lib/md.js";

type Task = {
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
  const items: RoadmapItem[] = tasks.map(t => ({
    id:
      t.id ||
      createHash("sha1")
        .update(t.title ?? "")
        .update(t.desc ?? "")
        .digest("hex"),
    type: t.type === "bug" ? "bug" : "idea",
    title: t.title ?? "",
    details: t.desc ?? "",
    created: t.created ?? new Date().toISOString(),
  }));
  await upsertRoadmap(items);
  console.log(`Migrated ${items.length} tasks to Supabase.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
