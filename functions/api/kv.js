// Cloudflare Pages Function backing /api/kv.
//
// Where the board lives, and why it's split in two:
//
//   Listings and accounts are ROWS in a D1 (SQL) database, bound as
//   RATEBOARD_DB. They change constantly and from many people at once, and
//   SQL is the only thing here that can take two writes landing in the same
//   millisecond without one quietly erasing the other. Posting a listing is
//   a single INSERT ... ON CONFLICT, which either inserts or replaces that
//   one row and touches nothing else. Nobody else's listing is even read,
//   let alone rewritten.
//
//   Minimums, the keep lists and reports stay in KV, bound as RATEBOARD_KV.
//   Only the admin edits those, so there's no contention to worry about.
//
// It used to all be one JSON blob in KV that every browser read, edited and
// wrote back whole. Two people posting within the same moment meant the
// second write erased the first — at volume most listings were being lost.
/* ---- the board read is the expensive thing here ------------------------
   Assembling the board scans both tables whole — every account and every
   listing, about a thousand rows a time. D1 bills reads by the ROW, so a few
   thousand page loads a day is all it takes to hit the daily ceiling, and
   once that's gone every query fails and the board reads as empty.
   So the assembled board is cached at the edge for a few seconds. Hundreds of
   people loading the board in the same moment now cost one query instead of
   hundreds, and any write clears the cache so nobody sees their own listing
   missing right after posting it. ------------------------------------- */
import { ADMINS, newSession, endSession, isAdminRequest, sameHash, allow, clientIp,
         forbidden } from '../../lib/auth.js';

/* ---- the Friday pack data window -------------------------------------
   Every account that existed when this was set up (created on or before
   GRANT_BEFORE) can open the Pack data tab, and only that tab, until
   GRANT_UNTIL - 2pm Eastern on Friday 30 October 2026. Nothing has to run to
   end it: past GRANT_UNTIL the board simply stops sending the window, and the
   page checks the clock as well. Accounts made later never qualify. */
const PACK_GRANT = {
  before: Date.parse('2026-10-30T05:55:00Z'),   // 9:55pm Alaska, Thu 29 Oct
  until:  Date.parse('2026-10-30T18:00:00Z')    // 2:00pm Eastern, Fri 30 Oct
};

const BOARD_CACHE_TTL = 10;      // the copy everyone is normally served
const BOARD_STALE_TTL = 21600;   // 6h fallback, used ONLY when the database says no
// Raised from v2 when password fingerprints stopped being part of the board,
// so no cached copy that still carries them is ever served again.
const BOARD_VER = 'v3';

function boardCacheReq(origin) {
  return new Request(`${origin}/__cache/board/${BOARD_VER}`, { method: 'GET' });
}
function boardStaleReq(origin) {
  return new Request(`${origin}/__cache/board-last-good/${BOARD_VER}`, { method: 'GET' });
}

async function cacheRead(req) {
  try {
    const hit = await caches.default.match(req);
    return hit ? await hit.text() : null;
  } catch (e) { return null; }
}
async function cacheWrite(req, body, ttl) {
  try {
    await caches.default.put(req, new Response(body, {
      headers: { 'content-type': 'application/json', 'cache-control': `max-age=${ttl}` }
    }));
  } catch (e) { /* caching is an optimisation, never a requirement */ }
}

// Fresh copy if there is one, otherwise the database. If the database refuses
// — a quota, an outage — fall back to the last good copy rather than handing
// back an error, because an error here reads to everyone as "board is empty".
async function cachedBoardBody(env, origin) {
  const fresh = await cacheRead(boardCacheReq(origin));
  if (fresh) return fresh;

  let body;
  try {
    body = JSON.stringify(await readBoard(env));
  } catch (e) {
    const stale = await cacheRead(boardStaleReq(origin));
    if (stale) return stale;
    throw e;
  }

  await cacheWrite(boardCacheReq(origin), body, BOARD_CACHE_TTL);
  await cacheWrite(boardStaleReq(origin), body, BOARD_STALE_TTL);
  return body;
}

// Only the short-lived copy is dropped on a write. The last-good fallback is
// left alone on purpose — it is the thing that keeps the board readable.
async function bustBoard(origin) {
  try { await caches.default.delete(boardCacheReq(origin)); } catch (e) {}
}

