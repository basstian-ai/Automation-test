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

/** Fetch build logs for a deployment ID. */
async function fetchBuildLog(deployId) {
  if (!deployId) {
    console.warn('⚠️ No deploy ID provided.');
    return 'Ingen forrige deploy.';
  }

  // Try multiple API versions, starting with the most recent
  const versions = ['v13', 'v3', 'v2']; // Adjust based on Vercel API docs

  for (const version of versions) {
    try {
      const response = await vercel.get(
        `/${version}/deployments/${deployId}/events`,
        {
          params: { limit: 100 }, // Reduced limit to avoid rate-limiting
          headers: {
            Authorization: `Bearer ${process.env.VERCEL_API_TOKEN}`, // Ensure token is set
          },
        }
      );

      const data = response.data;

      // Log response for debugging
      console.log(`API response for version ${version}:`, JSON.stringify(data, null, 2));

      // Check if data is empty or not an array
      if (!Array.isArray(data) || data.length === 0) {
        console.warn(`⚠️ No events found for deploy ${deployId} in version ${version}.`);
        continue; // Try next version
      }

      // Filter and map events to extract logs
      const logs = data
        .filter((event) => event?.payload?.text) // Ensure payload.text exists
        .map((event) => event.payload.text)
        .join('\n');

      if (!logs) {
        console.warn(`⚠️ No valid log content found for deploy ${deployId} in version ${version}.`);
        continue; // Try next version
      }

      return logs.slice(-8000); // Return last 8,000 characters
    } catch (err) {
      const status = err.response?.status;
      const message = err.response?.data?.message ?? err.message;

      console.error(`Error fetching logs for version ${version}:`, { status, message });

      // Handle specific errors
      if (status === 404 || /invalid api version/i.test(message)) {
        continue; // Try next version
      } else if (status === 401 || status === 403) {
        console.error('⚠️ Authentication error. Check VERCEL_API_TOKEN.');
        return 'Autentiseringsfeil ved henting av build-logg.';
      } else if (status === 429) {
        console.error('⚠️ Rate limit exceeded. Try again later.');
        return 'For mange forespørsler. Prøv igjen senere.';
      } else {
        throw err; // Rethrow unexpected errors
      }
    }
  }

  console.warn(`⚠️ Could not fetch build logs for deploy ${deployId} – all versions failed.`);
  return 'Kunne ikke hente build-logg.';
}

/** Hent build-logg for et deployment-uid. */
async function fetchBuildLog(deployId) {
  if (!deployId) return 'Ingen forrige deploy.';

  const versions = ['v3'];              // kjør v3 først …
  // Hvis du MÅ ha fallback:
  // const versions = ['v3', 'v2', 'v1'];

  for (const v of versions) {
    try {
      const { data } = await vercel.get(
        `/${v}/deployments/${deployId}/events`,
        { params: { limit: 2000 } }
      );

      return data
        .filter(e => e.payload?.text)
        .map(e => e.payload.text)
        .join('\n')
        .slice(-8_000);
    } catch (err) {
      const msg = err.response?.data?.message ?? '';
      if (!/invalid api version/i.test(msg)) throw err;  // andre feil → ut
      // ellers: prøv neste versjon i lista
    }
  }

  console.warn('⚠️  Kunne ikke hente build-logg – gir opp.');
  return 'Ingen forrige deploy.';
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
const status = await git.status();
console.log('🗂️  Git-status før commit:', status);

// hvis alt allerede er commit-et → hopp over push
if (status.modified.length === 0 &&
    status.created.length  === 0 &&
    status.deleted.length  === 0) {
  console.log('🟡 Ingen reelle endringer – hopper over commit/push.');
  process.exit(0);
}
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
