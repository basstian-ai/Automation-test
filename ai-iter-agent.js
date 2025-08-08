// ai-iter-agent.js
import dotenv from 'dotenv';
dotenv.config();

import OpenAI from 'openai';
import { readFileTree } from './readFileTree.js';
import simpleGit from 'simple-git';
import fs from 'fs';
import path from 'path';
import axios from 'axios';

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

// Super rough token estimate (avoid gpt-3-encoder)
const approxTokens = (s) => Math.ceil((s?.length || 0) / 4);

// ─────────────── Vercel helpers ───────────────

/** Get latest deployment for project; returns { id, readyState } */
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
    return { id: d.uid, readyState: d.readyState }; // e.g. READY, ERROR, BUILDING
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

/** Fetch build logs/events; returns the last ~8k chars */
async function fetchBuildLog(deployId) {
  if (!deployId) return 'Ingen forrige deploy.';

  try {
    const res = await vercel.get(`/v3/deployments/${deployId}/events`, {
      params: { limit: -1 }
    });

    const events = Array.isArray(res.data) ? res.data : (res.data?.events || []);

    if (events.length === 0) {
      console.warn(`⚠️ No build events for deploy ${deployId}.`);
      return 'Ingen build-logger funnet.';
    }

    const logs = events
      .map(e => e?.payload?.text || e?.text || '')
      .filter(Boolean)
      .join('\n');

    return logs.slice(-8000);
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    console.error('❌ Error fetching build log:', { status, data });

    if (status === 403) {
      return 'Kunne ikke hente build-logg (403). Sjekk VERCEL_TOKEN / team-tilgang.';
    }
    return 'Kunne ikke hente build-logg.';
  }
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
  ];

  const greenSignals = [
    'build completed',
    'build succeeded',
    'compiled successfully',
    'ready! deployed to',
    'deployment completed',
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
  const buildLog = await fetchBuildLog(lastDeployId);

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
