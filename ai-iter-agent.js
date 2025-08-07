// ai-iter-agent.js  -----------------------------------------------
import dotenv from 'dotenv';
dotenv.config();

import OpenAI from 'openai';
import { readFileTree } from './readFileTree.js';
import simpleGit from 'simple-git';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { encode } from 'gpt-3-encoder';   // token-sjekk

// ───────────────────────── ENV ─────────────────────────
const {
  OPENAI_API_KEY,
  VERCEL_TOKEN,
  VERCEL_TEAM_ID,
  VERCEL_PROJECT,
} = process.env;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const git = simpleGit();

// ───────────────────────── HELPERS ─────────────────────────
/** Skriv filer ned på disk fra et "fil → innhold"-objekt */
function writeFiles(fileMap) {
  for (const [file, content] of Object.entries(fileMap)) {
    const full = path.join(process.cwd(), file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

/** Minimal axios-klient mot Vercel v13 */
const vercel = axios.create({
  baseURL: 'https://api.vercel.com',
  headers: { Authorization: `Bearer ${VERCEL_TOKEN}` },
  params: VERCEL_TEAM_ID ? { teamId: VERCEL_TEAM_ID } : {}
});

/** Retry‐hjelper som håndterer 429 / rate limits */
async function safeCompletion(opts, retries = 3) {
  try {
    return await openai.chat.completions.create(opts);
  } catch (err) {
    if (retries && err.code === 'rate_limit_exceeded') {
      const wait = 15_000;
      console.warn(`⏳ Rate-limit – venter ${wait / 1000}s …`);
      await new Promise(r => setTimeout(r, wait));
      return safeCompletion(opts, retries - 1);
    }
    throw err;
  }
}

// ───────────────────────── MAIN LOOP ─────────────────────────
(async () => {
  /* 1) Repo-snapshot (maks 50 filer) */
  const repoFilesArr = await readFileTree('.', 50);
  const repoFiles = Object.fromEntries(repoFilesArr.map(f => [f.path, f.content]));

  /* 2) Forrige deploy-ID (om finnes) */
  let lastDeployId = null;
  if (fs.existsSync('state.json')) {
    ({ lastDeployId } = JSON.parse(fs.readFileSync('state.json', 'utf8')));
  }

  /* 3) Siste Vercel-build-logg */
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
Du er en autonom utvikler for et Next.js PIM-prosjekt. Du skal kjøre små, inkrementelle forbedringer og alltid sørge for at løsningen bygger på Vercel.

Returnér KUN gyldig JSON:
{
  "files":        { "<filsti>": "<nyttInnhold>", ... },
  "commitMessage": "Kort beskrivelse"
}
`.trim();

  const userPrompt = JSON.stringify({ files: repoFiles, buildLog });

  if (encode(userPrompt).length > 150_000) {
    console.error('❌ Prompt for stor – reduser antall filer i readFileTree.');
    process.exit(1);
  }

  const aiRes = await safeCompletion({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.2,
    response_format: { type: 'json_object' }
  });

  /* 5) Parse & valider */
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

  /* 6) Skriv nye/endrede filer */
  writeFiles(payload.files);

  /* 7) Commit & push */
  await git.addConfig('user.name', 'AI Dev Agent');
  await git.addConfig('user.email', 'ai-dev-agent@example.com');
  await git.add(Object.keys(payload.files));
  await git.commit(payload.commitMessage);
  const repoSlug = process.env.GITHUB_REPOSITORY;   // settes automatisk av Actions

  await git.remote([
    'set-url',
    'origin',
    `https://x-access-token:${process.env.GITHUB_TOKEN}@github.com/${repoSlug}.git`
  ]);
  await git.push();

  
  await git.remote([
    'set-url',
    'origin',
    `https://x-access-token:${process.env.GITHUB_TOKEN}@github.com/${repoSlug}.git`
  ]);
  await git.push();

 /* 8) Trigger deploy -------------------------------------------------- */
  let deploy;
  try {
    if (lastDeployId) {
      // 🚀  redeploy previous build
      ({ data: deploy } = await vercel.post(
        `/v13/deployments/${lastDeployId}/redeploy`,
        { target: 'production' }               // body can be empty; target just to be clear
      ));
    } else {
      // 🆕  first (or regular) deploy
      ({ data: deploy } = await vercel.post('/v13/deployments', {
        name:   VERCEL_PROJECT,  // project slug
        files:  [],              // required by schema
        target: 'production'
      }));
    }
  } catch (err) {
    console.error('❌ Vercel-deploy feilet:', err.response?.data || err.message);
    process.exit(1);
  }
  console.log('✅ Ny iterasjon pushet – deploy trigget:', deploy.url);
})();