const KV_KEY = 'ratebrd_market_v1';
const ALLOWED_KEYS = new Set([KV_KEY]);
const MAX_VALUE_BYTES = 8_000_000;
const MAX_OFFERS = 20_000;

/* ---- backups ----------------------------------------------------------
   These live in D1 alongside the listings, NOT in KV. They used to be KV
   writes, which put them on the same daily write budget as everything else
   using KV; when that budget ran out the backups stopped for three hours and
   said nothing, because they run in the background where a throw is silent.
   D1 has no such ceiling, and saveSnapshot now RETURNS its failure so the
   admin screen can show when the last good backup was taken. ------------- */
const DATA_REPORTS_DDL = `CREATE TABLE IF NOT EXISTS data_reports (
  id TEXT PRIMARY KEY, ts INTEGER NOT NULL, by_user TEXT NOT NULL, sport TEXT,
  player TEXT NOT NULL, field TEXT NOT NULL, value TEXT, note TEXT,
  status TEXT NOT NULL DEFAULT 'open')`;

// Two things the board never recorded: how many different people opened it on a
// given day, and how many messages were copied. New users, listings, reports
// and feature requests all carry their own timestamps already, so they need no
// counter - these two have nowhere else to come from. One row per person per
// day for opens (so a refresh does not count twice), one running total a day
// for copies. Nothing here identifies what was copied.
const COUNTS_DDL = `CREATE TABLE IF NOT EXISTS daily_counts (
  day TEXT NOT NULL, metric TEXT NOT NULL, who TEXT NOT NULL DEFAULT '',
  n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, metric, who))`;

// The day a count belongs to, in Eastern time, so a digest covering "yesterday"
// means the same thing to the board as it does to the person reading it.
function etDay(ts) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date(ts == null ? Date.now() : ts));
}

// Feature requests from members. Same shape of problem as a data report - a
// burst of them must not overwrite one another - so they get their own table
// rather than a slot in the board blob. Status is open, done or declined.
const FEATURES_DDL = `CREATE TABLE IF NOT EXISTS features (
  id TEXT PRIMARY KEY, ts INTEGER NOT NULL, by_user TEXT NOT NULL, kind TEXT,
  title TEXT NOT NULL, detail TEXT, status TEXT NOT NULL DEFAULT 'open')`;
// One person cannot fill the queue on their own.
const MAX_OPEN_PER_USER = 12;

const SNAP_BUCKET_MS = 30 * 60 * 1000;
const SNAP_KEEP = 24;                    // rolling slots — 12 hours' worth
const SNAP_DDL = `CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY, ts INTEGER NOT NULL, users INTEGER NOT NULL,
  offers INTEGER NOT NULL, minimums INTEGER NOT NULL, keeplist INTEGER NOT NULL,
  body TEXT NOT NULL)`;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'content-type': 'application/json' }
  });
}

// Same name-flattening the page uses, so "replace my own listing" behaves the
// way it does in the browser.
const ODD = { 'Æ':'AE','æ':'ae','Œ':'OE','œ':'oe','ß':'ss','Ø':'O','ø':'o','Ł':'L','ł':'l',
  'Đ':'D','đ':'d','Ð':'D','ð':'d','Þ':'Th','þ':'th','İ':'I','ı':'i' };
