'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { getExportFacts } = require('./fileFacts.cjs');

/** ---------- Shell helpers ---------- */
function run(cmd, opts = {}) {
  return execSync(cmd, { stdio: 'inherit', ...opts });
}

/** ---------- Package manager & build ---------- */
function pickPackageManager(repoDir) {
  const has = f => fs.existsSync(path.join(repoDir, f));
  if (has('pnpm-lock.yaml')) return 'pnpm';
  if (has('yarn.lock')) return 'yarn';
  return 'npm';
}

function tryLocalBuild(repoDir) {
  const pm = pickPackageManager(repoDir);

  // Ensure Node child processes (npm/yarn/pnpm/next) get the legacy provider
  const env = {
    ...process.env,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, '--openssl-legacy-provider'].filter(Boolean).join(' ')
  };

  if (pm === 'npm') {
    run('npm ci', { cwd: repoDir, env });
    run('npx next build', { cwd: repoDir, env });
  } else if (pm === 'yarn') {
    run('yarn install --frozen-lockfile', { cwd: repoDir, env });
    run('yarn next build', { cwd: repoDir, env });
  } else {
    run('pnpm install --frozen-lockfile', { cwd: repoDir, env });
    run('pnpm next build', { cwd: repoDir, env });
  }
}

/** ---------- Diff helpers ---------- */
function sanitizeDiff(raw) {
  if (!raw) return '';
  let s = String(raw);

  // Normalize
  s = s.replace(/^\uFEFF/, ''); // BOM
  s = s.replace(/\r/g, '');     // CRLF → LF

  // Remove fenced code blocks (e.g., ```diff ... ```)
  s = s.replace(/^\s*```[^\n]*\n[\s\S]*?\n```/gm, '');

  // Remove "*** Begin/End Patch" wrappers
  s = s.replace(/^\s*\*{3}.*?End Patch\s*$/gms, '');

  // Keep only from the FIRST "diff --git" ...
  const first = s.indexOf('diff --git ');
  if (first >= 0) s = s.slice(first);

  // ... and drop anything after known non-diff sections
  const cutMarks = [
    '\n# TEST PLAN',
    '\n#TEST PLAN',
    '\n# Changes Summary',
    '\n# CHANGES SUMMARY',
    '\n#Changes Summary',
    '\n#CHANGES SUMMARY',
    '\n*** End Patch',
    '\n```'
  ];
  let cutPos = s.length;
  for (const mark of cutMarks) {
    const p = s.indexOf(mark);
    if (p !== -1 && p < cutPos) cutPos = p;
  }
  s = s.slice(0, cutPos);

  // Fast-fail if no unified diff remains
  if (!s.includes('diff --git ')) {
    throw new Error('Sanitized output did not contain a unified git diff.');
  }

  // Ensure trailing newline
  if (!s.endsWith('\n')) s += '\n';
  return s;
}

function getRepoTree(repoDir) {
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(path.relative(repoDir, full).replace(/\\/g, '/'));
    }
  })(repoDir);
  return out;
}

function getRepoTreeSet(repoDir) {
  return new Set(getRepoTree(repoDir));
}

function splitDiffIntoFiles(sanitized) {
  // Split into per-file chunks (keep the "diff --git" marker with each)
  const normalized = sanitized.replace(/^diff --git /, '\n\0diff --git ');
  const parts = normalized.split(/\n(?=diff --git )/g);
  return parts.map(p => p.replace(/^\0/, '')).filter(Boolean);
}

function parseChunkPaths(chunk) {
  // Extract a/b paths from "diff --git a/... b/..." header
  const m = chunk.match(/^diff --git a\/(.+?) b\/(.+?)$/m);
  if (!m) return { a: null, b: null, type: 'unknown' };
  const a = m[1];
  const b = m[2];

  // Detect file action
  const isDeleted = /(^|\n)deleted file mode /m.test(chunk) || /(^|\n)\+\+\+ \/dev\/null/m.test(chunk);
  const isNew     = /(^|\n)new file mode /m.test(chunk) || /(^|\n)--- \/dev\/null/m.test(chunk);

  let type = 'modify';
  if (isDeleted) type = 'delete';
  else if (isNew) type = 'add';

  return { a, b, type };
}

