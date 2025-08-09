#!/usr/bin/env node
/* automation/ai-iter-agent.cjs
 * Self-iterating AI dev loop for Next.js on Vercel.
 * Minor update: when the AI patch is “not applicable”, we auto-retry with a
 * files[]-only request (full file bodies), then build-gate and push.
 *
 * Model update: default model -> gpt-5 (override with OPENAI_MODEL or AI_MODEL).
 * Compatibility: for gpt-5, omit temperature (model only supports default).
 *
 * New: optional UPGRADE mode for migrating the target app toward modern
 * Next.js versions (e.g., 14).
 */

const { execSync } = require("child_process");
const { writeFileSync, readFileSync, existsSync, mkdirSync } = require("fs");
const { dirname } = require("path");

// ---------- Config / ENV ----------
const {
  OPENAI_API_KEY,
  VERCEL_TOKEN,
  VERCEL_TEAM_ID,
  VERCEL_PROJECT, // project name or prj_ id
  TARGET_REPO = "basstian-ai/simple-pim-1754492683911",
  TARGET_BRANCH = "main",
  // Default model now gpt-5; OPENAI_MODEL or AI_MODEL can override
  AI_MODEL = process.env.OPENAI_MODEL || process.env.AI_MODEL || "gpt-5",
  AGENT_MAX_PROMPT_CHARS = parseInt(process.env.AGENT_MAX_PROMPT_CHARS || "45000", 10),
  AGENT_RETRY = parseInt(process.env.AGENT_RETRY || "3", 10),
  AGENT_MODE,
} = process.env;

if (!OPENAI_API_KEY) die("Missing OPENAI_API_KEY");

const ROOT = process.cwd();
const TARGET_DIR = `${ROOT}/target`;

// ---------- helpers ----------
function run(cmd, opts = {}) {
  return execSync(cmd, { stdio: "pipe", encoding: "utf8", ...opts }).toString();
}
function shTry(cmd) {
  try { return { ok: true, out: run(cmd) }; }
  catch (e) {
    const out = (e.stdout || "") + (e.stderr || "") || e.message;
    return { ok: false, out };
  }
}
function log(msg) { console.log(msg); }
function die(msg) { console.error(`❌ ${msg}`); process.exit(1); }
function safeWrite(path, content) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); }
function trim(s, n) { if (!s) return ""; return s.length <= n ? s : s.slice(0, n - 2000) + "\n…\n" + s.slice(-1000); }
function looksLikeUnifiedDiff(s) { return /^diff --git a\//m.test(s) && /(^--- a\/)|(^\+\+\+ b\/)/m.test(s); }
function firstLine(s) { return (s || "").split("\n")[0]; }

function listFiles() {
  try { return run(`git -C ${TARGET_DIR} ls-files`).split("\n").filter(Boolean).slice(0, 500); }
  catch { return []; }
}
function readFew(paths, maxBytes = 30000) {
  const out = []; let used = 0;
  for (const p of paths) {
    const full = `${TARGET_DIR}/${p}`;
    if (!existsSync(full)) continue;
    const txt = readFileSync(full, "utf8");
    const room = Math.max(0, Math.min(txt.length, maxBytes - used));
    const chunk = txt.slice(0, room);
    used += chunk.length;
    out.push({ path: p, snippet: chunk });
    if (used >= maxBytes) break;
  }
  return out;
}

// ---------- git sync ----------
function syncTarget() {
  const rs1 = shTry(`git -C ${TARGET_DIR} fetch origin ${TARGET_BRANCH}`);
  if (!rs1.ok) {
    run(`rm -rf ${TARGET_DIR}`);
    run(`git clone https://github.com/${TARGET_REPO} ${TARGET_DIR}`);
    run(`git -C ${TARGET_DIR} checkout ${TARGET_BRANCH}`);
  } else {
    run(`git -C ${TARGET_DIR} checkout ${TARGET_BRANCH}`);
    run(`git -C ${TARGET_DIR} reset --hard origin/${TARGET_BRANCH}`);
  }
  shTry(`git -C ${TARGET_DIR} config user.name "AI Dev Agent"`);
  shTry(`git -C ${TARGET_DIR} config user.email "ai-agent@local"`);
}

// ---------- vercel logs ----------
async function fetchJSON(url, init = {}) {
  const res = await fetch(url, init);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch { const e = new Error(`Non-JSON ${res.status}`); e.body = text; e.status = res.status; throw e; }
  if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.body = JSON.stringify(json); e.status = res.status; throw e; }
  return json;
}
async function resolveProjectId() {
  if (!VERCEL_TOKEN || !VERCEL_TEAM_ID || !VERCEL_PROJECT) return null;
  if (/^prj_/.test(VERCEL_PROJECT)) return VERCEL_PROJECT;
  try {
    const j = await fetchJSON(
      `https://api.vercel.com/v9/projects/${encodeURIComponent(VERCEL_PROJECT)}?teamId=${encodeURIComponent(VERCEL_TEAM_ID)}`,
      { headers: { Authorization: `Bearer ${VERCEL_TOKEN}` } }
    );
    return j.id || null;
  } catch { return null; }
}
async function latestDeployment(projectId) {
  if (!VERCEL_TOKEN || !VERCEL_TEAM_ID || !projectId) return null;
  try {
    const j = await fetchJSON(
      `https://api.vercel.com/v6/deployments?teamId=${encodeURIComponent(VERCEL_TEAM_ID)}&projectId=${encodeURIComponent(projectId)}&limit=1`,
      { headers: { Authorization: `Bearer ${VERCEL_TOKEN}` } }
    );
    return j.deployments?.[0] || null;
  } catch { return null; }
}
async function buildEvents(deploymentId) {
  if (!VERCEL_TOKEN || !VERCEL_TEAM_ID || !deploymentId) return "";
  try {
    const j = await fetchJSON(
      `https://api.vercel.com/v3/deployments/${deploymentId}/events?teamId=${encodeURIComponent(VERCEL_TEAM_ID)}`,
      { headers: { Authorization: `Bearer ${VERCEL_TOKEN}` } }
    );
    return (j.events || []).map(e => `[${e.type}] ${e?.payload?.text || ""}`).join("\n");
  } catch (e) { return `Failed to fetch events: ${e.status || "?"} ${e.body || ""}`; }
}
function runtimeLogsCLI(url) {
  if (!VERCEL_TOKEN || !VERCEL_TEAM_ID || !url) return "";
  const r = shTry(`npx vercel logs ${url} --token ${VERCEL_TOKEN} --scope ${VERCEL_TEAM_ID} --yes`);
  return r.out || "";
}

