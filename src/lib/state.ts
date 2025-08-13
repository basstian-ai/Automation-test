import { readFile, upsertFile } from "./github.js";
const STATE_PATH = "roadmap/.state/agent-state.json";

export type AgentState = {
  ingest?: { lastDeploymentId?: string; lastRowIds?: string[] };
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
