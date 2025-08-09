#!/usr/bin/env node

import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";

// ==== ENV VARS ====
const {
  OPENAI_API_KEY,
  VERCEL_TOKEN,
  VERCEL_TEAM_ID,
  VERCEL_PROJECT,
  TARGET_REPO,
  TARGET_BRANCH,
  PAT_TOKEN
} = process.env;

// ==== PRE-FLIGHT CHECKS ====
function assertEnv(name, value) {
  if (!value || value.trim() === "") {
    console.error(`❌ ERROR: Missing required env var: ${name}`);
    process.exit(1);
  }
}

[
  "OPENAI_API_KEY",
  "VERCEL_TOKEN",
  "VERCEL_TEAM_ID",
  "VERCEL_PROJECT",
  "TARGET_REPO",
  "TARGET_BRANCH",
  "PAT_TOKEN"
].forEach((name) => assertEnv(name, process.env[name]));

console.log(`🎯 Target repo: ${TARGET_REPO} @ ${TARGET_BRANCH}`);

// ==== HELPERS ====
function run(cmd, opts = {}) {
  console.log(`$ ${cmd}`);
  return execSync(cmd, { stdio: "pipe", encoding: "utf8", ...opts }).trim();
}

// ==== FETCH LATEST VERCEL DEPLOY ====
async function getVercelBuildStatus() {
  // Prefer projectId param, fallback to project slug param
  const urls = [
    `https://api.vercel.com/v6/deployments?projectId=${VERCEL_PROJECT}&teamId=${VERCEL_TEAM_ID}&limit=1`,
    `https://api.vercel.com/v6/deployments?project=${VERCEL_PROJECT}&teamId=${VERCEL_TEAM_ID}&limit=1`
  ];

  for (const url of urls) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${VERCEL_TOKEN}` }
    });
    if (res.ok) {
      const data = await res.json();
      if (data.deployments?.length) {
        const latest = data.deployments[0];
        return { state: latest.state.toUpperCase(), id: latest.uid };
      }
    }
  }
  throw new Error("❌ Failed to fetch Vercel deployments with provided credentials.");
}

// ==== MAIN LOOP ====
(async () => {
  try {
    // Ensure repo is up-to-date
    console.log("📂 Pulling latest changes...");
    run(`git fetch origin ${TARGET_BRANCH}`);
    run(`git checkout ${TARGET_BRANCH}`);
    run(`git reset --hard origin/${TARGET_BRANCH}`);

    // Check Vercel build status
    console.log("🔄 Fetching Vercel build logs...");
    const { state, id } = await getVercelBuildStatus();
    console.log(`🔍 Mode: ${state === "ERROR" ? "FIX" : "IMPROVE"} (Vercel state: ${state})`);

    // Build AI prompt
    const logsPath = path.join(process.cwd(), "vercel_build.log");
    const logsRes = await fetch(`https://api.vercel.com/v2/deployments/${id}/events`, {
      headers: { Authorization: `Bearer ${VERCEL_TOKEN}` }
    });
    const logsData = await logsRes.json();
    fs.writeFileSync(logsPath, JSON.stringify(logsData, null, 2));

    const prompt = `
      You are an autonomous dev agent.
      The current build status is: ${state}.
      If status=ERROR, fix the build. If status=READY, improve code with a useful enhancement.
      Here are the latest build logs:\n${JSON.stringify(logsData)}
    `;

    // Call OpenAI
    console.log("🤖 Sending prompt to OpenAI...");
    const aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
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

    const aiData = await aiRes.json();
    const patchContent = aiData.choices?.[0]?.message?.content?.trim();
    if (!patchContent || !patchContent.includes("diff")) {
      console.log("⚠️ AI did not return a valid diff.");
      process.exit(0);
    }

    fs.writeFileSync("ai_patch.diff", patchContent);

    // Apply patch
    try {
      run("git apply --check ai_patch.diff");
      run("git apply ai_patch.diff");
    } catch (err) {
      console.error("⚠️ Patch failed to apply directly, trying 'patch' command...");
      run("patch -p1 < ai_patch.diff");
    }

    // Commit & push
    run(`git config user.name "ai-bot"`);
    run(`git config user.email "ai-bot@users.noreply.github.com"`);
    run(`git add .`);
    run(`git commit -m "AI iteration: ${new Date().toISOString()}" || echo "No changes to commit"`);
    run(`git push origin ${TARGET_BRANCH}`);

    console.log("✅ Changes pushed");
  } catch (err) {
    console.error(`❌ ERROR: ${err.message}`);
    process.exit(1);
  }
})();