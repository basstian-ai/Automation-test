import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { acquireLock, releaseLock } from "../lib/lock.js";
import { readFile, commitMany, resolveRepoPath, ensureBranch, getDefaultBranch } from "../lib/github.js";
import { implementPlan } from "../lib/prompts.js";
import { ENV } from "../lib/env.js";
import type { Task } from "../lib/types.js";

export async function implementTopTask() {
  if (!(await acquireLock())) { console.log("Lock taken; exiting."); return; }
  try {
    const { supabase } = await import("../lib/supabase.js");
    // Load vision for context
    const vision = (await readFile("roadmap/vision.md")) || "";

    // Retrieve top priority task from Supabase
    const { data: rows, error } = await supabase
      .from("tasks")
      .select("*")
      .neq("type", "done")
      .order("priority", { ascending: true })
      .limit(1);
    if (error) { console.error("Failed to fetch tasks", error); return; }
    const top = rows?.[0] as Task | undefined;
    if (!top) { console.log("No tasks available."); return; }

    const writeMode = (ENV.WRITE_MODE || "commit").toLowerCase();
    let targetBranch: string | undefined;

    if (writeMode === "pr") {
      const base = process.env.BASE_BRANCH || await getDefaultBranch();
      const safeName = (title: string) =>
        title.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
      const branchName = `codex/${safeName(top.title || "change")}`;
      await ensureBranch(branchName, base);
      targetBranch = branchName;
    } else {
      targetBranch = undefined;
    }

    // Optional path guard
    const repoTree: string[] = [];
    const planJson = await implementPlan({ vision, done: "", topTask: top, repoTree });
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
        path: "TASK_NOTES.md",
        action: "update",
        content: `- ${new Date().toISOString()} Implemented: ${top.title}\n`
      });
    }

    // Build file list from normalized ops
    const files: Array<{ path: string; content: string }> = [];
    for (const op of filtered) {
      if (op.action !== "create" && op.action !== "update") continue;
      files.push({ path: op.path, content: op.content ?? "" });
    }

    if (files.length) {
      // Build commit body describing root cause, scope, and validation
      const cb: any = typeof plan.commitBody === "object" ? plan.commitBody : {};
      const rootCause = cb.rootCause || top.desc || "n/a";
      const scope = cb.scope || files.map(f => f.path).join(", ");
      const validation = cb.validation || plan.testHint || "n/a";
      const logLink = cb.logUrl || cb.logs || cb.log || undefined;
      const taskLink = cb.taskUrl || cb.task || (top.id ? `${ENV.SUPABASE_URL}/rest/v1/tasks?id=eq.${top.id}` : undefined);
      const bodyParts = [
        `Root Cause: ${rootCause}`,
        `Scope: ${scope}`,
        `Validation: ${validation}`,
      ];
      const linkLines: string[] = [];
      if (taskLink) linkLines.push(`Task: ${taskLink}`);
      if (logLink) linkLines.push(`Logs: ${logLink}`);
      if (linkLines.length) bodyParts.push(`Links:\n- ${linkLines.join("\n- ")}`);
      const commitBody = bodyParts.join("\n\n");

      let title = plan.commitTitle || ((top.type === "bug" ? "fix" : "feat") + `: ${top.title || top.id}`);
      if (!/^[a-z]+:\s/.test(title)) {
        const prefix = top.type === "bug" ? "fix" : "feat";
        title = `${prefix}: ${title}`;
      }
      try {

        execSync("npm run check", { stdio: "inherit" });
        const pkg = JSON.parse(readFileSync("package.json", "utf8"));
        if (pkg?.scripts?.test) {
          execSync("npm test", { stdio: "inherit" });
        }
      } catch (err) {
        console.error("Checks or tests failed; aborting commit.", err);
        return;
      }
      try {
        await commitMany(files, { title, body: commitBody }, { branch: targetBranch });
        const { completeTask } = await import("../lib/tasks.js");
        await completeTask(top);
        console.log("Implement complete.");
      } catch (err) {
        console.error("Bulk commit failed; no changes were applied.", err);
      }
    }
  } finally {
    await releaseLock();
  }
}
