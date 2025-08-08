import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import fetch from "node-fetch";
import OpenAI from "openai";

const {
  OPENAI_API_KEY,
  VERCEL_TOKEN,
  VERCEL_TEAM_ID,
  VERCEL_PROJECT,
  TARGET_BRANCH,
  PAT_TOKEN
} = process.env;

if (!OPENAI_API_KEY || !VERCEL_TOKEN) {
  console.error("❌ Missing required env vars.");
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

async function run(cmd, opts = {}) {
  console.log(`$ ${cmd}`);
  return execSync(cmd, { stdio: "pipe", encoding: "utf-8", ...opts });
}

async function fetchVercelLogs() {
  console.log("🔄 Fetching latest Vercel build logs...");
  const depRes = await fetch(
    `https://api.vercel.com/v6/deployments?projectId=${VERCEL_PROJECT}&teamId=${VERCEL_TEAM_ID}&limit=1`,
    { headers: { Authorization: `Bearer ${VERCEL_TOKEN}` } }
  );
  const depData = await depRes.json();
  const latest = depData.deployments?.[0];
  if (!latest) return { state: "NONE", logs: "" };

  const logRes = await fetch(
    `https://api.vercel.com/v2/deployments/${latest.uid}/events?teamId=${VERCEL_TEAM_ID}`,
    { headers: { Authorization: `Bearer ${VERCEL_TOKEN}` } }
  );
  const logData = await logRes.json();
  const logs = logData.map(l => l.payload?.text || "").join("\n");
  return { state: latest.state, logs };
}

async function getAIUpdate({ logs, buildOk }) {
  const systemPrompt = `
You are an autonomous developer maintaining a Product Information Management (PIM) system.
Rules:
- If buildOk=false: Find and fix the cause using the logs + current codebase.
- If buildOk=true: Implement the next most valuable modern PIM feature following best practices.
- Only commit working, deployable code.
- PIM features can include: advanced search, product variants, bulk editing, category management, integrations, image handling, etc.
- Keep changes minimal if fixing; be more ambitious if adding features.
`;

  const files = listFilesRecursive(".");
  const content = files
    .map(f => `// FILE: ${f}\n${fs.readFileSync(f, "utf8")}`)
    .join("\n\n");

  const userPrompt = `
Build status: ${buildOk ? "GREEN" : "RED"}
Latest Vercel logs:\n${logs}

Current codebase:\n${content}
`;

  const resp = await openai.chat.completions.create({
    model: "gpt-4.1",
    temperature: 0.2,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ]
  });

  return resp.choices[0].message.content;
}

function listFilesRecursive(dir) {
  let results = [];
  fs.readdirSync(dir).forEach(file => {
    if (["node_modules", ".next", ".git"].includes(file)) return;
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      results = results.concat(listFilesRecursive(filePath));
    } else {
      results.push(filePath);
    }
  });
  return results;
}

async function main() {
  console.log("🔄 Pulling latest PIM repo code...");
  run(`git pull origin ${TARGET_BRANCH}`);

  const { state, logs } = await fetchVercelLogs();
  console.log(`📦 Latest deployment state: ${state}`);

  console.log("🧪 Running local build check...");
  let buildOk = true;
  try {
    run("npm install");
    run("npm run build");
  } catch {
    buildOk = false;
  }

  const aiPatch = await getAIUpdate({ logs, buildOk });
  console.log("🤖 AI suggested update:\n", aiPatch);

  fs.writeFileSync("AI_PATCH.txt", aiPatch);

  // Apply patch manually here (AI returns full file changes or diffs)
  // This assumes AI outputs full new files — you'll need a parser if diff-based

  run(`git config user.name "AI Dev Agent"`);
  run(`git config user.email "ai-agent@example.com"`);
  run("git add .");
  run(`git commit -m "AI iteration update" || echo "No changes to commit"`);
  run(`git pull --rebase origin ${TARGET_BRANCH}`);
  run(`git push origin ${TARGET_BRANCH}`);
}

main().catch(err => {
  console.error("❌ Agent failed", err);
  process.exit(1);
});