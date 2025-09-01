import { ENV } from "./env.js";

const { SUPABASE_URL, SUPABASE_KEY } = ENV;

async function sbRequest(path: string, init: RequestInit = {}) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return [];
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const headers: Record<string, string> = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json",
    ...(init.headers as Record<string, string>),
  };
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    throw new Error(`Supabase error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export type AgentState = {
  ingest?: { lastDeploymentTimestamp?: number; lastRowIds?: string[] };
  lastReviewedSha?: string;
};

export async function loadState(): Promise<AgentState> {
  const data = (await sbRequest("agent_state?select=data&limit=1")) as any[];
  const row = data[0];
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
