import { ENV } from "./env.js";
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = ENV;
function requireSupabase() {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
        throw new Error("Missing Supabase credentials: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is undefined");
    }
}
async function sbRequest(path, init = {}) {
    requireSupabase();
    const url = `${SUPABASE_URL}/rest/v1/${path}`;
    const headers = {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        ...init.headers,
    };
    const res = await fetch(url, { ...init, headers });
    if (!res.ok) {
        throw new Error(`Supabase error: ${res.status} ${res.statusText}`);
    }
    if (res.status === 204 || res.headers.get("Content-Length") === "0") {
        return undefined;
    }
    return res.json();
}
export async function loadState() {
    const data = (await sbRequest("agent_state?select=data&limit=1"));
    const row = data?.[0];
    return row?.data || {};
}
export async function saveState(next) {
    await sbRequest("agent_state", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({ id: 1, data: next }),
    });
}
export async function appendChangelog(entry) {
    await sbRequest("agent_changelog", {
        method: "POST",
        body: JSON.stringify({ entry }),
    });
}
export async function appendDecision(entry) {
    await sbRequest("agent_decisions", {
        method: "POST",
        body: JSON.stringify({ entry }),
    });
}
