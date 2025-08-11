'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { getExportFacts } = require('./fileFacts.cjs');

function run(cmd, opts={}) {
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

function sanitizeDiff(raw) {
  if (!raw) return '';
  let s = String(raw);

  // Strip code fences, "*** Begin/End Patch", and any leading prose before first "diff --git"
  s = s.replace(/^\uFEFF/, '');               // remove BOM
  s = s.replace(/\r/g, '');                    // force LF
  s = s.replace(/^\s*```[\s\S]*?^```/gm, '');  // remove fenced blocks if any
  s = s.replace(/^\s*\*{3}.*?End Patch\s*$/gms, ''); // remove *** Begin/End Patch blocks

  const first = s.indexOf('diff --git ');
  if (first > 0) s = s.slice(first);

  // Ensure trailing newline
  if (!s.endsWith('\n')) s += '\n';
  return s;
}

function tryApply(repoDir, diffPath) {
  const modes = [
    'git apply --check -p1',
    'git apply --check',
    'git apply --check -p0',
  ];
  for (const m of modes) {
    try {
      run(`${m} ${path.basename(diffPath)}`, { cwd: repoDir });
      // If check passes, actually apply with same mode plus --index -3 --whitespace=fix
      const apply = m.replace(' --check', '') + ' --index -3 --whitespace=fix';
      run(`${apply} ${path.basename(diffPath)}`, { cwd: repoDir });
      return true;
    } catch (_) {
      // try next mode
    }
  }
  return false;
}

function applyUnifiedDiff(diffText, repoDir) {
  const sanitized = sanitizeDiff(diffText);
  const tmp = path.join(repoDir, '.ai_patch.diff');
  fs.writeFileSync(tmp, sanitized, 'utf8');

  try {
    if (tryApply(repoDir, tmp)) return;
    // If still failing, dump first lines for debugging and throw
    const head = sanitized.split('\n').slice(0, 120).join('\n');
    throw new Error(`git apply failed; diff head:\n${head}`);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}


function commitAndPush(message, repoDir) {
  run('git add -A', { cwd: repoDir });
  try { run(`git diff --cached --quiet || git commit -m "${message.replace(/"/g, '\\"')}"`, { cwd: repoDir }); } catch {}
  try { run('git push', { cwd: repoDir }); } catch {}
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

function collectRepoFiles(repoDir, paths=[]) {
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
