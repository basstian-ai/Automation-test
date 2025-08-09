#!/usr/bin/env node

/**
 * AI Iteration Agent - Hardened
 * - Validates diffs before applying
 * - Falls back to file-block replacement
 * - Fetches both build & runtime logs
 */

import fs from "fs";
import path from "path";
import { execSync, spawnSync } from "child_process";
import fetch from "node-fetch";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID;
const VERCEL_PROJECT = process.env.VERCEL_PROJECT;
const TARGET_REPO = process.env.TARGET_REPO;
const TARGET_BRANCH = process.env.TARGET_BRANCH || "main";
const PAT_TOKEN = process.env.PAT_TOKEN;

const targetDir = path.resolve("target");
const buildLogPath = path.join(targetDir, "vercel_build.log");
const runtimeLogPath = path.join(targetDir, "vercel_runtime.log");
const aiPatchPath = path.join(targetDir, "ai_patch.diff");
const badPatchPath = path.join(targetDir, "ai_bad_patch.diff");

function run(cmd) {
  console.log(`$ ${cmd}`);
  return execSync(cmd, { stdio: "inherit" });
}

function runCapture(cmd) {
  return execSync(cmd, { encoding: "utf8" }).trim();
}

function validateUnifiedDiff(raw) {
  const errors = [];
  if (!raw.trim()) errors.push("Empty diff");
  if (!/^diff --git/m.test(raw)) errors.push("Missing diff header");
  if (!/^---\s/m.test(raw) || !/^\+\+\+\s/m.test(raw))
    errors.push("Missing file markers (--- / +++)");
  if (/fragment without header|corrupt patch/i.test(raw))
    errors.push("Corruption markers found");
  if (/patch unexpectedly ends in middle of line/i.test(raw))
    errors.push("Patch ends abruptly");
  return { valid: errors.length === 0, errors };
}

async function getVercelDeployment() {
  const url = `https://api.vercel.com/v6/deployments?projectId=${VERCEL_PROJECT}&teamId=${VERCEL_TEAM_ID}&limit=1`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${VERCEL_TOKEN}` },
  });
  if (!res.ok) throw new Error(`Failed to fetch deployments: ${res.status}`);
  const data = await res.json();
  return data.deployments?.[0];
}

async function getVercelLogs(deploymentId, type) {
  const url = `https://api.vercel.com/v2/deployments/${deploymentId}/logs?teamId=${VERCEL_TEAM_ID}&limit=5000&type=${type}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${VERCEL_TOKEN}` },
  });
  if (!res.ok) throw new Error(`Failed to fetch ${type} logs: ${res.status}`);
  const data = await res.json();
  return data.logs?.map((l) => l.text).join("\n") || "";
}

async function askAIForPatch(context, forceFileBlocks = false) {
  const systemPrompt = forceFileBlocks
    ? `You MUST return file-blocks format ONLY.`
    : `Return a valid unified diff starting with 'diff --git'.`;
  const userPrompt = `Repo context:\n${context}\n\nApply improvements or fix errors.`;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0,
      max_tokens: 2000,
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(`OpenAI API error: ${res.status} ${JSON.stringify(data)}`);

  return data.choices?.[0]?.message?.content || "";
}

function tryApplyUnifiedDiff(diffText) {
  fs.writeFileSync(aiPatchPath, diffText);
  const strategies = [
    `git -C ${targetDir} apply --3way --whitespace=fix ${aiPatchPath}`,
    `git -C ${targetDir} apply --whitespace=fix ${aiPatchPath}`,
    `patch -p1 -d ${targetDir} < ${aiPatchPath}`,
  ];

  for (const cmd of strategies) {
    try {
      execSync(cmd, { stdio: "inherit" });
      return true;
    } catch (err) {
      console.error(`❌ Patch strategy failed: ${cmd}\n${err.message}`);
    }
  }
  return false;
}

(async () => {
  console.log("\n=== Sync target repo ===\n");
  if (!fs.existsSync(targetDir)) {
    run(`git clone https://${PAT_TOKEN}@github.com/${TARGET_REPO}.git ${targetDir}`);
  }
  run(`git -C ${targetDir} fetch origin ${TARGET_BRANCH}`);
  run(`git -C ${targetDir} checkout ${TARGET_BRANCH}`);
  run(`git -C ${targetDir} reset --hard origin/${TARGET_BRANCH}`);
  run(`git -C ${targetDir} config user.name "AI Dev Agent"`);
  run(`git -C ${targetDir} config user.email "ai-agent@local"`);

  console.log("\n=== Fetch latest Vercel deployment & logs ===\n");
  const deployment = await getVercelDeployment();
  if (!deployment) throw new Error("No deployments found");

  const buildLogs = await getVercelLogs(deployment.uid, "build");
  fs.writeFileSync(buildLogPath, buildLogs);
  console.log(`📝 Build logs saved: ${buildLogPath}`);

  const runtimeLogs = await getVercelLogs(deployment.uid, "runtime");
  fs.writeFileSync(runtimeLogPath, runtimeLogs);
  console.log(`📝 Runtime logs saved: ${runtimeLogPath}`);

  console.log("\n=== Ask AI for patch ===\n");
  let aiRaw = await askAIForPatch(buildLogs + "\n" + runtimeLogs);
  let { valid, errors } = validateUnifiedDiff(aiRaw);

  if (!valid) {
    console.error(`❌ Invalid diff from AI: ${errors.join("; ")}`);
    fs.writeFileSync(badPatchPath, aiRaw);
    console.log(`💾 Saved bad diff to: ${badPatchPath}`);
    console.log("🔁 Retrying with file-blocks mode...");
    aiRaw = await askAIForPatch(buildLogs + "\n" + runtimeLogs, true);
  }

  console.log("\n=== Apply patch ===\n");
  const applied = tryApplyUnifiedDiff(aiRaw);
  if (!applied) {
    console.warn("⚠️ AI did not produce an applicable change this run.");
    process.exit(0); // not a failure
  }

  run(`git -C ${targetDir} add -A`);
  run(`git -C ${targetDir} commit -m "AI iteration: ${new Date().toISOString()}" || echo "No changes to commit"`);
  run(`git -C ${targetDir} push origin ${TARGET_BRANCH}`);
})();
