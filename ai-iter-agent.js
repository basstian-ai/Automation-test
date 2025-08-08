#!/usr/bin/env node

import { execSync, spawnSync } from "child_process";
import fs from "fs";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const TARGET_BRANCH = process.env.TARGET_BRANCH || "main";
const TARGET_REPO = process.env.TARGET_REPO || "";
const vercelToken = process.env.VERCEL_TOKEN;
const vercelTeamId = process.env.VERCEL_TEAM_ID;
const vercelProject = process.env.VERCEL_PROJECT;

function run(cmd) {
  return execSync(cmd, { stdio: "pipe" }).toString().trim();
}

async function getVercelLogs() {
  console.log("🔄 Fetching Vercel build logs...");
  if (!vercelToken || !vercelTeamId || !vercelProject) {
    return "No Vercel credentials provided.";
  }

  try {
    const deployments = JSON.parse(run(
      `curl -s -H "Authorization: Bearer ${vercelToken}" "https://api.vercel.com/v6/deployments?teamId=${vercelTeamId}&projectId=${vercelProject}&limit=1"`
    ));

    if (!deployments.deployments?.length) return "No deployments found.";
    const latestId = deployments.deployments[0].uid;

    const logs = run(
      `curl -s -H "Authorization: Bearer ${vercelToken}" "https://api.vercel.com/v2/deployments/${latestId}/events?teamId=${vercelTeamId}"`
    );

    return logs;
  } catch (err) {
    console.error("Error fetching logs:", err);
    return "Error fetching logs.";
  }
}

async function getAIPlan(buildLogs) {
  const prompt = `
You are an autonomous AI software engineer improving a PIM system in a continuous loop.
If the build logs show an error, fix it.
If the build is successful, implement the next most valuable feature based on modern PIM best practices.

Your output must be ONLY a valid unified git diff starting with 'diff --git'.
No prose, no explanation, no markdown.
The diff must apply cleanly to the current repository and include all file changes needed.
`;

  let patch = "";
  let attempts = 0;
  while (!patch.startsWith("diff --git") && attempts < 5) {
    attempts++;
    console.log(`🤖 Asking AI for iteration (attempt ${attempts})...`);
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: `Build logs:\n${buildLogs}\n\nCurrent repo state is ready for patching.` }
      ]
    });

    patch = res.choices[0].message.content.trim();
    if (!patch.startsWith("diff --git")) {
      console.warn("⚠️ AI output invalid, retrying...");
    }
  }

  if (!patch.startsWith("diff --git")) {
    throw new Error("AI failed to produce a valid patch after 5 attempts.");
  }

  return patch;
}

function applyPatch(patch) {
  fs.writeFileSync("ai_patch.diff", patch);
  try {
    run("git config user.name 'AI Dev Agent'");
    run("git config user.email 'ai-agent@example.com'");
    run("git apply ai_patch.diff");
    console.log("✅ Patch applied.");
    fs.unlinkSync("ai_patch.diff");
  } catch (err) {
    console.error("❌ Failed to apply patch:", err);
    process.exit(1);
  }
}

function commitAndPush() {
  try {
    run(`git add .`);
    run(`git commit -m "AI iteration update" || echo "No changes to commit"`);
    run(`git push origin ${TARGET_BRANCH}`);
    console.log("🚀 Changes pushed.");
  } catch (err) {
    console.error("❌ Push failed:", err);
    process.exit(1);
  }
}

(async () => {
  console.log("📦 Installing dependencies...");
  run("npm install");

  const logs = await getVercelLogs();
  const patch = await getAIPlan(logs);
  applyPatch(patch);
  commitAndPush();
})();