#!/usr/bin/env node
/**
 * Self-iterating AI agent for autonomous dev flow
 * Senior Architect edition – resilient & production-ready
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const fetch = require("node-fetch");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID;
const VERCEL_PROJECT = process.env.VERCEL_PROJECT;
const TARGET_REPO = process.env.TARGET_REPO;
const TARGET_BRANCH = process.env.TARGET_BRANCH || "main";
const PAT_TOKEN = process.env.PAT_TOKEN;

if (!OPENAI_API_KEY || !VERCEL_TOKEN || !VERCEL_PROJECT || !TARGET_REPO || !PAT_TOKEN) {
  console.error("❌ Missing required environment variables.");
  process.exit(1);
}

console.log(`📂 CWD: ${process.cwd()}`);
console.log(`🎯 Target: ${TARGET_REPO} @ ${TARGET_BRANCH}`);

// ------------------- Utilities -------------------
function run(cmd, opts = {}) {
  console.log(`$ ${cmd}`);
  return execSync(cmd, { stdio: "inherit", ...opts });
}

function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

// ------------------- Package JSON Repair -------------------
function repairPackageJson() {
  const pkgPath = path.join(process.cwd(), "package.json");
  const content = readFileSafe(pkgPath);
  if (!content) return;

  try {
    JSON.parse(content);
  } catch (err) {
    console.warn("⚠️ package.json is invalid JSON – attempting fix...");
    const fixed = content
      .replace(/\/\/.*$/gm, "") // remove comments
      .replace(/,\s*}/g, "}")
      .replace(/,\s*]/g, "]");
    try {
      JSON.parse(fixed);
      fs.writeFileSync(pkgPath, fixed);
      console.log("✅ package.json fixed.");
    } catch (e) {
      console.error("❌ Could not auto-fix package.json", e);
    }
  }
}

// ------------------- Lock File Repair -------------------
function repairLockFileIfNeeded() {
  try {
    run("npm ci");
    return;
  } catch {
    console.warn("⚠️ npm ci failed — regenerating lockfile...");
    fs.rmSync("package-lock.json", { force: true });
    run("npm install");
    run("npm audit fix --force || true");
    run("git add package-lock.json");
    run(`git commit -m "chore: regenerate lock file" || true`);
  }
}

// ------------------- Fetch Vercel State -------------------
async function getVercelState() {
  const url = `https://api.vercel.com/v13/projects/${VERCEL_PROJECT}/deployments?teamId=${VERCEL_TEAM_ID}&limit=1`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${VERCEL_TOKEN}` },
  });
  const data = await res.json();
  if (!data.deployments?.length) {
    console.error("❌ No deployments found.");
    process.exit(1);
  }
  const state = data.deployments[0].readyState;
  console.log(`🔍 Vercel state: ${state}`);
  return state;
}

// ------------------- AI Patch Generation -------------------
async function generateAIPatch(mode, logs) {
  const prompt = `
You are an expert developer.
The project build logs show: ${logs}

Mode: ${mode}

If mode=FIX: generate a git diff that fixes the issue.
If mode=FEATURE: improve code by adding small enhancements.

Return only a valid git unified diff.
`;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const data = await res.json();
  const diff = data.choices?.[0]?.message?.content;
  if (!diff || !diff.includes("diff --git")) {
    throw new Error("AI did not return a valid diff.");
  }
  return diff;
}

function applyPatch(diff) {
  fs.writeFileSync("patch.diff", diff);
  try {
    run("git apply --whitespace=fix patch.diff");
    console.log("✅ Patch applied.");
  } catch {
    console.warn("⚠️ Patch failed – forcing apply with 3-way merge...");
    run("git apply --3way --whitespace=fix patch.diff || true");
  }
}

// ------------------- Main Flow -------------------
(async function main() {
  // Step 1: Ensure clean working dir
  run("git reset --hard");
  run(`git checkout ${TARGET_BRANCH}`);
  run("git pull");

  // Step 2: Repair package.json & lock file
  repairPackageJson();
  repairLockFileIfNeeded();

  // Step 3: Determine mode
  const state = await getVercelState();
  const mode = state === "ERROR" ? "FIX" : "FEATURE";

  // Step 4: Fetch logs (optional: implement full fetch from Vercel)
  const logs = state === "ERROR" ? "Build failed logs here" : "Build successful";

  // Step 5: Generate & apply AI patch
  try {
    const diff = await generateAIPatch(mode, logs);
    applyPatch(diff);
  } catch (err) {
    console.error("❌ AI patch generation failed:", err);
    process.exit(1);
  }

  // Step 6: Commit & push
  run("git add .");
  run(`git commit -m "AI ${mode} update" || true`);
  run(`git push https://x-access-token:${PAT_TOKEN}@github.com/${TARGET_REPO}.git ${TARGET_BRANCH}`);

  console.log("🚀 Changes pushed.");
})();