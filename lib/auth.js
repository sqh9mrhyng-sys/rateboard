// Server-side sign-in, admin checks and rate limits, shared by the API files.
//
// Until now every check lived in the page: the browser decided who was signed
// in and who was an admin, so anyone could tell it they were the admin. Now a
// password sign-in hands out a random session token, stored here in D1, and
// anything only an admin may do needs that token from an admin account.
//
// Members who were already signed in keep working as they did; only admin
// powers and account takeovers are closed here. See kv.js.

export const ADMINS = ['dennis'];

const SESS_DDL = `CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, key TEXT NOT NULL, created INTEGER NOT NULL,
  expires INTEGER NOT NULL)`;
const SESSION_DAYS = 120;
const TOKEN_RE = /^[a-f0-9]{64}$/;

export function tokenOf(request) {
  const t = request.headers.get('x-rb-token') || '';
  return TOKEN_RE.test(t) ? t : null;
}

function randomToken() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}

export async function newSession(env, key) {
  const db = env.RATEBOARD_DB;
  await db.prepare(SESS_DDL).run();
  const token = randomToken(), now = Date.now();
  await db.prepare('INSERT INTO sessions (token, key, created, expires) VALUES (?, ?, ?, ?)')
    .bind(token, key, now, now + SESSION_DAYS * 86400000).run();
  return token;
}

export async function endSession(env, request) {
  const t = tokenOf(request);
  if (!t) return;
  memo.delete(t);
  try { await caches.default.delete(await tokenCacheReq(request, t)); } catch (e) {}
  try { await env.RATEBOARD_DB.prepare('DELETE FROM sessions WHERE token=?').bind(t).run(); } catch (e) {}
}

// The account a request's token belongs to, or null. A banned account's
// sessions stop counting at once.
//
// Every gated request used to look the token up in the database, often two
// or three times (sign-in check, admin check, access check). When the database
// was busy that lookup failed, and a failure read as "not signed in" - which is
// why pages said to sign in again, or sat loading. Now a confirmed token is
// remembered for ten minutes (in this worker and in the edge cache), a failed
// lookup is tried once more, and only a real "no such session" signs anyone out.
const SESSION_MEMO_MS = 10 * 60000;
const memo = new Map();
async function tokenCacheReq(request, t) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t));
  const h = [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, '0')).join('');
  return new Request(`${new URL(request.url).origin}/__cache/sess/v1/${h}`, { method: 'GET' });
}
export async function sessionKey(env, request) {
  const t = tokenOf(request);
  if (!t || !env.RATEBOARD_DB) return null;
  const m = memo.get(t);
  if (m && Date.now() - m.at < SESSION_MEMO_MS) return m.key;
  let creq = null;
  try {
    creq = await tokenCacheReq(request, t);
    const hit = await caches.default.match(creq);
    if (hit) { const key = await hit.text(); if (key) { memo.set(t, { key, at: Date.now() }); return key; } }
  } catch (e) {}
  const look = () => env.RATEBOARD_DB.prepare(
      `SELECT s.key AS key FROM sessions s JOIN users u ON u.key = s.key
        WHERE s.token=? AND s.expires > ? AND COALESCE(u.banned, 0) = 0`)
      .bind(t, Date.now()).first();
  let row;
  try { row = await look(); }
  catch (e) {
    await new Promise(r => setTimeout(r, 400));
    try { row = await look(); } catch (e2) { return null; }   // no sessions table yet, or the database is down
  }
  if (!row) { memo.delete(t); return null; }
  const key = String(row.key);
  memo.set(t, { key, at: Date.now() });
  if (memo.size > 5000) memo.clear();
  try {
    if (creq) await caches.default.put(creq, new Response(key, { headers: { 'cache-control': `max-age=${SESSION_MEMO_MS / 1000}` } }));
  } catch (e) {}
  return key;
}

export async function isAdminRequest(env, request) {
  const k = await sessionKey(env, request);
  return !!k && ADMINS.includes(k.toLowerCase());
}

// Password fingerprints are compared without bailing out at the first
// differing character, so timing gives nothing away.
export function sameHash(a, b) {
  a = String(a || ''); b = String(b || '');
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

// A counter in the edge cache: at most `max` hits per `windowSec` for one
// bucket. Counted per Cloudflare location rather than globally, and it costs
// no KV or D1 writes. Never throws - if the cache is unhappy, the request goes
// through.
export async function allow(origin, bucket, max, windowSec) {
  const now = Date.now(), span = windowSec * 1000;
  const req = new Request(`${origin}/__cache/rl3/${encodeURIComponent(bucket)}`, { method: 'GET' });
  try {
    const hit = await caches.default.match(req);
    let hits = [];
    if (hit) { try { hits = JSON.parse(await hit.text()) || []; } catch (e) { hits = []; } }
    hits = hits.filter(t => now - t < span);
    if (hits.length >= max) return false;
    hits.push(now);
    await caches.default.put(req, new Response(JSON.stringify(hits), {
      headers: { 'content-type': 'application/json', 'cache-control': `max-age=${windowSec}` }
    }));
    return true;
  } catch (e) { return true; }
}

export function clientIp(request) {
  return request.headers.get('cf-connecting-ip') || 'unknown';
}

export function forbidden(why) {
  return new Response(JSON.stringify({ error: why || 'admin sign-in required' }), {
    status: 403, headers: { 'content-type': 'application/json' }
  });
}
