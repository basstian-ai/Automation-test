'use strict';

/**
 * Simple fetch wrapper with retries and improved error messages.
 *
 * @param {string|URL} url
 * @param {object} fetchOpts - options passed to fetch
 * @param {object} opts - { retries, retryDelayMs, errorPrefix, retryOn, maxErrorLength }
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(url, fetchOpts = {}, {
  retries = 3,
  retryDelayMs = attempt => 1000 * (attempt + 1),
  errorPrefix = '',
  retryOn = status => status === 429 || (status >= 500 && status < 600),
  maxErrorLength = 500,
} = {}) {
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, fetchOpts);
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const msg = `${errorPrefix}${res.status}: ${text.slice(0, maxErrorLength)}`;
        if (attempt < retries - 1 && retryOn(res.status)) {
          lastErr = new Error(msg);
          await new Promise(r => setTimeout(r, retryDelayMs(attempt)));
          continue;
        }
        throw new Error(msg);
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt === retries - 1) {
        if (errorPrefix) err.message = `${errorPrefix}${err.message}`;
        throw err;
      }
      await new Promise(r => setTimeout(r, retryDelayMs(attempt)));
    }
  }
  throw lastErr;
}

module.exports = { fetchWithRetry };