function norm(s) {
  return String(s == null ? '' : s)
    .replace(/[ÆæŒœßØøŁłĐđÐðÞþİı]/g, c => ODD[c] || c)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const str = (v, max) => typeof v === 'string' && v.length <= max ? v : null;
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/* ---- the KV half: admin lists ---- */
async function readSide(env) {
  const raw = await env.RATEBOARD_KV.get(KV_KEY);
  let m = null;
  if (raw) { try { m = JSON.parse(raw); } catch (e) { m = null; } }
  if (!m || typeof m !== 'object') m = {};
  return { reports: m.reports || [], minimums: m.minimums || [], keeplist: m.keeplist || [],
           house: m.house || [], gamedata: m.gamedata || [],
           packdata: m.packdata || [] };
}

/* ---- assemble the board in the shape the page already expects ---- */
async function readBoard(env, includeHashes) {
  const side = await readSide(env);
  const [offersRes, usersRes] = await Promise.all([
    env.RATEBOARD_DB.prepare(
      'SELECT id, user, sport, player, rate, link, ts FROM offers').all(),
    env.RATEBOARD_DB.prepare(
      'SELECT key, name, hash, created, banned FROM users').all()
  ]);
  const users = {};
  for (const u of (usersRes.results || [])) {
    users[u.key] = includeHashes
      ? { name: u.name, hash: u.hash, created: u.created, banned: !!u.banned }
      // What everyone downloads. A password fingerprint is never in it: only
      // whether one is set, which is what the page needs to spot a reset.
      : { name: u.name, hasPass: !!u.hash, created: u.created, banned: !!u.banned };
  }
  const now = Date.now();
  return {
    users,
    offers: (offersRes.results || []).map(o => ({
      id: o.id, user: o.user, sport: o.sport, player: o.player,
      rate: o.rate, link: o.link || '', ts: o.ts
    })),
    reports: side.reports, minimums: side.minimums, keeplist: side.keeplist, house: side.house,
    gamedata: side.gamedata, packdata: side.packdata,
    packgrant: now < PACK_GRANT.until ? { before: PACK_GRANT.before, until: PACK_GRANT.until } : null
  };
}

/* ---- the edits, each one a single atomic statement ---- */
async function applyOp(env, body) {
  const op = body.op;
  const db = env.RATEBOARD_DB;

  if (op === 'signup') {
    const key = str(body.key, 60), name = str(body.name, 60), hash = str(body.hash, 200);
    if (!key || !hash) return 'bad signup';
    // Never overwrite an existing account, even if two signups race.
    await db.prepare(
      `INSERT INTO users (key, name, hash, created, banned) VALUES (?, ?, ?, ?, 0)
       ON CONFLICT(key) DO NOTHING`
    ).bind(key, name || key, hash, Date.now()).run();
    return null;
  }

  if (op === 'addOffer') {
    const o = body.offer || {};
    const user = str(o.user, 60), player = str(o.player, 80), sport = str(o.sport, 8);
    const rate = Number(o.rate), link = str(o.link, 300) || '';
    if (!user || !player || !sport || !(rate > 0)) return 'bad offer';

    const count = await db.prepare('SELECT COUNT(*) AS n FROM offers').first();
    if (count && count.n >= MAX_OFFERS) return 'board is full';

    // One statement: adds this listing, or updates this person's existing one
    // for the same player. No other row is read or touched, so it can't
    // collide with anyone else posting at the same moment.
    await db.prepare(
      `INSERT INTO offers (id, user, sport, player, player_key, rate, link, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user, sport, player_key)
       DO UPDATE SET rate = excluded.rate, player = excluded.player,
                     link = excluded.link, ts = excluded.ts`
    ).bind(str(o.id, 40) || uid(), user, sport, player, norm(player), rate, link, Date.now()).run();
    return null;
  }

  if (op === 'updateOffer') {
    const id = str(body.id, 40);
    if (!id) return 'bad id';
    const owner = str(body.user, 60);
    const rate = Number(body.rate);
    const link = str(body.link, 300);
    const res = owner
      ? await db.prepare('UPDATE offers SET rate=?, link=?, ts=? WHERE id=? AND user=?')
          .bind(rate > 0 ? rate : 0, link || '', Date.now(), id, owner).run()
      : await db.prepare('UPDATE offers SET rate=?, link=?, ts=? WHERE id=?')
          .bind(rate > 0 ? rate : 0, link || '', Date.now(), id).run();
    if (!res.meta || !res.meta.changes) return 'listing not found';
    return null;
  }

  if (op === 'removeOffer') {
    const id = str(body.id, 40);
    if (!id) return 'bad id';
    const owner = str(body.user, 60);
    if (owner) await db.prepare('DELETE FROM offers WHERE id=? AND user=?').bind(id, owner).run();
    else await db.prepare('DELETE FROM offers WHERE id=?').bind(id).run();
    return null;
  }

  // Admin: delete or restore an account. Deleting also clears their listings.
  if (op === 'setBanned') {
    const key = str(body.key, 60);
    if (!key) return 'bad user';
    const banned = body.banned ? 1 : 0;
    await db.prepare('UPDATE users SET banned=? WHERE key=?').bind(banned, key).run();
    if (banned) await db.prepare('DELETE FROM offers WHERE user=?').bind(key).run();
    return null;
  }

  // Admin: clear someone's password so the next password they type becomes
  // their new one. Listings are deliberately left alone.
  if (op === 'resetPass') {
    const key = str(body.key, 60);
    if (!key) return 'bad user';
    const res = await db.prepare("UPDATE users SET hash='' WHERE key=?").bind(key).run();
    if (!res.meta || !res.meta.changes) return 'no such account';
    return null;
  }

  // Claim a reset account. The WHERE clause is the whole security of this:
  // it can only ever set a password on an account an admin already cleared,
  // so it can't be used to take over a normal account.
  if (op === 'setPass') {
    const key = str(body.key, 60), hash = str(body.hash, 200);
    if (!key || !hash) return 'bad reset';
    const res = await db.prepare(
      "UPDATE users SET hash=? WHERE key=? AND (hash='' OR hash IS NULL)"
    ).bind(hash, key).run();
    if (!res.meta || !res.meta.changes) return 'that account is not awaiting a reset';
    return null;
  }

  // Someone flags a wrong figure (age, minimum, earnings, status...). Kept in
  // the database so a burst of reports can't overwrite one another.
  if (op === 'dataReport') {
    const by = str(body.by, 60), player = str(body.player, 80), field = str(body.field, 20);
    if (!by || !player || !field) return 'bad report';
    await db.prepare(DATA_REPORTS_DDL).run();
    await db.prepare(
      `INSERT INTO data_reports (id, ts, by_user, sport, player, field, value, note, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open')`
    ).bind(uid(), Date.now(), by, str(body.sport, 8) || '', player, field,
           str(body.value, 60) || '', str(body.note, 300) || '').run();
    return null;
  }

  if (op === 'resolveDataReport') {
    const id = str(body.id, 40), status = body.status === 'fixed' ? 'fixed' : 'dismissed';
    if (!id) return 'bad id';
    await db.prepare(DATA_REPORTS_DDL).run();
    await db.prepare('UPDATE data_reports SET status=? WHERE id=?').bind(status, id).run();
    return null;
  }

  // A member asks for something. Title is required, detail optional; the board
  // owner reads these on the admin screen and closes them out.
  if (op === 'featureRequest') {
    const by = str(body.by, 60), title = str(body.title, 120);
    if (!by || !title) return 'bad request';
    await db.prepare(FEATURES_DDL).run();
    const mine = await db.prepare(
      `SELECT COUNT(*) AS n FROM features WHERE by_user=? AND status='open'`).bind(by).first();
    if (mine && Number(mine.n) >= MAX_OPEN_PER_USER) return 'you already have a lot of open requests';
    await db.prepare(
      `INSERT INTO features (id, ts, by_user, kind, title, detail, status)
       VALUES (?, ?, ?, ?, ?, ?, 'open')`
    ).bind(uid(), Date.now(), by, str(body.kind, 20) || '', title,
           str(body.detail, 1000) || '').run();
    return null;
  }

  // One ping per person per day for 'open', one tick per copied message.
  if (op === 'track') {
    const kind = str(body.kind, 10);
    if (kind !== 'open' && kind !== 'copy') return 'bad kind';
    const day = etDay();
    await db.prepare(COUNTS_DDL).run();
    if (kind === 'open') {
      const who = str(body.by, 60);
      if (!who) return null;                       // signed out: nothing to count
      await db.prepare(
        `INSERT INTO daily_counts (day, metric, who, n) VALUES (?, 'open', ?, 1)
         ON CONFLICT(day, metric, who) DO NOTHING`).bind(day, who.toLowerCase()).run();
    } else {
      await db.prepare(
        `INSERT INTO daily_counts (day, metric, who, n) VALUES (?, 'copy', '', 1)
         ON CONFLICT(day, metric, who) DO UPDATE SET n = n + 1`).bind(day).run();
    }
    return null;
  }

  if (op === 'resolveFeature') {
    const id = str(body.id, 40), status = body.status === 'done' ? 'done' : 'declined';
    if (!id) return 'bad id';
    await db.prepare(FEATURES_DDL).run();
    await db.prepare('UPDATE features SET status=? WHERE id=?').bind(status, id).run();
    return null;
  }

  // One-time move of the old blob into the database.
  if (op === 'import') {
    const users = body.users || {}, offers = body.offers || [];
    const stmts = [];
    for (const [key, u] of Object.entries(users)) {
      if (!key || !u || !u.hash) continue;
      stmts.push(db.prepare(
        `INSERT INTO users (key, name, hash, created, banned) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO NOTHING`
      ).bind(key, u.name || key, u.hash, u.created || Date.now(), u.banned ? 1 : 0));
    }
    for (const o of offers) {
      if (!o || !o.user || !o.player || !o.sport) continue;
      stmts.push(db.prepare(
        `INSERT INTO offers (id, user, sport, player, player_key, rate, link, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user, sport, player_key) DO NOTHING`
      ).bind(o.id || uid(), o.user, o.sport, o.player, norm(o.player),
             Number(o.rate) || 0, o.link || '', o.ts || Date.now()));
    }
    if (stmts.length) await db.batch(stmts);
    return null;
  }

  return 'unknown op';
}

/* ---- backups of the assembled board ---- */
async function writeSnap(db, id, board) {
  await db.prepare(
    `INSERT INTO snapshots (id, ts, users, offers, minimums, keeplist, body)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET ts=excluded.ts, users=excluded.users,
       offers=excluded.offers, minimums=excluded.minimums,
       keeplist=excluded.keeplist, body=excluded.body`
  ).bind(id, Date.now(), Object.keys(board.users).length, board.offers.length,
         board.minimums.length, board.keeplist.length, JSON.stringify(board)).run();
}

// Returns {ok:true} or {ok:false, why}. A backup failing still must never
// break a real write — but it must not vanish either, so callers can see it.
async function saveSnapshot(env, force) {
  const db = env.RATEBOARD_DB;
  if (!db) return { ok: false, why: 'no database binding' };
  try {
    await db.prepare(SNAP_DDL).run();

    const bucket = Math.floor(Date.now() / SNAP_BUCKET_MS);
    const id = String(bucket);
    if (!force) {
      const seen = await db.prepare('SELECT id FROM snapshots WHERE id = ?').bind(id).first();
      if (seen) return { ok: true, skipped: 'already taken this half hour' };
    }

    const board = await readBoard(env, true);
    const users = Object.keys(board.users).length;
    // Never let an empty or broken read overwrite a real backup.
    if (!users) return { ok: false, why: 'board read came back empty' };

    await writeSnap(db, id, board);

    // The protected copy is only replaced while the board still looks whole,
    // so a bad day can't quietly erase the last good state.
    const prev = await db.prepare('SELECT users FROM snapshots WHERE id = ?').bind('safe').first();
    if (!prev || users >= Math.floor(prev.users * 0.8)) await writeSnap(db, 'safe', board);

    await db.prepare(
      `DELETE FROM snapshots WHERE id <> 'safe' AND id NOT IN (
         SELECT id FROM snapshots WHERE id <> 'safe' ORDER BY ts DESC LIMIT ?)`
    ).bind(SNAP_KEEP).run();

    return { ok: true, id, users, offers: board.offers.length };
  } catch (e) {
    return { ok: false, why: String((e && e.message) || e) };
  }
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);

  // Everything except reading the board itself is for the admin screen:
  // reports, counters, feature requests and the backups (which still hold
  // password fingerprints, so they must never be public).
  const adminRead = ['datareports', 'counts', 'features', 'snap']
    .some(k => url.searchParams.get(k) != null) || url.searchParams.get('raw') === '1';
  if (adminRead && !(await isAdminRequest(env, request))) return forbidden();

  // Open data-correction reports, newest first, for the admin screen.
  if (url.searchParams.get('datareports') != null) {
    try {
      const db = env.RATEBOARD_DB;
      await db.prepare(DATA_REPORTS_DDL).run();
      const rows = await db.prepare(
        `SELECT id, ts, by_user, sport, player, field, value, note FROM data_reports
         WHERE status='open' ORDER BY ts DESC LIMIT 300`).all();
      return json({ reports: rows.results || [] });
    } catch (e) {
      return json({ error: 'could not read data reports', detail: String((e && e.message) || e) }, 503);
    }
  }

  // The two counters for one Eastern day, for the admin digest.
  if (url.searchParams.get('counts') != null) {
    const day = (url.searchParams.get('counts') || '').slice(0, 10) || etDay();
    try {
      const db = env.RATEBOARD_DB;
      await db.prepare(COUNTS_DDL).run();
      const opens = await db.prepare(
        `SELECT COUNT(*) AS n FROM daily_counts WHERE day=? AND metric='open'`).bind(day).first();
      const copies = await db.prepare(
        `SELECT COALESCE(SUM(n), 0) AS n FROM daily_counts WHERE day=? AND metric='copy'`).bind(day).first();
      return json({ day, opens: Number((opens && opens.n) || 0), copies: Number((copies && copies.n) || 0) });
    } catch (e) {
      return json({ error: 'could not read counts', detail: String((e && e.message) || e) }, 503);
    }
  }

  // Open feature requests, newest first, for the admin screen.
  if (url.searchParams.get('features') != null) {
    try {
      const db = env.RATEBOARD_DB;
      await db.prepare(FEATURES_DDL).run();
      const rows = await db.prepare(
        `SELECT id, ts, by_user, kind, title, detail FROM features
         WHERE status='open' ORDER BY ts DESC LIMIT 300`).all();
      return json({ requests: rows.results || [] });
    } catch (e) {
      return json({ error: 'could not read feature requests', detail: String((e && e.message) || e) }, 503);
    }
  }

  const snap = url.searchParams.get('snap');
  if (snap != null) {
    const db = env.RATEBOARD_DB;
    if (!db) return json({ error: 'no database binding' }, 503);

    // Take one on demand, so a backup is never more than a click away.
    if (snap === 'save') return json(await saveSnapshot(env, true));

    // Everything below talks to the database, and the database can refuse —
    // a quota, a hiccup. Report that as JSON instead of throwing, which
    // Cloudflare turns into an opaque 1101 error page.
    try {
      try { await db.prepare(SNAP_DDL).run(); } catch (e) {}

      if (snap === 'list') {
        const rows = await db.prepare(
          `SELECT id, ts, users, offers, minimums, keeplist FROM snapshots ORDER BY ts DESC`
        ).all();
        const snapshots = (rows.results || []).map(r => ({
          slot: r.id, takenAt: new Date(r.ts).toISOString(),
          ageMinutes: Math.round((Date.now() - r.ts) / 60000),
          users: r.users, offers: r.offers, minimums: r.minimums, keeplist: r.keeplist
        }));
        return json({ snapshots, newest: snapshots[0] || null });
      }

      if (!/^(safe|\d{1,12})$/.test(snap)) return json({ error: 'bad snapshot' }, 400);
      const row = await db.prepare('SELECT * FROM snapshots WHERE id = ?').bind(snap).first();
      if (!row) return json({ error: 'no such snapshot' }, 404);
      return json({ bucket: row.id, ts: row.ts, users: row.users, offers: row.offers,
        minimums: row.minimums, keeplist: row.keeplist, value: row.body });
    } catch (e) {
      return json({ error: 'could not read backups', detail: String((e && e.message) || e) }, 503);
    }
  }

  const key = url.searchParams.get('key');
  if (!key || !ALLOWED_KEYS.has(key)) return json({ error: 'unknown key' }, 400);

  // Reads the stored KV blob as-is rather than the assembled board. Only used
  // to lift the pre-database listings and accounts across during the move.
  if (url.searchParams.get('raw') === '1') {
    return json({ value: await env.RATEBOARD_KV.get(KV_KEY) });
  }

  try {
    return json({ value: await cachedBoardBody(env, new URL(request.url).origin) });
  } catch (e) {
    // Say WHY. A generic failure here is what made a quota look like an outage.
    return json({ error: 'could not read the board', detail: String((e && e.message) || e) }, 503);
  }
}

