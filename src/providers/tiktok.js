// TikTok provider (Login Kit v2 + Content Posting API).
//
// Important facts for learning:
// - Access tokens live 24h; refresh tokens live ~365 days. We refresh
//   automatically shortly before expiry. When the refresh token dies or is
//   revoked, the account becomes EXPIRED and the user must reconnect.
// - Photos can ONLY be posted with source = PULL_FROM_URL: TikTok downloads the
//   image from a public HTTPS URL on a domain/URL prefix you verified in the
//   TikTok developer portal. That's why this app serves uploads at /media.
// - Posting is asynchronous: init returns a publish_id, then you poll status.
// - Before a Direct Post you must query creator_info and let the user choose a
//   privacy level from the returned options (no default) - TikTok audits this UX.
// - Unaudited apps can only post with privacy SELF_ONLY (private), and to a
//   limited number of users. That's expected while testing.
import { config, redirectUri } from '../config.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { requestJson, form, ProviderError } from '../lib/http.js';
import { getAccount, patchAccount } from '../lib/store.js';

const NAME = 'tiktok';
const API = 'https://open.tiktokapis.com';
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

const AUTH_ERROR_CODES = new Set(['access_token_invalid', 'invalid_grant', 'token_expired', 'invalid_token']);

function apiError(status, json, fallback) {
  // OAuth endpoints: { error, error_description, log_id }
  // Other endpoints: { error: { code, message, log_id } }
  const e = json?.error;
  const code = typeof e === 'string' ? e : e?.code;
  const message = (typeof e === 'string' ? json.error_description : e?.message) || fallback;
  const hint = {
    scope_not_authorized: 'The user did not grant the required scope. Reconnect and allow it.',
    unaudited_client_can_only_post_to_private_accounts: 'Unaudited app: choose privacy "SELF_ONLY" (Only me).',
    url_ownership_unverified: 'The photo URL domain is not verified in the TikTok developer portal.',
    spam_risk_too_many_posts: 'Daily post limit reached for this user.',
    spam_risk_user_banned_from_posting: 'This user is banned from posting.',
    reached_active_user_cap: 'Daily active user cap reached for this (unaudited) app.',
    privacy_level_option_mismatch: 'Selected privacy level is not allowed for this creator.',
    rate_limit_exceeded: 'Rate limited by TikTok. Try again shortly.',
  }[code];
  return new ProviderError(NAME, `${hint ? hint + ' ' : ''}${message}${code ? ` [${code}]` : ''}`, {
    code,
    httpStatus: status,
    auth: AUTH_ERROR_CODES.has(code) || status === 401,
    details: json,
  });
}

function isOk(res) {
  // Non-OAuth endpoints return HTTP 200 with error.code === "ok" on success.
  return res.ok && (!res.json.error || res.json.error.code === 'ok');
}

// ---- OAuth ----------------------------------------------------------------

export function authorizeUrl(state) {
  const url = new URL('https://www.tiktok.com/v2/auth/authorize/');
  url.searchParams.set('client_key', config.tiktok.clientKey);
  url.searchParams.set('scope', config.tiktok.scopes.join(','));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri(NAME));
  url.searchParams.set('state', state);
  return url.toString();
}

export function callbackError(query) {
  if (!query.error) return null;
  return {
    cancelled: query.error === 'access_denied',
    message: query.error_description || query.error,
  };
}

async function tokenRequest(params) {
  const res = await requestJson(`${API}/v2/oauth/token/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
    body: form({ client_key: config.tiktok.clientKey, client_secret: config.tiktok.clientSecret, ...params }),
  });
  if (!res.ok || res.json.error || !res.json.access_token) throw apiError(res.status, res.json, 'Token request failed');
  return tokenFields(res.json);
}

function tokenFields(t) {
  const now = Date.now();
  return {
    tokens: { access: encrypt(t.access_token), refresh: encrypt(t.refresh_token) },
    scopes: (t.scope || '').split(',').filter(Boolean),
    expiresAt: new Date(now + t.expires_in * 1000).toISOString(),
    refreshExpiresAt: new Date(now + t.refresh_expires_in * 1000).toISOString(),
    openId: t.open_id,
  };
}

async function fetchUser(accessToken) {
  const url = `${API}/v2/user/info/?fields=open_id,union_id,avatar_url,display_name`;
  const res = await requestJson(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!isOk(res)) throw apiError(res.status, res.json, 'Could not load TikTok profile');
  const u = res.json.data.user;
  return { id: u.open_id, name: u.display_name, avatar: u.avatar_url || null };
}

export async function completeConnect(code) {
  const tokens = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: redirectUri(NAME) });

  // The user can untick scopes in the TikTok dialog. Detect that now, not at post time.
  const canPost = tokens.scopes.includes('video.publish') || tokens.scopes.includes('video.upload');
  if (!canPost) {
    throw new Error(`Posting scope was not granted (granted: ${tokens.scopes.join(', ') || 'none'}). Reconnect and allow posting.`);
  }

  const profile = await fetchUser(decrypt(tokens.tokens.access));
  return { ...tokens, profile };
}

// ---- token lifecycle ------------------------------------------------------

let refreshInFlight = null; // single-flight: concurrent callers share one refresh

async function refresh() {
  const account = getAccount(NAME);
  const refreshToken = decrypt(account?.tokens?.refresh);
  if (!refreshToken) throw new ProviderError(NAME, 'No refresh token stored', { auth: true });
  console.log('[tiktok] refreshing access token');
  const fields = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
  await patchAccount(NAME, { ...fields, lastRefreshedAt: new Date().toISOString() });
}

// Returns a valid access token, refreshing first if it is about to expire.
export async function getAccessToken() {
  const account = getAccount(NAME);
  const expiresAt = new Date(account?.expiresAt || 0).getTime();
  if (expiresAt - Date.now() < REFRESH_MARGIN_MS) {
    refreshInFlight ??= refresh().finally(() => { refreshInFlight = null; });
    await refreshInFlight;
  }
  return decrypt(getAccount(NAME).tokens.access);
}

async function authedJson(path, body) {
  const token = await getAccessToken();
  const res = await requestJson(`${API}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(body ?? {}),
  });
  if (!isOk(res)) throw apiError(res.status, res.json, `TikTok ${path} failed (${res.status})`);
  return res.json.data;
}

