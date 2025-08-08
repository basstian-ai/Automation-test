import OpenAI from "openai";
import { execSync } from "child_process";
import fs from "fs";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const TARGET_REPO = process.env.TARGET_REPO;
const TARGET_BRANCH = process.env.TARGET_BRANCH;

async function run() {
  console.log("📦 Installing dependencies...");
  execSync("npm install", { stdio: "inherit" });

  console.log("🔄 Fetching Vercel build logs...");
  const buildLogs = await getVercelLogs();

  console.log("🤖 Asking AI for iteration...");
  const prompt = `
You are an autonomous senior full-stack developer working on a modern PIM system.
Your goals:
1. Always keep the code deployable after each change.
2. If the last build failed, fix the issue.
3. If the last build passed, implement the next best feature or improvement based on best practices in modern PIM systems.
4. Prioritize features that improve scalability, data model flexibility, and UX for managing products.
5. Do not remove important existing functionality unless absolutely necessary.
6. Return only a valid unified diff (patch) from the current codebase.

Build logs:
${buildLogs}
  `;

  const res = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
  });

  const diff = res.choices[0].message.content.trim();
  fs.writeFileSync("ai_patch.diff", diff);

  console.log("📜 Applying patch...");
  execSync("git apply ai_patch.diff", { stdio: "inherit" });
}

async function getVercelLogs() {
  const fetch = (await import("node-fetch")).default;
  const resp = await fetch(
    `https://api.vercel.com/v13/deployments?projectId=${process.env.VERCEL_PROJECT}&teamId=${process.env.VERCEL_TEAM_ID}`,
    { headers: { Authorization: `Bearer ${process.env.VERCEL_TOKEN}` } }
  );
  const data = await resp.json();
  const latest = data.deployments?.[0]?.uid;
  if (!latest) return "No deployments found.";

  const logResp = await fetch(
    `https://api.vercel.com/v1/deployments/${latest}/events?teamId=${process.env.VERCEL_TEAM_ID}`,
    { headers: { Authorization: `Bearer ${process.env.VERCEL_TOKEN}` } }
  );
  return await logResp.text();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});