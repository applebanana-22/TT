// Tiny JSON-file database. Good enough for a single-user learning project:
// - in-memory copy for fast reads
// - writes go to a temp file and are then renamed, so a crash mid-write
//   never leaves a half-written (corrupt) db.json
// - writes are serialized through a promise chain so they never interleave
import fs from 'node:fs/promises';
import path from 'node:path';

const DATA_DIR = path.resolve('data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const EMPTY = () => ({ accounts: {}, posts: [] });

let db = EMPTY();
let writeChain = Promise.resolve();

export async function loadStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    db = { ...EMPTY(), ...JSON.parse(await fs.readFile(DB_FILE, 'utf8')) };
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`Could not read ${DB_FILE}: ${err.message}`);
    db = EMPTY();
    await persist();
  }
}

function persist() {
  const snapshot = JSON.stringify(db, null, 2);
  writeChain = writeChain.then(async () => {
    const tmp = `${DB_FILE}.tmp`;
    await fs.writeFile(tmp, snapshot);
    await fs.rename(tmp, DB_FILE);
  });
  return writeChain;
}

// ---- accounts -------------------------------------------------------------

export function getAccount(provider) {
  return db.accounts[provider] || null;
}

export async function saveAccount(provider, account) {
  db.accounts[provider] = { ...account, updatedAt: new Date().toISOString() };
  await persist();
  return db.accounts[provider];
}

export async function patchAccount(provider, patch) {
  return saveAccount(provider, { ...(db.accounts[provider] || {}), ...patch });
}

export async function deleteAccount(provider) {
  delete db.accounts[provider];
  await persist();
}

// ---- posts ----------------------------------------------------------------

export function listPosts() {
  return [...db.posts].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getPost(id) {
  return db.posts.find((p) => p.id === id) || null;
}

export async function savePost(post) {
  const i = db.posts.findIndex((p) => p.id === post.id);
  if (i === -1) db.posts.push(post);
  else db.posts[i] = post;
  await persist();
  return post;
}
