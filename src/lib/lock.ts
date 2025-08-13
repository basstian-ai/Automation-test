import { readFile, upsertFile } from "./github.js";

const LOCK_PATH = "roadmap/.lock";

export async function acquireLock(ttlSeconds = 900): Promise<boolean> {
  const now = Date.now();
  const existing = await readFile(LOCK_PATH);
  if (existing) {
    const ts = Number(existing.trim());
    if (!Number.isNaN(ts) && now - ts < ttlSeconds * 1000) return false;
  }
  await upsertFile(LOCK_PATH, () => String(now), "bot: acquire lock");
  return true;
}

export async function releaseLock() {
  // Overwrite with 0 rather than delete to avoid permissions edge cases
  await upsertFile(LOCK_PATH, () => "0\n", "bot: release lock");
}
