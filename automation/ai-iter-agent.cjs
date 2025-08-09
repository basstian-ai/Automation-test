#!/usr/bin/env node
/**
 * AI Iterative Dev Agent (CJS version)
 * - Syncs target repo
 * - Reads latest Vercel build & runtime logs
 * - If build/runtime errors → fix them first
 * - If no errors → iterate features (PIM first) and add tests
 * - Always commits something to keep iteration moving
 */

const fs = require("fs");
const path = require("path");
const { execSync, spawnSync } = require("child_process");
const https = require("https");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TARGET_REPO = process.env.TARGET_REPO;
const TARGET_BRANCH = process.env.TARGET_BRANCH || "main";
const PAT_TOKEN = process.env.PAT_TOKEN;
const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID;
const VERCEL_PROJECT = process.env.VERCEL_PROJECT;

const targetDir = path.join(process.cwd(), "target");
const buildLogPath = path.join(targetDir, "vercel_build.log");
const runtimeLogPath = path.join(targetDir, "vercel_runtime.log");
const patchPath = path.join(targetDir, "ai_patch.diff");

function run(cmd) {
  console.log(`$ ${cmd}`);
  return execSync(cmd, { stdio: "pipe" }).toString().trim();
}

function safeRun(cmd) {
  try {
    return run(cmd);
  } catch (err) {
    console.warn(`⚠️ Command failed: ${cmd}`);
    return "";
  }
}

function fetchVercelLogs() {
  console.log("\n=== Fetch latest Vercel deployment & logs ===");

  const buildLogs = safeRun(
    `npx vercel build --token ${VERCEL_TOKEN} --scope ${VERCEL_TEAM_ID} --confirm --cwd ${targetDir} || true`
  );
  fs.writeFileSync(buildLogPath, buildLogs || "No build log captured.");

  let runtimeLogs = "";
  try {
    // Removed --since as it's deprecated
    const runtime = spawnSync("npx", [
      "vercel",
      "logs",
      `${VERCEL_PROJECT}.vercel.app`,
      "--token",
      VERCEL_TOKEN,
      "--scope",
      VERCEL_TEAM_ID
    ], { encoding: "utf-8" });

    if (runtime.stdout) runtimeLogs = runtime.stdout;
    if (runtime.stderr) console.error(runtime.stderr);
  } catch (e) {
    console.warn("⚠️ Failed to fetch runtime logs:", e.message);
  }

  // Fallback: if no runtime logs, reuse build logs so AI still has context
  if (!runtimeLogs.trim()) {
    runtimeLogs = "⚠️ No runtime logs available. Using build logs instead.\n" + buildLogs;
  }

  fs.writeFileSync(runtimeLogPath, runtimeLogs);
  console.log(`📝 Build logs saved: ${buildLogPath}`);
  console.log(`📝 Runtime logs saved: ${runtimeLogPath}`);
}

async function askAIForPatch() {
  console.log("\n=== Ask AI for patch ===");

  const repoFiles = safeRun(`git -C ${targetDir} ls-files`).split("\n").filter(Boolean);
  const recentLogs = [
    fs.readFileSync(buildLogPath, "utf-8"),
    fs.readFileSync(runtimeLogPath, "utf-8")
  ].join("\n\n");

  const prompt = `
You are an autonomous developer agent.
The repo contains a PIM system that should be iteratively improved.
Priorities:
1. If there are build/runtime errors, fix them first.
2. If build is green, add or improve PIM features and prioritise adding automated tests.
3. Commit changes that keep the app deployable.

Repo files: ${repoFiles.join(", ")}
Recent Vercel logs:\n${recentLogs}

Return ONLY a valid unified diff (patch format) without explanation.
`;

  const payload = {
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0
  };

  const body = JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.openai.com",
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`
      }
    }, res => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          const content = json.choices?.[0]?.message?.content || "";
          if (!content.includes("---")) {
            return reject(new Error("No valid diff returned by AI"));
          }
          fs.writeFileSync(patchPath, content);
          resolve(content);
        } catch (err) {
          reject(err);
        }
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function applyPatch() {
  console.log("\n=== Apply patch ===");

  const strategies = [
    `git -C ${targetDir} apply --3way --whitespace=fix ${patchPath}`,
    `git -C ${targetDir} apply --whitespace=fix ${patchPath}`,
    `patch -p1 -d ${targetDir} < ${patchPath}`
  ];

  for (const cmd of strategies) {
    try {
      run(cmd);
      return true;
    } catch (err) {
      console.warn(`❌ Patch strategy failed: ${cmd}`);
    }
  }
  return false;
}

function commitAndPush() {
  safeRun(`git -C ${targetDir} add .`);
  try {
    run(`git -C ${targetDir} commit -m "AI iteration: ${new Date().toISOString()}"`);
    run(`git -C ${targetDir} push origin ${TARGET_BRANCH}`);
  } catch (e) {
    console.warn("⚠️ Nothing to commit.");
  }
}

(async () => {
  console.log("\n=== Sync target repo ===");
  safeRun(`git -C ${targetDir} fetch origin ${TARGET_BRANCH}`);
  safeRun(`git -C ${targetDir} checkout ${TARGET_BRANCH}`);
  safeRun(`git -C ${targetDir} reset --hard origin/${TARGET_BRANCH}`);
  safeRun(`git -C ${targetDir} config user.name "AI Dev Agent"`);
  safeRun(`git -C ${targetDir} config user.email "ai-agent@local"`);

  fetchVercelLogs();

  let patchOk = false;
  try {
    await askAIForPatch();
    patchOk = applyPatch();
  } catch (err) {
    console.error(`❌ ERROR: ${err.message}`);
  }

  if (!patchOk) {
    console.warn("⚠️ Patch failed. Attempting to commit any staged changes anyway.");
  }
  commitAndPush();
})();
