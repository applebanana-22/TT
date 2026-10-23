// Front end: plain JS, no build step. Talks only to our own /api — tokens never reach the browser.

const $ = (sel) => document.querySelector(sel);
const LABEL = { facebook: 'Facebook', tiktok: 'TikTok' };
const STATUS_TEXT = {
  disconnected: 'Not connected', connecting: 'Connecting…', connected: 'Connected', expired: 'Expired', error: 'Error',
  pending: 'Pending', processing: 'Processing', published: 'Published', inbox: 'Sent to inbox', failed: 'Failed',
};
const PRIVACY_TEXT = {
  PUBLIC_TO_EVERYONE: 'Everyone', MUTUAL_FOLLOW_FRIENDS: 'Friends', FOLLOWER_OF_CREATOR: 'Followers', SELF_ONLY: 'Only me',
};

let accounts = {};
let publicBaseUrl = '';

// Tiny element builder that always uses textContent (no innerHTML -> no XSS).
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

function banner(text, kind = 'ok') {
  const el = $('#banner');
  el.textContent = text;
  el.className = `banner ${kind}`;
  el.hidden = !text;
  if (kind === 'ok' && text) setTimeout(() => { if (el.textContent === text) el.hidden = true; }, 6000);
}

const badge = (status) => h('span', { class: `badge s-${status}` }, STATUS_TEXT[status] || status);
const fmt = (iso) => (iso ? new Date(iso).toLocaleString() : '—');

// ---- accounts -------------------------------------------------------------

async function loadAccounts() {
  const data = await api('/accounts');
  publicBaseUrl = data.publicBaseUrl;
  accounts = Object.fromEntries(data.accounts.map((a) => [a.provider, a]));
  renderAccounts();
  renderTargets();
  checkOrigin();
}

// OAuth cookies are per-domain: the login must start on the same host the
// provider redirects back to (PUBLIC_BASE_URL).
function checkOrigin() {
  const el = $('#originWarning');
  if (publicBaseUrl && location.origin !== publicBaseUrl) {
    el.replaceChildren('You opened the app at ', h('b', {}, location.origin), '. OAuth redirects go to ',
      h('a', { href: publicBaseUrl }, publicBaseUrl), '. Open the app there, or connecting will fail the security (state) check.');
    el.hidden = false;
  } else el.hidden = true;
}

async function action(provider, kind, btn) {
  btn.disabled = true;
  try {
    if (kind === 'disconnect' && !confirm(`Disconnect ${LABEL[provider]}? This also revokes the app's access.`)) return;
    const res = await api(`/accounts/${provider}/${kind}`, { method: 'POST' });
    if (res.warning) banner(res.warning, 'warn');
    else if (kind === 'verify') banner(res.status === 'connected' ? `${LABEL[provider]} connection is working.` : `${LABEL[provider]}: ${res.statusReason || res.status}`, res.status === 'connected' ? 'ok' : 'bad');
    else banner(`${LABEL[provider]} disconnected.`);
  } catch (err) {
    banner(err.message, 'bad');
  } finally {
    btn.disabled = false;
    await loadAccounts();
  }
}

function connectButton(provider, text, primary = true) {
  // A full-page navigation (not fetch) because OAuth needs the browser to visit the provider.
  return h('button', { class: primary ? 'primary' : '', onclick: () => { location.href = `/auth/${provider}/start`; } }, text);
}

