// Cloudflare Pages Function backing /api/kv.
// Reads and writes the Rate Board's shared market data to a Cloudflare KV
// namespace bound to this project as RATEBOARD_KV (Settings > Functions >
// KV namespace bindings in the Cloudflare Pages dashboard).
//
// Only a fixed set of keys is allowed, since this endpoint is public and
// unauthenticated — it should never become an arbitrary KV read/write proxy.
//
// The whole board lives in one JSON blob, so "read it, change it, write it
// back" is the only way to edit anything. Done from the browser that round
// trip takes seconds, and anything posted by someone else inside that window
// gets written back over. That's why the frequent edits — posting, editing
// and removing a listing, and signing up — are done HERE instead, where the
// gap between the read and the write is a few milliseconds inside one
// datacenter. See the `op` handling below.
const ALLOWED_KEYS = new Set(['ratebrd_market_v1']);
const KEY = 'ratebrd_market_v1';
const MAX_VALUE_BYTES = 8_000_000; // 8 MB — room for many thousands of listings
const MAX_OFFERS = 20_000;

/* ---- backups -------------------------------------------------------------
   Nobody sees these and nothing in the app reads them; they exist purely so
   the board can be put back if a bad write ever flattens it again.

   Two kinds. Eight rotating slots keep the last ~4 hours of healthy states,
   one per half-hour bucket so this costs a couple of writes an hour rather
   than one per listing. And one "safe" copy that is only ever replaced by a
   board at least 80% the size of the one already in it — a wipe can't
   overwrite it, which is the whole point.
--------------------------------------------------------------------------- */
const SNAP_SLOTS = 8;
const SNAP_BUCKET_MS = 30 * 60 * 1000;
const SNAP_PREFIX = 'ratebrd_snap_';
const SAFE_KEY = 'ratebrd_snap_safe';

function snapWrap(value, m, bucket) {
  return JSON.stringify({
    bucket, ts: Date.now(),
    users: Object.keys(m.users || {}).length,
    offers: (m.offers || []).length,
    minimums: (m.minimums || []).length,
    keeplist: (m.keeplist || []).length,
    value
  });
}

