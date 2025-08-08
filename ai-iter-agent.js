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
  TARGET_REPO,
  TARGET_BRANCH = 'main',

  // OpenAI
  OPENAI_API_KEY,

  // Vercel
  VERCEL_TOKEN,
  VERCEL_TEAM_ID,
  VERCEL_PROJECT
} = process.env;

const git = simpleGit();
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

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

const approxTokens = (s) => Math.ceil((s?.length || 0) / 4);

// ─────────────── Vercel helpers ───────────────
async function fetchLatestDeployment() {
  if (!VERCEL_PROJECT) {
    console.error('❌ Missing VERCEL_PROJECT.');
    return null;
  }
  try {
    const res = await vercel.get('/v6/deployments', {
      params: { projectId: VERCEL_PROJECT, limit: 1 }
    });
    const deployments = res.data?.deployments || [];
    if (!deployments.length) return null;
    const d = deployments[0];
    return { id: d.uid, url: d.url, readyState: d.readyState };
  } catch (err) {
    console.error('❌ Error fetching latest deployment:', err.response?.status, err.response?.data);
    return null;
  }
}

async function waitForTerminalState(deployId, { timeoutMs = 180_000, pollMs = 3_000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await vercel.get(`/v6/deployments/${deployId}`, {
        params: VERCEL_TEAM_ID ? { teamId: VERCEL_TEAM_ID } : {},
      });
      const rs = (r.data?.readyState || '').toUpperCase();
      if (!['BUILDING', 'QUEUED', 'INITIALIZING'].includes(rs)) return rs;
    } catch {}
    await new Promise(r => setTimeout(r, pollMs));
  }
  return 'TIMEOUT';
}

async function fetchBuildLog(deployId, deployUrl) {
  if (!deployId) return 'Ingen forrige deploy.';
  const chunks = [];
  const push = (label, text) => { if (text?.trim()) chunks.push(`\n===== ${label} =====\n${text.trim()}`); };
  const stitchEvents = (arr) => (Array.isArray(arr) ? arr : []).filter(e => e?.payload?.text).map(e => e.payload.text).join('\n');

  // v13 events
  try {
    const r = await vercel.get(`/v13/deployments/${deployId}/events`, { params: { limit: 2000 } });
    const data = Array.isArray(r.data) ? r.data : r.data?.events || [];
    const txt = stitchEvents(data);
    if (txt) push('v13 /deployments/:id/events', txt);
  } catch (err) {
    console.warn('⚠️ v13 /events failed', err.response?.status);
  }

  // v6 events
  if (!chunks.length) {
    try {
      const r = await vercel.get(`/v6/deployments/${deployId}/events`, { params: { limit: 2000 } });
      const data = Array.isArray(r.data) ? r.data : r.data?.events || [];
      const txt = stitchEvents(data);
      if (txt) push('v6 /deployments/:id/events', txt);
    } catch (err) {
      console.warn('⚠️ v6 /events failed', err.response?.status);
    }
  }

  // builds logs
  if (!chunks.length) {
    try {
      const buildsRes = await vercel.get(`/v13/deployments/${deployId}/builds`);
      const builds = Array.isArray(buildsRes.data) ? buildsRes.data : buildsRes.data?.builds || [];
      for (const b of builds) {
        const buildId = b.id || b.uid;
        if (!buildId) continue;
        try {
          const rLogs = await vercel.get(`/v13/builds/${buildId}/logs`);
          let txt = '';
          if (typeof rLogs.data === 'string') txt = rLogs.data;
          else if (Array.isArray(rLogs.data)) txt = rLogs.data.join('\n');
          else if (Array.isArray(rLogs.data?.logs)) txt = rLogs.data.logs.join('\n');
          if (txt) push(`v13 /builds/${buildId}/logs`, txt);
        } catch {}
      }
    } catch (err) {
      console.warn('⚠️ /builds failed', err.response?.status);
    }
  }

  // CLI fallback
  if (!chunks.length && (deployUrl || deployId)) {
    try {
      const idOrUrl = deployUrl ? `https://${deployUrl}` : deployId;
      const args = [
        'vercel@latest', 'inspect', idOrUrl,
        '--logs', '--token', VERCEL_TOKEN, '--no-color', '--yes'
      ];
      if (VERCEL_TEAM_ID) args.push('--scope', VERCEL_TEAM_ID);
      const res = spawnSync('npx', args, { encoding: 'utf-8' });
      const out = ((res.stdout || '') + (res.stderr || '')).trim();
      if (out) {
        const m = out.match(/Build Logs\s*\n[-=]+\n([\s\S]*)$/i);
        push('cli vercel inspect --logs', (m ? m[1] : out));
      }
    } catch (e) {
      console.warn('⚠️ CLI fallback failed', e.message);
    }
  }

  const out = chunks.join('\n').trim();
  return out ? out.slice(-8000) : 'Ingen build-logger funnet.';
}

