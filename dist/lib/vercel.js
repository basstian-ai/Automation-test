import { ENV } from "./env.js";
const API = "https://api.vercel.com";
async function vfetch(path, params = {}) {
    const url = new URL(API + path);
    for (const [k, v] of Object.entries(params))
        if (v)
            url.searchParams.set(k, v);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${ENV.VERCEL_TOKEN}` } });
    if (!res.ok)
        throw new Error(`Vercel ${path} failed: ${res.status}`);
    return res.json();
}
export async function getLatestDeployment() {
    if (!ENV.VERCEL_PROJECT_ID)
        return undefined;
    const data = await vfetch("/v6/deployments", {
        projectId: ENV.VERCEL_PROJECT_ID,
        limit: "1",
        state: "READY,ERROR,CANCELED",
        teamId: ENV.VERCEL_TEAM_ID || undefined
    });
    return data.deployments?.[0];
}
export async function getRuntimeLogs(deploymentId, opts = {}) {
    if (!ENV.VERCEL_PROJECT_ID)
        return [];
    const url = new URL(`${API}/v1/projects/${ENV.VERCEL_PROJECT_ID}/deployments/${deploymentId}/runtime-logs`);
    if (ENV.VERCEL_TEAM_ID)
        url.searchParams.set("teamId", ENV.VERCEL_TEAM_ID);
    const { fromId, from, until, limit, direction } = opts;
    if (fromId)
        url.searchParams.set("from", fromId);
    else if (from)
        url.searchParams.set("from", from);
    if (until)
        url.searchParams.set("until", until);
    if (limit !== undefined)
        url.searchParams.set("limit", String(limit));
    if (direction)
        url.searchParams.set("direction", direction);
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 30_000);
    let res;
    try {
        res = await fetch(url, {
            headers: { Authorization: `Bearer ${ENV.VERCEL_TOKEN}` },
            signal: controller.signal
        });
    }
    catch (err) {
        if (err.name === "AbortError") {
            console.warn("Vercel runtime-logs request timed out");
        }
        throw err;
    }
    finally {
        clearTimeout(t);
    }
    if (!res.ok)
        throw new Error(`Vercel runtime-logs failed: ${res.status}`);
    const text = await res.text();
    return text
        .split("\n")
        .filter(Boolean)
        .map(l => {
        try {
            return JSON.parse(l);
        }
        catch {
            return null;
        }
    })
        .filter(Boolean);
}