function applyChunk(repoDir, tmpName) {
  const variants = [
    // try without 3-way first (better for brand-new files)
    ['git apply --check -p1', 'git apply -p1 --whitespace=fix'],
    ['git apply --check',     'git apply --whitespace=fix'],
    ['git apply --check -p0', 'git apply -p0 --whitespace=fix'],
    // then try 3-way merge
    ['git apply --check -p1', 'git apply -p1 --index -3 --whitespace=fix'],
    ['git apply --check',     'git apply --index -3 --whitespace=fix'],
    ['git apply --check -p0', 'git apply -p0 --index -3 --whitespace=fix'],
  ];
  for (const [checkCmd, applyCmd] of variants) {
    try {
      run(`${checkCmd} ${tmpName}`, { cwd: repoDir });
      run(`${applyCmd} ${tmpName}`, { cwd: repoDir });
      return true;
    } catch (_) {}
  }
  return false;
}

function extractAddedContentFromChunk(chunk) {
  const out = [];
  let inHunk = false;
  for (const line of chunk.split('\n')) {
    if (line.startsWith('@@')) { inHunk = true; continue; }
    if (!inHunk) continue;
    if (line.startsWith('+') && !line.startsWith('+++ ')) out.push(line.slice(1));
  }
  return out.join('\n') + (out.length ? '\n' : '');
}

function reconstructNewFileFromChunk(chunk) {
  const lines = chunk.split('\n');
  const out = [];
  let inHunk = false;

  for (const line of lines) {
    if (line.startsWith('@@')) { inHunk = true; continue; }
    if (!inHunk) continue;
    if (line.startsWith('+++ ') || line.startsWith('--- ')) continue;
    if (line.startsWith('-')) continue;
    if (line.startsWith('+')) { out.push(line.slice(1)); continue; }
    if (line.startsWith(' ')) { out.push(line.slice(1)); continue; }
  }

  // If no @@ hunks or nothing accumulated, fall back to plus-only lines
  if (!inHunk || out.length === 0) {
    const plusOnly = [];
    let seenHeaders = false;
    for (const line of lines) {
      if (line.startsWith('+++ ') || line.startsWith('--- ')) { seenHeaders = true; continue; }
      if (!seenHeaders) continue;
      if (line.startsWith('+') && !line.startsWith('+++ ')) {
        plusOnly.push(line.slice(1));
      }
    }
    if (plusOnly.length > 0) return plusOnly.join('\n') + '\n';
  }

  return out.join('\n') + (out.length ? '\n' : '');
}

/** ---------- Heuristic fallbacks when git apply fails ---------- */
function ensureDefaultExportSlugifyShim(absPath) {
  if (!fs.existsSync(absPath)) return false;
  let txt = fs.readFileSync(absPath, 'utf8');
  if (/export\s+default\s+slugify\s*;?/m.test(txt)) return false; // already has default
  const needsNL = txt.length && !txt.endsWith('\n');
  txt += (needsNL ? '\n' : '') + '\n// default export shim for consumers using default import\nexport default slugify;\n';
  fs.writeFileSync(absPath, txt, 'utf8');
  return true;
}

function rewriteDefaultSlugifyImports(absPath) {
  if (!fs.existsSync(absPath)) return false;
  if (!/\.(js|jsx|ts|tsx)$/.test(absPath)) return false;
  let txt = fs.readFileSync(absPath, 'utf8');
  const before = txt;
  // Replace: import slugify from '.../slugify'
  txt = txt.replace(/import\s+slugify\s+from\s+(['"][^'"]*\/slugify['"])\s*;?/g, 'import { slugify } from $1;');
  if (txt !== before) {
    fs.writeFileSync(absPath, txt, 'utf8');
    return true;
  }
  return false;
}

