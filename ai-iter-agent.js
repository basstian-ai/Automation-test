/**
 * ai-iter-agent.js
 * Autonomous Dev Flow for PIM System — merged Vercel + local build logs for fixes
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import OpenAI from 'openai';
import fetch from 'node-fetch';

const PIM_REPO_DIR = path.resolve('../target'); // matches workflow paths
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID;
const VERCEL_PROJECT = process.env.VERCEL_PROJECT;

if (!VERCEL_TOKEN || !VERCEL_TEAM_ID || !VERCEL_PROJECT) {
  console.error('Missing required Vercel env vars');
  process.exit(1);
}

function run(cmd, cwd = PIM_REPO_DIR) {
  console.log(`\n$ ${cmd}`);
  return execSync(cmd, { cwd, stdio: 'pipe' }).toString().trim();
}

function safeRun(cmd, cwd = PIM_REPO_DIR) {
  try {
    return run(cmd, cwd);
  } catch (err) {
    return (err.stdout?.toString() || '') + '\n' + (err.stderr?.toString() || '');
  }
}

async function fetchLatestBuildLog() {
  const depRes = await fetch(
    `https://api.vercel.com/v6/deployments?projectId=${VERCEL_PROJECT}&teamId=${VERCEL_TEAM_ID}&limit=1`,
    { headers: { Authorization: `Bearer ${VERCEL_TOKEN}` } }
  );
  const depData = await depRes.json();
  if (!depData.deployments?.length) throw new Error('No deployments found for project');

  const deployment = depData.deployments[0];
  const deployId = deployment.uid;
  const state = deployment.state;

  const logRes = await fetch(
    `https://api.vercel.com/v3/deployments/${deployId}/events?teamId=${VERCEL_TEAM_ID}`,
    { headers: { Authorization: `Bearer ${VERCEL_TOKEN}` } }
  );
  const logData = await logRes.json();

  return { logs: JSON.stringify(logData, null, 2), state, deployId };
}

async function applyAIFix(mergedLogs) {
  const prompt = `
You are an autonomous senior software engineer improving a Next.js 10 PIM (Product Information Management) application.

The latest build failed. Below are BOTH the Vercel build logs and the local build output for full context.

===== BEGIN VERCEL LOGS =====
${mergedLogs.vercel}
===== END VERCEL LOGS =====

===== BEGIN LOCAL BUILD OUTPUT =====
${mergedLogs.local}
===== END LOCAL BUILD OUTPUT =====

Instructions:
- Identify the root cause(s) of failure.
- Apply the minimal changes needed to fix the build.
- Keep existing features unless removal is strictly required to fix the build.
- Ensure 'npm run build' will succeed locally after changes.
- Return updated file contents only, each starting with:
  FILE_PATH: <path from repo root>
<file contents>
`;

  const resp = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0,
  });

  await applyCodeDiff(resp.choices[0].message.content, true);
}

async function developNextFeature() {
  const featurePrompt = `
You are building a modern Product Information Management (PIM) system in Next.js 10.
When the build is green, implement the next high-value, production-ready feature.

Guidelines:
- Build in small, deployable increments.
- Priorities: Product CRUD, Category management, Bulk import/export, Media asset handling, User roles & permissions, API endpoints, Search/filtering/sorting, Dashboard with KPIs.
- Follow clean, maintainable code practices.
- Ensure 'npm run build' passes after changes.

Return updated files only:
FILE_PATH: <path>
<file contents>
`;

  const resp = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: featurePrompt }],
    temperature: 0.7,
  });

  await applyCodeDiff(resp.choices[0].message.content, true);
}

async function applyCodeDiff(aiOutput, verifyAfter = false) {
  const fileRegex = /^FILE_PATH:\s*(.+)$/gm;
  let match;
  const files = [];

  while ((match = fileRegex.exec(aiOutput)) !== null) {
    const filePath = match[1].trim();
    const startIndex = match.index + match[0].length;
    const nextMatch = fileRegex.exec(aiOutput);
    const endIndex = nextMatch ? nextMatch.index : aiOutput.length;
    const content = aiOutput.substring(startIndex, endIndex).trim();

    files.push({ filePath, content });
    if (nextMatch) fileRegex.lastIndex = nextMatch.index;
  }

  if (!files.length) {
    console.error('No FILE_PATH entries found in AI output.');
    console.log(aiOutput);
    return;
  }

  for (const { filePath, content } of files) {
    const absPath = path.join(PIM_REPO_DIR, filePath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content, 'utf-8');
    console.log(`Updated: ${filePath}`);
  }

  console.log('🛠 Installing deps...');
  safeRun('npm install');

  if (verifyAfter) {
    console.log('🧪 Verifying local build...');
    const buildOutput = safeRun('npm run build');
    if (/error/i.test(buildOutput) || /failed/i.test(buildOutput)) {
      console.error('❌ Local build still failing — retrying AI fix...');
      const { logs: vercelLogs } = await fetchLatestBuildLog();
      await applyAIFix({ vercel: vercelLogs, local: buildOutput });
      return;
    }
    pushChanges();
  }
}

function pushChanges() {
  run('git config user.email "ci-bot@example.com"');
  run('git config user.name "CI Bot"');
  run('git add .');
  run(`git commit -m "AI iteration: ${new Date().toISOString()}" || echo "No changes to commit"`);
  run(`git push origin ${process.env.TARGET_BRANCH || 'main'}`);
}

(async () => {
  console.log('🔄 Fetching latest Vercel build logs...');
  const { logs: vercelLogs, state } = await fetchLatestBuildLog();

  console.log('🧪 Running local build check before decision...');
  const localBuildOutput = safeRun('npm run build');

  if (state !== 'READY' || /error/i.test(localBuildOutput) || /failed/i.test(localBuildOutput)) {
    console.log('❌ Build failing — sending merged logs to AI...');
    await applyAIFix({ vercel: vercelLogs, local: localBuildOutput });
  } else {
    console.log('✅ Build green — developing next PIM feature...');
    await developNextFeature();
  }
})();
