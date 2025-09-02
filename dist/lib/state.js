import { sbRequest } from "./supabase.js";
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
