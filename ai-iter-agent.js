// ai-iter-agent.js
import dotenv from 'dotenv';
dotenv.config();

import OpenAI from 'openai';
import { readFileTree } from './readFileTree.js';
import simpleGit from 'simple-git';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { encode } from 'gpt-3-encoder';

// ─────────────── ENV ───────────────
const {
  PAT_TOKEN,
  GITHUB_TOKEN,
  TARGET_REPO,
  TARGET_BRANCH = 'main',

  OPENAI_API_KEY,

  VERCEL_TOKEN,
  VERCEL_TEAM_ID,
  VERCEL_PROJECT // projectId (prj_xxx)
} = process.env;

const git = simpleGit();
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const vercel = axios.create({
  baseURL: 'https://api.vercel.com',
  headers: { Authorization: `Bearer ${VERCEL_TOKEN}` },
  params: VERCEL_TEAM_ID ? { teamId: VERCEL_TEAM_ID } : {}
});

// ─────────────── Helpers ───────────────
function writeFiles(fileMap) {
  for (const [file, content] of Object.entries(fileMap)) {
    const full = path.join(process.cwd(), file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

/** Fetch latest deployment ID for the project */
async function fetchLatestDeployId() {
  try {
    const res = await vercel.get('/v6/deployments', {
      params: {
        projectId: VERCEL_PROJECT,
        limit: 1
      }
    });
    const deployments = res.data.deployments || [];
    if (deployments.length === 0) {
      console.warn('⚠️ No deployments found.');
      return null;
    }
    return deployments[0].uid;
  } catch (err) {
    console.error('❌ Error fetching latest deploy ID:', err.response?.data || err.message);
    return null;
  }
}

/** Fetch build logs from Vercel for given deployment ID */
async function fetchBuildLog(deployId) {
  if (!deployId) return 'Ingen forrige deploy.';

  try {
    const res = await vercel.get(`/v3/deployments/${deployId}/events`, {
      params: { limit: -1 }
    });

    // Some responses return { events: [...] }, others just an array
    const events = Array.isArray(res.data) ? res.data : res.data.events || [];

    if (events.length === 0) {
      console.warn(`⚠️ No build events for deploy ${deployId}.`);
      return 'Ingen build-logger funnet.';
    }

    const logs = events
      .filter(e => e?.payload?.text || e?.text)
      .map(e => e.payload?.text || e.text)
      .join('\n');

    return logs.slice(-8000); // last 8k chars
  } catch (err) {
    console.error('❌ Error fetching build log:', err.response?.data || err.message);
    return 'Kunne ikke hente build-logg.';
  }
}

/** Rate-limit-safe ChatGPT call */
async function safeCompletion(opts, retries = 3) {
  try {
    return await openai.chat.completions.create(opts);
  } catch (err) {
    if (retries && err.code === 'rate_limit_exceeded') {
      await new Promise(r => setTimeout(r, 15_000));
      return safeCompletion(opts, retries - 1);
    }
    throw err;
  }
}

// ─────────────── MAIN ───────────────
(async () => {
  // 1) Snapshot repo (max 50 files to control token usage)
  const repoFilesArr = await readFileTree('.', 50);
  const repoFiles = Object.fromEntries(repoFilesArr.map(f => [f.path, f.content]));

  // 2) Latest deploy ID + build log
  const lastDeployId = await fetchLatestDeployId();
  const buildLog = await fetchBuildLog(lastDeployId);

  console.log('📝 lastDeployId:', lastDeployId);
  console.log('🔍 buildLog-preview:', buildLog.slice(0, 400));

  // 3) Prompt to GPT
  const systemPrompt = `
Du er en autonom utvikler for et Next.js PIM-prosjekt.
Du skal:
1. Analysere buildLog for feil og rette dem, ELLER
2. Implementere små, inkrementelle forbedringer når builden er grønn.

Returnér KUN gyldig JSON:
{
  "files": { "<filsti>": "<innhold>" },
  "commitMessage": "<kort beskrivelse>"
}`.trim();

  const userPrompt = JSON.stringify({ files: repoFiles, buildLog });

  if (encode(userPrompt).length > 150_000) {
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
  console.log('🔎 AI-payload:', Object.keys(payload.files));
  if (Object.keys(payload.files).length === 0) {
    console.log('🟡 AI suggested no changes – skipping commit/push.');
    process.exit(0);
  }

  // 5) Write files, commit & push
  writeFiles(payload.files);
  const status = await git.status();
  console.log('🗂️ Git status before commit:', status);

  if (status.modified.length === 0 && status.created.length === 0 && status.deleted.length === 0) {
    console.log('🟡 No changes – skipping commit/push.');
    process.exit(0);
  }

  await git.addConfig('user.name', 'AI Dev Agent');
  await git.addConfig('user.email', 'ai-dev-agent@example.com');
  await git.add(Object.keys(payload.files));
  await git.commit(payload.commitMessage);

  const repoSlug = TARGET_REPO || process.env.GITHUB_REPOSITORY;
  const pushToken = PAT_TOKEN || GITHUB_TOKEN;

  await git.remote([
    'set-url',
    'origin',
    `https://x-access-token:${pushToken}@github.com/${repoSlug}.git`
  ]);
  await git.push('origin', TARGET_BRANCH);

  console.log('✅ New iteration pushed – Vercel building now via Git integration');
})();
