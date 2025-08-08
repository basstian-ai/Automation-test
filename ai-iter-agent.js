/**
 * ai-iter-agent.js
 * Autonomous Dev Flow for PIM System — with local build verification
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import OpenAI from 'openai';
import fetch from 'node-fetch';

const PIM_REPO_DIR = path.resolve('../target'); // matches your workflow
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID;
const VERCEL_PROJECT = process.env.VERCEL_PROJECT;

if (!VERCEL_TOKEN || !VERCEL_TEAM_ID || !VERCEL_PROJECT) {
  console.error('Missing required Vercel env vars');
  process.exit(1);
}

// -----------------
// Helpers
// -----------------
function run(cmd, cwd = PIM_REPO_DIR) {
  console.log(`\n$ ${cmd}`);
  return execSync(cmd, { cwd, stdio: 'pipe' }).toString().trim();
}

function safeRun(cmd, cwd = PIM_REPO_DIR) {
  try {
    return run(cmd, cwd);
  } catch (err) {
    return err.stdout?.toString() || err.message || 'Unknown error';
  }
}

async function fetchLatestBuildLog() {
  const depRes = await fetch(
    `https://api.vercel.com/v6/deployments?projectId=${VERCEL_PROJECT}&teamId=${VERCEL_TEAM_ID}&limit=1`,
    { headers: { Authorization: `Bearer ${VERCEL_TOKEN}` } }
  );
  const depData = await depRes.json();
  if (!depData.deployments || depData.deployments.length === 0) {
    throw new Error('No deployments found for project');
  }
  const deployment = depData.deployments[0];
  const deployId = deployment.uid;
  const state = deployment.state;

  const logRes = await fetch(
    `https://api.vercel.com/v3/deployments/${deployId}/events?teamId=${VERCEL_TEAM_ID}`,
    { headers: { Authorization: `Bearer ${VERCEL_TOKEN}` } }
  );
  const logData = await logRes.json();
  const logs = JSON.stringify(logData, null, 2);

  return { logs, state, deployId };
}

async function applyAIFix(buildLogs) {
  const prompt = `
You are an autonomous senior software engineer.
You are working inside a Next.js 10 PIM (Product Information Management) application.

The latest Vercel build has failed. The following build logs are provided:

${buildLogs}

Instructions:
- Identify the root cause of the failure.
- Propose and implement the minimal code change(s) needed to fix the error.
- Do not remove existing features unless required to fix the build.
- Ensure 'npm run build' will succeed locally after your changes.
- Provide only the updated file contents, each starting with: FILE_PATH: <path from repo root>
`;

  const resp = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0,
  });

  await applyCodeDiff(resp.choices[0].message.content);
}

async function developNextFeature() {
  const featurePrompt = `
You are building a modern Product Information Management (PIM) system
using Next.js 10 and best practices in software engineering.

The application must always be deployable. When the build is green,
you will add the next most valuable, production-ready feature that such a PIM should have.

Guidelines:
- Implement features in small, working increments.
- Prioritize: Product CRUD, Category management, Bulk import/export, Media asset handling,
  User roles & permissions, API integration endpoints, Search/filtering/sorting, Dashboard with KPIs.
- Use clean, maintainable, well-documented code.
- Ensure 'npm run build' passes after your changes.

Return only updated/added files in the following format:
FILE_PATH: <path>
<file contents>
`;

  const resp = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: featurePrompt }],
    temperature: 0.7,
  });

  await applyCodeDiff(resp.choices[0].message.content);
}

async function applyCodeDiff(aiOutput) {
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

  if (files.length === 0) {
    console.error('No files found in AI output.');
    console.log(aiOutput);
    return;
  }

  for (const { filePath, content } of files) {
    const absPath = path.join(PIM_REPO_DIR, filePath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content, 'utf-8');
    console.log(`Updated: ${filePath}`);
  }

  console.log('🛠 Running local npm install...');
  safeRun('npm install');

  console.log('🧪 Verifying local build...');
  const buildResult = safeRun('npm run build');

  if (buildResult.toLowerCase().includes('error') || buildResult.toLowerCase().includes('failed')) {
    console.error('❌ Local build failed. Not pushing changes.');
    console.log(buildResult);
    return;
  }

  run('git config user.email "ci-bot@example.com"');
  run('git config user.name "CI Bot"');
  run('git add .');
  run(`git commit -m "AI iteration: ${new Date().toISOString()}" || echo "No changes to commit"`);
  run(`git push origin ${process.env.TARGET_BRANCH || 'main'}`);
}

// -----------------
// Main loop
// -----------------
(async () => {
  console.log('🔄 Fetching latest Vercel build logs...');
  const { logs, state } = await fetchLatestBuildLog();

  if (state !== 'READY') {
    console.log('❌ Build failed — applying AI fix...');
    await applyAIFix(logs);
  } else {
    console.log('✅ Build passed — developing next PIM feature...');
    await developNextFeature();
  }
})();