function accountCard(a) {
  const btns = [];
  const verify = h('button', { onclick: (e) => action(a.provider, 'verify', e.currentTarget) }, 'Test connection');
  const disconnect = h('button', { class: 'danger', onclick: (e) => action(a.provider, 'disconnect', e.currentTarget) }, 'Disconnect');

  if (!a.configured) {
    btns.push(h('button', { disabled: true }, 'Connect'));
  } else if (a.status === 'disconnected') {
    btns.push(connectButton(a.provider, 'Connect'));
  } else if (a.status === 'connecting') {
    btns.push(connectButton(a.provider, 'Restart login', false));
  } else if (a.status === 'connected') {
    btns.push(verify, connectButton(a.provider, 'Reconnect', false), disconnect);
  } else if (a.status === 'expired') {
    btns.push(connectButton(a.provider, 'Reconnect'), disconnect);
  } else if (a.status === 'error') {
    btns.push(connectButton(a.provider, 'Reconnect'), verify, disconnect);
  }

  let reason = null;
  if (!a.configured) reason = h('div', { class: 'reason warn' }, `Add ${a.provider === 'facebook' ? 'FACEBOOK_APP_ID / FACEBOOK_APP_SECRET' : 'TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET'} to .env and restart.`);
  else if (a.status === 'connecting') reason = h('div', { class: 'reason warn' }, 'Waiting for you to finish logging in. If you closed the login tab, click "Restart login".');
  else if (a.statusReason) reason = h('div', { class: `reason ${a.status === 'connected' ? 'warn' : 'bad'}` }, a.statusReason);

  const meta = [];
  if (a.status === 'connected' || a.status === 'expired') {
    meta.push(`Connected: ${fmt(a.connectedAt)}`, `Last verified: ${fmt(a.lastVerifiedAt)}`);
    if (a.provider === 'tiktok') meta.push(`Access token until: ${fmt(a.expiresAt)} (auto-refresh)`, `Refresh token until: ${fmt(a.refreshExpiresAt)}`);
    if (a.provider === 'facebook') meta.push(`User token until: ${fmt(a.userTokenExpiresAt)}`);
    if (a.scopes.length) meta.push(`Scopes: ${a.scopes.join(', ')}`);
  }

  let pagePicker = null;
  if (a.provider === 'facebook' && a.status === 'connected' && a.pages?.length) {
    const select = h('select', {
      onchange: async (e) => {
        try { await api('/accounts/facebook/page', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pageId: e.target.value }) }); await loadAccounts(); }
        catch (err) { banner(err.message, 'bad'); }
      },
    }, a.pages.map((p) => h('option', { value: p.id, selected: p.id === a.selectedPageId }, p.name + (p.canPost ? '' : ' (no posting permission)'))));
    pagePicker = h('div', {}, h('label', {}, 'Post as Page'), select);
  }

  return h('article', { class: 'card' },
    h('header', {}, h('h3', {}, LABEL[a.provider]), badge(a.status)),
    a.profile
      ? h('div', { class: 'profile' }, a.profile.avatar ? h('img', { src: a.profile.avatar, alt: '' }) : null, h('div', {}, h('b', {}, a.profile.name || a.profile.id)))
      : h('div', { class: 'profile muted small' }, a.status === 'disconnected' ? 'No account linked.' : ''),
    reason,
    pagePicker,
    meta.length ? h('div', { class: 'meta' }, meta.map((m) => h('div', {}, m))) : null,
    h('div', { class: 'btns' }, btns),
  );
}

function renderAccounts() {
  $('#accounts').replaceChildren(...['facebook', 'tiktok'].map((p) => accountCard(accounts[p])));
}

// ---- composer -------------------------------------------------------------

function renderTargets() {
  for (const box of document.querySelectorAll('input[name=target]')) {
    const a = accounts[box.value];
    const ok = a?.status === 'connected';
    box.disabled = !ok;
    if (!ok) box.checked = false;
    const hint = box.value === 'facebook' ? $('#fbTargetHint') : $('#ttTargetHint');
    if (!ok) hint.textContent = '(connect first)';
    else if (box.value === 'facebook') hint.textContent = `→ ${a.pages?.find((p) => p.id === a.selectedPageId)?.name || ''}`;
    else hint.textContent = a.profile?.name ? `→ ${a.profile.name}` : '';
  }
  toggleTikTokOptions();
}

const selectedTargets = () => [...document.querySelectorAll('input[name=target]:checked')].map((b) => b.value);
const tiktokMode = () => document.querySelector('input[name=tiktokMode]:checked').value;

let creatorLoadedAt = 0;
async function toggleTikTokOptions() {
  const on = selectedTargets().includes('tiktok');
  $('#tiktokOptions').hidden = !on;
  $('#directOnly').hidden = tiktokMode() !== 'DIRECT_POST';
  // TikTok guideline: fetch creator info fresh when the user is about to post.
  if (on && Date.now() - creatorLoadedAt > 60_000) await loadCreatorInfo();
}

async function loadCreatorInfo() {
  const box = $('#creatorInfo');
  box.textContent = 'Loading creator info…';
  try {
    const info = await api('/tiktok/creator-info');
    creatorLoadedAt = Date.now();
    box.replaceChildren(info.avatar ? h('img', { src: info.avatar, alt: '' }) : null, `Posting as ${info.nickname} (@${info.username})`);
    const sel = $('#tiktokPrivacy');
    const prev = sel.value;
    // No default selection on purpose (TikTok UX requirement).
    sel.replaceChildren(h('option', { value: '' }, 'Select privacy…'),
      ...info.privacyLevelOptions.map((o) => h('option', { value: o, selected: o === prev }, PRIVACY_TEXT[o] || o)));
    const dc = $('#tiktokDisableComment');
    dc.disabled = info.commentDisabled;
    if (info.commentDisabled) dc.checked = true;
  } catch (err) {
    box.textContent = `Could not load creator info: ${err.message}`;
    await loadAccounts(); // the account may have just become expired
  }
}

