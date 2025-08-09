#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require("fs");
const path = require("path");
const { execSync, execFileSync } = require("child_process");
const process = require("process");

// Node 20+ has global fetch; if not, you can uncomment the next line to polyfill
// const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const {
  OPENAI_API_KEY,
  VERCEL_TOKEN,
  VERCEL_TEAM_ID,
  VERCEL_PROJECT,              // projectId or slug
  TARGET_REPO,                 // e.g. basstian-ai/simple-pim-1754492683911
  TARGET_BRANCH = "main",
  PAT_TOKEN
} = process.env;

const TARGET_DIR = path.resolve(process.cwd(), "target");
const MODEL = "gpt-4o-mini";
const MAX_MODEL_RETRIES = 2;
const MAX_TEXT = 30000; // safety bound for logs/context

// ---------- utils ----------
function assertEnv(name, val) {
  if (!val || String(val).trim() === "") {
    console.error(`❌ Missing env: ${name}`);
    process.exit(1);
  }
}
function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }
function readSafe(p) { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } }
function writeFile(abs, content) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}
function run(cmd, opts = {}) {
  const merged = { stdio: "pipe", encoding: "utf8", ...opts };
  console.log(`$ ${cmd}`);
  return execSync(cmd, merged).trim();
}
function section(title) { console.log(`\n=== ${title} ===`); }

[
  ["OPENAI_API_KEY", OPENAI_API_KEY],
  ["VERCEL_TOKEN", VERCEL_TOKEN],
  ["VERCEL_TEAM_ID", VERCEL_TEAM_ID],
  ["VERCEL_PROJECT", VERCEL_PROJECT],
  ["TARGET_REPO", TARGET_REPO],
  ["PAT_TOKEN", PAT_TOKEN],
].forEach(([n, v]) => assertEnv(n, v));

if (!exists(TARGET_DIR)) {
  console.error(`❌ ./target is missing. Checkout ${TARGET_REPO} into ./target before running.`);
  process.exit(1);
}

// ---------- git prep ----------
section("Sync target repo");
try {
  run(`git -C ${TARGET_DIR} fetch origin ${TARGET_BRANCH}`);
  run(`git -C ${TARGET_DIR} checkout ${TARGET_BRANCH}`);
  run(`git -C ${TARGET_DIR} reset --hard origin/${TARGET_BRANCH}`);
} catch (e) {
  console.error("❌ Failed to sync target repo:", e.message);
  process.exit(1);
}

// ---------- vercel ----------
async function getLatestDeployment() {
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
  const url = `https://api.vercel.com/v2/deployments/${encodeURIComponent(uid)}/events?teamId=${encodeURIComponent(VERCEL_TEAM_ID)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${VERCEL_TOKEN}` }});
  if (!res.ok) throw new Error(`Events fetch failed ${res.status}`);
  return await res.text();
}

// ---------- local build probe ----------
function localBuildProbe() {
  section("Local build probe (npm ci && npm run build --if-present)");
  const opts = { cwd: TARGET_DIR, stdio: "pipe", encoding: "utf8" };
  let installLog = "";
  let buildLog = "";
  try {
    try {
      installLog = execSync("npm ci", opts).toString();
    } catch (e) {
      installLog = (e.stdout?.toString() || "") + (e.stderr?.toString() || "");
      // fallback to npm i
      try {
        installLog += "\n-- fallback npm i --\n";
        installLog += execSync("npm i", opts).toString();
      } catch (e2) {
        installLog += "\n(fallback npm i failed)\n";
      }
    }
    try {
      buildLog = execSync("npm run build --if-present", opts).toString();
    } catch (e) {
      buildLog = (e.stdout?.toString() || "") + (e.stderr?.toString() || "");
    }
  } catch (e) {
    // shouldn't happen, but keep going
  }
  const trimmedInstall = installLog.slice(0, MAX_TEXT);
  const trimmedBuild = buildLog.slice(0, MAX_TEXT);
  const combined = `--- npm install output ---\n${trimmedInstall}\n--- npm run build output ---\n${trimmedBuild}`;
  writeFile(path.join(TARGET_DIR, "local_build.log"), combined);
  return combined;
}

// ---------- OpenAI ----------
async function callOpenAI(messages) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ model: MODEL, temperature: 0, messages })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI HTTP ${res.status}: ${text}`);
  }
  const json = await res.json();
  return String(json?.choices?.[0]?.message?.content || "").trim();
}

function codeFence(content, lang) {
  const re = new RegExp("```" + lang + "\\s*\\n([\\s\\S]*?)```", "m");
  const m = content.match(re);
  return m ? m[1].trim() : null;
}
function extractDiff(content) {
  const fenced = codeFence(content, "diff");
  if (fenced) return fenced;
  if (content.includes("diff --git")) return content;
  return null;
}
function extractEdits(content) {
  const json = codeFence(content, "json");
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed?.edits)) return parsed;
  } catch {}
  return null;
}

// ---------- patch application ----------
function applyDiff(diffText) {
  const diffPath = path.join(TARGET_DIR, "ai_patch.diff");
  writeFile(diffPath, diffText);
  try {
    run(`git -C ${TARGET_DIR} apply --3way --whitespace=fix ${diffPath}`);
    return true;
  } catch {
    try {
      run(`git -C ${TARGET_DIR} apply --whitespace=fix ${diffPath}`);
      return true;
    } catch {
      try {
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

// ---------- prompt building ----------
function fileList() {
  try {
    const out = run(`git -C ${TARGET_DIR} ls-files | sed -e 's/^/ - /'`);
    return out.length > 4000 ? out.slice(0, 4000) + "\n...[truncated]" : out;
  } catch { return ""; }
}
function readContextFiles() {
  const picks = [
    "package.json",
    "next.config.js",
    "pages/index.js",
    "pages/_app.js",
    "pages/api/products.js",
    "pages/admin.js",
  ];
  const acc = [];
  for (const rel of picks) {
    const abs = path.join(TARGET_DIR, rel);
    if (exists(abs)) {
      let txt = readSafe(abs);
      if (rel === "package.json") {
        // guard: remove comments which break JSON parsing downstream
        txt = txt.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      }
      const safe = txt.length > 6000 ? txt.slice(0, 6000) + "\n...[truncated]" : txt;
      acc.push({ path: rel, content: safe });
    }
  }
  return acc;
}

function systemPrompt() {
  return {
    role: "system",
    content: `
