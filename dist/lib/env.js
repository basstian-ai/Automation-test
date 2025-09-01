// src/lib/env.ts
export const ENV = {
    GH_USERNAME: process.env.GH_USERNAME || "ai-dev-agent",
    PAT_TOKEN: process.env.PAT_TOKEN || "",
    TARGET_REPO: process.env.TARGET_REPO || "",
    TARGET_DIR: process.env.TARGET_DIR || "",
    VERCEL_PROJECT_ID: process.env.VERCEL_PROJECT_ID || "",
    VERCEL_TEAM_ID: process.env.VERCEL_TEAM_ID || "",
    VERCEL_TOKEN: process.env.VERCEL_TOKEN || "",
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || "",
    OPENAI_MODEL: process.env.OPENAI_MODEL || "",
    WRITE_MODE: process.env.AI_BOT_WRITE_MODE || "commit",
    DRY_RUN: process.env.DRY_RUN === "1",
    BRANCH: process.env.GITHUB_REF_NAME || process.env.GITHUB_HEAD_REF || "",
    ALLOW_PATHS: (process.env.ALLOW_PATHS || "").split(",").map(s => s.trim()).filter(Boolean),
    SUPABASE_URL: process.env.SUPABASE_URL || "",
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
};
// Call this inside commands to assert only what they need.
export function requireEnv(names) {
    for (const n of names) {
        if (!process.env[n] || process.env[n] === "") {
            throw new Error(`Missing env: ${n}`);
        }
    }
}