// ---- health check ---------------------------------------------------------

export async function verify() {
  const profile = await fetchUser(await getAccessToken());
  return { ok: true, patch: { profile } };
}

// ---- publishing -----------------------------------------------------------

// Must be called right before showing the post form (TikTok UX guideline).
export async function creatorInfo() {
  const d = await authedJson('/v2/post/publish/creator_info/query/');
  return {
    username: d.creator_username,
    nickname: d.creator_nickname,
    avatar: d.creator_avatar_url,
    privacyLevelOptions: d.privacy_level_options || [],
    commentDisabled: Boolean(d.comment_disabled),
  };
}

/**
 * @param {object} p
 * @param {string} p.imageUrl  public HTTPS URL TikTok will download
 * @param {'DIRECT_POST'|'MEDIA_UPLOAD'} p.mode
 */
export async function publishPhoto(account, { imageUrl, title, description, mode, privacyLevel, disableComment, autoAddMusic }) {
  const needScope = mode === 'DIRECT_POST' ? 'video.publish' : 'video.upload';
  if (!account.scopes?.includes(needScope)) {
    throw new ProviderError(NAME, `Missing scope "${needScope}" for ${mode}. Add it to TIKTOK_SCOPES and reconnect.`, { code: 'scope_not_authorized' });
  }

  const postInfo = { title: title?.slice(0, 90) || '', description: description?.slice(0, 4000) || '' };
  if (mode === 'DIRECT_POST') {
    if (!privacyLevel) throw new Error('Choose a TikTok privacy level');
    Object.assign(postInfo, {
      privacy_level: privacyLevel,
      disable_comment: Boolean(disableComment),
      auto_add_music: Boolean(autoAddMusic),
      brand_content_toggle: false,
      brand_organic_toggle: false,
    });
  }

  const data = await authedJson('/v2/post/publish/content/init/', {
    media_type: 'PHOTO',
    post_mode: mode,
    post_info: postInfo,
    source_info: { source: 'PULL_FROM_URL', photo_images: [imageUrl], photo_cover_index: 0 },
  });
  return { publishId: data.publish_id };
}

// Maps TikTok's async status to our simpler post status.
const STATUS_MAP = {
  PROCESSING_DOWNLOAD: 'processing',
  PROCESSING_UPLOAD: 'processing',
  SEND_TO_USER_INBOX: 'inbox',       // MEDIA_UPLOAD finished: user must open TikTok to finish posting
  PUBLISH_COMPLETE: 'published',
  FAILED: 'failed',
};

export async function fetchStatus(publishId) {
  const d = await authedJson('/v2/post/publish/status/fetch/', { publish_id: publishId });
  const ids = d.publicaly_available_post_id || []; // (sic) TikTok's spelling
  return {
    rawStatus: d.status,
    status: STATUS_MAP[d.status] || 'processing',
    error: d.fail_reason || null,
    postIds: ids.map(String),
  };
}

// ---- disconnect -----------------------------------------------------------

export async function revoke(account) {
  const token = decrypt(account.tokens?.access);
  if (!token) return;
  const res = await requestJson(`${API}/v2/oauth/revoke/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ client_key: config.tiktok.clientKey, client_secret: config.tiktok.clientSecret, token }),
  });
  // Success is an empty 200; failure is { error: "<code>", error_description }.
  if (!res.ok || (typeof res.json.error === 'string' && res.json.error)) {
    throw apiError(res.status, res.json, 'Revoke failed');
  }
}

export function publicExtra(account) {
  return { refreshExpiresAt: account?.refreshExpiresAt || null };
}
