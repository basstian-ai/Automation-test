import fs from 'fs';
import { execSync } from 'child_process';
import fetch from 'node-fetch';
import OpenAI from 'openai';

const TARGET_REPO = process.env.TARGET_REPO;
const TARGET_BRANCH = process.env.TARGET_BRANCH;
const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID;
const VERCEL_PROJECT = process.env.VERCEL_PROJECT;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const PIM_REPO_DIR = '../target'; // where the PIM repo is checked out

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// -------------------- Helpers --------------------
function run(cmd, cwd = '.') {
  console.log(`$ ${cmd}`);
  return execSync(cmd, { cwd, encoding: 'utf8' });
}

function truncateLog(log, maxLines = 400) {
  if (!log) return '';
  const lines = log.split('\n');
  return lines.length > maxLines ? lines.slice(-maxLines).join('\n') : log;
}

// -------------------- Step 1: Pull latest code --------------------
console.log('🔄 Pulling latest PIM repo code...');
run(`git pull origin ${TARGET_BRANCH}`, PIM_REPO_DIR);

// -------------------- Step 2: Get latest Vercel build logs --------------------
async function getLatestVercelLogs() {
  console.log('🔄 Fetching latest Vercel build logs...');

  const deploymentsRes = await fetch(
    `https://api.vercel.com/v6/deployments?projectId=${VERCEL_PROJECT}&teamId=${VERCEL_TEAM_ID}&limit=1`,
    { headers: { Authorization: `Bearer ${VERCEL_TOKEN}` } }
  );
  const deployments = await deploymentsRes.json();
  if (!deployments.deployments || deployments.deployments.length === 0) {
    console.error('❌ No deployments found.');
    return '';
  }

  const latest = deployments.deployments[0];
  const buildId = latest.uid;
  console.log(`📦 Latest deployment: ${buildId}, state: ${latest.readyState}`);

  const logsRes = await fetch(
    `https://api.vercel.com/v1/deployments/${buildId}/events?teamId=${VERCEL_TEAM_ID}`,
    { headers: { Authorization: `Bearer ${VERCEL_TOKEN}` } }
  );

  const logsJson = await logsRes.json();
  const logText = logsJson
    .map(e => e.payload?.text || '')
    .filter(Boolean)
    .join('\n');

  return truncateLog(logText);
}

// -------------------- Step 3: Local build to capture errors --------------------
function getLocalBuildLogs() {
  console.log('🧪 Running local build check before decision...');
  try {
    run('npm install', PIM_REPO_DIR);
    run('npm run build', PIM_REPO_DIR);
    console.log('✅ Local build succeeded.');
    return null; // means build passed
  } catch (err) {
    console.log('❌ Local build failed.');
    return truncateLog(err.stdout?.toString() || err.message || '');
  }
}

// -------------------- Step 4: Send to OpenAI --------------------
async function applyAIFix(logs) {
  console.log('🤖 Asking AI to fix or improve code...');
  const prompt = `
You are an autonomous senior full-stack developer working on a Next.js based PIM system.
If logs indicate a build failure, fix the errors in the code.
If logs indicate success, implement the next best-practice feature for a modern PIM system
(such as advanced product search, bulk editing, improved data validation, etc.).

Constraints:
- The repo is at ${PIM_REPO_DIR}.
- Modify only necessary files to fix or add features.
- Commit changes with a clear message.

Logs from Vercel:
${logs.vercel}

Logs from local build:
${logs.local}
  `;

  const resp = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0
  });

  const aiResponse = resp.choices[0].message.content;
  console.log('--- AI Response Start ---\n', aiResponse, '\n--- AI Response End ---');

  fs.writeFileSync(`${PIM_REPO_DIR}/ai-fix-plan.txt`, aiResponse, 'utf8');

  // You can extend this to parse and apply patches from AI response automatically.
}

// -------------------- Main Flow --------------------
(async () => {
  const vercelLogs = await getLatestVercelLogs();
  const localLogs = getLocalBuildLogs();

  await applyAIFix({ vercel: vercelLogs, local: localLogs });

  // Commit & push changes if there are any
  try {
    run('git add .', PIM_REPO_DIR);
    run(`git commit -m "AI iteration update" || echo "No changes to commit"`, PIM_REPO_DIR);
    run(`git push origin ${TARGET_BRANCH}`, PIM_REPO_DIR);
    console.log('📤 Changes pushed to repo.');
  } catch (err) {
    console.error('⚠️ Commit/push step failed:', err.message);
  }
})();
