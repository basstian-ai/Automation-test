#!/usr/bin/env node
/* automation/ai-iter-agent.cjs
 * Self-iterating AI dev loop for Next.js (Next 10) on Vercel.
 * Flow:
 *   1) Sync target repo
 *   2) Pull latest Vercel build + runtime logs
 *   3) Decide FIX vs FEATURE from logs
 *   4) Ask AI for a STRICT JSON patch (unified diff OR files[])
 *   5) Apply patch; run LOCAL BUILD
 *      - if build fails: re-ask AI with stronger constraints (files[] only) and retry once
 *   6) Only push when local build passes
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
  AI_MODEL = process.env.AI_MODEL || "gpt-4o-mini",
  AGENT_MAX_PROMPT_CHARS = parseInt(process.env.AGENT_MAX_PROMPT_CHARS || "45000", 10),
  AGENT_RETRY = parseInt(process.env.AGENT_RETRY || "3", 10),
} = process.env;

if (!OPENAI_API_KEY) die("Missing OPENAI_API_KEY");
if (!VERCEL_TOKEN) log("⚠️ Missing VERCEL_TOKEN (logs may be limited)");
if (!VERCEL_TEAM_ID) log("⚠️ Missing VERCEL_TEAM_ID (logs lookup may fail)");
if (!VERCEL_PROJECT) log("⚠️ Missing VERCEL_PROJECT (logs lookup may fail)");

const ROOT = process.cwd();
const TARGET_DIR = `${ROOT}/target`;

// ---------- helpers ----------
function run(cmd, opts = {}) {
  return execSync(cmd, { stdio: "pipe", encoding: "utf8", ...opts }).toString();
}
function shTry(cmd) {
  try { return { ok: true, out: run(cmd) }; }
  catch (e) { return { ok: false, out: (e.stdout || "") + (e.stderr || "") || e.message }; }
}
function log(msg) { console.log(msg); }
function die(msg) { console.error(`❌ ${msg}`); process.exit(1); }
function safeWrite(path, content) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); }
function trim(s, n) { if (!s) return ""; return s.length <= n ? s : s.slice(0, n - 2000) + "\n…\n" + s.slice(-1000); }
function looksLikeUnifiedDiff(s) { return /^diff --git a\//m.test(s) && /(^--- a\/)|(^\+\+\+ b\/)/m.test(s); }

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
    const chunk = txt.slice(0, Math.max(0, Math.min(txt.length, maxBytes - used)));
    used += chunk.length;
    out.push({ path: p, snippet: chunk });
    if (used >= maxBytes) break;
  }
  return out;
}

// ---------- git sync ----------
function syncTarget() {
  // clone or reset
  const rs1 = shTry(`git -C ${TARGET_DIR} fetch origin ${TARGET_BRANCH}`);
  if (!rs1.ok) {
    run(`rm -rf ${TARGET_DIR}`);
    run(`git clone https://github.com/${TARGET_REPO} ${TARGET_DIR}`);
    run(`git -C ${TARGET_DIR} checkout ${TARGET_BRANCH}`);
  } else {
    run(`git -C ${TARGET_DIR} checkout ${TARGET_BRANCH}`);
    run(`git -C ${TARGET_DIR} reset --hard origin/${TARGET_BRANCH}`);
  }
  // identity
  shTry(`git -C ${TARGET_DIR} config user.name "AI Dev Agent"`);
  shTry(`git -C ${TARGET_DIR} config user.email "ai-agent@local"`);
}

// ---------- vercel logs ----------
async function fetchJSON(url, init = {}) {
  const res = await fetch(url, init);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { const e = new Error(`Non-JSON ${res.status}`); e.body = text; e.status = res.status; throw e; }
  if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.body = JSON.stringify(json); e.status = res.status; throw e; }
  return json;
}
async function resolveProjectId() {
  if (!VERCEL_PROJECT) return null;
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
  try {
    const j = await fetchJSON(
      `https://api.vercel.com/v6/deployments?teamId=${encodeURIComponent(VERCEL_TEAM_ID)}&projectId=${encodeURIComponent(projectId)}&limit=1`,
      { headers: { Authorization: `Bearer ${VERCEL_TOKEN}` } }
    );
    return j.deployments?.[0] || null;
  } catch { return null; }
}
async function buildEvents(deploymentId) {
  if (!deploymentId) return "";
  try {
    const j = await fetchJSON(
      `https://api.vercel.com/v3/deployments/${deploymentId}/events?teamId=${encodeURIComponent(VERCEL_TEAM_ID)}`,
      { headers: { Authorization: `Bearer ${VERCEL_TOKEN}` } }
    );
    return (j.events || []).map(e => `[${e.type}] ${e?.payload?.text || ""}`).join("\n");
  } catch (e) { return `Failed to fetch events: ${e.status || "?"} ${e.body || ""}`; }
}
function runtimeLogsCLI(url) {
  const r = shTry(`npx vercel logs ${url} --token ${VERCEL_TOKEN} --scope ${VERCEL_TEAM_ID} --yes`);
  return r.out || "";
}

// ---------- AI ----------
async function askAI(system, user, forceFilesOnly = false) {
  const body = {
    model: AI_MODEL,
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    response_format: { type: "json_object" },
    temperature: 0.2,
  };
  if (forceFilesOnly) {
    // small nudge inside system prompt to avoid diffs
    body.messages[0].content += "\nReturn ONLY `files` array; do not include `unified_diff`.";
  }
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j?.error?.message || `OpenAI ${res.status}`);
  const raw = j.choices?.[0]?.message?.content?.trim();
  if (!raw) throw new Error("Empty AI content");
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error("AI did not return valid JSON"); }
  // persist for trace
  safeWrite(`${TARGET_DIR}/ai_response.json`, JSON.stringify(parsed, null, 2));
  return parsed;
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
function firstLine(s) { return (s || "").split("\n")[0]; }

// ---------- local build gate ----------
function localBuild() {
  // Older Next 10 + webpack5 often need openssl legacy provider to build on Node 20
  const cmd = `cd ${TARGET_DIR} && (npm ci || npm i) && NODE_OPTIONS="--openssl-legacy-provider --max-old-space-size=4096" npm run build`;
  const r = shTry(cmd);
  safeWrite(`${TARGET_DIR}/local_build.log`, r.out || "");
  return r.ok;
}

// ---------- mode decision ----------
function decideMode(buildLog, runtimeLog) {
  const red = `${buildLog}\n${runtimeLog}`.toLowerCase();
  const needles = [
    "build failed", "error in", "module not found",
    "command \"npm run build\" exited with 1",
    "couldn't be found", "unhandled", "typeerror", "referenceerror"
  ];
  return needles.some(n => red.includes(n)) ? "FIX" : "FEATURE";
}

// ---------- main ----------
(async function main() {
  log("\n=== Sync target repo ===\n");
  syncTarget();

  log("\n=== Fetch latest Vercel deployment & logs ===\n");
  let buildLog = "", runtimeLog = "", depMeta = "";
  try {
    const projectId = await resolveProjectId();
    let dep = null;
    if (projectId) dep = await latestDeployment(projectId);
    if (dep) {
      depMeta = `${dep.uid || dep.id} (${dep.state || "?"}) url: ${dep.url || "n/a"}`;
      log(`📦 Latest deployment: ${depMeta}`);
      buildLog = await buildEvents(dep.uid || dep.id);
      runtimeLog = runtimeLogsCLI(dep.url);
    } else {
      depMeta = "no deployment; using local signals";
      // local signal if no deployment info
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

  // Prepare AI prompt
  const mode = decideMode(buildLog, runtimeLog);
  const files = listFiles();
  const key = ["package.json", "next.config.js", "pages/index.js", "pages/_app.js", "pages/api/products.js"].filter(p => files.includes(p));
  const snippets = readFew(key, 28000);
  const repoListing = files.slice(0, 300).map(f => ` - ${f}`).join("\n");
  const system =
`You are a senior Next.js (v10) & Vercel engineer and PIM domain expert.
- If Mode=FIX: deliver the smallest safe change to make build & runtime green. If "Module not found: 'isomorphic-unfetch'" appears, either add the dependency or refactor to native fetch compatible with Next 10. Avoid comments in package.json.
- If Mode=FEATURE: add one incremental, shippable PIM improvement (e.g., search facets, basic variant fields, attribute groups) with at least one test.
- Tests are encouraged but keep them minimal; if a test runner isn't present, add a basic Jest setup (jest, @testing-library/react, @testing-library/jest-dom) and script.
- Prefer UNIFIED DIFF. If uncertain, return FILES array instead. Always produce valid JSON.

Return JSON:
{
  "commit_message": "string",
  "unified_diff": "string (optional, full valid unified diff)",
  "files": [{"path":"string", "content":"string"}]
}`;
  const user =
`Context:
Mode: ${mode}
Latest deployment: ${depMeta}

Build log (trimmed):
${trim(buildLog, Math.floor(AGENT_MAX_PROMPT_CHARS * 0.45))}

Runtime log (trimmed):
${trim(runtimeLog, Math.floor(AGENT_MAX_PROMPT_CHARS * 0.2))}

Repo files (partial):
${repoListing}

Key file snippets:
${snippets.map(s => `--- ${s.path}\n${s.snippet}`).join("\n\n")}`;

  // First attempt
  let ai, attempt = 0;
  for (; attempt < AGENT_RETRY; attempt++) {
    const forceFilesOnly = attempt === AGENT_RETRY - 1; // last retry -> files[] only
    try {
      ai = await askAI(system, user, forceFilesOnly);
      break;
    } catch (e) {
      log(`⚠️ AI attempt ${attempt + 1} failed: ${e.message}`);
    }
  }
  if (!ai) return keepalive("no-op: AI did not return JSON");

  log("\n=== Apply patch ===\n");
  let applied = false;

  if (ai.unified_diff && looksLikeUnifiedDiff(ai.unified_diff)) {
    safeWrite(`${TARGET_DIR}/ai_patch.diff`, ai.unified_diff);
    applied = applyUnifiedDiff(ai.unified_diff);
    if (!applied) log("⚠️ Unified diff failed to apply; will try files[] if present.");
  }
  if (!applied && Array.isArray(ai.files) && ai.files.length) {
    applied = applyFiles(ai.files);
  }
  if (!applied) {
    safeWrite(`${TARGET_DIR}/ai_suggestion.md`, JSON.stringify(ai, null, 2));
    return keepalive("no-op: patch not applicable");
  }

  // Validate package.json JSON if present
  if (existsSync(`${TARGET_DIR}/package.json`)) {
    try { JSON.parse(readFileSync(`${TARGET_DIR}/package.json`, "utf8")); }
    catch { return abortChanges("package.json invalid JSON after patch"); }
  }

  // LOCAL BUILD GATE
  log("\n=== Local build gate ===\n");
  if (!localBuild()) {
    // One more AI try with build log feedback, files[] only
    const buildOut = readFileSync(`${TARGET_DIR}/local_build.log`, "utf8");
    const user2 =
`Local build failed. Fix it with minimal changes.
Return ONLY "files" (full contents). No unified_diff.

Local build log (trimmed):
${trim(buildOut, Math.floor(AGENT_MAX_PROMPT_CHARS * 0.6))}

Repo files (partial):
${repoListing}`;
    let ai2;
    try { ai2 = await askAI(system, user2, true); } catch (e) { return abortChanges(`2nd AI request failed: ${e.message}`); }

    // Revert previous changes before applying fresh files
    run(`git -C ${TARGET_DIR} reset --hard`);
    applied = applyFiles(ai2.files || []);
    if (!applied) return abortChanges("2nd patch not applicable");

    if (existsSync(`${TARGET_DIR}/package.json`)) {
      try { JSON.parse(readFileSync(`${TARGET_DIR}/package.json`, "utf8")); }
      catch { return abortChanges("package.json invalid JSON after 2nd patch"); }
    }
    if (!localBuild()) return abortChanges("Local build still failing after 2nd patch");
    ai = ai2; // commit message from second pass
  }

  // Commit & push
  const msg = (ai.commit_message || (mode === "FIX" ? "fix: build/runtime repair" : "feat: PIM improvement + tests")).replace(/"/g, '\\"');
  run(`git -C ${TARGET_DIR} add -A`);
  run(`git -C ${TARGET_DIR} commit -m "${msg}"`);
  run(`git -C ${TARGET_DIR} push origin ${TARGET_BRANCH}`);
  log("✅ Changes pushed.");
})().catch(err => die(err.message));

// ---------- small helpers ----------
function keepalive(reason) {
  log(`⚠️ ${reason}`);
  shTry(`git -C ${TARGET_DIR} commit --allow-empty -m "AI keepalive: ${reason}"`);
  shTry(`git -C ${TARGET_DIR} push origin ${TARGET_BRANCH}`);
}
function abortChanges(reason) {
  log(`❌ ${reason}`);
  // discard working tree changes
  shTry(`git -C ${TARGET_DIR} reset --hard`);
  process.exit(1);
}
