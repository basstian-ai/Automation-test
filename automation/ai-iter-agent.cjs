/**
 * AI Iteration Agent (wired with Vercel logs → issues → LLM → unified diff)
 * - Phase 1: FIX build/runtime issues
 * - Phase 2: IMPROVE by implementing one roadmap item
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { SYSTEM_PROMPT } = require('./lib/prompt.cjs');
const { listDeployments, getBuildEvents, getRuntimeLogs, concatAndTrimLogs } = require('./lib/vercelLogs.cjs');
const { extractIssuesFromLogs, filesFromIssues } = require('./lib/parseLogs.cjs');
const { strategyFor } = require('./lib/strategies.cjs');
const { tryLocalBuild, getRepoTree, collectRepoFiles, readRoadmap, applyUnifiedDiff, commitAndPush, pickPackageManager, run } = require('./lib/utils.cjs');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5-mini';
const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
const VERCEL_PROJECT_ID = process.env.VERCEL_PROJECT_ID;
const TARGET_REPO = process.env.TARGET_REPO; // "owner/name"
const TARGET_REPO_GIT =
  process.env.TARGET_REPO_GIT
  || (TARGET_REPO ? `https://github.com/${TARGET_REPO}.git` : 'https://github.com/basstian-ai/simple-pim-1754492683911');
const GH_PUSH_TOKEN = process.env.GH_PUSH_TOKEN || process.env.GITHUB_TOKEN; // prefer PAT


if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY');
  process.exit(1);
}

async function callLLM({ system, payload }) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify(payload) }
      ]
    })
  });
  if (!res.ok) {
    const t = await res.text().catch(()=> '');
    throw new Error(`OpenAI ${res.status}: ${t.slice(0,500)}`);
  }
  const json = await res.json();
  return json.choices?.[0]?.message?.content || '';
}

async function fetchVercelLogs() {
  if (!VERCEL_TOKEN || !VERCEL_PROJECT_ID) return { trimmedLogs: '', issues: [], deployments: [] };
  const deployments = await listDeployments({ token: VERCEL_TOKEN, projectId: VERCEL_PROJECT_ID, limit: 5 });
  if (!deployments.length) return { trimmedLogs: '', issues: [], deployments: [] };
  const d = deployments[0]; // latest
  const id = d.uid || d.id;
  const buildText = await getBuildEvents({ token: VERCEL_TOKEN, deploymentId: id });
  let runtimeText = '';
  try { runtimeText = await getRuntimeLogs({ token: VERCEL_TOKEN, projectId: VERCEL_PROJECT_ID, deploymentId: id }); } catch {}
  const trimmedLogs = concatAndTrimLogs({ buildText, runtimeText });
  const issues = extractIssuesFromLogs(trimmedLogs);
  return { trimmedLogs, issues, deployments };
}

function computeFilesToSend(repoDir, issues) {
  const fromIssues = filesFromIssues(issues);
  const likely = [
    'pages/admin.js', 'pages/admin/index.js',
    'pages/attributes.js', 'pages/attributes/index.js',
    'pages/api/products.js', 'pages/api/products/index.js',
    'pages/api/attributes.js', 'pages/api/attributes/index.js',
    'pages/api/attribute-groups.js', 'pages/api/attribute-groups/index.js',
    'pages/api/products/[sku]/attributes/flat.js',
    'pages/api/slugify.js',
    'lib/slugify.js', 'lib/slugify.ts',
  ];
  const set = new Set([...fromIssues, ...likely].filter(Boolean));
  return [...set].filter(p => fs.existsSync(path.join(repoDir, p)));
}

async function main() {
const repoDir = TARGET_REPO_DIR;
const authUrl = GH_PUSH_TOKEN
  ? TARGET_REPO_GIT.replace('https://github.com/', `https://x-access-token:${GH_PUSH_TOKEN}@github.com/`)
  : TARGET_REPO_GIT;

console.log(`🏁 Target repo: ${repoDir}`);
if (!fs.existsSync(repoDir)) {
  console.log(`🔁 Cloning target repo from ${TARGET_REPO_GIT}...`);
  try { run(`git clone "${authUrl}" "${repoDir}"`); } catch {}
}
if (!fs.existsSync(repoDir)) {
  console.error(`Target repo dir does not exist: ${repoDir}`);
  process.exit(1);
}

// Ensure remote uses token (even if it already existed)
if (GH_PUSH_TOKEN) {
  try { run(`git remote set-url origin "${authUrl}"`, { cwd: repoDir }); } catch {}
}
  const frameworkVariant = fs.existsSync(path.join(repoDir, 'pages')) ? 'next-pages'
                           : fs.existsSync(path.join(repoDir, 'app')) ? 'next-app'
                           : 'unknown';
  const packageManager = pickPackageManager(repoDir);

  // 1) Fetch vercel logs → issues
  const { trimmedLogs, issues } = await fetchVercelLogs();
  console.log(`ℹ️  Parsed ${issues.length} issue(s) from Vercel logs`);
  if (issues.length === 0) {
   console.log('ℹ️  No issues found → proceeding to implement ONE roadmap item.');
 }
  const rules = issues.map(i => ({ file: i.file, rules: strategyFor(i) })).filter(r => r.rules.length);

  // 2) Build payload for the model
  const repoTree = getRepoTree(repoDir);
  const filesToSend = computeFilesToSend(repoDir, issues);
  const repoFiles = collectRepoFiles(repoDir, filesToSend);
  const roadmap = readRoadmap(repoDir);

  const payload = {
    issues,
    rules,
    trimmedLogs,
    repoFiles,
    repoTree,
    roadmap,
    constraints: {
      allowedOps: ['modify', 'rename', 'delete', 'create'],
      commitStyle: 'single small commit'
    },
    context: { packageManager, frameworkVariant }
  };

  // 3) Ask LLM for a unified diff (Fix→Improve)
  console.log('🧠 Calling LLM for unified diff...');
  let diff = await callLLM({ system: SYSTEM_PROMPT, payload });
  if (!diff || !diff.includes('diff --git')) {
    console.warn('Got non-unified patch. Asking model to reformat to unified git diff only...');
    const reformPrompt = `
You previously returned a patch that was NOT a raw unified git diff.
RESPONSE RULES:
- Return ONLY a raw unified git diff starting with "diff --git".
- No code fences, no "*** Begin Patch", no prose.
If no changes are needed, return a minimal valid diff that makes no changes.
`;
    diff = await callLLM({
      system: SYSTEM_PROMPT + '\n' + reformPrompt,
      payload: { ...payload, previousResponse: String(diff).slice(-20000) } // give the model its last output to convert
    });
  }
  if (!diff || !diff.includes('diff --git')) {
    console.error('No unified diff returned after reformat attempt. Full response:\n', diff);
    process.exit(1);
  }

  // 4) Apply diff, try build
   console.log('🩹 Applying patch from model...');
 let buildOK = false; // <-- ensure this exists in this scope
  try {
    applyUnifiedDiff(diff, repoDir);
  } catch (e) {
    console.warn('Patch apply failed, requesting a reformatted unified git diff...', e.message || e);
    const reformPrompt = `
Your previous output was not a valid unified git diff that "git apply" can apply.
RESPONSE RULES:
- Return ONLY a raw unified git diff starting with "diff --git a/<path> b/<path>".
- Use LF newlines. Include both '--- a/<path>' and '+++ b/<path>' for each file and at least one '@@' hunk.
- No code fences. No "*** Begin Patch".
- Do not include any prose.
`;
  const retry = await callLLM({
    system: SYSTEM_PROMPT + '\n' + reformPrompt,
    payload: { ...payload, previousResponse: String(diff).slice(-20000) }
  });
  applyUnifiedDiff(retry, repoDir); // will throw if still invalid
}
    // 4.5) Verify build locally; on failure, feed logs back once and retry
  try {
    console.log('🏗️  Building locally...');
    tryLocalBuild(repoDir);
    buildOK = true;
  } catch (e) {
    console.warn('First build failed, retrying once with fresh build logs...');
    const localLogs = String(e?.stderr || e?.stdout || e?.message || e);
    const retryPayload = {
      ...payload,
      trimmedLogs: `${trimmedLogs}\n\n==== LOCAL BUILD OUTPUT ====\n${localLogs.slice(-20000)}`
    };
    const retryDiff = await callLLM({ system: SYSTEM_PROMPT, payload: retryPayload });
    if (!retryDiff || !retryDiff.includes('diff --git')) {
      console.error('Retry did not return a diff. Aborting.');
      process.exit(1);
    }
    applyUnifiedDiff(retryDiff, repoDir);
    tryLocalBuild(repoDir); // throws on failure
    buildOK = true;
  }


  // 5) Commit & push
  if (buildOK) {
    console.log('✅ Build is green. Committing & pushing...');
    commitAndPush('chore(ai): fix build issues and implement one roadmap item (auto)', repoDir);
  }
  console.log('✨ Done.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
