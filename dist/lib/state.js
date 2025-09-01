import { ENV } from "./env.js";
import { readFile, upsertFile } from "./github.js";
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = ENV;
const HAS_SUPABASE = !!SUPABASE_URL && !!SUPABASE_SERVICE_ROLE_KEY;
const STATE_PATH = "agent/STATE.json";
const LEGACY_STATE_PATH = "roadmap/.state/agent-state.json";
const CHANGELOG_PATH = "AGENT_CHANGELOG.md";
const DECISIONS_PATH = "agent/DECISIONS.md";
async function sbRequest(path, init = {}) {
    if (!HAS_SUPABASE) {
        throw new Error("Missing Supabase credentials");
    }
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
    return res.json();
}
export async function loadState() {
    if (!HAS_SUPABASE) {
        const raw = (await readFile(STATE_PATH)) ?? (await readFile(LEGACY_STATE_PATH));
        if (!raw)
            return {};
        try {
            return JSON.parse(raw);
        }
        catch {
            return {};
        }
    }
    const data = (await sbRequest("agent_state?select=data&limit=1"));
    const row = data[0];
    return row?.data || {};
}
export async function saveState(next) {
    if (!HAS_SUPABASE) {
        await upsertFile(STATE_PATH, () => JSON.stringify(next, null, 2) + "\n", "bot: update state");
        return;
    }
    await sbRequest("agent_state", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({ id: 1, data: next }),
    });
}
export async function appendChangelog(entry) {
    if (!HAS_SUPABASE) {
        await upsertFile(CHANGELOG_PATH, old => (old ?? "") + entry + "\n", "bot: update changelog");
        return;
    }
    await sbRequest("agent_changelog", {
        method: "POST",
        body: JSON.stringify({ entry }),
    });
}
export async function appendDecision(entry) {
    if (!HAS_SUPABASE) {
        await upsertFile(DECISIONS_PATH, old => (old ?? "") + entry + "\n", "bot: update decisions");
        return;
    }
    await sbRequest("agent_decisions", {
        method: "POST",
        body: JSON.stringify({ entry }),
    });
}