export async function onRequestPost({ request, env, waitUntil }) {
  const later = waitUntil ? (p) => waitUntil(p) : async (p) => { await p; };
  const origin = new URL(request.url).origin;
  let body;
  try { body = await request.json(); }
  catch (e) { return json({ error: 'bad json' }, 400); }

  const ip = clientIp(request);

  // Password sign-in, checked here rather than in the page. Creates the
  // account if the name is new, sets the password if an admin reset it, and
  // either way hands back a session token.
  if (body && body.op === 'auth') {
    if (!(await allow(origin, 'auth-ip:' + ip, 60, 300))) {
      return json({ error: 'Too many sign-in attempts. Wait a few minutes and try again.' }, 429);
    }
    const key = str(body.key, 60), name = str(body.name, 60), hash = str(body.hash, 200);
    if (!key || key.length < 2 || !hash) return json({ error: 'bad sign-in' }, 400);
    if (!(await allow(origin, 'auth-key:' + key, 10, 300))) {
      return json({ error: 'Too many attempts for that username. Wait a few minutes.' }, 429);
    }
    try {
      const db = env.RATEBOARD_DB;
      const u = await db.prepare('SELECT key, name, hash, banned FROM users WHERE key=?').bind(key).first();
      let created = false, reset = false;
      if (!u) {
        if (!(await allow(origin, 'signup-ip:' + ip, 20, 3600))) {
          return json({ error: 'Too many new accounts from here. Try again later.' }, 429);
        }
        await db.prepare(
          `INSERT INTO users (key, name, hash, created, banned) VALUES (?, ?, ?, ?, 0)
           ON CONFLICT(key) DO NOTHING`).bind(key, name || key, hash, Date.now()).run();
        const now = await db.prepare('SELECT hash FROM users WHERE key=?').bind(key).first();
        if (!now || !sameHash(now.hash, hash)) return json({ error: 'Wrong password for that username.' }, 401);
        created = true;
      } else if (u.banned) {
        return json({ error: 'This account has been removed from the board.' }, 403);
      } else if (!u.hash) {
        const res = await db.prepare(
          "UPDATE users SET hash=? WHERE key=? AND (hash='' OR hash IS NULL)").bind(hash, key).run();
        if (!res.meta || !res.meta.changes) return json({ error: 'Could not set that password. Try again.' }, 409);
        reset = true;
      } else if (!sameHash(u.hash, hash)) {
        return json({ error: 'Wrong password for that username.' }, 401);
      }
      const token = await newSession(env, key);
      if (created) await bustBoard(origin);
      return json({ ok: true, token, key, name: (u && u.name) || name || key,
                    admin: ADMINS.includes(key), created, reset });
    } catch (e) {
      return json({ error: 'could not sign in: ' + (e && e.message || e) }, 503);
    }
  }

  if (body && body.op === 'signout') {
    await endSession(env, request);
    return json({ ok: true });
  }

  if (body && body.op) {
    // Admin powers, checked against a real admin session. An offer edit or
    // removal without an owner is the admin's "any listing" version.
    const ADMIN_OPS = new Set(['setBanned', 'resetPass', 'resolveDataReport',
                               'resolveFeature', 'import']);
    const anyOwner = (body.op === 'updateOffer' || body.op === 'removeOffer') && !str(body.user, 60);
    if ((ADMIN_OPS.has(body.op) || anyOwner) && !(await isAdminRequest(env, request))) {
      return forbidden();
    }
    // A firehose of member writes from one place is somebody's script.
    if (!(await allow(origin, 'op-ip:' + ip, 120, 60))) {
      return json({ error: 'Slow down a little and try again.' }, 429);
    }
    if (body.op === 'signup' && !(await allow(origin, 'signup-ip:' + ip, 20, 3600))) {
      return json({ error: 'Too many new accounts from here. Try again later.' }, 429);
    }
    let err;
    try { err = await applyOp(env, body); }
    catch (e) { return json({ error: 'could not save: ' + (e && e.message || e) }, 503); }
    if (err) return json({ error: err }, 400);
    // Clear the cached board before answering, so the very next read — almost
    // always this same person checking their listing landed — sees the change.
    await bustBoard(origin);
    later(saveSnapshot(env));
    return json({ ok: true });
  }

  // Whole-board write from the admin screens. Listings and accounts live in
  // the database now, so only the admin lists are taken from this payload —
  // a stale copy of the board can no longer flatten anyone's listing.
  if (!(await isAdminRequest(env, request))) return forbidden();
  const { key, value } = body || {};
  if (!key || !ALLOWED_KEYS.has(key)) return json({ error: 'unknown key' }, 400);
  if (typeof value !== 'string' || value.length > MAX_VALUE_BYTES) {
    return json({ error: 'bad value' }, 400);
  }
  let incoming;
  try { incoming = JSON.parse(value); }
  catch (e) { return json({ error: 'bad value' }, 400); }

  await env.RATEBOARD_KV.put(KV_KEY, JSON.stringify({
    reports: incoming.reports || [],
    minimums: incoming.minimums || [],
    keeplist: incoming.keeplist || [],
    house: incoming.house || [],
    gamedata: incoming.gamedata || [],
    packdata: incoming.packdata || []
  }));
  await bustBoard(origin);
  later(saveSnapshot(env));
  return json({ ok: true });
}
