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

function applyUnifiedDiff(diffText, repoDir) {
  const tmp = path.join(repoDir, '.ai_patch.diff');
  fs.writeFileSync(tmp, diffText, 'utf8');
  try {
    try {
      run('git apply --index -3 --whitespace=fix .ai_patch.diff', { cwd: repoDir });
    } catch {
      run('git apply --index -3 --whitespace=fix -p1 .ai_patch.diff', { cwd: repoDir });
    }
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
