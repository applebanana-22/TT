// Connection state machine shared by every provider.
//
//                 connect()                 callback OK
//  DISCONNECTED ───────────► CONNECTING ───────────────► CONNECTED ◄──┐
//       ▲                       │  │                        │  │       │ refresh OK /
//       │   user cancelled /    │  │ callback failed        │  │       │ verify OK
//       │   10 min timeout      │  ▼                        │  ▼       │
//       └───────────────────────┘ ERROR ◄───── API error ───┘ EXPIRED ─┘
//       ▲                          │                           │ (token revoked / refresh failed:
//       └──────── disconnect() ────┴───────────────────────────┘  user must reconnect)
//
// Rules:
// - Only CONNECTED accounts can post.
// - EXPIRED means "we had access but lost it" -> show Reconnect.
// - ERROR means "something is wrong that reconnecting may or may not fix" -> show the reason.
// - CONNECTING is persisted with a timestamp so an abandoned OAuth tab
//   doesn't leave the UI stuck in "connecting" forever.

import { getAccount, patchAccount, saveAccount } from './store.js';

export const Status = Object.freeze({
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  EXPIRED: 'expired',
  ERROR: 'error',
});

const CONNECTING_TIMEOUT_MS = 10 * 60 * 1000;

const ALL = Object.values(Status);
const ALLOWED = {
  [Status.DISCONNECTED]: [Status.CONNECTING, Status.DISCONNECTED, Status.ERROR],
  // CONNECTING can end anywhere: success, failure, or "cancelled" which
  // restores whatever we had before (e.g. a reconnect the user abandoned).
  [Status.CONNECTING]: ALL,
  [Status.CONNECTED]: ALL,
  [Status.EXPIRED]: [Status.EXPIRED, Status.CONNECTED, Status.CONNECTING, Status.DISCONNECTED, Status.ERROR],
  [Status.ERROR]: ALL,
};

// Status as it should be shown *right now*, accounting for time passing.
export function effectiveStatus(account) {
  if (!account) return Status.DISCONNECTED;
  if (account.status === Status.CONNECTING) {
    const age = Date.now() - new Date(account.connectingSince || 0).getTime();
    if (age > CONNECTING_TIMEOUT_MS) return account.previousStatus || Status.DISCONNECTED;
  }
  if (account.status === Status.CONNECTED) {
    // Access token expired AND we can't refresh it -> expired.
    const accessExpired = account.expiresAt && new Date(account.expiresAt) <= new Date();
    const canRefresh = account.refreshExpiresAt && new Date(account.refreshExpiresAt) > new Date();
    if (accessExpired && !canRefresh) return Status.EXPIRED;
  }
  return account.status;
}

export async function transition(provider, to, patch = {}) {
  const current = getAccount(provider);
  const from = effectiveStatus(current);
  if (!ALLOWED[from]?.includes(to)) {
    throw new Error(`Invalid connection transition for ${provider}: ${from} -> ${to}`);
  }
  console.log(`[${provider}] ${from} -> ${to}${patch.statusReason ? ` (${patch.statusReason})` : ''}`);

  const base = {
    statusReason: null,
    ...(to === Status.CONNECTING ? { connectingSince: new Date().toISOString(), previousStatus: from === Status.CONNECTING ? current.previousStatus : from } : {}),
    ...(to === Status.CONNECTED ? { connectedAt: current?.connectedAt || new Date().toISOString(), lastVerifiedAt: new Date().toISOString() } : {}),
  };

  if (to === Status.DISCONNECTED) {
    // Forget everything (tokens, profile) but keep a reason for the UI.
    return saveAccount(provider, { status: to, statusReason: patch.statusReason || null });
  }
  return patchAccount(provider, { ...base, ...patch, status: to });
}

// User cancelled / denied the OAuth dialog: go back to where we were.
export async function cancelConnecting(provider, reason) {
  const account = getAccount(provider);
  const back = account?.previousStatus || Status.DISCONNECTED;
  if (back === Status.DISCONNECTED) return transition(provider, Status.DISCONNECTED, { statusReason: reason });
  return transition(provider, back, { statusReason: reason });
}

// The safe, token-free view of an account that is sent to the browser.
export function publicView(provider, account, extra = {}) {
  const status = effectiveStatus(account);
  return {
    provider,
    status,
    statusReason: account?.statusReason || null,
    profile: status === Status.DISCONNECTED ? null : account?.profile || null,
    scopes: account?.scopes || [],
    expiresAt: account?.expiresAt || null,
    connectedAt: account?.connectedAt || null,
    lastVerifiedAt: account?.lastVerifiedAt || null,
    updatedAt: account?.updatedAt || null,
    ...extra,
  };
}
