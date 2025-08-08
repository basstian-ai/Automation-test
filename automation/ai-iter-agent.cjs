// automation/ai-iter-agent.cjs
// Purpose: keep the loop moving when the model doesn't return a valid diff.
// - Strict diff-only prompting (+ example)
// - Two-pass repair if output isn't a diff
// - Deterministic fallbacks for known Vercel errors (openssl / missing deps)

const fs = require("fs");
const { execSync } = require("child_process");
const fetch = require("node-fetch");

const TARGET_REPO     = process.env.TARGET_REPO;
const TARGET_BRANCH   = process.env.TARGET_BRANCH || "main";
const OPENAI_API_KEY  = process.env.OPENAI_API_KEY;
const VERCEL_TOKEN    = process.env.VERCEL_TOKEN;
const VERCEL_TEAM_ID  = process.env.VERCEL_TEAM_ID;
const VERCEL_PROJECT  = process.env.VERCEL_PROJECT;
const PAT_TOKEN       = process.env.PAT_TOKEN;

function sh(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...opts }).trim();
  } catch (e) {
    return (e.stdout || "").toString() || (e.message || "");
  }
}

function info(msg){ console.log(msg); }
function warn(msg){ console.warn(msg); }
function err (msg){ console.error(msg); }

async function getLatestVercel() {
  info("🔄 Fetching Vercel build logs...");
  try {
    const list = await fetch(
      `https://api.vercel.com/v6/deployments?projectId=${VERCEL_PROJECT}&teamId=${VERCEL_TEAM_ID}&limit=1`,
      { headers: { Authorization: `Bearer ${VERCEL_TOKEN}` } }
    ).then(r => r.json());
    const dep = list?.deployments?.[0];
    if (!dep) return { state: "unknown", logs: "" };

    const events = await fetch(
      `https://api.vercel.com/v3/deployments/${dep.uid}/events?teamId=${VERCEL_TEAM_ID}`,
      { headers: { Authorization: `Bearer ${VERCEL_TOKEN}` } }
    ).then(r => r.text());

    const state = dep.readyState || dep.state || "unknown";
    return { state, logs: events.slice(0, 32000) }; // cap logs
  } catch (e) {
    warn("Vercel logs fetch failed: " + e.message);
    return { state: "unknown", logs: "" };
  }
}

function getRepoContext() {
  const fileList = sh(`git ls-files`).split("\n").slice(0, 400).join("\n");

  // include real content of critical files so diffs line up
  const critical = ["package.json", "next.config.js", "vercel.json"];
  let criticalContents = "";
  for (const f of critical) {
    if (fs.existsSync(f)) {
      criticalContents += `\n--- FILE: ${f} ---\n${fs.readFileSync(f, "utf8")}\n`;
    }
  }
  const lastCommit = sh(`git log -1 --pretty=%B`).trim();
  return { fileList, criticalContents, lastCommit };
}

