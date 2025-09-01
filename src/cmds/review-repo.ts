import { acquireLock, releaseLock } from "../lib/lock.js";
import { parseRepo, gh, upsertFile } from "../lib/github.js";
import { reviewToIdeas, reviewToSummary } from "../lib/prompts.js";
import { loadState, saveState, appendChangelog, appendDecision } from "../lib/state.js";
import { requireEnv, ENV } from "../lib/env.js";
import yaml from "js-yaml";

export async function reviewRepo() {
  if (!(await acquireLock())) { console.log("Lock taken; exiting."); return; }
  try {
    requireEnv(["TARGET_REPO", "SUPABASE_URL", "SUPABASE_KEY", "SUPABASE_SERVICE_ROLE_KEY"]);
    async function fetchRoadmap(type: string) {
      const url = `${process.env.SUPABASE_URL}/rest/v1/roadmap_items?select=content&type=eq.${type}`;
      const resp = await fetch(url, {
        headers: {
          apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY!}`,
        },
      });
      if (!resp.ok) return "";
      const data = await resp.json();
      return data.map((r: { content: string }) => r.content).join("\n");
    }
    const vision = await fetchRoadmap("vision");
    const tasks  = await fetchRoadmap("tasks");
    const bugs   = await fetchRoadmap("bugs");
    const done   = await fetchRoadmap("done");
    const fresh  = await fetchRoadmap("new");

    const state = await loadState();
    const { owner, repo } = parseRepo(ENV.TARGET_REPO);
    const commitsResp = await gh().rest.repos.listCommits({ owner, repo, per_page: 10 });
    const commitsData = [] as { sha: string; commit: { message: string } }[];
    for (const c of commitsResp.data) {
      if (c.sha === state.lastReviewedSha) break;
      commitsData.push(c);
    }
    if (commitsData.length === 0) { console.log("No new commits to review."); return; }
    const recent = commitsData.map(
      (c: { sha: string; commit: { message: string } }) =>
        `${c.sha.slice(0,7)} ${c.commit.message.split("\n")[0]}`
    );

    // 1. Generate high-level summary
    const summaryInput = { commits: recent, vision, tasks, bugs, done, fresh };
    const summary = await reviewToSummary(summaryInput);
    await upsertFile("reports/repo_summary.md", () => summary, "bot: update repo summary");

    // 2. Generate actionable ideas from summary
    const ideasInput = { summary, vision, tasks, bugs, done, fresh };
    const ideasYaml = await reviewToIdeas(ideasInput);

    // 3. Insert new ideas into Supabase
    const newIdeas = (yaml.load(ideasYaml) as { queue: any[] })?.queue || [];
    for (const idea of newIdeas) {
      const payload = {
        id: idea.id || `IDEA-${Date.now()}`,
        type: "new",
        content: yaml.dump(idea),
        created: idea.created || new Date().toISOString(),
      };
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/roadmap_items`, {
        method: "POST",
        headers: {
          apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY!}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify(payload),
      });
    }

    const headSha = commitsData[0]?.sha;
    await saveState({ ...state, lastReviewedSha: headSha });
    await appendChangelog("Reviewed repository and recorded summary.");
    await appendDecision(`Updated lastReviewedSha to ${headSha}.`);
    console.log("Review complete.");
  } finally {
    await releaseLock();
  }
}
