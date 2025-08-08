// ai-iter-agent.js
import dotenv from 'dotenv';
dotenv.config();

import OpenAI from 'openai';
import { readFileTree } from './readFileTree.js';
import simpleGit from 'simple-git';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { spawnSync } from 'child_process';

// ─────────────── ENV ───────────────
const {
  // Git / repo
  PAT_TOKEN,
  GITHUB_TOKEN,
  TARGET_REPO,                // e.g. "org/name"
  TARGET_BRANCH = 'main',

  // OpenAI
  OPENAI_API_KEY,

  // Vercel
  VERCEL_TOKEN,
  VERCEL_TEAM_ID,             // optional
  VERCEL_PROJECT              // required: projectId like prj_xxx
} = process.env;

const git = simpleGit();
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ─────────────── Vercel client ───────────────
const vercel = axios.create({
  baseURL: 'https://api.vercel.com',
  headers: {
    Authorization: `Bearer ${VERCEL_TOKEN}`,
    Accept: 'application/json'
  },
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

// Super rough token estimate (avoid gpt-3-encoder)
const approxTokens = (s) => Math.ceil((s?.length || 0) / 4);

// ─────────────── Vercel helpers ───────────────

/** Get latest deployment for project; returns { id, readyState, url } */
async function fetchLatestDeployment() {
  if (!VERCEL_PROJECT) {
    console.error('❌ Missing VERCEL_PROJECT (prj_xxx).');
    return null;
  }

  try {
    const res = await vercel.get('/v6/deployments', {
      params: {
        projectId: VERCEL_PROJECT,
        limit: 1
      }
    });

    const deployments = res.data?.deployments || [];
    if (deployments.length === 0) {
      console.warn('⚠️ No deployments found for project.');
      return null;
    }

    const d = deployments[0];
    return { id: d.uid, readyState: d.readyState, url: d.url };
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    console.error('❌ Error fetching latest deployment:', { status, data });

    if (status === 403) {
      console.error('🔒 403 Forbidden — check VERCEL_TOKEN scope and VERCEL_TEAM_ID (if project is under a team).');
    } else if (status === 400) {
      console.error('⚠️ 400 Bad Request — ensure VERCEL_PROJECT is a valid projectId (prj_xxx).');
    }
    return null;
  }
}

/** Fetch build log text for a deployment by trying multiple official paths + CLI fallback. */
async function fetchBuildLog(deployId, deployUrl) {
  if (!deployId) return 'Ingen forrige deploy.';

  const chunks = [];
  const push = (label, text) => {
    if (text && text.trim()) {
      chunks.push(`\n===== ${label} =====\n${text.trim()}`);
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
    const r = await vercel.get(`/v13/deployments/${deployId}/events`, {
      params: { limit: 2000, ...(VERCEL_TEAM_ID ? { teamId: VERCEL_TEAM_ID } : {}) },
    });
    const data = Array.isArray(r.data) ? r.data : r.data?.events || [];
    const txt = stitchEvents(data);
    if (txt.trim()) {
      push('v13 /deployments/:id/events', txt);
    } else {
      console.warn('⚠️ v13 /events returned no payload.text');
    }
  } catch (err) {
    console.warn('⚠️ v13 /deployments/:id/events failed', {
      status: err.response?.status,
      code: err.response?.data?.code,
      message: err.response?.data?.message || err.message,
    });
  }

  // 2) v6 events (fallback)
  if (chunks.length === 0) {
    try {
      const r = await vercel.get(`/v6/deployments/${deployId}/events`, {
        params: { limit: 2000, ...(VERCEL_TEAM_ID ? { teamId: VERCEL_TEAM_ID } : {}) },
      });
      const data = Array.isArray(r.data) ? r.data : r.data?.events || [];
      const txt = stitchEvents(data);
      if (txt.trim()) {
        push('v6 /deployments/:id/events', txt);
      } else {
        console.warn('⚠️ v6 /events returned no payload.text');
      }
    } catch (err) {
      console.warn('⚠️ v6 /deployments/:id/events failed', {
        status: err.response?.status,
        code: err.response?.data?.code,
        message: err.response?.data?.message || err.message,
      });
    }
  }

  // 3) Per-build logs nested under the deployment
  if (chunks.length === 0) {
    try {
      const buildsRes = await vercel.get(`/v13/deployments/${deployId}/builds`, {
        params: VERCEL_TEAM_ID ? { teamId: VERCEL_TEAM_ID } : {},
      });
      const builds = Array.isArray(buildsRes.data) ? buildsRes.data : buildsRes.data?.builds || [];
      if (!builds.length) {
        console.warn('⚠️ No builds listed for deployment (v13 /deployments/:id/builds).');
      }

      for (const b of builds) {
        const buildId = b.id || b.uid || b.buildId;
        if (!buildId) continue;

        // /deployments/:id/builds/:buildId/logs
        try {
          const rLogs = await vercel.get(`/v13/deployments/${deployId}/builds/${buildId}/logs`, {
            params: VERCEL_TEAM_ID ? { teamId: VERCEL_TEAM_ID } : {},
          });
          let txt = '';
          if (typeof rLogs.data === 'string') txt = rLogs.data;
          else if (Array.isArray(rLogs.data)) txt = rLogs.data.join('\n');
          else if (Array.isArray(rLogs.data?.logs)) txt = rLogs.data.logs.join('\n');

          if (txt.trim()) {
            push(`v13 /deployments/${deployId}/builds/${buildId}/logs`, txt);
          } else {
            console.warn(`⚠️ nested /logs had no text for build ${buildId}`);
          }
        } catch (err) {
          console.warn(`⚠️ v13 /deployments/${deployId}/builds/${buildId}/logs failed`, {
            status: err.response?.status,
            code: err.response?.data?.code,
            message: err.response?.data?.message || err.message,
          });
        }

        // /deployments/:id/builds/:buildId/events
        try {
          const rEv = await vercel.get(`/v13/deployments/${deployId}/builds/${buildId}/events`, {
            params: { limit: 2000, ...(VERCEL_TEAM_ID ? { teamId: VERCEL_TEAM_ID } : {}) },
          });
          const data = Array.isArray(rEv.data) ? rEv.data : rEv.data?.events || [];
          const txt = stitchEvents(data);
          if (txt.trim()) {
            push(`v13 /deployments/${deployId}/builds/${buildId}/events`, txt);
          } else {
            console.warn(`⚠️ nested /events returned no payload.text for build ${buildId}`);
          }
        } catch (err) {
          console.warn(`⚠️ v13 /deployments/${deployId}/builds/${buildId}/events failed`, {
            status: err.response?.status,
            code: err.response?.data?.code,
            message: err.response?.data?.message || err.message,
          });
        }
      }
    } catch (err) {
      console.warn('⚠️ v13 /deployments/:id/builds failed', {
        status: err.response?.status,
        code: err.response?.data?.code,
        message: err.response?.data?.message || err.message,
      });
    }
  }

  // 4) CLI fallback (often works even when API endpoints are picky)
  if (chunks.length === 0 && deployUrl) {
    try {
      const args = [
        'vercel@latest',
        'logs',
        deployUrl.startsWith('http') ? deployUrl : `https://${deployUrl}`,
        '--token', VERCEL_TOKEN,
        '--all',
        '--no-color'
      ];
      if (VERCEL_TEAM_ID) {
        args.push('--scope', VERCEL_TEAM_ID);
      }
      const res = spawnSync('npx', args, { encoding: 'utf-8' });
      if (res.error) {
        console.warn('⚠️ CLI logs spawn error:', res.error?.message);
      } else {
        const out = (res.stdout || '') + (res.stderr || '');
        if (out.trim()) push('cli vercel logs', out);
      }
    } catch (e) {
      console.warn('⚠️ CLI fallback failed:', e?.message);
    }
  }

  const out = chunks.join('\n').trim();
  if (!out) {
    console.warn('⚠️ No build logs found from any path; returning placeholder.');
    return 'Ingen build-logger funnet.';
  }
  // keep last 8k chars for token sanity
  return out.slice(-8000);
}

/** Decide if build failed using readyState first, then log heuristics */
function detectBuildFailed(readyState, buildLog) {
  // Trust the platform state first if present
  if (readyState) {
    const rs = String(readyState).toUpperCase();
    if (['ERROR', 'FAILED', 'CANCELED'].includes(rs)) return true;
    if (['READY', 'SUCCESS'].includes(rs)) return false;
  }

  // Heuristics on logs as fallback
  const log = (buildLog || '').toLowerCase();
  const redSignals = [
    'build failed',
    'error: command "npm run build" exited with',
    'failed with exit code',
    'exit code 1',
    'vercel build failed',
    'command failed',
    'error  in',
    'module not found',
    'tsc found',
    'eslint found',
    'failed to compile',
    'build error occurred'
  ];

  const greenSignals = [
    'build completed',
    'build succeeded',
    'compiled successfully',
    'ready! deployed to',
    'deployment completed',
    'build completed in'
  ];

  const redHit = redSignals.some(s => log.includes(s));
  const greenHit = greenSignals.some(s => log.includes(s));

  if (redHit && !greenHit) return true;
  if (greenHit && !redHit) return false;

  // Ambiguous? Default to "green" so we don’t block improvements forever.
  return false;
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

  // 2) Latest deployment + logs
  const latest = await fetchLatestDeployment();
  const lastDeployId = latest?.id || null;
  const readyState = latest?.readyState || null;
  const deployUrl = latest?.url || null;

  const buildLog = await fetchBuildLog(lastDeployId, deployUrl);
  const buildFailed = detectBuildFailed(readyState, buildLog);

  console.log('📝 lastDeployId:', lastDeployId, 'readyState:', readyState, 'buildFailed:', buildFailed);
  console.log('🔍 buildLog-preview:', (buildLog || '').slice(0, 400));

  // 3) Tailored system prompt
  const modeText = buildFailed
    ? `Bygget er RØDT. Finn årsaken i buildLog og rett feilen. Prioriter å gjøre det minimal-invasivt (små, sikre endringer).`
    : `Bygget er GRØNT. Implementer en liten, inkrementell forbedring i PIM-systemet (kodekvalitet, tilgjengelighet, DX, tests, eller en liten UI/UX-polish).`;

  const systemPrompt = `
Du er en autonom utvikler for et Next.js PIM-prosjekt.
${modeText}

Krav:
- Endringer skal være små, atomiske og trygge.
- Forklar kort hva du endrer i "commitMessage".
- Ikke modifiser låste filer (lockfiles) manuelt.
- Kjør type-/lint-fiks (ved behov) i koden du endrer.

Returnér KUN gyldig JSON:
{
  "files": { "<filsti>": "<innhold>" },
  "commitMessage": "<kort beskrivelse>"
}`.trim();

  const userPayload = { files: repoFiles, buildLog, lastDeployId, readyState, buildFailed, deployUrl };
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
  if (changedFiles.length === 0) {
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
