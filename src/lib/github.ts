import { Octokit } from "octokit";
import { posix as pathPosix } from "node:path";
import { ENV } from "./env.js";

export type RepoRef = { owner: string; repo: string };

export function parseRepo(s: string): RepoRef {
  const [owner, repo] = s.split("/");
  if (!owner || !repo) throw new Error(`Invalid TARGET_REPO: ${s}`);
  return { owner, repo };
}

export function gh() {
  return new Octokit({ auth: ENV.PAT_TOKEN });
}

function b64(s: string) {
  return Buffer.from(s, "utf8").toString("base64");
}

async function getFile(owner: string, repo: string, path: string, ref?: string) {
  const client = gh();
  try {
    const res = await client.rest.repos.getContent({ owner, repo, path, ref });
    const data = res.data as any;
    if (Array.isArray(data)) throw new Error(`Expected file at ${path}, got directory`);
    const sha = data.sha as string | undefined;
    const content = data.content ? Buffer.from(data.content, "base64").toString("utf8") : undefined;
    return { sha, content };
  } catch (e: any) {
    if (e?.status === 404) return { sha: undefined, content: undefined };
    throw e;
  }
}

export async function getDefaultBranch(): Promise<string> {
  const { owner, repo } = parseRepo(ENV.TARGET_REPO);
  const { data } = await gh().rest.repos.get({ owner, repo });
  return data.default_branch;
}

export async function ensureBranch(branch: string, baseBranch?: string): Promise<void> {
  const { owner, repo } = parseRepo(ENV.TARGET_REPO);
  const ref = `heads/${branch}`;
  try {
    await gh().rest.git.getRef({ owner, repo, ref });
    return;
  } catch (e: any) {
    if (e?.status !== 404) throw e;
  }
  const base = baseBranch || await getDefaultBranch();
  const baseRef = await gh().rest.git.getRef({ owner, repo, ref: `heads/${base}` });
  const baseSha = baseRef.data.object.sha;
  await gh().rest.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: baseSha });
}

export function resolveRepoPath(p: string): string {
  if (!p) throw new Error("Empty path");
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

export async function readFile(path: string): Promise<string | undefined> {
  const { owner, repo } = parseRepo(ENV.TARGET_REPO);
  const got = await getFile(owner, repo, path);
  return got.content;
}

export async function upsertFile(
  path: string,
  updater: (old: string | undefined) => string,
  message: string,
  opts?: { branch?: string }
) {
  const { owner, repo } = parseRepo(ENV.TARGET_REPO);
  const safePath = resolveRepoPath(path);
  const ref = opts?.branch;
  if (ENV.DRY_RUN) {
    const next = updater(undefined);
    console.log(`[DRY_RUN] upsert ${safePath} on ${ref || "(default branch)"}: ${message}\n---\n${next}\n---`);
    return;
  }
  const { sha, content: old } = await getFile(owner, repo, safePath, ref);
  const next = updater(old);
  await gh().rest.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: safePath,
    message,
    content: b64(next),
    sha,
    ...(ref ? { branch: ref } : {}),
    committer: { name: "ai-dev-agent", email: "bot@local" },
    author: { name: "ai-dev-agent", email: "bot@local" }
  });
}

export async function commitMany(
  files: Array<{ path: string; content: string }>,
  message: string,
  opts?: { branch?: string }
) {
  const { owner, repo } = parseRepo(ENV.TARGET_REPO);
  const ref = opts?.branch;
  if (ENV.DRY_RUN) {
    console.log(`[DRY_RUN] commitMany ${files.length} files on ${ref || "(default branch)"}: ${message}`);
    return;
  }
  for (const f of files) {
    const safePath = resolveRepoPath(f.path);
    const { sha } = await getFile(owner, repo, safePath, ref);
    await gh().rest.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: safePath,
      message,
      content: b64(f.content),
      sha,
      ...(ref ? { branch: ref } : {}),
      committer: { name: "ai-dev-agent", email: "bot@local" },
      author: { name: "ai-dev-agent", email: "bot@local" }
    });
  }
}
