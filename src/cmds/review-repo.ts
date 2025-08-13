import { acquireLock, releaseLock } from "../lib/lock.js";
import { readFile, parseRepo, gh, upsertFile } from "../lib/github.js";
import { readYamlBlock, writeYamlBlock } from "../lib/md.js";
import { reviewToIdeas } from "../lib/prompts.js";
import { loadState, saveState } from "../lib/state.js";

export async function reviewRepo() {
  if (!(await acquireLock())) { console.log("Lock taken; exiting."); return; }
  try {
    const vision = (await readFile("roadmap/vision.md")) || "";
    const tasks  = (await readFile("roadmap/tasks.md"))  || "";
    const bugs   = (await readFile("roadmap/bugs.md"))   || "";
    const done   = (await readFile("roadmap/done.md"))   || "";
    const fresh  = (await readFile("roadmap/new.md"))    || "";

    const state = await loadState();
    const { owner, repo } = parseRepo(process.env.TARGET_REPO!);
    const commits = await gh().rest.repos.listCommits({ owner, repo, per_page: 10 });
    const sinceSha = state.lastReviewedSha;
    const recent = commits.data.map((c: { sha: string; commit: { message: string } }) =>
      `${c.sha.slice(0,7)} ${c.commit.message.split("\n")[0]}`
    );
    const input = { commits: recent, vision, tasks, bugs, done, fresh };

    const ideas = await reviewToIdeas(input);
    const newPath = "roadmap/new.md";
    const current = (await readFile(newPath)) || "";
    const yaml = readYamlBlock<{ queue: any[] }>(current, { queue: [] });
    yaml.queue.push({ id: `IDEA-${Date.now()}`, title: "Architect review batch", details: ideas, created: new Date().toISOString() });
    const next = writeYamlBlock(current, yaml);

    await upsertFile(newPath, () => next, "bot: review repo → new.md");

    const headSha = commits.data[0]?.sha;
    await saveState({ ...state, lastReviewedSha: headSha });
    console.log("Review complete.");
  } finally {
    await releaseLock();
  }
}
