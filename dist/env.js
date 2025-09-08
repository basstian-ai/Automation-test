/**
 * Resolve repository configuration from environment variables.
 *
 * Required:
 *   - TARGET_OWNER (e.g. "basstian-ai")
 *   - TARGET_REPO (e.g. "simple-pim-1754492683911")
 */
export function parseRepo() {
    const targetOwner = process.env.TARGET_OWNER;
    const targetRepo = process.env.TARGET_REPO;
    if (!targetOwner || !targetRepo) {
        throw new Error("Missing required TARGET_OWNER and TARGET_REPO environment variables");
    }
    return {
        owner: targetOwner,
        repo: targetRepo,
    };
}
