import { Octokit } from "octokit";
import { createOrUpdateTextFile } from "@octokit/plugin-create-or-update-text-file";
import { ENV } from "./env.js";

const MyOctokit = Octokit.plugin(createOrUpdateTextFile);

export function gh() {
  return new MyOctokit({ auth: ENV.PAT_TOKEN });
}

export type RepoRef = { owner: string; repo: string };
export function parseRepo(s: string): RepoRef {
  const [owner, repo] = s.split("/");
  if (!owner || !repo) throw new Error(`Invalid TARGET_REPO: ${s}`);
  return { owner, repo };
}

export async function readFile(path: string): Promise<string | undefined> {
  const { owner, repo } = parseRepo(ENV.TARGET_REPO);
  try {
    const res = await gh().repos.getContent({ owner, repo, path });
    if (!Array.isArray(res.data) && "content" in res.data) {
      return Buffer.from(res.data.content, "base64").toString("utf8");
    }
    return undefined;
  } catch (e: any) {
    if (e.status === 404) return undefined;
    throw e;
  }
}

export async function upsertFile(path: string, updater: (oldContent: string | undefined) => string, message: string) {
  const { owner, repo } = parseRepo(ENV.TARGET_REPO);
  if (ENV.DRY_RUN) {
    const old = await readFile(path);
    const next = updater(old);
    console.log(`[DRY_RUN] Would write ${path} with message: ${message}\n---\n${next}`);
    return;
  }
  await (gh() as any).createOrUpdateTextFile({
    owner, repo, path,
    message,
    content: ({ content }: { content?: string }) => updater(content),
    committer: { name: "ai-dev-agent", email: "bot@local" },
    author: { name: "ai-dev-agent", email: "bot@local" }
  });
}

export async function commitMany(files: Array<{ path: string; content: string }>, message: string) {
  const { owner, repo } = parseRepo(ENV.TARGET_REPO);
  const client = gh();
  if (ENV.DRY_RUN) {
    console.log(`[DRY_RUN] Would commit ${files.length} files:`, files.map(f => f.path));
    return;
  }
  // Create a branchless commit via multiple createOrUpdateTextFile calls (simplest path)
  for (const f of files) {
    await (client as any).createOrUpdateTextFile({
      owner, repo, path: f.path, message, content: f.content,
      committer: { name: "ai-dev-agent", email: "bot@local" },
      author: { name: "ai-dev-agent", email: "bot@local" }
    });
  }
}
