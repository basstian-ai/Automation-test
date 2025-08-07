// ai-iter-agent.js  -----------------------------------------------
import dotenv from 'dotenv';
dotenv.config();

import OpenAI from 'openai';
import { readFileTree } from './readFileTree.js';
import simpleGit from 'simple-git';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { encode } from 'gpt-3-encoder';   // token‑sjekk

// ───────────────────────── ENV ─────────────────────────
const {
  PAT_TOKEN,
  GITHUB_TOKEN,           // fallback hvis PAT ikke er satt
  TARGET_REPO,            // owner/repo – f.eks. "basstian-ai/simple-pim-1754492683911"
  TARGET_BRANCH = 'main', // default branch å pushe til
  OPENAI_API_KEY,
  VERCEL_TOKEN,
  VERCEL_TEAM_ID
} = process.env;

// hvilket repo skal pushes til, og med hvilket token?
const repoSlug  = TARGET_REPO || process.env.GITHUB_REPOSITORY;
const isPat     = Boolean(PAT_TOKEN);
const pushToken = isPat ? PAT_TOKEN : GITHUB_TOKEN;

if (!pushToken) {
  console.error('❌ Ingen push‑token funnet (PAT_TOKEN eller GITHUB_TOKEN)');
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const git    = simpleGit();

// ───────────────────────── HELPERS ─────────────────────────
/**
 * Bygger riktig remote‑URL avhengig av om vi bruker PAT eller GitHub Actions‑token.
 *
 *  - PAT   → https://<token>@github.com/owner/repo.git
 *  - GHA‑token → https://x-access-token:<token>@github.com/owner/repo.git
 */
function gitRemoteUrl({ token, repo, isPat }) {
  return isPat
    ? `https://${token}@github.com/${repo}.git`
    : `https://x-access-token:${token}@github.com/${repo}.git`;
}

/** Skriv filer ned på disk fra et "fil → innhold"‑objekt */
function writeFiles(fileMap) {
  for (const [file, content] of Object.entries(fileMap)) {
    const full = path.join(process.cwd(), file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

/** Minimal axios‑klient mot Vercel v13 */
const vercel = axios.create({
  baseURL: 'https://api.vercel.com',
  headers: { Authorization: `Bearer ${VERCEL_TOKEN}` },
  params:  VERCEL_TEAM_ID ? { teamId: VERCEL_TEAM_ID } : {}
});

/** Retry‑hjelper som håndterer 429 / rate limits */
async function safeCompletion(opts, retries = 3) {
  try {
    return await openai.chat.completions.create(opts);
  } catch (err) {
    if (retries && err.code === 'rate_limit_exceeded') {
      const wait = 15_000;
      console.warn(`⏳ Rate‑limit – venter ${wait / 1000}s …`);
      await new Promise(r => setTimeout(r, wait));
      return safeCompletion(opts, retries - 1);
    }
    throw err;
  }
}

// ───────────────────────── MAIN LOOP ─────────────────────────
(async () => {
  /* 1) Repo‑snapshot (maks 50 filer) */
  const repoFilesArr = await readFileTree('.', 50);
  const repoFiles    = Object.fromEntries(repoFilesArr.map(f => [f.path, f.content]));

  /* 2) Finn siste Vercel-deploy (hvis finnes) */
  let lastDeployId = null;
  try {
    const { data } = await vercel.get('/v13/deployments', {
      params: {
        projectId: VERCEL_PROJECT,  // prj_xxx eller slug
        limit: 1,
        order: 'desc'
      }
    });
    lastDeployId = data.deployments?.[0]?.id ?? null;
  } catch (err) {
    console.warn('⚠️  Kunne ikke hente siste deploy-id:', err.response?.data || err.message);
  }

  /* 3) Siste Vercel‑build‑logg */
  let buildLog = 'Ingen forrige deploy.';
  if (lastDeployId) {
    const { data } = await vercel.get(`/v13/deployments/${lastDeployId}/events`, { params: { limit: 200 } });
    buildLog = data
      .filter(e => e.payload?.text)
      .map(e => e.payload.text)
      .join('\n')
      .slice(-8_000); // max 8 k tegn
  }

  /* 4) Prompt → OpenAI */
  const systemPrompt = `
Du er en autonom utvikler for et Next.js PIM‑prosjekt. Du skal kjøre små, inkrementelle forbedringer og alltid sørge for at løsningen er funksjonell og bygger i Vercel.
Du får:
- \"files\": kodebasen som JSON (fil -> innhold)
- \"buildLog\": den siste Vercel‑build‑loggen

Oppgave:
1. Hvis buildLog inneholder en feil, identifiser årsak og fiks.
2. Hvis buildLog er OK, implementer neste viktige, små forbedring/feature.
3. Returnér KUN gyldig JSON:
{
  "files":        { "<filsti>": "<nyttInnhold>", ... },
  "commitMessage": "Kort beskrivelse"
}`.trim();

  const userPrompt = JSON.stringify({ files: repoFiles, buildLog });

  if (encode(userPrompt).length > 150_000) {
    console.error('❌ Prompt for stor – reduser antall filer i readFileTree.');
    process.exit(1);
  }

  const aiRes = await safeCompletion({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt }
    ],
    temperature: 0.2,
    response_format: { type: 'json_object' }
  });

  /* 5) Parse & valider */
  let payload;
  try {
    payload = JSON.parse(aiRes.choices[0].message.content);
  } catch (e) {
    console.error('❌ Kunne ikke parse AI‑responsen:', e);
    process.exit(1);
  }

  if (!payload.files || !payload.commitMessage) {
    console.error('❌ AI‑respons mangler "files" eller "commitMessage"');
    process.exit(1);
  }

  console.log('🔎 AI‑payload:', Object.keys(payload.files));

  /* 6) Skriv nye/endrede filer */
  writeFiles(payload.files);

  /* 7) Commit & push */
  await git.addConfig('user.name',  'AI Dev Agent');
  await git.addConfig('user.email', 'ai-dev-agent@example.com');

  // stage alt (både nye, endrede og slettede filer)
  await git.add(['-A']);
  await git.commit(payload.commitMessage);

  await git.remote([
    'set-url',
    'origin',
    gitRemoteUrl({ token: pushToken, repo: repoSlug, isPat })
  ]);

  await git.push('origin', TARGET_BRANCH);

  /* 8) Ferdig – GitHub‑pushen ovenfor trigger Vercel automatisk */
  console.log('✅ Ny iterasjon pushet – Vercel bygger nå via Git‑integrasjonen');
})();
