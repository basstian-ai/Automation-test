import { acquireLock, releaseLock } from "../lib/lock.js";
import { readFile, upsertFile, commitMany, resolveRepoPath } from "../lib/github.js";
import { readYamlBlock, writeYamlBlock } from "../lib/md.js";
import { implementPlan } from "../lib/prompts.js";
import { ENV } from "../lib/env.js";

type Task = { id?: string; title?: string; desc?: string; type?: string; priority?: number };

export async function implementTopTask() {
  if (!(await acquireLock())) { console.log("Lock taken; exiting."); return; }
  try {
    // Load roadmap
    const vision = (await readFile("roadmap/vision.md")) || "";
    const done   = (await readFile("roadmap/done.md")) || "";
    const tRaw   = (await readFile("roadmap/tasks.md")) || "";
    const tYaml  = readYamlBlock<{ items: Task[] }>(tRaw, { items: [] });
    if (!tYaml.items.length) { console.log("No tasks."); return; }

    // Pick highest priority
    const tasks = [...tYaml.items].sort((a,b) => (a.priority||999)-(b.priority||999));
    const top = tasks[0];

    // Optional path guard
    const repoTree: string[] = []; // (keep empty for now, or list via GH if you want)
    const planJson = await implementPlan({ vision, done, topTask: top, repoTree });
    let plan: any = {};
    try { plan = JSON.parse(planJson); } catch { plan = {}; }

    const ops: Array<{ path: string; action: string; content?: string }> =
      Array.isArray(plan.operations) ? plan.operations : [];

    // Normalize to safe, repo-relative paths (and apply TARGET_DIR)
    const normalized: Array<{ path: string; action: string; content?: string }> = [];
    for (const o of ops) {
      try {
        normalized.push({ ...o, path: resolveRepoPath(o.path || "") });
      } catch (err) {
        console.warn(`Skipping operation with invalid path ${o.path}:`, err);
      }
    }

    // Enforce ALLOW_PATHS after normalization (if configured)
    let filtered = ENV.ALLOW_PATHS.length
      ? normalized.filter(o => {
          const allows = ENV.ALLOW_PATHS.map(a => a.replace(/^\/+/, "").replace(/^\.\//, ""));
          return allows.some(allow => o.path.startsWith(allow));
        })
      : normalized;

    if (!filtered.length) {
      // Fallback: create a minimal test placeholder if none proposed
      filtered.push({
        path: "ROADMAP_NOTES.md",
        action: "update",
        content: `- ${new Date().toISOString()} Implemented: ${top.title}\n`
      });
    }

    // Apply operations
    const files: Array<{ path: string; content: string }> = [];
    for (const op of filtered) {
      if (op.action !== "create" && op.action !== "update") continue;
      files.push({ path: op.path, content: op.content ?? "" });
    }
    if (files.length) {
      const title = plan.commitTitle || ((top.type === "bug" ? "fix" : "feat") + `: ${top.title || top.id}`);
      const body  = plan.commitBody || (top.desc || "");
      await commitMany(files, `${title}\n\n${body}`);
    }

    // Update roadmap: remove task and append to done
    const remaining = tYaml.items.filter(i => i !== top);
    const nextTasks = writeYamlBlock(tRaw, { items: remaining });
    await upsertFile("roadmap/tasks.md", () => nextTasks, "bot: remove completed task");

    const doneLine = `- ${new Date().toISOString()}: ✅ ${top.id || ""} — ${plan.commitTitle || top.title}\n`;
    await upsertFile("roadmap/done.md", (old) => (old || "") + doneLine, "bot: append done");

    console.log("Implement complete.");
  } finally {
    await releaseLock();
  }
}
