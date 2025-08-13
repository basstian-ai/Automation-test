import { Octokit } from "octokit";
import { ENV } from "./env.js";
export function parseRepo(s) {
    const [owner, repo] = s.split("/");
    if (!owner || !repo)
        throw new Error(`Invalid TARGET_REPO: ${s}`);
    return { owner, repo };
}
export function gh() {
    return new Octokit({ auth: ENV.PAT_TOKEN });
}
function b64(s) {
    return Buffer.from(s, "utf8").toString("base64");
}
async function getFile(owner, repo, path) {
    const client = gh();
    try {
        const res = await client.rest.repos.getContent({ owner, repo, path });
        const data = res.data;
        if (!Array.isArray(data) && data.type === "file" && typeof data.content === "string") {
            const content = Buffer.from(data.content, "base64").toString("utf8");
            return { sha: data.sha, content };
        }
        return { sha: undefined, content: undefined };
    }
    catch (e) {
        if (e.status === 404)
            return { sha: undefined, content: undefined };
        throw e;
    }
}
export async function readFile(path) {
    const { owner, repo } = parseRepo(ENV.TARGET_REPO);
    const got = await getFile(owner, repo, path);
    return got.content;
}
export async function upsertFile(path, updater, message) {
    const { owner, repo } = parseRepo(ENV.TARGET_REPO);
    if (ENV.DRY_RUN) {
        const old = await readFile(path);
        const next = updater(old);
        console.log(`[DRY_RUN] Would write ${path} with message: ${message}\n---\n${next}`);
        return;
    }
    const { sha, content: old } = await getFile(owner, repo, path);
    const next = updater(old);
    await gh().rest.repos.createOrUpdateFileContents({
        owner,
        repo,
        path,
        message,
        content: b64(next),
        sha, // include if file existed
        committer: { name: "ai-dev-agent", email: "bot@local" },
        author: { name: "ai-dev-agent", email: "bot@local" }
    });
}
export async function commitMany(files, message) {
    const { owner, repo } = parseRepo(ENV.TARGET_REPO);
    if (ENV.DRY_RUN) {
        console.log(`[DRY_RUN] Would commit ${files.length} files:`, files.map(f => f.path));
        return;
    }
    for (const f of files) {
        const existing = await getFile(owner, repo, f.path);
        await gh().rest.repos.createOrUpdateFileContents({
            owner,
            repo,
            path: f.path,
            message,
            content: b64(f.content),
            sha: existing.sha,
            committer: { name: "ai-dev-agent", email: "bot@local" },
            author: { name: "ai-dev-agent", email: "bot@local" }
        });
    }
}
