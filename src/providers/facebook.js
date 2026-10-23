// Facebook (Meta Graph API) provider.
//
// Important facts for learning:
// - The Graph API can NOT post to a personal profile. It posts to Facebook Pages
//   that the user manages. So "connecting Facebook" = log the user in, then pick a Page.
// - Flow: code -> short-lived user token (~1-2h) -> long-lived user token (~60 days)
//   -> /me/accounts returns Page access tokens. Page tokens obtained from a
//   long-lived user token do not expire (until the user changes password,
//   removes the app, loses the Page role, etc.).
// - Error code 190 = token invalid/expired -> the account must reconnect.
import fs from 'node:fs';
import { config, redirectUri } from '../config.js';
import { encrypt, decrypt, appSecretProof } from '../lib/crypto.js';
import { requestJson, ProviderError } from '../lib/http.js';

const NAME = 'facebook';
const graph = (path) => `https://graph.facebook.com/${config.facebook.graphVersion}${path}`;

// Permissions we can't work without. pages_show_list lists Pages, pages_manage_posts publishes.
const REQUIRED_PERMISSIONS = ['pages_show_list', 'pages_manage_posts'];

function toError(status, json, fallback) {
  const e = json?.error;
  if (!e) return new ProviderError(NAME, fallback, { httpStatus: status, details: json });
  const auth = e.code === 190 || e.code === 102 || e.error_subcode === 458 || e.error_subcode === 460 || e.error_subcode === 463;
  const hint = {
    190: 'Access token is invalid or expired.',
    10: 'Permission denied. Check that the required permission was granted.',
    200: 'Permission error. You may lack the right role on this Page or the permission was not granted.',
    368: 'Facebook temporarily blocked this action (policy / spam protection).',
    4: 'App rate limit reached. Try again later.',
    32: 'Page rate limit reached. Try again later.',
  }[e.code];
  return new ProviderError(NAME, `${hint ? hint + ' ' : ''}${e.message}`, {
    code: e.code, httpStatus: status, auth, details: { ...e, fbtrace_id: e.fbtrace_id },
  });
}

async function graphGet(path, token, params = {}) {
  const url = new URL(graph(path));
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (token) {
    url.searchParams.set('access_token', token);
    url.searchParams.set('appsecret_proof', appSecretProof(token, config.facebook.appSecret));
  }
  const { ok, status, json } = await requestJson(url);
  if (!ok || json.error) throw toError(status, json, `Graph GET ${path} failed (${status})`);
  return json;
}

// ---- OAuth ----------------------------------------------------------------

export function authorizeUrl(state, { rerequest = false } = {}) {
  const url = new URL(`https://www.facebook.com/${config.facebook.graphVersion}/dialog/oauth`);
  url.searchParams.set('client_id', config.facebook.appId);
  url.searchParams.set('redirect_uri', redirectUri(NAME));
  url.searchParams.set('state', state);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', config.facebook.scopes.join(','));
  // If the user previously declined a permission, Facebook will not ask again
  // unless we explicitly re-request it.
  if (rerequest) url.searchParams.set('auth_type', 'rerequest');
  return url.toString();
}

// Reads the "error" params Facebook appends when the user cancels.
export function callbackError(query) {
  if (!query.error) return null;
  return {
    cancelled: query.error === 'access_denied',
    message: query.error_description || query.error_reason || query.error,
  };
}

async function exchangeCode(code) {
  const short = await graphGet('/oauth/access_token', null, {
    client_id: config.facebook.appId,
    client_secret: config.facebook.appSecret,
    redirect_uri: redirectUri(NAME),
    code,
  });
  const long = await graphGet('/oauth/access_token', null, {
    grant_type: 'fb_exchange_token',
    client_id: config.facebook.appId,
    client_secret: config.facebook.appSecret,
    fb_exchange_token: short.access_token,
  });
  return {
    accessToken: long.access_token,
    // expires_in is sometimes omitted; ~60 days is the documented lifetime.
    expiresAt: new Date(Date.now() + (long.expires_in || 60 * 24 * 3600) * 1000).toISOString(),
  };
}

async function loadPermissions(userToken) {
  const { data } = await graphGet('/me/permissions', userToken);
  return {
    granted: data.filter((p) => p.status === 'granted').map((p) => p.permission),
    declined: data.filter((p) => p.status !== 'granted').map((p) => p.permission),
  };
}

async function loadPages(userToken) {
  const pages = [];
  let res = await graphGet('/me/accounts', userToken, { fields: 'id,name,access_token,tasks,picture{url}', limit: '100' });
  // Follow pagination (users can manage many Pages). "next" URLs already carry the token.
  for (;;) {
    for (const p of res.data || []) {
      pages.push({
        id: p.id,
        name: p.name,
        tasks: p.tasks || [],
        picture: p.picture?.data?.url || null,
        token: encrypt(p.access_token),
      });
    }
    if (!res.paging?.next) break;
    const { ok, status, json } = await requestJson(res.paging.next);
    if (!ok || json.error) throw toError(status, json, `Loading Pages failed (${status})`);
    res = json;
  }
  return pages;
}

