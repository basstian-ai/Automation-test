import { ingestLogs } from "./cmds/ingest-logs.js";
import { reviewRepo } from "./cmds/review-repo.js";
import { implementTopTask } from "./cmds/implement.js";
import { loadState } from "./lib/state.js";
import { getLatestDeployment } from "./lib/vercel.js";
import { gh } from "./lib/github.js";
import { ENV, requireEnv } from "./lib/env.js";
requireEnv(["TARGET_OWNER", "TARGET_REPO"]);
async function shouldIngest(state) {
    try {
        const dep = await getLatestDeployment();
        if (!dep)
            return false;
        return dep.createdAt > (state.ingest?.lastDeploymentTimestamp ?? 0);
    }
    catch {
        return false;
    }
}
async function shouldReview(state) {
    try {
        if (!ENV.OWNER || !ENV.REPO)
            return false;
        const resp = await gh.rest.repos.listCommits({ owner: ENV.OWNER, repo: ENV.REPO, per_page: 1 });
        const latest = resp.data[0]?.sha;
        return !!latest && latest !== state.lastReviewedSha;
    }
    catch {
        return false;
    }
}
export async function orchestrate(force) {
    const state = await loadState();
    let cmd = force;
    if (!cmd) {
        if (await shouldIngest(state))
            cmd = "ingest-logs";
        else if (await shouldReview(state))
            cmd = "review-repo";
        else
            cmd = "implement";
    }
    if (cmd === "ingest-logs")
        await ingestLogs();
    else if (cmd === "review-repo")
        await reviewRepo();
    else if (cmd === "implement")
        await implementTopTask();
    else {
        console.error(`Unknown command: ${cmd}`);
        process.exit(2);
    }
}
const arg = process.argv[2] || process.env.RUN_TASK;
orchestrate(arg).catch(err => {
    console.error("[ERROR] orchestrator:", err?.stack || err?.message || err);
    process.exit(1);
});
