import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import OpenAI from "openai";

const TARGET_DIR = path.resolve("target");
const MODEL = "gpt-4.1";

// Helper to run shell commands
function run(cmd, cwd = TARGET_DIR) {
  console.log(`\n$ ${cmd}`);
  return execSync(cmd, { cwd, stdio: "inherit" });
}

// Read build logs from local npm build + Vercel
async function getBuildLogs() {
  let localLogs = "";
  try {
    run("npm install");
    run("npm run build");
    localLogs = "✅ Local build successful";
  } catch (err) {
    localLogs = "❌ Local build failed:\n" + err.toString().slice(0, 8000);
  }
  return localLogs;
}

// Ask AI what to do next
async function getAIPlan(logs) {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const prompt = `
You are an autonomous AI developer improving a modern PIM system.
The repo is located in ./target.
Follow these rules:
- If build fails, fix it.
- If build passes, implement a new useful feature or enhancement based on best practices in modern PIM systems (search, product onboarding, data enrichment, API performance, admin UX, etc).
- Code must be clean, documented, and production ready.
- Ensure repo stays deployable after each iteration.

Build logs:
${logs}
`;

  const res = await client.responses.create({
    model: MODEL,
    input: prompt,
    temperature: 0.5
  });

  return res.output_text;
}

// Apply AI changes
function applyChanges(codeDiff) {
  const tempFile = path.join(TARGET_DIR, "ai_patch.diff");
  fs.writeFileSync(tempFile, codeDiff);
  try {
    run(`git apply ai_patch.diff`);
  } catch {
    console.warn("Patch failed, skipping apply.");
  }
  fs.unlinkSync(tempFile);
}

async function main() {
  console.log("🔄 Fetching build logs...");
  const logs = await getBuildLogs();

  console.log("🧠 Asking AI for next iteration...");
  const plan = await getAIPlan(logs);
  console.log("\n=== AI PLAN ===\n", plan);

  if (plan.includes("diff --git")) {
    console.log("📦 Applying AI patch...");
    applyChanges(plan);
  } else {
    console.log("⚠️ No patch found in AI output");
  }
}

main();