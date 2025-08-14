import { readFile, upsertFile } from "./github.js";
const STRATEGY = process.env.AI_LOCK_STRATEGY || "actions";
/**
 * When STRATEGY="actions" (default), rely on GitHub Actions concurrency.
 * When STRATEGY="file", write a timestamp to a repo file (optional).
 * When STRATEGY="none", always return true (not recommended in CI).
 */
export async function acquireLock(ttlSeconds = 900) {
    if (STRATEGY !== "file")
        return true; // actions/none → no file commits
    const LOCK_PATH = "roadmap/.state/lock"; // tucked away in .state
    const now = Date.now();
    const existing = await readFile(LOCK_PATH);
    if (existing) {
        const ts = Number(existing.trim());
        if (!Number.isNaN(ts) && now - ts < ttlSeconds * 1000)
            return false;
    }
    // Single commit on acquire; include [skip ci] to avoid triggering workflows in TARGET_REPO
    await upsertFile(LOCK_PATH, () => String(now) + "\n", "[skip ci] bot: acquire lock");
    return true;
}
export async function releaseLock() {
    // No-op to avoid a second "release lock" commit; TTL will expire it.
    if (STRATEGY !== "file")
        return;
    // (intentionally empty)
}
