'use strict';

const RX = {
  duplicatePage: /Duplicate page detected\.\s+(?<a>.+?)\s+and\s+(?<b>.+?)\s+both resolve to\s+(?<route>.+?)\./i,
  attemptedDefaultImport: /Attempted import error:\s+['"]?(?<path>[^'"]+)['"]?\s+does not contain a default export.*imported as\s+'(?<as>[^']+)'/i,
  genericWarn: /^\s*warn\s*-\s*(?<msg>.+)$/i,
  genericErr:  /^\s*error\s*-\s*(?<msg>.+)$/i
};

function normalizeRepoPath(s='') {
  return s.replace(/^\.?\//, '').replace(/\\/g, '/');
}

function dedupeIssues(arr) {
  const seen = new Set();
  return arr.filter(i => {
    const key = [i.severity, i.message, i.file || '', (i.related||[]).join(',')].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractIssuesFromLogs(allLogsText='') {
  const issues = [];
  const lines = allLogsText.split(/\r?\n/);

  for (const line of lines) {
    let m;
    if ((m = line.match(RX.duplicatePage))) {
      issues.push({
        severity: 'warn',
        message: `Duplicate route for ${m.groups.route}`,
        file: normalizeRepoPath(m.groups.a),
        related: [normalizeRepoPath(m.groups.b)],
        hint: 'nextjs_duplicate_page'
      });
      continue;
    }
    if ((m = line.match(RX.attemptedDefaultImport))) {
      issues.push({
        severity: 'error',
        message: `Default import used but module has no default export`,
        file: normalizeRepoPath(m.groups.path),
        hint: 'missing_default_export'
      });
      continue;
    }
    if ((m = line.match(RX.genericErr))) {
      issues.push({ severity: 'error', message: m.groups.msg });
      continue;
    }
    if ((m = line.match(RX.genericWarn))) {
      issues.push({ severity: 'warn', message: m.groups.msg });
      continue;
    }
  }
  return dedupeIssues(issues);
}

function filesFromIssues(issues=[]) {
  const set = new Set();
  for (const i of issues) {
    if (i.file) set.add(normalizeRepoPath(i.file));
    (i.related || []).forEach(f => set.add(normalizeRepoPath(f)));
  }
  return [...set];
}

module.exports = {
  extractIssuesFromLogs,
  filesFromIssues,
};
