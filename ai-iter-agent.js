// ai-iter-agent.js
import fs from "fs";
import { execSync } from "child_process";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const TARGET_REPO = process.env.TARGET_REPO;
const TARGET_BRANCH = process.env.TARGET_BRANCH || "main";
const PAT = process.env.PAT_TOKEN;

// Run shell commands
function run(cmd, options = {}) {
  console.log(`\n$ ${cmd}`);
  return execSync(cmd, { stdio: "pipe", encoding: "utf-8", ...options }).trim();
}

// Validate patch from AI
function extractValidDiff(patchText) {
  const startIndex = patchText.indexOf("diff --git");
  if (startIndex === -1) return null;
  const cleanPatch = patchText.slice(startIndex).trim();

  // Ensure it's at least one file diff
  if (!/^diff --git/m.test(cleanPatch)) return null;
  return cleanPatch;
}

// Get latest Vercel build logs
async function fetchBuildLogs() {
  console.log("🔄 Fetching build logs...");
  try {
    const res = await fetch(
      `https://api.vercel.com/v6/deployments?projectId=${process.env.VERCEL_PROJECT}&teamId=${process.env.VERCEL_TEAM_ID}`,
      { headers: { Authorization: `Bearer ${process.env.VERCEL_TOKEN}` } }
    );
    const data = await res.json();
    if (!data.deployments?.length) return null;

    const latest = data.deployments[0];
    const logsRes = await fetch(
      `https://api.vercel.com/v3/deployments/${latest.uid}/events?teamId=${process.env.VERCEL_TEAM_ID}`,
      { headers: { Authorization: `Bearer ${process.env.VERCEL_TOKEN}` } }
    );
    const logs = await logsRes.text();
    return logs;
  } catch (e) {
    console.error("⚠️ Failed to fetch build logs:", e.message);
    return null;
  }
}

// Decide mode: FIX or IMPROVE
function decideMode(logs) {
  if (!logs) return "IMPROVE";
  return logs.includes("BUILD_ERROR") || logs.includes("Error") ? "FIX" : "IMPROVE";
}

// Ask AI for next patch
async function askAI(mode, logs) {
  console.log("🧠 Asking AI for next iteration...");
  const prompt = `
You are an autonomous software engineer improving a modern PIM system.
Repository: ${TARGET_REPO}
Current mode: ${mode}
Build logs:
${logs || "No build logs"}

Rules:
- Output ONLY a valid unified diff patch.
- Start with "diff --git" — no explanations, no markdown, no backticks.
- If mode=FIX: focus only on fixing build/run errors.
- If mode=IMPROVE: add next best feature for a modern PIM (CRUD products, categories, attributes, search, bulk import, API docs, etc.).
- Always keep the app deployable.
`;
  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
  });
  return res.choices[0].message.content.trim();
}

// Apply patch and commit
function applyPatch(patch) {
  fs.writeFileSync("patch.diff", patch);
  try {
    run("git apply patch.diff");
    run('git config user.email "bot@example.com"');
    run('git config user.name "AI Dev Agent"');
    run("git add .");
    const status = run("git status --porcelain");
    if (!status) {
      console.log("ℹ️ No changes to commit.");
      return false;
    }
    run('git commit -m "AI iteration update"');
    return true;
  } catch (e) {
    console.error("❌ Failed to apply patch:", e.message);
    return false;
  }
}

// Push changes using PAT
function pushChanges() {
  const pushUrl = `https://${PAT}@github.com/${TARGET_REPO}.git`;
  run(`git push ${pushUrl} ${TARGET_BRANCH}`);
}

(async () => {
  // Fetch logs + decide mode
  const logs = await fetchBuildLogs();
  const mode = decideMode(logs);
  console.log(`🔍 Mode: ${mode}`);

  // Ask AI for patch
  const aiOutput = await askAI(mode, logs);
  const cleanDiff = extractValidDiff(aiOutput);

  if (!cleanDiff) {
    console.error("⚠️ AI did not return a valid diff. Skipping this iteration.");
    return;
  }

  // Apply + commit + push
  if (applyPatch(cleanDiff)) {
    pushChanges();
    console.log("✅ Changes pushed");
  }
})();