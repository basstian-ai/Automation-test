import { acquireLock, releaseLock } from "../lib/lock.js";
import { readFile, commitMany } from "../lib/github.js";
import { readYamlBlock, writeYamlBlock } from "../lib/md.js";
import { implementPlan } from "../lib/prompts.js";
import { ENV } from "../lib/env.js";
export async function implementTopTask() {
    if (!(await acquireLock())) {
        console.log("Lock taken; exiting.");
        return;
    }
    try {
        // Load roadmap
        const vision = (await readFile("roadmap/vision.md")) || "";
        const done = (await readFile("roadmap/done.md")) || "";
        const tRaw = (await readFile("roadmap/tasks.md")) || "";
        const tYaml = readYamlBlock(tRaw, { items: [] });
        if (!tYaml.items.length) {
            console.log("No tasks.");
            return;
        }
        // Pick highest priority
        const tasks = [...tYaml.items].sort((a, b) => (a.priority || 999) - (b.priority || 999));
        const top = tasks[0];
        // Optional path guard
        const repoTree = []; // (keep empty for now, or list via GH if you want)
        const planJson = await implementPlan({ vision, done, topTask: top, repoTree });
        let plan = {};
        try {
            plan = JSON.parse(planJson);
        }
        catch {
            plan = {};
        }
        const ops = Array.isArray(plan.operations) ? plan.operations : [];
        const filtered = ENV.ALLOW_PATHS.length
            ? ops.filter(o => ENV.ALLOW_PATHS.some(allow => o.path.startsWith(allow)))
            : ops;
        if (!filtered.length) {
            // Fallback: create a minimal test placeholder if none proposed
            filtered.push({
                path: "ROADMAP_NOTES.md",
                action: "update",
                content: `- ${new Date().toISOString()} Implemented: ${top.title}\n`
            });
        }
        // Apply operations
        const files = [];
        for (const op of filtered) {
            if (op.action !== "create" && op.action !== "update")
                continue;
            files.push({ path: op.path, content: op.content ?? "" });
        }
        // Prepare roadmap updates
        const remaining = tYaml.items.filter(i => i !== top);
        const nextTasks = writeYamlBlock(tRaw, { items: remaining });
        files.push({ path: "roadmap/tasks.md", content: nextTasks });
        const doneLine = `- ${new Date().toISOString()}: ✅ ${top.id || ""} — ${plan.commitTitle || top.title}\n`;
        files.push({ path: "roadmap/done.md", content: done + doneLine });
        if (files.length) {
            const title = plan.commitTitle || ((top.type === "bug" ? "fix" : "feat") + `: ${top.title || top.id}`);
            const body = plan.commitBody || (top.desc || "");
            try {
                await commitMany(files, `${title}\n\n${body}`);
            }
            catch (err) {
                console.error("Commit failed, rolling back", err);
                return;
            }
        }
        console.log("Implement complete.");
    }
    finally {
        await releaseLock();
    }
}
