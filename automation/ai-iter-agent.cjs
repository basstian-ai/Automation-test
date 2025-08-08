// automation/ai-iter-agent.cjs
// Self-iterating dev agent that fixes red builds first, then ships small features.

const fs = require("fs");
const { execSync } = require("child_process");
const fetch = require("node-fetch");

// ---------- ENV ----------
const TARGET_REPO    = process.env.TARGET_REPO;                 // e.g. basstian-ai/simple-pim-1754492683911
const TARGET_BRANCH  = (process.env.TARGET_BRANCH || "main").trim();
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const VERCEL_TOKEN   = process.env.VERCEL_TOKEN;
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID;
const VERCEL_PROJECT = process.env.VERCEL_PROJECT;
const PAT_TOKEN      = process.env.PAT_TOKEN;

if (!TARGET_REPO || !OPENAI_API_KEY || !PAT_TOKEN) {
  console.error("❌ Missing required env: TARGET_REPO, OPENAI_API_KEY, PAT_TOKEN (and Vercel vars for log fetch).");
  process.exit(1);
}

// ---------- UTIL ----------
function sh(cmd, opts = {}) {
  try {
    console.log(`$ ${cmd}`);
    return execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...opts }).trim();
  } catch (e) {
    const out = (e.stdout || "").toString();
    const err = (e.stderr || "").toString();
    if (out) console.log(out);
    if (err) console.log(err);
    throw e;
  }
}
function trySh(cmd, opts = {}) {
  try { return sh(cmd, opts); } catch { return ""; }
}
const info = (m)=>console.log(m);
const warn = (m)=>console.warn(m);

// ---------- DIAGNOSTICS ----------
(function bootstrapLog() {
  console.log("📂 CWD:", process.cwd());
  console.log("🔗 Remotes:\n" + trySh("git remote -v"));
  console.log("🌿 Branch:", trySh("git rev-parse --abbrev-ref HEAD") || "(unknown)");
  console.log("🎯 Target:", TARGET_REPO, "@", TARGET_BRANCH);
})();

// ---------- VERCEL ----------
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
    return { state, logs: (events || "").slice(0, 32000) };
  } catch (e) {
    warn("⚠️ Vercel fetch failed: " + e.message);
    return { state: "unknown", logs: "" };
  }
}

// ---------- REPO CONTEXT ----------
function getRepoContext() {
  const files = trySh(`git ls-files`).split("\n").slice(0, 400).join("\n");
  const critical = ["package.json", "next.config.js", "vercel.json"];
  let criticalContents = "";
  for (const f of critical) {
    if (fs.existsSync(f)) {
      criticalContents += `\n--- FILE: ${f} ---\n${fs.readFileSync(f, "utf8")}\n`;
    }
  }
  const lastCommit = trySh(`git log -1 --pretty=%B`).trim();
  return { files, criticalContents, lastCommit };
}

