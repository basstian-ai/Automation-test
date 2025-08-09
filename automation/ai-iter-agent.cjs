#!/usr/bin/env node
/* automation/ai-iter-agent.cjs
 * Red thread: read Vercel build + runtime logs ⇒ fix failing build; if green ⇒ iterate features + add tests.
 * Requires env: OPENAI_API_KEY, VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT, TARGET_REPO, TARGET_BRANCH, PAT_TOKEN
 * Run from repo root: NODE_OPTIONS="--max-old-space-size=8192" node automation/ai-iter-agent.cjs
 */

const { execSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");

// ---------- Small shell helpers ----------
function run(cmd, opts = {}) {
  const res = spawnSync("/bin/bash", ["-lc", cmd], {
    stdio: opts.stdio ?? "pipe",
    encoding: "utf8",
    ...opts,
  });
  if (res.status !== 0) {
    const err = new Error(res.stderr || `Command failed: ${cmd}`);
    err.code = res.status;
    err.stdout = res.stdout;
    err.stderr = res.stderr;
    throw err;
  }
  return res.stdout?.trim() ?? "";
}
function tryRun(cmd, opts = {}) {
  try {
    return run(cmd, opts);
  } catch (e) {
    return null;
  }
}
function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

// ---------- HTTP helper ----------
function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ status: res.statusCode, body: data });
        } else {
          const err = new Error(`GET ${url} => ${res.statusCode}`);
          err.status = res.statusCode;
          err.body = data;
          reject(err);
        }
      });
    });
    req.on("error", reject);
  });
}

// ---------- Config ----------
const TARGET_REPO = process.env.TARGET_REPO; // e.g. basstian-ai/simple-pim-1754492683911
const TARGET_BRANCH = process.env.TARGET_BRANCH || "main";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID;
const VERCEL_PROJECT = process.env.VERCEL_PROJECT;
const CWD = process.cwd();
const TARGET_DIR = path.join(CWD, "target");

// ---------- Git sync target repo ----------
function syncTargetRepo() {
  console.log("\n=== Sync target repo ===");
  ensureDir(TARGET_DIR);
  // Initialize once
  if (!fs.existsSync(path.join(TARGET_DIR, ".git"))) {
    run(`git clone https://github.com/${TARGET_REPO} ${TARGET_DIR}`);
  }
  run(`git -C ${TARGET_DIR} fetch origin ${TARGET_BRANCH}`);
  run(`git -C ${TARGET_DIR} checkout ${TARGET_BRANCH}`);
  run(`git -C ${TARGET_DIR} reset --hard origin/${TARGET_BRANCH}`);

  // Ensure committer identity (avoids CI failures)
  run(`git -C ${TARGET_DIR} config user.name "AI Dev Agent"`);
  run(`git -C ${TARGET_DIR} config user.email "ai-agent@local"`);
}

// ---------- Vercel REST: latest deployment + build logs ----------
async function fetchLatestDeployment() {
  if (!VERCEL_TOKEN || !VERCEL_TEAM_ID || !VERCEL_PROJECT) {
    throw new Error("Missing Vercel env (VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT)");
  }
  const base = `https://api.vercel.com/v6/deployments?projectId=${encodeURIComponent(
    VERCEL_PROJECT
  )}&teamId=${encodeURIComponent(VERCEL_TEAM_ID)}&limit=1`;
  const { body } = await httpGet(base, { Authorization: `Bearer ${VERCEL_TOKEN}` });
  const parsed = JSON.parse(body);
  const dep = parsed.deployments?.[0];
  if (!dep) return null;
  return dep; // { id, state, url, ... }
}

async function fetchBuildEvents(deploymentId) {
  const url = `https://api.vercel.com/v3/deployments/${deploymentId}/events?teamId=${encodeURIComponent(
    VERCEL_TEAM_ID
  )}`;
  const { body } = await httpGet(url, { Authorization: `Bearer ${VERCEL_TOKEN}` });
  // store raw JSON
  return JSON.parse(body);
}

function saveBuildLogFile(events, outPath) {
  const lines = [];
  for (const e of events) {
    if (e.payload?.text) lines.push(e.payload.text);
  }
  fs.writeFileSync(outPath, lines.join("\n"), "utf8");
}

// ---------- Vercel CLI: runtime logs ----------
function ensureVercelCLI() {
  // npx handles install, but pre-flight helps cache
  tryRun(`npx vercel --version`);
}

function fetchRuntimeLogsCLI(deploymentUrlOrId, outFile) {
  // Use --json to get parsable logs. Limit to recent 30 minutes for brevity.
  // Vercel CLI requires token via env or flag; we set env here.
  const env = { ...process.env, VERCEL_TOKEN };
  const cmd = `npx vercel logs ${deploymentUrlOrId} --json --since=30m --scope ${VERCEL_TEAM_ID}`;
  const res = tryRun(cmd, { env });
  if (res) {
    fs.writeFileSync(outFile, res, "utf8");
  } else {
    fs.writeFileSync(outFile, "[]\n", "utf8");
  }
}

