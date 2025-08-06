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
        content: 'Du er en erfaren fullstack-utvikler som lager produksjonsklar Next.js-applikasjon. Du returnerer kun gyldig kode.'
      },
      {
        role: 'user',
        content: prompt
      }
    ]
  });

  return response.choices[0].message.content;
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
  const prompt = 'Lag en enkel Next.js PIM-applikasjon hvor man kan legge inn produktinformasjon (navn, beskrivelse, pris) og vise dette på en produktside. Ingen database – bruk lokal JSON-fil for lagring.';
  const dirPath = path.join(process.cwd(), repoName);

  if (fs.existsSync(dirPath)) {
    console.warn(`⚠️ Mappen ${repoName} finnes allerede. Sletter og starter på nytt.`);
    fs.rmSync(dirPath, { recursive: true });
  }

  fs.mkdirSync(dirPath);

  console.log('🚀 Genererer kode med OpenAI...');
  const code = await generateCode(prompt);

  fs.writeFileSync(`${dirPath}/README.md`, `# ${repoName}\n\n${prompt}`);
  fs.writeFileSync(`${dirPath}/index.js`, code);

  const git = simpleGit();
  await git.cwd(repoName);
  await git.init();
  await git.checkoutLocalBranch('main');
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

