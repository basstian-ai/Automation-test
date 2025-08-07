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
  // ❶ Git / repo
  PAT_TOKEN,
  GITHUB_TOKEN,
  TARGET_REPO,          // e.g., "org/navn"
  TARGET_BRANCH = 'main',

  // ❷ OpenAI
  OPENAI_API_KEY,

  // ❸ Vercel
  VERCEL_TOKEN,
  VERCEL_TEAM_ID,
  VERCEL_PROJECT,       // prj_xxx…
} = process.env;

const git = simpleGit();
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ─────────────── Vercel Client ───────────────
const vercel = axios.create({
  baseURL: 'https://api.vercel.com',
  headers: { Authorization: `Bearer ${VERCEL_TOKEN}` },
  params: VERCEL_TEAM_ID ? { teamId: VERCEL_TEAM_ID } : {},
});

// ─────────────── Helpers ───────────────
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
            Authorization: `Bearer ${VERCEL_TOKEN}`, // Use VERCEL_TOKEN directly
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
        .filter((event) => event?.payload?.text)
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
        console.error('⚠️ Authentication error. Check VERCEL_TOKEN.');
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

/** Rate-limit-safe ChatGPT call */
async function safeCompletion(opts, retries = 3) {
  try {
    return await openai.chat.completions.create(opts);
  } catch (err) {
    if (retries && err.code === 'rate_limit_exceeded') {
      await new Promise((r) => setTimeout(r, 15_000));
      return safeCompletion(opts, retries - 1);
    }
    throw err;
  }
}

/** Fetch the latest deployment ID */
async function fetchLatestDeployId() {
  try {
    const response = await vercel.get('/v13/now/deployments', {
      params: {
        projectId: VERCEL_PROJECT,
        limit: 1,
      },
    });
    const deployments = response.data.deployments;
    return deployments.length > 0 ? deployments[0].uid : null;
  } catch (err) {
    console.error('Error fetching latest deploy ID:', err.message);
    return null;
  }
}

// ─────────────── MAIN ───────────────
(async () => {
  /* 1) Snapshot of the repo (max 50 files) */
  const repoFilesArr = await readFileTree('.', 50);
  const repoFiles = Object.fromEntries(repoFilesArr.map((f) => [f.path, f.content]));

  /* 2) Latest deploy ID + build log */
  const lastDeployId = await fetchLatestDeployId();
  const buildLog = await fetchBuildLog(lastDeployId);

  console.log('📝 lastDeployId:', lastDeployId);
  console.log('🔍 buildLog-preview:', buildLog.slice(0, 400)); // First 400 characters

  /* 3) Prompt to GPT-4o-mini */
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
    console.error('❌ Prompt too large – reduce number of files in readFileTree.');
    process.exit(1);
  }

  const aiRes = await safeCompletion({
    model: 'gpt-4o-mini',
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  });

  /* 4) Parse & validate */
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

  /* 5) Write files, commit & push */
  writeFiles(payload.files);
  const status = await git.status();
  console.log('🗂️ Git status before commit:', status);

  // If nothing to commit, skip push
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
    `https://x-access-token:${pushToken}@github.com/${repoSlug}.git`,
  ]);
  await git.push('origin', TARGET_BRANCH);

  console.log('✅ New iteration pushed – Vercel building now via Git integration');
})();
