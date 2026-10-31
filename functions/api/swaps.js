/* ---- Swaps ---------------------------------------------------------------
   Pack swaps between board members. Each member says which player (any
   season) they want, which of their own player passes they will not give up,
   and up to five daily hours they are happy to be messaged. Their passes are
   read from Real with the swap account's token. Two people match when each
   has a pass the other wants and they share at least one hour; at that hour
   both are messaged on Real by the swap account. A matched pass is taken off
   the table so it can't be promised twice.

   Admin only while it is being built. Real calls use their own token
   (RS_SWAP_TOKEN, or any other RS_*TOKEN that isn't the board's or the
   market's), never the board's main key.
   ------------------------------------------------------------------------- */
import { isAdminRequest, sessionKey, forbidden, allow, clientIp } from '../../lib/auth.js';

function hashidsEncode(number) {
  const saltChars = Array.from('realwebapp');
  const minLen = 16;
  const keepUnique = c => [...new Set(c)];
  const without = (c, x) => c.filter(ch => !x.includes(ch));
  const only = (c, k) => c.filter(ch => k.includes(ch));
  function shuffle(alpha, salt) {
    if (!salt.length) return alpha;
    let int, t = [...alpha];
    for (let i = t.length - 1, v = 0, p = 0; i > 0; i--, v++) {
      v %= salt.length; p += int = salt[v].codePointAt(0);
      const j = (int + v + p) % i; [t[i], t[j]] = [t[j], t[i]];
    }
    return t;
  }
  function toAlpha(n, alpha) {
    const id = []; let v = n;
    do { id.unshift(alpha[v % alpha.length]); v = Math.floor(v / alpha.length); } while (v > 0);
    return id;
  }
  let alpha = Array.from('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890');
  let seps  = Array.from('cfhistuCFHISTU');
  const uniq = keepUnique(alpha);
  alpha = without(uniq, seps);
  seps  = shuffle(only(seps, uniq), saltChars);
  if (!seps.length || alpha.length / seps.length > 3.5) {
    const sl = Math.ceil(alpha.length / 3.5);
    if (sl > seps.length) { seps.push(...alpha.slice(0, sl - seps.length)); alpha = alpha.slice(sl - seps.length); }
  }
  alpha = shuffle(alpha, saltChars);
  const gc = Math.ceil(alpha.length / 12);
  let guards;
  if (alpha.length < 3) { guards = seps.slice(0, gc); seps = seps.slice(gc); }
  else { guards = alpha.slice(0, gc); alpha = alpha.slice(gc); }
  const numId = number % 100;
  let ret = [alpha[numId % alpha.length]];
  const lottery = [...ret];
  alpha = shuffle(alpha, lottery.concat(saltChars, alpha));
  ret.push(...toAlpha(number, alpha));
  if (ret.length < minLen) ret.unshift(guards[(numId + ret[0].codePointAt(0)) % guards.length]);
  if (ret.length < minLen) ret.push(guards[(numId + ret[2].codePointAt(0)) % guards.length]);
  const half = Math.floor(alpha.length / 2);
  while (ret.length < minLen) {
    alpha = shuffle(alpha, alpha);
    ret.unshift(...alpha.slice(half)); ret.push(...alpha.slice(0, half));
    const ex = ret.length - minLen;
    if (ex > 0) ret = ret.slice(ex / 2, ex / 2 + minLen);
  }
  return ret.join('');
}
// ─────────────────────────────────────────────────────────────────────────────

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function rsHeaders(auth) {
  return {
    'Accept': 'application/json',
    'Origin': 'https://realsports.io',
    'Referer': 'https://realsports.io/',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Safari/605.1.15',
    'real-auth-info':     auth,
    'real-device-type':   'desktop_web',
    'real-device-uuid':   '310a20be-9ef8-4ee0-802f-5b1cffb5dd5e',
    'real-version':       '36',
    'real-request-token': hashidsEncode(Date.now()),
  };
}

