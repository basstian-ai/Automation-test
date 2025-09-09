import { requireEnv } from "./lib/env.js";
/**
 * Resolve repository configuration from environment variables.
 *
 * Required:
 *   - TARGET_OWNER (e.g. "basstian-ai")
 *   - TARGET_REPO (e.g. "simple-pim-1754492683911")
 */
export function parseRepo() {
    requireEnv(["TARGET_OWNER", "TARGET_REPO"]);
    return {
        owner: process.env.TARGET_OWNER,
        repo: process.env.TARGET_REPO,
    };
}
