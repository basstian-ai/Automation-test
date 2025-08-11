'use strict';

const VERCEL_API = 'https://api.vercel.com';

async function _fetch(url, { token }) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Vercel ${url} -> ${res.status}: ${text.slice(0,300)}`);
  }
  return res;
}

async function listDeployments({ token, projectId, limit = 5 }) {
  const url = new URL(`${VERCEL_API}/v6/deployments`);
  url.searchParams.set('projectId', projectId);
  url.searchParams.set('limit', String(limit));
  const res = await _fetch(url, { token });
  const json = await res.json();
  return json.deployments || [];
}

async function getBuildEvents({ token, deploymentId }) {
  // Build events (streamed text / NDJSON)
  const url = `${VERCEL_API}/v3/deployments/${deploymentId}/events`;
  const res = await _fetch(url, { token });
  return await res.text();
}

async function getRuntimeLogs({ token, projectId, deploymentId }) {
  // Runtime logs (text)
  const url = `${VERCEL_API}/v1/projects/${projectId}/deployments/${deploymentId}/runtime-logs`;
  const res = await _fetch(url, { token });
  return await res.text();
}

function concatAndTrimLogs({ buildText = '', runtimeText = '', maxChars = 40000 }) {
  const joined = [
    '==== VERCEL BUILD EVENTS ====',
    buildText || '(none)',
    '',
    '==== VERCEL RUNTIME LOGS ====',
    runtimeText || '(none)'
    ].join('\n');
  if (joined.length <= maxChars) return joined;
  return joined.slice(-maxChars);
}

module.exports = {
  listDeployments,
  getBuildEvents,
  getRuntimeLogs,
  concatAndTrimLogs,
};
