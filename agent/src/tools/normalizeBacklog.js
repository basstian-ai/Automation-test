import fs from 'fs';
import path from 'path';

const backlogPath = path.resolve(process.argv[2] || 'roadmap/new.md');
const idMapPath = path.resolve('agent/.idmap.json');

let idMap = {};
try { idMap = JSON.parse(fs.readFileSync(idMapPath, 'utf8')); } catch {}

const impactMap = { high:'H', hi:'H', h:'H', medium:'M', med:'M', m:'M', low:'L', lo:'L', l:'L' };
const effortMap = { tiny:'XS', xs:'XS', small:'S', s:'S', medium:'M', med:'M', m:'M', large:'L', l:'L', xlarge:'XL', xl:'XL' };
const riskMap = { low:'L', l:'L', medium:'M', med:'M', m:'M', high:'H', h:'H' };
const pathSynonyms = { repair:'red', fix:'red', improve:'green', feature:'green' };

function normalizeImpact(v){ return impactMap[(v||'').toLowerCase()] || 'M'; }
function normalizeEffort(v){ return effortMap[(v||'').toLowerCase()] || 'M'; }
function normalizeRisk(v){ return riskMap[(v||'').toLowerCase()] || 'M'; }
function normalizePath(v){ if(!v) return 'both'; v=v.toLowerCase(); return ['red','green','both'].includes(v)?v:(pathSynonyms[v]||'both'); }
function sentenceCase(s){ s = s.trim(); return s? s[0].toUpperCase()+s.slice(1) : s; }

let content='';
try { content = fs.readFileSync(backlogPath,'utf8'); } catch {}
const lines = content.split(/\r?\n/);
const rawItems=[];
for(const line of lines){
  if (/^\s*[-*]/.test(line)) rawItems.push({main:line,subs:[]});
  else if (/^\s{2}-\s/.test(line) && rawItems.length) rawItems[rawItems.length-1].subs.push(line);
  else if (line.trim()!=='') rawItems.push({main:line,subs:[]});
}

let maxId=0;
Object.values(idMap).forEach(v=>{const n=parseInt(v.slice(1),10); if(n>maxId) maxId=n;});
rawItems.forEach(it=>{const m=it.main.match(/\[T(\d{4})\]/); if(m){const n=parseInt(m[1],10); if(n>maxId) maxId=n;}});

function genId(){ maxId++; return `T${String(maxId).padStart(4,'0')}`; }
function mapLegacy(id){ if(idMap[id]) return idMap[id]; const nid=genId(); idMap[id]=nid; return nid; }

const items=[];
const triage=[];
for(const raw of rawItems){
  const original = raw.main;
  let line = original.trim();
  line = line.replace(/^[-*]\s*/,'').replace(/^\[(x|X| )\]\s*/,'');

  let id=''; const canonical=line.match(/\[T(\d{4})\]/);
  if(canonical){ id=`T${canonical[1]}`; line=line.replace(/\[T\d{4}\]\s*/,''); }
  else{
    const legacy=line.match(/\[(T?\d+)\]/)||line.match(/(T\d+|#\d+|\(\d+\)|\b\d+\b)/);
    if(legacy){ const key=legacy[1]||legacy[0]; line=line.replace(legacy[0],'').trim(); id=mapLegacy(key); }
    else { id=genId(); }
  }

  const meta={}; const extraTags=[];
  line=line.replace(/\(([^)]*)\)/g,(_,inner)=>{
    if(inner.includes(':')) inner.split(',').forEach(p=>{const [k,v]=p.split(':').map(s=>s.trim()); if(k&&v) meta[k]=v;});
    else inner.split(/[,\s]+/).forEach(t=>{if(t) extraTags.push(t);});
    return '';
  }).trim();
  line=line.replace(/\{([^}]*)\}/g,(_,inner)=>{inner.split(',').forEach(p=>{const [k,v]=p.split(':').map(s=>s.trim()); if(k&&v) meta[k]=v;}); return '';}).trim();

  let pathVal; const pm=line.match(/\[(red|green|both)\]$/i); if(pm){ pathVal=pm[1]; line=line.replace(/\[(red|green|both)\]$/i,'').trim(); }

  const title = sentenceCase(line);
  if(!title){
    triage.push({id:genId(), title:'Unparsed task', path:'both', impact:'M', effort:'M', risk:'M', tags:['needs-triage'], subs:[`  - desc: ${original.trim()}`]});
    continue;
  }

  const tags = (meta.tags? meta.tags.split(/[,\s]+/) : []).concat(extraTags).filter(Boolean);
  const subs = raw.subs.map(s=>{
    const m=s.match(/^\s{2}-\s(desc|files|validation):\s(.+)$/i);
    if(m){ const key=m[1].toLowerCase(); const val=m[2].trim(); return key==='files'?`  - files: ${val.split(',').map(f=>f.trim()).join(', ')}`:`  - ${key}: ${val}`; }
    return null;
  }).filter(Boolean);

  items.push({
    id,
    title,
    path: normalizePath(meta.path || pathVal),
    impact: normalizeImpact(meta.impact),
    effort: normalizeEffort(meta.effort),
    risk: normalizeRisk(meta.risk),
    tags: tags.length? tags : ['needs-triage'],
    subs
  });
}

const all=[...items,...triage];
const output=[];
all.forEach(it=>{
  output.push(`- [ ] [${it.id}] ${it.title} {path: ${it.path}, impact: ${it.impact}, effort: ${it.effort}, risk: ${it.risk}, tags: ${it.tags.join(',')}}`);
  output.push(...it.subs);
});
fs.mkdirSync(path.dirname(backlogPath),{recursive:true});
fs.writeFileSync(backlogPath, output.join('\n')+(output.length?'\n':''));
fs.mkdirSync(path.dirname(idMapPath),{recursive:true});
fs.writeFileSync(idMapPath, JSON.stringify(idMap, null, 2)+'\n');

const mainRe=/^\s*- \[ \] \[T\d{4}\] [^{}]+ \{path: (red|green|both), impact: (H|M|L), effort: (XS|S|M|L|XL), risk: (L|M|H), tags: [a-z0-9\-]+(?:,\s*[a-z0-9\-]+)*\}\s*$/;
const subRe=/^\s{2}-\s(desc|files|validation):\s.+$/;
for(const l of output){
  if(l.startsWith('- [ ]')){ if(!mainRe.test(l)){ console.error('Invalid line:', l); process.exit(1);} }
  else if(l.startsWith('  -')){ if(!subRe.test(l)){ console.error('Invalid sub-line:', l); process.exit(1);} }
}
