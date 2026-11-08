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
/* Is this request's token a live session? 'ok', 'none' (no token, or the
   database answered and doesn't know it), or 'unknown' (couldn't ask). */
export async function sessionState(env, request) {
  const t = tokenOf(request);
  if (!t) return 'none';
  if (!env.RATEBOARD_DB) return 'unknown';
  for (let i = 0; i < 4; i++) {
    try {
      const row = await env.RATEBOARD_DB.prepare(`SELECT s.key AS key FROM sessions s JOIN users u ON u.key = s.key
          WHERE s.token=? AND s.expires > ? AND COALESCE(u.banned, 0) = 0`).bind(t, Date.now()).first();
      return row ? 'ok' : 'none';
    } catch (e) { await new Promise(r => setTimeout(r, 300 * (i + 1))); }
  }
  return 'unknown';
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
  // A busy database answers with an error now and then: try a few times
  // before deciding nobody is signed in.
  let row, ok = false;
  for (let i = 0; i < 4 && !ok; i++) {
    try { row = await look(); ok = true; }
    catch (e) { await new Promise(r => setTimeout(r, 300 * (i + 1))); }
  }
  if (!ok) return null;   // no sessions table yet, or the database is down
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


/* ---- who's around --------------------------------------------------------
   Seen-at and active days, written at most once every 10 minutes per member
   per worker (and the day row once per day), from the calls a page makes when
   it opens - so a busy evening costs a few thousand small writes, not one
   per request. */
const SEEN_DDL = ['CREATE TABLE IF NOT EXISTS user_seen (key TEXT PRIMARY KEY, last INTEGER)',
  'CREATE TABLE IF NOT EXISTS user_days (day TEXT, key TEXT, PRIMARY KEY (day, key))'];
const seenMemo = new Map();
let seenReady = false;
export const etDay = (ms = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
export function touchSeen(env, key, waitUntil) {
  if (!key || !env || !env.RATEBOARD_DB) return;
  const now = Date.now(), day = etDay(now), m = seenMemo.get(key);
  if (m && now - m.at < 10 * 60000 && m.day === day) return;
  seenMemo.set(key, { at: now, day });
  if (seenMemo.size > 20000) seenMemo.clear();
  const db = env.RATEBOARD_DB;
  const job = (async () => {
    if (!seenReady) { for (const d of SEEN_DDL) await db.prepare(d).run(); seenReady = true; }
    await db.batch([
      db.prepare('INSERT INTO user_seen (key, last) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET last=excluded.last').bind(key, now),
      ...(!m || m.day !== day ? [db.prepare('INSERT OR IGNORE INTO user_days (day, key) VALUES (?, ?)').bind(day, key)] : [])
    ]);
  })().catch(() => {});
  try { waitUntil ? waitUntil(job) : null; } catch (e) {}
}
export async function userStats(env) {
  const db = env.RATEBOARD_DB;
  for (const d of SEEN_DDL) { try { await db.prepare(d).run(); } catch (e) {} }
  const now = Date.now(), H = 3600000, D = 24 * H;
  const one = async (sql, ...b) => { try { const r = await db.prepare(sql).bind(...b).first(); return r ? Number(Object.values(r)[0]) || 0 : 0; } catch (e) { return null; } };
  const dayAgo = n => etDay(now - n * D);
  const out = {
    total: await one('SELECT COUNT(*) AS n FROM users'),
    banned: await one('SELECT COUNT(*) AS n FROM users WHERE COALESCE(banned, 0) = 1'),
    activeNow: await one('SELECT COUNT(*) AS n FROM user_seen WHERE last >= ?', now - 15 * 60000),
    activeHour: await one('SELECT COUNT(*) AS n FROM user_seen WHERE last >= ?', now - H),
    activeToday: await one('SELECT COUNT(*) AS n FROM user_days WHERE day = ?', etDay(now)),
    activeWeek: await one('SELECT COUNT(DISTINCT key) AS n FROM user_days WHERE day >= ?', dayAgo(6)),
    activeMonth: await one('SELECT COUNT(DISTINCT key) AS n FROM user_days WHERE day >= ?', dayAgo(29)),
    newToday: await one('SELECT COUNT(*) AS n FROM users WHERE created >= ?', Date.parse(etDay(now) + 'T00:00:00-05:00')),
    newWeek: await one('SELECT COUNT(*) AS n FROM users WHERE created >= ?', now - 7 * D),
    newMonth: await one('SELECT COUNT(*) AS n FROM users WHERE created >= ?', now - 30 * D),
    // Sign-ins (new sessions) - there from before activity tracking started.
    signinWeek: await one('SELECT COUNT(DISTINCT key) AS n FROM sessions WHERE created >= ?', now - 7 * D),
    signinMonth: await one('SELECT COUNT(DISTINCT key) AS n FROM sessions WHERE created >= ?', now - 30 * D),
    tracking: await one('SELECT MIN(day) AS d FROM user_days') ,
    days: []
  };
  try { const r = await db.prepare('SELECT MIN(day) AS d FROM user_days').first(); out.trackingSince = r && r.d || null; } catch (e) {}
  delete out.tracking;
  try {
    // 60 days (2026-11-08: averages and growth on the admin page).
    const a = (await db.prepare('SELECT day, COUNT(*) AS n FROM user_days WHERE day >= ? GROUP BY day').bind(dayAgo(59)).all()).results || [];
    const nu = (await db.prepare('SELECT created FROM users WHERE created >= ?').bind(now - 60 * D).all()).results || [];
    const byNew = {}; for (const x of nu) { const d = etDay(Number(x.created)); byNew[d] = (byNew[d] || 0) + 1; }
    const byAct = Object.fromEntries(a.map(x => [x.day, x.n]));
    for (let i = 59; i >= 0; i--) { const d = dayAgo(i); out.days.push({ day: d, active: byAct[d] || 0, new: byNew[d] || 0 }); }
  } catch (e) {}
  return out;
}
