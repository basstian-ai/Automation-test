/**
 * AI Iteration Agent (wired with Vercel logs → issues → LLM → unified diff)
 * - Phase 1: FIX build/runtime issues
 * - Phase 2: IMPROVE by implementing roadmap items
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { SYSTEM_PROMPT } = require('./lib/prompt.cjs');
const { listDeployments, getBuildEvents, getRuntimeLogs, concatAndTrimLogs } = require('./lib/vercelLogs.cjs');
const { fetchWithRetry } = require('./lib/http.cjs');
const { extractIssuesFromLogs, filesFromIssues } = require('./lib/parseLogs.cjs');
const { strategyFor } = require('./lib/strategies.cjs');
const { tryLocalBuild, getRepoTree, collectRepoFiles, readRoadmap, applyUnifiedDiff, commitAndPush, pickPackageManager, run, runPreBuildFixes } = require('./lib/utils.cjs');
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5-mini';
const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
const VERCEL_PROJECT_ID = process.env.VERCEL_PROJECT_ID;
// Target repo + directory (accept both TARGET_REPO_DIR and TARGET_DIR for backwards compat)
const TARGET_REPO = process.env.TARGET_REPO; // e.g. "basstian-ai/simple-pim-1754492683911"
const TARGET_REPO_DIR =
  process.env.TARGET_REPO_DIR ||
  process.env.TARGET_DIR ||
  path.resolve(process.cwd(), '..', 'simple-pim-1754492683911');
const TARGET_REPO_GIT =
  process.env.TARGET_REPO_GIT ||
  (TARGET_REPO ? `https://github.com/${TARGET_REPO}.git` : 'https://github.com/basstian-ai/simple-pim-1754492683911');const GH_PUSH_TOKEN = process.env.GH_PUSH_TOKEN || process.env.GITHUB_TOKEN; // prefer PAT


if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY');
  process.exit(1);
}

if (!VERCEL_TOKEN && !VERCEL_PROJECT_ID) {
  console.warn('Missing VERCEL_TOKEN and VERCEL_PROJECT_ID; skipping Vercel log ingestion.');
} else if (!VERCEL_TOKEN) {
  console.error('VERCEL_TOKEN is required when VERCEL_PROJECT_ID is set.');
  process.exit(1);
} else if (!VERCEL_PROJECT_ID) {
  console.error('VERCEL_PROJECT_ID is required when VERCEL_TOKEN is set.');
  process.exit(1);
}

async function callLLM({ system, payload }) {
  const body = {
    model: OPENAI_MODEL, // keep gpt-5-mini
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify(payload) }
    ]
  };

  const res = await fetchWithRetry(
    'https://api.openai.com/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify(body),
    },
    { errorPrefix: 'OpenAI ' }
  );

  const json = await res.json();
  const out = json.choices?.[0]?.message?.content || '';
  if (!out) throw new Error('OpenAI returned empty message');
  return out;
}
async function fetchVercelLogs() {
  if (!VERCEL_TOKEN || !VERCEL_PROJECT_ID) return { trimmedLogs: '', issues: [], deployments: [] };
  const deployments = await listDeployments({ token: VERCEL_TOKEN, projectId: VERCEL_PROJECT_ID, limit: 5 });
  if (!deployments.length) return { trimmedLogs: '', issues: [], deployments: [] };
  const d = deployments[0]; // latest
  const id = d.uid || d.id;
  // Fetch build and runtime logs concurrently for speed
  const runtimeLogsPromise = getRuntimeLogs({
    token: VERCEL_TOKEN,
    projectId: VERCEL_PROJECT_ID,
    deploymentId: id,
  }).catch(err => {
    console.warn('Failed to fetch Vercel runtime logs:', err.message || err);
    return '';
  });

  const [buildText, runtimeText] = await Promise.all([
    getBuildEvents({ token: VERCEL_TOKEN, deploymentId: id }),
    Promise.race([
      runtimeLogsPromise,
      new Promise(resolve => setTimeout(() => resolve(''), 5000)),
    ]),
  ]);
  const trimmedLogs = concatAndTrimLogs({ buildText, runtimeText });
  const issues = extractIssuesFromLogs(trimmedLogs);
  return { trimmedLogs, issues, deployments };
}

function computeFilesToSend(repoDir, issues) {
  const fromIssues = filesFromIssues(issues);
  const extra = [];

  function walk(dir) {
    const abs = path.join(repoDir, dir);
    if (!fs.existsSync(abs)) return;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const rel = path.join(dir, entry.name).replace(/\\/g, '/');
      if (entry.isDirectory()) walk(rel);
      else if (/\.(js|jsx|ts|tsx|cjs|mjs)$/.test(entry.name)) extra.push(rel);
    }
  }

  ['pages', 'lib', 'components'].forEach(walk);
  const set = new Set([...fromIssues, ...extra]);
  return Array.from(set).slice(0, 100);
}

function generateCommitMessage(diff) {
  const fileRegex = /^diff --git a\/\S+ b\/(\S+)$/gm;
  const files = Array.from(new Set([...diff.matchAll(fileRegex)].map(m => m[1])));
  let summary;
  if (files.length === 0) summary = 'update files';
  else if (files.length === 1) summary = `update ${files[0]}`;
  else if (files.length === 2) summary = `update ${files[0]} and ${files[1]}`;
  else summary = `update ${files[0]} and ${files.length - 1} other files`;
  return `chore(ai): ${summary} (auto)`;
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
   console.log('ℹ️  No issues found → proceeding to implement roadmap improvements.');
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
      commitStyle: 'single comprehensive commit'
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
    // Run small deterministic fixes that we know are safe
  runPreBuildFixes(repoDir);

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
    const commitMessage = generateCommitMessage(diff);
    console.log(`✅ Build is green. Committing & pushing with message: ${commitMessage}`);
    commitAndPush(commitMessage, repoDir);
  }
  console.log('✨ Done.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
