'use strict';
const fs = require('fs');

function getExportFacts(path) {
  try {
    const text = fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : '';
    const hasDefault = /export\s+default\s+|module\.exports\s*=/m.test(text);
    const named = [...text.matchAll(/export\s+(?:const|function|class|let|var)\s+([A-Za-z0-9_]+)/g)]
      .map(m => m[1]);
    return { hasDefault, named };
  } catch {
    return { hasDefault: false, named: [] };
  }
}

module.exports = { getExportFacts };
