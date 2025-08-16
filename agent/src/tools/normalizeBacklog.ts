import fs from 'fs';
import path from 'path';

// Paths
const backlogPath = path.resolve(process.argv[2] || 'roadmap/new.md');
const idMapPath = path.resolve('agent/.idmap.json');

// Load existing id map
let idMap: Record<string, string> = {};
try {
  idMap = JSON.parse(fs.readFileSync(idMapPath, 'utf8'));
} catch {
  idMap = {};
}

// Helper normalization maps
const impactMap: Record<string, 'H'|'M'|'L'> = {
  high: 'H', hi: 'H', h: 'H',
  medium: 'M', med: 'M', m: 'M',
  low: 'L', lo: 'L', l: 'L'
};
const effortMap: Record<string, 'XS'|'S'|'M'|'L'|'XL'> = {
  tiny: 'XS', xs: 'XS',
  small: 'S', s: 'S',
  medium: 'M', med: 'M', m: 'M',
  large: 'L', l: 'L',
  xlarge: 'XL', xl: 'XL'
};
const riskMap: Record<string, 'L'|'M'|'H'> = {
  low: 'L', l: 'L',
  medium: 'M', med: 'M', m: 'M',
  high: 'H', h: 'H'
};
const pathSynonyms: Record<string, 'red'|'green'|'both'> = {
  repair: 'red', fix: 'red',
  improve: 'green', feature: 'green'
};

function normalizeImpact(v?: string): 'H'|'M'|'L' {
  if (!v) return 'M';
  return impactMap[v.toLowerCase()] || 'M';
}
function normalizeEffort(v?: string): 'XS'|'S'|'M'|'L'|'XL' {
  if (!v) return 'M';
  return effortMap[v.toLowerCase()] || 'M';
}
function normalizeRisk(v?: string): 'L'|'M'|'H' {
  if (!v) return 'M';
  return riskMap[v.toLowerCase()] || 'M';
}
function normalizePath(v?: string): 'red'|'green'|'both' {
  if (!v) return 'both';
  v = v.toLowerCase();
  if (v === 'red' || v === 'green' || v === 'both') return v as any;
  return pathSynonyms[v] || 'both';
}

function sentenceCase(s: string): string {
  s = s.trim();
  if (!s) return s;
  return s[0].toUpperCase() + s.slice(1);
}

// Read backlog file
let content = '';
try {
  content = fs.readFileSync(backlogPath, 'utf8');
} catch {
  content = '';
}

const lines = content.split(/\r?\n/);
interface RawItem { main: string; subs: string[]; }
const rawItems: RawItem[] = [];
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (/^\s*[-*]/.test(line)) {
    rawItems.push({ main: line, subs: [] });
  } else if (/^\s{2}-\s/.test(line) && rawItems.length) {
    rawItems[rawItems.length - 1].subs.push(line);
  } else if (line.trim() !== '') {
    rawItems.push({ main: line, subs: [] });
  }
}

// Determine next ID
let maxId = 0;
for (const v of Object.values(idMap)) {
  const num = parseInt(v.slice(1), 10);
  if (num > maxId) maxId = num;
}
for (const { main } of rawItems) {
  const m = main.match(/\[T(\d{4})\]/);
  if (m) {
    const num = parseInt(m[1], 10);
    if (num > maxId) maxId = num;
  }
}
function genId(): string {
  maxId += 1;
  return `T${String(maxId).padStart(4, '0')}`;
}
function mapLegacy(id: string): string {
  if (idMap[id]) return idMap[id];
  const newId = genId();
  idMap[id] = newId;
  return newId;
}

interface Item {
  id: string;
  title: string;
  path: 'red'|'green'|'both';
  impact: 'H'|'M'|'L';
  effort: 'XS'|'S'|'M'|'L'|'XL';
  risk: 'L'|'M'|'H';
  tags: string[];
  subs: string[];
  triage?: string;
}

const items: Item[] = [];
const triage: Item[] = [];

