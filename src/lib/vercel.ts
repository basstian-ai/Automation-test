import { ENV } from "./env.js";

const API = "https://api.vercel.com";

async function vfetch(path: string, params: Record<string, string | undefined> = {}) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${ENV.VERCEL_TOKEN}` } });
  if (!res.ok) throw new Error(`Vercel ${path} failed: ${res.status}`);
  return res.json();
}

export async function getLatestDeployment() {
  if (!ENV.VERCEL_PROJECT_ID) return undefined;
  const data = await vfetch("/v6/deployments", {
    projectId: ENV.VERCEL_PROJECT_ID,
    limit: "1",
    state: "READY,ERROR,CANCELED",
    teamId: ENV.VERCEL_TEAM_ID || undefined
  }) as any;
  return data.deployments?.[0];
}

export async function* getBuildLogs(
  deploymentId: string,
  opts: {
    fromId?: string;
    from?: string;
    until?: string;
    limit?: number;
    direction?: string;
  } = {},
) : AsyncGenerator<any, void, unknown> {
  if (!ENV.VERCEL_PROJECT_ID) return;
  const url = new URL(
    `${API}/v6/deployments/${deploymentId}/build-logs`
  );
  if (ENV.VERCEL_TEAM_ID) url.searchParams.set("teamId", ENV.VERCEL_TEAM_ID);
  const { fromId, from, until, limit, direction } = opts;
  if (fromId) url.searchParams.set("from", fromId);
  else if (from) url.searchParams.set("from", from);
  if (until) url.searchParams.set("until", until);
  if (limit !== undefined) url.searchParams.set("limit", String(limit));
  if (direction) url.searchParams.set("direction", direction);

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 180_000);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${ENV.VERCEL_TOKEN}` },
      signal: controller.signal
    });
  } catch (err) {
    if ((err as any).name === "AbortError") {
      console.warn("Vercel build-logs request timed out");
    }
    throw err;
  } finally {
    clearTimeout(t);
  }
  if (res.status === 404) return;
  if (!res.ok) throw new Error(`Vercel build-logs failed: ${res.status}`);

  const reader = res.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        yield JSON.parse(line);
      } catch {
        // ignore malformed lines
      }
    }
  }
  if (buffer.trim()) {
    try {
      yield JSON.parse(buffer);
    } catch {
      // ignore
    }
  }
}