function fallbackApply(repoDir, { a, b, type, chunk }) {
  try {
    if (type === 'delete' && a) {
      const abs = path.join(repoDir, a);
      if (fs.existsSync(abs)) { fs.rmSync(abs, { force: true }); return true; }
      return false;
    }
    if (type === 'add' && b) {
      const abs = path.join(repoDir, b);
      if (!fs.existsSync(abs)) {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, extractAddedContentFromChunk(chunk), 'utf8');
        return true;
      }
      return false;
    }
    if (type === 'modify' && a) {
      // Known heuristics first
      if (/\/lib\/slugify\.(js|ts)$/.test(a)) {
        const abs = path.join(repoDir, a);
        return ensureDefaultExportSlugifyShim(abs);
      }
      if (/\/pages\/.*\.(js|jsx|ts|tsx)$/.test(a)) {
        const abs = path.join(repoDir, a);
        if (rewriteDefaultSlugifyImports(abs)) return true;
      }
      // Last resort: reconstruct the "after" file from the diff and overwrite
      const abs = path.join(repoDir, a);
      if (fs.existsSync(abs)) {
        let nextText = reconstructNewFileFromChunk(chunk);
        if (!nextText || nextText.trim().length === 0) {
          nextText = extractAddedContentFromChunk(chunk); // plus-only fallback
        }
        if (nextText && nextText.trim().length > 0) {
          fs.writeFileSync(abs, nextText, 'utf8');
          return true;
        }
      }
    }
  } catch (_) {}
  return false;
}

/**
 * Apply a unified diff robustly:
 * - sanitize
 * - split into per-file chunks
 * - skip chunks that target non-existent files (for modify/delete)
 * - try multiple -p modes per chunk
 * - if apply fails, run heuristics (add/delete/slugify/overwrite)
 * - succeed if at least one chunk applies
 */
function applyUnifiedDiff(diffText, repoDir) {
  const sanitized = sanitizeDiff(diffText);
  const chunks = splitDiffIntoFiles(sanitized);
  const treeSet = getRepoTreeSet(repoDir);

  let applied = 0;
  const skipped = [];
  const heuristic = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i].trim();
    if (!chunk.startsWith('diff --git ')) continue;

    const { a, b, type } = parseChunkPaths(chunk);

    // Skip deletes/modifies for files that don't exist locally
    if (type === 'delete' && a && !treeSet.has(a)) {
      skipped.push({ i, reason: 'delete-nonexistent', path: a });
      continue;
    }
    if (type === 'modify' && a && !treeSet.has(a)) {
      skipped.push({ i, reason: 'modify-nonexistent', path: a });
      continue;
    }

    // Write chunk to a temp file and try to apply
    const tmp = path.join(repoDir, `.ai_patch_${i}.diff`);
    fs.writeFileSync(tmp, chunk + (chunk.endsWith('\n') ? '' : '\n'), 'utf8');

    let ok = false;
    try {
      ok = applyChunk(repoDir, path.basename(tmp));
    } catch (_) {
      ok = false;
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }

    if (ok) {
      applied++;
      // keep repo tree up to date
      if (type === 'delete' && a) treeSet.delete(a);
      if (type === 'add' && b) treeSet.add(b);
      continue;
    }

    // Heuristic fallback
    const didHeuristic = fallbackApply(repoDir, { a, b, type, chunk });
    if (didHeuristic) {
      applied++;
      heuristic.push({ i, reason: 'heuristic-applied', path: a || b, type });
      if (type === 'delete' && a) treeSet.delete(a);
      if (type === 'add' && b) treeSet.add(b);
      continue;
    }

    skipped.push({ i, reason: 'git-apply-failed', path: a || b });
  }

  if (applied === 0) {
    const head = sanitized.split('\n').slice(0, 120).join('\n');
    throw new Error(
      `No patch chunks applied. Skipped: ${JSON.stringify(skipped)}\n` +
      `diff head:\n${head}`
    );
  }

  if (heuristic.length) {
    console.log('ℹ️  Heuristic fixes applied:', heuristic);
  }
  if (skipped.length) {
    console.log('ℹ️  Some chunks skipped:', skipped);
  }
}

