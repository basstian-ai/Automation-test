import { Octokit } from "@octokit/rest";
import { posix as pathPosix } from "node:path";
import { ENV } from "./env.js";

export const gh = new Octokit({ auth: ENV.PAT_TOKEN });

export type RepoRef = { owner: string; repo: string };
export type CommitMessage = string | { title: string; body?: string };

function formatMessage(msg: CommitMessage): string {
  if (typeof msg === "string") return msg;
  return msg.body ? `${msg.title}\n\n${msg.body}` : msg.title;
}

export function parseRepo(repoEnv: string = ENV.TARGET_REPO): RepoRef {
  if (!repoEnv) {
    throw new Error(
      "Missing TARGET_REPO. Expected either 'owner/repo' or TARGET_OWNER + TARGET_REPO."
    );
  }
  if (repoEnv.includes("/")) {
    const [owner, repo] = repoEnv.split("/");
    if (!owner || !repo) {
      throw new Error(
        `Invalid TARGET_REPO format: "${repoEnv}". Expected "owner/repo".`
      );
    }
    return { owner, repo };
  }
  if (!ENV.TARGET_OWNER) {
    throw new Error(
      `TARGET_REPO="${repoEnv}" provided without TARGET_OWNER. Please set TARGET_OWNER (deprecated) or prefer TARGET_REPO="owner/repo".`
    );
  }
  console.warn(
    "DEPRECATION: Using TARGET_OWNER + TARGET_REPO. Prefer TARGET_REPO='owner/repo'."
  );
  return { owner: ENV.TARGET_OWNER, repo: repoEnv };
}

function b64(s: string) {
  return Buffer.from(s, "utf8").toString("base64");
}

/**
 * Create Octokit instance that automatically injects {owner, repo}
 * for any repo-scoped route when missing.
 */
export function createOctokitWithRepo(repo: RepoRef) {
  const gh = new Octokit({ auth: ENV.PAT_TOKEN });

  gh.hook.before("request", (options: any) => {
    if (typeof options.url === "string" && options.url.includes("/repos/")) {
      if (options.owner == null) options.owner = repo.owner;
      if (options.repo == null) options.repo = repo.repo;
    }
  });

  return gh;
}

/** Small helper to merge repo params */
export function withRepo<T extends object>(ref: RepoRef, extra: T): T & RepoRef {
  return { owner: ref.owner, repo: ref.repo, ...extra };
}

/** Resolve default branch name from the repo (e.g. "main") */
export async function getDefaultBranch(
  client: Octokit = gh,
  repo: RepoRef = parseRepo()
) {
  const { data } = await client.rest.repos.get(withRepo(repo, {}));
  return data.default_branch || "main";
}

/** Resolve a valid base tree SHA from the head commit of a branch */
export async function getBaseTreeSha(
  client: Octokit,
  repo: RepoRef,
  branch?: string
) {
  const defaultBranch = branch || (await getDefaultBranch(client, repo));
  const ref = await client.rest.git.getRef(
    withRepo(repo, { ref: `heads/${defaultBranch}` })
  );
  const commitSha = ref.data.object.sha;
  const commit = await client.rest.git.getCommit(
    withRepo(repo, { commit_sha: commitSha })
  );
  return commit.data.tree.sha;
}

/**
 * Create a tree robustly.
 * 1) Try with base_tree resolved from default branch.
 * 2) On 404/Not Found, retry without base_tree (works for trees that add only new files).
 */
export async function createRepoTree(
  client: Octokit,
  repo: RepoRef,
  files: Array<{ path: string; sha: string }>
) {
  const tree = files.map((f) => ({
    path: f.path,
    mode: "100644" as const,
    type: "blob" as const,
    sha: f.sha,
  }));

  try {
    const base_tree = await getBaseTreeSha(client, repo);
    const { data } = await client.rest.git.createTree(
      withRepo(repo, { base_tree, tree })
    );
    return data.sha;
  } catch (e: any) {
    const msg = String(e?.message || "");
    if (e?.status === 404 || /Not Found/i.test(msg)) {
      const { data } = await client.rest.git.createTree(
        withRepo(repo, { tree })
      );
      return data.sha;
    }
    throw e;
  }
}

/**
 * Example high-level commit helper (optional).
 * Use this if you currently hand-wire blob/tree/commit calls.
 */
export async function commitFiles(
  client: Octokit,
  repo: RepoRef,
  files: Array<{ path: string; content: string }>,
  message: CommitMessage,
  branch?: string
) {
  // 1) create blobs
  const blobShas: Array<{ path: string; sha: string }> = [];
  for (const f of files) {
    const blob = await client.rest.git.createBlob(
      withRepo(repo, { content: b64(f.content), encoding: "base64" as const })
    );
    blobShas.push({ path: f.path, sha: blob.data.sha });
  }

  // 2) create tree robustly
  const treeSha = await createRepoTree(client, repo, blobShas);

  // 3) get parent commit
  const defaultBranch = branch || (await getDefaultBranch(client, repo));
  const ref = await client.rest.git.getRef(
    withRepo(repo, { ref: `heads/${defaultBranch}` })
  );
  const parentSha = ref.data.object.sha;

  // 4) create commit
  const commit = await client.rest.git.createCommit(
    withRepo(repo, {
      message: formatMessage(message),
      tree: treeSha,
      parents: [parentSha],
    })
  );

  // 5) update ref
  await client.rest.git.updateRef(
    withRepo(repo, { ref: `heads/${defaultBranch}`, sha: commit.data.sha, force: false })
  );

  return commit.data.sha;
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

export async function ensureBranch(branch: string, baseBranch?: string): Promise<void> {
  const { owner, repo } = parseRepo(ENV.TARGET_REPO);
  const ref = `heads/${branch}`;
  try {
    await gh.rest.git.getRef({ owner, repo, ref });
    return;
  } catch (e: any) {
    if (e?.status !== 404) throw e;
  }
  const base = baseBranch || (await getDefaultBranch(gh, { owner, repo }));
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
  const { owner, repo } = parseRepo(ENV.TARGET_REPO);
  const got = await getFile(owner, repo, path);
  return got.content;
}

export async function upsertFile(
  path: string,
  updater: (old: string | undefined) => string,
  message: CommitMessage,
  opts?: { branch?: string }
) {
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
  const { owner, repo } = parseRepo(ENV.TARGET_REPO);
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

try {
  const parsed = parseRepo();
  console.log("Resolved repo configuration:", {
    TARGET_OWNER: ENV.TARGET_OWNER,
    TARGET_REPO: ENV.TARGET_REPO,
    parsed,
  });
} catch (err: any) {
  console.log("Resolved repo configuration:", {
    TARGET_OWNER: ENV.TARGET_OWNER,
    TARGET_REPO: ENV.TARGET_REPO,
    parsed: err.message,
  });
}
