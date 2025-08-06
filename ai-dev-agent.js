import OpenAI from 'openai';
import axios from 'axios';
import simpleGit from 'simple-git';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config();

const {
  OPENAI_API_KEY,
  PERSONAL_ACCESS_TOKEN,
  GH_USERNAME,
  VERCEL_TOKEN,
  VERCEL_TEAM_ID
} = process.env;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

async function generateCode(prompt) {
  const response = await openai.chat.completions.create({
    model: 'gpt-4',
    messages: [
      {
        role: 'system',
        content: 'Du er en erfaren fullstack-utvikler som lager produksjonsklar Next.js-applikasjon. Returner KUN et gyldig JSON-objekt uten kodeblokker (ingen ```), uten forklarende tekst eller kommentarer. N\u00f8kler skal v\u00e6re filbaner og verdier skal v\u00e6re filinnhold.'
      },
      {
        role: 'user',
        content: prompt
      }
    ]
  });

  return response.choices[0].message.content;
}

function tryParseJSON(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    const cleaned = raw
      .replace(/^```(?:json)?/, '')
      .replace(/```$/, '')
      .replace(/^[\s\S]*?\{/, '{')
      .replace(/\}[\s\S]*$/, '}');
    return JSON.parse(cleaned);
  }
}

async function createRepo(repoName) {
  try {
    const res = await axios.post(
      'https://api.github.com/user/repos',
      {
        name: repoName,
        private: false
      },
      {
        headers: {
          Authorization: `token ${PERSONAL_ACCESS_TOKEN}`
        }
      }
    );
    return res.data.clone_url;
  } catch (err) {
    console.error('❌ Feil ved opprettelse av GitHub-repo:');
    console.error(err.response?.data || err.message);
    process.exit(1);
  }
}

async function deployToVercel(projectName) {
  try {
    const res = await axios.post(
      'https://api.vercel.com/v9/projects',
      {
        name: projectName,
        framework: 'nextjs',
        gitRepository: {
          type: 'github',
          repo: `${GH_USERNAME}/${projectName}`
        },
        buildCommand: 'npm run build',
        outputDirectory: 'out',
        installCommand: 'npm install',
        rootDirectory: null,
        devCommand: 'npm run dev'
      },
      {
        headers: {
          Authorization: `Bearer ${VERCEL_TOKEN}`,
          'Content-Type': 'application/json'
        },
        params: {
          teamId: VERCEL_TEAM_ID
        }
      }
    );
    return res.data;
  } catch (err) {
    console.error('❌ Feil ved deploy til Vercel:');
    console.error(err.response?.data || err.message);
    process.exit(1);
  }
}

async function main() {
  const timestamp = Date.now();
  const repoName = `simple-pim-${timestamp}`;
  const prompt = `
Returner KUN et gyldig JSON-objekt uten kodeblokker (ingen \`\`\`), ingen forklarende tekst eller kommentarer. Objektets nøkler skal være filbaner og verdiene filinnhold.
Eksempel:
{
  "pages/index.js": "// next.js komponent",
  "package.json": "{...}"
}

Lag en enkel Next.js PIM-applikasjon hvor man kan:
- legge inn produktdata (navn, beskrivelse, pris)
- vise produktene offentlig
- lagre data i lokal JSON-fil (ingen database)
Inkluder filer som:
- pages/index.js
- pages/admin.js
- pages/api/products/index.js
- data/products.json (tom array)
- .gitignore
- package.json
`;

  const dirPath = path.join(process.cwd(), repoName);

  if (fs.existsSync(dirPath)) {
    console.warn(`⚠️ Mappen ${repoName} finnes allerede. Sletter og starter på nytt.`);
    fs.rmSync(dirPath, { recursive: true });
  }

  fs.mkdirSync(dirPath);

  console.log('🚀 Genererer kode med OpenAI...');
  const rawOutput = await generateCode(prompt);

  let files;
  try {
    files = tryParseJSON(rawOutput);
  } catch (err) {
    console.error('🧨 Klarte ikke å parse OpenAI-respons som JSON.');
    fs.writeFileSync(`${dirPath}/openai-output.txt`, rawOutput);
    process.exit(1);
  }

  if (typeof files !== 'object' || files === null || Array.isArray(files)) {
    console.error('🧨 Responsen fra OpenAI er ikke et gyldig JSON-objekt.');
    fs.writeFileSync(`${dirPath}/openai-output.txt`, rawOutput);
    process.exit(1);
  }

  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = path.join(dirPath, filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }

  fs.writeFileSync(`${dirPath}/README.md`, `# ${repoName}\n\n${prompt}`);

  const git = simpleGit();
  await git.cwd(repoName);
  await git.init();
  await git.checkoutLocalBranch('main');
  await git.addConfig('user.name', 'AI Dev Agent');
  await git.addConfig('user.email', 'ai-dev-agent@example.com');
  await git.add('.');
  await git.commit('Initial commit');

  console.log('📦 Oppretter GitHub-repo...');
  const cloneUrl = await createRepo(repoName);
  const remoteUrlWithAuth = cloneUrl.replace(
    'https://',
    `https://${GH_USERNAME}:${PERSONAL_ACCESS_TOKEN}@`
  );
  await git.addRemote('origin', remoteUrlWithAuth);
  await git.push('origin', 'main');

  console.log('🌐 Trigger deploy på Vercel...');
  await deployToVercel(repoName);

  console.log('\n✅ Ferdig!');
  console.log(`🔗 GitHub: https://github.com/${GH_USERNAME}/${repoName}`);
  console.log(`🔗 Vercel: https://vercel.com/${VERCEL_TEAM_ID}/${repoName}`);
}

main().catch((err) => {
  console.error('❌ Uventet feil:', err);
});
