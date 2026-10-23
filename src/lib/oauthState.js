// OAuth "state" parameter = CSRF protection.
// We generate a random value, remember it (server side + in an httpOnly cookie
// bound to this browser), and on callback require both to match. Each state is
// single-use and expires after 10 minutes.
import crypto from 'node:crypto';

const TTL_MS = 10 * 60 * 1000;
const pending = new Map(); // state -> { provider, createdAt, data }

export const STATE_COOKIE = 'oauth_state';

export function createState(provider, data = {}) {
  const state = crypto.randomBytes(24).toString('base64url');
  pending.set(state, { provider, createdAt: Date.now(), data });
  return state;
}

// Returns the stored entry or throws a descriptive error.
export function consumeState(provider, stateFromQuery, stateFromCookie) {
  for (const [s, v] of pending) if (Date.now() - v.createdAt > TTL_MS) pending.delete(s);

  if (!stateFromQuery) throw new Error('Missing state parameter');
  const entry = pending.get(stateFromQuery);
  pending.delete(stateFromQuery); // single use, even on failure

  if (!entry) throw new Error('Unknown or expired login attempt. Please try connecting again.');
  if (entry.provider !== provider) throw new Error('State was issued for a different provider');
  if (!stateFromCookie || !timingSafeEqual(stateFromCookie, stateFromQuery)) {
    throw new Error('State does not match this browser (possible CSRF). Please try again.');
  }
  return entry;
}

function timingSafeEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}
