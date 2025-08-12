'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { updateRoadmap } = require('./utils.cjs');

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

console.log('updateRoadmap tests passed.');