for (const raw of rawItems) {
  const original = raw.main;
  let line = original.trim();
  line = line.replace(/^[-*]\s*/, '');
  line = line.replace(/^\[(x|X| )\]\s*/, '');

  // extract ID
  let id = '';
  let canonical = line.match(/\[T(\d{4})\]/);
  if (canonical) {
    id = `T${canonical[1]}`;
    line = line.replace(/\[T\d{4}\]\s*/, '');
  } else {
    const legacy = line.match(/\[(T?\d+)\]/) || line.match(/(T\d+|#\d+|\(\d+\)|\b\d+\b)/);
    if (legacy) {
      const key = legacy[1] || legacy[0];
      line = line.replace(legacy[0], '').trim();
      id = mapLegacy(key);
    } else {
      id = genId();
    }
  }

  // metadata and tags
  let meta: Record<string, string> = {};
  const extraTags: string[] = [];
  line = line.replace(/\(([^)]*)\)/g, (_m, inner) => {
    if (inner.includes(':')) {
      inner.split(',').forEach(part => {
        const [k, v] = part.split(':').map((s: string) => s.trim());
        if (k && v) meta[k] = v;
      });
    } else {
      inner.split(/[,\s]+/).forEach(t => { if (t) extraTags.push(t); });
    }
    return '';
  }).trim();
  line = line.replace(/\{([^}]*)\}/g, (_m, inner) => {
    inner.split(',').forEach(part => {
      const [k, v] = part.split(':').map((s: string) => s.trim());
      if (k && v) meta[k] = v;
    });
    return '';
  }).trim();

  let pathVal: string | undefined;
  const pathMatch = line.match(/\[(red|green|both)\]$/i);
  if (pathMatch) {
    pathVal = pathMatch[1];
    line = line.replace(/\[(red|green|both)\]$/i, '').trim();
  }

  const title = sentenceCase(line);
  if (!title) {
    triage.push({
      id: genId(),
      title: 'Unparsed task',
      path: 'both',
      impact: 'M',
      effort: 'M',
      risk: 'M',
      tags: ['needs-triage'],
      subs: [`  - desc: ${original.trim()}`]
    });
    continue;
  }

  const item: Item = {
    id,
    title,
    path: normalizePath(meta.path || pathVal),
    impact: normalizeImpact(meta.impact),
    effort: normalizeEffort(meta.effort),
    risk: normalizeRisk(meta.risk),
    tags: [],
    subs: []
  };

  const tags = meta.tags ? meta.tags.split(/[,\s]+/) : [];
  item.tags = [...tags, ...extraTags].filter(Boolean);
  if (!item.tags.length) item.tags = ['needs-triage'];

  // sub-bullets
  for (const s of raw.subs) {
    const m = s.match(/^\s{2}-\s(desc|files|validation):\s(.+)$/i);
    if (m) {
      const key = m[1].toLowerCase();
      const val = m[2].trim();
      if (key === 'files') {
        const files = val.split(',').map(f => f.trim()).join(', ');
        item.subs.push(`  - files: ${files}`);
      } else {
        item.subs.push(`  - ${key}: ${val}`);
      }
    }
  }

  items.push(item);
}

// Output normalized items
const output: string[] = [];
const allItems = [...items, ...triage];
for (const it of allItems) {
  const line = `- [ ] [${it.id}] ${it.title} {path: ${it.path}, impact: ${it.impact}, effort: ${it.effort}, risk: ${it.risk}, tags: ${it.tags.join(',')}}`;
  output.push(line);
  output.push(...it.subs);
}

fs.mkdirSync(path.dirname(backlogPath), { recursive: true });
fs.writeFileSync(backlogPath, output.join('\n') + (output.length ? '\n' : ''));
fs.mkdirSync(path.dirname(idMapPath), { recursive: true });
fs.writeFileSync(idMapPath, JSON.stringify(idMap, null, 2) + '\n');

// Validation
const mainRe = /^\s*- \[ \] \[T\d{4}\] [^{}]+ \{path: (red|green|both), impact: (H|M|L), effort: (XS|S|M|L|XL), risk: (L|M|H), tags: [a-z0-9\-]+(?:,\s*[a-z0-9\-]+)*\}\s*$/;
const subRe = /^\s{2}-\s(desc|files|validation):\s.+$/;
const outLines = output;
for (const l of outLines) {
  if (l.startsWith('- [ ]')) {
    if (!mainRe.test(l)) {
      console.error('Invalid line:', l);
      process.exit(1);
    }
  } else if (l.startsWith('  -')) {
    if (!subRe.test(l)) {
      console.error('Invalid sub-line:', l);
      process.exit(1);
    }
  }
}
