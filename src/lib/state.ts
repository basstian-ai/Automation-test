import { readFile, upsertFile } from "./github.js";
const STATE_PATH = "agent/STATE.json";
const CHANGELOG_PATH = "AGENT_CHANGELOG.md";
const DECISIONS_PATH = "agent/DECISIONS.md";

export type AgentState = {
  ingest?: { lastDeploymentTimestamp?: number; lastRowIds?: string[] };
  lastReviewedSha?: string;
};

export async function loadState(): Promise<AgentState> {
  const raw = await readFile(STATE_PATH);
  if (!raw) return {};
  try { return JSON.parse(raw) as AgentState; } catch { return {}; }
}

export async function saveState(next: AgentState) {
  await upsertFile(STATE_PATH, () => JSON.stringify(next, null, 2) + "\n", "bot: update state");
}

export async function appendChangelog(entry: string) {
  await upsertFile(
    CHANGELOG_PATH,
    old => (old ?? "") + entry + "\n",
    "bot: update changelog"
  );
}

export async function appendDecision(entry: string) {
  await upsertFile(
    DECISIONS_PATH,
    old => (old ?? "") + entry + "\n",
    "bot: update decisions"
  );
}
