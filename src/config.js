// Central place for configuration. Fails fast at startup with a clear list of
// what is missing, instead of failing later in the middle of an OAuth flow.

const env = process.env;

function list(value) {
  return (value || '').split(',').map((s) => s.trim()).filter(Boolean);
}

export const config = {
  port: Number(env.PORT || 3000),
  publicBaseUrl: (env.PUBLIC_BASE_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/+$/, ''),
  encryptionKey: env.TOKEN_ENCRYPTION_KEY || '',

  facebook: {
    appId: env.FACEBOOK_APP_ID || '',
    appSecret: env.FACEBOOK_APP_SECRET || '',
    graphVersion: env.FACEBOOK_GRAPH_VERSION || 'v23.0',
    scopes: list(env.FACEBOOK_SCOPES || 'pages_show_list,pages_read_engagement,pages_manage_posts'),
  },

  tiktok: {
    clientKey: env.TIKTOK_CLIENT_KEY || '',
    clientSecret: env.TIKTOK_CLIENT_SECRET || '',
    scopes: list(env.TIKTOK_SCOPES || 'user.info.basic,video.publish,video.upload'),
  },
};

export const redirectUri = (provider) => `${config.publicBaseUrl}/auth/${provider}/callback`;

// A provider is "configured" when its credentials exist. An unconfigured
// provider still shows in the UI, but its Connect button explains why it is disabled.
export function isConfigured(provider) {
  if (provider === 'facebook') return Boolean(config.facebook.appId && config.facebook.appSecret);
  if (provider === 'tiktok') return Boolean(config.tiktok.clientKey && config.tiktok.clientSecret);
  return false;
}

export function validateConfig() {
  const errors = [];
  const warnings = [];

  if (!/^[0-9a-f]{64}$/i.test(config.encryptionKey)) {
    errors.push('TOKEN_ENCRYPTION_KEY must be 64 hex chars (run: npm run gen-key)');
  }
  if (!config.publicBaseUrl.startsWith('https://')) {
    warnings.push('PUBLIC_BASE_URL is not HTTPS. TikTok requires HTTPS redirect URIs and a public, verified URL to pull photos from.');
  }
  if (!isConfigured('facebook')) warnings.push('Facebook is not configured (FACEBOOK_APP_ID / FACEBOOK_APP_SECRET).');
  if (!isConfigured('tiktok')) warnings.push('TikTok is not configured (TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET).');

  return { errors, warnings };
}
