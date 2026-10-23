// AES-256-GCM encryption for tokens at rest. If someone copies data/db.json,
// they cannot use the tokens without TOKEN_ENCRYPTION_KEY.
import crypto from 'node:crypto';
import { config } from '../config.js';

const ALGO = 'aes-256-gcm';

function key() {
  return Buffer.from(config.encryptionKey, 'hex');
}

export function encrypt(plain) {
  if (plain == null) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key(), iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${data.toString('base64')}`;
}

export function decrypt(payload) {
  if (payload == null) return null;
  const [version, iv, tag, data] = payload.split(':');
  if (version !== 'v1') throw new Error('Unknown token encryption format');
  const decipher = crypto.createDecipheriv(ALGO, key(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

// Facebook recommends signing Graph calls with appsecret_proof so a leaked
// token cannot be used without your app secret.
export function appSecretProof(accessToken, appSecret) {
  return crypto.createHmac('sha256', appSecret).update(accessToken).digest('hex');
}
