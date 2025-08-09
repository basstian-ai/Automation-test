#!/usr/bin/env node
/* automation/ai-iter-agent.cjs
 * Hands-off AI dev loop for Next.js + Vercel:
 * 1) Sync target repo
 * 2) Pull last Vercel build/runtime logs
 * 3) If RED -> ask AI for fix (+ test), else -> feature (+ test)
 * 4) Apply JSON-enforced patch (unified diff or file blocks)
 * 5) Commit & push
 * Requires: Node 20+, fetch available globally
 */

const { execSync, spawnSync } = require("child_process");
const { writeFileSync, readFileSync, existsSync, mkdirSync } = require("fs");
const { dirname } = require("path");

// ---------- Config / ENV ----------
const {
  OPENAI_API_KEY,
  VERCEL_TOKEN,
  VERCEL_TEAM_ID,
  VERCEL_PROJECT, // may be prj_xxx or project name
  TARGET_REPO = "basstian-ai/simple-pim-1754492683911",
  TARGET_BRANCH = "main",
  AI_MODEL = process.env.AI_MODEL || "gpt-4o-mini",
  AGENT_MAX_PROMPT_CHARS = parseInt(process.env.AGENT_MAX_PROMPT_CHARS || "45000", 10),
  AGENT_RETRY = parseInt(process.env.AGENT_RETRY || "3", 10),
  RUN_TESTS = process.env.RUN_TESTS === "1" ? true : false,
} = process.env;

if (!OPENAI_API_KEY) fail("Missing OPENAI_API_KEY");
if (!VERCEL_TOKEN) warn("Missing VERCEL_TOKEN (build/runtime logs might be limited)");
if (!VERCEL_TEAM_ID) warn("Missing VERCEL_TEAM_ID (logs lookup may fail)");
if (!VERCEL_PROJECT) warn("Missing VERCEL_PROJECT (logs lookup may fail)");

const ROOT = process.cwd();
const TARGET_DIR = `${ROOT}/target`;

// ---------- Small utils ----------
function run(cmd, opts = {}) {
  const opt = {
    stdio: "pipe",
    encoding: "utf8",
    ...opts,
  };
  return execSync(cmd, opt).toString();
}

function safeWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function note(msg) {
  console.log(msg);
}
function warn(msg) {
  console.log(`⚠️ ${msg}`);
}
function fail(msg) {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

async function fetchJSON(url, init = {}) {
  const res = await fetch(url, init);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (_) {
    const err = new Error(`Non-JSON from ${url}: ${res.status}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} for ${url}`);
    err.status = res.status;
    err.body = JSON.stringify(json);
    throw err;
  }
  return json;
}

function trim(s, max) {
  if (!s) return "";
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 2000)) + "\n\n[...snip for length...]\n" + s.slice(-1000);
}

function listFilesForPrompt() {
  try {
    return run(`git -C ${TARGET_DIR} ls-files`).split("\n").filter(Boolean).slice(0, 500);
  } catch {
    return [];
  }
}

function readFewFiles(paths, maxBytes = 35000) {
  const out = [];
  let used = 0;
  for (const p of paths) {
    if (used > maxBytes) break;
    const full = `${TARGET_DIR}/${p}`;
    if (existsSync(full)) {
      const txt = readFileSync(full, "utf8");
      const chunk = txt.slice(0, Math.max(0, Math.min(txt.length, maxBytes - used)));
      used += chunk.length;
      out.push({ path: p, snippet: chunk });
    }
  }
  return out;
}

function looksLikeUnifiedDiff(s) {
  return /^diff --git a\//m.test(s) && /(^--- a\/)|(^\+\+\+ b\/)/m.test(s);
}

function applyUnifiedDiff(diffText) {
  const diffPath = `${TARGET_DIR}/ai_patch.diff`;
  safeWrite(diffPath, diffText);

  // Strategy 1: git apply --3way
  try {
    run(`git -C ${TARGET_DIR} apply --3way --whitespace=fix ${diffPath}`);
    return true;
  } catch (e) {
    note(`❌ git apply --3way failed: ${e.message.split("\n")[0]}`);
  }

  // Strategy 2: git apply
  try {
    run(`git -C ${TARGET_DIR} apply --whitespace=fix ${diffPath}`);
    return true;
  } catch (e) {
    note(`❌ git apply failed: ${e.message.split("\n")[0]}`);
  }

  // Strategy 3: classic patch
  try {
    run(`patch -p1 -d ${TARGET_DIR} < ${diffPath}`);
    return true;
  } catch (e) {
    note(`❌ patch(1) failed: ${e.message.split("\n")[0]}`);
  }
  return false;
}

