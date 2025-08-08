#!/usr/bin/env node

// automation/ai-iter-agent.cjs

const fs = require("fs");
const { execSync } = require("child_process");
const path = require("path");

// --- Helper functions ---
function trySh(cmd) {
  console.log(`$ ${cmd}`);
  try {
    return execSync(cmd, { stdio: "inherit" });
  } catch (err) {
    console.error(`⚠️ Command failed: ${cmd}`);
    return null;
  }
}

function stripJsonComments(txt) {
  return txt
    .replace(/\/\*[\s\S]*?\*\//g, "")      // Remove /* block comments */
    .replace(/(^|[^:])\/\/.*$/gm, "$1");   // Remove // line comments not after a colon
}

function repairPackageJsonIfNeeded() {
  const pkgPath = path.join(process.cwd(), "package.json");
  if (!fs.existsSync(pkgPath)) return;
  const raw = fs.readFileSync(pkgPath, "utf8");
  try {
    JSON.parse(raw);
    return; // Already valid
  } catch {
    console.log("🛠️ Detected invalid package.json, attempting repair…");
  }
  const cleaned = stripJsonComments(raw);
  try {
    JSON.parse(cleaned);
    fs.writeFileSync(pkgPath, cleaned);
    console.log("✅ package.json repaired by stripping comments");
    return;
  } catch {}
  // Fallback: minimal working package.json
  const fallback = {
    name: "next-pim-app",
    private: true,
    scripts: { dev: "next dev", build: "next build", start: "next start" },
    dependencies: {
      next: "10.2.3",
      react: "^17.0.2",
      "react-dom": "^17.0.2",
      axios: "^1.6.8",
      "isomorphic-unfetch": "^3.1.0"
    }
  };
  fs.writeFileSync(pkgPath, JSON.stringify(fallback, null, 2) + "\n");
  console.log("🛟 Wrote minimal fallback package.json");
}

// --- Startup info ---
console.log(`📂 CWD: ${process.cwd()}`);
trySh("git remote -v");
const branch = execSync("git rev-parse --abbrev-ref HEAD").toString().trim();
console.log(`🌿 Branch: ${branch}`);

// --- Preflight repair ---
repairPackageJsonIfNeeded();

// --- Install deps ---
trySh("npm ci || npm i");

// --- Fetch Vercel logs (placeholder: keep your existing logic here) ---
console.log("🔄 Fetching Vercel build logs...");
// TODO: Insert your current fetch/build log analysis + AI patch logic here

// --- Decide mode ---
const mode = "FIX"; // Or FEATURE based on build status
console.log(`🔍 Mode: ${mode}`);

// --- Apply AI patch (placeholder for your existing code) ---
console.log("🤖 Generating patch...");
/*
Your patch application logic here:
1. Generate diff from AI
2. git apply --check
3. Commit + push if valid
*/

// --- Push changes ---
console.log("✅ Changes pushed (simulation)");