'use strict';

const assert = require('assert');
const { extractIssuesFromLogs } = require('./parseLogs.cjs');

// Duplicate page detection
{
  const logs = "Duplicate page detected. pages/index.js and pages/index.jsx both resolve to /index.";
  const issues = extractIssuesFromLogs(logs);
  assert.deepStrictEqual(issues, [
    {
      severity: 'warn',
      message: 'Duplicate route for /index',
      file: 'pages/index.js',
      related: ['pages/index.jsx'],
      hint: 'nextjs_duplicate_page'
    }
  ]);
}

// Missing default export
{
  const logs = "Attempted import error: './lib/foo.js' does not contain a default export (imported as 'foo').";
  const issues = extractIssuesFromLogs(logs);
  assert.deepStrictEqual(issues, [
    {
      severity: 'error',
      message: 'Default import used but module has no default export',
      file: 'lib/foo.js',
      hint: 'missing_default_export'
    }
  ]);
}

// Generic error
{
  const logs = 'error - Something failed';
  const issues = extractIssuesFromLogs(logs);
  assert.deepStrictEqual(issues, [
    { severity: 'error', message: 'Something failed' }
  ]);
}

// Generic warning
{
  const logs = 'warn - Watch out';
  const issues = extractIssuesFromLogs(logs);
  assert.deepStrictEqual(issues, [
    { severity: 'warn', message: 'Watch out' }
  ]);
}

console.log('All tests passed.');
