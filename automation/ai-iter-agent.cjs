#!/usr/bin/env node
// automation/ai-iter-agent.cjs
// Red thread: sync -> collect logs -> fix build OR add PIM feature -> add tests -> apply diff -> push.

const fs = require("fs");
const path = require("path");
const https = require("https");
const { spawnSync, execSync } = require("child_process");

// ===== Env =====
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const VERCEL_TOKEN = process.env.VERCEL_TOKEN || "";
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID || "";
const VERCEL_PROJECT_INPUT = process.env.VERCEL_PROJECT || ""; // can be name or prj_*
const TARGET_REPO = process.env.TARGET_REPO || "";
const TARGET_BRANCH = process.env.TARGET_BRANCH || "main";
const PAT_TOKEN = process.env.PAT_TOKEN || "";
const AI_MODEL = process.env.AI_MODEL || "gpt-4o-mini";
const ATTEMPTS = 3;
const MAX_PROMPT_CHARS = parseInt(process.env.AGENT_MAX_PROMPT_CHARS || "45000", 10);

// ===== Paths =====
const ROOT = process.cwd();
const TARGET_DIR = path.join(ROOT, "target");
const BUILD_LOG = path.join(TARGET_DIR, "vercel_build.log");
const RUNTIME_LOG = path.join(TARGET_DIR, "vercel_runtime.log");
const PATCH_FILE = path.join(TARGET_DIR, "ai_patch.diff");
const SUGGESTIONS_FILE = path.join(TARGET_DIR, "ai_suggestion.md");

// ===== Helpers =====
function run(cmd, opts = {}) {
  const res = spawnSync(cmd, { shell: true, encoding: "utf8", ...opts });
  if (opts.print !== false) {
    if (res.stdout) process.stdout.write(res.stdout);
    if (res.stderr) process.stderr.write(res.stderr);
  }
  return res;
}

function execOk(cmd, opts = {}) {
  try {
    const out = execSync(cmd, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", ...opts });
    if (opts.print) process.stdout.write(out);
    return { ok: true, out };
  } catch (e) {
    const out = (e && (e.stdout || e.stderr)) ? String(e.stdout || e.stderr) : String(e.message || "");
    if (opts.print) process.stderr.write(out);
    return { ok: false, out };
  }
}

function httpsJSON(method, url, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        method,
        hostname: u.hostname,
        path: u.pathname + (u.search || ""),
        headers,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode >= 400) {
            return reject(Object.assign(new Error(`${method} ${url} => ${res.statusCode}`), { status: res.statusCode, body: data }));
          }
          try { resolve(JSON.parse(data || "{}")); }
          catch { reject(new Error(`Invalid JSON from ${url}: ${data?.slice(0,400)}`)); }
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function save(file, content) {
  fs.writeFileSync(file, content, "utf8");
  console.log(`📝 Saved: ${file}`);
}

function tail(str, maxChars) {
  if (!str) return "";
  return str.length > maxChars ? str.slice(-maxChars) : str;
}

function sanitizeUnifiedDiff(text) {
  if (!text) return "";
  let t = text.replace(/```(?:diff)?/g, "").trim();

  // If we see multiple sections, keep from the first diff header
  const idx = t.indexOf("diff --git ");
  if (idx >= 0) t = t.slice(idx);

  // Accept minimal unified diff (---/+++)
  if (idx < 0 && !(t.includes("\n--- ") && t.includes("\n+++ "))) return "";

  if (!t.endsWith("\n")) t += "\n";
  return t;
}

// ===== Vercel API =====
async function resolveProjectId() {
  if (!VERCEL_PROJECT_INPUT) return null;
  if (VERCEL_PROJECT_INPUT.startsWith("prj_")) return VERCEL_PROJECT_INPUT;

  // Try to resolve a name -> id
  try {
    const list = await httpsJSON(
      "GET",
      `https://api.vercel.com/v9/projects?teamId=${VERCEL_TEAM_ID}&limit=200`,
      { Authorization: `Bearer ${VERCEL_TOKEN}` }
    );
    const projects = list?.projects || [];
    const byName = projects.find((p) => p.name === VERCEL_PROJECT_INPUT);
    if (byName?.id) return byName.id;
  } catch (e) {
    console.warn("⚠️ resolveProjectId failed:", e.status || "", e.message);
  }
  // Fall back to user-provided, may still be ID
  return VERCEL_PROJECT_INPUT;
}

