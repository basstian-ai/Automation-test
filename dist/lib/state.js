import { readFile, upsertFile } from "./github.js";
const STATE_PATH = "roadmap/.state/agent-state.json";
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
