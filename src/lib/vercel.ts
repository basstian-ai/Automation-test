import { ENV } from "./env.js";

const API = "https://api.vercel.com";

async function vfetch(path: string, params: Record<string, string | undefined> = {}) {
  const url = new URL(API + path);
  for (const [k,v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${ENV.VERCEL_TOKEN}` } });
  if (!res.ok) throw new Error(`Vercel ${path} failed: ${res.status}`);
  return res.json();
}

export async function getLatestProdDeployment() {
  if (!ENV.VERCEL_PROJECT_ID) return undefined;
  const data = await vfetch("/v6/deployments", {
    projectId: ENV.VERCEL_PROJECT_ID,
    target: "production",
    limit: "1",
    teamId: ENV.VERCEL_TEAM_ID || undefined
  }) as any;
  return data.deployments?.[0];
}

export async function getRuntimeLogs(deploymentId: string) {
  if (!ENV.VERCEL_PROJECT_ID) return [];
  const url = new URL(`${API}/v1/projects/${ENV.VERCEL_PROJECT_ID}/deployments/${deploymentId}/runtime-logs`);
  if (ENV.VERCEL_TEAM_ID) url.searchParams.set("teamId", ENV.VERCEL_TEAM_ID);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${ENV.VERCEL_TOKEN}` } });
  if (!res.ok) throw new Error(`Vercel runtime-logs failed: ${res.status}`);
  const text = await res.text();
  return text.split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
