import { Octokit } from "octokit";
import { posix as pathPosix } from "node:path";
import { ENV, parseRepo } from "./env.js";
export const gh = new Octokit({ auth: ENV.PAT_TOKEN });
function formatMessage(msg) {
    if (typeof msg === "string")
        return msg;
    return msg.body ? `${msg.title}\n\n${msg.body}` : msg.title;
}
function b64(s) {
    return Buffer.from(s, "utf8").toString("base64");
}
async function getFile(owner, repo, path, ref) {
    try {
        const res = await gh.rest.repos.getContent({ owner, repo, path, ref });
        const data = res.data;
        if (Array.isArray(data))
            throw new Error(`Expected file at ${path}, got directory`);
        const sha = data.sha;
        const content = data.content ? Buffer.from(data.content, "base64").toString("utf8") : undefined;
        return { sha, content };
    }
    catch (e) {
        if (e?.status === 404)
            return { sha: undefined, content: undefined };
        throw e;
    }
}
export async function getDefaultBranch() {
    const { owner, repo } = parseRepo();
    const { data } = await gh.rest.repos.get({ owner, repo });
    return data.default_branch;
}
export async function ensureBranch(branch, baseBranch) {
    const { owner, repo } = parseRepo();
    const ref = `heads/${branch}`;
    try {
        await gh.rest.git.getRef({ owner, repo, ref });
        return;
    }
    catch (e) {
        if (e?.status !== 404)
            throw e;
    }
    const base = baseBranch || await getDefaultBranch();
    const baseRef = await gh.rest.git.getRef({ owner, repo, ref: `heads/${base}` });
    const baseSha = baseRef.data.object.sha;
    await gh.rest.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: baseSha });
}
export function resolveRepoPath(p) {
    if (!p)
        throw new Error("Empty path");
    let norm = p.replace(/\\/g, "/").replace(/^\/+/, "").replace(/^\.\//, "");
    norm = pathPosix.normalize(norm);
    if (norm === "" || norm === "." || norm.startsWith("..")) {
        throw new Error(`Refusing path outside repo: ${p}`);
    }
    const rawBase = ENV.TARGET_DIR || "";
    const base = rawBase.replace(/^\/+|\/+$/g, "");
    if (base.includes("://") || base.includes(":")) {
        throw new Error(`Invalid TARGET_DIR: ${ENV.TARGET_DIR}`);
    }
    const joined = base ? pathPosix.join(base, norm) : norm;
    return joined.replace(/^\/+/, "");
}
export async function readFile(path) {
    const { owner, repo } = parseRepo();
    const got = await getFile(owner, repo, path);
    return got.content;
}
export async function upsertFile(path, updater, message, opts) {
    const { owner, repo } = parseRepo();
    const safePath = resolveRepoPath(path);
    const ref = opts?.branch;
    if (ENV.DRY_RUN) {
        const next = updater(undefined);
        const msg = formatMessage(message);
        console.log(`[DRY_RUN] upsert ${safePath} on ${ref || "(default branch)"}: ${msg}\n---\n${next}\n---`);
        return;
    }
    const { sha, content: old } = await getFile(owner, repo, safePath, ref);
    const next = updater(old);
    await gh.rest.repos.createOrUpdateFileContents({
        owner,
        repo,
        path: safePath,
        message: formatMessage(message),
        content: b64(next),
        sha,
        ...(ref ? { branch: ref } : {}),
        committer: { name: "ai-dev-agent", email: "bot@local" },
        author: { name: "ai-dev-agent", email: "bot@local" }
    });
}
export async function commitMany(files, message, opts) {
    const { owner, repo } = parseRepo();
    const ref = opts?.branch;
    const msg = formatMessage(message);
    if (ENV.DRY_RUN) {
        console.log(`[DRY_RUN] commitMany will create 1 commit on ${ref || "(default branch)"}: ${msg}`);
        for (const f of files) {
            const safePath = resolveRepoPath(f.path);
            console.log(`  - ${safePath} (${f.content.length} bytes)`);
        }
        return;
    }
    const branch = ref || (await getDefaultBranch());
    const git = gh.rest.git;
    const headRef = await git.getRef({ owner, repo, ref: `heads/${branch}` });
    const latestCommitSha = headRef.data.object.sha;
    const latestCommit = await git.getCommit({
        owner,
        repo,
        commit_sha: latestCommitSha
    });
    const { data: existingTree } = await git.getTree({
        owner,
        repo,
        tree_sha: latestCommit.data.tree.sha,
        recursive: "true"
    });
    const modeByPath = new Map();
    for (const entry of existingTree.tree) {
        if (entry.type === "blob" && entry.path && entry.mode) {
            modeByPath.set(entry.path, entry.mode);
        }
    }
    const treeEntries = [];
    for (const f of files) {
        const safePath = resolveRepoPath(f.path);
        const blob = await git.createBlob({
            owner,
            repo,
            content: f.content,
            encoding: "utf-8"
        });
        const mode = modeByPath.get(safePath) || "100644";
        treeEntries.push({
            path: safePath,
            mode,
            type: "blob",
            sha: blob.data.sha
        });
    }
    const tree = await git.createTree({
        owner,
        repo,
        base_tree: latestCommit.data.tree.sha,
        tree: treeEntries
    });
    const newCommit = await git.createCommit({
        owner,
        repo,
        message: msg,
        tree: tree.data.sha,
        parents: [latestCommitSha],
        committer: { name: "ai-dev-agent", email: "bot@local" },
        author: { name: "ai-dev-agent", email: "bot@local" }
    });
    await git.updateRef({
        owner,
        repo,
        ref: `heads/${branch}`,
        sha: newCommit.data.sha
    });
}
