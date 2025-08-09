#!/usr/bin/env node

/**
 * AI Iteration Agent with Vercel Build + Runtime Logs
 * CJS version
 */

const fs = require("node:fs");
const path = require("node:path");
const fetch = require("node-fetch");
const { execSync, spawnSync } = require("node:child_process");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID;
const VERCEL_PROJECT = process.env.VERCEL_PROJECT;
const TARGET_REPO = process.env.TARGET_REPO;
const TARGET_BRANCH = process.env.TARGET_BRANCH || "main";
const PAT_TOKEN = process.env.PAT_TOKEN;

const targetDir = path.resolve(__dirname, "../target");

if (!OPENAI_API_KEY || !VERCEL_TOKEN || !VERCEL_PROJECT || !TARGET_REPO) {
  console.error("❌ Missing required environment variables.");
  process.exit(1);
}

/**
 * Run shell command
 */
function sh(cmd, opts = {}) {
  console.log(`$ ${cmd}`);
  return execSync(cmd, { stdio: "inherit", ...opts });
}

/**
 * Fetch latest deployment from Vercel
 */
async function getLatestDeployment() {
  let url = `https://api.vercel.com/v6/deployments?projectId=${VERCEL_PROJECT}&limit=1`;
  if (VERCEL_TEAM_ID) url += `&teamId=${VERCEL_TEAM_ID}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${VERCEL_TOKEN}` },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch deployments: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  if (!data.deployments || data.deployments.length === 0) {
    throw new Error("No deployments found");
  }
  return data.deployments[0];
}

/**
 * Fetch build logs from Vercel
 */
async function fetchBuildLogs(deploymentId, outPath) {
  let url = `https://api.vercel.com/v1/deployments/${deploymentId}/events`;
  if (VERCEL_TEAM_ID) url += `?teamId=${VERCEL_TEAM_ID}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${VERCEL_TOKEN}` },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch build logs: ${res.status} ${await res.text()}`);
  }
  fs.writeFileSync(outPath, await res.text(), "utf8");
}

/**
 * Fetch runtime logs (NDJSON)
 */
async function fetchRuntimeLogs({ deploymentId, projectId, teamId, token, cwd }) {
  const outPath = path.join(cwd, "vercel_runtime.log");
  const url = new URL(`https://api.vercel.com/v1/projects/${projectId}/deployments/${deploymentId}/runtime-logs`);
  if (teamId) url.searchParams.set("teamId", teamId);

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`Failed to fetch runtime logs: ${res.status} ${await res.text()}`);
  }

  const file = fs.createWriteStream(outPath, { flags: "w" });
  await new Promise((resolve, reject) => {
    res.body.pipe(file);
    res.body.on("error", reject);
    file.on("finish", resolve);
  });

  return outPath;
}

/**
 * Ask AI for patch
 */
async function getAIPatch(buildLogText, runtimeLogText, fileList) {
  const prompt = `
You are an expert full-stack developer.
Here are the latest Vercel build logs:
---
${buildLogText}

Here are the runtime logs:
---
${runtimeLogText}

File list in repo:
---
${fileList}

Please provide a unified diff (git patch) to fix any issues or improve the app.
Only output the patch file, nothing else.
`;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenAI API error: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || "";
  if (!content.includes("diff")) {
    throw new Error("No valid diff returned by AI");
  }
  return content;
}

/**
 * Apply patch with retries
 */
function applyPatch(patchPath) {
  const strategies = [
    `git -C ${targetDir} apply --3way --whitespace=fix ${patchPath}`,
    `git -C ${targetDir} apply --whitespace=fix ${patchPath}`,
    `patch -p1 -d ${targetDir} < ${patchPath}`,
  ];
  for (const cmd of strategies) {
    try {
      execSync(cmd, { stdio: "inherit" });
      return true;
    } catch (err) {
      console.warn(`❌ Patch strategy failed: ${cmd}`);
    }
  }
  return false;
}

/**
 * Main
 */
(async () => {
  // Prepare target dir
  fs.mkdirSync(targetDir, { recursive: true });

  console.log("=== Sync target repo ===");
  if (!fs.existsSync(path.join(targetDir, ".git"))) {
    sh(`git clone https://${PAT_TOKEN}@github.com/${TARGET_REPO}.git ${targetDir}`);
  }
  sh(`git -C ${targetDir} fetch origin ${TARGET_BRANCH}`);
  sh(`git -C ${targetDir} checkout ${TARGET_BRANCH}`);
  sh(`git -C ${targetDir} reset --hard origin/${TARGET_BRANCH}`);

  console.log("\n=== Fetch latest Vercel deployment & logs ===");
  const deployment = await getLatestDeployment();
  const buildLogPath = path.join(targetDir, "vercel_build.log");
  await fetchBuildLogs(deployment.uid, buildLogPath);
  console.log(`📝 Build logs saved: ${buildLogPath}`);

  try {
    const runtimePath = await fetchRuntimeLogs({
      deploymentId: deployment.uid,
      projectId: VERCEL_PROJECT,
      teamId: VERCEL_TEAM_ID,
      token: VERCEL_TOKEN,
      cwd: targetDir,
    });
    console.log(`📝 Runtime logs saved: ${runtimePath}`);
  } catch (e) {
    console.warn(`⚠️ Could not fetch runtime logs: ${e.message}`);
  }

  const fileList = execSync(`git -C ${targetDir} ls-files`, { encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .map((f) => ` - ${f}`)
    .join("\n");

  const buildLogText = fs.readFileSync(buildLogPath, "utf8");
  const runtimeLogPath = path.join(targetDir, "vercel_runtime.log");
  const runtimeLogText = fs.existsSync(runtimeLogPath) ? fs.readFileSync(runtimeLogPath, "utf8") : "";

  console.log("\n=== Ask AI for patch ===");
  let patchContent;
  try {
    patchContent = await getAIPatch(buildLogText, runtimeLogText, fileList);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }

  const patchPath = path.join(targetDir, "ai_patch.diff");
  fs.writeFileSync(patchPath, patchContent, "utf8");

  console.log("\n=== Apply patch ===");
  if (!applyPatch(patchPath)) {
    console.warn("⚠️ AI did not produce an applicable change this run.");
    process.exit(0); // Not a hard fail
  }

  console.log("\n=== Commit & push changes ===");
  sh(`git -C ${targetDir} add .`);
  sh(`git -C ${targetDir} commit -m "AI patch" || true`);
  sh(`git -C ${targetDir} push origin ${TARGET_BRANCH}`);

  console.log("✅ Done");
})();