// ---------- AI ----------
function extractDiff(text) {
  if (!text) return null;
  const start = text.indexOf("diff --git ");
  if (start === -1) return null;
  const out = text.slice(start).replace(/```/g, "").trim();
  if (!/^diff --git .+$/m.test(out)) return null;
  if (!/^--- .+$/m.test(out) || !/^\+\+\+ .+$/m.test(out)) return null;
  return out;
}
async function openaiChat(messages) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o-mini", temperature: 0, messages }),
  }).then(r => r.json());
  return res.choices?.[0]?.message?.content || "";
}
async function getAIDiff({ mode, logs, ctx }) {
  const system = `You are a senior engineer. Output MUST be a valid unified 'git diff' that applies with 'git apply'.
- No prose, no markdown fences. Start with 'diff --git'.
- Match CURRENT file contents exactly; only change necessary lines.
- Keep patches minimal and keep the app deployable.`;

  const example = `diff --git a/package.json b/package.json
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

  const user = `Mode: ${mode}
Build logs (truncated):
${logs || "(none)"}

Repository files (first ~400):
${ctx.files}

Critical file contents:
${ctx.criticalContents}

Last commit message:
${ctx.lastCommit}

Rules:
- Output ONLY a valid unified diff (no comments/markdown).
- If package.json does not require changes, omit it.
- For FIX mode: focus solely on build errors shown.
- For FEATURE mode: implement a small, safe improvement for a modern PIM (search UX, API robustness, types, tests).
FORMAT EXAMPLE ONLY (do not repeat unless needed):
${example}`;

  // pass 1
  let out = await openaiChat([{ role: "system", content: system }, { role: "user", content: user }]);
  let diff = extractDiff(out);
  if (diff) return diff;

  // repair pass
  const repair = `Your previous output was not a valid 'git diff'. Return ONLY a unified diff starting with 'diff --git'.`;
  out = await openaiChat([
    { role: "system", content: system },
    { role: "user", content: user },
    { role: "user", content: repair },
  ]);
  diff = extractDiff(out);
  return diff;
}

// ---------- PATCH/COMMIT/PUSH ----------
function tryApplyPatch(diffText) {
  fs.writeFileSync("ai_patch.diff", diffText);
  try { execSync("git apply --check ai_patch.diff", { stdio: "pipe" }); } catch { return false; }
  try { execSync("git apply ai_patch.diff", { stdio: "pipe" }); } catch { return false; }
  return true;
}
function commitAndPush(message) {
  execSync('git config user.name "AI Dev Agent"', { stdio: "pipe" });
  execSync('git config user.email "github-actions[bot]@users.noreply.github.com"', { stdio: "pipe" });

  const stagedBefore = trySh("git diff --cached --name-only");
  execSync("git add -A", { stdio: "pipe" });
  const staged = trySh("git diff --cached --name-only");
  if (!staged) {
    info("ℹ️ No changes to commit");
    return false;
  }
  execSync(`git commit -m "${message}"`, { stdio: "pipe" });

  const pushUrl = `https://x-access-token:${PAT_TOKEN}@github.com/${TARGET_REPO}.git`;
  execSync(`git push ${pushUrl} ${TARGET_BRANCH}`, { stdio: "pipe" });
  info("✅ Changes pushed");
  return true;
}

// ---------- FALLBACKS (deterministic) ----------
function tryFallbackFix(logs) {
  let changed = false;

  // OpenSSL error with Next 10 on Node 20+ → pin Node 16 + ensure build script
  if (/ERR_OSSL|digital envelope routines::unsupported/i.test(logs)) {
    if (fs.existsSync("package.json")) {
      const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
      const before = JSON.stringify(pkg);
      pkg.engines = pkg.engines || {};
      pkg.engines.node = "16.x";
      pkg.scripts = pkg.scripts || {};
      pkg.scripts.build = "next build";
      const after = JSON.stringify(pkg);
      if (before !== after) {
        fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
        changed = true;
      }
    }
  }

  // Missing deps
  if (/Can't resolve 'axios'|Module not found:.*axios/i.test(logs)) {
    trySh("npm i axios@^1 -S");
    changed = true;
  }
  if (/Can't resolve 'isomorphic-unfetch'|Module not found:.*isomorphic-unfetch/i.test(logs)) {
    trySh("npm i isomorphic-unfetch@^3 -S");
    changed = true;
  }

  if (changed) {
    execSync('git config user.name "AI Dev Agent"', { stdio: "pipe" });
    execSync('git config user.email "github-actions[bot]@users.noreply.github.com"', { stdio: "pipe" });
    execSync("git add -A", { stdio: "pipe" });
    try { execSync('git commit -m "chore: fallback fix from agent"', { stdio: "pipe" }); } catch {}
    const pushUrl = `https://x-access-token:${PAT_TOKEN}@github.com/${TARGET_REPO}.git`;
    execSync(`git push ${pushUrl} ${TARGET_BRANCH}`, { stdio: "pipe" });
    info("✅ Fallback fix pushed");
    return true;
  }
  return false;
}

// ---------- MAIN ----------
(async function main() {
  // Always have deps; allows AI/fallback to add imports
  trySh("npm ci || npm i");

  const { state, logs } = await getLatestVercel();
  const failing = /ERROR|FAILED|BUILD_ERROR/i.test(state + " " + logs);
  const mode = failing ? "FIX" : "FEATURE";
  info(`🔍 Mode: ${mode} (Vercel state: ${state})`);

  const ctx = getRepoContext();

  // Ask AI for a diff
  let diff = await getAIDiff({ mode, logs, ctx });
  if (diff) {
    const applied = tryApplyPatch(diff);
    if (applied) {
      commitAndPush(mode === "FIX" ? "fix: AI build repair" : "feat: AI improvement");
      return;
    }
    warn("⚠️ AI diff failed to apply -> trying fallbacks");
  } else {
    warn("⚠️ No valid patch from AI -> trying fallbacks");
  }

  // Deterministic fallbacks (ensures forward motion)
  const done = tryFallbackFix(logs || "");
  if (!done) {
    info("⏭️ Skipping: nothing to change this run.");
  }
})();