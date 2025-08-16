import { acquireLock, releaseLock } from "../lib/lock.js";
import { readFile, parseRepo, gh, upsertFile } from "../lib/github.js";
import { readYamlBlock, writeYamlBlock } from "../lib/md.js";
import { reviewToIdeas, reviewToSummary } from "../lib/prompts.js";
import { loadState, saveState } from "../lib/state.js";
import { requireEnv, ENV } from "../lib/env.js";
import yaml from "js-yaml";
export async function reviewRepo() {
    if (!(await acquireLock())) {
        console.log("Lock taken; exiting.");
        return;
    }
    try {
        requireEnv(["TARGET_REPO"]);
        const vision = (await readFile("roadmap/vision.md")) || "";
        const tasks = (await readFile("roadmap/tasks.md")) || "";
        const bugs = (await readFile("roadmap/bugs.md")) || "";
        const done = (await readFile("roadmap/done.md")) || "";
        const fresh = (await readFile("roadmap/new.md")) || "";
        const state = await loadState();
        const { owner, repo } = parseRepo(ENV.TARGET_REPO);
        const commitsResp = await gh().rest.repos.listCommits({ owner, repo, per_page: 10 });
        const commitsData = [];
        for (const c of commitsResp.data) {
            if (c.sha === state.lastReviewedSha)
                break;
            commitsData.push(c);
        }
        if (commitsData.length === 0) {
            console.log("No new commits to review.");
            return;
        }
        const recent = commitsData.map((c) => `${c.sha.slice(0, 7)} ${c.commit.message.split("\n")[0]}`);
        // 1. Generate high-level summary
        const summaryInput = { commits: recent, vision, tasks, bugs, done, fresh };
        const summary = await reviewToSummary(summaryInput);
        await upsertFile("reports/repo_summary.md", () => summary, "bot: update repo summary");
        // 2. Generate actionable ideas from summary
        const ideasInput = { summary, vision, tasks, bugs, done, fresh };
        const ideasYaml = await reviewToIdeas(ideasInput);
        // 3. Append new ideas to roadmap/new.md
        const newPath = "roadmap/new.md";
        const currentNewMd = (await readFile(newPath)) || "";
        const currentIdeas = readYamlBlock(currentNewMd, { queue: [] });
        const newIdeas = yaml.load(ideasYaml)?.queue || [];
        for (const idea of newIdeas) {
            currentIdeas.queue.push({
                ...idea,
                id: idea.id || `IDEA-${Date.now()}`,
                created: idea.created || new Date().toISOString()
            });
        }
        const nextNewMd = writeYamlBlock(currentNewMd, currentIdeas);
        await upsertFile(newPath, () => nextNewMd, "bot: review repo → new.md");
        const headSha = commitsData[0]?.sha;
        await saveState({ ...state, lastReviewedSha: headSha });
        console.log("Review complete.");
    }
    finally {
        await releaseLock();
    }
}
