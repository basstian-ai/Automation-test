// automation/ai-iter-agent.cjs
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const fetch = require("node-fetch");

const TARGET_REPO = process.env.TARGET_REPO;
const TARGET_BRANCH = process.env.TARGET_BRANCH || "main";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID;
const VERCEL_PROJECT = process.env.VERCEL_PROJECT;
const PAT_TOKEN = process.env.PAT_TOKEN;

if (!TARGET_REPO || !OPENAI_API_KEY) {
  console.error("Missing required environment variables");
  process.exit(1);
}

// Run shell commands and return output
function sh(cmd) {
  return execSync(cmd, { encoding: "utf8", stdio: "pipe" }).trim();
}

// Fetch latest Vercel build logs
async function getVercelBuildStatus() {
  console.log("🔄 Fetching Vercel build logs...");
  const deployList = await fetch(
    `https://api.vercel.com/v6/deployments?projectId=${VERCEL_PROJECT}&teamId=${VERCEL_TEAM_ID}&limit=1`,
    { headers: { Authorization: `Bearer ${VERCEL_TOKEN}` } }
  ).then((res) => res.json());

  if (!deployList?.deployments?.length) return null;
  const latestId = deployList.deployments[0].uid;

  const events = await fetch(
    `https://api.vercel.com/v3/deployments/${latestId}/events?teamId=${VERCEL_TEAM_ID}`,
    { headers: { Authorization: `Bearer ${VERCEL_TOKEN}` } }
  ).then((res) => res.json());

  const errorEvents = events?.filter?.((e) => e.payload?.error);
  if (errorEvents?.length) {
    console.log("Vercel state: ERROR");
    return { state: "ERROR", logs: JSON.stringify(errorEvents, null, 2) };
  }
  return { state: "READY", logs: "" };
}

// Generate a patch from AI
async function askAIForPatch(vercelState, buildLogs) {
  console.log("🧠 Asking AI for next iteration...");
  const prompt = `
You are an autonomous coding agent. The project failed with Vercel state: ${vercelState}.
Build logs:
${buildLogs}

Generate a unified diff patch to fix the problem. Do NOT include explanations — only valid patch format starting with "diff --git".
`;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0
    })
  }).then((res) => res.json());

  return response.choices?.[0]?.message?.content || "";
}

// Apply the AI patch
function applyPatch(patch) {
  if (!patch.startsWith("diff --git")) {
    console.log("⚠️ No valid patch found in AI output");
    return false;
  }
  fs.writeFileSync("ai_patch.diff", patch);
  try {
    sh("git apply --check ai_patch.diff");
    sh("git apply ai_patch.diff");
    return true;
  } catch (err) {
    console.error("❌ Patch failed to apply:", err.message);
    return false;
  }
}

// Commit & push
function commitAndPush() {
  sh("git config user.name 'github-actions[bot]'");
  sh("git config user.email 'github-actions[bot]@users.noreply.github.com'");
  try {
    sh("git add .");
    sh(`git commit -m "AI iteration"`);
    sh(`git push https://x-access-token:${PAT_TOKEN}@github.com/${TARGET_REPO}.git ${TARGET_BRANCH}`);
    console.log("✅ Changes pushed");
  } catch (err) {
    console.error("⚠️ Nothing to commit or push failed:", err.message);
  }
}

// Main loop
(async () => {
  const vercel = await getVercelBuildStatus();
  if (!vercel) {
    console.log("No deployments found. Exiting.");
    process.exit(0);
  }

  const patch = await askAIForPatch(vercel.state, vercel.logs);
  if (applyPatch(patch)) {
    commitAndPush();
  }
})();