import express from 'express';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { config, isConfigured } from '../config.js';
import { providers, PROVIDER_NAMES, withAuthHandling } from '../providers/index.js';
import { Status, transition, effectiveStatus, publicView } from '../lib/connection.js';
import { getAccount, patchAccount, listPosts, getPost, savePost } from '../lib/store.js';
import { upload, sniffImage, checkRules } from '../lib/media.js';

export const apiRouter = express.Router();

// Express 4 doesn't catch rejected promises; this forwards them to the error handler.
const ah = (fn) => (req, res, next) => fn(req, res, next).catch(next);

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function accountView(name) {
  const account = getAccount(name);
  return publicView(name, account, { configured: isConfigured(name), ...providers[name].publicExtra(account) });
}

function requireConnected(name) {
  const account = getAccount(name);
  const status = effectiveStatus(account);
  if (status !== Status.CONNECTED) throw new HttpError(409, `${name} is not connected (status: ${status})`);
  return account;
}

function requireProvider(req) {
  const name = req.params.provider;
  if (!providers[name]) throw new HttpError(404, 'Unknown provider');
  return name;
}

// ---- accounts -------------------------------------------------------------

apiRouter.get('/accounts', (req, res) => {
  res.json({ accounts: PROVIDER_NAMES.map(accountView), publicBaseUrl: config.publicBaseUrl });
});

// "Test connection": calls the provider with the stored token.
apiRouter.post('/accounts/:provider/verify', ah(async (req, res) => {
  const name = requireProvider(req);
  const account = getAccount(name);
  const status = effectiveStatus(account);
  if (![Status.CONNECTED, Status.EXPIRED, Status.ERROR].includes(status) || !account?.tokens) {
    throw new HttpError(409, `Nothing to verify (status: ${status})`);
  }
  try {
    const result = await withAuthHandling(name, () => providers[name].verify(account));
    if (result.ok) {
      await transition(name, Status.CONNECTED, { ...result.patch, statusReason: result.reason || null, lastVerifiedAt: new Date().toISOString() });
    } else {
      await transition(name, Status.ERROR, { statusReason: result.reason });
    }
  } catch (err) {
    // Auth errors were already turned into EXPIRED by withAuthHandling.
    if (!err.auth) await transition(name, Status.ERROR, { statusReason: err.message });
  }
  res.json(accountView(name));
}));

apiRouter.post('/accounts/:provider/disconnect', ah(async (req, res) => {
  const name = requireProvider(req);
  const account = getAccount(name);
  let warning = null;
  if (account?.tokens) {
    try {
      await providers[name].revoke(account);
    } catch (err) {
      // Still disconnect locally; the token may already be dead.
      warning = `Disconnected locally, but revoking on ${name} failed: ${err.message}`;
    }
  }
  await transition(name, Status.DISCONNECTED, { statusReason: warning });
  res.json({ ...accountView(name), warning });
}));

apiRouter.put('/accounts/facebook/page', express.json(), ah(async (req, res) => {
  const account = requireConnected('facebook');
  const pageId = String(req.body?.pageId || '');
  if (!account.pages?.some((p) => p.id === pageId)) throw new HttpError(400, 'Unknown Page');
  await patchAccount('facebook', { selectedPageId: pageId });
  res.json(accountView('facebook'));
}));

apiRouter.get('/tiktok/creator-info', ah(async (req, res) => {
  requireConnected('tiktok');
  res.json(await withAuthHandling('tiktok', () => providers.tiktok.creatorInfo()));
}));

// ---- posts ----------------------------------------------------------------

apiRouter.get('/posts', (req, res) => res.json({ posts: listPosts() }));