function detectBuildFailed(readyState, buildLog) {
  if (readyState) {
    const rs = String(readyState).toUpperCase();
    if (['ERROR', 'FAILED', 'CANCELED'].includes(rs)) return true;
    if (['READY', 'SUCCESS'].includes(rs)) return false;
  }
  const log = (buildLog || '').toLowerCase();
  const redSignals = ['build failed', 'error: command "npm run build"', 'failed with exit code', 'exit code 1', 'vercel build failed', 'module not found'];
  const greenSignals = ['build completed', 'build succeeded', 'compiled successfully', 'ready! deployed to'];
  const redHit = redSignals.some(s => log.includes(s));
  const greenHit = greenSignals.some(s => log.includes(s));
  if (redHit && !greenHit) return true;
  if (greenHit && !redHit) return false;
  return false;
}

async function safeCompletion(opts, retries = 3) {
  try { return await openai.chat.completions.create(opts); }
  catch (err) {
    if (retries && (err.code === 'rate_limit_exceeded' || err.status === 429)) {
      await new Promise(r => setTimeout(r, 15_000));
      return safeCompletion(opts, retries - 1);
    }
    throw err;
  }
}

// ─────────────── MAIN ───────────────
(async () => {
  const repoFilesArr = await readFileTree('.', 50);
  const repoFiles = Object.fromEntries(repoFilesArr.map(f => [f.path, f.content]));

  const latest = await fetchLatestDeployment();
  if (latest?.id && ['BUILDING', 'QUEUED', 'INITIALIZING'].includes(String(latest.readyState).toUpperCase())) {
    const finalState = await waitForTerminalState(latest.id);
    console.log('⏳ waited for terminal state →', finalState);
    latest.readyState = finalState;
  }

  const buildLog = await fetchBuildLog(latest?.id, latest?.url);
  const buildFailed = detectBuildFailed(latest?.readyState, buildLog);

  console.log('📝 lastDeployId:', latest?.id, 'readyState:', latest?.readyState, 'buildFailed:', buildFailed);
  console.log('🔍 buildLog-preview:', (buildLog || '').slice(0, 400));

  const modeText = buildFailed
    ? `Bygget er RØDT. Finn årsaken i buildLog og rett feilen.`
    : `Bygget er GRØNT. Implementer en liten forbedring.`;

  const systemPrompt = `
Du er en autonom utvikler for et Next.js PIM-prosjekt.
${modeText}
- Endringer skal være små, trygge.
- Forklar kort hva du endrer i "commitMessage".
- Ikke endre lockfiles manuelt.
Returnér KUN gyldig JSON:
{
  "files": { "<filsti>": "<innhold>" },
  "commitMessage": "<kort beskrivelse>"
}`.trim();

  const userPayload = { files: repoFiles, buildLog, lastDeployId: latest?.id, readyState: latest?.readyState, buildFailed };
  const userPrompt = JSON.stringify(userPayload);
  if (approxTokens(systemPrompt) + approxTokens(userPrompt) > 150_000) {
    console.error('❌ Prompt too large.');
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

  let payload;
  try { payload = JSON.parse(aiRes.choices[0].message.content); }
  catch (e) { console.error('❌ Could not parse AI response:', e); process.exit(1); }

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

  writeFiles(payload.files);
  const status = await git.status();
  console.log('🗂️ Git status before commit:', status);

  if (!status.modified.length && !status.created.length && !status.deleted.length) {
    console.log('🟡 No changes – skipping commit/push.');
    process.exit(0);
  }

  await git.addConfig('user.name', 'AI Dev Agent');
  await git.addConfig('user.email', 'ai-dev-agent@example.com');
  await git.add(changedFiles);
  await git.commit(payload.commitMessage);

  const repoSlug = TARGET_REPO || process.env.GITHUB_REPOSITORY;
  const pushToken = PAT_TOKEN || GITHUB_TOKEN;
  await git.remote(['set-url', 'origin', `https://x-access-token:${pushToken}@github.com/${repoSlug}.git`]);
  await git.push('origin', TARGET_BRANCH);

  console.log('✅ New iteration pushed – Vercel will build via Git integration');
})();
