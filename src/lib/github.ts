import { Octokit } from "octokit";
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

export async function commitMany(
  files: Array<{ path: string; content: string }>,
  message: string
) {
  const { owner, repo } = parseRepo(ENV.TARGET_REPO);
  if (ENV.DRY_RUN) {
    console.log(`[DRY_RUN] Would commit ${files.length} files:`, files.map(f => f.path));
    return;
  }

  const client = gh();

  // Determine default branch and current commit
  const { data: repoInfo } = await client.rest.repos.get({ owner, repo });
  const branch = repoInfo.default_branch;
  const { data: ref } = await client.rest.git.getRef({ owner, repo, ref: `heads/${branch}` });
  const currentSha = ref.object.sha;
  const { data: baseCommit } = await client.rest.git.getCommit({ owner, repo, commit_sha: currentSha });

  try {
    // Create blobs for each file
    const treeEntries = await Promise.all(files.map(async (f) => {
      const blob = await client.rest.git.createBlob({ owner, repo, content: f.content, encoding: "utf-8" });
      return { path: f.path, mode: "100644", type: "blob", sha: blob.data.sha } as const;
    }));

    // Build tree and commit
    const { data: tree } = await client.rest.git.createTree({ owner, repo, base_tree: baseCommit.tree.sha, tree: treeEntries });
    const { data: commit } = await client.rest.git.createCommit({
      owner,
      repo,
      message,
      tree: tree.sha,
      parents: [currentSha],
      author: { name: "ai-dev-agent", email: "bot@local" },
      committer: { name: "ai-dev-agent", email: "bot@local" }
    });

    await client.rest.git.updateRef({ owner, repo, ref: `heads/${branch}`, sha: commit.sha });
  } catch (e) {
    // Roll back to previous commit if something went wrong
    try {
      await client.rest.git.updateRef({ owner, repo, ref: `heads/${branch}`, sha: currentSha, force: true });
    } catch {}
    throw e;
  }
}