apiRouter.post('/posts', upload.single('photo'), ah(async (req, res) => {
  const file = req.file;
  try {
    if (!file) throw new HttpError(400, 'Choose a photo');

    const targets = String(req.body.targets || '').split(',').filter((t) => providers[t]);
    if (!targets.length) throw new HttpError(400, 'Choose at least one platform');
    const accounts = Object.fromEntries(targets.map((t) => [t, requireConnected(t)]));

    // Validate the real file type and per-platform limits BEFORE calling any API.
    const kind = await sniffImage(file.path);
    if (!kind) throw new HttpError(400, 'File is not a supported image (JPEG, PNG, WEBP, GIF)');
    const problems = checkRules(targets, { mime: kind.mime, size: file.size });
    if (problems.length) throw new HttpError(400, problems.join('\n'));

    const caption = String(req.body.caption || '').trim();
    const tiktokOpts = {
      mode: req.body.tiktokMode === 'MEDIA_UPLOAD' ? 'MEDIA_UPLOAD' : 'DIRECT_POST',
      privacyLevel: req.body.tiktokPrivacy || null,
      title: String(req.body.tiktokTitle || '').trim(),
      disableComment: req.body.tiktokDisableComment === 'true',
      autoAddMusic: req.body.tiktokAutoMusic === 'true',
    };

    if (targets.includes('tiktok') && tiktokOpts.mode === 'DIRECT_POST') {
      // Re-check on the server: the creator may be unable to post right now,
      // and the chosen privacy level must be one TikTok offered.
      const info = await withAuthHandling('tiktok', () => providers.tiktok.creatorInfo());
      if (!info.privacyLevelOptions.includes(tiktokOpts.privacyLevel)) {
        throw new HttpError(400, `TikTok privacy must be one of: ${info.privacyLevelOptions.join(', ')}`);
      }
      tiktokOpts.username = info.username;
    }

    const filename = file.filename + kind.ext;
    await fs.rename(file.path, `${file.destination}/${filename}`);
    const filePath = `${file.destination}/${filename}`;

    const post = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      caption,
      image: { filename, mime: kind.mime, size: file.size, url: `/media/${filename}` },
      targets: Object.fromEntries(targets.map((t) => [t, { status: 'pending' }])),
    };
    await savePost(post);

    // Each platform succeeds or fails independently (partial success is normal).
    await Promise.all(targets.map(async (t) => {
      try {
        if (t === 'facebook') {
          const r = await withAuthHandling(t, () => providers.facebook.publishPhoto(accounts.facebook, { filePath, mime: kind.mime, caption }));
          post.targets.facebook = { status: 'published', ...r };
        } else if (t === 'tiktok') {
          const imageUrl = `${config.publicBaseUrl}/media/${filename}`;
          const r = await withAuthHandling(t, () => providers.tiktok.publishPhoto(accounts.tiktok, {
            ...tiktokOpts, imageUrl, description: caption, title: tiktokOpts.title || caption.split('\n')[0],
          }));
          post.targets.tiktok = { status: 'processing', mode: tiktokOpts.mode, username: tiktokOpts.username || null, ...r };
        }
      } catch (err) {
        console.error(`[${t}] publish failed:`, err.message, err.details ?? '');
        post.targets[t] = { status: 'failed', error: err.message, code: err.code ?? null };
      }
    }));

    await savePost(post);
    res.status(201).json(post);
  } catch (err) {
    // Don't leave rejected uploads on disk.
    if (file) await fs.unlink(file.path).catch(() => {});
    throw err;
  }
}));

// TikTok publishing is async: the browser calls this to poll the status.
apiRouter.post('/posts/:id/refresh', ah(async (req, res) => {
  const post = getPost(req.params.id);
  if (!post) throw new HttpError(404, 'Post not found');
  const tt = post.targets.tiktok;
  if (tt?.status === 'processing' && tt.publishId) {
    requireConnected('tiktok');
    const s = await withAuthHandling('tiktok', () => providers.tiktok.fetchStatus(tt.publishId));
    post.targets.tiktok = {
      ...tt,
      status: s.status,
      rawStatus: s.rawStatus,
      error: s.error,
      postIds: s.postIds,
      url: s.postIds[0] && tt.username ? `https://www.tiktok.com/@${tt.username}/photo/${s.postIds[0]}` : null,
      checkedAt: new Date().toISOString(),
    };
    await savePost(post);
  }
  res.json(post);
}));

// ---- errors ---------------------------------------------------------------

// eslint-disable-next-line no-unused-vars
apiRouter.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File is too large (max 20 MB)' });
  const status = err.status || (err.provider ? 502 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message, code: err.code ?? null, provider: err.provider ?? null });
});
