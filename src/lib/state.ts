import { ENV } from "./env.js";
import { readFile, upsertFile } from "./github.js";

const { SUPABASE_URL, SUPABASE_KEY } = ENV;
const HAS_SUPABASE = !!SUPABASE_URL && !!SUPABASE_KEY;

const STATE_PATH = "agent/STATE.json";
const LEGACY_STATE_PATH = "roadmap/.state/agent-state.json";
const CHANGELOG_PATH = "AGENT_CHANGELOG.md";
const DECISIONS_PATH = "agent/DECISIONS.md";

async function sbRequest(path: string, init: RequestInit = {}) {
  if (!HAS_SUPABASE) {
    throw new Error("Missing Supabase credentials");
  }
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const headers: Record<string, string> = {
    apikey: SUPABASE_KEY!,
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
  if (!HAS_SUPABASE) {
    const raw = (await readFile(STATE_PATH)) ?? (await readFile(LEGACY_STATE_PATH));
    if (!raw) return {};
    try {
      return JSON.parse(raw) as AgentState;
    } catch {
      return {};
    }
  }
  const data = (await sbRequest("agent_state?select=data&limit=1")) as any[];
  const row = data[0];
  return (row?.data as AgentState) || {};
}

export async function saveState(next: AgentState) {
  if (!HAS_SUPABASE) {
    await upsertFile(
      STATE_PATH,
      () => JSON.stringify(next, null, 2) + "\n",
      "bot: update state"
    );
    return;
  }
  await sbRequest("agent_state", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ id: 1, data: next }),
  });
}

export async function appendChangelog(entry: string) {
  if (!HAS_SUPABASE) {
    await upsertFile(
      CHANGELOG_PATH,
      old => (old ?? "") + entry + "\n",
      "bot: update changelog"
    );
    return;
  }
  await sbRequest("agent_changelog", {
    method: "POST",
    body: JSON.stringify({ entry }),
  });
}

export async function appendDecision(entry: string) {
  if (!HAS_SUPABASE) {
    await upsertFile(
      DECISIONS_PATH,
      old => (old ?? "") + entry + "\n",
      "bot: update decisions"
    );
    return;
  }
  await sbRequest("agent_decisions", {
    method: "POST",
    body: JSON.stringify({ entry }),
  });
}
