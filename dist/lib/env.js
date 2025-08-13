export const ENV = {
    GH_USERNAME: must("GH_USERNAME"),
    PAT_TOKEN: must("PAT_TOKEN"),
    TARGET_REPO: must("TARGET_REPO"), // "owner/repo"
    TARGET_DIR: process.env.TARGET_DIR || "", // e.g., "" or "subdir"
    VERCEL_PROJECT_ID: process.env.VERCEL_PROJECT_ID || "",
    VERCEL_TEAM_ID: process.env.VERCEL_TEAM_ID || "",
    VERCEL_TOKEN: process.env.VERCEL_TOKEN || "",
    OPENAI_API_KEY: must("OPENAI_API_KEY"),
    OPENAI_MODEL: process.env.OPENAI_MODEL || "gpt-4o-mini",
    WRITE_MODE: process.env.AI_BOT_WRITE_MODE || "commit", // commit|pr
    DRY_RUN: process.env.DRY_RUN === "1",
    ALLOW_PATHS: (process.env.ALLOW_PATHS || "").split(",").map(s => s.trim()).filter(Boolean),
};
function must(name) {
    const v = process.env[name];
    if (!v)
        throw new Error(`Missing env: ${name}`);
    return v;
}
