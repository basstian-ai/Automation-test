#!/usr/bin/env node

// Node 20+: global fetch is available
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import process from "process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- ENV & CONSTANTS ----------
const {
  OPENAI_API_KEY,
  VERCEL_TOKEN,
  VERCEL_TEAM_ID,
  VERCEL_PROJECT,       // can be projectId or slug
  TARGET_REPO,          // owner/name
  TARGET_BRANCH = "main",
  PAT_TOKEN
} = process.env;

const MAX_MODEL_RETRIES = 2;
const MODEL = "gpt-4o-mini";

// ---------- UTIL ----------
function assertEnv(name, val) {
  if (!val || String(val).trim() === "") {
    console.error(`❌ Missing env: ${name}`);
    process.exit(1);
  }
}

function run(cmd, opts = {}) {
  const merged = { stdio: "pipe", encoding: "utf8", ...opts };
  console.log(`$ ${cmd}`);
  return execSync(cmd, merged).trim();
}

function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

function writeFile(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function logSection(title) {
  console.log(`\n=== ${title} ===`);
}

// ---------- PRE-FLIGHT ----------
[
  ["OPENAI_API_KEY", OPENAI_API_KEY],
  ["VERCEL_TOKEN", VERCEL_TOKEN],
  ["VERCEL_TEAM_ID", VERCEL_TEAM_ID],
  ["VERCEL_PROJECT", VERCEL_PROJECT],
  ["TARGET_REPO", TARGET_REPO],
  ["PAT_TOKEN", PAT_TOKEN],
].forEach(([n, v]) => assertEnv(n, v));

// Ensure we are in mono-repo root and target repo is present at ./target
const TARGET_DIR = path.resolve(process.cwd(), "target");
if (!exists(TARGET_DIR)) {
  console.error(`❌ Missing ./target checkout. Your workflow must checkout ${TARGET_REPO} into ./target`);
  process.exit(1);
}

// ---------- GIT PREP ----------
logSection("Sync target repo");
try {
  run(`git -C ${TARGET_DIR} fetch origin ${TARGET_BRANCH}`);
  run(`git -C ${TARGET_DIR} checkout ${TARGET_BRANCH}`);
  run(`git -C ${TARGET_DIR} reset --hard origin/${TARGET_BRANCH}`);
} catch (e) {
  console.error("❌ Failed to sync target repo:", e.message);
  process.exit(1);
}

// ---------- VERCEL ----------
async function getLatestDeployment() {
  // Try by projectId first, then slug
  const urls = [
    `https://api.vercel.com/v6/deployments?projectId=${encodeURIComponent(VERCEL_PROJECT)}&teamId=${encodeURIComponent(VERCEL_TEAM_ID)}&limit=1`,
    `https://api.vercel.com/v6/deployments?project=${encodeURIComponent(VERCEL_PROJECT)}&teamId=${encodeURIComponent(VERCEL_TEAM_ID)}&limit=1`,
  ];
  for (const url of urls) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${VERCEL_TOKEN}` }});
    if (res.ok) {
      const data = await res.json();
      if (data?.deployments?.length) return data.deployments[0];
    }
  }
  throw new Error("No deployments found or invalid VERCEL_PROJECT/VERCEL_TEAM_ID");
}

async function getDeploymentEvents(uid) {
  // v2/events returns NDJSON or big JSON array depending on endpoint; we’ll fetch as text for robustness
  const url = `https://api.vercel.com/v2/deployments/${encodeURIComponent(uid)}/events?teamId=${encodeURIComponent(VERCEL_TEAM_ID)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${VERCEL_TOKEN}` }});
  if (!res.ok) throw new Error(`Events fetch failed ${res.status}`);
  return await res.text();
}

// ---------- OPENAI ----------
async function callOpenAI(messages) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      messages
    })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI HTTP ${res.status}: ${text}`);
  }
  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content ?? "";
  return String(content).trim();
}

function extractCodeFence(content, lang) {
  // Extract ```<lang> ... ```
  const fence = new RegExp("```" + lang + "\\s*\\n([\\s\\S]*?)```", "m");
  const m = content.match(fence);
  return m ? m[1].trim() : null;
}

function extractAnyDiff(content) {
  // Accept ```diff``` or plain unified diff without fences
  const fenced = extractCodeFence(content, "diff");
  if (fenced) return fenced;
  // raw diff? must contain "diff --git"
  if (content.includes("diff --git")) return content;
  return null;
}

function extractEditsJSON(content) {
  const jsonBlock = extractCodeFence(content, "json");
  if (!jsonBlock) return null;
  try {
    const parsed = JSON.parse(jsonBlock);
    if (Array.isArray(parsed?.edits)) return parsed;
  } catch { /* ignore */ }
  return null;
}

// ---------- APPLY PATCH / EDITS ----------
function tryApplyDiff(diffText) {
  const diffPath = path.join(TARGET_DIR, "ai_patch.diff");
  writeFile(diffPath, diffText);

  try {
    // 1) safest first: 3-way merge
    run(`git -C ${TARGET_DIR} apply --3way --whitespace=fix ${diffPath}`);
    return true;
  } catch {
    try {
      // 2) normal apply
      run(`git -C ${TARGET_DIR} apply --whitespace=fix ${diffPath}`);
      return true;
    } catch {
      try {
        // 3) patch fallback
        // note: patch reads from stdin; we need to run in shell
        execSync(`patch -p1 -d ${TARGET_DIR} < ${diffPath}`, { stdio: "pipe", encoding: "utf8" });
        return true;
      } catch (e3) {
        console.error("❌ All diff apply strategies failed:", e3.message);
        return false;
      }
    }
  }
}

function applyEditsJSON(edits) {
  // { edits:[{ path, content }...] }
  let wrote = 0;
  for (const e of edits.edits) {
    if (!e.path || typeof e.content !== "string") continue;
    const abs = path.join(TARGET_DIR, e.path);
    writeFile(abs, e.content);
    console.log(`✍️  wrote ${e.path}`);
    wrote++;
  }
  return wrote > 0;
}

// ---------- PROMPTS ----------
function buildSystemPrompt() {
  return {
    role: "system",
    content:
`You are an autonomous senior full-stack engineer.
Target stack: Next.js (v10.x), Node 20, Vercel hosting.
Goal:
1) If the last Vercel deployment is ERROR -> analyze logs and produce a fix.
2) If the last Vercel deployment is READY -> implement a small, safe PIM improvement (no breaking changes).

