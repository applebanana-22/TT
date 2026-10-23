// OAuth routes:  GET /auth/:provider/start  ->  provider login  ->  GET /auth/:provider/callback
import express from 'express';
import { config, isConfigured } from '../config.js';
import { providers } from '../providers/index.js';
import { Status, transition, cancelConnecting, effectiveStatus } from '../lib/connection.js';
import { getAccount } from '../lib/store.js';
import { createState, consumeState, readCookie, STATE_COOKIE } from '../lib/oauthState.js';

export const authRouter = express.Router();

function backToApp(res, params) {
  res.clearCookie(STATE_COOKIE, { path: '/auth' });
  res.redirect(`/?${new URLSearchParams(params)}`);
}

authRouter.param('provider', (req, res, next, name) => {
  if (!providers[name]) return res.status(404).send('Unknown provider');
  req.provider = providers[name];
  req.providerName = name;
  next();
});

authRouter.get('/:provider/start', async (req, res, next) => {
  try {
    const name = req.providerName;
    if (!isConfigured(name)) return backToApp(res, { error: `${name} is not configured on the server (.env)`, provider: name });

    const current = getAccount(name);
    // Facebook only re-shows declined permissions when asked with auth_type=rerequest.
    const rerequest = name === 'facebook' && Boolean(current?.needsRerequest);

    const state = createState(name);
    res.cookie(STATE_COOKIE, state, {
      httpOnly: true,
      secure: config.publicBaseUrl.startsWith('https://'),
      sameSite: 'lax', // must be lax (not strict) so it is sent on the redirect back from the provider
      maxAge: 10 * 60 * 1000,
      path: '/auth',
    });

    await transition(name, Status.CONNECTING);
    res.redirect(req.provider.authorizeUrl(state, { rerequest }));
  } catch (err) {
    next(err);
  }
});

authRouter.get('/:provider/callback', async (req, res) => {
  const name = req.providerName;
  const provider = req.provider;
  const isConnecting = () => effectiveStatus(getAccount(name)) === Status.CONNECTING;

  // 1) User cancelled / provider returned an error.
  const cbError = provider.callbackError(req.query);
  if (cbError) {
    if (isConnecting()) await cancelConnecting(name, cbError.cancelled ? 'Login cancelled' : cbError.message);
    return backToApp(res, { error: cbError.cancelled ? `${name} login was cancelled` : cbError.message, provider: name });
  }

  // 2) CSRF check. On failure we don't touch the account: this request may not be from our user.
  try {
    consumeState(name, req.query.state, readCookie(req, STATE_COOKIE));
  } catch (err) {
    if (isConnecting()) await cancelConnecting(name, err.message);
    return backToApp(res, { error: err.message, provider: name });
  }

  if (!req.query.code) {
    await transition(name, Status.ERROR, { statusReason: 'Provider returned no authorization code' });
    return backToApp(res, { error: 'No authorization code received', provider: name });
  }

  // 3) Exchange code -> tokens, load profile, validate permissions.
  try {
    const fields = await provider.completeConnect(String(req.query.code));
    await transition(name, Status.CONNECTED, { ...fields, needsRerequest: false });
    backToApp(res, { connected: name });
  } catch (err) {
    console.error(`[${name}] connect failed:`, err.message, err.details ?? '');
    await transition(name, Status.ERROR, {
      statusReason: err.message,
      needsRerequest: Boolean(err.needsRerequest),
      tokens: null, // never keep half-validated tokens around
      pages: null,
    });
    backToApp(res, { error: err.message, provider: name });
  }
});