async function saveSnapshot(env, value, m) {
  try {
    const bucket = Math.floor(Date.now() / SNAP_BUCKET_MS);
    const slotKey = SNAP_PREFIX + (bucket % SNAP_SLOTS);

    // One write per bucket — if this slot already holds this bucket, skip.
    const existing = await env.RATEBOARD_KV.get(slotKey);
    let sameBucket = false;
    if (existing) {
      try { sameBucket = JSON.parse(existing).bucket === bucket; } catch (e) {}
    }
    if (sameBucket) return;

    await env.RATEBOARD_KV.put(slotKey, snapWrap(value, m, bucket));

    // The safe copy only moves forward to boards that haven't lost people.
    const users = Object.keys(m.users || {}).length;
    const safeRaw = await env.RATEBOARD_KV.get(SAFE_KEY);
    let allowed = users > 0;
    if (allowed && safeRaw) {
      try { allowed = users >= Math.floor(JSON.parse(safeRaw).users * 0.8); } catch (e) {}
    }
    if (allowed) await env.RATEBOARD_KV.put(SAFE_KEY, snapWrap(value, m, bucket));
  } catch (e) {
    // A backup that fails must never take a real write down with it.
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

// Same name-flattening the page uses, so "replace my own listing" matches the
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

function blank() {
  return { users: {}, offers: [], reports: [], minimums: [], keeplist: [] };
}

async function readMarket(env) {
  // No cacheTtl override here: KV rejects anything under 60 seconds, and the
  // default already gives this datacenter's freshest copy.
  const raw = await env.RATEBOARD_KV.get(KEY);
  let m = null;
  if (raw) { try { m = JSON.parse(raw); } catch (e) { m = null; } }
  if (!m || typeof m !== 'object') m = blank();
  m.users ||= {}; m.offers ||= []; m.reports ||= [];
  m.minimums ||= []; m.keeplist ||= [];
  return m;
}

const str = (v, max) => typeof v === 'string' && v.length <= max ? v : null;

// Each op edits the board in place and returns an error string, or null on success.
function applyOp(m, body) {
  const op = body.op;

  if (op === 'signup') {
    const key = str(body.key, 60), name = str(body.name, 60), hash = str(body.hash, 200);
    if (!key || !hash) return 'bad signup';
    if (m.users[key]) return null;              // already there — never overwrite
    m.users[key] = { name: name || key, hash, created: Date.now(), banned: false };
    return null;
  }

  if (op === 'addOffer') {
    const o = body.offer || {};
    const user = str(o.user, 60), player = str(o.player, 80), sport = str(o.sport, 8);
    const rate = Number(o.rate), link = str(o.link, 300) || '';
    if (!user || !player || !sport || !(rate > 0)) return 'bad offer';
    if (m.offers.length >= MAX_OFFERS) return 'board is full';
    const i = m.offers.findIndex(x =>
      x.user === user && x.sport === sport && norm(x.player) === norm(player));
    if (i > -1) {
      m.offers[i].rate = rate; m.offers[i].player = player;
      m.offers[i].link = link; m.offers[i].ts = Date.now();
    } else {
      m.offers.push({ id: str(o.id, 40) || (Date.now().toString(36) + Math.random().toString(36).slice(2, 7)),
        user, sport, player, rate, link, ts: Date.now() });
    }
    return null;
  }

  if (op === 'updateOffer') {
    const id = str(body.id, 40);
    const t = id && m.offers.find(x => x.id === id);
    if (!t) return 'listing not found';
    if (body.user && t.user !== body.user) return 'not your listing';
    const rate = Number(body.rate);
    if (rate > 0) t.rate = rate;
    const link = str(body.link, 300);
    if (link != null) t.link = link;
    t.ts = Date.now();
    return null;
  }

  if (op === 'removeOffer') {
    const id = str(body.id, 40);
    if (!id) return 'bad id';
    const t = m.offers.find(x => x.id === id);
    if (!t) return null;                         // already gone — not an error
    if (body.user && t.user !== body.user) return 'not your listing';
    m.offers = m.offers.filter(x => x.id !== id);
    return null;
  }

  return 'unknown op';
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);

  // Backups. `?snap=list` shows what's stored and how big each one was;
  // `?snap=3` or `?snap=safe` hands back that copy of the board.
  const snap = url.searchParams.get('snap');
  if (snap != null) {
    if (snap === 'list') {
      const out = [];
      for (const s of [...Array(SNAP_SLOTS).keys(), 'safe']) {
        const raw = await env.RATEBOARD_KV.get(SNAP_PREFIX + s);
        if (!raw) { out.push({ slot: String(s), empty: true }); continue; }
        try {
          const d = JSON.parse(raw);
          out.push({ slot: String(s), takenAt: new Date(d.ts).toISOString(),
            users: d.users, offers: d.offers, minimums: d.minimums, keeplist: d.keeplist });
        } catch (e) { out.push({ slot: String(s), unreadable: true }); }
      }
      return json({ snapshots: out });
    }
    if (!/^(safe|[0-7])$/.test(snap)) return json({ error: 'bad snapshot' }, 400);
    const raw = await env.RATEBOARD_KV.get(SNAP_PREFIX + snap);
    if (!raw) return json({ error: 'no such snapshot' }, 404);
    return new Response(raw, { headers: { 'content-type': 'application/json' } });
  }

  const key = url.searchParams.get('key');
  if (!key || !ALLOWED_KEYS.has(key)) {
    return json({ error: 'unknown key' }, 400);
  }
  const value = await env.RATEBOARD_KV.get(key);
  return json({ value });
}

export async function onRequestPost({ request, env, waitUntil }) {
  const later = waitUntil ? (p) => waitUntil(p) : async (p) => { await p; };
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: 'bad json' }, 400);
  }

  // Server-side edit: read, change, write, all in one place.
  if (body && body.op) {
    let m;
    try {
      m = await readMarket(env);
    } catch (e) {
      return json({ error: 'could not read the board' }, 503);
    }
    // A board that reads back empty when it shouldn't be means something is
    // wrong upstream. Writing then would erase everyone, so refuse instead.
    if (!Object.keys(m.users).length && body.op !== 'signup') {
      return json({ error: 'board unavailable, nothing was changed' }, 503);
    }
    const err = applyOp(m, body);
    if (err) return json({ error: err }, 400);

    const encoded = JSON.stringify(m);
    if (encoded.length > MAX_VALUE_BYTES) return json({ error: 'board is full' }, 413);
    await env.RATEBOARD_KV.put(KEY, encoded);
    later(saveSnapshot(env, encoded, m));
    return json({ ok: true, offers: m.offers.length });
  }

  // Legacy whole-blob write, still used for the admin-only edits.
  const { key, value } = body || {};
  if (!key || !ALLOWED_KEYS.has(key)) {
    return json({ error: 'unknown key' }, 400);
  }
  if (typeof value !== 'string' || value.length > MAX_VALUE_BYTES) {
    return json({ error: 'bad value' }, 400);
  }
  await env.RATEBOARD_KV.put(key, value);
  try {
    const m = JSON.parse(value);
    if (m && typeof m === 'object') later(saveSnapshot(env, value, m));
  } catch (e) {}
  return json({ ok: true });
}
