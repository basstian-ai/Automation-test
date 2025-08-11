// lib/api/withTimeout.js
/**
 * Wrap a promise with a timeout.
 * Rejects with Error(message) if it doesn't settle within `ms`.
 */
export function withTimeout(promise, ms = 5000, message = 'Timeout') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

export default withTimeout;
