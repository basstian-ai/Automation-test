#!/usr/bin/env node
/**
 * AI Iteration Agent (CJS, hardened)
 * Flow:
 *  1) Sync target repo
 *  2) Fetch Vercel latest deployment + build & runtime logs
 *  3) Ask AI for a strict unified diff; validate it
 *  4) If invalid, retry once with stricter prompt
 *  5) If still invalid, fallback to file-blocks format
 *  6) Apply, commit, push
 */

const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");
const fetch = require("node-fetch");

// -------- Env --------
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const VERCEL_TOKEN   = process.env.VERCEL_TOKEN;
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID || "";
const VERCEL_PROJECT = process.env.VERCEL_PROJECT;
const TARGET_REPO    = process.env.TARGET_REPO; // org/repo
const TARGET_BRANCH  = process.env.TARGET_BRANCH || "main";
const PAT_TOKEN      = process.env.PAT_TOKEN;

if (!OPENAI_API_KEY || !VERCEL_TOKEN || !VERCEL_PROJECT || !TARGET_REPO || !PAT_TOKEN) {
  console.error("❌ Missing required env vars. Need OPENAI_API_KEY, VERCEL_TOKEN, VERCEL_PROJECT, TARGET_REPO, PAT_TOKEN.");
  process.exit(1);
}

const ROOT_DIR   = path.resolve(__dirname, "..");
const TARGET_DIR = path.join(ROOT_DIR, "target");

// -------- Utils --------
function sh(cmd, opts = {}) {
  console.log(`$ ${cmd}`);
  return execSync(cmd, { stdio: "inherit", ...opts });
}

function shOut(cmd, opts = {}) {
  return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
}

function ensureGitIdentity(dir) {
  const name = shOut(`git -C ${dir} config user.name || true`).trim();
  const email = shOut(`git -C ${dir} config user.email || true`).trim();
  if (!name)  sh(`git -C ${dir} config user.name "AI Dev Agent"`);
  if (!email) sh(`git -C ${dir} config user.email "ai-agent@local"`);
}

function normalizeEOL(s) {
  return s.replace(/\r\n/g, "\n");
}

function stripFences(s) {
  // Remove outermost triple-backtick fences if present
  let t = s.trim();
  if (/^```/m.test(t)) {
    t = t.replace(/^```(?:\w+)?\s*/i, "");
    t = t.replace(/\s*```$/i, "");
  }
  return t.trim();
}

function writeFileSafe(absPath, content) {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content);
}

// -------- Vercel --------
async function getLatestDeployment() {
  let url = `https://api.vercel.com/v6/deployments?projectId=${encodeURIComponent(VERCEL_PROJECT)}&limit=1`;
  if (VERCEL_TEAM_ID) url += `&teamId=${encodeURIComponent(VERCEL_TEAM_ID)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${VERCEL_TOKEN}` } });
  if (!res.ok) throw new Error(`Failed to fetch deployments: ${res.status} ${await res.text()}`);
  const data = await res.json();
  if (!data.deployments || !data.deployments.length) throw new Error("No deployments found");
  return data.deployments[0]; // { uid, state, url, ... }
}

async function fetchBuildLogs(deploymentId, outPath) {
  let url = `https://api.vercel.com/v1/deployments/${deploymentId}/events`;
  if (VERCEL_TEAM_ID) url += `?teamId=${encodeURIComponent(VERCEL_TEAM_ID)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${VERCEL_TOKEN}` } });
  if (!res.ok) throw new Error(`Failed to fetch build logs: ${res.status} ${await res.text()}`);
  writeFileSafe(outPath, await res.text());
}

async function fetchRuntimeLogs({ deploymentId, projectId, teamId, token, cwd }) {
  const outPath = path.join(cwd, "vercel_runtime.log");
  const url = new URL(`https://api.vercel.com/v1/projects/${projectId}/deployments/${deploymentId}/runtime-logs`);
  if (teamId) url.searchParams.set("teamId", teamId);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Failed to fetch runtime logs: ${res.status} ${await res.text()}`);
  const file = fs.createWriteStream(outPath, { flags: "w" });
  await new Promise((resolve, reject) => {
    res.body.pipe(file);
    res.body.on("error", reject);
    file.on("finish", resolve);
  });
  return outPath;
}

// -------- AI Prompting --------
function basePrompt({ buildLog, runtimeLog, fileList }) {
  return `
You are a senior full‑stack engineer working on a Next.js 10.2 PIM app.
Use the logs to either **fix failing builds/runtime** or, when green, add a small high‑value PIM improvement.

You MUST output **exactly one** of the following formats (no extra prose, no markdown fences):

1) Preferred: a **strict unified git diff**:
   - Each file change must begin with:
     diff --git a/REL_PATH b/REL_PATH
     --- a/REL_PATH
     +++ b/REL_PATH
   - Followed by one or more hunks starting with:
     @@ -oldStart,oldCount +newStart,newCount @@
   - No truncated hunks; no lines starting with '@@' before headers.
   - End with trailing newline.

