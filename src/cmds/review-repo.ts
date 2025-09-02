import { acquireLock, releaseLock } from "../lib/lock.js";
import { parseRepo, gh } from "../lib/github.js";
import { reviewToIdeas, reviewToSummary } from "../lib/prompts.js";
import { loadState, saveState, appendChangelog, appendDecision } from "../lib/state.js";
import { requireEnv, ENV } from "../lib/env.js";
import { sbRequest } from "../lib/supabase.js";
import yaml from "js-yaml";
import crypto from "node:crypto";

export async function reviewRepo() {
  if (!(await acquireLock())) { console.log("Lock taken; exiting."); return; }
  try {
    requireEnv(["TARGET_REPO", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]);
    async function fetchRoadmap(type: string) {
      const data = (await sbRequest(
        `roadmap_items?select=content&type=eq.${type}`,
      )) as { content: string }[] | undefined;
      return data ? data.map((r) => r.content).join("\n") : "";
    }
    const roadmapTypes = ["vision", "task", "bugs", "done", "new"];
    const [vision, tasks, bugs, done, ideas] = await Promise.all(
      roadmapTypes.map(fetchRoadmap),
    );

    const state = await loadState();
    const { owner, repo } = parseRepo(ENV.TARGET_REPO);
    const commitsResp = await gh.rest.repos.listCommits({ owner, repo, per_page: 10 });
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
    const summaryInput = { commits: recent, vision, tasks, bugs, done, ideas };
    const summary = await reviewToSummary(summaryInput);
    await sbRequest("roadmap_items", {
      method: "POST",
      headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({
        id: `SUMMARY-${Date.now()}`,
        type: "summary",
        content: summary,
        created: new Date().toISOString(),
      }),
    });
    console.log("Stored repo summary in Supabase.");

    // 2. Generate actionable ideas from summary
    const ideasInput = { summary, vision, tasks, bugs, done, ideas };
    const ideasYaml = await reviewToIdeas(ideasInput);
    // Normalize by removing fenced code block markers if present
    const normalizedIdeasYaml = ideasYaml
      .trim()
      .replace(/^```(?:yaml)?\n?/i, "")
      .replace(/\n?```$/, "")
      .trim();

    // 3. Insert new ideas into Supabase
    let newIdeas: any[] = [];
    try {
      newIdeas =
        (yaml.load(normalizedIdeasYaml) as { queue: any[] })?.queue || [];
    } catch (err) {
      console.error("Failed to parse ideas YAML.", err);
      console.error("Offending YAML:\n" + normalizedIdeasYaml);
      throw new Error("Failed to parse ideas YAML");
    }
    const payloads = newIdeas.map((idea) => ({
      id: idea.id || crypto.randomUUID(),
      type: "task",
      title: idea.title,
      content: idea.details,
      source: "review",
      created: idea.created || new Date().toISOString(),
    }));
    if (payloads.length > 0) {
      await sbRequest("roadmap_items", {
        method: "POST",
        headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify(payloads),
      });
    }

    const headSha = commitsData[0]?.sha;
    await saveState({ ...state, lastReviewedSha: headSha });
    await appendChangelog("Reviewed repository and stored summary in Supabase.");
    await appendDecision(`Updated lastReviewedSha to ${headSha}.`);
    console.log("Review complete.");
  } finally {
    await releaseLock();
  }
}
