#!/usr/bin/env node

// -----------------------------
// AI Iterative Agent
// -----------------------------
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const fetch = require("node-fetch");

// ---- ENV ----
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID;
const VERCEL_PROJECT = process.env.VERCEL_PROJECT;
const TARGET_REPO = process.env.TARGET_REPO;
const TARGET_BRANCH = process.env.TARGET_BRANCH || "main";
const PAT_TOKEN = process.env.PAT_TOKEN;

if (!OPENAI_API_KEY || !VERCEL_TOKEN || !TARGET_REPO || !PAT_TOKEN) {
  console.error("❌ Missing required environment variables.");
  process.exit(1);
}

// ---- Directories ----
const rootDir = process.cwd();
const targetDir = path.join(rootDir, "target");

// -----------------------------
// 1. Ensure target repo is cloned
// -----------------------------
if (!fs.existsSync(targetDir)) {
  console.log(`📦 Cloning target repo ${TARGET_REPO}...`);
  execSync(
    `git clone https://${PAT_TOKEN}@github.com/${TARGET_REPO}.git ${targetDir}`,
    { stdio: "inherit" }
  );
} else {
  console.log(`📂 Pulling latest changes from ${TARGET_REPO}...`);
  execSync(`git -C ${targetDir} fetch origin ${TARGET_BRANCH}`, { stdio: "inherit" });
  execSync(`git -C ${targetDir} checkout ${TARGET_BRANCH}`, { stdio: "inherit" });
  execSync(`git -C ${targetDir} pull origin ${TARGET_BRANCH}`, { stdio: "inherit" });
}

// -----------------------------
// 2. Fetch latest Vercel build status + logs
// -----------------------------
async function getVercelBuildStatus() {
  console.log("🔄 Fetching Vercel build logs...");
  const url = `https://api.vercel.com/v13/deployments?projectId=${VERCEL_PROJECT}&teamId=${VERCEL_TEAM_ID}&limit=1`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${VERCEL_TOKEN}` }
  });

  if (!res.ok) throw new Error(`Failed to fetch deployments: ${res.status}`);
  const data = await res.json();
  if (!data.deployments || !data.deployments.length) return { state: "UNKNOWN", logs: "" };

  const deployment = data.deployments[0];
  const logUrl = `https://api.vercel.com/v2/deployments/${deployment.uid}/events?teamId=${VERCEL_TEAM_ID}`;
  const logsRes = await fetch(logUrl, {
    headers: { Authorization: `Bearer ${VERCEL_TOKEN}` }
  });
  const logsText = await logsRes.text();

  const logPath = path.join(targetDir, "vercel_build.log");
  fs.writeFileSync(logPath, logsText, "utf8");

  return { state: deployment.state.toUpperCase(), logs: logsText };
}

// -----------------------------
// 3. Generate AI patch
// -----------------------------
async function generatePatch(mode, logs) {
  console.log(`🤖 Generating patch in mode: ${mode}...`);
  const prompt = `
You are an autonomous AI developer.
Current build status: ${mode}
Build logs:
${logs}

Instructions:
- If mode=FIX, identify and fix the build error.
- If mode=IMPROVE, add or enhance a small feature without breaking build.
- Output ONLY a valid git patch/diff with no explanations.
`;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0
    })
  });

  if (!res.ok) throw new Error(`OpenAI request failed: ${res.status}`);
  const data = await res.json();
  const patch = data.choices?.[0]?.message?.content?.trim();
  if (!patch.startsWith("diff")) throw new Error("Invalid patch output from AI");

  return patch;
}

// -----------------------------
// 4. Apply patch
// -----------------------------
function applyPatch(patch) {
  const patchPath = path.join(targetDir, "ai_patch.diff");
  fs.writeFileSync(patchPath, patch, "utf8");

  try {
    execSync(`git apply --check ${patchPath}`, { cwd: targetDir, stdio: "inherit" });
    execSync(`git apply ${patchPath}`, { cwd: targetDir, stdio: "inherit" });
    console.log("✅ Patch applied successfully.");
  } catch (err) {
    console.error("❌ Patch failed to apply:", err.message);
    process.exit(1);
  }
}

// -----------------------------
// 5. Commit + push changes
// -----------------------------
function pushChanges() {
  execSync("git add .", { cwd: targetDir });
  execSync(`git commit -m "AI iteration update" || echo "No changes to commit"`, {
    cwd: targetDir,
    stdio: "inherit"
  });
  execSync(`git push origin ${TARGET_BRANCH}`, { cwd: targetDir, stdio: "inherit" });
  console.log("📤 Changes pushed to target repo.");
}

// -----------------------------
// MAIN LOOP
// -----------------------------
(async () => {
  try {
    const { state, logs } = await getVercelBuildStatus();
    const mode = state === "ERROR" ? "FIX" : "IMPROVE";

    const patch = await generatePatch(mode, logs);
    applyPatch(patch);
    pushChanges();
  } catch (err) {
    console.error("❌ ERROR:", err);
    process.exit(1);
  }
})();