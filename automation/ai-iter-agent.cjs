#!/usr/bin/env node

// ai-iter-agent.cjs
const fs = require("fs");
const path = require("path");
const https = require("https");
const { execSync } = require("child_process");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID;
const VERCEL_PROJECT = process.env.VERCEL_PROJECT;
const TARGET_REPO = process.env.TARGET_REPO;
const TARGET_BRANCH = process.env.TARGET_BRANCH || "main";
const PAT_TOKEN = process.env.PAT_TOKEN;

const targetDir = path.join(process.cwd(), "target");
const buildLogPath = path.join(targetDir, "vercel_build.log");
const runtimeLogPath = path.join(targetDir, "vercel_runtime.log");
const patchFilePath = path.join(targetDir, "ai_patch.diff");

function exec(cmd) {
  console.log(`$ ${cmd}`);
  return execSync(cmd, { stdio: "pipe" }).toString().trim();
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(
      url,
      {
        headers: {
          Authorization: `Bearer ${VERCEL_TOKEN}`,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode >= 400) {
            return reject(
              new Error(`GET ${url} => ${res.statusCode}: ${data}`)
            );
          }
          resolve(JSON.parse(data));
        });
      }
    ).on("error", reject);
  });
}

async function fetchLatestDeployment() {
  const url = `https://api.vercel.com/v6/deployments?projectId=${VERCEL_PROJECT}&teamId=${VERCEL_TEAM_ID}&limit=1`;
  const data = await fetchJSON(url);
  return data.deployments && data.deployments.length > 0
    ? data.deployments[0]
    : null;
}

async function fetchBuildEvents(deploymentId) {
  const url = `https://api.vercel.com/v3/deployments/${deploymentId}/events?teamId=${VERCEL_TEAM_ID}`;
  return fetchJSON(url);
}

function saveLogFile(content, filePath) {
  fs.writeFileSync(filePath, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  console.log(`📝 Logs saved: ${filePath}`);
}

async function main() {
  console.log("\n=== Sync target repo ===\n");
  if (!fs.existsSync(targetDir)) {
    exec(`git clone https://${PAT_TOKEN}@github.com/${TARGET_REPO}.git target`);
  }
  exec(`git -C ${targetDir} fetch origin ${TARGET_BRANCH}`);
  exec(`git -C ${targetDir} checkout ${TARGET_BRANCH}`);
  exec(`git -C ${targetDir} reset --hard origin/${TARGET_BRANCH}`);
  exec(`git -C ${targetDir} config user.name "AI Dev Agent"`);
  exec(`git -C ${targetDir} config user.email "ai-agent@local"`);

  console.log("\n=== Fetch latest Vercel deployment & logs ===\n");
  let deployment = null;
  try {
    deployment = await fetchLatestDeployment();
  } catch (err) {
    console.warn(`⚠️ Failed to fetch latest deployment: ${err.message}`);
  }

  if (deployment) {
    try {
      const buildEvents = await fetchBuildEvents(deployment.uid);
      saveLogFile(buildEvents, buildLogPath);
    } catch (err) {
      console.warn(`⚠️ Failed to fetch build events: ${err.message}`);
    }
  } else {
    console.warn("⚠️ No deployment found. Skipping build events fetch.");
    fs.writeFileSync(buildLogPath, "No Vercel deployment found.\n");
  }

  // Always try runtime logs via CLI (uses project name, not ID)
  try {
    const runtimeLogs = exec(`npx vercel logs ${deployment ? deployment.url : VERCEL_PROJECT} --token ${VERCEL_TOKEN} --scope ${VERCEL_TEAM_ID} --since 1h`);
    saveLogFile(runtimeLogs, runtimeLogPath);
  } catch (err) {
    console.warn(`⚠️ Failed to fetch runtime logs: ${err.message}`);
    fs.writeFileSync(runtimeLogPath, "No runtime logs available.\n");
  }

  console.log("\n=== Ask AI for patch ===\n");
  const systemPrompt = `
You are an autonomous AI software engineer.
Your job:
1. Read vercel_build.log and vercel_runtime.log.
2. If there are build errors, fix them.
3. If build is green, improve PIM features.
4. If no features to add, write automated tests.
5. Always output a unified diff (git apply format).
`.trim();

  const logsContent =
    "\n\n=== BUILD LOG ===\n" +
    fs.readFileSync(buildLogPath, "utf8") +
    "\n\n=== RUNTIME LOG ===\n" +
    fs.readFileSync(runtimeLogPath, "utf8");

  const aiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: logsContent },
      ],
      temperature: 0,
    }),
  }).then((res) => res.json());

  const patchText = aiResponse.choices?.[0]?.message?.content || "";
  fs.writeFileSync(patchFilePath, patchText);

  console.log("\n=== Apply patch ===\n");
  try {
    exec(`git -C ${targetDir} apply --3way --whitespace=fix ${patchFilePath}`);
  } catch {
    try {
      exec(`git -C ${targetDir} apply --whitespace=fix ${patchFilePath}`);
    } catch {
      try {
        exec(`patch -p1 -d ${targetDir} < ${patchFilePath}`);
      } catch {
        console.warn("⚠️ Patch failed. Skipping commit.");
        return;
      }
    }
  }

  exec(`git -C ${targetDir} add .`);
  exec(`git -C ${targetDir} commit -m "AI iteration: ${new Date().toISOString()}"`);
  exec(`git -C ${targetDir} push origin ${TARGET_BRANCH}`);
}

main().catch((err) => {
  console.error("❌ ERROR:", err);
  process.exit(1);
});
