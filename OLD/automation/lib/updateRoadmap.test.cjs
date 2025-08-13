'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { updateRoadmap, readRoadmap } = require('./utils.cjs');

// Bullet list with preface text
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadmap-'));
  const file = path.join(dir, 'roadmap.md');
  fs.writeFileSync(file, '# Roadmap\n\n## Progress\nPreface line\n- existing\n', 'utf8');
  updateRoadmap(dir, 'new item', '');
  const content = fs.readFileSync(file, 'utf8');
  assert.match(content, /## Progress\n\nPreface line\n- existing\n- new item\n/);
}

// Numbered list
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadmap-'));
  const file = path.join(dir, 'roadmap.md');
  fs.writeFileSync(file, '# Roadmap\n\n## Next Steps\n1. first\n2. second\n', 'utf8');
  updateRoadmap(dir, '', 'third');
  const content = fs.readFileSync(file, 'utf8');
  assert.match(content, /## Next Steps\n\n1\. first\n2\. second\n- third\n/);
}

// Archiving old items when exceeding limit
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadmap-'));
  const file = path.join(dir, 'roadmap.md');
  let content = '# Roadmap\n\n## Progress\n';
  for (let i = 1; i <= 20; i++) content += `- item ${i}\n`;
  fs.writeFileSync(file, content, 'utf8');
  updateRoadmap(dir, 'new item', '');
  const main = fs.readFileSync(file, 'utf8');
  const archive = fs.readFileSync(path.join(dir, 'roadmap-archive.md'), 'utf8');
  assert(!/- item 1\n/.test(main));
  assert(/- item 2\n/.test(main));
  assert(/new item/.test(main));
  assert(/## Progress/.test(archive));
  assert(/- item 1(?:\n|$)/.test(archive));
  assert.strictEqual(readRoadmap(dir), main);
}

// Archiving in Next Steps section
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadmap-'));
  const file = path.join(dir, 'roadmap.md');
  let content = '# Roadmap\n\n## Next Steps\n';
  for (let i = 1; i <= 20; i++) content += `- step ${i}\n`;
  fs.writeFileSync(file, content, 'utf8');
  updateRoadmap(dir, '', 'extra');
  const main = fs.readFileSync(file, 'utf8');
  const archive = fs.readFileSync(path.join(dir, 'roadmap-archive.md'), 'utf8');
  assert(!/- step 1\n/.test(main));
  assert(/- step 2\n/.test(main));
  assert(/extra/.test(main));
  assert(/## Next Steps/.test(archive));
  assert(/- step 1(?:\n|$)/.test(archive));
}

// Pruning completed items
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadmap-'));
  const file = path.join(dir, 'roadmap.md');
  fs.writeFileSync(file, '# Roadmap\n\n## Progress\n- [x] done\n- todo\n', 'utf8');
  updateRoadmap(dir, '', '');
  const main = fs.readFileSync(file, 'utf8');
  const archive = fs.readFileSync(path.join(dir, 'roadmap-archive.md'), 'utf8');
  assert(!/\[x\] done/.test(main));
  assert(/todo/.test(main));
  assert(/\[x\] done/.test(archive));
}

// Pruning dated items older than threshold
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadmap-'));
  const file = path.join(dir, 'roadmap.md');
  const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const recentDate = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(file, `# Roadmap\n\n## Next Steps\n- [${oldDate}] stale\n- [${recentDate}] fresh\n`, 'utf8');
  updateRoadmap(dir, '', '');
  const main = fs.readFileSync(file, 'utf8');
  const archive = fs.readFileSync(path.join(dir, 'roadmap-archive.md'), 'utf8');
  assert(!/stale/.test(main));
  assert(/fresh/.test(main));
  assert(/stale/.test(archive));
}

console.log('updateRoadmap tests passed.');