async function fetchLatestDeployment(projectId) {
  if (!VERCEL_TOKEN || !VERCEL_TEAM_ID || !projectId) return null;
  const url = `https://api.vercel.com/v6/deployments?projectId=${projectId}&teamId=${VERCEL_TEAM_ID}&limit=1`;
  const json = await httpsJSON("GET", url, { Authorization: `Bearer ${VERCEL_TOKEN}` });
  const d = json?.deployments?.[0] || null;
  if (d) console.log(`📦 Latest deployment: ${d.uid} (${d.state}) url: ${d.url}`);
  else console.log("⚠️ No deployments found.");
  return d;
}

async function fetchBuildEvents(deploymentUid) {
  if (!deploymentUid) return { events: [] };
  const url = `https://api.vercel.com/v3/deployments/${deploymentUid}/events?teamId=${VERCEL_TEAM_ID}`;
  return await httpsJSON("GET", url, { Authorization: `Bearer ${VERCEL_TOKEN}` });
}

function fetchRuntimeLogsCLI(deploymentUrl) {
  if (!deploymentUrl) return "No deployment URL available.";
  // --since deprecated; rely on last 2000 lines
  const cmd = `npx vercel logs ${deploymentUrl} --token ${VERCEL_TOKEN} --scope ${VERCEL_TEAM_ID} --limit 2000`;
  const res = execOk(cmd);
  return res.out || "No runtime logs available.";
}