// ---------- AI ----------
async function askAI(system, user) {
  const baseBody = {
    model: AI_MODEL,
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    response_format: { type: "json_object" },
    // temperature may not be supported for all models (e.g., gpt-5). We add it only if allowed.
  };

  const isGpt5 = /^gpt-5($|[-_])/i.test(AI_MODEL);
  const candidateBodies = [];

  // If not gpt-5, try with temperature first (more deterministic).
  if (!isGpt5) {
    candidateBodies.push({ ...baseBody, temperature: 0.2 });
  }
  // Always add a fallback without temperature (works for all models).
  candidateBodies.push({ ...baseBody });

  let lastErr;
  for (const body of candidateBodies) {
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      let j;
      try { j = JSON.parse(text); } catch { throw new Error(`OpenAI ${res.status}: ${text.slice(0, 200)}`); }
      if (!res.ok) {
        const msg = j?.error?.message || `OpenAI ${res.status}`;
        // If error mentions temperature not supported, continue to next body
        if (/temperature/i.test(msg) && /not support|Only the default/.test(msg)) {
          lastErr = new Error(msg);
          continue;
        }
        throw new Error(msg);
      }
      const raw = j.choices?.[0]?.message?.content?.trim();
      if (!raw) throw new Error("Empty AI content");
      let parsed;
      try { parsed = JSON.parse(raw); } catch { throw new Error("AI did not return valid JSON"); }
      safeWrite(`${TARGET_DIR}/ai_response.json`, JSON.stringify(parsed, null, 2));
      return parsed;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("OpenAI request failed");
}

// ---------- patch apply ----------
function applyUnifiedDiff(diffText) {
  const diffPath = `${TARGET_DIR}/ai_patch.diff`;
  safeWrite(diffPath, diffText);
  const s1 = shTry(`git -C ${TARGET_DIR} apply --3way --whitespace=fix ${diffPath}`);
  if (s1.ok) return true;
  log(`❌ git apply --3way failed: ${firstLine(s1.out)}`);

  const s2 = shTry(`git -C ${TARGET_DIR} apply --whitespace=fix ${diffPath}`);
  if (s2.ok) return true;
  log(`❌ git apply failed: ${firstLine(s2.out)}`);

  const s3 = shTry(`patch -p1 -d ${TARGET_DIR} < ${diffPath}`);
  if (s3.ok) return true;
  log(`❌ patch(1) failed: ${firstLine(s3.out)}`);
  return false;
}
function applyFiles(files) {
  if (!Array.isArray(files) || files.length === 0) return false;
  for (const f of files) {
    if (!f?.path || typeof f.content !== "string") return false;
    safeWrite(`${TARGET_DIR}/${f.path}`, f.content);
    run(`git -C ${TARGET_DIR} add "${f.path}"`);
  }
  return true;
}

// ---------- local build gate ----------
function localBuild() {
  const cmd = `cd ${TARGET_DIR} && (npm ci || npm i) && NODE_OPTIONS="--openssl-legacy-provider --max-old-space-size=4096" npm run build`;
  const r = shTry(cmd);
  safeWrite(`${TARGET_DIR}/local_build.log`, r.out || "");
  return r.ok;
}

// ---------- mode decision ----------
function decideMode(buildLog, runtimeLog, depState) {
  if (AGENT_MODE) return AGENT_MODE.toUpperCase();
  if ((depState || "").toUpperCase() === "READY") return "FEATURE";
  const red = `${buildLog}\n${runtimeLog}`.toLowerCase();
  const needles = [
    "build failed","error in","module not found",
    "command \"npm run build\" exited with 1","couldn't be found",
    "unhandled","typeerror","referenceerror"
  ];
  return needles.some(n => red.includes(n)) ? "FIX" : "FEATURE";
}

// ---------- main ----------
;(async function main() {
  log("\n=== Sync target repo ===\n");
  syncTarget();

  log("\n=== Fetch latest Vercel deployment & logs ===\n");
  let buildLog = "", runtimeLog = "", depMeta = "n/a", depState = "UNKNOWN";
  try {
    const projectId = await resolveProjectId();
    let dep = null;
    if (projectId) dep = await latestDeployment(projectId);
    if (dep) {
      depMeta = `${dep.uid || dep.id} (${dep.state || "?"}) url: ${dep.url || "n/a"}`;
      depState = dep.state || "UNKNOWN";
      log(`📦 Latest deployment: ${depMeta}`);
      buildLog = await buildEvents(dep.uid || dep.id);
      runtimeLog = runtimeLogsCLI(dep.url);
    } else {
      const tryLocal = shTry(`cd ${TARGET_DIR} && (npm ci || npm i) && NODE_OPTIONS="--openssl-legacy-provider --max-old-space-size=4096" npm run build`);
      buildLog = tryLocal.out || "";
      runtimeLog = "(no runtime logs)";
    }
  } catch (e) {
    buildLog = `logs fetch error: ${e.message}`;
  }
  safeWrite(`${TARGET_DIR}/vercel_build.log`, buildLog || "(no build logs)");
  safeWrite(`${TARGET_DIR}/vercel_runtime.log`, runtimeLog || "(no runtime logs)");
  log("📝 Build/runtime logs saved.");

  const mode = decideMode(buildLog, runtimeLog, depState);
  const files = listFiles();
  const key = ["package.json","next.config.js","pages/index.js","pages/_app.js","pages/api/products.js"].filter(p => files.includes(p));
  const snippets = readFew(key, 28000);
  const repoListing = files.slice(0, 300).map(f => ` - ${f}`).join("\n");

  const system =
`You are a senior Next.js (v10) + Vercel engineer and PIM domain expert.
 - Each iteration should deliver visible progress with a moderate, cohesive chunk of work.
 - Mode=FIX: minimal safe change to make build/runtime green. If "Module not found: 'isomorphic-unfetch'", either add the dep or refactor to native fetch that works in Next 10. No comments in package.json.
 - Mode=FEATURE: implement a moderately sized, shippable PIM improvement (e.g., admin gui, APIs, AI-features, list view polish, basic variant fields, attribute groups) with at least one small test. Aim for tangible progress each iteration rather than tiny tweaks.
 - Mode=UPGRADE: incrementally migrate the codebase and dependencies toward Next.js 14 while keeping the app functional, tackling meaningful chunks each step.
 - Prefer UNIFIED DIFF. If unsure or file context may be stale, provide "files" with full contents.
 - live site is here: https://simple-pim-1754492683911.vercel.app .
 - Include a concise commit_message summarizing the specific fix or feature implemented.
 - Always return valid JSON only.`;

  const user =
`Context:
Mode: ${mode}
Deployment: ${depMeta}

Build log (trimmed):
${trim(buildLog, Math.floor(AGENT_MAX_PROMPT_CHARS * 0.45))}

Runtime log (trimmed):
${trim(runtimeLog, Math.floor(AGENT_MAX_PROMPT_CHARS * 0.2))}

Repo files (partial):
${repoListing}

Key file snippets:
${snippets.map(s => `--- ${s.path}\n${s.snippet}`).join("\n\n")}`;

  // Ask AI (first pass)
  let ai;
  try { ai = await askAI(system, user); }
  catch (e) { return keepalive(`AI error: ${e.message}`); }

  log("\n=== Apply patch ===\n");
  let applied = false;

  if (ai.unified_diff && looksLikeUnifiedDiff(ai.unified_diff)) {
    safeWrite(`${TARGET_DIR}/ai_patch.diff`, ai.unified_diff);
    applied = applyUnifiedDiff(ai.unified_diff);
    if (!applied) log("⚠️ unified diff didn’t apply; will try files[] if present");
  }
  if (!applied && Array.isArray(ai.files) && ai.files.length) {
    applied = applyFiles(ai.files);
  }

  // If still not applied, do an immediate files[] retry
  if (!applied) {
    log("⚠️ patch not applicable — retrying with files[] only");
    const userRetry =
`Return ONLY "files" with full file contents (no unified_diff).
Make the smallest correct change for Mode=${mode}.
Build/runtime logs and repo listing are unchanged from previous message.`;
    let ai2;
    try { ai2 = await askAI(system + "\nReturn only files[].", userRetry); }
    catch (e) { return keepalive(`no-op: ${e.message}`); }

    if (Array.isArray(ai2.files) && ai2.files.length) {
      applied = applyFiles(ai2.files);
      if (applied) ai = ai2; // use second commit message if present
    }
  }

  if (!applied) {
    safeWrite(`${TARGET_DIR}/ai_suggestion.md`, JSON.stringify(ai, null, 2));
    log("⚠️ no-op: patch not applicable");
    return; // no keepalive commit when everything is green
  }

  // Validate package.json JSON if present
  if (existsSync(`${TARGET_DIR}/package.json`)) {
    try { JSON.parse(readFileSync(`${TARGET_DIR}/package.json`, "utf8")); }
    catch { return abortChanges("package.json invalid JSON after patch"); }
  }

  // LOCAL BUILD GATE
  log("\n=== Local build gate ===\n");
  if (!localBuild()) {
    const buildOut = readFileSync(`${TARGET_DIR}/local_build.log`, "utf8");
    const user2 =
`Local build failed. Fix it with minimal changes.
Return ONLY "files" (full contents). No unified_diff.

Local build log (trimmed):
${trim(buildOut, Math.floor(AGENT_MAX_PROMPT_CHARS * 0.6))}

Repo files (partial):
${repoListing}`;
    let ai2;
    try { ai2 = await askAI(system + "\nReturn only files[].", user2); }
    catch (e) { return abortChanges(`2nd AI request failed: ${e.message}`); }

    run(`git -C ${TARGET_DIR} reset --hard`);
    if (!applyFiles(ai2.files || [])) return abortChanges("2nd patch not applicable");

    if (existsSync(`${TARGET_DIR}/package.json`)) {
      try { JSON.parse(readFileSync(`${TARGET_DIR}/package.json`, "utf8")); }
      catch { return abortChanges("package.json invalid JSON after 2nd patch"); }
    }
    if (!localBuild()) return abortChanges("Local build still failing after 2nd patch");
    ai = ai2;
  }

    const type = mode === "FIX"
      ? "fix"
      : mode === "UPGRADE"
        ? "chore"
        : "feat";

    run(`git -C ${TARGET_DIR} add -A`);

    let msg = ai.commit_message;
    if (!msg) {
      const filesChanged = run(`git -C ${TARGET_DIR} diff --cached --name-only`).trim().split("\n").filter(Boolean);
      if (filesChanged.length) {
        const first = filesChanged[0];
        const extra = filesChanged.length > 1 ? ` +${filesChanged.length - 1} more` : "";
        msg = `${type}: update ${first}${extra}`;
      } else {
        msg = `${type}: update`;
      }
    }

    msg = msg.replace(/"/g, '\\"');
  run(`git -C ${TARGET_DIR} commit -m "${msg}"`);
  run(`git -C ${TARGET_DIR} push origin ${TARGET_BRANCH}`);
  log("✅ Changes pushed.");
})().catch(err => die(err.message));

// ---------- small helpers ----------
function keepalive(reason) {
  log(`⚠️ ${reason}`);
  // Ready deployment + no actual changes: do nothing (avoid noise)
}
function abortChanges(reason) {
  log(`❌ ${reason}`);
  shTry(`git -C ${TARGET_DIR} reset --hard`);
  process.exit(1);
}