// ---------- Repo snapshot (brief) ----------
function listFilesForPrompt(root) {
  const out = tryRun(`git -C ${root} ls-files`) || "";
  const arr = out.split("\n").filter(Boolean);
  // Show short tree in prompt
  return arr.slice(0, 200);
}

function readIfExists(p, limit = 50000) {
  try {
    const s = fs.readFileSync(p, "utf8");
    return s.length > limit ? s.slice(0, limit) + "\n/* truncated */\n" : s;
  } catch {
    return "";
  }
}

// ---------- OpenAI call ----------
async function openAIChat(messages, maxTokens = 2000) {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
  const payload = {
    model: "gpt-4.1", // good reasoning; adjust if you prefer a different model
    temperature: 0.2,
    max_output_tokens: maxTokens,
    messages,
  };
  const body = JSON.stringify(payload);
  const resp = await new Promise((resolve, reject) => {
    const req = https.request(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (d) => (data += d));
        res.on("end", () =>
          res.statusCode >= 200 && res.statusCode < 300
            ? resolve({ status: res.statusCode, body: data })
            : reject(Object.assign(new Error(`OpenAI ${res.statusCode}`), { status: res.statusCode, body: data }))
        );
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
  const parsed = JSON.parse(resp.body);
  return parsed.choices?.[0]?.message?.content || "";
}

// ---------- Patch validators & appliers ----------
function looksLikeUnifiedDiff(txt) {
  return /^(diff --git|---\s+.+\n\+\+\+\s+)/m.test(txt) && /@@\s-\d+,\d+\s\+\d+,\d+\s@@/m.test(txt);
}

function parseFileBlockJSON(txt) {
  try {
    const jsonStart = txt.indexOf("[");
    const jsonEnd = txt.lastIndexOf("]");
    if (jsonStart === -1 || jsonEnd === -1) return null;
    const raw = txt.slice(jsonStart, jsonEnd + 1);
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return null;
    for (const item of arr) {
      if (typeof item.path !== "string" || typeof item.content !== "string") return null;
    }
    return arr;
  } catch {
    return null;
  }
}

function applyUnifiedDiff(diffPath) {
  // 1) try 3-way
  const a = tryRun(`git -C ${TARGET_DIR} apply --3way --whitespace=fix ${diffPath}`);
  if (a !== null) return true;
  // 2) try plain apply
  const b = tryRun(`git -C ${TARGET_DIR} apply --whitespace=fix ${diffPath}`);
  if (b !== null) return true;
  // 3) try GNU patch
  const c = tryRun(`patch -p1 -d ${TARGET_DIR} < ${diffPath}`);
  if (c !== null) return true;
  return false;
}

function applyFileBlocks(blocks) {
  for (const { path: rel, content } of blocks) {
    const abs = path.join(TARGET_DIR, rel);
    ensureDir(path.dirname(abs));
    fs.writeFileSync(abs, content, "utf8");
  }
  return true;
}

// ---------- Prompt builders ----------
function buildSystemPrompt() {
  return [
    "You are an autonomous senior engineer for a Next.js PIM app on Vercel.",
    "RED THREAD:",
    "1) If Vercel build is red: produce a *minimal* fix.",
    "2) If green: implement a *useful next PIM feature* and **add/expand automated tests**.",
    "CONSTRAINTS:",
    "- Prefer *unified diffs* (starts with `diff --git`).",
    "- If diff is complex, you may return a FILE_BLOCK patch as JSON array: [{\"path\":\"...\",\"content\":\"<full file content>\"}].",
    "- Never return partial hunks; diffs must apply cleanly to the current repo.",
    "- Keep changes tight and explain them briefly at top as comments in the diff (use JS comments).",
  ].join("\n");
}

function buildUserPrompt({ repoTree, pkgJson, nextConfig, buildLog, runtimeLog, mode }) {
  const plan = mode === "FIX"
    ? "Build is failing. Produce the smallest safe code change to make it pass."
    : "Build is green. Implement the next most valuable PIM feature and prioritize adding/editing Jest tests.";

  return [
    `MODE: ${mode}`,
    "",
    "REPO TREE (first ~200 files):",
    repoTree.map((f) => ` - ${f}`).join("\n"),
    "",
    "package.json (truncated if large):",
    pkgJson,
    "",
    "next.config.js (if any):",
    nextConfig,
    "",
    "Vercel Build Log (latest):",
    "-----BEGIN BUILD LOG-----",
    buildLog,
    "-----END BUILD LOG-----",
    "",
    "Vercel Runtime Log (latest JSON from `vercel logs --json --since=30m`):",
    "-----BEGIN RUNTIME LOG-----",
    runtimeLog,
    "-----END RUNTIME LOG-----",
    "",
    "TASK:",
    plan,
    "",
    "OUTPUT FORMAT (choose one):",
    "1) UNIFIED DIFF in a single code fence:",
    "```diff",
    "diff --git a/path/file b/path/file",
    "...",
    "```",
    "",
    "2) Or FILE_BLOCK JSON in a code fence:",
    "```json",
    "[ { \"path\": \"relative/path\", \"content\": \"<full new file content>\" } ]",
    "```",
  ].join("\n");
}

// ---------- Decide FIX vs FEATURE ----------
function decideModeFromBuildState(vercelDeployment) {
  const state = vercelDeployment?.state || "UNKNOWN";
  // states: READY, ERROR, CANCELED, BUILDING, QUEUED, INITIALIZING…
  return state === "READY" ? "FEATURE" : "FIX";
}

// ---------- Main flow ----------
(async function main() {
  try {
    syncTargetRepo();

    // Get latest Vercel deployment + events
    console.log("\n=== Fetch latest Vercel deployment & logs ===");
    const deployment = await fetchLatestDeployment();
    const mode = decideModeFromBuildState(deployment);
    const buildEvents = deployment ? await fetchBuildEvents(deployment.id) : { events: [] };

    // Save build log (plain text) for the model
    const buildLogPath = path.join(TARGET_DIR, "vercel_build.log");
    saveBuildLogFile(buildEvents.events || [], buildLogPath);
    console.log(`📝 Build logs saved: ${buildLogPath}`);

    // Ensure CLI then fetch runtime logs via CLI
    ensureVercelCLI();
    const runtimeLogPath = path.join(TARGET_DIR, "vercel_runtime.log");
    if (deployment?.url) {
      fetchRuntimeLogsCLI(deployment.url, runtimeLogPath);
    } else {
      fs.writeFileSync(runtimeLogPath, "[]\n", "utf8");
    }
    console.log(`📝 Runtime logs saved: ${runtimeLogPath}`);

    // Quick local build check—helps catch obvious issues before asking AI
    let localBuildOk = true;
    try {
      // Prefer ci, fall back to i (lock may be skewed)
      tryRun(`npm ci`, { cwd: TARGET_DIR });
      tryRun(`npm i`, { cwd: TARGET_DIR });
      run(`npm run build`, { cwd: TARGET_DIR });
    } catch (e) {
      localBuildOk = false;
    }

    // Gather prompt inputs
    const repoTree = listFilesForPrompt(TARGET_DIR);
    const pkgJson = readIfExists(path.join(TARGET_DIR, "package.json"));
    const nextConfig = readIfExists(path.join(TARGET_DIR, "next.config.js"));
    const buildLogText = readIfExists(buildLogPath, 200000);
    const runtimeLogText = readIfExists(runtimeLogPath, 100000);

    // Ask the model
    console.log("\n=== Ask AI for patch ===");
    const sys = buildSystemPrompt();
    const user = buildUserPrompt({
      repoTree,
      pkgJson,
      nextConfig,
      buildLog: buildLogText,
      runtimeLog: runtimeLogText,
      mode: localBuildOk ? "FEATURE" : "FIX",
    });
    const aiText = await openAIChat(
      [
        { role: "system", content: sys },
        { role: "user", content: user },
      ],
      3500
    );

    // Extract code fence
    const diffFence = aiText.match(/```diff([\s\S]*?)```/i);
    const jsonFence = aiText.match(/```json([\s\S]*?)```/i);

    console.log("\n=== Apply patch ===");
    let applied = false;

    if (diffFence) {
      const diffContent = diffFence[1].trim();
      const diffPath = path.join(TARGET_DIR, "ai_patch.diff");
      fs.writeFileSync(diffPath, diffContent + (diffContent.endsWith("\n") ? "" : "\n"), "utf8");

      if (!looksLikeUnifiedDiff(diffContent)) {
        console.error("⚠️ Diff did not validate as unified diff.");
      } else {
        // Try three strategies
        if (applyUnifiedDiff(diffPath)) applied = true;
      }
    }

    if (!applied && jsonFence) {
      // file-block fallback
      const blocks = parseFileBlockJSON(jsonFence[1]);
      if (blocks) {
        applied = applyFileBlocks(blocks);
      }
    }

    if (!applied) {
      console.error("⚠️ AI did not produce an applicable change this run.");
      process.exit(0); // soft exit (so Action doesn't fail hard)
    }

    // Commit & push
    tryRun(`git -C ${TARGET_DIR} add -A`);
    const changed = tryRun(`git -C ${TARGET_DIR} status --porcelain`);
    if (changed && changed.trim().length > 0) {
      const msg = `AI iteration: ${new Date().toISOString()}`;
      run(`git -C ${TARGET_DIR} commit -m "${msg}"`);
      // Push with auth via PAT if present; otherwise rely on Actions token
      if (process.env.PAT_TOKEN) {
        // swap remote to embed PAT (https)
        const remoteUrl = `https://${process.env.PAT_TOKEN}@github.com/${TARGET_REPO}.git`;
        tryRun(`git -C ${TARGET_DIR} remote set-url origin ${remoteUrl}`);
      }
      run(`git -C ${TARGET_DIR} push origin ${TARGET_BRANCH}`);
      console.log("🚀 Changes pushed");
    } else {
      console.log("ℹ️ No changes to commit");
    }
  } catch (err) {
    console.error("❌ ERROR:", err);
    process.exit(1);
  }
})();
