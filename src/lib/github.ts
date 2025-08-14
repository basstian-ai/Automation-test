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

async function getFile(owner: string, repo: string, path: string) {
  const client = gh();
  try {
    const res = await client.rest.repos.getContent({ owner, repo, path });
    const data = res.data as any;
    if (!Array.isArray(data) && data.type === "file" && typeof data.content === "string") {
      const content = Buffer.from(data.content, "base64").toString("utf8");
      return { sha: data.sha as string, content };
    }
    return { sha: undefined, content: undefined };
  } catch (e: any) {
    if (e.status === 404) return { sha: undefined, content: undefined };
    throw e;
  }
}

export function resolveRepoPath(p: string): string {
  if (!p) throw new Error("Empty path");
  let norm = p.replace(/\\/g, "/").replace(/^\/+/, "").replace(/^\.\//, "");
  norm = pathPosix.normalize(norm);
  if (norm === "" || norm === "." || norm.startsWith("..")) {
    throw new Error(`Refusing path outside repo: ${p}`);
  }
  const base = (ENV.TARGET_DIR || "").replace(/^\/+|\/+$/g, "");
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
  updater: (oldContent: string | undefined) => string,
  message: string
) {
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

export async function commitMany(
  files: Array<{ path: string; content: string }>,
  message: string
) {
  const { owner, repo } = parseRepo(ENV.TARGET_REPO);
  if (ENV.DRY_RUN) {
    console.log(`[DRY_RUN] Would commit ${files.length} files:`, files.map(f => resolveRepoPath(f.path))); 
    return;
  }
  for (const f of files) {
    const safePath = resolveRepoPath(f.path);
    const existing = await getFile(owner, repo, safePath);
    await gh().rest.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: safePath,
      message,
      content: b64(f.content),
      sha: existing.sha,
      committer: { name: "ai-dev-agent", email: "bot@local" },
      author: { name: "ai-dev-agent", email: "bot@local" }
    });
  }
}
