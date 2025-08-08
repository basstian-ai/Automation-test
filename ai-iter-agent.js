#!/usr/bin/env node
import fs from "fs";
import { execSync } from "child_process";
import OpenAI from "openai";

// tiny helper to run shell
function sh(cmd, opts = {}) {
  console.log(`$ ${cmd}`);
  return execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...opts }).toString();
}

const env = process.env;
const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

async function fetchVercelLogs() {
  console.log("🔄 Fetching Vercel build logs...");
  try {
    const list = sh(`curl -s -H "Authorization: Bearer ${env.VERCEL_TOKEN}" "https://api.vercel.com/v6/deployments?projectId=${env.VERCEL_PROJECT}&teamId=${env.VERCEL_TEAM_ID}&limit=1"`);
    const json = JSON.parse(list);
    const dep = json.deployments?.[0];
    if (!dep) return { state: "unknown", logs: "" };

    const state = dep.readyState || dep.state || "unknown";
    const events = sh(`curl -s -H "Authorization: Bearer ${env.VERCEL_TOKEN}" "https://api.vercel.com/v3/deployments/${dep.uid}/events?teamId=${env.VERCEL_TEAM_ID}"`);
    return { state, logs: events.slice(0, 30000) }; // guard against token bloat
  } catch (e) {
    console.log("⚠️ Vercel logs fetch failed:", e.message);
    return { state: "unknown", logs: "" };
  }
}

function repoContext() {
  // keep context small-ish to avoid token spikes
  const files = sh(`git ls-files`).split("\n").slice(0, 400).join("\n"); // cap to 400 files
  const lastCommit = sh(`git log -1 --pretty=%B`).trim();
  return { files, lastCommit };
}

function extractCleanDiff(text) {
  const i = text.indexOf("diff --git");
  if (i < 0) return null;
  // strip any backticks or markdown fence junk
  let patch = text.slice(i).replace(/```/g, "").trim();
  // quick sanity check: must contain at least one file header
  if (!/^diff --git .+/m.test(patch)) return null;
  return patch;
}

function tryApplyPatch(patchText) {
  fs.writeFileSync("ai_patch.diff", patchText);
  try {
    sh("git apply --check ai_patch.diff", { stdio: "inherit" });
  } catch {
    return false;
  }
  try {
    sh("git apply ai_patch.diff", { stdio: "inherit" });
    return true;
  } catch {
    return false;
  }
}

async function askAI(mode, logs, ctx) {
  const system = `You are an autonomous software engineer improving a modern PIM (Next.js) codebase.
Rules:
- If build is failing (mode=FIX): produce the minimal changes to make the build succeed on Vercel.
- If build is passing (mode=IMPROVE): implement a small, valuable PIM improvement (e.g., fix warnings, add missing deps, small feature, tighten types, improve API route).
- Output ONLY a valid unified git diff that applies with \`git apply\`.
- No explanations, no markdown, no backticks.
- Start with "diff --git".
- Keep diffs small but complete.`;

  const user = `Mode: ${mode}
Build logs (possibly truncated):
${logs || "(none)"}

Repository files (first ~400):
${ctx.files}

Last commit message:
${ctx.lastCommit}

Produce a unified diff to either fix the build or implement a small improvement (ensure repo remains deployable).`;

  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.1,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ]
  });

  return res.choices?.[0]?.message?.content || "";
}

async function main() {
  // 1) Ensure node modules exist in target
  try { sh("npm ci || npm i"); } catch {}

  // 2) Get vercel status & mode
  const { state, logs } = await fetchVercelLogs();
  const mode = /ERROR|FAILED|ERROR_BUILD|BUILD_ERROR/i.test(state + " " + logs) ? "FIX" : "IMPROVE";
  console.log(`🔍 Mode: ${mode} (Vercel state: ${state})`);

  // 3) Repo context
  const ctx = repoContext();

  // 4) Ask AI for a patch with retries
  let patch = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`🤖 Generating patch (attempt ${attempt})...`);
    const out = await askAI(mode, logs, ctx);
    const clean = extractCleanDiff(out || "");
    if (!clean) {
      console.log("⚠️ AI did not return a valid unified diff. Retrying…");
      continue;
    }
    if (tryApplyPatch(clean)) {
      patch = clean;
      break;
    } else {
      console.log("⚠️ Patch failed to apply. Retrying…");
    }
  }

  if (!patch) {
    console.log("⏭️ Skipping: no valid patch after 3 attempts.");
    return;
  }

  // 5) Commit & push via PAT (avoid github-actions[bot] 403)
  sh('git config user.name "AI Dev Agent"');
  sh('git config user.email "github-actions[bot]@users.noreply.github.com"');
  const hasChanges = sh("git status --porcelain");
  if (!hasChanges) {
    console.log("ℹ️ No changes to commit after applying patch.");
    return;
  }
  sh('git commit -m "AI iteration update"');
  const pushUrl = `https://${env.PAT_TOKEN}@github.com/${env.TARGET_REPO}.git`;
  sh(`git push ${pushUrl} ${env.TARGET_BRANCH}`);
  console.log("✅ Changes pushed");
}

main().catch((e) => {
  console.error("Fatal agent error:", e.message);
  process.exit(1);
});