// Strictly extract first valid unified diff
function extractDiff(text) {
  if (!text) return null;
  const start = text.indexOf("diff --git ");
  if (start === -1) return null;
  let patch = text.slice(start).replace(/```/g, "").trim();
  // must contain at least one file header block
  if (!/^diff --git .+$/m.test(patch)) return null;
  if (!/^--- .+$/m.test(patch) || !/^\+\+\+ .+$/m.test(patch)) {
    // Some models forget the ---/+++ lines; reject
    return null;
  }
  return patch;
}

async function callOpenAI(messages) {
  const body = {
    model: "gpt-4o-mini",
    messages,
    temperature: 0,
    max_tokens: 2000,
    // we want plain text, no JSON
    response_format: { type: "text" }
  };
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  }).then(r => r.json());
  return res.choices?.[0]?.message?.content || "";
}

async function getAIDiff({ mode, logs, ctx }) {
  const exampleUnifiedDiff = `diff --git a/package.json b/package.json
index 1111111..2222222 100644
--- a/package.json
+++ b/package.json
@@ -1,5 +1,6 @@
 {
   "name": "app",
+  "engines": { "node": "16.x" },
   "scripts": {
     "build": "next build"
   }
}`;

  const system = `You are a senior engineer. Output MUST be a valid unified 'git diff' patch that applies with 'git apply'.
- No prose, no markdown fences. Start with 'diff --git'.
- Match CURRENT file contents exactly; only touch lines that must change.
- Prefer small, minimal patches that keep the app deployable.`;

  const user = `Mode: ${mode}
Build logs (truncated):
${logs || "(none)"}

Repository file list (first ~400 files):
${ctx.fileList}

Critical file contents:
${ctx.criticalContents}

Last commit message:
${ctx.lastCommit}

Rules:
- Output ONLY a valid unified diff (no comments, no markdown).
- If you don't need to change package.json, omit it.
- Keep changes minimal and safe.
Here is a tiny EXAMPLE OF FORMAT ONLY (do NOT repeat these exact changes unless needed):
${exampleUnifiedDiff}`;

  // pass 1
  let out = await callOpenAI([
    { role: "system", content: system },
    { role: "user", content: user },
  ]);
  let diff = extractDiff(out);
  if (diff) return diff;

  // repair pass: explicitly ask for diff only
  const repair = `Your previous output was not a valid 'git diff'.
Return ONLY a valid unified diff starting with 'diff --git'. No prose, no code fences.`;
  out = await callOpenAI([
    { role: "system", content: system },
    { role: "user", content: user },
    { role: "user", content: repair },
  ]);
  diff = extractDiff(out);
  return diff;
}

function tryApplyPatch(diffText) {
  fs.writeFileSync("ai_patch.diff", diffText);
  const check = sh("git apply --check ai_patch.diff");
  if (/error:/i.test(check)) return false;
  const apply = sh("git apply ai_patch.diff");
  if (/error:/i.test(apply)) return false;
  return true;
}

// Deterministic fallbacks for the exact failures you've seen repeatedly.
function tryFallbackFix(logs) {
  let changed = false;

  // 1) OpenSSL + Next 10: pin Node 16
  if (/ERR_OSSL|digital envelope routines::unsupported/i.test(logs)) {
    if (fs.existsSync("package.json")) {
      const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
      const before = JSON.stringify(pkg);
      pkg.engines = pkg.engines || {};
      pkg.engines.node = "16.x";
      if (pkg.scripts?.build !== "next build") {
        pkg.scripts = pkg.scripts || {};
        pkg.scripts.build = "next build";
      }
      const after = JSON.stringify(pkg);
      if (before !== after) {
        fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
        changed = true;
      }
    }
  }

  // 2) Missing deps: axios / isomorphic-unfetch
  if (/Can't resolve 'axios'|Module not found:.*axios/i.test(logs)) {
    sh("npm i axios@^1 -S");
    changed = true;
  }
  if (/Can't resolve 'isomorphic-unfetch'|Module not found:.*isomorphic-unfetch/i.test(logs)) {
    sh("npm i isomorphic-unfetch@^3 -S");
    changed = true;
  }

  // If we changed anything, commit it so Vercel rebuilds
  if (changed) {
    sh('git config user.name "AI Dev Agent"');
    sh('git config user.email "github-actions[bot]@users.noreply.github.com"');
    sh("git add -A");
    try { sh('git commit -m "chore: fallback fix from agent"'); } catch {}
    const pushUrl = `https://x-access-token:${PAT_TOKEN}@github.com/${TARGET_REPO}.git`;
    sh(`git push ${pushUrl} ${TARGET_BRANCH}`);
    info("✅ Fallback fix pushed");
    return true;
  }

  return false;
}

function commitAndPush(message) {
  sh('git config user.name "AI Dev Agent"');
  sh('git config user.email "github-actions[bot]@users.noreply.github.com"');
  sh("git add -A");
  try {
    sh(`git commit -m "${message}"`);
  } catch {
    info("ℹ️ No changes to commit");
    return false;
  }
  const pushUrl = `https://x-access-token:${PAT_TOKEN}@github.com/${TARGET_REPO}.git`;
  sh(`git push ${pushUrl} ${TARGET_BRANCH}`);
  info("✅ Changes pushed");
  return true;
}

(async function main() {
  const { state, logs } = await getLatestVercel();
  const failing = /ERROR|FAILED|BUILD_ERROR/i.test(state + " " + logs);
  const mode = failing ? "FIX" : "FEATURE";
  info(`🔍 Mode: ${mode} (Vercel state: ${state})`);

  // Always have deps installed to let model add imports if needed
  sh("npm ci || npm i");

  const ctx = getRepoContext();

  // 1) Ask AI for a diff
  let diff = await getAIDiff({ mode, logs, ctx });

  if (diff) {
    const applied = tryApplyPatch(diff);
    if (applied) {
      commitAndPush(mode === "FIX" ? "fix: AI build repair" : "feat: AI improvement");
      return;
    }
    warn("⚠️ AI diff failed to apply, attempting fallback logic…");
  } else {
    warn("⚠️ No valid patch from AI, attempting fallback logic…");
  }

  // 2) Fallbacks for known failures (keeps the loop moving)
  const fallbackDone = tryFallbackFix(logs || "");
  if (fallbackDone) return;

  info("⏭️ Skipping: still no valid change to apply.");
})();