// Called by the OAuth callback. Returns the fields to store on the account,
// or throws if the connection is not usable (e.g. a required permission was declined).
export async function completeConnect(code) {
  const { accessToken, expiresAt } = await exchangeCode(code);
  const [me, perms] = await Promise.all([
    graphGet('/me', accessToken, { fields: 'id,name,picture{url}' }),
    loadPermissions(accessToken),
  ]);

  const missing = REQUIRED_PERMISSIONS.filter((p) => !perms.granted.includes(p));
  if (missing.length) {
    const e = new Error(`Required permission(s) not granted: ${missing.join(', ')}. Click Connect again and allow them.`);
    e.needsRerequest = true;
    throw e;
  }

  const pages = await loadPages(accessToken);
  if (!pages.length) {
    throw new Error('Login worked, but no Facebook Pages were shared with this app. You must be an admin/editor of a Page and select it in the Facebook dialog.');
  }

  return {
    profile: { id: me.id, name: me.name, avatar: me.picture?.data?.url || null },
    tokens: { user: encrypt(accessToken) },
    scopes: perms.granted,
    // Informational: when the user token dies. Page tokens keep working past this.
    userTokenExpiresAt: expiresAt,
    expiresAt: null,
    pages,
    selectedPageId: pages[0].id,
  };
}

// ---- health check ---------------------------------------------------------

// Returns { ok, patch, reason }. ok=false + auth=true means the account is EXPIRED.
export async function verify(account) {
  const page = selectedPage(account);
  const userToken = decrypt(account.tokens?.user);
  try {
    const [perms, pages] = await Promise.all([loadPermissions(userToken), loadPages(userToken)]);
    const missing = REQUIRED_PERMISSIONS.filter((p) => !perms.granted.includes(p));
    if (missing.length) return { ok: false, reason: `Permission removed: ${missing.join(', ')}` };
    if (!pages.length) return { ok: false, reason: 'No Pages are available to this app anymore.' };
    const selectedPageId = pages.some((p) => p.id === account.selectedPageId) ? account.selectedPageId : pages[0].id;
    return { ok: true, patch: { pages, selectedPageId, scopes: perms.granted } };
  } catch (err) {
    if (!(err instanceof ProviderError && err.auth) || !page) throw err;
    // User token is dead, but the Page token may still be valid.
    await graphGet('/me', decrypt(page.token), { fields: 'id,name' });
    return { ok: true, reason: 'User token expired, Page token still valid. Reconnect to refresh the Page list.' };
  }
}

// ---- publishing -----------------------------------------------------------

export function selectedPage(account) {
  return account?.pages?.find((p) => p.id === account.selectedPageId) || null;
}

// Uploads the photo bytes directly (multipart "source" field), so Facebook
// does not need to reach our server.
export async function publishPhoto(account, { filePath, mime, caption }) {
  const page = selectedPage(account);
  if (!page) throw new Error('No Facebook Page selected');
  const token = decrypt(page.token);

  const body = new FormData();
  body.set('source', await fs.openAsBlob(filePath, { type: mime }), 'photo');
  if (caption) body.set('message', caption);
  body.set('published', 'true');
  body.set('access_token', token);
  body.set('appsecret_proof', appSecretProof(token, config.facebook.appSecret));

  const { ok, status, json } = await requestJson(graph(`/${page.id}/photos`), { method: 'POST', body, timeoutMs: 60000 });
  if (!ok || json.error) throw toError(status, json, `Photo upload failed (${status})`);

  // json = { id: <photo id>, post_id: <pageId_postId> }
  return {
    photoId: json.id,
    postId: json.post_id,
    url: json.post_id ? `https://www.facebook.com/${json.post_id}` : `https://www.facebook.com/${json.id}`,
    pageId: page.id,
    pageName: page.name,
  };
}

// ---- disconnect -----------------------------------------------------------

// Revokes the app's permissions on Facebook's side (best effort).
export async function revoke(account) {
  const token = decrypt(account.tokens?.user);
  if (!token) return;
  const url = new URL(graph('/me/permissions'));
  url.searchParams.set('access_token', token);
  url.searchParams.set('appsecret_proof', appSecretProof(token, config.facebook.appSecret));
  const { ok, status, json } = await requestJson(url, { method: 'DELETE' });
  if (!ok || json.error) throw toError(status, json, `Revoke failed (${status})`);
}

// Fields safe to show in the browser.
export function publicExtra(account) {
  return {
    pages: (account?.pages || []).map(({ id, name, picture, tasks }) => ({ id, name, picture, canPost: tasks.includes('CREATE_CONTENT') })),
    selectedPageId: account?.selectedPageId || null,
    userTokenExpiresAt: account?.userTokenExpiresAt || null,
  };
}
