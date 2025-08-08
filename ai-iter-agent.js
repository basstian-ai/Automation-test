import { execSync, spawnSync } from "child_process";
import fs from "fs";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function run(cmd) {
  try {
    return execSync(cmd, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function fetchVercelLogs() {
  console.log("🔄 Fetching build logs...");
  try {
    const deployments = JSON.parse(run(
      `curl -s -H "Authorization: Bearer ${process.env.VERCEL_TOKEN}" "https://api.vercel.com/v6/deployments?projectId=${process.env.VERCEL_PROJECT}&teamId=${process.env.VERCEL_TEAM_ID}&limit=1"`
    ));
    const id = deployments.deployments?.[0]?.uid;
    if (!id) return { status: "unknown", logs: "" };

    const deployment = JSON.parse(run(
      `curl -s -H "Authorization: Bearer ${process.env.VERCEL_TOKEN}" "https://api.vercel.com/v13/deployments/${id}"`
    ));

    const state = deployment.readyState;
    const logs = run(
      `curl -s -H "Authorization: Bearer ${process.env.VERCEL_TOKEN}" "https://api.vercel.com/v3/deployments/${id}/events"`
    );

    return { status: state, logs };
  } catch (e) {
    return { status: "error", logs: e.toString() };
  }
}

function validatePatch(patch) {
  return patch.startsWith("diff --git");
}

function applyAndPush(patch) {
  fs.writeFileSync("patch.diff", patch);
  run("git config user.email 'dev-agent@github.com'");
  run("git config user.name 'AI Dev Agent'");
  run("git apply patch.diff || git apply --reject --whitespace=fix patch.diff");
  run("git add .");
  try {
    run(`git commit -m "AI iteration update"`);
    run(`git push https://${process.env.PAT_TOKEN}@github.com/${process.env.TARGET_REPO}.git ${process.env.TARGET_BRANCH}`);
    console.log("✅ Changes pushed");
  } catch {
    console.log("⚠️ No changes to commit");
  }
}

async function main() {
  const { status, logs } = fetchVercelLogs();
  const mode = status === "ERROR" || status === "FAILED" ? "fix" : "improve";

  console.log(`🔍 Mode: ${mode.toUpperCase()}`);

  const repoTree = run("find . -type f -not -path './.git/*' -maxdepth 3");
  const lastCommit = run("git log -1 --pretty=%B");

  const prompt = `
You are an autonomous software improvement agent.

If build failed: fix the build error using the logs.
If build succeeded: choose and implement the next most valuable improvement or feature for this PIM system, based on modern best practices.

Build status: ${status}
Build logs:
${logs}

Repository structure:
${repoTree}

Last commit message:
${lastCommit}

Rules:
- Output ONLY a unified diff starting with "diff --git"
- No explanations, no markdown
`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "system", content: prompt }],
    temperature: 0,
  });

  const patch = response.choices[0].message.content.trim();

  if (validatePatch(patch)) {
    applyAndPush(patch);
  } else {
    console.log("❌ Invalid patch from AI");
  }
}

main();