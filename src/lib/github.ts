import { Octokit } from "octokit";
import { posix as pathPosix } from "node:path";
import { ENV, parseRepo, requireEnv } from "./env.js";

export const gh = new Octokit({ auth: ENV.PAT_TOKEN });

export type RepoRef = { owner: string; repo: string };
export type CommitMessage = string | { title: string; body?: string };

function formatMessage(msg: CommitMessage): string {
  if (typeof msg === "string") return msg;
  return msg.body ? `${msg.title}\n\n${msg.body}` : msg.title;
}

function b64(s: string) {
  return Buffer.from(s, "utf8").toString("base64");
}

async function getFile(owner: string, repo: string, path: string, ref?: string) {
  try {
    const res = await gh.rest.repos.getContent({ owner, repo, path, ref });
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
  const { owner, repo } = parseRepo();
  const { data } = await gh.rest.repos.get({ owner, repo });
  return data.default_branch;
}

export async function ensureBranch(branch: string, baseBranch?: string): Promise<void> {
  const { owner, repo } = parseRepo();
  const ref = `heads/${branch}`;
  try {
    await gh.rest.git.getRef({ owner, repo, ref });
    return;
  } catch (e: any) {
    if (e?.status !== 404) throw e;
  }
  const base = baseBranch || await getDefaultBranch();
  const baseRef = await gh.rest.git.getRef({ owner, repo, ref: `heads/${base}` });
  const baseSha = baseRef.data.object.sha;
  await gh.rest.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: baseSha });
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
  const { owner, repo } = parseRepo();
  const got = await getFile(owner, repo, path);
  return got.content;
}

export async function upsertFile(
  path: string,
  updater: (old: string | undefined) => string,
  message: CommitMessage,
  opts?: { branch?: string }
) {
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

export async function commitMany(
  files: Array<{ path: string; content: string }>,
  message: CommitMessage,
  opts?: { branch?: string }
) {
  requireEnv(["PAT_TOKEN"]);
  const { owner, repo } = parseRepo();
  const ref = opts?.branch;
  const msg = formatMessage(message);
  if (ENV.DRY_RUN) {
    console.log(
      `[DRY_RUN] commitMany will create 1 commit on ${ref || "(default branch)"}: ${msg}`
    );
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
  const modeByPath = new Map<string, string>();
  for (const entry of existingTree.tree) {
    if (entry.type === "blob" && entry.path && entry.mode) {
      modeByPath.set(entry.path, entry.mode);
    }
  }

  const treeEntries: Array<{
    path: string;
    mode: "100644" | "100755" | "040000" | "160000" | "120000";
    type: "blob";
    sha: string;
  }> = [];
  for (const f of files) {
    const safePath = resolveRepoPath(f.path);
    const blob = await git.createBlob({
      owner,
      repo,
      content: f.content,
      encoding: "utf-8"
    });
    const mode =
      (modeByPath.get(safePath) as
        | "100644"
        | "100755"
        | "040000"
        | "160000"
        | "120000"
        | undefined) || "100644";
    treeEntries.push({
      path: safePath,
      mode,
      type: "blob",
      sha: blob.data.sha
    });
  }

  try {
    await gh.rest.repos.get({ owner, repo });
  } catch (e: any) {
    if (e?.status === 404 || e?.status === 403) {
      throw new Error(
        `Access to repository ${owner}/${repo} failed with status ${e.status}. Please verify TARGET_OWNER, TARGET_REPO, and PAT_TOKEN permissions.`
      );
    }
    throw e;
  }

  console.log(
    `commitMany target: owner=${owner} repo=${repo} branch=${branch} base=${latestCommit.data.tree.sha}`
  );

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
