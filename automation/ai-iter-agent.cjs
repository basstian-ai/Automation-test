#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const fetch = require("node-fetch");

const {
  OPENAI_API_KEY,
  VERCEL_TOKEN,
  VERCEL_TEAM_ID,
  VERCEL_PROJECT,
  TARGET_BRANCH,
} = process.env;

const targetDir = path.join(process.cwd(), "target");
const logFilePath = path.join(targetDir, "vercel_build.log");

async function fetchVercelLogs() {
  console.log("🔄 Fetching Vercel build logs...");

  // 1. Get latest deployment
  const deployList = await fetch(
    `https://api.vercel.com/v6/deployments?projectId=${VERCEL_PROJECT}&teamId=${VERCEL_TEAM_ID}&limit=1`,
    {
      headers: { Authorization: `Bearer ${VERCEL_TOKEN}` },
    }
  ).then((res) => res.json());

  if (!deployList.deployments || !deployList.deployments.length) {
    throw new Error("No deployments found.");
  }
  const deployId = deployList.deployments[0].uid;

  // 2. Get events/logs for that deployment
  const events = await fetch(
    `https://api.vercel.com/v3/deployments/${deployId}/events?teamId=${VERCEL_TEAM_ID}`,
    {
      headers: { Authorization: `Bearer ${VERCEL_TOKEN}` },
    }
  ).then((res) => res.json());

  const logText = events.map((e) => e.payload?.text || "").join("\n");
  fs.writeFileSync(logFilePath, logText);
  console.log(`📝 Logs saved to ${logFilePath}`);

  return logText;
}

async function run() {
  // Ensure target repo exists
  if (!fs.existsSync(targetDir)) {
    console.error("❌ Target directory not found.");
    process.exit(1);
  }

  // Get latest build logs
  const buildLogs = await fetchVercelLogs();

  // Build AI prompt
  const prompt = `
You are an AI developer. The goal is to make the Vercel build green.

Repository path: ${targetDir}
Branch: ${TARGET_BRANCH}

Vercel build logs:
\`\`\`
${buildLogs}
\`\`\`

Task:
1. Identify the cause of the build failure from logs.
2. Modify the code in the target repo to fix the issue.
3. If build is already green, improve existing features.

Output ONLY the 'git diff' patch.
`;

  console.log("🤖 Sending prompt to OpenAI...");
  const aiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
    }),
  }).then((res) => res.json());

  const patch = aiResponse.choices?.[0]?.message?.content;
  if (!patch) {
    console.error("❌ No patch returned from AI.");
    process.exit(1);
  }

  // Apply patch
  fs.writeFileSync(path.join(process.cwd(), "ai_patch.diff"), patch);
  try {
    execSync("git apply --check ai_patch.diff", { cwd: targetDir });
    execSync("git apply ai_patch.diff", { cwd: targetDir });
    console.log("✅ Patch applied.");
  } catch (err) {
    console.error("❌ Patch failed to apply:", err.message);
    process.exit(1);
  }

  // Commit & push
  try {
    execSync("git config user.name 'AI Bot'", { cwd: targetDir });
    execSync("git config user.email 'ai-bot@example.com'", { cwd: targetDir });
    execSync("git add .", { cwd: targetDir });
    execSync(`git commit -m "AI: ${new Date().toISOString()}"`, {
      cwd: targetDir,
    });
    execSync(`git push origin ${TARGET_BRANCH}`, { cwd: targetDir });
    console.log("📤 Changes pushed.");
  } catch {
    console.log("ℹ️ Nothing to commit.");
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});