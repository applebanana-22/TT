// Small fetch wrapper with timeouts and a typed error, so every provider
// reports failures the same way.

export class ProviderError extends Error {
  /**
   * @param {string} provider  'facebook' | 'tiktok'
   * @param {string} message   human readable
   * @param {object} opts
   * @param {string|number} [opts.code]  provider error code
   * @param {number} [opts.httpStatus]
   * @param {boolean} [opts.auth]  true when the token is invalid/expired/revoked -> account becomes EXPIRED
   * @param {object} [opts.details] raw provider payload, for logs
   */
  constructor(provider, message, { code, httpStatus, auth = false, details } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.provider = provider;
    this.code = code;
    this.httpStatus = httpStatus;
    this.auth = auth;
    this.details = details;
  }
}

export async function requestJson(url, { method = 'GET', headers = {}, body, timeoutMs = 20000 } = {}) {
  let res;
  try {
    res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const reason = err.name === 'TimeoutError' ? `timed out after ${timeoutMs / 1000}s` : err.message;
    const e = new Error(`Network error calling ${new URL(url).host}: ${reason}`);
    e.network = true;
    throw e;
  }
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { ok: res.ok, status: res.status, json };
}

export function form(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v != null) p.set(k, String(v));
  return p;
}