2) Fallback: **file-blocks**:
   <<<BEGIN_FILE: REL_PATH_FROM_REPO_ROOT
   <ENTIRE NEW FILE CONTENTS>
   END_FILE

Rules:
- If deployment state is ERROR, fix the causes first (missing deps, bad imports, Next.js config).
- Small, safe edits. Avoid large refactors.
- Ensure changes apply cleanly against the file list shown.

--- BUILD LOGS (Vercel) ---
${buildLog}

--- RUNTIME LOGS (Vercel NDJSON) ---
${runtimeLog}

--- REPO FILE LIST ---
${fileList}
`.trim();
}

function stricterPrompt({ buildLog, runtimeLog, fileList }) {
  return `
Your previous output failed validation because it contained a patch hunk without required headers.

You MUST produce one valid output only:

(A) A unified diff where **every** hunk is preceded by:
    diff --git a/REL_PATH b/REL_PATH
    --- a/REL_PATH
    +++ b/REL_PATH
    @@ -oldStart,oldCount +newStart,newCount @@
or
(B) File-blocks with full file contents.

NO markdown fences, NO commentary, NO truncation. Include trailing newline.

--- BUILD LOGS ---
${buildLog}

--- RUNTIME LOGS ---
${runtimeLog}

--- FILES ---
${fileList}
`.trim();
}

async function askOpenAI(prompt) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.1,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI API error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || "";
}

// -------- Patch Validation & Apply --------
function validateUnifiedDiff(raw) {
  // Ensure: every hunk @@ ... @@ appears after a triplet of headers for SAME file
  // And that diff starts with "diff --git a/... b/..."
  const lines = raw.split("\n");
  const errors = [];
  let i = 0;
  let sawAnyDiff = false;

  while (i < lines.length) {
    const line = lines[i];

    if (/^diff --git a\/.+ b\/.+$/.test(line)) {
      sawAnyDiff = true;
      // Next two lines must be --- a/... and +++ b/...
      const h1 = lines[i + 1] || "";
      const h2 = lines[i + 2] || "";
      if (!/^--- a\/.+$/.test(h1)) errors.push(`Missing '--- a/...' after: ${line}`);
      if (!/^\+\+\+ b\/.+$/.test(h2)) errors.push(`Missing '+++ b/...' after: ${line}`);
      i += 3;

      // Consume hunks for this file until next diff or EOF
      while (i < lines.length && !/^diff --git a\//.test(lines[i])) {
        const l = lines[i];
        if (/^@@ /.test(l)) {
          // OK: inside hunk; next lines may start with ' ', '+', '-', '\'
          i++;
          while (i < lines.length) {
            const hl = lines[i];
            if (/^@@ /.test(hl) || /^diff --git a\//.test(hl)) break;
            i++;
          }
          continue;
        }
        // Allow blank lines between hunks; otherwise must be part of hunk or new diff
        if (l.trim() === "") { i++; continue; }

        // Lines outside hunks are suspicious but not fatal (some diffs include index/metadata)
        i++;
      }

      continue;
    }

    // If an '@@' hunk appears without a diff header before it -> invalid
    if (/^@@ /.test(line) && !sawAnyDiff) {
      errors.push("Hunk appears before any 'diff --git' header.");
      break;
    }

    i++;
  }

  if (!sawAnyDiff) errors.push("No 'diff --git' headers found.");
  return { valid: errors.length === 0, errors };
}

function parseFileBlocks(raw) {
  // <<<BEGIN_FILE: path
  // ...contents...
  // END_FILE
  const blocks = [];
  const re = /^<<<BEGIN_FILE:\s*(.+)$/m;
  let cursor = 0;

  while (true) {
    const m = re.exec(raw.slice(cursor));
    if (!m) break;
    const beginIdx = cursor + m.index;
    const headerEnd = beginIdx + m[0].length;
    const afterHeaderNL = raw.indexOf("\n", headerEnd);
    if (afterHeaderNL === -1) break;
    const relPath = m[1].trim();

    const endMarker = "\nEND_FILE";
    const endIdx = raw.indexOf(endMarker, afterHeaderNL);
    if (endIdx === -1) break;

    const content = raw.slice(afterHeaderNL + 1, endIdx);
    blocks.push({ path: relPath, content });
    cursor = endIdx + endMarker.length;
  }

  return blocks;
}

function tryApplyUnifiedDiff(diffPath) {
  const strategies = [
    `git -C ${TARGET_DIR} apply --3way --whitespace=fix ${diffPath}`,
    `git -C ${TARGET_DIR} apply --whitespace=fix ${diffPath}`,
    `patch -p1 -d ${TARGET_DIR} < ${diffPath}`,
  ];
  for (const cmd of strategies) {
    try {
      sh(cmd);
      return true;
    } catch (e) {
      console.warn(`❌ Patch strategy failed: ${cmd}`);
    }
  }
  return false;
}

function tryApplyFileBlocks(raw) {
  const blocks = parseFileBlocks(raw);
  if (!blocks.length) return false;
  for (const { path: rel, content } of blocks) {
    const abs = path.join(TARGET_DIR, rel);
    writeFileSafe(abs, normalizeEOL(content.endsWith("\n") ? content : content + "\n"));
    console.log(`✍️  Wrote ${rel}`);
  }
  return true;
}

// -------- Main --------
(async () => {
  fs.mkdirSync(TARGET_DIR, { recursive: true });

  console.log("\n=== Sync target repo ===");
  if (!fs.existsSync(path.join(TARGET_DIR, ".git"))) {
    sh(`git clone https://${PAT_TOKEN}@github.com/${TARGET_REPO}.git ${TARGET_DIR}`);
  }
  sh(`git -C ${TARGET_DIR} fetch origin ${TARGET_BRANCH}`);
  sh(`git -C ${TARGET_DIR} checkout ${TARGET_BRANCH}`);
  sh(`git -C ${TARGET_DIR} reset --hard origin/${TARGET_BRANCH}`);
  ensureGitIdentity(TARGET_DIR);

  console.log("\n=== Fetch latest Vercel deployment & logs ===");
  let deployment;
  try {
    deployment = await getLatestDeployment();
  } catch (e) {
    console.warn(`⚠️ Could not resolve deployment: ${e.message}`);
  }

  const buildLogPath = path.join(TARGET_DIR, "vercel_build.log");
  let buildLog = "";
  try {
    if (deployment?.uid) {
      await fetchBuildLogs(deployment.uid, buildLogPath);
      console.log(`📝 Build logs saved: ${buildLogPath}`);
      buildLog = fs.readFileSync(buildLogPath, "utf8");
    }
  } catch (e) {
    console.warn(`⚠️ Could not fetch build logs: ${e.message}`);
  }

  let runtimeLog = "";
  try {
    if (deployment?.uid) {
      const runtimePath = await fetchRuntimeLogs({
        deploymentId: deployment.uid,
        projectId: VERCEL_PROJECT,
        teamId: VERCEL_TEAM_ID,
        token: VERCEL_TOKEN,
        cwd: TARGET_DIR,
      });
      console.log(`📝 Runtime logs saved: ${runtimePath}`);
      runtimeLog = fs.readFileSync(runtimePath, "utf8");
    }
  } catch (e) {
    console.warn(`⚠️ Could not fetch runtime logs: ${e.message}`);
  }

  const fileList = shOut(`git -C ${TARGET_DIR} ls-files`)
    .split("\n")
    .filter(Boolean)
    .map((f) => ` - ${f}`)
    .join("\n");

  // ---------- Ask AI (with retry) ----------
  const prompts = [
    basePrompt({ buildLog, runtimeLog, fileList }),
    stricterPrompt({ buildLog, runtimeLog, fileList }),
  ];

  let aiRaw = "";
  let applied = false;
  let attempt = 0;

  while (!applied && attempt < prompts.length) {
    console.log("\n=== Ask AI for patch ===");
    aiRaw = await askOpenAI(prompts[attempt]);
    const rawPath = path.join(TARGET_DIR, `ai_raw_attempt_${attempt + 1}.txt`);
    writeFileSafe(rawPath, aiRaw || "");
    aiRaw = normalizeEOL(stripFences(aiRaw || ""));

    // Try unified diff path first
    const diffPath = path.join(TARGET_DIR, "ai_patch.diff");
    writeFileSafe(diffPath, aiRaw);

    const validation = validateUnifiedDiff(aiRaw);
    writeFileSafe(path.join(TARGET_DIR, "ai_patch_validation.txt"), [
      `attempt: ${attempt + 1}`,
      `valid: ${validation.valid}`,
      `errors: ${validation.errors.join("; ")}`,
      "",
    ].join("\n"));

    if (validation.valid) {
      console.log("\n=== Apply unified diff ===");
      if (tryApplyUnifiedDiff(diffPath)) {
        applied = true;
        break;
      } else {
        console.warn("⚠️ Unified diff failed to apply with all strategies.");
      }
    } else {
      // Save for debugging
      writeFileSafe(path.join(TARGET_DIR, "ai_bad_patch.diff"), aiRaw);
      console.warn("⚠️ Invalid unified diff, will try fallback or retry.\nIssues:", validation.errors.join(" | "));
    }

    // Fallback: file-blocks
    console.log("ℹ️ Trying file-block fallback…");
    if (tryApplyFileBlocks(aiRaw)) {
      applied = true;
      break;
    }

    attempt++;
  }

  if (!applied) {
    console.warn("⚠️ AI did not produce an applicable change this run.");
    process.exit(0); // not a hard failure; let the loop try in next run
  }

  console.log("\n=== Commit & push ===");
  sh(`git -C ${TARGET_DIR} add -A`);
  try {
    sh(`git -C ${TARGET_DIR} commit -m "AI iteration: ${new Date().toISOString()}"`);
  } catch {
    console.log("ℹ️ Nothing to commit (no changes).");
  }
  sh(`git -C ${TARGET_DIR} push origin ${TARGET_BRANCH}`);

  console.log("✅ Done.");
})().catch((err) => {
  console.error("❌ Agent error:", err);
  process.exit(1);
});
