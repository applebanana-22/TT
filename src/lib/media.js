// Photo upload handling + validation.
// We never trust the browser's MIME type or file extension: we read the first
// bytes of the file ("magic numbers") to find the real format.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';

export const UPLOAD_DIR = path.resolve('uploads');
const MB = 1024 * 1024;

// Per-platform rules (from each platform's docs).
export const RULES = {
  facebook: { mimes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'], maxBytes: 4 * MB },
  tiktok: { mimes: ['image/jpeg', 'image/webp'], maxBytes: 20 * MB },
};

export const upload = multer({
  storage: multer.diskStorage({
    destination: async (req, file, cb) => {
      await fs.mkdir(UPLOAD_DIR, { recursive: true });
      cb(null, UPLOAD_DIR);
    },
    // Random, unguessable name. Extension is fixed after sniffing.
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex')),
  }),
  limits: { fileSize: 20 * MB, files: 1 },
});

export async function sniffImage(filePath) {
  const fh = await fs.open(filePath, 'r');
  const buf = Buffer.alloc(12);
  await fh.read(buf, 0, 12, 0);
  await fh.close();
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: '.jpg' };
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: '.png' };
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return { mime: 'image/webp', ext: '.webp' };
  if (buf.toString('ascii', 0, 4) === 'GIF8') return { mime: 'image/gif', ext: '.gif' };
  return null;
}

// Returns a list of human-readable problems for the chosen targets.
export function checkRules(targets, { mime, size }) {
  const problems = [];
  for (const t of targets) {
    const r = RULES[t];
    if (!r.mimes.includes(mime)) problems.push(`${t}: ${mime} is not supported (allowed: ${r.mimes.join(', ')})`);
    if (size > r.maxBytes) problems.push(`${t}: file is ${(size / MB).toFixed(1)} MB, max is ${r.maxBytes / MB} MB`);
  }
  return problems;
}
