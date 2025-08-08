#!/usr/bin/env node

/**
 * AI Iteration Agent
 * - Fetches latest Vercel build logs
 * - If build fails => AI generates patch to fix
 * - If build succeeds => AI implements next useful feature (PIM best practices)
 * - Applies patch, commits, pushes
 * - Self-iterates
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const fetch = require("node-fetch");

const sh = (cmd) => execSync(cmd, { encoding: "utf8" }).trim();

// ===== CONFIG =====
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
const VERCEL_PROJECT = process.env.VERCEL_PROJECT;
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID;
const TARGET_REPO = process.env.TARGET_REPO;
const TARGET_BRANCH = process.env.TARGET_BRANCH || "main";
const PAT_TOKEN = process.env.PAT_TOKEN;

// ===== HELPERS =====
async function fetchVercelLogs() {
  try {
    const depRes = await fetch(
      `https://api.vercel.com/v6/deployments?projectId=${VERCEL_PROJECT}&teamId=${VERCEL_TEAM_ID}&limit=1`,
      { headers: { Authorization: `Bearer ${VERCEL_TOKEN}` } }
    );
    const depData = await depRes.json();
    const latest = depData.deployments?.[0];
    if (!latest) return null;

    const eventsRes = await fetch(
      `https://api.vercel.com/v3/deployments/${latest.uid}/events?teamId=${VERCEL_TEAM_ID}`,
      { headers: { Authorization: `Bearer ${VERCEL_TOKEN}` } }
    );
    const eventsData = await eventsRes.json();
    return JSON.stringify(eventsData, null, 2).slice(0, 8000);
  } catch (err) {
    console.error("Failed to fetch Vercel logs:", err);
    return null;
  }
}

function repoContext() {
  const files = sh(`git ls-files`).split("\n").slice(0, 400).join("\n");
  const criticalFiles = ["package.json", "next.config.js", "vercel.json"];
  let criticalContents = "";
  for (const file of criticalFiles) {
    if (fs.existsSync(file)) {
      criticalContents += `\n--- FILE: ${file} ---\n` + fs.readFileSync(file, "utf8") + "\n";
    }
  }
  const lastCommit = sh(`git log -1 --pretty=%B`).trim();
  return { files, criticalContents, lastCommit };
}

async function askOpenAI(prompt) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
    }),
  });
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

function applyPatch(patch) {
  fs.writeFileSync("ai_patch.diff", patch);
  try {
    sh(`git apply --check ai_patch.diff`);
    sh(`git apply ai_patch.diff`);
    return true;
  } catch {
    return false;
  }
}

function commitAndPush(message) {
  sh(`git config user.email "github-actions[bot]@users.noreply.github.com"`);
  sh(`git config user.name "github-actions[bot]"`);
  sh(`git add -A`);
  try {
    sh(`git commit -m "${message}"`);
  } catch {
    console.log("No changes to commit");
    return;
  }
  sh(`git push https://${PAT_TOKEN}@github.com/${TARGET_REPO}.git ${TARGET_BRANCH}`);
}

// ===== MAIN LOOP =====
async function run() {
  console.log("🔄 Fetching Vercel build logs...");
  const logs = await fetchVercelLogs();
  const ctx = repoContext();

  // Determine mode
  const mode = logs && logs.includes('"type":"error"') ? "FIX" : "FEATURE";
  console.log(`🔍 Mode: ${mode}`);

  const featurePrompt = `
The project is a modern PIM (Product Information Management) system.
Implement the next small but valuable feature based on best practices from leading PIMs.
Examples: product versioning, bulk editing, advanced search, workflow automation, etc.
Do not break the build. Write clean, modular code.
`;

  const userPrompt = `
Mode: ${mode}
Build logs:
${logs || "(none)"}

Repository file list (first ~400 files):
${ctx.files}

Critical file contents for reference:
${ctx.criticalContents}

Last commit message:
${ctx.lastCommit}

Rules for patch:
- Output ONLY a valid unified git diff
- Match existing lines exactly so patch applies cleanly
- If you don't need to change package.json, don't include it
- For FIX mode: fix build errors seen in logs
- For FEATURE mode: implement next useful PIM feature
- Keep changes small and safe, so builds stay green
${mode === "FEATURE" ? featurePrompt : ""}
`;

  let patch;
  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`🤖 Generating patch (attempt ${attempt})...`);
    patch = await askOpenAI(userPrompt);
    if (applyPatch(patch)) {
      commitAndPush(`${mode === "FIX" ? "fix" : "feat"}: AI iteration`);
      console.log("✅ Patch applied and pushed");
      return;
    } else {
      console.log("⚠️ Patch failed to apply, retrying…");
    }
  }
  console.log("⏭️ Skipping: no valid patch after 3 attempts.");
}

run();