You are an autonomous senior full-stack engineer (Next.js 10.x, Node 20, Vercel).
Goal:
- If the last Vercel deployment is ERROR -> analyze logs and FIX the cause.
- If READY -> implement one small, safe PIM improvement (no breaking changes).

Return EXACTLY ONE code fence in ONE of these formats:

(Preferred)
\`\`\`diff
<unified diff starting with "diff --git">
\`\`\`

(Alternative)
\`\`\`json
{"edits":[{"path":"relative/file","content":"FULL updated file content"}, ...]}
\`\`\`

Rules:
- No prose outside the single code fence.
- For diffs: valid unified diff that applies with \`git apply\`.
- For JSON edits: provide FULL file contents (not snippets).
- Keep change minimal and safe.
`.trim()
  };
}

function userPrompt(state, deploymentUid, vercelEvents, buildOutput) {
  const files = fileList();
  const contexts = readContextFiles()
    .map(f => `--- ${f.path} ---\n${f.content}`)
    .join("\n\n");
  const trimmedVercel = vercelEvents.slice(0, MAX_TEXT);
  const trimmedBuild = buildOutput.slice(0, MAX_TEXT);

  return {
    role: "user",
    content: `
Latest Vercel deployment state: ${String(state || "").toUpperCase()}
Deployment UID: ${deploymentUid}
Repo: ${TARGET_REPO} @ ${TARGET_BRANCH}

Top-level files:
${files || "(n/a)"}

Key source/context:
${contexts || "(n/a)"}

Recent Vercel events/logs:
${trimmedVercel || "(n/a)"}

Local build probe output:
${trimmedBuild || "(n/a)"}

Return exactly one code fence as per the system rules above.
`.trim()
  };
}

// ---------- main ----------
(async () => {
  try {
    section("Fetch latest Vercel deployment & logs");
    const deployment = await getLatestDeployment();
    const events = await getDeploymentEvents(deployment.uid);
    const logsPath = path.join(TARGET_DIR, "vercel_build.log");
    writeFile(logsPath, events);
    console.log(`📝 Build logs saved: ${logsPath}`);

    // Local build probe to surface immediate issues (e.g., invalid package.json, missing deps)
    const buildOut = localBuildProbe();

    const sys = systemPrompt();
    const usrBase = userPrompt(deployment.state, deployment.uid, events, buildOut);

    let applied = false;
    let prompt = { ...usrBase };

    for (let attempt = 0; attempt <= MAX_MODEL_RETRIES; attempt++) {
      if (attempt > 0) console.log(`🔁 Retry AI (${attempt}/${MAX_MODEL_RETRIES})...`);
      const content = await callOpenAI([sys, prompt]);

      const diff = extractDiff(content);
      if (diff) {
        console.log("🧩 Got diff from AI, applying...");
        applied = applyDiff(diff);
        if (applied) break;
        prompt = {
          role: "user",
          content:
`${usrBase.content}

The diff did not apply. Please regenerate a SMALLER minimal fix that cleanly applies.
If diffs keep failing, return JSON {"edits":[...]} with FULL file contents instead.`
        };
        continue;
      }

      const edits = extractEdits(content);
      if (edits) {
        console.log("🧩 Got JSON edits from AI, writing files...");
        applied = applyEditsJSON(edits);
        if (applied) break;
        prompt = {
          role: "user",
          content:
`${usrBase.content}

Your JSON "edits" couldn't be applied (missing path/content or incomplete files).
Please return a corrected JSON edits block with FULL file contents.`
        };
        continue;
      }

      // Neither format recognized
      prompt = {
        role: "user",
        content:
`${usrBase.content}

You did not return a \`\`\`diff\`\`\` or \`\`\`json\`\`\` block. Return exactly ONE code fence with a valid diff OR JSON edits.`
      };
    }

    if (!applied) {
      console.warn("⚠️ No applicable change this run. Exiting without failure.");
      process.exit(0);
    }

    section("Commit & push");
    try {
      run(`git -C ${TARGET_DIR} config user.name "github-actions[bot]"`);
      run(`git -C ${TARGET_DIR} config user.email "github-actions[bot]@users.noreply.github.com"`);
      run(`git -C ${TARGET_DIR} add -A`);
      try { run(`git -C ${TARGET_DIR} commit -m "AI iteration: ${new Date().toISOString()}"`); }
      catch { console.log("ℹ️ No changes to commit."); }
      run(`git -C ${TARGET_DIR} push origin ${TARGET_BRANCH}`);
      console.log("✅ Changes pushed");
    } catch (e) {
      console.error("❌ Push failed:", e.message);
      process.exit(0);
    }
  } catch (err) {
    console.error("❌ ERROR:", err.message);
    process.exit(1);
  }
})();