function applyFileBlocks(files) {
  // Write each file, then generate our own unified diff to keep history clean
  const tmpIndex = `${TARGET_DIR}/.ai-tmp`;
  mkdirSync(tmpIndex, { recursive: true });

  for (const f of files) {
    const dest = `${TARGET_DIR}/${f.path}`;
    safeWrite(dest, f.content);
    run(`git -C ${TARGET_DIR} add "${f.path}"`);
  }
  return true;
}

// ---------- Git sync ----------
function syncTargetRepo() {
  try {
    // If 'target' is already a clone, just reset to origin/main
    run(`git -C ${TARGET_DIR} fetch origin ${TARGET_BRANCH}`);
    run(`git -C ${TARGET_DIR} checkout ${TARGET_BRANCH}`);
    run(`git -C ${TARGET_DIR} reset --hard origin/${TARGET_BRANCH}`);
  } catch {
    // Fresh clone
    const httpsUrl = `https://github.com/${TARGET_REPO}`;
    run(`rm -rf ${TARGET_DIR}`);
    run(`git clone ${httpsUrl} ${TARGET_DIR}`);
    run(`git -C ${TARGET_DIR} checkout ${TARGET_BRANCH}`);
  }

  // Ensure identity (avoid "who are you?")
  try {
    run(`git -C ${TARGET_DIR} config user.name "AI Dev Agent"`);
    run(`git -C ${TARGET_DIR} config user.email "ai-agent@local"`);
  } catch {}
}

// ---------- Vercel logs ----------
async function ensureProjectId() {
  if (!VERCEL_PROJECT) return null;
  if (/^prj_/.test(VERCEL_PROJECT)) return VERCEL_PROJECT;

  // resolve by name -> id
  try {
    const j = await fetchJSON(
      `https://api.vercel.com/v9/projects/${encodeURIComponent(VERCEL_PROJECT)}?teamId=${encodeURIComponent(VERCEL_TEAM_ID)}`,
      { headers: { Authorization: `Bearer ${VERCEL_TOKEN}` } }
    );
    return j.id || null;
  } catch (e) {
    warn(`resolve project id failed (${e.status || "?"})`);
    return null;
  }
}

async function getLatestDeployment(projectId) {
  try {
    const url = `https://api.vercel.com/v6/deployments?teamId=${encodeURIComponent(VERCEL_TEAM_ID)}&projectId=${encodeURIComponent(projectId)}&limit=1`;
    const j = await fetchJSON(url, { headers: { Authorization: `Bearer ${VERCEL_TOKEN}` } });
    return j.deployments && j.deployments[0] ? j.deployments[0] : null;
  } catch (e) {
    warn(`deployments fetch failed: ${e.status || "?"} ${e.body || ""}`);
    return null;
  }
}

async function getBuildEvents(deploymentId) {
  if (!deploymentId) return "";
  try {
    const url = `https://api.vercel.com/v3/deployments/${deploymentId}/events?teamId=${encodeURIComponent(VERCEL_TEAM_ID)}`;
    const j = await fetchJSON(url, { headers: { Authorization: `Bearer ${VERCEL_TOKEN}` } });
    const events = (j && j.events) || [];
    return events.map(e => `[${e.type}] ${e.payload && e.payload.text ? e.payload.text : ""}`).join("\n");
  } catch (e) {
    return `Failed to fetch events: ${e.status || "?"} ${e.body || ""}`;
  }
}

function getRuntimeLogsCLI(url) {
  // Best-effort: vercel CLI errors if deployment not ready. That’s fine—we still persist the output.
  try {
    const out = run(
      `npx vercel logs ${url} --token ${VERCEL_TOKEN} --scope ${VERCEL_TEAM_ID} --yes`,
      { stdio: "pipe", encoding: "utf8" }
    );
    return out;
  } catch (e) {
    return `Vercel CLI logs error: ${e.stdout || e.message || ""}`;
  }
}

