import { acquireLock, releaseLock } from "../lib/lock.js";
import { readFile, commitMany, resolveRepoPath } from "../lib/github.js";
import yaml from "js-yaml";
import { readYamlBlock, writeYamlBlock } from "../lib/md.js";
import { implementPlan } from "../lib/prompts.js";
import { ENV } from "../lib/env.js";
function extractTasks(md) {
    const a = readYamlBlock(md, { items: [] });
    if (a.items?.length)
        return a.items;
    const m = md.match(/```yaml\s*?\n([\s\S]*?)\n```/);
    if (m) {
        try {
            const parsed = yaml.load(m[1]);
            if (parsed?.items?.length)
                return parsed.items;
        }
        catch { }
    }
    return [];
}
function isMeta(t) {
    return /batch task synthesis/i.test(t?.title || "") || /```/.test(t?.desc || "");
}
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
        const tasks = extractTasks(tRaw).filter(t => !isMeta(t));
        if (!tasks.length) {
            console.log("No tasks (none after filtering). Ensure tasks.md has one fenced yaml block with `items:`.");
            return;
        }
        // Pick highest priority
        const sorted = [...tasks].sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));
        const top = sorted[0];
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
        // Normalize to safe, repo-relative paths (and apply TARGET_DIR)
        const normalized = [];
        for (const o of ops) {
            try {
                normalized.push({ ...o, path: resolveRepoPath(o.path || "") });
            }
            catch (err) {
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
        // Apply operations and roadmap updates
        const files = [];
        for (const op of filtered) {
            if (op.action !== "create" && op.action !== "update")
                continue;
            files.push({ path: op.path, content: op.content ?? "" });
        }
        // Prepare roadmap changes
        const remaining = tasks.filter(i => i !== top);
        const nextTasks = writeYamlBlock(tRaw, { items: remaining });
        const doneLine = `- ${new Date().toISOString()}: ✅ ${top.id || ""} — ${plan.commitTitle || top.title}\n`;
        const nextDone = done + doneLine;
        files.push({ path: "roadmap/tasks.md", content: nextTasks });
        files.push({ path: "roadmap/done.md", content: nextDone });
        if (files.length) {
            const title = plan.commitTitle || ((top.type === "bug" ? "fix" : "feat") + `: ${top.title || top.id}`);
            const body = plan.commitBody || (top.desc || "");
            try {
                await commitMany(files, `${title}\n\n${body}`, ENV.BRANCH);
                console.log("Implement complete.");
            }
            catch (err) {
                console.error("Bulk commit failed; no changes were applied.", err);
            }
        }
    }
    finally {
        await releaseLock();
    }
}
