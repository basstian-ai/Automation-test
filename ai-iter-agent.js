// ai-iter-agent.js
import dotenv from 'dotenv';
dotenv.config();

import OpenAI from 'openai';
import { readFileTree } from './readFileTree.js';
import simpleGit from 'simple-git';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { execSync } from 'child_process';

// ─────────────── ENV ───────────────
const {
  // Git / repo
  PAT_TOKEN,
  GITHUB_TOKEN,
  TARGET_REPO,                 // e.g. "org/name"
  TARGET_BRANCH = 'main',

  // OpenAI
  OPENAI_API_KEY,

  // Vercel
  VERCEL_TOKEN,
  VERCEL_TEAM_ID,              // optional
  VERCEL_PROJECT               // required: projectId like prj_xxx
} = process.env;

const git = simpleGit();
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ─────────────── Vercel client ───────────────
const vercel = axios.create({
  baseURL: 'https://api.vercel.com',
  headers: { Authorization: `Bearer ${VERCEL_TOKEN}` },
  params: VERCEL_TEAM_ID ? { teamId: VERCEL_TEAM_ID } : {}
});

// ─────────────── Utils ───────────────
function writeFiles(fileMap) {
  for (const [file, content] of Object.entries(fileMap)) {
    const full = path.join(process.cwd(), file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

const fileExists = (p) => {
  try { return fs.existsSync(p); } catch { return false; }
};

// Super rough token estimate (avoid gpt-3-encoder)
const approxTokens = (s) => Math.ceil((s?.length || 0) / 4);

// Poll helper
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─────────────── Vercel helpers ───────────────

/** Get latest deployment for project; returns { id, readyState } */
async function fetchLatestDeployment() {
  if (!VERCEL_PROJECT) {
    console.error('❌ Missing VERCEL_PROJECT (prj_xxx).');
    return null;
  }

  try {
    const res = await vercel.get('/v6/deployments', {
      params: { projectId: VERCEL_PROJECT, limit: 1 }
    });

    const deployments = res.data?.deployments || [];
    if (!deployments.length) {
      console.warn('⚠️ No deployments found for project.');
      return null;
    }
    const d = deployments[0];
    return { id: d.uid, readyState: d.readyState }; // e.g. READY, ERROR, BUILDING
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    console.error('❌ Error fetching latest deployment:', { status, data });

    if (status === 403) {
      console.error('🔒 403 Forbidden — check VERCEL_TOKEN scope and VERCEL_TEAM_ID.');
    } else if (status === 400) {
      console.error('⚠️ 400 Bad Request — ensure VERCEL_PROJECT is a valid projectId (prj_xxx).');
    }
    return null;
  }
}

/** Wait until deployment is in a terminal state (READY|ERROR|CANCELED) or timeout */
async function waitForTerminalState(id, initialState, timeoutMs = 90_000) {
  const term = new Set(['READY', 'ERROR', 'CANCELED']);
  if (term.has(String(initialState).toUpperCase())) return initialState;

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(3_000);
    try {
      const res = await vercel.get(`/v6/deployments/${id}`);
      const state = res.data?.readyState;
      if (term.has(String(state).toUpperCase())) return state;
    } catch { /* ignore */ }
  }
  return initialState;
}

/** Fetch build log text for a deployment by trying multiple official paths + CLI fallback. */
async function fetchBuildLog(deployId) {
  if (!deployId) return 'Ingen forrige deploy.';

  const chunks = [];
  const push = (label, text) => {
    if (text && String(text).trim()) {
      chunks.push(`\n===== ${label} =====\n${String(text).trim()}`);
    }
  };

  // Helper: stitch payload.text from events arrays
  const stitchEvents = (arr) =>
    (Array.isArray(arr) ? arr : [])
      .filter((e) => e?.payload?.text)
      .map((e) => e.payload.text)
      .join('\n');

  // 1) v13 events (preferred)
  try {
    const r = await vercel.get(`/v13/deployments/${deployId}/events`, { params: { limit: 2000 } });
    const data = Array.isArray(r.data) ? r.data : r.data?.events || [];
    const txt = stitchEvents(data);
    if (txt.trim()) push('v13 /deployments/:id/events', txt);
    else console.warn('⚠️ v13 /events returned no payload.text');
  } catch (err) {
    console.warn('⚠️ v13 /events failed  ' + (err.response?.status || ''), );
  }

  // 2) v6 events (fallback)
  if (!chunks.length) {
    try {
      const r = await vercel.get(`/v6/deployments/${deployId}/events`, { params: { limit: 2000 } });
      const data = Array.isArray(r.data) ? r.data : r.data?.events || [];
      const txt = stitchEvents(data);
      if (txt.trim()) push('v6 /deployments/:id/events', txt);
      else console.warn('⚠️ v6 /events returned no payload.text');
    } catch (err) {
      console.warn('⚠️ v6 /events failed  ' + (err.response?.status || ''), );
    }
  }

  // 3) per-build logs/events (v13)
  if (!chunks.length) {
    try {
      const buildsRes = await vercel.get(`/v13/deployments/${deployId}/builds`);
      const builds = Array.isArray(buildsRes.data)
        ? buildsRes.data
        : buildsRes.data?.builds || [];
      if (!builds.length) console.warn('⚠️ No builds listed for deployment (v13 /deployments/:id/builds).');

      for (const b of builds) {
        const buildId = b.id || b.uid || b.buildId;
        if (!buildId) continue;

        try {
          const rLogs = await vercel.get(`/v13/builds/${buildId}/logs`, {
            params: VERCEL_TEAM_ID ? { teamId: VERCEL_TEAM_ID } : {},
          });
          let txt = '';
          if (typeof rLogs.data === 'string') txt = rLogs.data;
          else if (Array.isArray(rLogs.data)) txt = rLogs.data.join('\n');
          else if (Array.isArray(rLogs.data?.logs)) txt = rLogs.data.logs.join('\n');
          if (txt.trim()) push(`v13 /builds/${buildId}/logs`, txt);
          else console.warn(`⚠️ v13 /builds/${buildId}/logs had no text`);
        } catch (err) {
          console.warn(`⚠️ v13 /builds/${buildId}/logs failed ${err.response?.status || ''}`);
        }

        try {
          const rEv = await vercel.get(`/v13/builds/${buildId}/events`, {
            params: { limit: 2000, ...(VERCEL_TEAM_ID ? { teamId: VERCEL_TEAM_ID } : {}) },
          });
          const data = Array.isArray(rEv.data) ? rEv.data : rEv.data?.events || [];
          const txt = stitchEvents(data);
          if (txt.trim()) push(`v13 /builds/${buildId}/events`, txt);
          else console.warn(`⚠️ v13 /builds/${buildId}/events returned no payload.text`);
        } catch (err) {
          console.warn(`⚠️ v13 /builds/${buildId}/events failed ${err.response?.status || ''}`);
        }
      }
    } catch (err) {
      console.warn('⚠️ v13 /deployments/:id/builds failed ' + (err.response?.status || ''));
    }
  }

  // 4) CLI fallback: npx vercel inspect --logs
  if (!chunks.length) {
    try {
      const cmd = [
        'npx',
        '-y',
        'vercel@latest',
        'inspect',
        deployId,
        '--logs',
        '--token', VERCEL_TOKEN
      ];
      // Avoid --scope unless you know the team slug. Token usually suffices.
      const out = execSync(cmd.join(' '), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      if (out?.trim()) push('cli vercel inspect --logs', out);
    } catch (e) {
      const errOut = e?.stdout?.toString() || e?.stderr?.toString() || e?.message;
      if (errOut?.trim()) push('cli vercel inspect --logs (stderr)', errOut);
    }
  }

  const out = chunks.join('\n').trim();
  if (!out) {
    console.warn('⚠️ No build logs found from any path; returning placeholder.');
    return 'Ingen build-logger funnet.';
  }
  return out.slice(-8000); // keep tail for token sanity
}

/** Decide if build failed using readyState first, then log heuristics */
function detectBuildFailed(readyState, buildLog) {
  if (readyState) {
    const rs = String(readyState).toUpperCase();
    if (['ERROR', 'FAILED', 'CANCELED'].includes(rs)) return true;
    if (['READY', 'SUCCESS'].includes(rs)) return false;
  }
  const log = (buildLog || '').toLowerCase();
  const redSignals = [
    'build failed',
    'build error',
    'failed with exit code',
    'exit code 1',
    'error: command "npm run build" exited',
    'command failed',
    'module not found',
  ];
  const greenSignals = [
    'build completed',
    'compiled successfully',
    'ready! deployed to',
    'deployment completed',
  ];
  const redHit = redSignals.some(s => log.includes(s));
  const greenHit = greenSignals.some(s => log.includes(s));
  if (redHit && !greenHit) return true;
  if (greenHit && !redHit) return false;
  return false;
}

// ─────────────── Autofixes for known Vercel/Next issues ───────────────

function logContainsRoutesManifestError(buildLog) {
  const s = (buildLog || '').toLowerCase();
  return s.includes('routes-manifest.json') || s.includes('now-next-routes-manifest');
}

function sanitizePackageJson(pkg) {
  pkg.scripts = pkg.scripts || {};
  pkg.scripts.dev = pkg.scripts.dev || 'next dev';
  pkg.scripts.build = 'next build';
  pkg.scripts.start = pkg.scripts.start || 'next start -p 3000';

  // Remove "export" / vercel-build scripts that produce /out
  const badScripts = ['export', 'vercel-build', 'predeploy', 'postbuild'];
  for (const key of Object.keys(pkg.scripts)) {
    const v = String(pkg.scripts[key] || '');
    if (badScripts.includes(key) || /next\s+export/i.test(v) || /\bout\b/.test(v)) {
      delete pkg.scripts[key];
    }
  }
  return pkg;
}

function buildNextConfig() {
  return `/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // IMPORTANT: do not set output: 'export' or distDir: 'out' on Vercel
};

module.exports = nextConfig;
`;
}

function needsNextConfigFix(content) {
  if (!content) return true;
  const s = content.toLowerCase();
  return s.includes("output: 'export'") || s.includes('output:"export"') || s.includes('distdir') || s.includes('out');
}

/** Apply auto-fixes if logs show export misconfig (routes-manifest error). Returns {changed:boolean, files:{}} */
function computeAutoFixesForRoutesManifest(buildLog) {
  if (!logContainsRoutesManifestError(buildLog)) return { changed: false, files: {} };

  const files = {};
  // 1) package.json
  const pkgPath = 'package.json';
  if (fileExists(pkgPath)) {
    try {
      const raw = fs.readFileSync(pkgPath, 'utf8');
      const pkg = JSON.parse(raw);
      const fixed = sanitizePackageJson(pkg);
      files[pkgPath] = JSON.stringify(fixed, null, 2) + '\n';
    } catch (e) {
      console.warn('⚠️ Could not read/parse package.json for autofix, skipping.', e.message);
    }
  }

  // 2) next.config.js
  const nextCfgPath = 'next.config.js';
  if (fileExists(nextCfgPath)) {
    const current = fs.readFileSync(nextCfgPath, 'utf8');
    if (needsNextConfigFix(current)) {
      files[nextCfgPath] = buildNextConfig();
    }
  } else {
    files[nextCfgPath] = buildNextConfig();
  }

  // 3) vercel.json — strip legacy "builds" if present
  const vercelJsonPath = 'vercel.json';
  if (fileExists(vercelJsonPath)) {
    try {
      const raw = fs.readFileSync(vercelJsonPath, 'utf8');
      const cfg = JSON.parse(raw);
      if (cfg.builds) {
        delete cfg.builds;
        files[vercelJsonPath] = JSON.stringify(cfg, null, 2) + '\n';
      }
    } catch (e) {
      // If invalid JSON, replace with minimal config (safe)
      files[vercelJsonPath] = JSON.stringify({}, null, 2) + '\n';
    }
  }

  const changed = Object.keys(files).length > 0;
  return { changed, files };
}

// ─────────────── OpenAI helpers ───────────────
async function safeCompletion(opts, retries = 3) {
  try {
    return await openai.chat.completions.create(opts);
  } catch (err) {
    if (retries && (err.code === 'rate_limit_exceeded' || err.status === 429)) {
      await new Promise(r => setTimeout(r, 15_000));
      return safeCompletion(opts, retries - 1);
    }
    throw err;
  }
}

// ─────────────── MAIN ───────────────
(async () => {
  // 1) Snapshot repo (max 50 files)
  const repoFilesArr = await readFileTree('.', 50);
  const repoFiles = Object.fromEntries(repoFilesArr.map(f => [f.path, f.content]));

  // 2) Latest deployment + wait for terminal + logs
  const latest = await fetchLatestDeployment();
  const lastDeployId = latest?.id || null;
  let readyState = latest?.readyState || null;
  readyState = await waitForTerminalState(lastDeployId, readyState);
  const buildLog = await fetchBuildLog(lastDeployId);

  const buildFailed = detectBuildFailed(readyState, buildLog);

  console.log('📝 lastDeployId:', lastDeployId, 'readyState:', readyState, 'buildFailed:', buildFailed);
  console.log('🔍 buildLog-preview:', (buildLog || '').slice(0, 400));

  // 2.5) If red build and log shows the Next export/routes-manifest issue → auto-fix & push immediately
  if (buildFailed) {
    const { changed, files } = computeAutoFixesForRoutesManifest(buildLog);
    if (changed) {
      console.log('🛠️ Applying auto-fix for Next export/routes-manifest…');
      writeFiles(files);

      const status = await git.status();
      if (status.modified.length || status.created.length || status.deleted.length) {
        await git.addConfig('user.name', 'AI Dev Agent');
        await git.addConfig('user.email', 'ai-dev-agent@example.com');
        await git.add(Object.keys(files));
        await git.commit('fix(next): remove static export; use `next build`; add sane next.config.js');
        const repoSlug = TARGET_REPO || process.env.GITHUB_REPOSITORY;
        const pushToken = PAT_TOKEN || GITHUB_TOKEN;
        await git.remote([
          'set-url',
          'origin',
          `https://x-access-token:${pushToken}@github.com/${repoSlug}.git`
        ]);
        await git.push('origin', TARGET_BRANCH);
        console.log('✅ Auto-fix pushed — Vercel will rebuild now. Exiting.');
        process.exit(0);
      } else {
        console.log('ℹ️ Auto-fix computed but no file changes detected.');
      }
    }
  }

  // 3) Tailored system prompt for model iteration
  const modeText = buildFailed
    ? `Bygget er RØDT. Finn årsaken i buildLog og rett feilen. Prioriter minimal-invasiv fix.`
    : `Bygget er GRØNT. Implementer en liten, inkrementell forbedring i PIM-systemet.`;

  const systemPrompt = `
Du er en autonom utvikler for et Next.js PIM-prosjekt.
${modeText}

Krav:
- Endringer skal være små, atomiske og trygge.
- Forklar kort hva du endrer i "commitMessage".
- Ikke modifiser lockfiles manuelt.
- Kjør type-/lint-fiks (ved behov) i koden du endrer.

Returnér KUN gyldig JSON:
{
  "files": { "<filsti>": "<innhold>" },
  "commitMessage": "<kort beskrivelse>"
}`.trim();

  const userPayload = { files: repoFiles, buildLog, lastDeployId, readyState, buildFailed };
  const userPrompt = JSON.stringify(userPayload);

  const tokenEstimate = approxTokens(systemPrompt) + approxTokens(userPrompt);
  if (tokenEstimate > 150_000) {
    console.error('❌ Prompt too large – reduce files in readFileTree.');
    process.exit(1);
  }

  const aiRes = await safeCompletion({
    model: 'gpt-4o-mini',
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]
  });

  // 4) Parse & validate
  let payload;
  try {
    payload = JSON.parse(aiRes.choices[0].message.content);
  } catch (e) {
    console.error('❌ Could not parse AI response:', e);
    process.exit(1);
  }
  if (!payload.files || !payload.commitMessage) {
    console.error('❌ AI response missing "files" or "commitMessage"');
    process.exit(1);
  }

  const changedFiles = Object.keys(payload.files);
  console.log('🔎 AI-payload:', changedFiles);
  if (!changedFiles.length) {
    console.log('🟡 AI suggested no changes – skipping commit/push.');
    process.exit(0);
  }

  // 5) Write, commit & push
  writeFiles(payload.files);
  const status = await git.status();
  console.log('🗂️ Git status before commit:', status);

  if (status.modified.length === 0 && status.created.length === 0 && status.deleted.length === 0) {
    console.log('🟡 No changes – skipping commit/push.');
    process.exit(0);
  }

  await git.addConfig('user.name', 'AI Dev Agent');
  await git.addConfig('user.email', 'ai-dev-agent@example.com');
  await git.add(changedFiles);
  await git.commit(payload.commitMessage);

  const repoSlug = TARGET_REPO || process.env.GITHUB_REPOSITORY;
  const pushToken = PAT_TOKEN || GITHUB_TOKEN;

  await git.remote([
    'set-url',
    'origin',
    `https://x-access-token:${pushToken}@github.com/${repoSlug}.git`
  ]);
  await git.push('origin', TARGET_BRANCH);

  console.log('✅ New iteration pushed – Vercel will build via Git integration');
})();
