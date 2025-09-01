import { Octokit } from "octokit";
import { posix as pathPosix } from "node:path";
import { ENV } from "./env.js";
function formatMessage(msg) {
    if (typeof msg === "string")
        return msg;
    return msg.body ? `${msg.title}\n\n${msg.body}` : msg.title;
}
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
async function getFile(owner, repo, path, ref) {
    const client = gh();
    try {
        const res = await client.rest.repos.getContent({ owner, repo, path, ref });
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
    const { owner, repo } = parseRepo(ENV.TARGET_REPO);
    const { data } = await gh().rest.repos.get({ owner, repo });
    return data.default_branch;
}
export async function ensureBranch(branch, baseBranch) {
    const { owner, repo } = parseRepo(ENV.TARGET_REPO);
    const ref = `heads/${branch}`;
    try {
        await gh().rest.git.getRef({ owner, repo, ref });
        return;
    }
    catch (e) {
        if (e?.status !== 404)
            throw e;
    }
    const base = baseBranch || await getDefaultBranch();
    const baseRef = await gh().rest.git.getRef({ owner, repo, ref: `heads/${base}` });
    const baseSha = baseRef.data.object.sha;
    await gh().rest.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: baseSha });
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
    const { owner, repo } = parseRepo(ENV.TARGET_REPO);
    const got = await getFile(owner, repo, path);
    return got.content;
}
export async function upsertFile(path, updater, message, opts) {
    const { owner, repo } = parseRepo(ENV.TARGET_REPO);
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
    await gh().rest.repos.createOrUpdateFileContents({
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
    const { owner, repo } = parseRepo(ENV.TARGET_REPO);
    const ref = opts?.branch;
    if (ENV.DRY_RUN) {
        const msg = formatMessage(message);
        console.log(`[DRY_RUN] commitMany ${files.length} files on ${ref || "(default branch)"}: ${msg}`);
        return;
    }
    for (const f of files) {
        const safePath = resolveRepoPath(f.path);
        const { sha } = await getFile(owner, repo, safePath, ref);
        await gh().rest.repos.createOrUpdateFileContents({
            owner,
            repo,
            path: safePath,
            message: formatMessage(message),
            content: b64(f.content),
            sha,
            ...(ref ? { branch: ref } : {}),
            committer: { name: "ai-dev-agent", email: "bot@local" },
            author: { name: "ai-dev-agent", email: "bot@local" }
        });
    }
}
