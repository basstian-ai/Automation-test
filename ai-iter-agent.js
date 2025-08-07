// ai-iter-agent.js  ---------------------------------------------------------
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
  // ❶ Git / repo
  PAT_TOKEN,
  GITHUB_TOKEN,
  TARGET_REPO,          // f.eks. "org/navn"
  TARGET_BRANCH = 'main',

  // ❷ OpenAI
  OPENAI_API_KEY,

  // ❸ Vercel
  VERCEL_TOKEN,
  VERCEL_TEAM_ID,
  VERCEL_PROJECT,       // prj_xxx…
} = process.env;

const git   = simpleGit();
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ─────────────── Vercel-klient ───────────────
const vercel = axios.create({
  baseURL : 'https://api.vercel.com',
  headers : { Authorization: `Bearer ${VERCEL_TOKEN}` },
  params  : VERCEL_TEAM_ID ? { teamId: VERCEL_TEAM_ID } : {},
});

// ─────────────── Hjelpere ───────────────
function writeFiles(fileMap) {
  for (const [file, content] of Object.entries(fileMap)) {
    const full = path.join(process.cwd(), file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

/** Hent UID til siste deploy for prosjektet via /v6 */
async function fetchLatestDeployId() {
  if (!VERCEL_PROJECT) return null;
  try {
    const { data } = await vercel.get('/v6/deployments', {
      params: {
        projectId: VERCEL_PROJECT, // evt. projectName hvis du foretrekker
        limit    : 1,
      },
    });
    return data.deployments?.[0]?.uid ?? null;
  } catch (err) {
    console.warn('⚠️  Kunne ikke hente siste deploy-id:', err.response?.data || err.message);
    return null;
  }
}

/** Hent build-logg for et deployment-uid via Vercel v6 */
async function fetchBuildLog(deployId) {
  if (!deployId) return 'Ingen forrige deploy.';

  try {
    const { data } = await vercel.get(`/v6/deployments/${deployId}/events`, {
      params: {
        limit: 500           // v6 tillater maks 500
        // ingen "direction"
      }
    });

    return data
      .filter(e => e.payload?.text)
      .map(e => e.payload.text)
      .join('\n')
      .slice(-8_000);        // behold de siste 8 k tegn
  } catch (err) {
    console.warn('⚠️  Kunne ikke hente build-logg:',
                 err.response?.data || err.message);
    return 'Ingen forrige deploy.';
  }
}


/** Rate-limit-safe ChatGPT-kall */
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
  /* 1) Snapshot av repoet (maks 50 filer) */
  const repoFilesArr = await readFileTree('.', 50);
  const repoFiles    = Object.fromEntries(repoFilesArr.map(f => [f.path, f.content]));

  /* 2) Siste deploy-ID + build-logg */
  const lastDeployId = await fetchLatestDeployId();
  const buildLog     = await fetchBuildLog(lastDeployId);

  console.log('📝 lastDeployId:', lastDeployId);
  console.log('🔍 buildLog-preview:', buildLog.slice(0, 400)); // første 400 tegn


  /* 3) Prompt til GPT-4o-mini */
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
    console.error('❌ Prompt for stor – reduser antall filer i readFileTree.');
    process.exit(1);
  }

  const aiRes  = await safeCompletion({
    model: 'gpt-4o-mini',
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt  },
    ],
  });

  /* 4) Parse & valider */
  let payload;
  try {
    payload = JSON.parse(aiRes.choices[0].message.content);
  } catch (e) {
    console.error('❌ Kunne ikke parse AI-responsen:', e);
    process.exit(1);
  }
  if (!payload.files || !payload.commitMessage) {
    console.error('❌ AI-respons mangler "files" eller "commitMessage"');
    process.exit(1);
  }
  console.log('🔎 AI-payload:', Object.keys(payload.files));
  if (Object.keys(payload.files).length === 0) {
    console.log('🟡 AI foreslo ingen endringer – hopper over commit/push.');
    process.exit(0);
  }
  
  /* 5) Skriv filer, commit & push */
  writeFiles(payload.files);

  await git.addConfig('user.name',  'AI Dev Agent');
  await git.addConfig('user.email', 'ai-dev-agent@example.com');
  await git.add(Object.keys(payload.files));
  await git.commit(payload.commitMessage);

  const repoSlug  = TARGET_REPO || process.env.GITHUB_REPOSITORY;
  const pushToken = PAT_TOKEN    || GITHUB_TOKEN;

  await git.remote([
    'set-url',
    'origin',
    `https://x-access-token:${pushToken}@github.com/${repoSlug}.git`,
  ]);
  await git.push('origin', TARGET_BRANCH);

  console.log('✅ Ny iterasjon pushet – Vercel bygger nå via Git-integrasjonen');
})();