Return your output in ONE of these two formats (no commentary outside code fences):

(Preferred)
\`\`\`diff
<unified diff, starting with "diff --git">
\`\`\`

(Alternative)
\`\`\`json
{"edits":[{"path":"relative/path/file.ext","content":"FULL new file content"}, ...]}
\`\`\`

Rules:
- No prose outside the single code fence.
- Diff must be valid unified diff for 'git apply'.
- For JSON edits, include FULL file contents (not snippets).
- Keep changes minimal and safe.`
  };
}

function buildUserPrompt(deploy, eventsText) {
  const state = String(deploy.state || "").toUpperCase();
  // Trim events to keep prompts small
  const trimmedEvents = eventsText.length > 30000 ? (eventsText.slice(0, 30000) + "\n...[truncated]") : eventsText;

  // optional small context: list of top-level files to help the model aim patches
  let fileList = "";
  try { fileList = run(`git -C ${TARGET_DIR} ls-files | sed -e 's/^/ - /'`); } catch {}
  if (fileList.length > 4000) fileList = fileList.slice(0, 4000) + "\n...[truncated]";

  return {
    role: "user",
    content:
`Latest deployment state: ${state}
Deployment uid: ${deploy.uid}
Repo: ${TARGET_REPO} @ ${TARGET_BRANCH}

Top-level tracked files:
${fileList || "(list unavailable)"}

Recent Vercel events/logs:
${trimmedEvents}

Please return ONLY a single code fence as per the system rules.`
  };
}

// ---------- MAIN ----------
(async () => {
  try {
    logSection("Fetch latest Vercel deployment & logs");
    const latest = await getLatestDeployment();
    const events = await getDeploymentEvents(latest.uid);
    const logsPath = path.join(TARGET_DIR, "vercel_build.log");
    writeFile(logsPath, events);
    console.log(`📝 Build logs saved: ${logsPath}`);

    const sys = buildSystemPrompt();
    const usr = buildUserPrompt(latest, events);

    let content = "";
    let applied = false;

    for (let attempt = 0; attempt <= MAX_MODEL_RETRIES; attempt++) {
      if (attempt > 0) console.log(`🔁 Retry AI (${attempt}/${MAX_MODEL_RETRIES})...`);
      content = await callOpenAI([sys, usr]);

      const diff = extractAnyDiff(content);
      if (diff) {
        console.log("🧩 Got diff from AI, applying...");
        applied = tryApplyDiff(diff);
        if (applied) break;
        // If diff application failed, augment prompt for next retry
        usr.content += `

Previous diff failed to apply cleanly. Reasons could include line offsets or file not found.
Please regenerate a SMALLER, minimal diff that applies cleanly.`;
        continue;
      }

      const edits = extractEditsJSON(content);
      if (edits) {
        console.log("🧩 Got JSON edits from AI, writing files...");
        applied = applyEditsJSON(edits);
        if (applied) break;
        usr.content += `

Your JSON "edits" couldn't be applied. Ensure each edit has { "path", "content" } with full file content.`;
        continue;
      }

      // Neither diff nor edits recognized -> ask AI to comply
      usr.content += `

You did not return a valid \`\`\`diff\`\`\` or \`\`\`json\`\`\` block. Return exactly one code fence only.`;
    }

    if (!applied) {
      console.warn("⚠️ AI did not produce an applicable change this run. Exiting without failure.");
      process.exit(0); // don't fail the job; just no-op this iteration
    }

    // GIT COMMIT & PUSH
    logSection("Commit & push");
    try {
      run(`git -C ${TARGET_DIR} config user.name "github-actions[bot]"`);
      run(`git -C ${TARGET_DIR} config user.email "github-actions[bot]@users.noreply.github.com"`);
      run(`git -C ${TARGET_DIR} add -A`);
      // Avoid empty commit failure
      try { run(`git -C ${TARGET_DIR} commit -m "AI iteration: ${new Date().toISOString()}"`); }
      catch { console.log("ℹ️ No changes to commit."); }
      run(`git -C ${TARGET_DIR} push origin ${TARGET_BRANCH}`);
      console.log("✅ Changes pushed");
    } catch (e) {
      console.error("❌ Failed to push changes:", e.message);
      // Don’t hard-fail the job if push fails due to race; next run will resync
      process.exit(0);
    }
  } catch (err) {
    console.error("❌ ERROR:", err.message);
    process.exit(1);
  }
})();