function swapToken(env) {
  if (env.RS_SWAP_TOKEN) return env.RS_SWAP_TOKEN;
  const k = Object.keys(env).find(k => /token/i.test(k) && !['RS_AUTH_TOKEN', 'RS_MARKET_TOKEN'].includes(k)
    && typeof env[k] === 'string' && env[k].length > 20);
  return k ? env[k] : null;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Which seasons a member's passes are read for: every season the market
// covers, in Real's own numbering.
const SWAP_SEASONS = {
  nba: [2027, 2026, 2025, 2024, 2023], ncaam: [2027, 2026, 2025, 2024],
  nfl: [2026, 2025, 2024, 2023], ncaaf: [2026, 2025, 2024, 2023], nhl: [2026, 2025, 2024, 2023],
  mlb: [2026, 2025, 2024, 2023, 2022], wnba: [2026, 2025, 2024], soccer: [2026, 2025],
  golf: [2026, 2025, 2024, 2023, 2022], ufc: [2023]
};

const DDL = [
  `CREATE TABLE IF NOT EXISTS swap_users (key TEXT PRIMARY KEY, rsUser TEXT, hashId TEXT,
     wants TEXT, keep TEXT, slots TEXT, passes TEXT, scannedAt INTEGER, updatedAt INTEGER, active INTEGER DEFAULT 1)`,
  `CREATE TABLE IF NOT EXISTS swap_matches (id INTEGER PRIMARY KEY AUTOINCREMENT, a TEXT, b TEXT,
     aGets TEXT, bGets TEXT, slot INTEGER, createdAt INTEGER, sentAt INTEGER, status TEXT, note TEXT)`
];
async function ready(db) { for (const d of DDL) await db.prepare(d).run(); }

const rowsOf = d => {
  if (Array.isArray(d)) return d;
  for (const k of ['passes', 'items', 'entities', 'results', 'data', 'userPasses', 'players']) if (Array.isArray(d && d[k])) return d[k];
  return [];
};
// One pass, reduced to what matching needs. Real's exact shape is still being
// learned, so the player's id, name, rarity and rating are searched for
// anywhere in the pass, nested objects included.
function deepFind(o, keys, depth = 0) {
  if (!o || typeof o !== 'object' || depth > 4) return undefined;
  for (const k of keys) if (o[k] != null && o[k] !== '' && typeof o[k] !== 'object') return o[k];
  for (const v of Object.values(o)) {
    if (v && typeof v === 'object') { const r = deepFind(v, keys, depth + 1); if (r !== undefined) return r; }
  }
  return undefined;
}
function passOf(p, sport, season) {
  const e = p.entity || p.player || p.primaryPlayer || (p.card && p.card.primaryPlayer) || {};
  const id = Number(p.entityId ?? p.playerId ?? e.id ?? deepFind(p, ['entityId', 'playerId']) ?? p.id);
  const first = deepFind(p, ['firstName']), last = deepFind(p, ['lastName']);
  const name = String(p.entityLabel || p.label || e.displayName || e.fullName || e.name
    || (first && last ? `${first} ${last}` : '') || deepFind(p, ['displayName', 'fullName', 'entityLabel', 'playerName', 'name', 'label']) || '').slice(0, 80);
  const count = Number(p.count ?? p.quantity ?? p.numPasses ?? p.passCount ?? 1) || 1;
  const rarity = Number(deepFind(p, ['rarity', 'rarityLevel', 'tier'])) || null;
  const rating = Number(deepFind(p, ['value', 'rating', 'boost', 'boostValue', 'primaryValue'])) || null;
  return Number.isFinite(id) ? { key: `${sport}:${season}:${id}`, sport, season, id, name, count, rarity, rating } : null;
}

// Names Real didn't put on the pass, from the board's own game log.
async function fillNames(db, passes) {
  const need = passes.filter(p => !p.name || /^player$/i.test(p.name));
  const groups = {};
  for (const p of need) (groups[`${p.sport}|${p.season}`] = groups[`${p.sport}|${p.season}`] || []).push(p);
  for (const [g, list] of Object.entries(groups)) {
    const [sp, se] = g.split('|');
    for (let i = 0; i < list.length; i += 90) {
      const ids = list.slice(i, i + 90).map(p => p.id).filter(Number.isFinite);
      try {
        const r = await db.prepare(`SELECT playerId, MAX(player) AS player FROM gamelog WHERE sport=? AND season=? AND playerId IN (${ids.join(',')}) GROUP BY playerId`)
          .bind(sp, Number(se)).all();
        const m = new Map((r.results || []).map(x => [x.playerId, x.player]));
        for (const p of list) if (m.get(p.id)) p.name = m.get(p.id);
      } catch (e) {}
    }
  }
  return passes;
}

async function rsGetJson(url, auth) {
  for (let i = 0; ; i++) {
    const res = await fetch(url, { headers: rsHeaders(auth) });
    const text = await res.text();
    if (res.ok) { try { return JSON.parse(text); } catch (e) { return null; } }
    if ((res.status === 429 || /high volume/i.test(text)) && i < 2) { await sleep(3000 * (i + 1)); continue; }
    throw new Error(`Real ${res.status}: ${text.slice(0, 160)}`);
  }
}

async function resolveHashId(username, auth) {
  const d = await rsGetJson(`https://web.realapp.com/searchusers?query=${encodeURIComponent(username)}`, auth);
  const u = ((d && d.users) || []).find(x => String(x.userName || '').toLowerCase() === username.toLowerCase());
  return u ? u.id : null;
}

// Reads every player pass a member has, one sport-season at a time, one
// request at a time.
async function scanPasses(hashId, auth) {
  const out = [], errors = [];
  let sample = null;
  for (const [sport, seasons] of Object.entries(SWAP_SEASONS)) {
    for (const season of seasons) {
      try {
        const d = await rsGetJson(`https://web.realapp.com/userpasses/${encodeURIComponent(hashId)}/passes`
          + `?entityType=player&season=${season}&sport=${sport}`, auth);
        const rows = rowsOf(d);
        if (rows.length && !sample) sample = { sport, season, keys: Object.keys(d || {}), first: rows[0] };
        for (const r of rows) { const p = passOf(r, sport, season); if (p) out.push(p); }
      } catch (e) { errors.push(`${sport} ${season}: ${String(e.message || e).slice(0, 100)}`); }
      await sleep(250);
    }
  }
  return { passes: out, errors, sample };
}

const parse = (s, d) => { try { return JSON.parse(s || ''); } catch (e) { return d; } };

/* Greedy two-way matching. For every pair of active members who share an
   hour: does A have a giveable pass B wants, and B one A wants? Each member
   gets at most one match per run, and the passes in it are spoken for. */
async function runMatching(db) {
  const users = ((await db.prepare('SELECT * FROM swap_users WHERE active=1 AND passes IS NOT NULL').all()).results || [])
    .map(u => ({ ...u, wants: parse(u.wants, []), keep: new Set(parse(u.keep, [])), slots: parse(u.slots, []),
                 passes: parse(u.passes, []) }));
  const open = ((await db.prepare(`SELECT a, b, aGets, bGets FROM swap_matches WHERE status IN ('pending','sent')`).all()).results || []);
  const busy = new Set(), promised = new Set();
  for (const m of open) {
    busy.add(m.a); busy.add(m.b);
    promised.add(`${m.b}|${m.aGets}`); promised.add(`${m.a}|${m.bGets}`);     // passes already offered
  }
  const gives = u => new Set(u.passes.map(p => p.key).filter(k => !u.keep.has(k) && !promised.has(`${u.key}|${k}`)));
  const made = [];
  for (let i = 0; i < users.length; i++) {
    const A = users[i]; if (busy.has(A.key) || !A.wants.length) continue;
    const gA = gives(A);
    for (let j = i + 1; j < users.length; j++) {
      const B = users[j]; if (busy.has(B.key) || !B.wants.length) continue;
      const slot = A.slots.find(h => B.slots.includes(h));
      if (slot == null) continue;
      const gB = gives(B);
      const aGets = A.wants.find(w => gB.has(w)), bGets = B.wants.find(w => gA.has(w));
      if (!aGets || !bGets) continue;
      made.push({ a: A.key, b: B.key, aGets, bGets, slot });
      busy.add(A.key); busy.add(B.key);
      break;
    }
  }
  const now = Date.now();
  for (const m of made) {
    await db.prepare(`INSERT INTO swap_matches (a, b, aGets, bGets, slot, createdAt, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')`)
      .bind(m.a, m.b, m.aGets, m.bGets, m.slot, now).run();
  }
  return made;
}

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const db = env.RATEBOARD_DB;
  if (!(await isAdminRequest(env, request))) return forbidden('Swaps are admin only while they are being built.');
  const me = await sessionKey(env, request);
  await ready(db);
  const op = url.searchParams.get('op') || '';
  const auth = swapToken(env);

  // Which token names exist (names only, never values).
  if (op === 'env') {
    // Every setting's name (never a value), so a token saved under any name can be spotted.
    return json({ settingNames: Object.keys(env).filter(k => typeof env[k] === 'string'), swapTokenFound: !!auth });
  }

  if (op === 'me') {
    const u = await db.prepare('SELECT * FROM swap_users WHERE key=?').bind(me).first();
    return json({ key: me, tokenFound: !!auth, profile: u ? { rsUser: u.rsUser, hashId: u.hashId, wants: parse(u.wants, []),
      keep: parse(u.keep, []), slots: parse(u.slots, []), passes: parse(u.passes, []), scannedAt: u.scannedAt, active: !!u.active } : null });
  }

  if (op === 'save' && request.method === 'POST') {
    let b = {};
    try { b = await request.json(); } catch (e) {}
    const wants = (Array.isArray(b.wants) ? b.wants : []).map(String).filter(k => /^[a-z]+:\d{4}:\d+$/.test(k)).slice(0, 20);
    const keep = (Array.isArray(b.keep) ? b.keep : []).map(String).filter(k => /^[a-z]+:\d{4}:\d+$/.test(k)).slice(0, 2000);
    const slots = [...new Set((Array.isArray(b.slots) ? b.slots : []).map(Number).filter(h => Number.isInteger(h) && h >= 0 && h < 24))].slice(0, 5);
    const rsUser = String(b.rsUser || '').trim().slice(0, 40);
    await db.prepare(`INSERT INTO swap_users (key, rsUser, wants, keep, slots, updatedAt, active) VALUES (?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(key) DO UPDATE SET rsUser=excluded.rsUser, wants=excluded.wants, keep=excluded.keep,
        slots=excluded.slots, updatedAt=excluded.updatedAt, active=1`)
      .bind(me, rsUser, JSON.stringify(wants), JSON.stringify(keep), JSON.stringify(slots), Date.now()).run();
    return json({ ok: true, wants, keep: keep.length, slots });
  }

  if (op === 'scan') {
    if (!auth) return json({ error: 'No swap token found in the Cloudflare settings.' }, 503);
    if (!(await allow(url.origin, 'swapscan:' + me, 3, 600))) return json({ error: 'Three scans per ten minutes - try again shortly.' }, 429);
    const u = await db.prepare('SELECT rsUser, hashId FROM swap_users WHERE key=?').bind(me).first();
    const rsUser = String(url.searchParams.get('rsUser') || (u && u.rsUser) || '').trim();
    if (!rsUser) return json({ error: 'Enter your Real username first.' }, 400);
    let hashId = u && u.rsUser === rsUser ? u.hashId : null;
    try { if (!hashId) hashId = await resolveHashId(rsUser, auth); } catch (e) { return json({ error: String(e.message || e) }, 502); }
    if (!hashId) return json({ error: `No Real user called ${rsUser}.` }, 404);
    const r = await scanPasses(hashId, auth);
    await fillNames(db, r.passes);
    await db.prepare(`INSERT INTO swap_users (key, rsUser, hashId, passes, scannedAt, updatedAt, wants, keep, slots) VALUES (?, ?, ?, ?, ?, ?, '[]', '[]', '[]')
      ON CONFLICT(key) DO UPDATE SET rsUser=excluded.rsUser, hashId=excluded.hashId, passes=excluded.passes,
        scannedAt=excluded.scannedAt, updatedAt=excluded.updatedAt`)
      .bind(me, rsUser, hashId, JSON.stringify(r.passes), Date.now(), Date.now()).run();
    return json({ hashId, passes: r.passes, errors: r.errors, sample: r.sample });
  }

  if (op === 'matches') {
    const rows = (await db.prepare(`SELECT * FROM swap_matches ORDER BY id DESC LIMIT 200`).all()).results || [];
    const users = (await db.prepare('SELECT key, rsUser, passes FROM swap_users').all()).results || [];
    const names = {};
    for (const u of users) for (const p of parse(u.passes, [])) names[p.key] = p.name;
    const rs = Object.fromEntries(users.map(u => [u.key, u.rsUser]));
    return json({ matches: rows.map(m => ({ ...m, aUser: rs[m.a], bUser: rs[m.b], aGetsName: names[m.aGets], bGetsName: names[m.bGets] })) });
  }

  if (op === 'run') return json({ made: await runMatching(db) });

  // A raw look at a Real endpoint with the swap token: GET only, and only the
  // paths swaps need, for working out response shapes.
  if (op === 'probe') {
    if (!auth) return json({ error: 'No swap token found.' }, 503);
    const path = String(url.searchParams.get('path') || '').replace(/^\/+/, '');
    if (!/^(userpasses|messages|searchusers|users)\b/.test(path)) return json({ error: 'path not allowed' }, 400);
    try {
      const res = await fetch('https://web.realapp.com/' + path, { headers: rsHeaders(auth) });
      const text = await res.text();
      return json({ status: res.status, body: text.slice(0, 6000) });
    } catch (e) { return json({ error: String(e.message || e) }, 502); }
  }

  /* A test message from the swap account into one chat it is in, using
     Real's own send request: POST messages/channels/<id>/messages with
     { text, parentMessageId: null }. Admin only, and capped, so it can't
     become a way to spam. */
  if (op === 'dmtest') {
    if (!auth) return json({ error: 'No swap token found.' }, 503);
    const ch = String(url.searchParams.get('channel') || '');
    const text = String(url.searchParams.get('text') || 'Swap bot test').slice(0, 300);
    if (!/^\d{1,12}$/.test(ch)) return json({ error: 'channel must be a number' }, 400);
    if (!(await allow(url.origin, 'swapdm-test', 5, 600))) return json({ error: 'Five test messages per ten minutes.' }, 429);
    try {
      const res = await fetch(`https://web.realapp.com/messages/channels/${ch}/messages`, {
        method: 'POST', headers: { ...rsHeaders(auth), 'content-type': 'application/json' },
        body: JSON.stringify({ text, parentMessageId: null }) });
      return json({ status: res.status, body: (await res.text()).slice(0, 2000) });
    } catch (e) { return json({ error: String(e.message || e) }, 502); }
  }

  return json({ error: 'unknown op' }, 400);
}