/** ---------- Repo helpers ---------- */
function commitAndPush(message, repoDir) {
  const name = process.env.GIT_USER_NAME || 'automation-bot';
  const email = process.env.GIT_USER_EMAIL || 'automation-bot@users.noreply.github.com';
  run(`git config user.name "${name}"`, { cwd: repoDir });
  run(`git config user.email "${email}"`, { cwd: repoDir });

  run('git add -A', { cwd: repoDir });
  try {
    run(`git diff --cached --quiet || git commit -m "${message.replace(/"/g, '\\"')}"`, { cwd: repoDir });
  } catch {}

  try { run('git push', { cwd: repoDir }); } catch {}
}

function collectRepoFiles(repoDir, paths = []) {
  return paths.map(p => {
    const abs = path.join(repoDir, p);
    const content = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
    return { path: p, content, exportFacts: getExportFacts(abs) };
  });
}

function readRoadmap(repoDir) {
  const p = path.join(repoDir, 'roadmap.md');
  if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  const alt = path.join(repoDir, 'ROADMAP.md');
  if (fs.existsSync(alt)) return fs.readFileSync(alt, 'utf8');
  return '# Roadmap\n\n(No roadmap.md found)';
}

/** ---------- Pre-build deterministic fixes ---------- */
function ensureDefaultExportSlugify(repoDir) {
  const abs = path.join(repoDir, 'lib/slugify.js');
  return ensureDefaultExportSlugifyShim(abs);
}

function fixDuplicateApiRoutes(repoDir) {
  // When both pages/api/<name>.js and pages/api/<name>/index.js exist, keep the index.js
  const names = ['attribute-groups', 'attributes', 'products']; // extend if needed
  const touched = [];
  for (const name of names) {
    const file = path.join(repoDir, `pages/api/${name}.js`);
    const idx  = path.join(repoDir, `pages/api/${name}/index.js`);
    if (fs.existsSync(file) && fs.existsSync(idx)) {
      fs.rmSync(file, { force: true });
      touched.push(`deleted duplicate pages/api/${name}.js (kept /${name}/index.js)`);
    }
  }
  return touched;
}

function ensureHealthApiValid(repoDir) {
  const rel = 'pages/api/health.js';
  const abs = path.join(repoDir, rel);
  if (!fs.existsSync(abs)) return false;
  // Canonical, syntactically-safe health endpoint
  const content = `export default function handler(req, res) {
  const version = process.env.npm_package_version || '0.0.0';
  return res.status(200).json({ ok: true, uptime: process.uptime(), version });
}
`;
  // Only rewrite if file looks broken or empty
  const current = fs.readFileSync(abs, 'utf8');
  const broken = /SyntaxError|<<<<<<<|>>>>>>>|^\s*$/m.test(current) || current.trim().endsWith('{') || current.includes('return res.status(200).json') === false;
  if (broken) {
    fs.writeFileSync(abs, content, 'utf8');
    return true;
  }
  return false;
}

function ensureWithTimeoutHelper(repoDir) {
  const dir = path.join(repoDir, 'lib/api');
  const file = path.join(dir, 'withTimeout.js');
  if (fs.existsSync(file)) return false;

  fs.mkdirSync(dir, { recursive: true });
  const content = `/**
 * Wrap a promise with a timeout.
 */
export function withTimeout(promise, ms = 5000, message = 'Timeout') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}
export default withTimeout;
`;
  fs.writeFileSync(file, content, 'utf8');
  return true;
}

function runPreBuildFixes(repoDir) {
  const actions = [];
  if (ensureWithTimeoutHelper(repoDir)) actions.push('created lib/api/withTimeout.js');
  if (ensureDefaultExportSlugify(repoDir)) actions.push('added default export shim to lib/slugify.js');
  actions.push(...fixDuplicateApiRoutes(repoDir));
  if (ensureHealthApiValid(repoDir)) actions.push('rewrote pages/api/health.js to a safe handler');
  console.log('🔧 Pre-build fixes:', actions.length ? actions : 'none needed');
}

/** ---------- Exports ---------- */
module.exports = {
  run,
  tryLocalBuild,
  commitAndPush,
  getRepoTree,
  collectRepoFiles,
  readRoadmap,
  pickPackageManager,
  applyUnifiedDiff,
  runPreBuildFixes,
};
