import { readFile, upsertFile } from "./github.js";
const STATE_PATH = "agent/STATE.json";
const CHANGELOG_PATH = "AGENT_CHANGELOG.md";
const DECISIONS_PATH = "agent/DECISIONS.md";
export async function loadState() {
    const raw = await readFile(STATE_PATH);
    if (!raw)
        return {};
    try {
        return JSON.parse(raw);
    }
    catch {
        return {};
    }
}
export async function saveState(next) {
    await upsertFile(STATE_PATH, () => JSON.stringify(next, null, 2) + "\n", "bot: update state");
}
export async function appendChangelog(entry) {
    await upsertFile(CHANGELOG_PATH, old => (old ?? "") + entry + "\n", "bot: update changelog");
}
export async function appendDecision(entry) {
    await upsertFile(DECISIONS_PATH, old => (old ?? "") + entry + "\n", "bot: update decisions");
}
