import { sbRequest } from "./supabase.js";

export type AgentState = {
  ingest?: { lastDeploymentTimestamp?: number; lastRowIds?: string[] };
  lastReviewedSha?: string;
};

export async function loadState(): Promise<AgentState> {
  const data = (await sbRequest("agent_state?select=data&limit=1")) as any[] | undefined;
  const row = data?.[0];
  return (row?.data as AgentState) || {};
}

export async function saveState(next: AgentState) {
  await sbRequest("agent_state", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ id: 1, data: next }),
  });
}

export async function appendChangelog(entry: string) {
  await sbRequest("agent_changelog", {
    method: "POST",
    body: JSON.stringify({ entry }),
  });
}

export async function appendDecision(entry: string) {
  await sbRequest("agent_decisions", {
    method: "POST",
    body: JSON.stringify({ entry }),
  });
}
