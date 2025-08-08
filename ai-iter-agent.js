import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import fetch from 'node-fetch';
import OpenAI from 'openai';
import dotenv from 'dotenv';
dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// SETTINGS
const PIM_REPO_DIR = '../simple-pim-1754492683911';
const VERCEL_PROJECT_ID = process.env.VERCEL_PROJECT_ID;
const VERCEL_TOKEN = process.env.VERCEL_TOKEN;

// Persistent product vision for the AI
const PIM_PROMPT = `
You are building a modern Product Information Management (PIM) system using Next.js 10 and best practices.

The goal: Iteratively add the most valuable, production-ready features such a PIM should have, keeping the app always deployable.
Follow these principles:
- Clean, maintainable code with clear separation of concerns
- Prioritize features that unlock new capabilities for users:
  * Product CRUD (create, read, update, delete)
  * Category and taxonomy management
  * Bulk import/export (CSV/Excel)
  * Media asset management
  * User roles & permissions
  * API endpoints for integration with e-commerce, ERP, etc.
  * Search, filtering, and sorting for large product catalogs
  * Dashboard with KPIs
- Implement minimal viable versions first, then enhance iteratively
- Use modern UI patterns and responsive design
- Avoid breaking changes; every commit must result in a deployable build
- Keep dependencies up-to-date and secure
`;

// Run shell commands and capture output
function runCmd(cmd, cwd = PIM_REPO_DIR) {
  return execSync(cmd, { cwd, stdio: 'pipe' }).toString().trim();
}

// Fetch latest Vercel deployment and logs
async function getLatestDeploymentLogs() {
  const depRes = await fetch(`https://api.vercel.com/v6/deployments?projectId=${VERCEL_PROJECT_ID}&limit=1`, {
    headers: { Authorization: `Bearer ${VERCEL_TOKEN}` }
  });
  const depData = await depRes.json();
  if (!depData.deployments?.length) throw new Error('No deployments found');

  const latest = depData.deployments[0];
  const depId = latest.uid;
  const readyState = latest.readyState;

  const logRes = await fetch(`https://api.vercel.com/v13/deployments/${depId}/events`, {
    headers: { Authorization: `Bearer ${VERCEL_TOKEN}` }
  });
  const logData = await logRes.text();

  return { depId, readyState, logData };
}

// Use OpenAI to fix build errors
async function fixBuildErrors(logs) {
  console.log('🚨 Build failed — sending logs to AI for fix...');
  const codeFiles = getAllCodeFiles();

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'You are an AI software engineer that fixes build errors in JavaScript/TypeScript/Next.js projects.' },
      { role: 'user', content: `Here are the latest build logs:\n\n${logs}\n\nHere is the current codebase:\n${codeFiles}\n\nFix the errors so that the app builds successfully without removing existing features.` }
    ]
  });

  applyPatch(completion.choices[0].message.content);
}

// Use OpenAI to add next PIM feature
async function addNextFeature() {
  console.log('✅ Build passed — generating next PIM feature...');
  const codeFiles = getAllCodeFiles();

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'You are an AI software engineer building a production-ready PIM system.' },
      { role: 'user', content: `${PIM_PROMPT}\n\nCurrent codebase:\n${codeFiles}\n\nImplement the next high-value feature.` }
    ]
  });

  applyPatch(completion.choices[0].message.content);
}

// Read all JS/TS/TSX files in PIM repo
function getAllCodeFiles() {
  const files = [];
  function walk(dir) {
    for (const file of fs.readdirSync(dir)) {
      const fullPath = path.join(dir, file);
      if (fs.statSync(fullPath).isDirectory()) {
        walk(fullPath);
      } else if (/\.(js|ts|tsx)$/.test(file) && fs.statSync(fullPath).size < 20000) {
        files.push(`--- ${fullPath} ---\n${fs.readFileSync(fullPath, 'utf8')}`);
      }
    }
  }
  walk(PIM_REPO_DIR);
  return files.join('\n\n');
}

// Apply AI patch to repo
function applyPatch(patchContent) {
  fs.writeFileSync(path.join(PIM_REPO_DIR, 'ai_patch.txt'), patchContent);
  runCmd('git pull');
  // You could improve this by actually parsing diff/patch and writing to files
  runCmd('git add .');
  runCmd('git commit -m "AI iteration update" || echo "No changes to commit"');
  runCmd('git push');
}

// MAIN
(async () => {
  try {
    // Step 1: Pull latest
    runCmd('git pull');

    // Step 2: Read latest Vercel logs
    const { readyState, logData } = await getLatestDeploymentLogs();

    if (readyState === 'ERROR') {
      await fixBuildErrors(logData);
    } else if (readyState === 'READY') {
      await addNextFeature();
    } else {
      console.log(`ℹ️ Build state: ${readyState} — no action taken.`);
    }
  } catch (err) {
    console.error('❌ Agent failed:', err);
  }
})();
