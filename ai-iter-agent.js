// ai-iter-agent.js  -----------------------------------------------
import OpenAI from 'openai';
import simpleGit from 'simple-git';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

// ───────────────────────── ENV ─────────────────────────
const {
  OPENAI_API_KEY,
  PERSONAL_ACCESS_TOKEN,
  GH_USERNAME,
  VERCEL_TOKEN,
  VERCEL_TEAM_ID,
  VERCEL_PROJECT,        // f.eks. "simple-pim-123..."
} = process.env;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const git = simpleGit();

// ───────────────────────── HELPERS ─────────────────────────
const readAllFiles = (dir, base = '') => {
  let map = {};
  for (const entry of fs.readdirSync(dir)) {
    const p = path.join(dir, entry);
    const rel = path.join(base, entry);
    if (fs.statSync(p).isDirectory()) {
      map = { ...map, ...readAllFiles(p, rel) };
    } else {
      map[rel] = fs.readFileSync(p, 'utf8');
    }
  }
  return map;
};

const writeFiles = (fileMap) => {
  for (const [file, content] of Object.entries(fileMap)) {
    const full = path.join(process.cwd(), file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
};

const vercel = axios.create({
  baseURL: 'https://api.vercel.com',
  headers: { Authorization: `Bearer ${VERCEL_TOKEN}` },
  params: VERCEL_TEAM_ID ? { teamId: VERCEL_TEAM_ID } : {},
});

// ───────────────────────── MAIN LOOP ─────────────────────────
(async () => {
  // 1) repo snapshot
  const repoFiles = readAllFiles(process.cwd());
  const codeBlob = JSON.stringify(repoFiles);

  // 2) hent forrige deploy-ID
  let lastDeployId = null;
  if (fs.existsSync('state.json')) {
    lastDeployId = JSON.parse(fs.readFileSync('state.json', 'utf8')).lastDeployId;
  }

  // 3) hent build-logg (hvis forrige deploy finnes)
  let buildLog = 'Ingen forrige deploy.';
  if (lastDeployId) {
    const { data } = await vercel.get(`/v13/deployments/${lastDeployId}/events`, {
      params: { limit: 200 },
    });
    buildLog = data
      .filter((e) => e.payload?.text)
      .map((e) => e.payload.text)
      .join('\n')
      .slice(-8000); // kutt til maks 8k tegn
  }

  // 4) bygg prompt
  const systemPrompt = `
Du er en autonom udvikler for et Next.js PIM-prosjekt. 
Du får:
- "files": hele kodebasen som JSON (fil -> innhold)
- "buildLog": den siste Vercel-build-loggen

Oppgave:
1. Hvis buildLog inneholder en feil, identifiser årsak og fiks.
2. Hvis buildLog er OK, implementer neste viktige, små forbedring/feature.
3. Returnér KUN gyldig JSON:
{
  "files": { "<filsti>": "<nyttInnhold>", ... },
  "commitMessage": "Kort beskrivelse"
}`;

  const userPrompt = JSON.stringify({ files: repoFiles, buildLog });

  const aiRes = await openai.chat.completions.create({
    model: 'gpt-4o-mini',          // evt. gpt-4o eller gpt-4o-128k
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.2,
    response_format: { type: 'json_object' },
  });

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

  // 5) skriv filer
  writeFiles(payload.files);

  // 6) commit & push
  await git.addConfig('user.name', 'AI Dev Agent');
  await git.addConfig('user.email', 'ai-dev-agent@example.com');
  await git.add(Object.keys(payload.files));
  await git.commit(payload.commitMessage);
  await git.push();

  // 7) trigger ny deploy (via Vercel API)
  const { data: deploy } = await vercel.post('/v13/deployments', {
    name: VERCEL_PROJECT,
    gitSource: { type: 'github', repoId: `${GH_USERNAME}/${VERCEL_PROJECT}`, ref: 'main' },
  });

  // 8) lagre state
  fs.writeFileSync('state.json', JSON.stringify({ lastDeployId: deploy.id }, null, 2));

  console.log('✅ Ny iterasjon pushet og deploy trigget:', deploy.url);
})();