// ---------- AI interaction (JSON-enforced) ----------
async function askAIJSON(system, user) {
  const body = {
    model: AI_MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: { type: "json_object" },
    temperature: 0.2,
  };
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) {
    const msg = json && json.error ? json.error.message : `HTTP ${res.status}`;
    throw new Error(`OpenAI error: ${msg}`);
  }
  let content = json.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error("No content from AI");
  try {
    return JSON.parse(content);
  } catch (e) {
    throw new Error("AI did not return valid JSON");
  }
}

function decideModeFromLogs(buildLog, runtimeLog) {
  const redMarkers = [
    "Build failed",
    "ERROR in",
    "Module not found",
    "Command \"npm run build\" exited with 1",
    "Error: The file \"/vercel/path0/out/routes-manifest.json\" couldn't be found",
    "SSR error",
    "Unhandled rejection",
    "TypeError:",
    "ReferenceError:",
  ];
  const hay = `${buildLog}\n${runtimeLog}`.toLowerCase();
  const isRed = redMarkers.some(m => hay.includes(m.toLowerCase()));
  return isRed ? "FIX" : "FEATURE";
}

// ---------- Main ----------
(async function main() {
  note("\n=== Sync target repo ===\n");
  syncTargetRepo();

  // Snapshot repo context for the model
  const files = listFilesForPrompt();
  const keyFiles = ["package.json", "next.config.js", "pages/index.js", "pages/api/products.js"].filter(p => files.includes(p));
  const keySnippets = readFewFiles(keyFiles, 25000);

  note("\n=== Fetch latest Vercel deployment & logs ===\n");
  const projectId = VERCEL_PROJECT ? await ensureProjectId() : null;
  let deployment = null;
  if (projectId) deployment = await getLatestDeployment(projectId);

  let buildLog = "";
  let runtimeLog = "";
  if (deployment) {
    const depUrl = deployment?.url || "(no url)";
    note(`📦 Latest deployment: ${deployment.uid || deployment.id} (${deployment.state || "?"}) url: ${depUrl}`);
    buildLog = await getBuildEvents(deployment.uid || deployment.id);
    runtimeLog = getRuntimeLogsCLI(depUrl);
  } else {
    warn("No deployment found or project not resolved. Attempting local build for signal...");
    try {
      buildLog = run(`cd ${TARGET_DIR} && npm ci || npm i && npm run build`, { stdio: "pipe" });
    } catch (e) {
      buildLog = (e.stdout || "") + "\n" + (e.stderr || "");
    }
  }

  safeWrite(`${TARGET_DIR}/vercel_build.log`, buildLog || "(no build logs)");
  safeWrite(`${TARGET_DIR}/vercel_runtime.log`, runtimeLog || "(no runtime logs)");
  note(`📝 Build/runtime logs saved.`);

  const mode = decideModeFromLogs(buildLog, runtimeLog);

  // Prepare the prompt (tight, capped length)
  const repoListing = files.slice(0, 300).map(f => ` - ${f}`).join("\n");
  const snippets = keySnippets.map(s => `--- ${s.path}\n${s.snippet}`).join("\n\n");
  const promptUser = trim(
`Context:
- Repo is a Next.js app deployed on Vercel.
- Mode: ${mode} (if FIX: repair build/runtime error first with minimal change + add/extend tests; if FEATURE: implement next useful PIM feature aligned with modern PIM best practices + tests).
- Always keep package.json valid JSON (no comments).
- Prefer incremental, shippable changes.
- If you touch config (next.config.js), explain why in commit message.
- If you add deps, ensure they match Next 10 constraints (legacy project) and lockfiles.
- Provide exactly ONE atomic change per run.

Strict output format (JSON):
{
  "commit_message": "string",
  "unified_diff": "optional string with valid full unified diff starting with 'diff --git a/...' and file headers",
  "files": [
    { "path": "relative path from repo root", "content": "full new file content" }
  ],
  "post_steps": "optional short note e.g. 'run npm test'"
}

Build log (trimmed):
${trim(buildLog, Math.floor(AGENT_MAX_PROMPT_CHARS * 0.4))}

Runtime log (trimmed):
${trim(runtimeLog, Math.floor(AGENT_MAX_PROMPT_CHARS * 0.2))}

Repo files (partial):
${repoListing}

Key file snippets:
${trim(snippets, Math.floor(AGENT_MAX_PROMPT_CHARS * 0.25))}
`, AGENT_MAX_PROMPT_CHARS);

  const systemPrompt =
`You are a senior Next.js/Vercel engineer and PIM domain expert.
Task:
- If Mode=FIX, produce the smallest safe fix to get build and runtime green and add/extend at least one relevant test. Avoid unrelated refactors.
- If Mode=FEATURE, add one meaningful PIM feature (e.g., search facets, basic variant handling, attribute groups) with minimal UI + API updates and at least one test.
- Always prefer unified diff. If you cannot produce a correct unified diff, provide "files" full content.
- Respect Next.js 10 constraints in this repo.
Return strictly valid JSON per schema.`;

  note("\n=== Ask AI for patch ===\n");
  let answer = null;
  let attempts = 0;
  while (attempts < AGENT_RETRY) {
    attempts++;
    try {
      answer = await askAIJSON(systemPrompt, promptUser);
      if (!answer) throw new Error("Empty AI JSON");
      break;
    } catch (e) {
      warn(`AI attempt ${attempts} failed: ${e.message}`);
    }
  }
  if (!answer) {
    // keepalive commit so the workflow doesn’t sit idle
    try {
      run(`git -C ${TARGET_DIR} commit --allow-empty -m "AI keepalive: no-op (no JSON)"`);
      run(`git -C ${TARGET_DIR} push origin ${TARGET_BRANCH}`);
    } catch {}
    return;
  }

  // ---------- Apply patch ----------
  note("\n=== Apply patch ===\n");
  let applied = false;

  if (answer.unified_diff && looksLikeUnifiedDiff(answer.unified_diff)) {
    applied = applyUnifiedDiff(answer.unified_diff);
    if (!applied) warn("Unified diff failed to apply; will try files[] if present.");
  }

  if (!applied && Array.isArray(answer.files) && answer.files.length) {
    applied = applyFileBlocks(answer.files);
  }

  if (!applied) {
    warn("No applicable change from AI this run.");
    safeWrite(`${TARGET_DIR}/ai_suggestion.md`, JSON.stringify(answer, null, 2));
    // keepalive commit (optional)
    try {
      run(`git -C ${TARGET_DIR} commit --allow-empty -m "AI keepalive: no-op (patch not applicable)"`);
      run(`git -C ${TARGET_DIR} push origin ${TARGET_BRANCH}`);
    } catch {}
    return;
  }

  // Optional: run tests if present or requested
  if (RUN_TESTS) {
    try {
      // only run if a test script exists
      const pkg = JSON.parse(readFileSync(`${TARGET_DIR}/package.json`, "utf8"));
      if (pkg.scripts && pkg.scripts.test && !/no test specified/i.test(pkg.scripts.test)) {
        note("\n=== Run tests ===\n");
        run(`cd ${TARGET_DIR} && npm test --silent`, { stdio: "pipe" });
      }
    } catch (e) {
      // Round-trip failed test output back to AI could be added here if desired
      warn(`Tests failed/skipped: ${e.message.split("\n")[0]}`);
    }
  }

  const commitMsg = answer.commit_message || (mode === "FIX" ? "fix: build/runtime repair" : "feat: PIM improvement + tests");
  try {
    run(`git -C ${TARGET_DIR} add -A`);
    // Avoid package.json comment issues: validate JSON
    try {
      JSON.parse(readFileSync(`${TARGET_DIR}/package.json`, "utf8"));
    } catch (e) {
      throw new Error("package.json invalid JSON after patch. Aborting commit.");
    }
    run(`git -C ${TARGET_DIR} commit -m "${commitMsg.replace(/"/g, '\\"')}"`);
    run(`git -C ${TARGET_DIR} push origin ${TARGET_BRANCH}`);
    note("✅ Changes pushed.");
  } catch (e) {
    fail(`Git push failed: ${e.message}`);
  }

})();