function setFile(file) {
  const input = $('#photo');
  if (file && input.files[0] !== file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
  }
  const img = $('#preview');
  if (!file) { img.hidden = true; $('#dropText').hidden = false; $('#fileInfo').textContent = ''; return; }
  img.src = URL.createObjectURL(file);
  img.hidden = false;
  $('#dropText').hidden = true;
  $('#fileInfo').textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB · ${file.type || 'unknown type'}`;
}

// Quick client-side checks for fast feedback. The server re-checks everything.
function clientValidate() {
  const file = $('#photo').files[0];
  const targets = selectedTargets();
  const errs = [];
  if (!file) errs.push('Choose a photo.');
  if (!targets.length) errs.push('Choose at least one platform.');
  if (file && targets.includes('facebook') && file.size > 4 * 1024 * 1024) errs.push('Facebook: photo must be 4 MB or less.');
  if (file && targets.includes('tiktok') && !['image/jpeg', 'image/webp'].includes(file.type)) errs.push('TikTok: only JPEG or WEBP photos are supported.');
  if (targets.includes('tiktok') && tiktokMode() === 'DIRECT_POST' && !$('#tiktokPrivacy').value) errs.push('TikTok: choose who can view the post.');
  return errs;
}

async function submit(e) {
  e.preventDefault();
  const errs = clientValidate();
  if (errs.length) return banner(errs.join('\n'), 'bad');

  const fd = new FormData();
  fd.set('photo', $('#photo').files[0]);
  fd.set('caption', $('#caption').value);
  fd.set('targets', selectedTargets().join(','));
  fd.set('tiktokMode', tiktokMode());
  fd.set('tiktokPrivacy', $('#tiktokPrivacy').value);
  fd.set('tiktokTitle', $('#tiktokTitle').value);
  fd.set('tiktokDisableComment', String($('#tiktokDisableComment').checked));
  fd.set('tiktokAutoMusic', String($('#tiktokAutoMusic').checked));

  const btn = $('#submitBtn');
  btn.disabled = true;
  $('#submitStatus').textContent = 'Publishing…';
  try {
    const post = await api('/posts', { method: 'POST', body: fd });
    const results = Object.entries(post.targets);
    const failed = results.filter(([, r]) => r.status === 'failed');
    if (!failed.length) {
      banner('Submitted! Check the history below for the final status.');
      $('#composer').reset();
      setFile(null);
      $('#captionCount').textContent = '0';
    } else {
      banner(failed.map(([t, r]) => `${LABEL[t]}: ${r.error}`).join('\n'), failed.length === results.length ? 'bad' : 'warn');
    }
  } catch (err) {
    banner(err.message, 'bad');
  } finally {
    btn.disabled = false;
    $('#submitStatus').textContent = '';
    await Promise.all([loadPosts(), loadAccounts()]);
  }
}

// ---- history --------------------------------------------------------------

function postRow(p) {
  const targets = Object.entries(p.targets).map(([t, r]) => h('div', { class: 'target' },
    h('b', {}, LABEL[t]), badge(r.status),
    r.pageName ? h('span', { class: 'muted' }, `on ${r.pageName}`) : null,
    r.mode ? h('span', { class: 'muted' }, r.mode === 'DIRECT_POST' ? 'direct post' : 'draft to inbox') : null,
    r.url ? h('a', { href: r.url, target: '_blank', rel: 'noopener' }, 'Open ↗') : null,
    r.status === 'inbox' ? h('span', { class: 'muted' }, 'Open the TikTok app to finish posting.') : null,
    r.status === 'published' && t === 'tiktok' && !r.url ? h('span', { class: 'muted' }, 'Published (private posts have no public link).') : null,
    r.error ? h('span', { class: 'err' }, r.error) : null,
  ));
  return h('div', { class: 'post' },
    h('img', { src: p.image.url, alt: '' }),
    h('div', { class: 'body' },
      h('div', { class: 'small muted' }, fmt(p.createdAt)),
      h('div', { class: 'caption' }, p.caption || h('i', { class: 'muted' }, 'No caption')),
      targets,
    ),
  );
}

let posts = [];
async function loadPosts() {
  posts = (await api('/posts')).posts;
  $('#posts').replaceChildren(...(posts.length ? posts.map(postRow) : [h('p', { class: 'muted' }, 'Nothing posted yet.')]));
}

// Poll TikTok posts that are still processing (TikTok downloads + publishes asynchronously).
async function pollProcessing() {
  const processing = posts.filter((p) => p.targets.tiktok?.status === 'processing');
  if (!processing.length) return;
  await Promise.all(processing.map((p) => api(`/posts/${p.id}/refresh`, { method: 'POST' }).catch(() => {})));
  await loadPosts();
}

// ---- boot -----------------------------------------------------------------

function readRedirectResult() {
  const q = new URLSearchParams(location.search);
  if (q.get('connected')) banner(`${LABEL[q.get('connected')]} connected successfully.`);
  if (q.get('error')) banner(`${LABEL[q.get('provider')] || 'Login'}: ${q.get('error')}`, 'bad');
  if (q.toString()) history.replaceState(null, '', '/');
}

function wireComposer() {
  $('#photo').addEventListener('change', (e) => setFile(e.target.files[0]));
  const dz = $('#dropzone');
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('drag'); if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]); });
  $('#caption').addEventListener('input', (e) => { $('#captionCount').textContent = e.target.value.length; });
  for (const el of document.querySelectorAll('input[name=target], input[name=tiktokMode]')) el.addEventListener('change', toggleTikTokOptions);
  $('#composer').addEventListener('submit', submit);
}

readRedirectResult();
wireComposer();
await Promise.all([loadAccounts(), loadPosts()]).catch((err) => banner(err.message, 'bad'));

setInterval(pollProcessing, 4000);
// Status can change while the tab is in the background (e.g. "connecting" timing out).
window.addEventListener('focus', () => loadAccounts().catch(() => {}));
