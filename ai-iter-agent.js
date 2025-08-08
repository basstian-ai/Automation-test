import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * List all files recursively
 */
function listFilesRecursive(dir) {
  let results = [];
  fs.readdirSync(dir).forEach(file => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      results = results.concat(listFilesRecursive(filePath));
    } else {
      results.push(filePath);
    }
  });
  return results;
}

/**
 * Filter files to keep token count low
 */
function filterRelevantFiles(files, logs) {
  const relevant = new Set();

  // Match filenames from build logs
  logs.split("\n").forEach(line => {
    const match = line.match(/([a-zA-Z0-9_\-/]+\.(js|ts|tsx|jsx))/);
    if (match) {
      relevant.add(match[1]);
    }
  });

  // Always include some critical files
  const alwaysInclude = [
    "package.json",
    "next.config.js",
    "pages/_app.js",
    "pages/index.js",
    "components/"
  ];

  return files.filter(file => {
    if (alwaysInclude.some(p => file.includes(p))) return true;
    return [...relevant].some(r => file.includes(r));
  });
}

/**
 * Get Vercel build logs
 */
function fetchVercelLogs() {
  try {
    const project = process.env.VERCEL_PROJECT;
    const teamId = process.env.VERCEL_TEAM_ID;
    const token = process.env.VERCEL_TOKEN;

    const deployments = execSync(
      `curl -s -H "Authorization: Bearer ${token}" "https://api.vercel.com/v6/deployments?projectId=${project}&teamId=${teamId}&limit=1"`
    ).toString();

    const latest = JSON.parse(deployments).deployments?.[0];
    if (!latest) return "";

    const logs = execSync(
      `curl -s -H "Authorization: Bearer ${token}" "https://api.vercel.com/v2/deployments/${latest.uid}/events?teamId=${teamId}"`
    ).toString();

    return logs;
  } catch (err) {
    console.error("Failed to fetch Vercel logs", err);
    return "";
  }
}

/**
 * Run local build
 */
function runLocalBuild() {
  try {
    execSync("npm install", { stdio: "inherit" });
    execSync("npm run build", { stdio: "pipe" });
    return { success: true, logs: "" };
  } catch (err) {
    return { success: false, logs: err.stdout?.toString() || err.message };
  }
}

/**
 * Ask OpenAI for changes
 */
async function askAI(buildSuccess, logs, files) {
  const prompt = `
The following JavaScript/TypeScript/Next.js project is a Product Information Management (PIM) system.

Build status: ${buildSuccess ? "SUCCESS" : "FAILURE"}
${
  buildSuccess
    ? "Since build succeeded, add or improve a meaningful feature for the PIM."
    : "The build failed. Fix it based on the logs."
}

Build logs:
${logs}

Relevant code files:
${files
  .map(
    f =>
      `// FILE: ${path.relative(".", f)}\n${fs.readFileSync(f, "utf8").slice(0, 4000)}`
  )
  .join("\n\n")}
`;

  const response = await client.chat.completions.create({
    model: "gpt-4.1",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2
  });

  return response.choices[0].message.content;
}

/**
 * Apply AI changes automatically
 */
function applyChanges(aiResponse) {
  const matches = aiResponse.match(
    /```(?:\w+\n)?([\s\S]*?)```/g
  );
  if (!matches) return false;

  matches.forEach(block => {
    const content = block.replace(/```[\w]*\n?/, "").replace(/```$/, "");
    // Look for FILE: marker
    const fileMatch = content.match(/\/\/ FILE: (.+)\n/);
    if (fileMatch) {
      const filePath = fileMatch[1].trim();
      const code = content.replace(/\/\/ FILE: .+\n/, "");
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, code, "utf8");
      console.log(`✅ Updated ${filePath}`);
    }
  });

  return true;
}

/**
 * Main autonomous loop
 */
async function main() {
  execSync(`git pull origin ${process.env.TARGET_BRANCH}`, { stdio: "inherit" });

  const vercelLogs = fetchVercelLogs();
  const buildResult = runLocalBuild();

  const allFiles = listFilesRecursive("./");
  const relevantFiles = filterRelevantFiles(allFiles, buildResult.logs || vercelLogs);

  const aiResponse = await askAI(buildResult.success, buildResult.logs || vercelLogs, relevantFiles);

  const updated = applyChanges(aiResponse);
  if (updated) {
    execSync("git add .");
    execSync(`git commit -m "AI iteration update" || echo "No changes to commit"`, { stdio: "inherit" });
    execSync(`git push origin ${process.env.TARGET_BRANCH}`, { stdio: "inherit" });
  }
}

main().catch(err => {
  console.error("❌ Agent failed", err);
  process.exit(1);
});