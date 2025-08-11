'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { getExportFacts } = require('./fileFacts.cjs');

function run(cmd, opts = {}) {
  return execSync(cmd, { stdio: 'inherit', ...opts });
}

function pickPackageManager(repoDir) {
  const has = f => fs.existsSync(path.join(repoDir, f));
  if (has('pnpm-lock.yaml')) return 'pnpm';
  if (has('yarn.lock')) return 'yarn';
  return 'npm';
}

function tryLocalBuild(repoDir) {
  const pm = pickPackageManager(repoDir);
  if (pm === 'npm') {
    run('npm ci', { cwd: repoDir });
    run('npx next build', { cwd: repoDir });
  } else if (pm === 'yarn') {
    run('yarn install --frozen-lockfile', { cwd: repoDir });
    run('yarn next build', { cwd: repoDir });
  } else {
    run('pnpm install --frozen-lockfile', { cwd: repoDir });
    run('pnpm next build', { cwd: repoDir });
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
  // - language after ``` is optional
  // - closing fence must be on its own line
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
  // Extract a/b paths from the "diff --git a/... b/..." header
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
  const modes = [
    'git apply --check -p1',
    'git apply --check',
    'git apply --check -p0',
  ];
  for (const m of modes) {
    try {
      run(`${m} ${tmpName}`, { cwd: repoDir });
      const apply = m.replace(' --check', '') + ' --index -3 --whitespace=fix';
      run(`${apply} ${tmpName}`, { cwd: repoDir });
      return true;
    } catch (_) { /* try next */ }
  }
  return false;
}

/** ---------- Heuristic fallbacks when git apply fails ---------- */

function ensureDefaultExportSlugify(absPath) {
  if (!fs.existsSync(absPath)) return false;
  let txt = fs.readFileSync(absPath, 'utf8');
  // If there is already a default export, nothing to do
  if (/export\s+default\s+slugify\s*;?/m.test(txt)) return false;
  // Add a small shim at the end
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

function fallbackApply(repoDir, { a, b, type }) {
  try {
    if (type === 'delete' && a) {
      const abs = path.join(repoDir, a);
      if (fs.existsSync(abs)) {
        fs.rmSync(abs, { force: true });
        return true;
      }
      return false;
    }

    if (type === 'modify') {
      // Heuristics for the slugify pattern seen in logs/diffs
      if (a && /\/lib\/slugify\.(js|ts)$/.test(a)) {
        const abs = path.join(repoDir, a);
        return ensureDefaultExportSlugify(abs);
      }
      if (a && /\/pages\/.*\.(js|jsx|ts|tsx)$/.test(a)) {
        const abs = path.join(repoDir, a);
        return rewriteDefaultSlugifyImports(abs);
      }
    }

    // We could add more heuristics here as needed
  } catch (_) {
    // swallow and report false
  }
  return false;
}

/**
 * Apply a unified diff robustly:
 * - sanitize
 * - split into per-file chunks
 * - skip chunks that target non-existent files (for modify/delete)
 * - try multiple -p modes per chunk
 * - if apply fails, run heuristics (delete file / slugify fixes)
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
    const didHeuristic = fallbackApply(repoDir, { a, b, type });
    if (didHeuristic) {
      applied++;
      heuristic.push({ i, reason: 'heuristic-applied', path: a || b, type });
      if (type === 'delete' && a) treeSet.delete(a);
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

module.exports = {
  run,
  tryLocalBuild,
  commitAndPush,
  getRepoTree,
  collectRepoFiles,
  readRoadmap,
  pickPackageManager,
  applyUnifiedDiff,
};
