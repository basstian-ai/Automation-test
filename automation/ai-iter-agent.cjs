#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const fetch = require("node-fetch");

// ---- ENV ----
const {
  OPENAI_API_KEY,
  VERCEL_TOKEN,
  VERCEL_TEAM_ID,
  VERCEL_PROJECT,
  TARGET_REPO,
  TARGET_BRANCH = "main",
  PAT_TOKEN
} = process.env;

if (!OPENAI_API_KEY || !VERCEL_TOKEN || !TARGET_REPO || !PAT_TOKEN) {
  console.error("❌ Missing required environment variables.");
  process.exit(1);
}

const rootDir = process.cwd();
const targetDir = path.join(rootDir, "target");
const backlogPath = path.join(targetDir, "backlog.md");

// -----------------------------
// 1. Ensure target repo
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
// 2. Fetch Vercel build status + logs
// -----------------------------
async function getVercelBuildStatus() {
  console.log("🔄 Fetching Vercel build logs...");
  const url = `https://api.vercel.com/v13/deployments?projectId=${VERCEL_PROJECT}&teamId=${VERCEL_TEAM_ID}&limit=1`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${VERCEL_TOKEN}` }
  });
  if (!res.ok) throw new Error(`Failed to fetch deployments: ${res.status}`);

  const data = await res.json();
  if (!data.deployments?.length) return { state: "UNKNOWN", logs: "" };

  const deployment = data.deployments[0];
  const logUrl = `https://api.vercel.com/v2/deployments/${deployment.uid}/events?teamId=${VERCEL_TEAM_ID}`;
  const logsRes = await fetch(logUrl, {
    headers: { Authorization: `Bearer ${VERCEL_TOKEN}` }
  });
  const logsText = await logsRes.text();

  fs.writeFileSync(path.join(targetDir, "vercel_build.log"), logsText, "utf8");
  return { state: deployment.state.toUpperCase(), logs: logsText };
}

// -----------------------------
// 3. Backlog handling
// -----------------------------
async function ensureBacklog() {
  if (!fs.existsSync(backlogPath) || fs.readFileSync(backlogPath, "utf8").trim() === "") {
    console.log("📝 Backlog missing — generating...");
    const prompt = `
Generate a markdown backlog of the next 5 best-practice features to add
to a modern PIM (Product Information Management) system. 
Number them 1–5, short descriptions, each on one line.
Avoid things already standard in most starter templates.
`;
    const backlog = await callOpenAI(prompt);
    fs.writeFileSync(backlogPath, backlog, "utf8");
  }
}

function getNextBacklogItem() {
  const lines = fs.readFileSync(backlogPath, "utf8").split("\n").filter(l => l.trim());
  if (!lines.length) return null;
  return lines[0];
}

function removeBacklogItem(item) {
  const lines = fs.readFileSync(backlogPath, "utf8").split("\n").filter(l => l.trim() && l.trim() !== item.trim());
  fs.writeFileSync(backlogPath, lines.join("\n"), "utf8");
}

// -----------------------------
// 4. AI calls
// -----------------------------
async function callOpenAI(prompt) {
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
  return data.choices?.[0]?.message?.content?.trim();
}

async function generatePatch(mode, logs, backlogItem) {
  console.log(`🤖 Generating patch in mode: ${mode}...`);
  let prompt = "";

  if (mode === "FIX") {
    prompt = `
You are an autonomous AI developer. 
The Vercel build failed. Fix the problem based on these logs:
${logs}
Output ONLY a valid unified git diff/patch.
`;
  } else {
    prompt = `
You are an autonomous AI developer.
The build is green. Implement the next backlog feature for a modern PIM system:
"${backlogItem}"
Follow best practices. Do not break the build.
Output ONLY a valid unified git diff/patch.
`;
  }
  const patch = await callOpenAI(prompt);
  if (!patch.startsWith("diff")) throw new Error("Invalid patch output from AI");
  return patch;
}

// -----------------------------
// 5. Apply + push
// -----------------------------
function applyPatch(patch) {
  const patchPath = path.join(targetDir, "ai_patch.diff");
  fs.writeFileSync(patchPath, patch, "utf8");
  execSync(`git apply --check ai_patch.diff`, { cwd: targetDir, stdio: "inherit" });
  execSync(`git apply ai_patch.diff`, { cwd: targetDir, stdio: "inherit" });
}

function pushChanges() {
  execSync("git add .", { cwd: targetDir });
  execSync(`git commit -m "AI iteration update" || echo "No changes"`, { cwd: targetDir, stdio: "inherit" });
  execSync(`git push origin ${TARGET_BRANCH}`, { cwd: targetDir, stdio: "inherit" });
}

// -----------------------------
// MAIN
// -----------------------------
(async () => {
  try {
    const { state, logs } = await getVercelBuildStatus();
    const mode = state === "ERROR" ? "FIX" : "IMPROVE";

    if (mode === "IMPROVE") {
      await ensureBacklog();
      const nextItem = getNextBacklogItem();
      if (!nextItem) {
        console.log("✅ Backlog empty, nothing to improve.");
        return;
      }
      const patch = await generatePatch(mode, logs, nextItem);
      applyPatch(patch);
      removeBacklogItem(nextItem);
    } else {
      const patch = await generatePatch(mode, logs, null);
      applyPatch(patch);
    }

    pushChanges();
    console.log("🚀 Iteration complete.");
  } catch (err) {
    console.error("❌ ERROR:", err);
    process.exit(1);
  }
})();