// ===== OpenAI =====
async function openAIChat(messages) {
  const body = JSON.stringify({ model: AI_MODEL, messages, temperature: 0 });
  const json = await httpsJSON(
    "POST",
    "https://api.openai.com/v1/chat/completions",
    { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body
  );
  return json?.choices?.[0]?.message?.content || "";
}

// ===== Repo ops =====
function ensureTargetRepo() {
  if (!fs.existsSync(TARGET_DIR)) {
    const cloneUrl = `https://${PAT_TOKEN}@github.com/${TARGET_REPO}.git`;
    run(`git clone ${cloneUrl} target`);
  }
  run(`git -C ${TARGET_DIR} fetch origin ${TARGET_BRANCH}`);
  run(`git -C ${TARGET_DIR} checkout ${TARGET_BRANCH}`);
  run(`git -C ${TARGET_DIR} reset --hard origin/${TARGET_BRANCH}`);
  run(`git -C ${TARGET_DIR} config user.name "AI Dev Agent"`);
  run(`git -C ${TARGET_DIR} config user.email "ai-agent@local"`);
}

function repoSnapshot() {
  const files = execOk(`git -C ${TARGET_DIR} ls-files`).out || "";
  const headMsg = (execOk(`git -C ${TARGET_DIR} log -1 --pretty=%B`).out || "").trim();
  const nextCfg = fs.existsSync(path.join(TARGET_DIR, "next.config.js"))
    ? fs.readFileSync(path.join(TARGET_DIR, "next.config.js"), "utf8")
    : "";
  const pkgJson = fs.existsSync(path.join(TARGET_DIR, "package.json"))
    ? fs.readFileSync(path.join(TARGET_DIR, "package.json"), "utf8")
    : "";
  return { files, headMsg, nextCfg, pkgJson };
}

function maybeLocalBuildAppendLogs() {
  try {
    const bLen = fs.existsSync(BUILD_LOG) ? fs.statSync(BUILD_LOG).size : 0;
    const rLen = fs.existsSync(RUNTIME_LOG) ? fs.statSync(RUNTIME_LOG).size : 0;
    if (bLen > 400 && rLen > 200) return;

    console.log("🧪 Running local install/build (log enrichment)...");
    const ci = execOk(`npm ci`, { cwd: TARGET_DIR });
    const build = execOk(`npm run build`, { cwd: TARGET_DIR });
    const merged = ["=== LOCAL INSTALL ===", ci.out || "", "=== LOCAL BUILD ===", build.out || ""].join("\n");
    fs.appendFileSync(BUILD_LOG, `\n\n${merged}`);
  } catch (e) {
    console.warn("⚠️ Local build fallback failed:", e.message);
  }
}

// ===== Diff application =====
function tryApplyDiffOnce() {
  let r = run(`git -C ${TARGET_DIR} apply --3way --whitespace=fix ${PATCH_FILE}`, { print: false });
  if (r.status === 0) return true;

  r = run(`git -C ${TARGET_DIR} apply --whitespace=fix ${PATCH_FILE}`, { print: false });
  if (r.status === 0) return true;

  r = run(`patch -p1 -d ${TARGET_DIR} < ${PATCH_FILE}`, { print: false });
  if (r.status === 0) return true;

  return false;
}

async function reAskAIWithError(prevDiff, errorText, logsChunk, snapshot) {
  const sys = [
    "You are an autonomous senior engineer.",
    "Return ONLY a VALID unified diff (git apply format).",
    "Fix build/runtime errors first; if none, add next useful PIM feature; otherwise add Jest/RTL tests.",
    "No code fences. No commentary.",
  ].join(" ");

  const user = [
    "Previous diff FAILED to apply. Git/patch error:",
    "-----",
    tail(errorText, 4000),
    "-----",
    "\n--- Repo snapshot ---",
    `HEAD:\n${snapshot.headMsg}`,
    `next.config.js (tail):\n${tail(snapshot.nextCfg, 3000)}`,
    `package.json (tail):\n${tail(snapshot.pkgJson, 3000)}`,
    `Files:\n${tail(snapshot.files, 3000)}`,
    "\n--- Logs (tail) ---",
    tail(logsChunk, MAX_PROMPT_CHARS),
    "\nReturn ONLY a unified diff.",
  ].join("\n");

  return await openAIChat([{ role: "system", content: sys }, { role: "user", content: user }]);
}

async function getAIDiff(logsChunk, snapshot) {
  const sys = [
    "You are an autonomous senior engineer for a Next.js + Vercel PIM project.",
    "RED THREAD: 1) read logs 2) fix build 3) if green add PIM feature 4) else add tests.",
    "OUTPUT: VALID unified diff only. No code fences. No prose.",
  ].join(" ");

  const user = [
    "--- Repo snapshot ---",
    `HEAD:\n${snapshot.headMsg}`,
    `next.config.js (tail):\n${tail(snapshot.nextCfg, 3000)}`,
    `package.json (tail):\n${tail(snapshot.pkgJson, 3000)}`,
    `Files:\n${tail(snapshot.files, 3000)}`,
    "\n--- Logs (build + runtime tail) ---",
    tail(logsChunk, MAX_PROMPT_CHARS),
  ].join("\n");

  return await openAIChat([{ role: "system", content: sys }, { role: "user", content: user }]);
}

function keepaliveCommit(reason = "no-op") {
  const dir = path.join(TARGET_DIR, ".ai-keepalive");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  const f = path.join(dir, `${Date.now()}-${reason}.txt`);
  fs.writeFileSync(f, new Date().toISOString() + "\n", "utf8");
  run(`git -C ${TARGET_DIR} add .`, { print: false });
  run(`git -C ${TARGET_DIR} commit -m "AI keepalive: ${reason} ${new Date().toISOString()}"`, { print: false });
  run(`git -C ${TARGET_DIR} push origin ${TARGET_BRANCH}`, { print: false });
  console.log("✅ Keepalive commit pushed.");
}

// ===== Main =====
(async function main() {
  if (!OPENAI_API_KEY) { console.error("❌ OPENAI_API_KEY missing"); process.exit(1); }
  if (!TARGET_REPO || !PAT_TOKEN) { console.error("❌ TARGET_REPO or PAT_TOKEN missing"); process.exit(1); }

  console.log("\n=== Sync target repo ===");
  ensureTargetRepo();

  console.log("\n=== Fetch latest Vercel deployment & logs ===");
  let projectId = null;
  try { projectId = await resolveProjectId(); } catch {}
  let deployment = null;

  try {
    deployment = await fetchLatestDeployment(projectId);
  } catch (e) {
    console.warn("⚠️ fetchLatestDeployment failed:", e.status || "", e.message);
  }

  try {
    if (deployment?.uid) {
      const events = await fetchBuildEvents(deployment.uid);
      save(BUILD_LOG, JSON.stringify(events || {}, null, 2));
    } else {
      save(BUILD_LOG, "No Vercel deployment found or no UID.\n");
    }
  } catch (e) {
    console.warn("⚠️ fetchBuildEvents failed:", e.status || "", e.message, e.body || "");
    save(BUILD_LOG, `fetchBuildEvents error: ${e.message}\n${e.body || ""}\n`);
  }

  try {
    const runtime = deployment?.url ? fetchRuntimeLogsCLI(deployment.url) : "No deployment URL for runtime logs.";
    save(RUNTIME_LOG, runtime);
  } catch (e) {
    console.warn("⚠️ runtime logs failed:", e.message);
    save(RUNTIME_LOG, "No runtime logs available.\n");
  }

  // Enrich with local build if logs thin
  maybeLocalBuildAppendLogs();

  // Prompt materials
  const buildTail = fs.existsSync(BUILD_LOG) ? fs.readFileSync(BUILD_LOG, "utf8") : "";
  const runtimeTail = fs.existsSync(RUNTIME_LOG) ? fs.readFileSync(RUNTIME_LOG, "utf8") : "";
  const logsChunk = [
    "=== BUILD LOG ===",
    tail(buildTail, Math.floor(MAX_PROMPT_CHARS / 2)),
    "=== RUNTIME LOG ===",
    tail(runtimeTail, Math.floor(MAX_PROMPT_CHARS / 2)),
  ].join("\n");
  const snapshot = repoSnapshot();

  console.log("\n=== Ask AI for patch ===");
  let diffText = await getAIDiff(logsChunk, snapshot);

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const clean = sanitizeUnifiedDiff(diffText);
    if (!clean) {
      console.warn("⚠️ AI diff missing headers; re-asking with instruction.");
      diffText = await reAskAIWithError("", "Unified diff headers missing", logsChunk, snapshot);
      continue;
    }
    save(PATCH_FILE, clean);

    console.log("\n=== Apply patch ===");
    if (tryApplyDiffOnce()) {
      run(`git -C ${TARGET_DIR} add .`, { print: false });
      const msg = `AI iteration: ${new Date().toISOString()}`;
      const c = run(`git -C ${TARGET_DIR} commit -m "${msg}"`, { print: false });
      if (c.status === 0) {
        run(`git -C ${TARGET_DIR} push origin ${TARGET_BRANCH}`, { print: false });
        console.log("✅ Changes pushed.");
      } else {
        console.log("ℹ️ No changes to commit.");
      }
      return;
    }

    // Ask AI again with exact error from apply --check
    const check = execOk(`git -C ${TARGET_DIR} apply --check ${PATCH_FILE}`);
    const errText = check.ok ? "apply --check passed, later strategy failed" : check.out || "patch failed";
    console.warn("❌ Patch failed. Re-asking AI with error details...");
    diffText = await reAskAIWithError(clean, errText, logsChunk, snapshot);
  }

  console.warn("⚠️ AI did not produce an applicable change this run.");
  save(SUGGESTIONS_FILE, `# Patch failures\n\nLast attempted at: ${new Date().toISOString()}\n`);
  keepaliveCommit("patch-failed");
})().catch((err) => {
  console.error("❌ ERROR:", err);
  process.exit(1);
});
