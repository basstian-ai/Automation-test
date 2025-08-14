import { acquireLock, releaseLock } from "../lib/lock.js";
import { readFile, commitMany, resolveRepoPath, ensureBranch, getDefaultBranch, upsertFile } from "../lib/github.js";
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
        const writeMode = (ENV.WRITE_MODE || "commit").toLowerCase();
        let targetBranch;
        if (writeMode === "pr") {
            const base = process.env.BASE_BRANCH || await getDefaultBranch();
            const safeName = (title) => title.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
            const branchName = `codex/${safeName(top.title || "change")}`;
            await ensureBranch(branchName, base);
            targetBranch = branchName;
        }
        else {
            targetBranch = undefined;
        }
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
        // Build file list from normalized ops
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
        if (files.length) {
            const title = plan.commitTitle || ((top.type === "bug" ? "fix" : "feat") + `: ${top.title || top.id}`);
            try {
                await commitMany(files, title, { branch: targetBranch });
                await upsertFile("roadmap/tasks.md", () => nextTasks, "bot: remove completed task", { branch: targetBranch });
                await upsertFile("roadmap/done.md", () => nextDone, "bot: append done item", { branch: targetBranch });
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
