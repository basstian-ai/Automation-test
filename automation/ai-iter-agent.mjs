#!/usr/bin/env node
import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import { execSync } from "child_process";
import process from "process";

const __dirname = path.dirname(new URL(import.meta.url).pathname);

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

const runCmd = (cmd, cwd = ".") => {
  console.log(`$ ${cmd}`);
  return execSync(cmd, { cwd, stdio: "pipe", encoding: "utf-8" }).trim();
};

// 1. Pull latest target repo
console.log("📂 Pulling latest changes...");
runCmd(`git -C target fetch origin ${TARGET_BRANCH}`);
runCmd(`git -C target checkout ${TARGET_BRANCH}`);
runCmd(`git -C target pull origin ${TARGET_BRANCH}`);

// 2. Get latest Vercel build status
async function getVercelBuildLogs() {
  const url = `https://api.vercel.com/v6/deployments?projectId=${VERCEL_PROJECT}&teamId=${VERCEL_TEAM_ID}&limit=1`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${VERCEL_TOKEN}` }
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch deployments: ${res.status}`);
  }
  const data = await res.json();
  const deployment = data.deployments?.[0];
  if (!deployment) throw new Error("No deployments found.");

  const logsUrl = `https://api.vercel.com/v2/deployments/${deployment.uid}/events?teamId=${VERCEL_TEAM_ID}`;
  const logsRes = await fetch(logsUrl, {
    headers: { Authorization: `Bearer ${VERCEL_TOKEN}` }
  });
  const logs = await logsRes.text();
  fs.writeFileSync(path.join(__dirname, "../target/vercel_build.log"), logs);
  console.log("📝 Build logs saved.");
  return { state: deployment.state, logs };
}

// 3. Send context to OpenAI for fix/improvement
async function getAIPatch(state, logs) {
  const prompt = `
You are an autonomous AI developer. The last Vercel deployment state was "${state}".
Build logs:
\`\`\`
${logs}
\`\`\`
If state is ERROR, fix the cause. If READY, improve a feature in the Next.js PIM system.
Return a valid unified diff patch.
  `.trim();

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

  const json = await res.json();
  const patch = json.choices?.[0]?.message?.content?.trim();
  if (!patch.startsWith("diff")) {
    throw new Error("No valid diff returned by AI");
  }
  fs.writeFileSync(path.join(__dirname, "../target/ai_patch.diff"), patch);
  return patch;
}

// 4. Apply patch
function applyPatch() {
  const patchPath = path.join(__dirname, "../target/ai_patch.diff");
  runCmd(`git -C target apply ${patchPath} --whitespace=fix`);
  runCmd(`git -C target add .`);
  runCmd(`git -C target commit -m "AI Iteration Update"`);
  runCmd(`git -C target push origin ${TARGET_BRANCH}`);
}

(async () => {
  try {
    const { state, logs } = await getVercelBuildLogs();
    const patch = await getAIPatch(state, logs);
    console.log("✅ AI Patch Generated");
    applyPatch();
  } catch (err) {
    console.error("❌ ERROR:", err);
    process.exit(1);
  }
})();
