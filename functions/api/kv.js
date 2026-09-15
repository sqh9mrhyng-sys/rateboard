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
  const key = url.searchParams.get('key');
  if (!key || !ALLOWED_KEYS.has(key)) {
    return json({ error: 'unknown key' }, 400);
  }
  const value = await env.RATEBOARD_KV.get(key);
  return json({ value });
}

export async function onRequestPost({ request, env }) {
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
  return json({ ok: true });
}
