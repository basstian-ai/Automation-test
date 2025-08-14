import { Octokit } from "octokit";
import { posix as pathPosix } from "node:path";
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
export function resolveRepoPath(p) {
    if (!p)
        throw new Error("Empty path");
    let norm = p.replace(/\\/g, "/").replace(/^\/+/, "").replace(/^\.\//, "");
    norm = pathPosix.normalize(norm);
    if (norm === "" || norm === "." || norm.startsWith("..")) {
        throw new Error(`Refusing path outside repo: ${p}`);
    }
    const base = (ENV.TARGET_DIR || "").replace(/^\/+|\/+$/g, "");
    const joined = base ? pathPosix.join(base, norm) : norm;
    return joined.replace(/^\/+/, "");
}
export async function readFile(path) {
    const { owner, repo } = parseRepo(ENV.TARGET_REPO);
    const got = await getFile(owner, repo, path);
    return got.content;
}
export async function upsertFile(path, updater, message) {
    const { owner, repo } = parseRepo(ENV.TARGET_REPO);
    const safePath = resolveRepoPath(path);
    if (ENV.DRY_RUN) {
        const old = await readFile(safePath);
        const next = updater(old);
        console.log(`[DRY_RUN] Would write ${safePath} with message: ${message}\n---\n${next}`);
        return;
    }
    const { sha, content: old } = await getFile(owner, repo, safePath);
    const next = updater(old);
    await gh().rest.repos.createOrUpdateFileContents({
        owner,
        repo,
        path: safePath,
        message,
        content: b64(next),
        sha, // include if file existed
        committer: { name: "ai-dev-agent", email: "bot@local" },
        author: { name: "ai-dev-agent", email: "bot@local" }
    });
}
export async function commitMany(files, message, branch = ENV.BRANCH) {
    const { owner, repo } = parseRepo(ENV.TARGET_REPO);
    if (ENV.DRY_RUN) {
        console.log(`[DRY_RUN] Would commit ${files.length} files:`, files.map(f => resolveRepoPath(f.path)));
        return;
    }
    const client = gh();
    // Normalize and ensure paths are within repo scope
    const safe = files.map(f => ({ path: resolveRepoPath(f.path), content: f.content }));
    // Determine the current branch and commit
    const { data: repoData } = await client.rest.repos.get({ owner, repo });
    const targetBranch = branch || repoData.default_branch;
    const { data: refData } = await client.rest.git.getRef({ owner, repo, ref: `heads/${targetBranch}` });
    const baseSha = refData.object.sha;
    const { data: commitData } = await client.rest.git.getCommit({ owner, repo, commit_sha: baseSha });
    // Create blobs and collect tree entries
    const tree = [];
    for (const f of safe) {
        const blob = await client.rest.git.createBlob({ owner, repo, content: f.content, encoding: "utf-8" });
        tree.push({ path: f.path, mode: "100644", type: "blob", sha: blob.data.sha });
    }
    // Create new tree and commit
    const { data: newTree } = await client.rest.git.createTree({ owner, repo, base_tree: commitData.tree.sha, tree });
    const { data: newCommit } = await client.rest.git.createCommit({
        owner,
        repo,
        message,
        tree: newTree.sha,
        parents: [baseSha],
        committer: { name: "ai-dev-agent", email: "bot@local" },
        author: { name: "ai-dev-agent", email: "bot@local" }
    });
    // Update branch reference; rollback if it fails
    try {
        await client.rest.git.updateRef({ owner, repo, ref: `heads/${targetBranch}`, sha: newCommit.sha });
    }
    catch (err) {
        try {
            await client.rest.git.updateRef({ owner, repo, ref: `heads/${targetBranch}`, sha: baseSha, force: true });
        }
        catch { }
        throw err;
    }
}
