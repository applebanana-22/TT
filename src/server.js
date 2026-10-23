import express from 'express';
import path from 'node:path';
import { config, validateConfig } from './config.js';
import { loadStore } from './lib/store.js';
import { UPLOAD_DIR } from './lib/media.js';
import { authRouter } from './routes/auth.js';
import { apiRouter } from './routes/api.js';

const { errors, warnings } = validateConfig();
for (const w of warnings) console.warn(`[config] warning: ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`[config] error: ${e}`);
  console.error('\nFix .env (see .env.example) and restart.');
  process.exit(1);
}

await loadStore();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // behind ngrok / a reverse proxy

// ngrok's free tier shows an interstitial page to browsers; this header skips it
// for API clients. TikTok's downloader is not a browser, but setting it is harmless.
app.use((req, res, next) => {
  res.setHeader('ngrok-skip-browser-warning', 'true');
  next();
});

// Uploaded photos. TikTok downloads from here, so it must be publicly reachable.
app.use('/media', express.static(UPLOAD_DIR, { fallthrough: false, maxAge: '1h' }));

// public/ also serves TikTok's URL-prefix verification file (tiktok*.txt) if you drop it there.
app.use(express.static(path.resolve('public')));

app.use('/auth', authRouter);
app.use('/api', apiRouter);

app.listen(config.port, () => {
  console.log(`\nSocial Poster running`);
  console.log(`  local : http://localhost:${config.port}`);
  console.log(`  public: ${config.publicBaseUrl}`);
  console.log(`\nRegister these redirect URIs in the developer portals:`);
  console.log(`  Facebook: ${config.publicBaseUrl}/auth/facebook/callback`);
  console.log(`  TikTok  : ${config.publicBaseUrl}/auth/tiktok/callback\n`);
});
