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
  TARGET_BRANCH
} = process.env;

if (!OPENAI_API_KEY || !VERCEL_TOKEN) {
  console.error("❌ Missing required env vars.");
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

function run(cmd, opts = {}) {
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

async function getAIUpdate({ logs, buildOk }) {
  const systemPrompt = `
You are an autonomous developer for a Product Information Management (PIM) system.

Rules:
- If buildOk=false: identify and fix the cause using logs + codebase.
- If buildOk=true: implement the next high-value feature for a modern PIM system.
- Only produce deployable code — no pseudocode, no TODOs.
- Overwrite the necessary files completely with final working code.
`;

  const files = listFilesRecursive("target");
  const content = files
    .map(f => `// FILE: ${f}\n${fs.readFileSync(f, "utf8")}`)
    .join("\n\n");

  const userPrompt = `
Build status: ${buildOk ? "GREEN" : "RED"}
Latest Vercel logs:\n${logs}

Current codebase:\n${content}

Return only valid file contents with the same // FILE: markers for direct overwrite.
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

function applyAIChanges(aiOutput) {
  const parts = aiOutput.split("// FILE: ").slice(1);
  for (const part of parts) {
    const [filename, ...rest] = part.split("\n");
    const content = rest.join("\n");
    fs.writeFileSync(filename.trim(), content, "utf8");
    console.log(`✅ Updated ${filename.trim()}`);
  }
}

async function main() {
  const targetDir = path.resolve("target");
  process.chdir(targetDir);

  console.log("🔄 Pulling latest PIM repo...");
  run(`git pull origin ${TARGET_BRANCH}`);

  const { state, logs } = await fetchVercelLogs();
  console.log(`📦 Latest deployment state: ${state}`);

  let buildOk = true;
  try {
    run("npm install");
    run("npm run build");
  } catch {
    buildOk = false;
  }

  const aiPatch = await getAIUpdate({ logs, buildOk });
  applyAIChanges(aiPatch);

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