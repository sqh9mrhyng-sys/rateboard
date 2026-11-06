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
import { isAdminRequest, sessionKey, forbidden, allow, clientIp, touchSeen, ADMINS, etDay } from '../../lib/auth.js';
import { watchEnv, noteSlowRequest } from '../../lib/dbwatch.js';

/* Adding a column that already exists just errors (and is ignored). Each
   ALTER is tried once per server instance, not on every request. */
const ALTERED = new Set();
async function alterOnce(db, sql) {
  if (ALTERED.has(sql)) return;
  ALTERED.add(sql);
  await db.prepare(sql).run();
}


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
  golf: [2026, 2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018, 2017, 2016, 2015, 2014], ufc: [2023]
};
// Every call one full scan makes, in order, and how many go in each part.
const SCAN_STEPS = Object.entries(SWAP_SEASONS).flatMap(([sp, v]) => v.flatMap(se => sp === 'ufc' ? [[sp, se, 'team']] : sp === 'golf' ? [[sp, se, 'player']] : [[sp, se, 'player'], [sp, se, 'team']]));   // golf has no team passes
const SCAN_PER_PART = 90;   // the whole scan in one go

// What the Swaps page scans: no FC or UFC (nothing to swap there), golf back to 2014.
const SWAPS_SCAN = Object.fromEntries(Object.entries(SWAP_SEASONS).filter(([k]) => k !== 'soccer' && k !== 'ufc')
  .map(([k, v]) => [k, k === 'golf' ? [2026, 2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018, 2017, 2016, 2015, 2014] : v]));

const DDL = [
  `CREATE TABLE IF NOT EXISTS swap_users (key TEXT PRIMARY KEY, rsUser TEXT, hashId TEXT,
     wants TEXT, keep TEXT, slots TEXT, passes TEXT, scannedAt INTEGER, updatedAt INTEGER, active INTEGER DEFAULT 1)`,
  `CREATE TABLE IF NOT EXISTS swap_matches (id INTEGER PRIMARY KEY AUTOINCREMENT, a TEXT, b TEXT,
     aGets TEXT, bGets TEXT, slot INTEGER, createdAt INTEGER, sentAt INTEGER, status TEXT, note TEXT)`
];
async function ready(db) { for (const d of DDL) await db.prepare(d).run(); }

/* A small search table of every player-season - name, team, season rax -
   so the "who you want" search reads a few thousand rows instead of the
   whole game log on every keystroke. One sport-season is (re)built at a
   time, each at most once a day, alongside searches. */
const IDX_DDL = [
  `CREATE TABLE IF NOT EXISTS swap_index (sport TEXT, season INTEGER, playerId INTEGER, player TEXT, lname TEXT,
     team TEXT, rax INTEGER, games INTEGER, PRIMARY KEY (sport, season, playerId))`,
  `CREATE TABLE IF NOT EXISTS swap_index_meta (job TEXT PRIMARY KEY, builtAt INTEGER)`
];
async function indexOne(db) {
  for (const d of IDX_DDL) await db.prepare(d).run();
  // At most one season every five minutes, whoever asks: each one is a full
  // read of that season's game log, and back to back they crowd the database.
  const last = await db.prepare("SELECT builtAt FROM swap_index_meta WHERE job='__last'").first();
  if (last && Date.now() - last.builtAt < 5 * 60000) return null;
  await db.prepare("INSERT OR REPLACE INTO swap_index_meta (job, builtAt) VALUES ('__last', ?)").bind(Date.now()).run();
  const meta = new Map(((await db.prepare('SELECT job, builtAt FROM swap_index_meta').all()).results || []).map(r => [r.job, r.builtAt]));
  let pick = null, oldest = Infinity;
  for (const [sp, ss] of Object.entries(SWAP_SEASONS)) for (const se of ss) {
    const at = meta.get(`${sp}:${se}`) || 0;
    if (at < oldest) { oldest = at; pick = [sp, se]; }
  }
  if (!pick || Date.now() - oldest < 86400000) return null;
  const [sp, se] = pick;
  await db.prepare('DELETE FROM swap_index WHERE sport=? AND season=?').bind(sp, se).run();
  await db.prepare(`INSERT OR REPLACE INTO swap_index (sport, season, playerId, player, lname, team, rax, games)
    SELECT sport, season, playerId, MAX(player), LOWER(MAX(player)), MAX(team), COALESCE(SUM(rax), 0), COUNT(*)
      FROM gamelog WHERE sport=? AND season=? GROUP BY playerId`).bind(sp, se).run();
  await db.prepare('INSERT OR REPLACE INTO swap_index_meta (job, builtAt) VALUES (?, ?)').bind(`${sp}:${se}`, Date.now()).run();
  return `${sp}:${se}`;
}

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
function passOf(p, sport, season, kind = 'player') {
  const e = p.entity || p.player || p.primaryPlayer || (p.card && p.card.primaryPlayer) || {};
  const id = Number(p.entityId ?? p.playerId ?? e.id ?? deepFind(p, ['entityId', 'playerId']));
  const name = String((e.firstName && e.lastName ? `${e.firstName} ${e.lastName}` : '')
    || p.label || e.displayName || e.name || e.fullName || e.abbreviation || '').slice(0, 80);
  // Real's own read of the pass: level, multiplier and progress to the next one.
  const b = p.boostInfo || {};
  // boostValue is the pass's total rating; progress/required is the climb to
  // the next level.
  const bv = parseFloat(p.boostValue);
  const rating = Number.isFinite(bv) ? bv : (b.progress != null && Number.isFinite(Number(b.progress)) ? Number(b.progress) : null);
  const mult = parseFloat(String(b.multiplier || '').replace(/x$/i, '')) || null;
  const passId = Number(p.id);
  // Team passes get a "t" in their key so a team and a player with the same
  // number never collide.
  const team = kind === 'team';
  return Number.isFinite(id) ? { key: `${sport}:${season}:${team ? 't' : ''}${id}`, sport, season, id, name, kind,
    count: 1, rating, required: b.required != null ? Number(b.required) : null,
    needNext: b.required != null && b.progress != null ? Math.max(0, Number(b.required) - Number(b.progress)) : null,
    progress: b.progressDisplay || null, toward: b.progressQualifier || null,
    levelLabel: b.rarityLabel ? String(b.rarityLabel) + (b.level && Number(b.baseRarity) >= 5 ? '' : '') : null,
    level: b.level != null ? Number(b.level) : null, rarity: b.baseRarity != null ? Number(b.baseRarity) : null,
    color: b.rarityColor || null, mult, earned: p.earned != null ? Number(p.earned) : null,
    // Set "untouchable" on Real (2026-11-05): never given in a swap.
    ...(p.untouchable === true ? { untouchable: 1 } : {}),
    passId: Number.isFinite(passId) ? passId : null } : null;
}

// Names Real didn't put on the pass, from the board's own game log.
async function fillNames(db, passes) {
  const need = passes.filter(p => p.kind !== 'team' && (!p.name || /^player$/i.test(p.name)));
  const groups = {};
  for (const p of need) (groups[`${p.sport}|${p.season}`] = groups[`${p.sport}|${p.season}`] || []).push(p);
  for (const [g, list] of Object.entries(groups)) {
    const [sp, se] = g.split('|');
    for (let i = 0; i < list.length; i += 90) {
      const ids = list.slice(i, i + 90).map(p => p.id).filter(Number.isFinite);
      try {
        // That season first, then any season of the sport (a player keeps
        // his id), then the marketplace copy - which has this season's
        // rookies the game log doesn't yet.
        const m = new Map();
        const tries = [
          [`SELECT playerId, MAX(player) AS player FROM gamelog WHERE sport=? AND season=? AND playerId IN (${ids.join(',')}) GROUP BY playerId`, [sp, Number(se)]],
          [`SELECT playerId, MAX(player) AS player FROM gamelog WHERE sport=? AND season IN (2027,2026,2025,2024,2023,2022) AND playerId IN (${ids.join(',')}) GROUP BY playerId`, [sp]],
          [`SELECT playerId, MAX(player) AS player FROM market_v2 WHERE sport=? AND season=? AND playerId IN (${ids.join(',')}) GROUP BY playerId`, [sp, Number(se)]]
        ];
        for (const [q, args] of tries) {
          if (ids.every(x => m.has(x))) break;
          try { for (const x of ((await db.prepare(q).bind(...args).all()).results || [])) if (x.player && !m.has(x.playerId)) m.set(x.playerId, x.player); } catch (e) {}
        }
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

/* The bot account (RS_SWAP_TOKEN) only handles DMs. Reading passes and
   looking people up goes through the board's and the market's accounts. */
function scanToks(env) {
  // The market account first: it sits idle unless a market pull is queued,
  // while the board account is busy with the game-data collectors all day.
  const t = [env.RS_MARKET_TOKEN, env.RS_AUTH_TOKEN].filter(x => typeof x === 'string' && x.length > 20);
  return t.length ? [...new Set(t)] : [swapToken(env)].filter(Boolean);
}
const scanTok = env => scanToks(env)[Math.floor(Math.random() * scanToks(env).length)];

async function resolveHashId(username, auth) {
  const d = await rsGetJson(`https://web.realapp.com/searchusers?query=${encodeURIComponent(username)}`, auth);
  const u = ((d && d.users) || []).find(x => String(x.userName || '').toLowerCase() === username.toLowerCase());
  return u ? u.id : null;
}

/* A season's passes can come back a page at a time: someone holding more
   cards than a page holds was silently cut short (a member was missing 3 CBB
   cards). After a page that's full - a round 20, 25, 50 or 100 - or that
   carries a cursor, the next one is asked for (Real's lists page with a cursor
   or with before=<how many so far>, as the shop does), until a page brings
   nothing new. A season with fewer cards costs no extra call. */
const passCursor = o => o && typeof o === 'object' && !Array.isArray(o) ? (o.nextCursor || o.cursor || o.next || o.nextPage || (o.meta && (o.meta.nextCursor || o.meta.cursor)) || null) : null;
async function morePassPages(base, tok, first, rows) {
  const seen = new Set(rows.map(r => String(r && r.id))), extra = [];
  let d = first, n = rows.length;
  for (let i = 0; i < 12; i++) {
    const cur = passCursor(d);
    const full = n >= 20 && [20, 25, 50, 100].some(z => n % z === 0);
    if (!(cur && typeof cur !== 'object') && !full) break;
    await sleep(250);
    const u = base + (cur && typeof cur !== 'object' ? `&cursor=${encodeURIComponent(cur)}&before=${encodeURIComponent(cur)}` : `&before=${seen.size}`);
    const res = await fetch(u, { headers: rsHeaders(tok) });
    if (!res.ok) throw new Error(`Real ${res.status} (page ${i + 2})`);
    try { d = JSON.parse(await res.text()); } catch (e) { break; }
    const page = rowsOf(d), fresh = page.filter(r => r && !seen.has(String(r.id)));
    if (!fresh.length) break;
    for (const r of fresh) { seen.add(String(r.id)); extra.push(r); }
    n = page.length;
  }
  return extra;
}

// Reads every player pass a member has, one sport-season at a time, one
// request at a time.
async function scanPasses(hashId, auth, only) {
  const out = [], errors = [];
  let sample = null;
  for (const [sport, seasons] of Object.entries(only || SWAP_SEASONS)) {
    for (const season of seasons) {
      // Player passes, then team passes (UFC fighters are filed as teams).
      for (const kind of (only ? ['player'] : ['player', 'team'])) {
        try {
          const base = `https://web.realapp.com/userpasses/${encodeURIComponent(hashId)}/passes?entityType=${kind}&season=${season}&sport=${sport}`;
          const d = await rsGetJson(base, auth);
          const rows = rowsOf(d);
          rows.push(...(await morePassPages(base, auth, d, rows)));
          if (rows.length && !sample) sample = { sport, season, keys: Object.keys(d || {}), first: rows[0] };
          for (const r of rows) { const p = passOf(r, sport, season, kind); if (p) out.push(p); }
        } catch (e) { errors.push(`${sport} ${season} ${kind}: ${String(e.message || e).slice(0, 100)}`); }
        await sleep(700);
      }
    }
  }
  return { passes: out, errors, sample };
}

const parse = (s, d) => { try { return JSON.parse(s || ''); } catch (e) { return d; } };

/* Greedy two-way matching. For every pair of active members who share an
   hour: does A have a giveable pass B wants, and B one A wants? Each member
   gets at most one match per run, and the passes in it are spoken for. */
/* Goal rating: once a member is near the rating they want on the pass they
   are swapping for, they only get as many swaps as it should take to get
   there - each swap counted as one pack's average card rating for that
   player (pack data), or the season's average when the player has none. */
// Each season's pack averages, kept 30 minutes per isolate (matching re-read every season's snapshot each run: ~8s).
const PACK_MEMO = new Map();
async function packAvg(db, cache, key) {
  const [sp, se, id] = String(key).split(':');
  const sk = sp + ':' + se;
  if (!cache.has(sk)) { const pm = PACK_MEMO.get(sk); if (pm && Date.now() - pm.at < 30 * 60000) cache.set(sk, pm.v); }
  if (!cache.has(sk)) {
    let rows = [];
    try { const r = await db.prepare('SELECT body FROM pack_snap WHERE sport=? AND season=?').bind(sp, Number(se)).first(); rows = parse(r && r.body, []) || []; } catch (e) {}
    const by = new Map(), vals = [];
    for (const x of rows) { const v = Number(x.avgRating); if (v > 0) { by.set(Number(x.playerId), v); vals.push(v); } }
    cache.set(sk, { by, all: vals.length ? vals.reduce((a, v) => a + v, 0) / vals.length : null });
    if (rows.length) PACK_MEMO.set(sk, { at: Date.now(), v: cache.get(sk) });
  }
  const c = cache.get(sk);
  // A swap is one pack, and a pack is three cards (floor of 10, as on the pack data tab).
  // This used to count one card per swap, so it allowed about three times the swaps a goal needed.
  const card = c.by.get(Number(id)) || c.all || null;
  return card ? Math.max(10, card * 3) : null;
}
/* Only players with 27+ collectible plays can be swapped for (Dennis,
   2026-11-04): a pack of a thin player is mostly the same few cards. Counts
   come from pack data (each season's saved board), kept 12 hours as a small
   id -> plays map. A season with no pack data at all isn't held back. */
const MIN_PLAYS = 27;
async function playsMap(env, db, sp, se) {
  const k = `plays_ct_v1_${sp}_${se}`;
  try { const c = JSON.parse((await env.RATEBOARD_KV.get(k)) || 'null'); if (c && Date.now() - c.at < 12 * 3600000) return c.m; } catch (e) {}
  let m = null;
  try { const r = await db.prepare('SELECT body FROM pack_snap WHERE sport=? AND season=?').bind(sp, Number(se)).first();
    const rows = parse(r && r.body, null);
    if (Array.isArray(rows) && rows.length) { m = {}; for (const x of rows) if (x && x.playerId != null) m[x.playerId] = Number(x.plays) || 0; } } catch (e) {}
  try { await env.RATEBOARD_KV.put(k, JSON.stringify({ at: Date.now(), m }), { expirationTtl: 86400 }); } catch (e) {}
  return m;
}
// The keys (sport:season:id) with fewer than MIN_PLAYS collectible plays, among those given.
const playsMemo = new Map();   // this worker's copy, so a page open doesn't read KV once per season
async function lowPlays(env, db, keys) {
  const bySeason = new Map(), low = new Set();
  for (const k of keys) { const [sp, se, id] = String(k).split(':'); if (/^t/.test(id)) continue; (bySeason.get(`${sp}:${se}`) || bySeason.set(`${sp}:${se}`, []).get(`${sp}:${se}`)).push([k, id]); }
  // Every season at once rather than one after another.
  await Promise.all([...bySeason].map(async ([ss, list]) => { const [sp, se] = ss.split(':');
    let c = playsMemo.get(ss);
    if (!c || Date.now() - c.at > 30 * 60000) { c = { at: Date.now(), m: await playsMap(env, db, sp, se) }; playsMemo.set(ss, c); }
    const m = c.m; if (!m) return; for (const [k, id] of list) if ((m[id] || 0) < MIN_PLAYS) low.add(k); }));
  return low;
}
async function goalRoom(db, cache, u, usedFor, wantKey) {
  const want = wantKey || (u.wants || [])[0];
  // Each player has his own goal now (2026-11-05); the old single goal is the fallback.
  const cp = typeof u.caps === 'string' ? (parse(u.caps, {}) || {}) : (u.caps || {});
  const g = Number(cp[want] && cp[want].g) || Number(u.goal);
  if (!want || !(g > 0)) return { limited: false, left: Infinity };
  const p = (u.passes || []).find(x => x.key === want);
  const rating = p ? Number(p.rating) || 0 : 0;
  if (rating >= g) return { limited: true, left: 0, rating, goal: g, reached: true };
  const avg = await packAvg(db, cache, want);
  if (!avg) return { limited: false, left: Infinity, rating, goal: g };
  const need = Math.ceil((g - rating) / avg);
  const used = usedFor ? await usedFor(u, want) : 0;
  return { limited: true, left: Math.max(0, need - used), need, used, rating, goal: g, avg: Math.round(avg * 100) / 100 };
}
async function usedSince(db, u, want) {
  const since = Number(u.scannedAt) || 0;
  const r = await db.prepare(`SELECT COUNT(*) AS n FROM swap_matches WHERE createdAt > ? AND status IN ('pending','sending','warned','sent')
    AND ((a=? AND aGets=?) OR (b=? AND bGets=?))`).bind(since, u.key, want, u.key, want).first();
  return Number(r && r.n) || 0;
}

const MAX_WANTS = 10;    // players a member can swap for at once (was 5)
/* When a member can swap (Dennis, 2026-11-04). Three ways:
     daily   - the same hours every day (slots, UTC hours, as before)
     weekly  - different hours for each day of the week, in their own time
     date    - just one day, in their own time
   sched = { mode, tz, week: { '0'..'6': [local hours] }, date: 'YYYY-MM-DD', hours: [local hours] }.
   For weekly/date, slots also holds every UTC hour they use, for the counts
   and quick filters. Each list is in tap order: the first is the primary. */
const localAt = (ms, tz) => { try { const o = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz || 'UTC', hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { wd: { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[o.weekday], hour: Number(o.hour) % 24, date: `${o.year}-${o.month}-${o.day}` }; } catch (e) { return null; } };
// Their rank for a swap at this moment (0 = primary), or -1 if they don't swap then.
function rankAt(u, due) {
  const sc = u.sched && typeof u.sched === 'object' ? u.sched : null;
  if (!sc || sc.mode === 'daily' || !sc.mode) return (u.slots || []).indexOf(new Date(due).getUTCHours());
  const l = localAt(due, sc.tz); if (!l) return -1;
  if (sc.mode === 'weekly') return ((sc.week || {})[l.wd] || []).indexOf(l.hour);
  if (sc.mode === 'date') return l.date === sc.date ? (sc.hours || []).indexOf(l.hour) : -1;
  return -1;
}
function cleanSched(b) {
  const hrs = a => [...new Set((Array.isArray(a) ? a : []).map(Number).filter(h => Number.isInteger(h) && h >= 0 && h < 24))].slice(0, MAX_SLOTS);
  const mode = ['daily', 'weekly', 'date'].includes(b && b.mode) ? b.mode : 'daily';
  const tz = String((b && b.tz) || 'UTC').slice(0, 60);
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch (e) { return { mode: 'daily' }; }
  if (mode === 'weekly') { const week = {}; for (let d = 0; d < 7; d++) week[d] = hrs(b.week && b.week[d]); return { mode, tz, week }; }
  if (mode === 'date') return { mode, tz, date: /^\d{4}-\d{2}-\d{2}$/.test(String(b.date || '')) ? String(b.date) : null, hours: hrs(b.hours) };
  return { mode: 'daily' };
}
// The UTC hours a weekly/date schedule touches (today's offset), for counts and filters.
function schedUtc(sc) {
  if (!sc || sc.mode === 'daily') return null;
  const off = (() => { const l = localAt(Date.now(), sc.tz); return l ? ((l.hour - new Date().getUTCHours()) % 24 + 24) % 24 : 0; })();
  const loc = sc.mode === 'weekly' ? Object.values(sc.week || {}).flat() : (sc.hours || []);
  return [...new Set(loc.map(h => ((h - off) % 24 + 24) % 24))];
}
const MATCH_AHEAD_MS = 3 * 3600000 + 30 * 60000;   // a run fills the hours starting in the next 3.5 hours
const MAX_SLOTS = 10;    // hours a member can pick, per day (was 5)
/* Members' saved passes are big (every sport and season), and D1 won't hand
   back more than 50 MB in one answer, so wide reads go a page at a time. */
async function pagedRows(db, sql, binds = [], size = 25) {
  const out = [];
  for (let off = 0; ; off += size) {
    const r = ((await db.prepare(`${sql} ORDER BY key LIMIT ? OFFSET ?`).bind(...binds, size, off).all()).results) || [];
    out.push(...r);
    if (r.length < size) return out;
  }
}

/* ---------- Inbox: reports and feature requests, answered through the bot ----------
   Three sources: Swaps reports (swap_reports), board member reports (the
   board blob in KV) and feature requests (features). Dennis can answer any of
   them; when the person who sent it has a chat with the bot, the answer and
   the outcome go to them on Real. Every bot message he sends is kept in
   admin_dm so he can see who has written back. */
const BOARD_KV = 'ratebrd_market_v1';
const ADMIN_DM_DDL = `CREATE TABLE IF NOT EXISTS admin_dm (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT, rsUser TEXT, hashId TEXT, channelId INTEGER, text TEXT, ts INTEGER, ref TEXT)`;
const RESTRICT_DDL = `CREATE TABLE IF NOT EXISTS restricted (key TEXT PRIMARY KEY, at INTEGER, why TEXT)`;
// Swaps taken away by Dennis from the admin page (swaps only - posting offers is untouched).
const SBLOCK_DDL = `CREATE TABLE IF NOT EXISTS swap_block (key TEXT PRIMARY KEY, at INTEGER)`;
// Someone named by a board key or a Real username: their board key, Real name, comment and bot chat.
async function whoIs(db, name) {
  const n = String(name || '').trim().replace(/^@/, '').toLowerCase();
  if (!n) return null;
  await db.prepare(DM_DDL).run();
  const u = await db.prepare('SELECT key, rsUser, hashId, comment, active FROM swap_users WHERE LOWER(key)=? OR LOWER(rsUser)=? LIMIT 1').bind(n, n).first();
  const b = await db.prepare('SELECT key, banned FROM users WHERE LOWER(key)=? LIMIT 1').bind(u ? String(u.key).toLowerCase() : n).first().catch(() => null);
  let ch = null;
  if (u && u.hashId) ch = await db.prepare('SELECT channelId FROM swap_dm WHERE hashId=? AND channelId IS NOT NULL').bind(u.hashId).first();
  if (!ch) ch = await db.prepare('SELECT channelId, hashId FROM swap_dm WHERE LOWER(userName)=? AND channelId IS NOT NULL LIMIT 1').bind(u && u.rsUser ? String(u.rsUser).toLowerCase() : n).first();
  let restricted = false;
  try { await db.prepare(RESTRICT_DDL).run(); restricted = !!(await db.prepare('SELECT 1 AS x FROM restricted WHERE key=?').bind(b ? b.key : (u ? u.key : n)).first()); } catch (e) {}
  return { name: n, key: b ? b.key : (u ? u.key : null), rsUser: (u && u.rsUser) || null, hashId: (u && u.hashId) || (ch && ch.hashId) || null,
    comment: (u && u.comment) || null, channelId: ch ? Number(ch.channelId) : null, banned: !!(b && b.banned), restricted, swapper: !!(u && u.active) };
}
async function adminDm(db, auth, who, text, ref) {
  if (!who || !who.channelId) return { sent: false, why: 'no open chat with the bot' };
  await db.prepare(ADMIN_DM_DDL).run();
  try {
    await dmSend(auth, who.channelId, text);
    await db.prepare('INSERT INTO admin_dm (key, rsUser, hashId, channelId, text, ts, ref) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(who.key || who.name, who.rsUser || who.name, who.hashId, who.channelId, String(text).slice(0, 1000), Date.now(), ref || null).run();
    await stat(db, 'dm_admin');
    return { sent: true };
  } catch (e) { await botFail(db, 'dm_admin', `${who.name}: ${e.message || e}`); return { sent: false, why: String(e.message || e).slice(0, 160) }; }
}
// A player's name for a pass key, from the search index (no member passes loaded).
async function indexName(db, k, cache) {
  if (cache && cache.has(k)) return cache.get(k);
  const [sp, se, id] = String(k).split(':'); let n = null;
  try { const r = await db.prepare('SELECT player FROM swap_index WHERE sport=? AND season=? AND playerId=? LIMIT 1').bind(sp, Number(se), Number(String(id).replace(/^t/, ''))).first(); n = r && r.player; } catch (e) {}
  const v = `${n || 'Player ' + id} ${({ nba: 'NBA', ncaam: 'CBB', nfl: 'NFL', ncaaf: 'CFB', nhl: 'NHL', mlb: 'MLB', wnba: 'WNBA', golf: 'Golf' })[sp] || sp} ${se}`;
  if (cache) cache.set(k, v); return v;
}
async function inboxItems(env, db) {
  const out = [];
  await db.prepare(SREPORT_DDL).run();
  try { await alterOnce(db, 'ALTER TABLE swap_reports ADD COLUMN matchId INTEGER'); } catch (e) {}
  for (const r of ((await db.prepare("SELECT rowid AS id, ts, by_user, kind, target, detail, matchId FROM swap_reports WHERE status='open' ORDER BY ts DESC LIMIT 200").all()).results || []))
    out.push({ src: 'swap', id: String(r.id), ts: r.ts, by: r.by_user, target: r.target, matchId: r.matchId || null,
      kind: r.kind === 'user' ? 'Swaps: wrong usage' : r.kind === 'refund' ? 'Swaps: called-off swap' : 'Swaps: problem', detail: r.detail });
  try { const m = JSON.parse((await env.RATEBOARD_KV.get(BOARD_KV)) || '{}') || {};
    for (const r of (m.reports || []).filter(x => x.status === 'open')) out.push({ src: 'board', id: String(r.id), ts: r.ts, by: r.by, target: r.target, kind: 'Board: member report', detail: r.reason || '' }); } catch (e) {}
  try { await db.prepare(`CREATE TABLE IF NOT EXISTS features (id TEXT PRIMARY KEY, ts INTEGER NOT NULL, by_user TEXT NOT NULL, kind TEXT, title TEXT NOT NULL, detail TEXT, status TEXT NOT NULL DEFAULT 'open')`).run();
    for (const r of ((await db.prepare("SELECT id, ts, by_user, kind, title, detail FROM features WHERE status='open' ORDER BY ts DESC LIMIT 300").all()).results || []))
      out.push({ src: 'feature', id: String(r.id), ts: r.ts, by: r.by_user, target: null, kind: 'Feature request' + (r.kind ? ' · ' + r.kind : ''), title: r.title, detail: r.detail || '' }); } catch (e) {}
  out.sort((a, b) => b.ts - a.ts);
  const cache = new Map(), look = async n => { const k = String(n || '').toLowerCase(); if (!k) return null; if (!cache.has(k)) cache.set(k, await whoIs(db, k)); return cache.get(k); };
  for (const x of out) { x.from = await look(x.by); x.about = x.target ? await look(x.target) : null; }
  // Swaps reports: the called-off swaps (last 30 days) the reporter was in, and whether they were refunded.
  try { await matchCols(db); } catch (e) {}
  for (const x of out) if (x.src === 'swap' && x.from && x.from.key) {
    const k = x.from.key;
    const ms = ((await db.prepare(`SELECT * FROM swap_matches WHERE status='cancelled' AND (a=? OR b=?) AND createdAt > ? ORDER BY id DESC LIMIT 20`).bind(k, k, Date.now() - 30 * 86400000).all()).results) || [];
    const nc = new Map();
    x.offs = [];
    for (const m of ms) { const side = m.a === k ? 'A' : 'B';
      // The players in it: what the reporter was to buy (give) and what they were to get.
      const gives = side === 'A' ? m.bGets : m.aGets, gets = side === 'A' ? m.aGets : m.bGets;
      x.offs.push({ id: m.id, due: sideDue(m), partner: side === 'A' ? m.b : m.a, side, told: !!(m['warn' + side] || m['done' + side]), refunded: m['refund' + side] || null,
        note: m.note || null, reported: x.matchId === m.id, buys: await indexName(db, gives, nc), gets: await indexName(db, gets, nc) }); }
  }
  // Board reports: every board listing (with its comment link) of the person reported.
  for (const x of out) if (x.src === 'board' && x.about) {
    try { x.about = { ...x.about, offers: ((await db.prepare('SELECT id, sport, player, rate, link, ts FROM offers WHERE LOWER(user)=? ORDER BY ts DESC LIMIT 100')
      .bind(String(x.about.key || x.target).toLowerCase()).all()).results) || [] }; } catch (e) {}
  }
  return out;
}
// The outcome note to the person who sent it.
function outcomeText(item, status) {
  const word = status === 'done' ? 'has been completed' : 'has been denied';
  if (item.src === 'feature') return `Your feature request "${String(item.title || '').slice(0, 120)}" ${word}.`;
  if (item.target) return `Your report of @${item.target} ${word}.`;
  return `Your report "${String(item.detail || '').slice(0, 80)}${String(item.detail || '').length > 80 ? '…' : ''}" ${word}.`;
}
async function closeItem(env, db, item, status) {
  if (item.src === 'swap') {
    if (status === 'delete') await db.prepare('DELETE FROM swap_reports WHERE rowid=?').bind(Number(item.id)).run();
    else await db.prepare('UPDATE swap_reports SET status=? WHERE rowid=?').bind(status === 'done' ? 'closed' : 'declined', Number(item.id)).run();
  } else if (item.src === 'feature') {
    if (status === 'delete') await db.prepare('DELETE FROM features WHERE id=?').bind(item.id).run();
    else await db.prepare('UPDATE features SET status=? WHERE id=?').bind(status === 'done' ? 'done' : 'declined', item.id).run();
  } else {
    const m = JSON.parse((await env.RATEBOARD_KV.get(BOARD_KV)) || '{}') || {};
    m.reports = m.reports || [];
    if (status === 'delete') m.reports = m.reports.filter(x => String(x.id) !== item.id);
    else { const r = m.reports.find(x => String(x.id) === item.id); if (r) r.status = status === 'done' ? 'closed' : 'declined'; }
    await env.RATEBOARD_KV.put(BOARD_KV, JSON.stringify(m));
  }
}
// Who wrote last in a chat, read from Real's message list (any of the shapes it uses).
async function chatState(auth, channelId, theirId, since) {
  const d = await rsGetJson(`https://web.realapp.com/messages/channels/${channelId}/messages`, auth);
  const msgs = [];
  const walk = o => { if (!o || typeof o !== 'object') return; if (Array.isArray(o)) { o.forEach(walk); return; }
    if (typeof o.text === 'string' && (o.createdAt || o.created || o.timestamp || o.id)) msgs.push(o); else Object.values(o).forEach(v => v && typeof v === 'object' && walk(v)); };
  walk(d);
  const author = m => String(m.userId || m.senderId || m.authorId || (m.user && (m.user.id || m.user.userId)) || (m.sender && m.sender.id) || '');
  const when = m => { const t = m.createdAt || m.created || m.timestamp; const n = typeof t === 'number' ? (t < 1e12 ? t * 1000 : t) : Date.parse(t); return Number.isFinite(n) ? n : 0; };
  const theirs = msgs.filter(m => theirId && author(m) === String(theirId)).sort((a, b) => when(b) - when(a));
  const last = theirs[0];
  return { messages: msgs.length, replied: !!(last && when(last) > since), lastTheirs: last ? { at: when(last), text: String(last.text).slice(0, 300) } : null };
}

const PRIO_KEY = 'swap_priority_v1';
async function runMatching(db, env) {
  const T = [Date.now()], lap = () => T.push(Date.now());
  // Only members the bot already has a chat with: new chats are capped at
  // five a day, so a match with anyone else might never be delivered.
  await db.prepare(DM_DDL).run();
  try { await db.prepare(RESTRICT_DDL).run(); } catch (e) {}
  try { await db.prepare(SBLOCK_DDL).run(); } catch (e) {}
  const users = (await pagedRows(db, `SELECT * FROM swap_users WHERE active=1 AND passes IS NOT NULL
      AND wants IS NOT NULL AND wants <> '[]' AND slots IS NOT NULL AND slots <> '[]'
      AND key NOT IN (SELECT key FROM restricted) AND key NOT IN (SELECT key FROM swap_block)
      AND hashId IN (SELECT hashId FROM swap_dm WHERE channelId IS NOT NULL)`))
    .map(u => ({ ...u, sched: parse(u.sched, null), wants: parse(u.wants, []), keep: new Set(parse(u.keep, [])), touch: new Set(parse(u.touch, [])), slots: parse(u.slots, []),
                 passes: parse(u.passes, []), caps: parse(u.caps, {}) || {} }));
  /* A member can be in any number of swaps a swap day, with anyone, the same
     partner again (even in the same hour) included. Each specific pass
     (player + season) a member gives goes out once a swap day: they hold one
     pack of it. The swap day runs 7am to 7am ET, by the hour the swap
     happens, so a player can go out at 6am and again at 7am. Limited by their
     goal rating when they set one. */
  /* A pass set untouchable on Real since its swap was made: that swap is
     called off while it's still only scheduled (once warned, the late-change
     rule keeps it). */
  try {
    // ...and the same for a pass they're now swapping for themselves.
    const un = new Map(users.map(u => [u.key, new Set([...u.passes.filter(p => p.untouchable && !u.touch.has(p.key)).map(p => p.key), ...u.wants])]).filter(([, v]) => v.size));
    if (un.size) {
      const pend = ((await db.prepare(`SELECT * FROM swap_matches WHERE status='pending' AND dueAt > ?`).bind(Date.now()).all()).results) || [];
      const res = { n: 0, late: 0, soon: 0 };
      for (const m of pend) {
        const who = un.has(m.b) && un.get(m.b).has(m.aGets) ? m.b : un.has(m.a) && un.get(m.a).has(m.bGets) ? m.a : null;
        if (who && !lateStage(m)) { const own = (users.find(u => u.key === who) || { wants: [] }).wants.includes(who === m.b ? m.aGets : m.bGets);
          await callOff(db, m, own ? `called off: @${who} is swapping for that player themselves` : `called off: @${who} set that pass untouchable`, res); }
      }
    }
  } catch (e) {}
  // One read of the last two days' swaps, split here into live ones and the rest.
  const recent2d = ((await db.prepare(`SELECT a, b, aGets, bGets, slot, createdAt, dueAt, followA, followB, warnA, warnB, doneA, doneB, status FROM swap_matches WHERE createdAt > ?`).bind(Date.now() - 2 * 86400000).all()).results || []);
  const LIVE_ST = new Set(['pending', 'sending', 'warned', 'sent']);
  const open = recent2d.filter(m => LIVE_ST.has(m.status));
  /* A called-off swap still uses up a pass for the day on whichever side had
     already been told to buy it - they may well have bought the pack - so it
     isn't handed to them to give again (people were told to give the same
     card twice in one day). */
  /* Once a pass has been scheduled to go out from someone, it's theirs for the
     swap day (to 7am ET) whatever happens to that swap - called off, cleared,
     anything (Dennis, 2026-11-04). So every swap made, in any state, counts. */
  const offTold = recent2d.filter(m => !LIVE_ST.has(m.status));
  const paired = new Set(), given = new Set(), count = new Map(), recv = new Map(), closed = new Set(), goalUsed = new Map();
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  for (const m of open) {
    const d = swapDay(sideDue(m));
    given.add(`${m.b}|${m.aGets}|${d}`); given.add(`${m.a}|${m.bGets}|${d}`);     // B gave aGets, A gave bGets: each pass goes out once a swap day
    bump(count, `${m.a}|${d}`); bump(count, `${m.b}|${d}`);
    bump(recv, `${m.a}|${m.aGets}|${d}`); bump(recv, `${m.b}|${m.bGets}|${d}`);
    // Finished swaps are marked (followA/followB) but no longer close the swap day.
  }
  /* A called-off swap only uses up the pass of a side that had already been
     warned (told to buy - they may have bought it). Called off before any
     warning, both passes are free again the same swap day (Dennis, 2026-11-05). */
  for (const m of offTold) { const d = swapDay(sideDue(m));
    if (m.warnB || m.doneB) given.add(`${m.b}|${m.aGets}|${d}`);
    if (m.warnA || m.doneA) given.add(`${m.a}|${m.bGets}|${d}`); }
  // Packs a member marked as used today themselves (Packs today tab): not given again this swap day.
  for (const u of users) { const pu = parse(u.packsUsed, null); if (pu && pu.day && Array.isArray(pu.keys)) for (const k of pu.keys) given.add(`${u.key}|${k}|${pu.day}`); }
  lap();   // 1: members + swaps read
  // FC and UFC have no packs to swap, so neither is ever offered or matched.
  const swappable = k => !/^(soccer|ufc):/.test(k) && !seasonOff(k);
  // Up to 5 players each, in their order, and only passes they own: they buy cards for those.
  for (const u of users) { const own = new Set(u.passes.filter(p => p.kind !== 'team').map(p => p.key)); u.wants = u.wants.filter(k => swappable(k) && own.has(k)).slice(0, MAX_WANTS); }
  // Players with fewer than 27 collectible plays are never matched, even if picked before the rule.
  if (env) { try { const low = await lowPlays(env, db, [...new Set(users.flatMap(u => u.wants))]); if (low.size) for (const u of users) u.wants = u.wants.filter(k => !low.has(k)); } catch (e) {} }
  /* Goal rating, per player they want: how many more swaps that pass can take.
     The counts come from one read of the live swaps, done here in memory
     (2026-11-05: a count query per member per player - hundreds once goals
     went per player - ran matching past its time limit and no swaps were
     made from 22:20 UTC). */
  const recvAt = new Map();
  for (const m of (((await db.prepare("SELECT a, b, aGets, bGets, createdAt FROM swap_matches WHERE status IN ('pending','sending','warned','sent')").all()).results) || []))
    for (const [k, w] of [[m.a, m.aGets], [m.b, m.bGets]]) { const kk = k + '|' + w; (recvAt.get(kk) || recvAt.set(kk, []).get(kk)).push(Number(m.createdAt) || 0); }
  const countSince = (k, w, since) => { const t0 = Number(since) || 0; let n = 0; for (const t of (recvAt.get(k + '|' + w) || [])) if (t > t0) n++; return n; };
  lap();   // 2: low plays + live swaps read
  const cache = new Map(), goalLeft = new Map();
  // Every season that has a goal set, read at once rather than one after another.
  { const need = new Map(); for (const u of users) for (const w of u.wants) { const g = Number(u.caps[w] && u.caps[w].g) || Number(u.goal); if (g > 0) need.set(String(w).split(':').slice(0, 2).join(':'), w); }
    await Promise.all([...need.values()].map(w => packAvg(db, cache, w).catch(() => null))); }
  for (const u of users) for (const w of u.wants) {
    let left = Infinity;
    try { const g = await goalRoom(db, cache, u, (x, ww) => countSince(x.key, ww, x.scannedAt), w); if (g.limited) left = g.left; } catch (e) {}
    // Scale: their own cap for this player, overall since they set it.
    const c = u.caps[w];
    if (c && Number(c.n) > 0 && c.at) left = Math.min(left, Math.max(0, Number(c.n) - countSince(u.key, w, c.at)));
    goalLeft.set(`${u.key}|${w}`, left);
  }
  // No daily cap and no limit per partner: two members swap as often as they have compatible picks.
  const dayCap = new Map(users.filter(u => Number(u.dayCap) > 0).map(u => [u.key, Number(u.dayCap)]));
  const roomFor = (k, d) => !closed.has(`${k}|${d}`) && (count.get(`${k}|${d}`) || 0) < (dayCap.get(k) ?? Infinity);   // Scale: their swaps-a-day, if set
  const goalOk = (k, w) => (goalLeft.get(`${k}|${w}`) ?? Infinity) > 0;
  // Scale: their swaps-a-day for one player.
  const capsOf = new Map(users.map(u => [u.key, u.caps]));
  // Receiving the same pass more than once a day is fine (Dennis, 2026-11-04); only their own Scale per-day limit applies.
  const perDayOk = (k, w, d) => { const c = (capsOf.get(k) || {})[w]; return !(c && Number(c.d) > 0) || (recv.get(`${k}|${w}|${d}`) || 0) < Number(c.d); };
  // Never a pass they're swapping for themselves (2026-11-05: a member was receiving Caufield and giving Caufield in the same hour).
  const gives = (u, d) => new Set(u.passes.filter(p => p.kind !== 'team' && !(p.untouchable && !u.touch.has(p.key))).map(p => p.key).filter(k => swappable(k) && !u.keep.has(k) && !u.wants.includes(k) && !given.has(`${u.key}|${k}|${d}`)));
  /* Every possible pair and shared hour, best first: an hour someone picked
     first is their primary, so pairs on both members' earliest picks go
     ahead - when two people want the same player, the one whose primary
     hour it is gets it. */
  /* An hour closes to new matches once its warning has gone out (30 min
     before): the 11:30 run can't add anyone to 12:00, so everyone in an
     hour got the same warning. That hour's next turn is the following day. */
  lap();   // 3: goals
  const made = [], now = Date.now(), cands = [];
  /* Only the next few hours are filled each run (Dennis, 2026-11-04), in time
     order: the tops of the hour from just after the next warning out to
     MATCH_AHEAD_MS. Each member's schedule says whether (and how high) they
     swap at each one. */
  const dues = [];
  for (let t = Math.floor((now + 30 * 60000) / 3600000) * 3600000 + 3600000; t - now <= MATCH_AHEAD_MS; t += 3600000) dues.push(t);
  /* Priority members (Dennis picks them on the Swaps page, 2026-11-05): every
     hour they pick counts as their 1st, and their pairs go ahead of everyone
     but Dennis's - so when two people want the same player, they get it. */
  let prio = new Set(); try { prio = new Set((JSON.parse((env && await env.RATEBOARD_KV.get(PRIO_KEY)) || '[]') || []).map(k => String(k).toLowerCase())); } catch (e) {}
  const isPrio = k => prio.has(String(k).toLowerCase()), bossOf = k => ADMINS.includes(String(k).toLowerCase()) ? 2 : isPrio(k) ? 1 : 0;
  const ranks = new Map(users.map(u => [u.key, dues.map(t => { const r = rankAt(u, t); return r >= 0 && bossOf(u.key) ? 0 : r; })]));
  for (let i = 0; i < users.length; i++) for (let j = i + 1; j < users.length; j++) {
    const A = users[i], B = users[j];
    if (!A.wants.length || !B.wants.length) continue;
    const RA = ranks.get(A.key), RB = ranks.get(B.key);
    dues.forEach((due, k) => {
      const ra = RA[k], rb = RB[k]; if (ra < 0 || rb < 0) return;
      cands.push({ A, B, slot: new Date(due).getUTCHours(), best: Math.min(ra, rb), sum: ra + rb, due, i, boss: Math.max(bossOf(A.key), bossOf(B.key)) });
    });
  }
  // Dennis first, in every hour he picks; then the soonest hour; then primary hours.
  cands.sort((x, y) => (y.boss - x.boss) || x.due - y.due || x.best - y.best || x.sum - y.sum || x.i - y.i);
  for (const { A, B, slot, due } of cands) {
    const d = swapDay(due);
    if (!roomFor(A.key, d) || !roomFor(B.key, d)) continue;
    // The same two can swap again, even in the same hour, while each still has a pass the other wants.
    for (;;) {
    if (!roomFor(A.key, d) || !roomFor(B.key, d)) break;
    // The best pair of picks that works both ways (earlier picks first). The
    // exact same pass both ways is no swap; the same player in two seasons is fine.
    const gB = gives(B, d), gA = gives(A, d);
    const aOk = A.wants.filter(w => gB.has(w) && goalOk(A.key, w) && perDayOk(A.key, w, d)), bOk = B.wants.filter(w => gA.has(w) && goalOk(B.key, w) && perDayOk(B.key, w, d));
    let pick = null;
    for (let s = 0; s < aOk.length + bOk.length && !pick; s++)
      for (let x = 0; x <= s && !pick; x++) { const aw = aOk[x], bw = bOk[s - x]; if (aw && bw && aw !== bw) pick = [aw, bw]; }
    if (!pick) break;
    const [aGets, bGets] = pick;
    made.push({ a: A.key, b: B.key, aGets, bGets, slot, due });
    given.add(`${B.key}|${aGets}|${d}`); given.add(`${A.key}|${bGets}|${d}`);
    bump(count, `${A.key}|${d}`); bump(count, `${B.key}|${d}`);
    bump(recv, `${A.key}|${aGets}|${d}`); bump(recv, `${B.key}|${bGets}|${d}`);
    goalLeft.set(`${A.key}|${aGets}`, (goalLeft.get(`${A.key}|${aGets}`) ?? Infinity) - 1);
    goalLeft.set(`${B.key}|${bGets}`, (goalLeft.get(`${B.key}|${bGets}`) ?? Infinity) - 1);
    }
  }
  lap();   // 4: pairing
  // Never the same swap twice on one swap day, even if two runs overlap: checked against the
  // live swaps read at the start (in memory), then saved 50 at a time.
  try { await alterOnce(db, 'ALTER TABLE swap_matches ADD COLUMN dueAt INTEGER'); } catch (e) {}
  const sig = (a, b, ag, bg, d) => a < b ? `${a}|${b}|${ag}|${bg}|${d}` : `${b}|${a}|${bg}|${ag}|${d}`;
  const seen = new Set(open.map(x => sig(x.a, x.b, x.aGets, x.bGets, swapDay(sideDue(x)))));
  const ins = [];
  for (const m of made) { const k = sig(m.a, m.b, m.aGets, m.bGets, swapDay(m.due)); if (seen.has(k)) continue; seen.add(k);
    ins.push(db.prepare(`INSERT INTO swap_matches (a, b, aGets, bGets, slot, createdAt, status, dueAt) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`).bind(m.a, m.b, m.aGets, m.bGets, m.slot, now, m.due)); }
  for (let i = 0; i < ins.length; i += 50) await db.batch(ins.slice(i, i + 50));
  lap();   // 5: saved
  made.timing = `members ${users.length}, read ${T[1] - T[0]}ms, plays ${T[2] - T[1]}ms, goals ${T[3] - T[2]}ms, pairing ${T[4] - T[3]}ms, save ${T[5] - T[4]}ms`;
  return made;
}

/* ---------- Bot DMs ----------
   Sent from the swap account (raxacademy.app). Real opens a chat with
   POST messages/channels { users: [{ id, userName }] } and answers
   { channelId }; a message is POST messages/channels/<id>/messages with
   { text, parentMessageId: null }. A member's Real id is the same short code
   Swaps already keeps as hashId. Each member's chat is remembered, so the bot
   never opens a second one with the same person. */
const DM_ON = true;
const DM_DDL = `CREATE TABLE IF NOT EXISTS swap_dm (hashId TEXT PRIMARY KEY, userName TEXT, channelId INTEGER, openedAt INTEGER)`;

async function dmChannel(db, auth, hashId, userName, env) {
  await db.prepare(DM_DDL).run();
  const had = await db.prepare('SELECT channelId FROM swap_dm WHERE hashId=?').bind(hashId).first();
  if (had && had.channelId) return had.channelId;
  if (!env || !(await newChatAllowed(env))) throw new Error('no chat with this member yet and today\'s 5 new chats are used - ask them to message @raxacademy.app');
  const res = await fetch('https://web.realapp.com/messages/channels', {
    method: 'POST', headers: { ...rsHeaders(auth), 'content-type': 'application/json' },
    body: JSON.stringify({ users: [{ id: hashId, userName: userName || undefined }] }) });
  const text = await res.text();
  let d = null; try { d = JSON.parse(text); } catch (e) {}
  const ch = d && (d.channelId || (d.channel && d.channel.id));
  if (!res.ok || !ch) throw new Error(`open chat ${res.status}: ${text.slice(0, 160)}`);
  await db.prepare('INSERT OR REPLACE INTO swap_dm (hashId, userName, channelId, openedAt) VALUES (?, ?, ?, ?)')
    .bind(hashId, userName || null, Number(ch), Date.now()).run();
  return Number(ch);
}

/* ---- bot stats: a count per day (ET) per thing, and the last failures ---- */
const BOTSTAT_DDL = `CREATE TABLE IF NOT EXISTS bot_stats (day TEXT, k TEXT, n INTEGER, PRIMARY KEY (day, k))`;
const BOTLOG_DDL = `CREATE TABLE IF NOT EXISTS bot_log (at INTEGER, kind TEXT, msg TEXT)`;
let botReady = false;
async function botTables(db) { if (botReady) return; await db.prepare(BOTSTAT_DDL).run(); await db.prepare(BOTLOG_DDL).run(); botReady = true; }
async function stat(db, k, n = 1) {
  try { await botTables(db);
    await db.prepare('INSERT INTO bot_stats (day, k, n) VALUES (?, ?, ?) ON CONFLICT(day, k) DO UPDATE SET n = n + excluded.n').bind(etDay(), k, n).run(); } catch (e) {}
}
async function botFail(db, kind, msg) {
  try { await botTables(db); await stat(db, 'fail');
    await db.prepare('INSERT INTO bot_log (at, kind, msg) VALUES (?, ?, ?)').bind(Date.now(), kind, String(msg || '').slice(0, 300)).run();
    if (Math.random() < 0.05) await db.prepare('DELETE FROM bot_log WHERE at < ?').bind(Date.now() - 14 * 86400000).run(); } catch (e) {}
}

// A send that waits and tries again when Real is busy (429) or hiccups (5xx).
async function dmSendRetry(auth, channelId, text) {
  let last;
  for (const wait of [0, 2500, 6000]) {
    if (wait) await sleep(wait);
    try { return await dmSend(auth, channelId, text); } catch (e) { last = e; if (!/send (429|5\d\d)/.test(String(e.message || e))) throw e; }
  }
  throw last;
}
/* Parts that still wouldn't go: kept in order and sent again each minute
   (tick) until they do, for up to an hour. */
/* At :30 and :00 the bot has a lot to send (an hour can hold 180 swaps and
   50+ people). It sends up to 20 messages a minute, and pass scans stay off
   the bot from :25 to :40 and :55 to :10 so Real doesn't throttle it while
   the warnings and contacts go out. */
const DM_PER_TICK = 40;   // a cap per run; time is the real limit
const CANCEL_DM_ON = false;   // called-off notices (Dennis, 2026-11-04: too many extra DMs) - flip to bring them back   // Real's message slowmode: 10, then the rest of the minute off
const dmWindow = (t = new Date()) => { const m = t.getUTCMinutes(); return (m >= 25 && m < 40) || m >= 55 || m < 10; };
const DMQ_DDL = 'CREATE TABLE IF NOT EXISTS dm_retry (id INTEGER PRIMARY KEY AUTOINCREMENT, channelId INTEGER, parts TEXT, label TEXT, tries INTEGER, at INTEGER)';
async function queueDm(db, channelId, parts, label) {
  try { await db.prepare(DMQ_DDL).run();
    await db.prepare('INSERT INTO dm_retry (channelId, parts, label, tries, at) VALUES (?, ?, ?, 0, ?)').bind(Number(channelId), JSON.stringify(parts), String(label || '').slice(0, 120), Date.now()).run(); } catch (e) {}
}
/* Second look (Dennis, 2026-11-04): three minutes after a warning or contact
   message, the chat is read back and any part that didn't land is queued to
   go again. A few chats a minute, so it never floods Real. */
const DMV_DDL = 'CREATE TABLE IF NOT EXISTS dm_verify (id INTEGER PRIMARY KEY AUTOINCREMENT, channelId INTEGER, parts TEXT, label TEXT, checkAt INTEGER, tries INTEGER)';
async function queueVerify(db, channelId, parts, label) {
  try { await db.prepare(DMV_DDL).run();
    await db.prepare('INSERT INTO dm_verify (channelId, parts, label, checkAt, tries) VALUES (?, ?, ?, ?, 0)').bind(Number(channelId), JSON.stringify(parts), String(label || '').slice(0, 120), Date.now() + 3 * 60000).run(); } catch (e) {}
}
// Something in a message that's sure to be in Real's copy of it: its first link, else its opening words.
const dmFlat = t => String(t).replace(/[^A-Za-z0-9]+/g, ' ').trim();
const dmMark = t => { const u = String(t).match(/https?:\/\/[^\s)]+/); return u ? dmFlat(u[0]) : dmFlat(t).slice(0, 30); };
async function verifyDms(db, auth) {
  await db.prepare(DMV_DDL).run();
  const rows = ((await db.prepare('SELECT * FROM dm_verify WHERE checkAt <= ? ORDER BY checkAt LIMIT 4').bind(Date.now()).all()).results) || [];
  for (const r of rows) {
    // Every bit of text in the chat, flattened the same way as the marks.
    let blob = null;
    try { const d = await rsGetJson(`https://web.realapp.com/messages/channels/${r.channelId}/messages`, auth); const bits = [];
      const walk = o => { if (typeof o === 'string') bits.push(o); else if (o && typeof o === 'object') Object.values(o).forEach(walk); }; walk(d);
      blob = dmFlat(bits.join(' ')); } catch (e) {}
    if (blob == null) {
      if (Number(r.tries) >= 10) await db.prepare('DELETE FROM dm_verify WHERE id=?').bind(r.id).run();
      else await db.prepare('UPDATE dm_verify SET tries=tries+1, checkAt=? WHERE id=?').bind(Date.now() + 60000, r.id).run();
      continue;
    }
    const missing = parse(r.parts, []).filter(t => { const k = dmMark(t); return k && !blob.includes(k); });
    if (missing.length) { await queueDm(db, r.channelId, missing, `${r.label} (2nd look)`); await stat(db, 'dm_verify_resend', missing.length); }
    else await stat(db, 'dm_verify_ok');
    await db.prepare('DELETE FROM dm_verify WHERE id=?').bind(r.id).run();
    await sleep(400);
  }
}
async function retryDms(db, auth) {
  await db.prepare(DMQ_DDL).run();
  const rows = ((await db.prepare('SELECT * FROM dm_retry ORDER BY id LIMIT 20').all()).results) || [];
  const usedCh = new Set();
  for (const r of rows) {
    if (usedCh.has(Number(r.channelId))) continue;   // that chat already got a message this minute
    if (TICK_T0 && tickLeft() < 14000) break;   // leave the rest of the minute for the swaps' own DMs
    let parts = parse(r.parts, []);
    parts = parts.flatMap(fitDm);   // queued before the length fix: cut down to size
    usedCh.add(Number(r.channelId));
    try { await dmSendRetry(auth, r.channelId, parts[0]); parts.shift(); await stat(db, 'dm_retried'); await sleep(400); }
    catch (e) { if (Number(r.tries) % 5 === 0) await botFail(db, 'dm_retry', `${r.label} try ${r.tries}: ${String(e.message || e).slice(0, 120)}`); }
    if (!parts.length) await db.prepare('DELETE FROM dm_retry WHERE id=?').bind(r.id).run();
    else if (Number(r.tries) >= 60) { await db.prepare('DELETE FROM dm_retry WHERE id=?').bind(r.id).run(); await botFail(db, 'dm_retry', `${r.label}: gave up after an hour, ${parts.length} part(s) unsent`); }
    else await db.prepare('UPDATE dm_retry SET parts=?, tries=tries+1 WHERE id=?').bind(JSON.stringify(parts), r.id).run();
  }
}
/* One gap between every DM the bot sends (Dennis, 2026-11-05): sends that
   bunched up got "Message slowmode" and "Cannot message this channel right
   now" from Real. Each send takes the next free slot, DM_GAP_MS after the last. */
const DM_GAP_MS = 3000;   // 1 message every 3 seconds, everything combined (Dennis, 2026-11-05)
let dmNextAt = 0;
const dmWaitAhead = () => Math.max(0, dmNextAt - Date.now());
async function dmPace() { const t = Date.now(), at = Math.max(t, dmNextAt); dmNextAt = at + DM_GAP_MS; if (at > t) await sleep(at - t); }
async function dmSend(auth, channelId, text) {
  await dmPace();
  const res = await fetch(`https://web.realapp.com/messages/channels/${channelId}/messages`, {
    method: 'POST', headers: { ...rsHeaders(auth), 'content-type': 'application/json' },
    body: JSON.stringify({ text, parentMessageId: null }) });
  if (!res.ok) throw new Error(`send ${res.status}: ${(await res.text()).slice(0, 160)}`);
}

/* Real lets an account start only five new chats a day, so new chats are
   rationed and everything else goes through chats that already exist. A
   member who messages raxacademy.app first has a chat already, and the bot
   finds it by reading its chat list. */
const NEW_CHATS_PER_DAY = 5;
async function newChatAllowed(env) {
  const k = 'swapdm_newchats_v1', now = Date.now();
  let at = [];
  try { at = JSON.parse((await env.RATEBOARD_KV.get(k)) || '[]') || []; } catch (e) {}
  at = at.filter(t => now - t < 86400000);
  if (at.length >= NEW_CHATS_PER_DAY) return false;
  at.push(now);
  try { await env.RATEBOARD_KV.put(k, JSON.stringify(at)); } catch (e) {}
  return true;
}
async function newChatsLeft(env) {
  let at = [];
  try { at = JSON.parse((await env.RATEBOARD_KV.get('swapdm_newchats_v1')) || '[]') || []; } catch (e) {}
  return Math.max(0, NEW_CHATS_PER_DAY - at.filter(t => Date.now() - t < 86400000).length);
}

// Reads the bot's chat list and remembers which chat goes with which member.
// The shape of the list isn't pinned down, so it looks for any channel that
// has an id and a users list, wherever it sits.
async function syncChats(db, auth) {
  await db.prepare(DM_DDL).run();
  // The newest chats come first; if Real hands back a cursor, read a few more pages.
  const d = await rsGetJson('https://web.realapp.com/messages/channels', auth);
  const pages = [d];
  const cursorOf = o => o && typeof o === 'object' ? (o.nextCursor || o.cursor || o.next || o.nextPage || o.before || (o.meta && (o.meta.nextCursor || o.meta.cursor)) || null) : null;
  for (let i = 0, cur = cursorOf(d); i < 3 && cur && typeof cur !== 'object'; i++) {
    await sleep(700);
    try { const n = await rsGetJson(`https://web.realapp.com/messages/channels?cursor=${encodeURIComponent(cur)}&before=${encodeURIComponent(cur)}`, auth);
      pages.push(n); const nx = cursorOf(n); if (!nx || nx === cur) break; cur = nx; } catch (e) { break; }
  }
  const found = [];
  const walk = o => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { o.forEach(walk); return; }
    const users = o.users || o.members;
    if (o.id != null && Array.isArray(users) && (!o.type || o.type === 'dm')) {
      for (const u of users) {
        const uid = u && (u.userId || u.id);
        if (uid && uid !== BOT_ID) found.push([String(uid), u.userName || null, Number(o.id)]);
      }
    }
    for (const v of Object.values(o)) if (v && typeof v === 'object') walk(v);
  };
  pages.forEach(walk);
  for (const [hashId, userName, ch] of found) {
    await db.prepare(`INSERT INTO swap_dm (hashId, userName, channelId, openedAt) VALUES (?, ?, ?, ?)
      ON CONFLICT(hashId) DO UPDATE SET channelId=excluded.channelId, userName=COALESCE(excluded.userName, swap_dm.userName)`)
      .bind(hashId, userName, ch, Date.now()).run();
  }
  return found.length;
}
const BOT_ID = 'jvbj4p6v';   // raxacademy.app

/* ---- self-serve password reset --------------------------------------------
   Board usernames are Real usernames. Someone who forgot their password gets
   a short code, sends it in a DM to @raxacademy.app from their Real account,
   and once the bot sees that code come from that account the password is
   cleared - exactly what an admin reset does - so the next password they
   sign in with becomes theirs. Admin accounts can't be reset this way. */
const RESET_TTL = 15 * 60000;
async function resetFlow(env, db, url, request, op, waitUntil) {
  const name = String(url.searchParams.get('user') || '').trim().replace(/^@/, '');
  const key = name.toLowerCase();
  if (key.length < 2) return json({ error: 'Enter your username.' }, 400);
  const ip = clientIp(request);
  const kvKey = 'pwreset_v1_' + key;
  if (op === 'resetstart') {
    if (!(await allow(url.origin, 'pwreset-ip:' + ip, 10, 3600)) || !(await allow(url.origin, 'pwreset-user:' + key, 4, 3600)))
      return json({ error: 'Too many reset attempts. Try again in an hour.' }, 429);
    const u = await db.prepare('SELECT key, banned FROM users WHERE key=?').bind(key).first();
    if (!u) return json({ error: 'No board account with that username. New usernames just sign up.' }, 404);
    if (u.banned) return json({ error: 'This account has been removed from the board.' }, 403);
    if (ADMINS.includes(key)) return json({ error: 'This account can only be reset by hand.' }, 403);
    const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789', b = new Uint8Array(5); crypto.getRandomValues(b);
    const code = 'RB-' + [...b].map(x => A[x % A.length]).join('');
    await env.RATEBOARD_KV.put(kvKey, JSON.stringify({ code, at: Date.now(), name }), { expirationTtl: 1800 });
    return json({ code, bot: 'raxacademy.app', minutes: RESET_TTL / 60000 });
  }
  // resetcheck: has the bot received the code from this account?
  let c = null;
  try { c = JSON.parse((await env.RATEBOARD_KV.get(kvKey)) || 'null'); } catch (e) {}
  if (!c || Date.now() - c.at > RESET_TTL) return json({ error: 'That code has run out. Get a new one.' }, 410);
  if (!(await allow(url.origin, 'pwreset-check:' + key, 3, 60))) return json({ waiting: true });
  const auth = swapToken(env);
  if (!auth) return json({ error: 'The reset bot is not set up.' }, 503);
  const found = await findCodeInDms(auth, key, c.code);
  if (found.error) return json({ waiting: true, note: found.error });
  if (!found.ok) return json({ waiting: true });
  const res = await db.prepare("UPDATE users SET hash='' WHERE key=? AND COALESCE(banned, 0) = 0").bind(key).run();
  await stat(db, 'reset_ok');
  await env.RATEBOARD_KV.delete(kvKey);
  // A log for /admin.
  try {
    const log = JSON.parse((await env.RATEBOARD_KV.get('pwreset_log_v1')) || '[]') || [];
    log.unshift({ key, at: Date.now(), ip });
    await env.RATEBOARD_KV.put('pwreset_log_v1', JSON.stringify(log.slice(0, 200)));
  } catch (e) {}
  // Accept the request if it was one, then reply in the same chat.
  try {
    waitUntil((async () => {
      if (found.request) { try { await fetch(`https://web.realapp.com/messages/channels/${found.request}/acceptrequest`, { method: 'PUT', headers: { ...rsHeaders(auth), 'content-type': 'application/json' }, body: '{}' }); } catch (e) {} }
      if (found.channel) { try { await dmSend(auth, found.channel, 'Code confirmed; password reset available on https://raxacademy.app'); await stat(db, 'dm_reset'); } catch (e) { await botFail(db, 'dm_reset', e.message); } }
    })());
  } catch (e) {}
  return json({ ok: !!(res.meta && res.meta.changes), reset: true });
}
/* Looks through the bot's message requests and chats for one from this Real
   username that contains the code: first in whatever the lists carry, then
   in the recent messages of that person's chat. */
async function findCodeInDms(auth, userKey, code) {
  const hasCode = o => { try { return JSON.stringify(o).toUpperCase().includes(code); } catch (e) { return false; } };
  const fromUser = o => { try { return JSON.stringify(o).toLowerCase().includes('"username":"' + userKey + '"'); } catch (e) { return false; } };
  const chans = [];
  const collect = (d, isReq) => {
    const walk = o => {
      if (!o || typeof o !== 'object') return;
      if (Array.isArray(o)) { o.forEach(walk); return; }
      const ch = Number(o.channelId != null ? o.channelId : o.id);
      if (Number.isFinite(ch) && ch > 0 && (o.users || o.members || o.user || o.lastMessage || o.creatorUserId) && fromUser(o)) chans.push({ ch, o, isReq });
      else for (const v of Object.values(o)) if (v && typeof v === 'object') walk(v);
    };
    walk(d);
  };
  try { collect(await rsGetJson('https://web.realapp.com/messages/requests', auth), true); } catch (e) {}
  try { collect(await rsGetJson('https://web.realapp.com/messages/channels', auth), false); } catch (e) { if (!chans.length) return { error: 'Could not reach Real just now.' }; }
  const idOf = o => { try { const m = JSON.stringify(o).match(new RegExp('"(?:userId|id)":"([A-Za-z0-9]{6,12})"[^{}]*"userName":"' + userKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"', 'i')); return m ? m[1] : null; } catch (e) { return null; } };
  for (const c of chans) if (hasCode(c.o)) return { ok: true, request: c.isReq ? c.ch : null, channel: c.ch, hashId: idOf(c.o) };
  for (const c of chans.slice(0, 1)) {
    try {
      const m = await rsGetJson(`https://web.realapp.com/messages/channels/${c.ch}/messages`, auth);
      if (hasCode(m)) return { ok: true, request: c.isReq ? c.ch : null, channel: c.ch, hashId: idOf(c.o) };
    } catch (e) {}
  }
  return { ok: false, chats: chans.length };
}

/* A first message from someone new lands in the bot's DM requests
   (GET messages/requests). Requests from members who have scanned on Swaps
   are accepted - PUT messages/channels/<id>/acceptrequest with {} - which
   makes them an ordinary chat. Anyone else's request is left alone. */
function requestChats(d) {
  const out = [];
  const walk = o => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { o.forEach(walk); return; }
    const ch = Number(o.channelId != null ? o.channelId : o.id);
    const ids = [];
    for (const u of (o.users || o.members || [])) { const id = u && (u.userId || u.id); if (id) ids.push([String(id), u.userName || null]); }
    if (o.creatorUserId) ids.push([String(o.creatorUserId), null]);
    if (o.user && o.user.id) ids.push([String(o.user.id), o.user.userName || null]);
    if (Number.isFinite(ch) && ch > 0 && ids.length) {
      for (const [id, name] of ids) if (id !== BOT_ID) out.push({ channelId: ch, hashId: id, userName: name });
    }
    for (const v of Object.values(o)) if (v && typeof v === 'object') walk(v);
  };
  walk(d);
  return out;
}
async function acceptRequests(db, auth) {
  await db.prepare(DM_DDL).run();
  const d = await rsGetJson('https://web.realapp.com/messages/requests', auth);
  const reqs = requestChats(d);
  if (!reqs.length) return { requests: 0, accepted: [] };
  const members = new Set(((await db.prepare('SELECT hashId FROM swap_users WHERE hashId IS NOT NULL').all()).results || []).map(r => r.hashId));
  const accepted = [], seen = new Set();
  for (const r of reqs) {
    if (!members.has(r.hashId) || seen.has(r.channelId)) continue;
    seen.add(r.channelId);
    const res = await fetch(`https://web.realapp.com/messages/channels/${r.channelId}/acceptrequest`, {
      method: 'PUT', headers: { ...rsHeaders(auth), 'content-type': 'application/json' }, body: '{}' });
    if (!res.ok) continue;
    await db.prepare(`INSERT INTO swap_dm (hashId, userName, channelId, openedAt) VALUES (?, ?, ?, ?)
      ON CONFLICT(hashId) DO UPDATE SET channelId=excluded.channelId`).bind(r.hashId, r.userName, r.channelId, Date.now()).run();
    accepted.push(r.userName || r.hashId);
    await sleep(800);
  }
  return { requests: new Set(reqs.map(r => r.channelId)).size, accepted };
}

/* Real's own link codes (hashids, salt 'routing', min length 11): a player is
   [2, sport code, 0, id], a pass is [18, 0, 0, passId]. */
function routeId(numbers) {
  const ALPHA0 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890', SEPS0 = 'cfhistuCFHISTU';
  const salt = Array.from('routing'), minLength = 11;
  const shuffle = (alpha, sl) => { if (!sl.length) return alpha; const t = alpha.slice();
    for (let i = t.length - 1, v = 0, p = 0; i > 0; i--, v++) { v %= sl.length; const n = sl[v].codePointAt(0); p += n; const j = (n + v + p) % i; [t[i], t[j]] = [t[j], t[i]]; } return t; };
  const toAlpha = (n, alpha) => { const id = []; let v = n; do { id.unshift(alpha[v % alpha.length]); v = Math.floor(v / alpha.length); } while (v > 0); return id; };
  let alpha = [...new Set(Array.from(ALPHA0))], seps = Array.from(SEPS0).filter(c => alpha.includes(c));
  alpha = alpha.filter(c => !seps.includes(c)); seps = shuffle(seps, salt);
  if (!seps.length || alpha.length / seps.length > 3.5) { let sl = Math.ceil(alpha.length / 3.5); if (sl === 1) sl = 2;
    if (sl > seps.length) { const d = sl - seps.length; seps = seps.concat(alpha.slice(0, d)); alpha = alpha.slice(d); } else seps = seps.slice(0, sl); }
  alpha = shuffle(alpha, salt);
  const gc = Math.ceil(alpha.length / 12); let guards;
  if (alpha.length < 3) { guards = seps.slice(0, gc); seps = seps.slice(gc); } else { guards = alpha.slice(0, gc); alpha = alpha.slice(gc); }
  let hashInt = 0; for (let i = 0; i < numbers.length; i++) hashInt += numbers[i] % (i + 100);
  const lottery = alpha[hashInt % alpha.length]; let ret = [lottery];
  for (let i = 0; i < numbers.length; i++) { let num = numbers[i];
    alpha = shuffle(alpha, [lottery].concat(salt, alpha).slice(0, alpha.length));
    const last = toAlpha(num, alpha); ret = ret.concat(last);
    if (i + 1 < numbers.length) { num %= (last[0].codePointAt(0) + i); ret.push(seps[num % seps.length]); } }
  if (ret.length < minLength) { let gi = (hashInt + ret[0].codePointAt(0)) % guards.length; ret.unshift(guards[gi]);
    if (ret.length < minLength) { gi = (hashInt + ret[2].codePointAt(0)) % guards.length; ret.push(guards[gi]); } }
  const half = Math.floor(alpha.length / 2);
  while (ret.length < minLength) { alpha = shuffle(alpha, alpha); ret = alpha.slice(half).concat(ret, alpha.slice(0, half));
    const ex = ret.length - minLength; if (ex > 0) ret = ret.slice(ex / 2, ex / 2 + minLength); }
  return ret.join('');
}
const REAL_SPORT = { nba: [2, 1], nfl: [2, 2], ncaam: [2, 3], mlb: [2, 4], nhl: [2, 7], ufc: [3, 10], ncaaf: [2, 11], wnba: [2, 12], soccer: [2, 14], golf: [2, 15] };
function playerUrl(key) {
  const [sp, se, id] = String(key).split(':'); const k = REAL_SPORT[sp]; const n = Number(id);
  return k && Number.isFinite(n) && n > 0 ? `https://www.realapp.com/${routeId([k[0], k[1], 0, n])}/${se}` : null;
}
function passUrl(owner, key) {
  const p = (owner.passes || []).find(x => x.key === key);
  return p && p.passId ? `https://www.realapp.com/${routeId([18, 0, 0, Number(p.passId)])}` : null;
}
function playerName(owner, key) {
  const p = (owner.passes || []).find(x => x.key === key);
  const [, se, id] = String(key).split(':');
  return `${p && p.name && !/^player$/i.test(p.name) ? p.name : 'Player ' + id} ${se}`;
}

const SPORT_NAME = { nba: 'NBA', ncaam: 'CBB', nfl: 'NFL', ncaaf: 'CFB', nhl: 'NHL', mlb: 'MLB', wnba: 'WNBA', golf: 'Golf' };
function passLabel(owner, key) {
  const p = (owner.passes || []).find(x => x.key === key);
  const [sp, se] = String(key).split(':');
  const name = p && p.name ? p.name : 'a pass';
  const tag = p && p.levelLabel ? ` (${p.levelLabel})` : '';
  return `${name}${tag} · ${SPORT_NAME[sp] || sp} ${se}`;
}
function slotEt(h) {
  const d = new Date(Date.UTC(2026, 0, 1, Number(h) || 0));
  try { return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric' }).format(d) + ' ET'; }
  catch (e) { return `${h}:00 UTC`; }
}
function matchText(me, other, gets, gives, slot) {
  return `🔁 Rate Board swap match\n\n`
    + `You give: ${passLabel(me, gives)}\n`
    + `You get: ${passLabel(other, gets)}\n`
    + `Your partner: @${other.rsUser}\n`
    + `Your shared time: ${slotEt(slot)}\n\n`
    + `Message @${other.rsUser} to set it up. Manage your swaps at raxacademy.app/swaps`;
}

/* Swap DMs on a swap day: for each of their swap hours (up to 3) a warn 30
   min before it and a contact at it, then one follow-up after the last.
   1. warn    - 30 min before each swap hour: that hour's packs
                (each line: player link, season - their own pass to buy it on).
   2-4. contact - at each of their swap hours (up to 3): each partner's @,
                comment link and player.
   5. follow  - 90 min after their last swap hour: the reminder.
   Matching runs once a day, so a member's whole day is known before the warn.
   Each side of a match is marked as each DM goes, so nothing repeats. */
const FOLLOW_TEXT = "(This is automatic dm 90 mins after final swap for everyone)\nPlease make sure you bought all packs and offered 12 hours on everyone else's, there are no warnings if you scam or don't communicate, you will be banned.";
// Long lists are split: the heading on its own, then at most 8 lines a message.
const LINES_PER_DM = 6;   // 6 players a message (Dennis, 2026-11-04), easier on Real's slowmode
/* Up to 8 lines a message, and never more than DM_MAX_CHARS: Real refuses a
   long message ("Message is too long"), and 8 warning lines with three links
   each went over, so everything after the heading was being dropped. */
const DM_MAX_CHARS = 750;   // 750 a message (Dennis, 2026-11-05; Real refused some 900s as too long)
const chunks = (lines, n = LINES_PER_DM) => { const out = []; let cur = [];
  for (const l of lines) { if (cur.length && (cur.length >= n || [...cur, l].join('\n').length > DM_MAX_CHARS)) { out.push(cur.join('\n')); cur = []; } cur.push(l); }
  if (cur.length) out.push(cur.join('\n')); return out; };
// A message that's still too long, cut at line breaks into pieces Real will take.
const fitDm = t => String(t).length <= DM_MAX_CHARS ? [t] : chunks(String(t).split('\n'), DM_MAX_CHARS);
// One message no matter what: the summary line is cut short rather than splitting.
const fitOne = t => { t = String(t); if (t.length <= DM_MAX_CHARS) return t; const cut = t.lastIndexOf('\n\nYou are receiving:'); return cut > 0 ? (t.slice(0, DM_MAX_CHARS - 4) + '...') : t.slice(0, DM_MAX_CHARS); };
// Warn: heading plus the first 5 swaps in one message, then up to 8 a message.
/* Warning, grouped by the player they receive (Dennis, 2026-11-04): the
   heading, then one message per player received - his link on top, the packs
   to buy for him under it - so "you are receiving" isn't on every line. Big
   groups run on into more messages, each kept under Real's length limit. */
/* Fewer messages (Dennis, 2026-11-04): the heading and the groups are packed
   together - up to 6 swap lines a message and under Real's length limit - with
   "You are receiving X:" starting each group inside the message, instead of a
   message per group. */
function packDm(head, groups) {
  const out = []; let cur = head ? [head] : [], n = 0;
  const flush = () => { if (cur.length) out.push(cur.join('\n')); cur = []; n = 0; };
  for (const g of groups) {
    let first = true;
    for (const l of g.lines) {
      const hdr = first ? `You are receiving ${g.recv}:` : null;
      const add = (n === 0 && !first ? [`${g.recv} (cont.):`] : []).concat(hdr ? [hdr] : [], [l]);
      if (n >= LINES_PER_DM || [...cur, ...add].join('\n').length > DM_MAX_CHARS) { flush(); if (!first) add.unshift(`${g.recv} (cont.):`); }
      cur.push(...(n === 0 && !first && cur.length === 0 ? add : add)); n++; first = false;
    }
  }
  flush();
  return out.map(x => x.replace(/^(.*\(cont\.\):)\n\1/, '$1'));
}
function groupsOf(items, field) {
  const groups = new Map();
  for (const it of items) (groups.get(it.recvKey) || groups.set(it.recvKey, { recv: it.recv, lines: [] }).get(it.recvKey)).lines.push(it[field]);
  return [...groups.values()];
}
function warnGrouped(items) {
  const head = "Heads up - you swap in 30 min. Buy these packs now:";
  const groups = new Map();
  for (const it of items) (groups.get(it.recvKey) || groups.set(it.recvKey, { recv: it.recv, lines: [] }).get(it.recvKey)).lines.push(it.buy);
  // Always labelled with the player received, even when it's just one (Dennis, 2026-11-04).
  return packDm(head, [...groups.values()]);
}
/* Contact message, the same way: heading, then per player they receive his
   link on top and the partners to contact under it (6 a message). */
function contactGrouped(items, buyItems) {
  const head = "Swap time - send 12 hour offers. Comments are only to reach someone who didn't buy; report anyone doing it wrong.";
  const groups = new Map();
  for (const it of items) (groups.get(it.recvKey) || groups.set(it.recvKey, { recv: it.recv, lines: [] }).get(it.recvKey)).lines.push(it.contact);
  const out = packDm(head, [...groups.values()]);
  if (buyItems.length) out.push(...packDm('Also buy these packs now:', groupsOf(buyItems, 'buy')));
  return out;
}
function warnText(lines) {
  const head = "You are swapping the following players today, please buy the following packs within 30 mins. This is a heads up DM - the users you're swapping with in 30 mins:";
  let k = Math.min(5, lines.length);
  while (k > 1 && (head + '\n\n' + lines.slice(0, k).join('\n')).length > DM_MAX_CHARS + 100) k--;
  return [head + '\n\n' + lines.slice(0, k).join('\n'), ...chunks(lines.slice(k))];
}
function contactText(lines, buy) {
  return ["Here are comments to contact the following swaps, please send 12 hour offers and report anyone who's doing anything wrong.\n"
    + "Comments are to get ahold of other users if they didn't buy the pack in the warning period, ideally this should be communication-less.",
    ...chunks(lines), ...(buy && buy.length ? chunks(buy).map((c, i) => (i ? '' : 'Also buy these packs now:\n') + c) : [])];
}
async function loadMember(db, k) {
  const u = await db.prepare('SELECT key, rsUser, hashId, passes, comment, wants FROM swap_users WHERE key=?').bind(k).first();
  return u ? { ...u, passes: parse(u.passes, []), wants: parse(u.wants, []) } : null;
}
// The line for one side of a match. What they buy is the player their
// PARTNER asked for, on their own pass of that player.
async function sideLines(member, m, side) {
  const o = await member(side === 'A' ? m.b : m.a), me = await member(side === 'A' ? m.a : m.b);
  if (!o || !me) return null;
  const gets = side === 'A' ? m.bGets : m.aGets;
  return {
    // What to buy; the player they receive goes at the top of its own message instead of on every line.
    buy: `${playerUrl(gets) || playerName(me, gets)} ${String(gets).split(':')[1]} - ${passUrl(me, gets) || '(pass link not found)'}`,
    recvKey: side === 'A' ? m.aGets : m.bGets,
    recv: (() => { const k = side === 'A' ? m.aGets : m.bGets; return `${playerUrl(k) || playerName(me, k)} ${String(k).split(':')[1]}`; })(),
    // @partner - their comment | the player you give (with season) / your card of him (Dennis, 2026-11-04).
    contact: `@${o.rsUser} - ${o.comment || '(no comment link)'} | ${playerUrl(gets) || playerName(me, gets)} ${String(gets).split(':')[1]} / ${passUrl(me, gets) || '(card link not found)'}`
  };
}
async function matchCols(db) {
  for (const c of ['warnA', 'warnB', 'doneA', 'doneB', 'followA', 'followB', 'dueAt']) { try { await alterOnce(db, `ALTER TABLE swap_matches ADD COLUMN ${c} INTEGER`); } catch (e) {} }
  try { await alterOnce(db, 'ALTER TABLE swap_users ADD COLUMN comment TEXT'); } catch (e) {}
  // Untouchable passes the member chose to swap anyway (step 3).
  try { await alterOnce(db, 'ALTER TABLE swap_users ADD COLUMN touch TEXT'); } catch (e) {}
  // Packs today: passes the member marked as used this swap day ({ day, keys }).
  try { await alterOnce(db, 'ALTER TABLE swap_users ADD COLUMN packsUsed TEXT'); } catch (e) {}
  try { await alterOnce(db, 'ALTER TABLE swap_users ADD COLUMN goal REAL'); } catch (e) {}
  try { await alterOnce(db, 'ALTER TABLE swap_users ADD COLUMN autoAt INTEGER'); } catch (e) {}
  // Scale: dayCap = most swaps a swap day (all players); caps = { passKey: { n, at } }, most swaps for that player overall, counted from when it was set.
  try { await alterOnce(db, 'ALTER TABLE swap_users ADD COLUMN dayCap INTEGER'); } catch (e) {}
  try { await alterOnce(db, 'ALTER TABLE swap_users ADD COLUMN caps TEXT'); } catch (e) {}
  try { await alterOnce(db, 'ALTER TABLE swap_users ADD COLUMN sched TEXT'); } catch (e) {}   // weekly / one-day schedules
  // Called-off swaps: when Dennis marked each side refunded (rax back) by hand.
  for (const c of ['refundA', 'refundB']) { try { await alterOnce(db, `ALTER TABLE swap_matches ADD COLUMN ${c} INTEGER`); } catch (e) {} }
}
// Swaps a member has had for one player since a moment (made, not called off).
async function usedFor(db, key, want, since) {
  const r = await db.prepare(`SELECT COUNT(*) AS n FROM swap_matches WHERE createdAt > ? AND status IN ('pending','sending','warned','sent')
    AND ((a=? AND aGets=?) OR (b=? AND bGets=?))`).bind(Number(since) || 0, key, want, key, want).first();
  return Number(r && r.n) || 0;
}
// When a match's swap hour comes: the next time that UTC hour starts, an
// hour or more after it was made.
function dueFor(slot, from) {
  const d = new Date(from); d.setUTCMinutes(0, 0, 0); d.setUTCHours(d.getUTCHours() + 1);   // the next top of the hour
  while (d.getUTCHours() !== Number(slot)) d.setUTCHours(d.getUTCHours() + 1);
  return d.getTime();
}
// The swap day a moment belongs to: it starts at 7am ET.
const swapDay = ms => etDay(ms - 7 * 3600000);
const sideDue = m => Number(m.dueAt) || dueFor(m.slot, Number(m.createdAt) || Date.now());

/* Runs every minute. Groups the open matches by member and sends whatever
   is due, about 9 DMs a minute in all. */
async function runDms(env, db, auth, rows, max, force) {
  const now = Date.now(), notes = [];
  // Drop any swap where a giver now keeps the pass they'd give.
  const keeps = new Map();
  for (const k of new Set(rows.flatMap(m => [m.a, m.b]))) {
    try { const r = await db.prepare('SELECT keep FROM swap_users WHERE key=?').bind(k).first(); keeps.set(k, new Set(parse(r && r.keep, []))); } catch (e) { keeps.set(k, new Set()); }
  }
  const live = [];
  for (const m of rows) {
    if (m.aGets === m.bGets) {         // the exact same pass both ways
      await db.prepare(`UPDATE swap_matches SET status='cancelled', note='cancelled: same pass both ways' WHERE id=?`).bind(m.id).run();
      notes.push(`match ${m.id} cancelled (same pass)`); continue;
    }
    const keptNow = (keeps.get(m.a) || new Set()).has(m.bGets) || (keeps.get(m.b) || new Set()).has(m.aGets);
    if (m.status === 'cancelling' || (keptNow && !lateStage(m))) {   // a late keep doesn't undo a warned swap
      /* Whoever called it off (removed the player or hour, paused/ended, or
         now keeps the pass) gets no notice and no refund offer - it was their
         doing. Only their partner, if already told to buy, hears it's off. */
      const byNote = (String(m.note || '').match(/called off: @(\S+)/) || [])[1];
      const byKeep = (keeps.get(m.a) || new Set()).has(m.bGets) ? m.a : (keeps.get(m.b) || new Set()).has(m.aGets) ? m.b : null;
      const canceller = String(byNote || byKeep || '').toLowerCase();
      for (const side of ['A', 'B']) {
        if (canceller && String(side === 'A' ? m.a : m.b).toLowerCase() === canceller) { try { await db.prepare(`UPDATE swap_matches SET ${'follow' + side}=COALESCE(${'follow' + side}, ?) WHERE id=?`).bind(now, m.id).run(); } catch (e) {} continue; }
        // Only a swap they've actually been warned about: its warning went out and its hour is
        // under 35 minutes away (or here). One scheduled hours ahead gets no message at all.
        // Only in the half hour between its warning and its swap (:30 to :00), and only if warned.
        if (!CANCEL_DM_ON) continue;          // called-off notices are off: only the DMs for what they matched for
        if (!m['warn' + side]) continue;
        { const left = sideDue(m) - now; if (!(left > 0 && left <= 36 * 60000)) continue; }
        const r = await db.prepare(`UPDATE swap_matches SET ${'follow' + side}=? WHERE id=? AND ${'follow' + side} IS NULL`).bind(now, m.id).run();
        if (!(r && r.meta && r.meta.changes)) continue;
        const who = side === 'A' ? m.a : m.b, other = side === 'A' ? m.b : m.a, gets = side === 'A' ? m.bGets : m.aGets;
        try {
          const u = await loadMember(db, who), o = await loadMember(db, other);
          if (u && u.hashId) { const ch = await dmChannel(db, auth, u.hashId, u.rsUser, env);
            await dmSend(auth, ch, `Your swap with @${(o && o.rsUser) || other} for ${playerName(u, gets)} is called off - a pass in it isn't being swapped anymore. Don't buy that pack; if you already did, the cards stay yours.\n\nTo receive rax back for the pack or a replacement swap, go to REPORT on https://raxacademy.app/swaps and report the swap you want rax back for.`);
            await stat(db, 'dm_cancel'); }
        } catch (e) { await botFail(db, 'dm_cancel', `${who}: ${e.message || e}`); }
      }
      await db.prepare(`UPDATE swap_matches SET status='cancelled', note=COALESCE(note, 'called off: a pass in it is kept now') WHERE id=?`).bind(m.id).run();
      notes.push(`match ${m.id} cancelled (kept pass)`); await stat(db, 'cancel_kept');
    } else live.push(m);
  }
  rows = live;
  const cache = new Map(), member = async k => cache.has(k) ? cache.get(k) : (cache.set(k, await loadMember(db, k)), cache.get(k));
  const per = new Map();
  // One group per member per swap day (7am to 7am ET): that's the 5-DM day.
  for (const m of rows) for (const side of ['A', 'B']) {
    const who = side === 'A' ? m.a : m.b, due = force ? now : sideDue(m), g = who + '|' + swapDay(due);
    (per.get(g) || per.set(g, []).get(g)).push({ m, side, due, who });
  }
  let sent = 0;
  const mark = async (list, col) => { for (const { m, side } of list) { await db.prepare(`UPDATE swap_matches SET ${col + side}=? WHERE id=?`).bind(now, m.id).run(); m[col + side] = now; } };
  /* Claim before sending: only the run that sets the column first sends the DM,
     so two overlapping runs can never both send it. A failed send gives it back. */
  const claim = async (list, col) => {
    const got = [];
    for (const x of list) {
      const r = await db.prepare(`UPDATE swap_matches SET ${col + x.side}=? WHERE id=? AND ${col + x.side} IS NULL`).bind(now, x.m.id).run();
      if (r && r.meta && r.meta.changes) { x.m[col + x.side] = now; got.push(x); }
    }
    return got;
  };
  const unclaim = async (list, col) => { for (const x of list) { await db.prepare(`UPDATE swap_matches SET ${col + x.side}=NULL WHERE id=? AND ${col + x.side}=?`).bind(x.m.id, now).run(); x.m[col + x.side] = null; } };
  const send = async (who, text, kind) => {
    const me = await member(who);
    if (!me || !me.hashId) { notes.push(`${who}: never verified`); await botFail(db, kind, `${who}: never verified`); return false; }
    try {
      const ch = await dmChannel(db, auth, me.hashId, me.rsUser, env);
      const msgs = Array.isArray(text) ? text : [text];
      /* Each part is tried a few times on the spot; a part after the heading
         that still won't go is queued and sent again every minute until it
         does (a busy Real was dropping the player lines after the heading). */
      /* Parts 4.5s apart (2026-11-05: at 1.5s Real took a second part but it
         never showed in the chat - a member got 3 of his 6 contacts). A part
         that still won't go is queued and tried again each minute. */
      for (let i = 0; i < msgs.length; i++) {
        // Out of time this minute: the rest go first thing next minute.
        if (i && TICK_T0 && !force && tickLeft() < 5000) { await queueDm(db, ch, msgs.slice(i), `${kind} @${me.rsUser}`); await stat(db, 'dm_parts_deferred', msgs.length - i); break; }
        if (i) await sleep(4500);
        try { await dmSendRetry(auth, ch, msgs[i]); }
        catch (e) { if (i === 0) throw e; await queueDm(db, ch, msgs.slice(i), `${kind} @${me.rsUser}`); await botFail(db, 'dm_' + kind, `@${me.rsUser} part ${i + 1}/${msgs.length} queued for retry: ${e.message || e}`); break; }
        sent++; await stat(db, 'dm_' + kind);
      }
      // A second look in a few minutes: read the chat back and re-send any part that isn't there.
      // (The read-back second look is off: Real stores links differently from what was sent, so it re-sent messages that had landed.)
      notes.push(`${kind} sent to @${me.rsUser} (${msgs.length} message${msgs.length === 1 ? '' : 's'})`); return true;
    }
    catch (e) { notes.push(`${kind} to @${me.rsUser} failed: ${String(e.message || e).slice(0, 160)}`); await botFail(db, 'dm_' + kind, `@${me.rsUser}: ${e.message || e}`);
      if (/send 403/.test(String(e.message || e))) NO_MSG.set(who, Date.now() + 4 * 60000);   // try them again in a few minutes, not every tick
      return false; }
  };
  // Soonest (or most overdue) first, so a busy hour can't leave earlier ones waiting.
  const order = [...per.values()].sort((x, y) => Math.min(...x.map(z => z.due)) - Math.min(...y.map(z => z.due)));
  /* Members are worked two at a time; every send waits its turn in dmPace,
     DM_GAP_MS apart, so Real never gets a burst. */
  const doList = async list => {
    if (sent >= max || Date.now() - now > 40000 || (TICK_T0 && !force && tickLeft() - dmWaitAhead() < 6000)) return;   // never past the tick's time
    const who = list[0].who;
    if (!force && (NO_MSG.get(who) || 0) > Date.now()) return;   // Real refused them a minute ago: not every tick
    const first = Math.min(...list.map(x => x.due)), last = Math.max(...list.map(x => x.due));
    // 1. warn: every pack for the day, once.
    // 1. warn: 30 min before each swap hour, that hour's packs only.
    const warnHours = new Map();
    // From :25 (35 minutes before the hour).
    // Past :55 the contact message carries it instead.
    for (const x of list) if (!x.m['warn' + x.side] && (force || (now >= x.due - 35 * 60000 && now < x.due - 5 * 60000))) { const k = force ? 'now' : x.due; (warnHours.get(k) || warnHours.set(k, []).get(k)).push(x); }
    let warnFail = false;
    for (const [, wh0] of warnHours) {
      if (sent >= max || Date.now() - now > 40000 || (TICK_T0 && !force && tickLeft() - dmWaitAhead() < 6000)) break;   // never past the tick's time
      const wh = await claim(wh0, 'warn');
      if (!wh.length) continue;
      const items = []; for (const x of wh) { const l = await sideLines(member, x.m, x.side); if (l) items.push(l); }
      let wmsg = warnGrouped(items);
      { const me0 = await member(who);   // always the site message now (Dennis, 2026-11-05), whatever the size
        wmsg = [siteDm('Heads up - you swap in 30 min. Buy your packs now.', items.length, await hourLink(env, who, wh[0].due), recvSummary(me0, items))]; }
      if (!(items.length && await send(who, wmsg, 'warn'))) { await unclaim(wh, 'warn'); warnFail = true; }
    }
    if (warnFail) return;
    // 2-4. contact: one per swap hour that has come.
    const byHour = new Map();
    // From :55 (5 minutes before the hour).
    for (const x of list) if (!x.m['done' + x.side] && now >= x.due - 5 * 60000) { const k = force ? 'now' : x.due; (byHour.get(k) || byHour.set(k, []).get(k)).push(x); }
    for (const [, hr0] of byHour) {
      if (sent >= max || Date.now() - now > 40000 || (TICK_T0 && !force && tickLeft() - dmWaitAhead() < 6000)) break;   // never past the tick's time
      const noWarn = hr0.filter(x => !x.m['warn' + x.side]);
      const hr = await claim(hr0, 'done');
      if (!hr.length) continue;
      const items = [], buy = [];
      for (const x of hr) { const l = await sideLines(member, x.m, x.side); if (!l) continue; items.push(l); if (noWarn.includes(x)) buy.push(l); }
      let cmsg = contactGrouped(items, buy);
      { const me0 = await member(who);   // always the site message now
        cmsg = [siteDm('', items.length, await hourLink(env, who, hr[0].due, 'offer'), recvSummary(me0, items), buy.length ? `You weren't warned earlier: buy the ${buy.length} pack${buy.length === 1 ? '' : 's'} on the site first.` : '')]; }
      if (items.length && await send(who, cmsg, 'contact')) await mark(hr.filter(x => noWarn.includes(x)), 'warn');
      else await unclaim(hr, 'done');
    }
    // 5. follow-up, 90 min after their last swap hour, once every contact is out.
    if (sent < max && list.every(x => x.m['done' + x.side]) && list.some(x => !x.m['follow' + x.side]) && (force || now >= last + 90 * 60000)) {
      // The follow-up DM is off (Dennis, 2026-11-04): the swaps are just marked finished, nothing is sent.
      await claim(list.filter(x => !x.m['follow' + x.side]), 'follow');
    }
  };
  let qi = 0;
  // Two at a time: sends are spaced by dmPace anyway, this just overlaps the lookups.
  await Promise.all([0, 1].map(async () => { while (qi < order.length) { const l = order[qi++]; try { await doList(l); } catch (e) { notes.push('list failed: ' + String(e.message || e).slice(0, 80)); } } }));
  // Status: sent once both sides have had the follow-up.
  for (const m of rows) {
    const st = m.followA && m.followB ? 'sent' : (m.warnA || m.warnB || m.doneA || m.doneB) ? 'warned' : m.status;
    if (st !== m.status) { await db.prepare('UPDATE swap_matches SET status=?, sentAt=? WHERE id=?').bind(st, st === 'sent' ? now : null, m.id).run(); m.status = st; }
  }
  return notes;
}
/* A swap that would have someone give a pass they've since ticked as keep is
   called off before any more DMs go. Returns how many were cancelled. */
/* Calling off a swap at a member's request (Dennis, 2026-11-04):
     - once its warning stage has begun (from :25, or anyone already warned),
       it is too late: the swap stands and the member is told so;
     - otherwise it's called off; if that happens between :20 and :25 (the
       hour was matched at :20 but nobody warned yet) the matching runs again
       straight away so partners get a new swap for the hour. */
// Off (Dennis, 2026-11-04): during the warning period a member only gets the DMs for what they matched for.
const LATE_DM_ON = false;
const LATE_TEXT = 'Sorry you requested a late change/removal, please do the swaps at :00';
const lateStage = m => !!(m.warnA || m.warnB || m.doneA || m.doneB) || sideDue(m) - Date.now() <= 35 * 60000;
async function callOff(db, m, note, res) {
  if (sideDue(m) <= Date.now()) return;                      // its hour has come: leave it
  if (lateStage(m)) { res.late++; res.lateHours = (res.lateHours || new Set()).add(sideDue(m)); return; }
  await db.prepare(`UPDATE swap_matches SET status='cancelling', note=? WHERE id=?`).bind(note, m.id).run(); res.n++;
  if (sideDue(m) - Date.now() <= 40 * 60000) res.soon++;
}
async function afterCallOff(env, db, auth, who, res) {
  /* Once per member per swap hour, however many times they tap or save
     (it was going out on every keep tick - a member got dozens). */
  let fresh = false;
  if (res.late) {
    try { await db.prepare('CREATE TABLE IF NOT EXISTS bot_once (campaign TEXT, key TEXT, at INTEGER, ok INTEGER, PRIMARY KEY (campaign, key))').run();
      for (const h of (res.lateHours || [])) { const c = await db.prepare('INSERT OR IGNORE INTO bot_once (campaign, key, at, ok) VALUES (?, ?, ?, 1)').bind('late_' + h, String(who).toLowerCase(), Date.now()).run();
        if (c && c.meta && c.meta.changes) fresh = true; } } catch (e) { fresh = false; }
  }
  if (res.late && fresh && LATE_DM_ON) {
    try { const u = await loadMember(db, who); if (u && u.hashId && auth) { const ch = await dmChannel(db, auth, u.hashId, u.rsUser, env); await dmSendRetry(auth, ch, LATE_TEXT); await stat(db, 'dm_late'); } }
    catch (e) { await botFail(db, 'dm_late', `${who}: ${e.message || e}`); }
  }
  const mi = new Date().getUTCMinutes();
  if (res.soon && mi >= 20 && mi < 25) { try { await matchCols(db); await runMatching(db, env); await stat(db, 'match_refresh'); } catch (e) { await botFail(db, 'matching', 'refresh: ' + e.message); } }
  return res;
}
async function cancelKept(db, who, keep) {
  try { await matchCols(db); } catch (e) {}
  const rows = ((await db.prepare(`SELECT * FROM swap_matches WHERE status IN ('pending','warned') AND (a=? OR b=?)`).bind(who, who).all()).results) || [];
  const res = { n: 0, late: 0, soon: 0 };
  for (const m of rows) {
    const gives = m.a === who ? m.bGets : m.aGets;      // A gives what B asked for, and the other way round
    if (keep.has(gives)) await callOff(db, m, `called off: @${who} keeps that pass`, res);
  }
  return res;
}
/* A swap still to come for a player they no longer pick, or at an hour they
   no longer pick, is called off when they save: both sides are told (if
   they'd been warned) by the next DM run, the same as a kept pass. */
async function cancelDropped(db, who, wants, slots, sched) {
  const me = { slots: [...slots], sched: sched || null };
  try { await matchCols(db); } catch (e) {}
  const rows = ((await db.prepare(`SELECT * FROM swap_matches WHERE status IN ('pending','warned') AND (a=? OR b=?)`).bind(who, who).all()).results) || [];
  const res = { n: 0, late: 0, soon: 0 };
  for (const m of rows) {
    const gets = m.a === who ? m.aGets : m.bGets;
    const why = !wants.has(gets) ? 'no longer swapping for that player' : rankAt(me, sideDue(m)) < 0 ? 'no longer picks that hour' : null;
    if (why) await callOff(db, m, `called off: @${who} ${why}`, res);
  }
  return res;
}
// Admin "Send now": every DM for one match straight away (warn, contact, follow-up).
async function sendMatch(env, db, auth, m) {
  return (await runDms(env, db, auth, [m], 6, true)).join('; ');
}

/* Called once a minute from the collector tick. Matching runs every hour at
   :30, so a swap hour starting at the next :00 still gets its 30-minute warn;
   DMs go out as they come due; one swapper is re-scanned a minute. */
/* A full refresh (every Swaps season, golf back to 2014) for anyone queued
   with fullPart set: 14 seasons a minute, so about 3 minutes a person. */
const FULL_LIST = Object.entries(SWAPS_SCAN).flatMap(([sp, v]) => v.map(se => [sp, se]));
const FULL_CHUNK = 14;
async function fullRescan(env, db, auth) {
  let u = null;
  try { u = await db.prepare('SELECT key, hashId, passes, fullPart FROM swap_users WHERE fullPart IS NOT NULL AND hashId IS NOT NULL ORDER BY fullPart DESC, key LIMIT 1').first(); } catch (e) { return null; }
  if (!u) return null;
  const part = Number(u.fullPart) || 0, chunk = FULL_LIST.slice(part * FULL_CHUNK, part * FULL_CHUNK + FULL_CHUNK);
  const done = (part + 1) * FULL_CHUNK >= FULL_LIST.length;
  // Claim this part first, so a slow run can't be picked up twice.
  await db.prepare('UPDATE swap_users SET fullPart=? WHERE key=?').bind(done ? null : part + 1, u.key).run();
  if (!chunk.length) return null;
  const only = {}; for (const [sp, se] of chunk) (only[sp] = only[sp] || []).push(se);
  const r = await scanPasses(u.hashId, scanTok(env), only);
  if ((r.errors || []).length) { await stat(db, 'rescan_fail'); return { key: u.key, part, skipped: r.errors.length }; }   // that part keeps its old passes
  const fresh = new Set(chunk.map(([sp, se]) => `${sp}:${se}`));
  const merged = parse(u.passes, []).filter(p => !fresh.has(`${p.sport}:${p.season}`)).concat(r.passes);
  await fillNames(db, merged);
  await db.prepare(`UPDATE swap_users SET passes=?${done ? ', autoAt=?' : ''} WHERE key=?`)
    .bind(...(done ? [JSON.stringify(merged), Date.now(), u.key] : [JSON.stringify(merged), u.key])).run();
  if (done) await stat(db, 'rescans');
  return { key: u.key, part, passes: merged.length };
}

async function autoRescan(env, db, auth) {
  // A queued full refresh goes first.
  const full = await fullRescan(env, db, auth);
  if (full) return full;
  const day = Date.now() - 86400000;
  const u = await db.prepare(`SELECT key, hashId, passes FROM swap_users WHERE active=1 AND hashId IS NOT NULL AND passes IS NOT NULL
      AND ((wants IS NOT NULL AND wants <> '[]') OR autoAt = 0) AND COALESCE(autoAt, scannedAt, 0) < ? AND COALESCE(scannedAt, 0) < ? ORDER BY COALESCE(autoAt, scannedAt, 0) LIMIT 1`).bind(day, day).first();
  if (!u) return null;
  await db.prepare('UPDATE swap_users SET autoAt=? WHERE key=?').bind(Date.now(), u.key).run();   // claimed, even if it fails
  const prev = parse(u.passes, []);
  const only = {};
  // Every sport's current season (where new passes show up), then the seasons they hold passes in.
  const add = (sp, se) => { (only[sp] = only[sp] || []); if (!only[sp].includes(Number(se))) only[sp].push(Number(se)); };
  for (const [sp, list] of Object.entries(SWAPS_SCAN)) add(sp, list[0]);
  for (const p of prev) if (!/^(soccer|ufc)$/.test(p.sport)) add(p.sport, p.season);
  // At most 14 sport-seasons, so one run stays short.
  let n = 0; for (const k of Object.keys(only)) { only[k] = only[k].slice(0, Math.max(0, 14 - n)); n += only[k].length; if (!only[k].length) delete only[k]; }
  if (!n) return null;
  const r = await scanPasses(u.hashId, scanTok(env), only);
  if ((r.errors || []).length) { await stat(db, 'rescan_fail'); return { key: u.key, skipped: r.errors.length }; }   // try again tomorrow rather than drop passes
  const fresh = new Set(Object.entries(only).flatMap(([k, v]) => v.map(se => `${k}:${se}`)));
  const merged = prev.filter(p => !fresh.has(`${p.sport}:${p.season}`)).concat(r.passes);
  await fillNames(db, merged);
  await db.prepare('UPDATE swap_users SET passes=?, autoAt=? WHERE key=?').bind(JSON.stringify(merged), Date.now(), u.key).run();   // never starts their scan timer
  await stat(db, 'rescans');
  return { key: u.key, passes: merged.length };
}

/* One-off message campaigns from the bot, each member once. Day-1 feedback
   (2026-11-03): everyone who got a swap DM since launch. Replies land in the
   bot's DMs, where Dennis reads them. */
const FEEDBACK_TEXT = 'After day 1 of this project, rate your experience 1-10 with any feedback or change requests.';

/* ---- Pass scans: the line, the saved progress, and the work itself ------ */
const SCAN_AT_ONCE = 3;            // scans running at the same time; the rest wait in line
const SCAN_HOLD_MS = 5 * 60000;    // a place in line is kept this long after the page stops asking
const SCAN_PAGE_GONE_MS = 25000;   // a running scan nobody's page has asked about for this long is carried on by the server
async function scanTables(db) {
  await db.prepare('CREATE TABLE IF NOT EXISTS scan_queue (key TEXT PRIMARY KEY, joinedAt INTEGER, startedAt INTEGER, lastSeen INTEGER)').run();
  await db.prepare('CREATE TABLE IF NOT EXISTS scan_jobs (key TEXT PRIMARY KEY, body TEXT, at INTEGER)').run();
  try { await alterOnce(db, 'ALTER TABLE scan_jobs ADD COLUMN busy INTEGER'); } catch (e) {}
}
async function loadJob(db, key) {
  try {
    const r = await db.prepare('SELECT body FROM scan_jobs WHERE key=?').bind(key).first();
    const j = r ? JSON.parse(r.body) : null;
    if (j && Date.now() - j.at > 20 * 60000) { await db.prepare('DELETE FROM scan_jobs WHERE key=?').bind(key).run(); await db.prepare('DELETE FROM scan_queue WHERE key=?').bind(key).run(); return null; }
    return j;
  } catch (e) { return null; }
}
// Join the line (or keep your place) and see whether it's your turn.
async function scanQueueTurn(db, me, now) {
  await db.prepare('DELETE FROM scan_queue WHERE startedAt IS NULL AND lastSeen < ?').bind(now - SCAN_HOLD_MS).run();
  await db.prepare('DELETE FROM scan_queue WHERE startedAt IS NOT NULL AND key NOT IN (SELECT key FROM scan_jobs) AND startedAt < ?').bind(now - 60000).run();
  await db.prepare('INSERT INTO scan_queue (key, joinedAt, lastSeen) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET lastSeen=excluded.lastSeen').bind(me, now, now).run();
  const mine = await db.prepare('SELECT joinedAt, startedAt FROM scan_queue WHERE key=?').bind(me).first();
  if (mine && mine.startedAt) return { go: true };
  const joined = Number(mine && mine.joinedAt) || now;
  // Start only if fewer than SCAN_AT_ONCE are running and nobody waiting joined earlier.
  const c = await db.prepare(`UPDATE scan_queue SET startedAt=? WHERE key=? AND startedAt IS NULL
      AND (SELECT COUNT(*) FROM scan_queue WHERE startedAt IS NOT NULL) < ?
      AND NOT EXISTS (SELECT 1 FROM scan_queue q WHERE q.startedAt IS NULL AND q.joinedAt < ? AND q.key <> ?)`)
    .bind(now, me, SCAN_AT_ONCE, joined, me).run();
  if (c && c.meta && c.meta.changes) return { go: true };
  const ahead = await db.prepare('SELECT COUNT(*) AS n FROM scan_queue WHERE startedAt IS NULL AND joinedAt < ?').bind(joined).first();
  const pos = (Number(ahead && ahead.n) || 0) + 1, secs = Math.ceil(pos / SCAN_AT_ONCE) * 25;
  return { go: false, position: pos, wait: secs < 60 ? `${secs} seconds` : `${Math.ceil(secs / 60)} minute${secs > 60 ? 's' : ''}` };
}
async function newScanJob(env, db, me, over, u) {
  const own = await realName(db, me), rsUser = over || own;
  let hashId = u && String(u.rsUser || '').toLowerCase() === rsUser.toLowerCase() ? u.hashId : null;
  if (!hashId && rsUser.toLowerCase() === String(own).toLowerCase()) { try { await db.prepare(SPRO_DDL).run(); const pr = await db.prepare('SELECT rsId FROM swap_pro WHERE key=?').bind(me).first(); if (pr && pr.rsId) hashId = pr.rsId; } catch (e) {} }
  try { if (!hashId) hashId = await resolveHashId(rsUser, scanTok(env)); } catch (e) { return { error: 'Could not reach Real just now - try again in a minute.', status: 502 }; }
  if (!hashId) return { error: `No Real account called ${rsUser}. If your Real username is different, link it at raxacademy.app/username.`, status: 404 };
  /* Faster scans (2026-11-04): every current season, plus any old season
     they held cards in last time, is read each scan; the old seasons they had
     nothing in (most of the 76) are only read on a full scan, once a week or
     on their first. Unread seasons keep their passes from the last scan. */
  try { await alterOnce(db, 'ALTER TABLE swap_users ADD COLUMN fullScanAt INTEGER'); } catch (e) {}
  let steps = SCAN_STEPS, full = true;
  try {
    const pr = await db.prepare('SELECT passes, fullScanAt FROM swap_users WHERE key=?').bind(me).first();
    const prev = parse(pr && pr.passes, []);
    if (pr && prev.length && Date.now() - (Number(pr.fullScanAt) || 0) < 7 * 86400000) {
      const had = new Set(prev.map(p => `${p.sport}:${p.season}`));
      const current = new Set(Object.entries(SWAP_SEASONS).flatMap(([sp, v]) => v.slice(0, 2).map(se => `${sp}:${se}`)));   // this season and last, every sport
      steps = SCAN_STEPS.filter(([sp, se]) => had.has(`${sp}:${se}`) || current.has(`${sp}:${se}`)); full = false;
    }
  } catch (e) {}
  const job = { rsUser, hashId, passes: [], errors: [], at: Date.now(), idx: 0, failed: [], ri: 0, still: [], steps, full };
  await db.prepare('INSERT INTO scan_jobs (key, body, at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET body=excluded.body, at=excluded.at, busy=NULL').bind(me, JSON.stringify(job), Date.now()).run();
  return job;
}
/* About 20 seconds of one member's scan, from wherever it got to. Only one
   worker at a time per scan (the page or the server), so nothing is read
   twice. Returns what the page shows. */
const TOK_COOL = new Map();   // token -> rested until (after a 429)
async function scanWork(env, db, me, job, auth) {
  const now = Date.now();
  const claim = await db.prepare('UPDATE scan_jobs SET busy=? WHERE key=? AND (busy IS NULL OR busy < ?)').bind(now + 30000, me, now).run();
  if (!(claim && claim.meta && claim.meta.changes)) return { done: false, busy: true };
  job = (await loadJob(db, me)) || job;
  /* Real started answering the bot account with 429s on every pass read
     (2026-11-04: three scans at once, all on the bot, ~15 calls a second), so
     every call failed and waited for a retry on another account - 2 to 4
     minutes a scan. Calls now go round the three accounts in turn, and an
     account that gets a 429 is rested for 3 minutes (across scans). */
  // Not the collector's account: scans on it got it 429'd and stalled game data (2026-11-04).
  const toks0 = [...new Set([auth, env.RS_MARKET_TOKEN].filter(x => typeof x === 'string' && x.length > 20))];
  const toks = dmWindow() && toks0.length > 1 ? toks0.filter(t => t !== auth) : toks0;   // the bot is busy with DMs at :30 / :00
  let rr = Math.floor(Math.random() * toks.length);
  const pickTok = () => { for (let i = 0; i < toks.length; i++) { const t = toks[(rr + i) % toks.length]; if (!(TOK_COOL.get(t) > Date.now())) { rr = (rr + i + 1) % toks.length; return t; } }
    return toks[(rr++) % toks.length]; };
  const t0 = Date.now(), budget = () => Date.now() - t0 < 20000;
  const read = async (step, tok) => {
    const [sport, season, kind] = step;
    const base = `https://web.realapp.com/userpasses/${encodeURIComponent(job.hashId)}/passes?entityType=${kind}&season=${season}&sport=${sport}`;
    const tq = Date.now();
    const res = await fetch(base, { headers: rsHeaders(tok) });
    job.calls = (job.calls || 0) + 1; job.callMs = (job.callMs || 0) + (Date.now() - tq);
    const text = await res.text();
    if (res.status === 429) TOK_COOL.set(tok, Date.now() + 3 * 60000);
    if (!res.ok) throw new Error(`Real ${res.status}: ${text.slice(0, 80)}`);
    let d = null; try { d = JSON.parse(text); } catch (e) {}
    // Only a reply that says it's an error counts as a failure; an empty or
    // differently-shaped reply just means no passes in that season.
    if (d && typeof d === 'object' && !Array.isArray(d) && !rowsOf(d).length
        && (d.error || (Number(d.statusCode) >= 400) || /high volume|rate limit|too many/i.test(String(d.message || '')))) throw new Error(`Real said: ${String(d.message || d.error || d.statusCode).slice(0, 80)}`);
    const rows = rowsOf(d);
    rows.push(...(await morePassPages(base, tok, d, rows)));
    for (const r of rows) { const p = passOf(r, sport, season, kind); if (p) job.passes.push(p); }
  };
  const STEPS = job.steps || SCAN_STEPS;
  while (job.idx < STEPS.length && budget()) {
    const step = STEPS[job.idx++];
    try { await read(step, pickTok()); } catch (e) { job.failed.push(step); if (!job.firstErr) job.firstErr = String(e.message || e).slice(0, 120); }
    await sleep(200);
  }
  if (job.idx >= STEPS.length) {
    while (job.ri < job.failed.length && budget()) {
      const step = job.failed[job.ri++]; let err = null;
      for (let t = 0; t < toks.length; t++) {
        await sleep(600);
        try { await read(step, pickTok()); err = null; break; } catch (e) { err = e; }
      }
      if (err) { job.still.push(step); job.errors.push(`${step[0]} ${step[1]} ${step[2]}: ${String(err.message || err).slice(0, 100)}`); }
    }
  }
  if (job.idx < STEPS.length || job.ri < job.failed.length) {
    await db.prepare('UPDATE scan_jobs SET body=?, busy=NULL WHERE key=?').bind(JSON.stringify(job), me).run();
    return { done: false, next: 1, found: job.passes.length, retrying: job.idx >= STEPS.length };
  }
  // Whatever still failed keeps its passes from the last scan.
  const u = await db.prepare('SELECT passes FROM swap_users WHERE key=?').bind(me).first();
  if (job.still.length) {
    const miss = new Set(job.still.map(([sp, se, k]) => `${sp}:${se}:${k}`));
    for (const p of parse(u && u.passes, [])) if (miss.has(`${p.sport}:${p.season}:${p.kind || 'player'}`)) job.passes.push(p);
    job.kept = job.still.length;
  }
  // Seasons this (quick) scan didn't read keep what the last scan found.
  if (job.steps && !job.full) {
    const read = new Set(STEPS.map(([sp, se, k]) => `${sp}:${se}:${k}`));
    for (const p of parse(u && u.passes, [])) if (!read.has(`${p.sport}:${p.season}:${p.kind || 'player'}`)) job.passes.push(p);
  }
  await fillNames(db, job.passes);
  // A scan with seasons that still failed can be run again in 5 minutes.
  const stamp = job.kept ? Date.now() - (await scanEvery(env)) * 60000 + 5 * 60000 : Date.now();
  await db.prepare(`INSERT INTO swap_users (key, rsUser, hashId, passes, scannedAt, updatedAt, wants, keep, slots) VALUES (?, ?, ?, ?, ?, ?, '[]', '[]', '[]')
    ON CONFLICT(key) DO UPDATE SET rsUser=excluded.rsUser, hashId=excluded.hashId, passes=excluded.passes,
      scannedAt=excluded.scannedAt, updatedAt=excluded.updatedAt`)
    .bind(me, job.rsUser, job.hashId, JSON.stringify(job.passes), stamp, Date.now()).run();
  try { await db.prepare('UPDATE swap_users SET fullPart=NULL, boostScanAt=NULL WHERE key=?').bind(me).run(); } catch (e) {}
  if (job.full !== false) { try { await db.prepare('UPDATE swap_users SET fullScanAt=? WHERE key=?').bind(Date.now(), me).run(); } catch (e) {} }
  try { await db.prepare('DELETE FROM scan_jobs WHERE key=?').bind(me).run(); } catch (e) {}
  try { await db.prepare('DELETE FROM scan_queue WHERE key=?').bind(me).run(); } catch (e) {}   // next in line goes
  // How long scans take, for the health page: the last 15.
  try { const k = 'scan_perf_v1'; const l = JSON.parse((await env.RATEBOARD_KV.get(k)) || '[]') || [];
    l.unshift({ at: new Date().toISOString(), secs: Math.round((Date.now() - job.at) / 1000), steps: (job.steps || SCAN_STEPS).length, full: job.full !== false,
      calls: job.calls || 0, avgMs: job.calls ? Math.round(job.callMs / job.calls) : null, failed: job.failed.length, firstErr: job.firstErr || null, botTok: !!auth });
    await env.RATEBOARD_KV.put(k, JSON.stringify(l.slice(0, 15))); } catch (e) {}
  if (job.kept) { await stat(db, 'scan_partial'); await botFail(db, 'scan', `${me}: ${job.kept} season(s) kept from last scan - ${job.errors.slice(0, 3).join(' | ')}`); }
  else await stat(db, 'scan_ok');
  return { done: true, hashId: job.hashId, passes: job.passes, errors: job.errors, scannedAt: Date.now(),
    note: job.kept ? `${job.kept} season${job.kept === 1 ? '' : 's'} couldn't be read from Real just now, so ${job.kept === 1 ? 'it keeps' : 'they keep'} your passes from your last scan. Scan again in 5 minutes to refresh ${job.kept === 1 ? 'it' : 'them'}.` : null };
}
/* The server's share, once a minute: carry on scans whose page went away,
   and start the next person in line if they've left the page. */
async function backgroundScans(env, db, auth) {
  await scanTables(db);
  const now = Date.now(), t0 = now;
  const gone = ((await db.prepare(`SELECT q.key FROM scan_queue q JOIN scan_jobs j ON j.key = q.key WHERE q.startedAt IS NOT NULL AND q.lastSeen < ? ORDER BY q.startedAt LIMIT 2`)
    .bind(now - SCAN_PAGE_GONE_MS).all()).results) || [];
  for (const { key } of gone) {
    if (Date.now() - t0 > 25000) break;
    const job = await loadJob(db, key);
    if (job) { const r = await scanWork(env, db, key, job, auth); if (r.done) await stat(db, 'scan_background'); }
  }
  // Next in line but not on the page: start it here.
  const running = await db.prepare('SELECT COUNT(*) AS n FROM scan_queue WHERE startedAt IS NOT NULL').first();
  if ((Number(running && running.n) || 0) < SCAN_AT_ONCE && Date.now() - t0 < 15000) {
    const first = await db.prepare('SELECT key, lastSeen FROM scan_queue WHERE startedAt IS NULL ORDER BY joinedAt LIMIT 1').first();
    if (first && Number(first.lastSeen) < now - 20000) {
      const c = await db.prepare('UPDATE scan_queue SET startedAt=?, lastSeen=? WHERE key=? AND startedAt IS NULL').bind(Date.now(), now - SCAN_PAGE_GONE_MS, first.key).run();
      if (c && c.meta && c.meta.changes) {
        const u = await db.prepare('SELECT rsUser, hashId, scannedAt, passes FROM swap_users WHERE key=?').bind(first.key).first();
        const job = await newScanJob(env, db, first.key, null, u);
        if (job.error) await db.prepare('DELETE FROM scan_queue WHERE key=?').bind(first.key).run();
        else await scanWork(env, db, first.key, job, auth);
      }
    }
  }
}

/* Second feedback round (Dennis, 2026-11-04): from 5:10pm ET, everyone the
   bot sent a swap warning or contact to today (since 7am ET). Five a minute,
   and only outside the :25-:10 warning/contact window so it never gets in
   their way. */
const FEEDBACK2_TEXT = "Rate your experience so far 1-10, it's okay to be harsh this is to improve the experience.\nIs there any additions you want to see to the website or swaps?";
async function feedbackDms2(env, db, auth) {
  const C = 'feedback_1104', AT = Date.parse('2026-11-04T22:10:00Z');
  if (Date.now() < AT || Date.now() > AT + 6 * 3600000) return;
  await db.prepare('CREATE TABLE IF NOT EXISTS bot_once (campaign TEXT, key TEXT, at INTEGER, ok INTEGER, PRIMARY KEY (campaign, key))').run();
  if (!(await env.RATEBOARD_KV.get('bot_once_' + C))) {
    await env.RATEBOARD_KV.put('bot_once_' + C, String(Date.now()));
    const rows = ((await db.prepare(`SELECT a, b, warnA, warnB, doneA, doneB FROM swap_matches WHERE dueAt >= ? AND dueAt <= ?`).bind(Date.parse('2026-11-04T12:00:00Z'), Date.now()).all()).results) || [];
    const who = new Set();
    for (const m of rows) { if (m.warnA || m.doneA) who.add(m.a); if (m.warnB || m.doneB) who.add(m.b); }
    for (const k of who) await db.prepare('INSERT OR IGNORE INTO bot_once (campaign, key) VALUES (?, ?)').bind(C, k).run();
    await stat(db, 'feedback2_queued', who.size);
  }
  if (dmWindow()) return;
  // One more try, 10 minutes on, for anyone whose message Real's slowmode refused.
  try { await db.prepare('UPDATE bot_once SET at=NULL, ok=-1 WHERE campaign=? AND ok=0 AND at < ?').bind(C, Date.now() - 10 * 60000).run(); } catch (e) {}
  const due = ((await db.prepare('SELECT key FROM bot_once WHERE campaign=? AND at IS NULL LIMIT 5').bind(C).all()).results) || [];
  for (const { key } of due) {
    const c = await db.prepare('UPDATE bot_once SET at=? WHERE campaign=? AND key=? AND at IS NULL').bind(Date.now(), C, key).run();
    if (!(c && c.meta && c.meta.changes)) continue;
    const u = await loadMember(db, key);
    let ok = 0;
    const was = await db.prepare('SELECT ok FROM bot_once WHERE campaign=? AND key=?').bind(C, key).first();
    try { if (u && u.hashId) { const ch = await dmChannel(db, auth, u.hashId, u.rsUser, env); await dmSendRetry(auth, ch, FEEDBACK2_TEXT); ok = 1; await stat(db, 'dm_feedback2'); } }
    catch (e) { await botFail(db, 'dm_feedback', `${key}: ${e.message || e}`); }
    if (!ok && was && Number(was.ok) === -1) ok = -2;      // second miss: left alone
    await db.prepare('UPDATE bot_once SET ok=? WHERE campaign=? AND key=?').bind(ok, C, key).run();
    await sleep(1500);
  }
}
async function feedbackDms(env, db, auth) {
  await db.prepare('CREATE TABLE IF NOT EXISTS bot_once (campaign TEXT, key TEXT, at INTEGER, ok INTEGER, PRIMARY KEY (campaign, key))').run();
  const C = 'feedback_day1';
  if (!(await env.RATEBOARD_KV.get('bot_once_' + C))) {
    await env.RATEBOARD_KV.put('bot_once_' + C, String(Date.now()));
    const since = Date.UTC(2026, 10, 3, 10, 20);
    const rows = ((await db.prepare(`SELECT a, b, warnA, warnB, doneA, doneB, followA, followB FROM swap_matches WHERE createdAt >= ?`).bind(since).all()).results) || [];
    const who = new Set();
    for (const m of rows) { if (m.warnA || m.doneA || m.followA) who.add(m.a); if (m.warnB || m.doneB || m.followB) who.add(m.b); }
    for (const k of who) await db.prepare('INSERT OR IGNORE INTO bot_once (campaign, key) VALUES (?, ?)').bind(C, k).run();
    await stat(db, 'feedback_queued', who.size);
  }
  const due = ((await db.prepare('SELECT key FROM bot_once WHERE campaign=? AND at IS NULL LIMIT 5').bind(C).all()).results) || [];
  for (const { key } of due) {
    const c = await db.prepare('UPDATE bot_once SET at=? WHERE campaign=? AND key=? AND at IS NULL').bind(Date.now(), C, key).run();
    if (!(c && c.meta && c.meta.changes)) continue;          // another run took it
    const u = await loadMember(db, key);
    let ok = 0;
    try { if (u && u.hashId) { const ch = await dmChannel(db, auth, u.hashId, u.rsUser, env); await dmSend(auth, ch, FEEDBACK_TEXT); ok = 1; await stat(db, 'dm_feedback'); } }
    catch (e) { await botFail(db, 'dm_feedback', `${key}: ${e.message || e}`); }
    await db.prepare('UPDATE bot_once SET ok=? WHERE campaign=? AND key=?').bind(ok, C, key).run();
    await sleep(900);
  }
}

/* The tick runs in the background after the collector's reply, and Cloudflare
   stops background work about 30 seconds later - with no error. A DM still
   being sent then is lost, though its swap is already marked as told
   (2026-11-05: members got the first part of a contact message and never the
   last). So the DMs go first, everything is timed from the tick's start, no
   new member is started after 16s, and a part that would go after 22s is
   queued for the next minute instead. Scans don't run in the DM windows. */
let TICK_T0 = 0, TICK_BUDGET = 22000;
const tickLeft = () => TICK_BUDGET - (Date.now() - TICK_T0);
const NO_MSG = new Map();   // members Real just refused a DM for -> when to try again
/* The DMs' own run (2026-11-05): the collector tick calls /api/swaps?op=dmtick
   once a minute, so the warnings and contacts get a whole background slot to
   themselves instead of sharing one with matching and scans. The key is
   derived from the bot's token, so only the board can start it. */
export async function dmTickKey(env) {
  const t = swapToken(env); if (!t) return null;
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('dmtick|' + t));
  return [...new Uint8Array(h)].slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('');
}
/* One DM per member per stage (2026-11-05, Dennis: "fix everything"). A
   member with many swaps in an hour got 5-10 messages - Real drops some, the
   bot falls behind, and it's unreadable. Now: if it all fits in one message
   it's sent as before; if not, ONE message with a short summary and a link to
   a page listing every swap that hour (packs to buy, who to contact, card
   links). The link carries a signature, so it opens without signing in (Real's
   in-app browser isn't signed in) and only for that member and hour. */
/* Packs today: every pass the system counts as used by a member this swap day
   (7am-7am ET) - each one scheduled to go out in a swap, whatever happened to
   it - plus any they added themselves (used elsewhere; never given again that
   day, though a swap already scheduled with it stays). Used on /swaps and on
   the hour page. `change` = { key, remove } to add or take one off. */
async function packsToday(env, db, me, change) {
  await matchCols(db);
  const day = swapDay(Date.now());
  const r = await db.prepare('SELECT passes, packsUsed, keep, wants FROM swap_users WHERE key=?').bind(me).first();
  if (!r) return { error: 'Scan your passes first.' };
  let pu = parse(r.packsUsed, null); if (!pu || pu.day !== day) pu = { day, keys: [] };
  if (change) {
    const k = String(change.key || '');
    if (!/^[a-z]+:\d{4}:t?\d+$/.test(k)) return { error: 'Pick a pass.' };
    if (change.remove) pu.keys = pu.keys.filter(x => x !== k); else if (!pu.keys.includes(k)) pu.keys.push(k);
    await db.prepare('UPDATE swap_users SET packsUsed=? WHERE key=?').bind(JSON.stringify(pu), me).run();
  }
  const mine = { key: me, passes: parse(r.passes, []) };
  const ms = ((await db.prepare("SELECT a, b, aGets, bGets, dueAt, slot, createdAt, status, warnA, warnB, doneA, doneB FROM swap_matches WHERE (a=? OR b=?) AND dueAt > ? AND status <> 'cleared'").bind(me, me, Date.now() - 2 * 86400000).all()).results) || [];
  const used = new Map(), recvToday = new Map(); let next = null, latest = null;
  for (const m of ms) { const due = sideDue(m);
    // Packs coming to them today, per player they're grinding.
    if (swapDay(due) === day && !['cancelled', 'cancelling'].includes(m.status)) { const rk = m.a === me ? m.aGets : m.bGets; const v = recvToday.get(rk) || recvToday.set(rk, { done: 0, left: 0 }).get(rk); if (due <= Date.now()) v.done++; else v.left++; }
    if (!['cancelled', 'cancelling'].includes(m.status)) { if (due > Date.now() - 3600000 && (!next || due < next)) next = due; if (!latest || due > latest) latest = due; }
    if (swapDay(due) !== day) continue;
    const isOff = ['cancelled', 'cancelling'].includes(m.status), toldMe = m.a === me ? (m.warnA || m.doneA) : (m.warnB || m.doneB);
    if (isOff && !toldMe) continue;      // called off before they were warned: that pass is free again
    const k = m.a === me ? m.bGets : m.aGets, partner = m.a === me ? m.b : m.a;
    const x = used.get(k) || used.set(k, { key: k, name: playerName(mine, k), times: [], partners: [], off: 0, n: 0 }).get(k);
    x.n++; x.times.push(due); x.partners.push(partner); if (['cancelled', 'cancelling'].includes(m.status)) x.off++; }
  const pk = [...new Set([...used.values()].flatMap(x => x.partners))], rn = new Map();
  for (let i = 0; i < pk.length; i += 90) { const part = pk.slice(i, i + 90);
    for (const x of (((await db.prepare(`SELECT key, rsUser FROM swap_users WHERE key IN (${part.map(() => '?').join(',')})`).bind(...part).all()).results) || [])) rn.set(x.key, x.rsUser || x.key); }
  const system = [...used.values()].map(x => ({ ...x, times: [...new Set(x.times)].sort((a, b) => a - b), partners: [...new Set(x.partners)].map(k => rn.get(k) || k) })).sort((a, b) => a.times[0] - b.times[0]);
  const manual = pu.keys.map(k => ({ key: k, name: playerName(mine, k), manual: true }));
  // What can still be added: their swappable passes not used yet today.
  const taken = new Set([...used.keys(), ...pu.keys]), keep = new Set(parse(r.keep, []));
  const options = mine.passes.filter(p => p.kind !== 'team' && !/^(soccer|ufc):/.test(p.key) && !seasonOff(p.key) && !taken.has(p.key) && !keep.has(p.key))
    .map(p => ({ key: p.key, name: playerName(mine, p.key) })).sort((a, b) => a.name.localeCompare(b.name));
  const at = next || latest;
  const wants = parse(r.wants, []);
  const grinds = [...new Set([...wants, ...recvToday.keys()])].map(k => ({ key: k, name: playerName(mine, k), picked: wants.includes(k), done: (recvToday.get(k) || {}).done || 0, left: (recvToday.get(k) || {}).left || 0 }))
    .filter(g => g.picked || g.done || g.left);
  return { day, system, manual, options, grinds, hourUrl: at ? `/hour?u=${encodeURIComponent(me)}&d=${at}&t=${await hourSig(env, me, at)}` : null };
}
async function hourSig(env, key, due) {
  const t = swapToken(env) || 'x';
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode('hour|' + t), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(`${String(key).toLowerCase()}|${Number(due)}`));
  return [...new Uint8Array(sig)].slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('');
}
/* A short link for the DM (raxacademy.app/h/<10 letters>), kept in a table and
   turned into the full signed link by functions/h/[code].js. The warning and
   the contact each get their own: "buy" opens on the packs to buy (the
   offers appear at :55), "offer" opens on the offers. */
async function hourLink(env, key, due, stage = 'buy') {
  const t = await hourSig(env, key, due);
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode('hourcode|' + (swapToken(env) || 'x')), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const code = [...new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(`${String(key).toLowerCase()}|${Number(due)}|${stage}`)))].slice(0, 5).map(b => b.toString(16).padStart(2, '0')).join('');
  try { const db = env.RATEBOARD_DB;
    await db.prepare('CREATE TABLE IF NOT EXISTS hour_links2 (code TEXT PRIMARY KEY, u TEXT, d INTEGER, t TEXT, s TEXT, at INTEGER)').run();
    await db.prepare('INSERT OR IGNORE INTO hour_links2 (code, u, d, t, s, at) VALUES (?, ?, ?, ?, ?, ?)').bind(code, String(key), Number(due), t, stage, Date.now()).run();
    return `https://raxacademy.app/h/${code}`;
  } catch (e) { return `https://raxacademy.app/hour?u=${encodeURIComponent(key)}&d=${Number(due)}&t=${t}&s=${stage}`; }
}
/* A member's Real profile: Real's own route is /u/<username>/<user id> (from
   Real's web app, 2026-11-05). The id keeps working after a rename. */
const profileUrl = (userName, hashId) => userName ? `https://www.realapp.com/u/${encodeURIComponent(userName)}${hashId ? '/' + encodeURIComponent(hashId) : ''}` : null;
// "Player link x#" for each player received (Real shows a player link as his name).
function recvSummary(me, items) {
  const c = new Map(); for (const it of items) c.set(it.recvKey, (c.get(it.recvKey) || 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${playerUrl(k) || playerName(me, k)} ${String(k).split(':')[1]} x${n}`).join(', ');
}
// Dennis's wording (2026-11-05) for the one-message DM.
const siteDm = (pre, n, link, sum, extra) => fitOne(`${pre ? pre + '\n\n' : ''}You have ${n} swap${n === 1 ? '' : 's'}, all details on site below, we are using the site to avoid large quantity of dm issues\n${link}\n\nPlayers you're receiving this run: ${sum}${extra ? '\n\n' + extra : ''}`);
/* One-off check (Dennis, 2026-11-05): everyone in the 8:00 AKST run (17:00
   UTC). Each member's chat is read back and looked for their swap link (its
   short code); anyone without it gets the swap DM again. A few chats each
   tick, after the regular DMs. Dennis gets a DM with who was resent. If the
   first few all come back "missing", the read-back can't see links and the
   check stops instead of sending everyone a repeat. */
const AUDIT_DUE = Date.UTC(2026, 10, 5, 17, 0, 0);
async function auditHour(env, db, auth) {
  const K = 'dm_audit_' + AUDIT_DUE;
  let st = null; try { st = JSON.parse((await env.RATEBOARD_KV.get(K)) || 'null'); } catch (e) {}
  if (st && st.finished) return;
  st = st || { done: [], ok: [], resent: [], failed: [], pending: [], startedAt: Date.now() };
  st.pending = st.pending || [];
  const save = () => env.RATEBOARD_KV.put(K, JSON.stringify(st), { expirationTtl: 7 * 86400 });
  const ms = ((await db.prepare("SELECT * FROM swap_matches WHERE dueAt BETWEEN ? AND ? AND status NOT IN ('cancelled','cancelling','cleared')").bind(AUDIT_DUE - 3600000, AUDIT_DUE + 3600000).all()).results) || [];
  const per = new Map();
  for (const m of ms) for (const side of ['A', 'B']) if (sideDue(m) === AUDIT_DUE) { const who = side === 'A' ? m.a : m.b; (per.get(who) || per.set(who, []).get(who)).push({ m, side }); }
  const cache = new Map(), member = async k => cache.has(k) ? cache.get(k) : (cache.set(k, await loadMember(db, k)), cache.get(k));
  const resend = async (who, list, ch, link) => {
    const me = await member(who), items = []; for (const x of list) { const l = await sideLines(member, x.m, x.side); if (l) items.push(l); }
    if (items.length) { await dmSendRetry(auth, ch, siteDm('', items.length, link, recvSummary(me, items), '')); await stat(db, 'dm_audit_resend'); st.resent.push('@' + ((me && me.rsUser) || who)); }
  };
  for (const [who, list] of [...per.entries()].sort()) {
    if (st.finished) break;
    if (TICK_T0 && tickLeft() - dmWaitAhead() < 9000) break;
    // Missing ones held back until the read-back has seen at least one link; then they're sent.
    if (st.ok.length && st.pending.length) { const p0 = st.pending.shift();
      try { await resend(p0.who, per.get(p0.who) || [], p0.ch, p0.link); } catch (e) { st.failed.push(`@${p0.who} (${String(e.message || e).slice(0, 60)})`); }
      await save(); continue; }
    if (st.done.includes(who)) continue;
    const me = await member(who), name = '@' + ((me && me.rsUser) || who);
    try {
      if (!me || !me.hashId) throw new Error('never verified');
      const had = await db.prepare('SELECT channelId FROM swap_dm WHERE hashId=?').bind(me.hashId).first();
      if (!had || !had.channelId) throw new Error('no chat with the bot');
      const link = await hourLink(env, who, AUDIT_DUE, 'offer'), code = link.split('/').pop();
      const d = await rsGetJson(`https://web.realapp.com/messages/channels/${had.channelId}/messages`, auth);
      const blob = JSON.stringify(d || '');
      if (blob.includes(code)) st.ok.push(name);
      else if (!st.ok.length) {
        st.pending.push({ who, ch: had.channelId, link });
        // Six missing and none found: the read-back can't see links - stop, send nobody a repeat.
        if (st.pending.length >= 6) { st.finished = true; st.aborted = `first ${st.pending.length} chats showed no link, so the read-back can't see links - nothing resent`; }
      } else await resend(who, list, had.channelId, link);
    } catch (e) { st.failed.push(`${name} (${String(e.message || e).slice(0, 60)})`); }
    st.done.push(who); await save(); await sleep(300);
  }
  if (!st.finished && per.size && [...per.keys()].every(k => st.done.includes(k)) && (!st.pending.length || !st.ok.length)) { st.finished = true; if (st.pending.length) st.aborted = 'no chat showed a link - nothing resent'; }
  if (st.finished && !st.told) {
    st.told = Date.now();
    try { const dn = await loadMember(db, 'dennis');
      if (dn && dn.hashId) { const ch = await dmChannel(db, auth, dn.hashId, dn.rsUser, env);
        await dmSend(auth, ch, fitOne(st.aborted ? `8:00 run check stopped: ${st.aborted}. Resent to ${st.resent.join(', ') || 'nobody'}.`
          : `8:00 run check: ${per.size} people. ${st.ok.length} had their swap DM. Resent to ${st.resent.length}: ${st.resent.join(', ') || 'nobody'}.${st.failed.length ? ` Couldn't check: ${st.failed.join(', ')}.` : ''}`)); } } catch (e) {}
  }
  await save();
}
async function dmTick(env) {
  TICK_T0 = Date.now(); TICK_BUDGET = 26000;
  const db = env.RATEBOARD_DB, auth = swapToken(env);
  if (!db || !auth || !DM_ON) return [];
  // One-off (2026-11-05, Dennis asked): the new one-message DMs sent to him exactly as members get them, from his own swaps.
  try { if (!(await env.RATEBOARD_KV.get('example_dm_1105c'))) { await env.RATEBOARD_KV.put('example_dm_1105c', String(Date.now()));
    const me = await loadMember(db, 'dennis');
    if (me && me.hashId) {
      const m0 = await db.prepare("SELECT dueAt FROM swap_matches WHERE (a='dennis' OR b='dennis') AND status NOT IN ('cleared') AND dueAt IS NOT NULL ORDER BY ABS(dueAt - ?) LIMIT 1").bind(Date.now()).first();
      const due = (m0 && Number(m0.dueAt)) || Math.ceil(Date.now() / 3600000) * 3600000;
      const ms = ((await db.prepare("SELECT * FROM swap_matches WHERE (a='dennis' OR b='dennis') AND dueAt=? AND status NOT IN ('cancelled','cleared')").bind(due).all()).results) || [];
      const cache = new Map(), member = async k => cache.has(k) ? cache.get(k) : (cache.set(k, await loadMember(db, k)), cache.get(k));
      const items = []; for (const m of ms) { const l = await sideLines(member, m, m.a === 'dennis' ? 'A' : 'B'); if (l) items.push(l); }
      const link = await hourLink(env, 'dennis', due), link2 = await hourLink(env, 'dennis', due, 'offer'), n = items.length || 0, sum = items.length ? recvSummary(me, items) : 'Jacob Misiorowski x9, A\'ja Wilson x6, Scottie Scheffler x5';
      const ch = await dmChannel(db, auth, me.hashId, me.rsUser, env);
      await dmSend(auth, ch, fitOne(`Heads up - you swap in 30 min. You have ${n} swaps that hour - buy the ${n} packs listed here:\n${link}\n\nYou are receiving: ${sum}`));
      await sleep(4500);
      await dmSend(auth, ch, fitOne(`Swap time - send 12 hour offers. You have ${n} swaps now - who to contact, their comments and your cards are here:\n${link2}\n\nYou are receiving: ${sum}\n\nReport anyone doing it wrong.`));
      await stat(db, 'dm_admin', 2);
    } } } catch (e) { await botFail(db, 'dm_admin', 'example: ' + (e.message || e)); }
  try { await retryDms(db, auth); } catch (e) { await botFail(db, 'dm_retry', e.message); }   // unsent parts first
  try {
    const rows = ((await db.prepare(`SELECT * FROM swap_matches WHERE status IN ('pending','warned','cancelling') AND createdAt > ? ORDER BY COALESCE(dueAt, createdAt), id LIMIT 800`)
      .bind(Date.now() - 2 * 86400000).all()).results) || [];
    if (rows.length) { const out = await runDms(env, db, auth, rows, DM_PER_TICK, false);
      try { await auditHour(env, db, auth); } catch (e) { await botFail(db, 'dm_audit', e.message); }
      return out; }
  } catch (e) { await botFail(db, 'dm_run', e.message); }
  try { await auditHour(env, db, auth); } catch (e) { await botFail(db, 'dm_audit', e.message); }
  return [];
}
export async function swapTick(env) {
  TICK_T0 = Date.now();
  if (!DM_ON) return null;
  const db = env.RATEBOARD_DB, auth = swapToken(env);
  if (!db || !auth) return null;
  await ready(db);
  // Once an hour at :20 (before the :30 warnings). The claim is a database row (instant everywhere), not KV,
  // so two ticks can never both run matching in the same hour.
  const hour = new Date().toISOString().slice(0, 13);
  let mine = false;
  if (new Date().getUTCMinutes() >= 20) {
    try { await db.prepare('CREATE TABLE IF NOT EXISTS swap_runs (hour TEXT PRIMARY KEY, at INTEGER)').run();
      const c = await db.prepare('INSERT OR IGNORE INTO swap_runs (hour, at) VALUES (?, ?)').bind(hour, Date.now()).run();
      mine = !!(c && c.meta && c.meta.changes); } catch (e) {}
  }
  if (mine) {
    try { await matchCols(db); } catch (e) {}
    const t0 = Date.now();
    try { await db.prepare("INSERT INTO bot_log (at, kind, msg) VALUES (?, 'match', ?)").bind(t0, 'run started').run(); } catch (e) {}
    try { const made = await runMatching(db, env); await stat(db, 'matches', made.length); await stat(db, 'match_runs');
      try { await db.prepare("INSERT INTO bot_log (at, kind, msg) VALUES (?, 'match', ?)").bind(Date.now(), `run done: ${made.length} swaps in ${((Date.now() - t0) / 1000).toFixed(1)}s (${made.timing || ''})`).run(); } catch (e) {} }
    catch (e) { await botFail(db, 'matching', `after ${((Date.now() - t0) / 1000).toFixed(1)}s: ${e.message}`); }
  }
  // One-time (2026-11-03): a match sent early by hand goes back on schedule.
  try {
    if (!(await env.RATEBOARD_KV.get('swap_unsend_v1'))) {
      await env.RATEBOARD_KV.put('swap_unsend_v1', String(Date.now()));
      await db.prepare(`UPDATE swap_matches SET status='pending', warnA=NULL, warnB=NULL, doneA=NULL, doneB=NULL, followA=NULL, followB=NULL, sentAt=NULL, note='reset to schedule after a manual send'
        WHERE createdAt >= ? AND status <> 'cleared' AND dueAt IS NOT NULL AND (COALESCE(doneA, 0) BETWEEN 1 AND dueAt - 1 OR COALESCE(doneB, 0) BETWEEN 1 AND dueAt - 1)`)
        .bind(Date.UTC(2026, 10, 3, 10, 20)).run();
    }
  } catch (e) {}
  // One-time (2026-11-03, launch): every match made before now - test ones included - is cleared.
  try {
    if (!(await env.RATEBOARD_KV.get('swap_clear_v2'))) {
      await env.RATEBOARD_KV.put('swap_clear_v2', String(Date.now()));
      await db.prepare("UPDATE swap_matches SET status='cleared' WHERE status <> 'cleared' AND createdAt < ?").bind(Date.UTC(2026, 10, 3, 10, 20)).run();
      await stat(db, 'cleared');
    }
  } catch (e) {}
  // One-time (2026-11-03): clear every swap submission before launch.
  try {
    if (!(await env.RATEBOARD_KV.get('swap_clear_v1'))) {
      await env.RATEBOARD_KV.put('swap_clear_v1', String(Date.now()));
      try { await alterOnce(db, 'ALTER TABLE swap_users ADD COLUMN goal REAL'); } catch (e) {}
      await db.prepare("UPDATE swap_users SET wants='[]', keep='[]', slots='[]', goal=NULL, active=0").run();
      await db.prepare("UPDATE swap_matches SET status='cleared' WHERE status IN ('pending','warned','sending','error')").run();
      try { await env.RATEBOARD_KV.delete('swap_hourcounts_v1'); await env.RATEBOARD_KV.delete('swap_wantcounts_v1'); } catch (e) {}
      await stat(db, 'cleared');
    }
  } catch (e) {}
  // One-time (2026-11-03 21:25 AK): clear everyone's scan timer again.
  try {
    if (!(await env.RATEBOARD_KV.get('scan_reset_v6'))) {
      await env.RATEBOARD_KV.put('scan_reset_v6', String(Date.now()));
      await db.prepare('UPDATE swap_users SET scannedAt = NULL, boostScanAt = NULL').run();
      await stat(db, 'scan_reset');
    }
  } catch (e) {}
  // One-time (2026-11-03 evening): clear everyone's scan timer after the scan fix.
  try {
    if (!(await env.RATEBOARD_KV.get('scan_reset_v5'))) {
      await env.RATEBOARD_KV.put('scan_reset_v5', String(Date.now()));
      await db.prepare('UPDATE swap_users SET scannedAt = NULL, boostScanAt = NULL').run();
      await stat(db, 'scan_reset');
    }
  } catch (e) {}
  // One-time (2026-11-03): scans made while there were no pauses may have lost a sport - let them rescan now.
  try {
    if (!(await env.RATEBOARD_KV.get('scan_reset_v4'))) {
      await env.RATEBOARD_KV.put('scan_reset_v4', String(Date.now()));
      await db.prepare('UPDATE swap_users SET scannedAt = NULL WHERE scannedAt > ?').bind(Date.UTC(2026, 10, 3, 15, 40)).run();
    }
  } catch (e) {}
  // One-time (2026-11-03): one scan site-wide - clear every scan timer and any queued refresh.
  try {
    if (!(await env.RATEBOARD_KV.get('scan_reset_v3'))) {
      await env.RATEBOARD_KV.put('scan_reset_v3', String(Date.now()));
      try { await alterOnce(db, 'ALTER TABLE swap_users ADD COLUMN boostScanAt INTEGER'); } catch (e) {}
      try { await alterOnce(db, 'ALTER TABLE swap_users ADD COLUMN fullPart INTEGER'); } catch (e) {}
      await db.prepare('UPDATE swap_users SET scannedAt = NULL, boostScanAt = NULL, fullPart = NULL').run();
      await stat(db, 'scan_reset');
    }
  } catch (e) {}
  // One-time (2026-11-03): no server refresh after all - just the cleared timers. Empty the queue.
  try {
    if (!(await env.RATEBOARD_KV.get('scan_unqueue_v1'))) {
      await env.RATEBOARD_KV.put('scan_unqueue_v1', String(Date.now()));
      try { await db.prepare('UPDATE swap_users SET fullPart = NULL WHERE fullPart IS NOT NULL').run(); } catch (e) {}
    }
  } catch (e) {}
  // One-time (2026-11-03): clear everyone's scan timers (Swaps and Boosts).
  try {
    if (!(await env.RATEBOARD_KV.get('scan_reset_v2'))) {
      await env.RATEBOARD_KV.put('scan_reset_v2', String(Date.now()));
      try { await alterOnce(db, 'ALTER TABLE swap_users ADD COLUMN fullPart INTEGER'); } catch (e) {}
      try { await alterOnce(db, 'ALTER TABLE swap_users ADD COLUMN boostScanAt INTEGER'); } catch (e) {}
      await db.prepare('UPDATE swap_users SET scannedAt = MIN(COALESCE(scannedAt, 0), ?), boostScanAt = NULL WHERE hashId IS NOT NULL').bind(Date.now() - 4 * 3600000).run();
      await stat(db, 'scan_reset');
    }
  } catch (e) {}
  // One-time (2026-11-02): clear everyone's scan timers and queue a fresh scan.
  try {
    if (!(await env.RATEBOARD_KV.get('scan_reset_v1'))) {
      await env.RATEBOARD_KV.put('scan_reset_v1', String(Date.now()));
      try { await alterOnce(db, 'ALTER TABLE swap_users ADD COLUMN boostScanAt INTEGER'); } catch (e) {}
      try { await alterOnce(db, 'ALTER TABLE swap_users ADD COLUMN autoAt INTEGER'); } catch (e) {}
      await db.prepare('UPDATE swap_users SET scannedAt = MIN(COALESCE(scannedAt, 0), ?), boostScanAt = NULL, autoAt = 0').bind(Date.now() - 4 * 3600000).run();
      await stat(db, 'scan_reset');
    }
  } catch (e) {}
  const inDmWindow = dmWindow();
  if (!inDmWindow) { try { await autoRescan(env, db, auth); } catch (e) { await botFail(db, 'rescan', e.message); } }
  // One-off (2026-11-04): swaps still to come, nobody warned yet, where the giver had already been
  // scheduled to give that pass earlier in the swap day (in any swap, even a called-off one): called off quietly.
  try { if (!(await env.RATEBOARD_KV.get('give_dupe_fix_1104'))) { await env.RATEBOARD_KV.put('give_dupe_fix_1104', '1');
    const ms = ((await db.prepare("SELECT * FROM swap_matches WHERE createdAt > ? ORDER BY createdAt, id").bind(Date.now() - 2 * 86400000).all()).results) || [];
    const seen = new Set(); let n = 0;
    for (const m of ms) { const d = swapDay(sideDue(m)), ga = `${m.a}|${m.bGets}|${d}`, gb = `${m.b}|${m.aGets}|${d}`;
      const live = ['pending', 'warned'].includes(m.status) && !m.warnA && !m.warnB && !m.doneA && !m.doneB && sideDue(m) > Date.now();
      if (live && (seen.has(ga) || seen.has(gb))) { await db.prepare("UPDATE swap_matches SET status='cancelled', note='called off: pass already scheduled to go out today' WHERE id=?").bind(m.id).run(); n++; continue; }
      seen.add(ga); seen.add(gb); }
    await stat(db, 'give_dupe_fixed', n); } } catch (e) { await botFail(db, 'dupefix', e.message); }
  // (The swaps' DMs have their own run now - dmTick.) If last minute had no
  // such run, the call isn't getting through: send them from here instead.
  let notes = [];
  try {
    await db.prepare('CREATE TABLE IF NOT EXISTS dm_runs (minute TEXT PRIMARY KEY, at INTEGER)').run();
    const prevMin = new Date(Date.now() - 60000).toISOString().slice(0, 16), curMin = new Date().toISOString().slice(0, 16);
    const had = await db.prepare('SELECT 1 AS x FROM dm_runs WHERE minute=?').bind(prevMin).first();
    if (!had) {
      await sleep(3000);   // give this minute's own run a moment to claim first
      const c = await db.prepare('INSERT OR IGNORE INTO dm_runs (minute, at) VALUES (?, ?)').bind(curMin, Date.now()).run();
      if (c && c.meta && c.meta.changes) { await stat(db, 'dm_fallback'); notes = await dmTick(env); }
    }
  } catch (e) { await botFail(db, 'dm_run', e.message); }
  if (!inDmWindow) {
    try { await feedbackDms(env, db, auth); } catch (e) { await botFail(db, 'dm_feedback', e.message); }
    try { await feedbackDms2(env, db, auth); } catch (e) { await botFail(db, 'dm_feedback', e.message); }
    try { await backgroundScans(env, db, auth); } catch (e) { await botFail(db, 'scan_bg', e.message); }
  }
  return notes;
}

/* Who can use Swaps besides admins: these Real usernames, matched against
   the board account's key or display name. */
const SWAP_MEMBERS = ['scantrawn', 'prod', 'nebula57', 'thinkpoker', 'harris', 'reschny', 'six',
  'uawheel', 'topfloorboss', 'aayan.t', 'nicohoerner', 'gabby', 'rhjin', 'lax', 'thathuey5', 'puka', 'mar'];
const SACCESS_DDL = `CREATE TABLE IF NOT EXISTS swap_access (key TEXT PRIMARY KEY, grantedAt INTEGER)`;
/* The Real Pro wall in front of Swaps: one check per member, ever. Their
   board username is looked up on Real (they can't type another one), and
   the answer is kept, so it is never asked again. Dennis can clear it. */
// Swaps stays closed to everyone but admins and hand-picked members until
// this is true; then the Pro check opens it to every Real Pro member.
const SWAPS_OPEN = true;   // open quietly 2026-11-02: reachable at /swaps, not in the menu yet (index.html)
const SPRO_DDL = `CREATE TABLE IF NOT EXISTS swap_pro (key TEXT PRIMARY KEY, pro INTEGER, tier INTEGER, rsId TEXT, at INTEGER)`;
// Seasons that can't be swapped for now (2026-27 college and pro basketball).
const NO_SWAP_SEASONS = new Set(['ncaam:2027', 'nba:2027']);
const seasonOff = k => NO_SWAP_SEASONS.has(String(k).split(':').slice(0, 2).join(':'));
const SREPORT_DDL = `CREATE TABLE IF NOT EXISTS swap_reports (ts INTEGER, by_user TEXT, kind TEXT, target TEXT, detail TEXT, status TEXT)`;
const HIGH_VOL = "We're experiencing high volume, give it 1-2 mins then try again";
const PRO_RETRY_MS = 3 * 86400000;           // a failed Pro check can be run again after 3 days
// Comment links must sit under the swap post (its long id; the share link is 9DHKtlFNQA4).
const SWAP_POST_ID = '0VH8Fy0KQ01CBqj5';
const SWAP_COMMENT_RE = new RegExp('^https://(www\\.)?realapp\\.com/' + SWAP_POST_ID + '/[0-9A-Za-z]{4,}([/?#].*)?$');
/* A member's Real username: their board username, unless they have linked a
   different Real account by DMing the bot from it (/username). */
async function realName(db, key) {
  try { const r = await db.prepare('SELECT rsName FROM users WHERE key=?').bind(key).first(); return String((r && r.rsName) || key); }
  catch (e) { return String(key); }
}
const OTD_DDL = `CREATE TABLE IF NOT EXISTS otd_access (key TEXT PRIMARY KEY, grantedAt INTEGER)`;
/* Who can use Swaps and who can use OTD optimization - two separate grants.
   ok means either; swaps and otd say which. */
/* A member's access is remembered for a minute in this worker: every page
   open made four trips to the database just to ask (2026-11-04, slow pages).
   A grant only ever widens access, so a minute's delay on one is harmless;
   a "no" isn't remembered, so a fresh Pro check counts at once. */
const ACCESS_MEMO = new Map();
export async function swapAccess(env, request) {
  const who = await sessionKey(env, request);
  if (!who) return { who: null, admin: false, ok: false, swaps: false, otd: false };
  const admin = ADMINS.includes(String(who).toLowerCase());
  if (admin) return { who, admin, ok: true, swaps: true, otd: true };
  const hit = ACCESS_MEMO.get(who);
  if (hit && Date.now() - hit.at < 60000) return hit.v;
  const db = env.RATEBOARD_DB;
  const norm = x => String(x || '').trim().toLowerCase().replace(/^@/, '');
  let swaps = SWAP_MEMBERS.includes(norm(who)), otd = false;
  try {
    await db.prepare(SACCESS_DDL).run();
    await db.prepare(OTD_DDL).run();
    await db.prepare(SPRO_DDL).run();
    await db.prepare(SBLOCK_DDL).run();
    // All five questions in one trip.
    const [a, b, c, d, e] = await db.batch([
      db.prepare('SELECT 1 AS x FROM swap_access WHERE key=?').bind(who),
      db.prepare('SELECT 1 AS x FROM otd_access WHERE key=?').bind(who),
      db.prepare('SELECT 1 AS x FROM swap_pro WHERE key=? AND pro=1').bind(who),
      db.prepare('SELECT name FROM users WHERE key=?').bind(who),
      db.prepare('SELECT 1 AS x FROM swap_block WHERE key=?').bind(who)]);
    const nm = d && d.results && d.results[0];
    swaps = swaps || (!!nm && SWAP_MEMBERS.includes(norm(nm.name))) || !!(a.results && a.results.length) || (SWAPS_OPEN && !!(c.results && c.results.length));
    if (e && e.results && e.results.length) swaps = false;   // Dennis took their swaps away
    otd = !!(b.results && b.results.length);
  } catch (e) {}
  const v = { who, admin: false, ok: swaps || otd, swaps, otd };
  if (v.ok) { ACCESS_MEMO.set(who, { at: Date.now(), v }); if (ACCESS_MEMO.size > 5000) ACCESS_MEMO.clear(); }
  return v;
}
// What a member (not an admin) may do: their own swap and nothing else, and
// for OTD their own passes and games.
const MEMBER_OPS = new Set(['myhour', 'me', 'save', 'keep', 'touch', 'packstoday', 'scan', 'scanstatus', 'search', 'connect', 'whynot', 'hourcounts', 'wantcounts', 'report', 'myswaps', 'dropwant', 'pause', 'endall', 'saveslots']);
const OTD_OPS = new Set(['me', 'scan', 'scanstatus', 'games', 'boostplan']);
const BOOST_OPS = new Set(['me', 'scan', 'scanstatus', 'boostplan', 'boostdays', 'projections', 'boostinv', 'buys', 'legboosts', 'resell', 'nosell']);
const BOOSTS_OPEN = true;   // opened to everyone signed in, 2026-11-02
const PAGE_OPS = new Set(['projections', 'me', 'procheck', 'myswaps', 'hourcounts', 'wantcounts', 'boostplan', 'boostinv', 'buys', 'legboosts', 'resell', 'boostdays']);

/* ---- OTD: saved game lists ------------------------------------------------
   Every player's [MM-DD, rax] list for a whole sport-season, built once from
   the game log and kept in KV. A finished season never changes, so its copy
   is kept for good; a season still being played is rebuilt once a day (after
   the morning sweep has added the new games). */
const OTD_LIVE = new Set(['nba:2027', 'ncaam:2027', 'nfl:2026', 'ncaaf:2026', 'nhl:2026', 'soccer:2026', 'golf:2026']);
export async function otdSeason(env, db, sp, se, force) {
  const job = `${sp}:${se}`, key = 'otdseason_v1_' + job;
  let c = null;
  if (!force) { try { c = JSON.parse((await env.RATEBOARD_KV.get(key)) || 'null'); } catch (e) {} }
  if (c && c.games && (!OTD_LIVE.has(job) || Date.now() - c.at < 24 * 3600000)) return c.games;
  const games = {};
  try {
    const r = await db.prepare(`SELECT playerId, substr(day, 6, 5) AS d, rax FROM gamelog
      WHERE sport=? AND season=? AND rax > 0`).bind(sp, se).all();
    for (const x of (r.results || [])) (games[x.playerId] = games[x.playerId] || []).push([x.d, x.rax]);
  } catch (e) { return (c && c.games) || {}; }
  try { await env.RATEBOARD_KV.put(key, JSON.stringify({ at: Date.now(), games })); } catch (e) {}
  return games;
}

/* Boosts: current season and the one before, per sport (Real's numbering). */
const BOOST_SEASON = { ncaam: [2027, 2026], ncaaf: [2026, 2025], nfl: [2026, 2025] };
/* Booster thresholds on projected rax for the game, per sport, set from
   last season's rax per game among regulars: Legendary is roughly the top
   2-3% of games, Epic the top 10%, Rare the top 25%. Boost saver raises the
   bar 15%, earning heavy lowers it 15%. */
const BOOST_BARS = { ncaam: [11.5, 10, 7.5], ncaaf: [25, 20, 12], nfl: [19, 15, 8.5], golf: [19, 15, 10] };   // Legendary ~top 1% game, Epic ~top 3-5%
const BOOST_MODES = { balanced: 1, heavy: 1, saver: 1, custom: 1 };
const ESPN_PATH = { ncaam: 'basketball/mens-college-basketball', ncaaf: 'football/college-football', nfl: 'football/nfl' };
const ESPN_GROUP = { ncaam: '&groups=50', ncaaf: '&groups=80', nfl: '' };
// Where Real's team code differs from ESPN's.
const BOOST_ALIAS = { WISC: 'WIS', NCST: 'NCSU', BUT: 'BTLR', BSU: 'BOIS', AFA: 'AF', BUFF: 'BUF', HP: 'HPU', CHIC: 'CHST',
  CAMP: 'CAM', CLEV: 'CLE', ALB: 'UALB', IUPU: 'IUIN', ULL: 'UL', PRE: 'PRES', UALR: 'LR', SCUP: 'UPST', TAMC: 'AMCC',
  HBU: 'HCU', NIAG: 'NIA', DXST: 'UTU', IND: 'IU', JVST: 'JXST', WAS: 'WSH' };
const boostAlias = (sp, t) => BOOST_ALIAS[t] || t;
/* Schedules, injury reports and depth charts are fetched by the daily
   refresh (boostRefresh, on the collector tick) and saved; a member's request
   only reads the saved copies. Only if a copy is missing altogether is it
   fetched once, and saved for everyone. */
async function boostSchedule(env, sp, day, force) {
  const key = `boostsched_v2_${sp}_${day}`;
  if (!force) { try { const c = JSON.parse((await env.RATEBOARD_KV.get(key)) || 'null'); if (c) return c; } catch (e) {} }
  let d;
  try {
    const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${ESPN_PATH[sp]}/scoreboard?dates=${day.replace(/-/g, '')}&limit=500${ESPN_GROUP[sp]}`);
    if (!r.ok) return { error: 'Could not load the schedule (' + r.status + ').' };
    d = await r.json();
  } catch (e) { return { error: 'Could not load the schedule.' }; }
  const teams = {};
  let games = 0;
  for (const ev of (d.events || [])) {
    const c = (ev.competitions || [])[0]; if (!c) continue;
    const cs = c.competitors || []; if (cs.length !== 2) continue;
    games++;
    for (const [i, x] of cs.entries()) {
      const t = x.team || {}, o = (cs[1 - i] || {}).team || {};
      if (t.abbreviation) teams[t.abbreviation] = { id: t.id || null, opp: o.shortDisplayName || o.abbreviation || '', oppAb: o.abbreviation || null, home: x.homeAway === 'home', at: ev.date || null };
    }
  }
  const out = { at: Date.now(), games, teams };
  try { await env.RATEBOARD_KV.put(key, JSON.stringify(out), { expirationTtl: 5 * 86400 }); } catch (e) {}
  return out;
}

/* The daily refresh: at 10am and 5pm Eastern, today's and the next three
   days' schedules, the three injury reports and every NFL depth chart for the
   teams on those slates are fetched again and saved - a handful of requests
   per collector tick until the list is done. Nothing here touches D1. */
/* How much each opponent gives up: the average rax of players who faced
   them (last season's regular season and this season so far), against the
   average for everyone, pulled toward 1 when the sample is small and kept
   between 0.85 and 1.15. Built once a day by the refresh; keyed by ESPN code. */
async function boostMatchups(env, sp) {
  const db = env.RATEBOARD_DB; if (!db) return;
  const [se, prev] = BOOST_SEASON[sp];
  const minSql = sp === 'ncaam' ? ' AND min >= 10' : '';
  let rows = [];
  try { rows = (await db.prepare(`SELECT opponent AS o, AVG(rax) AS a, COUNT(*) AS n FROM gamelog
      WHERE sport=? AND season IN (?, ?) AND seasonType='regularseason' AND rax > 0${minSql} AND opponent IS NOT NULL GROUP BY opponent`).bind(sp, se, prev).all()).results || []; } catch (e) { return; }
  const tot = rows.reduce((t, r) => t + r.a * r.n, 0), n = rows.reduce((t, r) => t + r.n, 0);
  if (!n) return;
  const mean = tot / n, K = sp === 'ncaam' ? 300 : 150, f = {};
  for (const r of rows) {
    const raw = r.a / mean, w = r.n / (r.n + K);
    f[boostAlias(sp, r.o)] = Math.round(Math.min(1.15, Math.max(0.85, 1 + (raw - 1) * w)) * 100) / 100;
  }
  try { await env.RATEBOARD_KV.put('boostmatch_v1_' + sp, JSON.stringify({ at: Date.now(), f }), { expirationTtl: 5 * 86400 }); } catch (e) {}
}

const BOOST_REFRESH_HOURS = [10, 13, 17, 20];   // ET: injuries, slates, depth charts (13 and 20 added 2026-11-04)
const BOOST_REFRESH_KEY = 'boostrefresh_v2';
export async function boostRefresh(env) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false });
  const o = Object.fromEntries(f.formatToParts(new Date()).map(x => [x.type, x.value]));
  const hour = Number(o.hour) % 24, today = `${o.year}-${o.month}-${o.day}`;
  const slot = BOOST_REFRESH_HOURS.filter(h => hour >= h).pop();
  if (slot == null) return null;
  const run = `${today}@${slot}`;
  let st = null;
  try { st = JSON.parse((await env.RATEBOARD_KV.get(BOOST_REFRESH_KEY)) || 'null'); } catch (e) {}
  if (st && st.run === run && st.done) return null;
  if (!st || st.run !== run) {
    const days = [0, 1, 2, 3].map(i => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(new Date(Date.now() + i * 86400000)));
    const steps = [];
    for (const sp of Object.keys(BOOST_SEASON)) { steps.push(['inj', sp]); for (const d of days) steps.push(['sched', sp, d]); }
    steps.push(['depthlist']);
    for (const sp of Object.keys(BOOST_SEASON)) steps.push(['match', sp]);
    steps.push(['rosterlist']);
    st = { run, steps, i: 0, done: false };
  }
  let n = 0;
  while (st.i < st.steps.length && n < (st.steps[st.i][0] === 'roster' ? 12 : 6)) {
    const [k, a, b] = st.steps[st.i];
    try {
      if (k === 'inj') await boostInjuries(env, a, true);
      else if (k === 'sched') await boostSchedule(env, a, b, true);
      else if (k === 'depthlist') {
        // Every NFL team on the saved slates, one depth chart per step.
        const ids = new Set();
        for (const s of st.steps) if (s[0] === 'sched' && s[1] === 'nfl') {
          try { const c = JSON.parse((await env.RATEBOARD_KV.get(`boostsched_v2_nfl_${s[2]}`)) || 'null'); if (c) Object.values(c.teams).forEach(t => t.id && ids.add(t.id)); } catch (e) {}
        }
        for (const id of ids) st.steps.push(['depth', id]);
      }
      else if (k === 'depth') await boostDepth(env, null, true, [a]);
      else if (k === 'match') await boostMatchups(env, a);
      else if (k === 'rosterlist') {
        // CBB rosters for every team on the saved slates, refreshed weekly.
        const ids = new Set();
        for (const s2 of st.steps) if (s2[0] === 'sched' && s2[1] === 'ncaam') {
          try { const c = JSON.parse((await env.RATEBOARD_KV.get(`boostsched_v2_ncaam_${s2[2]}`)) || 'null'); if (c) Object.values(c.teams).forEach(t => t.id && ids.add(String(t.id))); } catch (e) {}
        }
        let have = {};
        try { have = (JSON.parse((await env.RATEBOARD_KV.get('boostrostermap_v1_ncaam')) || 'null') || {}).teams || {}; } catch (e) {}
        for (const id of ids) if (!have[id] || Date.now() - have[id] > 7 * 86400000) st.steps.push(['roster', id]);
        st.steps.push(['rostermerge']);
        st.rosterIds = [...ids];
      }
      else if (k === 'roster') {
        try {
          const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/teams/${a}/roster`);
          const d = r.ok ? await r.json() : null;
          if (d) {
            const ab = (d.team || {}).abbreviation || null;
            const list = (d.athletes || []).map(x => ({ n: boostName(x.displayName), pos: (x.position || {}).abbreviation || '', yr: (x.experience || {}).years ?? null }));
            await env.RATEBOARD_KV.put('boostroster_v1_' + a, JSON.stringify({ at: Date.now(), ab, list }), { expirationTtl: 30 * 86400 });
          }
        } catch (e) {}
      }
      else if (k === 'rostermerge') {
        let cur = {};
        try { cur = JSON.parse((await env.RATEBOARD_KV.get('boostrostermap_v1_ncaam')) || 'null') || {}; } catch (e) {}
        const m = cur.m || {}, teams = cur.teams || {};
        for (const id of (st.rosterIds || [])) {
          try { const c = JSON.parse((await env.RATEBOARD_KV.get('boostroster_v1_' + id)) || 'null');
            if (c && c.ab) { teams[id] = c.at; for (const x of c.list) m[x.n] = { ab: c.ab, pos: x.pos, yr: x.yr }; } } catch (e) {}
        }
        await env.RATEBOARD_KV.put('boostrostermap_v1_ncaam', JSON.stringify({ at: Date.now(), m, teams }), { expirationTtl: 30 * 86400 });
      }
    } catch (e) {}
    st.i++; n++;
  }
  st.done = st.i >= st.steps.length;
  try { await env.RATEBOARD_KV.put(BOOST_REFRESH_KEY, JSON.stringify(st), { expirationTtl: 3 * 86400 }); } catch (e) {}
  return st.done ? 'boosts refreshed' : `boosts refresh ${st.i}/${st.steps.length}`;
}

/* A member's boosters from Real (userpassboostercards, collectionstats):
   each is a rarity (Rare 10x, Epic 15x, Legendary 25x) on one stat, with a
   boost value per stat and how many they hold. Kept 30 minutes. */
async function boostInventory(env, tok, hashId, sp, fresh) {
  const all = await boostInventoryAll(env, tok, hashId, fresh);
  if (all.error) return all;
  return { at: all.at, next: all.next, list: (all.sports || {})[sp] || [] };
}
/* All four sports' boosters (CBB, CFB, NFL, golf) in one read, at most once every 4 hours per
   member; inside that the saved copy is used. */
const BOOSTINV_EVERY = 2 * 3600000;
// Members whose pass and booster reads on Boosts are never held back.
const BOOST_FAST = new Set(['quas23']);
async function boostInventoryAll(env, tok, hashId, fresh, admin) {
  const key = `boostinv_v6_${hashId}`;   // v6: golf added (2026-11-05)
  let c = null;
  try { c = JSON.parse((await env.RATEBOARD_KV.get(key)) || 'null'); } catch (e) {}
  if (c && (!fresh || (!admin && Date.now() - c.at < BOOSTINV_EVERY))) return { ...c, next: admin ? Date.now() : c.at + BOOSTINV_EVERY, cached: !!fresh };
  const sports = {};
  for (const sp of [...Object.keys(BOOST_SEASON), 'golf']) {
    let d;
    try { d = await rsGetJson(`https://web.realapp.com/userpassboostercards/undefined/entity/player?displayType=collectionstats&sport=${sp}&userId=${encodeURIComponent(hashId)}&version=stat`, tok); }
    catch (e) { if (c) return { ...c, next: c.at + BOOSTINV_EVERY }; return { error: 'Could not read your boosters from Real: ' + String(e.message || e).slice(0, 120) }; }
    const list = [];
    for (const g of (((d && d.boosterCardInfo) || {}).rarityGroups || [])) {
      const mult = parseFloat(String(g.multiplierDisplay || '').replace(/x$/i, '')) || null;
      for (const k of (g.statBoostKeyInfo || [])) {
        // Football boosters carry two attributes (one offensive, one defensive).
        const attrs = (k.info || []).map(i => ({ stat: String(i.label || ''), boost: parseFloat(i.boostValue) || 0 })).filter(a => a.stat);
        list.push({ rarity: Number(g.rarity), label: String(g.label || ''), mult, key: String(k.statBoostKey), attrs,
          stat: attrs.map(a => a.stat).join(' / '), boost: attrs.length ? attrs[0].boost : 0, count: Number(k.count) || 0 });
      }
    }
    sports[sp] = list;
    await sleep(700);
  }
  const out = { at: Date.now(), sports };
  try { await env.RATEBOARD_KV.put(key, JSON.stringify(out), { expirationTtl: 30 * 86400 }); } catch (e) {}
  return { ...out, next: out.at + BOOSTINV_EVERY };
}
/* Per-stat bars for basketball (a starter's per-game average, last season):
   [top 10%, top 25%, median] - boost saver needs the first, balanced the
   second, earning heavy the third. */
const STAT_BARS = { PTS: [15.8, 12.7, 9.5], REB: [6.3, 4.9, 3.6], AST: [3.8, 2.4, 1.6], STL: [1.4, 1.1, 0.8], BLK: [1.0, 0.6, 0.3], '3PM': [2.5, 1.8, 1.0] };
const MODE_BAR = { saver: 0, balanced: 1, heavy: 2 };
/* Dennis's CBB top 175 for 2026-27 (player id -> [rank, team, his link]), used for newcomers
   with no college games: on the list they get a projection from their rank;
   off it they're listed below with "not enough data". */
const CBB_TOP175 = {"4711255":[1,"MSU","jxtRc6FPBpw9"],"5187600":[2,"VAN","aetecRFBODGq"],"5142731":[3,"KU","d6tOcgFRggge/2027","Tyran Stokes"],"5080489":[4,"FLA","6qt4cvFjPmNG"],"5174657":[5,"FLA","Plt1cDF5kJ66"],"5106275":[6,"TA&M","8wtpcOFbqPE9"],"5044426":[7,"LOU","NGtrcgFLWgPo"],"5103630":[8,"DUKE","A7tmc1FJ4gmr"],"5142609":[9,"TENN","ObtEc8FwmmD4"],"4858604":[10,"NEB","8wtpcOFbWbR3"],"5060709":[11,"BYU","GxtacOF4w8e0"],"5095152":[12,"SJU","5mt6c5FpL2O4"],"5054083":[13,"CONN","jxtRc6FPWd6m"],"5142722":[14,"ARIZ","jxtRc6FPRRRL/2027","Caleb Holt"],"5347090":[15,"DUKE","5mt6c5Fpyj4O/2027","Joaquim Boumtje Boumtje"],"5142715":[16,"MIZ","19tbcKF4kkvp/2027","Jason Crowe Jr."],"5311832":[17,"ILL","xwtYcEFLJWRv"],"5101833":[18,"ALA","wWtlcNFW7Mbg"],"4869764":[19,"MICH","m3t8cxFy209J"],"4873209":[20,"DUKE","2at8cpFrN62o"],"5164368":[21,"TEX","5mt6c5FpNP6r"],"5142729":[22,"ARK","k3t1cvFbddd0/2027","Jordan Smith Jr."],"4848637":[23,"UK","7vtWcRFD63ab"],"4684634":[24,"USC","0ytNcgFGq3AJ"],"5174954":[25,"ARIZ","19tbcKF4kJog"],"5210407":[26,"DUKE","aetecRFBYMpk/2027","Cameron Williams"],"5174971":[27,"FLA","NGtrcgFLJ2GQ"],"5311846":[28,"UVA","Rqt3c3FkpPJW"],"5196916":[29,"CONN","5mt6c5FpRrLY"],"4894445":[30,"GONZ","0ytNcgFG71LV"],"5239838":[31,"TEX","WbtlcDFOybqe"],"5101809":[32,"MIA","LxtJcmFNWJj9"],"4873184":[33,"IU","KYtEc1F3gxG8"],"5254159":[34,"TEX","4Pt5cQFaYGm3"],"4712832":[35,"COLO","bYtLcMFJbjGq"],"5175007":[36,"ILL","wWtlcNFWxgWm"],"5177233":[37,"UNC","optxcAFl5bG1"],"5174955":[38,"ASU","2at8cpFr4oRg"],"5238195":[39,"FLA","m3t8cxFy71LG"],"5144105":[40,"MIA","jxtRc6FPRalw"],"5311896":[41,"ARIZ","A7tmc1FJ840g"],"5144495":[42,"USC","LxtJcmFNL1vW"],"5143604":[43,"TTU","aetecRFBOOm5"],"4873093":[44,"HOU","95tbclFJKYNr"],"5144108":[45,"BAY","3AtwcWF7lxaN"],"5060732":[46,"ARK","Rqt3c3FkPpxA"],"5241360":[47,"ISU","6qt4cvFjYdLr"],"5101623":[48,"IU","Rqt3c3FkPMgl"],"4873219":[49,"USC","A7tmc1FJRPAd"],"5101849":[50,"UK","extmcdFMpYK1"],"4845361":[51,"LOU","jxtRc6FP1E27"],"4684276":[52,"ALA","k3t1cvFb4BG8"],"5060700":[53,"HOU","NGtrcgFLWBQM"],"5149078":[54,"MICH","aetecRFBOw80"],"4711256":[55,"DUKE","pgt3cvFNAvYo"],"5165276":[56,"ARK","Jltrc5FG58V8"],"5060705":[57,"UK","8wtpcOFbqoJb"],"5150404":[58,"UVA","5mt6c5FpN103"],"5060685":[59,"KU","NGtrcgFLWBQ7"],"5312258":[60,"TENN","Rqt3c3FkpPy8"],"5105534":[61,"MICH","DBtPcRFW2K96"],"5174952":[62,"USC","4Pt5cQFaNVj8"],"4869770":[63,"SJU","Rqt3c3FkLqV6"],"5311991":[64,"ILL","gQtVcRFyQk35"],"4872740":[65,"MSU","95tbclFJKPON"],"4683680":[66,"XAV","B5t7coFVdG8q"],"4845373":[67,"TENN","0ytNcgFG9bkL"],"5238184":[68,"IU","95tbclFJmjy9"],"5093142":[69,"MICH","LxtJcmFNWAmj"],"5214642":[70,"ILL","YBtWcOFL6wVR"],"5174609":[71,"TENN","5mt6c5FpNY7j"],"5105527":[72,"FLA","bYtLcMFJpV15"],"4684270":[73,"GTWN","pgt3cvFNWmL9"],"5175021":[74,"VAN","5mt6c5FpNjbe"],"4683769":[75,"VILL","8wtpcOFbAKWW"],"5144086":[76,"MARQ","95tbclFJ4m5D"],"5311928":[77,"TCU","EGt3cMFw9N3D"],"5144479":[78,"KU","optxcAFl519e/2027"],"5217192":[79,"USC","pgt3cvFNkWeL/2027"],"5082704":[80,"ALA","WbtlcDFON46L"],"4895783":[81,"WISC","yktdcvFBKN44"],"4873089":[82,"AUB","EGt3cMFwxg2w"],"5079838":[83,"ISU","Plt1cDF5gqKK"],"5239571":[84,"NEB","B5t7coFV474l"],"5174665":[85,"ILL","KYtEc1F3LyP3"],"5037881":[86,"MIZ","KYtEc1F3VGxg"],"5105552":[87,"SMU","KYtEc1F3VbwK"],"5238203":[88,"MIA","jxtRc6FPawQl"],"5313054":[89,"VAN","aetecRFBbOkJ"],"4848619":[90,"WVU","EGt3cMFw01MP"],"5238207":[91,"BYU","A7tmc1FJbQEm"],"5060712":[92,"TENN","LxtJcmFNWpxK"],"5311844":[93,"UVA","gQtVcRFyQkWP"],"5311829":[94,"UNC","95tbclFJgLVm"],"5240980":[95,"TEX","gQtVcRFyMDd8"],"5240529":[96,"MSU","5mt6c5FpRlwQ"],"4683944":[97,"TENN","xwtYcEFLwmbj"],"5311502":[98,"TEX","LxtJcmFNpWbG"],"5177122":[99,"LOU","Rqt3c3FkVWg7"],"4869777":[100,"LOU","Plt1cDF50yk2"],"5315585":[101,"MD","B5t7coFVv4Am"],"5258494":[102,"WVU","jxtRc6FPaqG3"],"5177275":[103,"MISS","A7tmc1FJVDP4"],"5107312":[104,"WASH","LxtJcmFNWGov"],"5185443":[105,"ARK","r8t4c1FempjN/2027"],"5311903":[106,"GONZ","yktdcvFBYk15"],"5142356":[107,"PITT","wWtlcNFWxxLd"],"5248302":[108,"ISU","Plt1cDF5Wa7a"],"5041949":[109,"MIZ","r8t4c1FeWJqK"],"5174291":[110,"IU","k3t1cvFbdKQE"],"5176310":[111,"NEB","NGtrcgFLJ261"],"5101766":[112,"ARIZ","2at8cpFr7y6l"],"5041958":[113,"MIZ","aetecRFBkae4"],"5105577":[114,"CREI","2at8cpFr758d"],"4838704":[115,"ISU","2at8cpFrG9xq"],"5175952":[116,"PROV","r8t4c1FemK9A"],"5060696":[117,"PROV","EGt3cMFwNEoV"],"5292602":[118,"CONN","8wtpcOFbowmo"],"4873086":[119,"HOU","extmcdFMmwB7"],"5196913":[120,"GONZ","KYtEc1F3doVD"],"5313012":[121,"GONZ","WbtlcDFO76mk"],"5311967":[122,"MARQ","5mt6c5FpyLOV"],"5175058":[123,"PROV","2at8cpFr4ovW"],"5313560":[124,"CREI","r8t4c1FejmD8"],"5176232":[125,"UVA","4Pt5cQFaNVGw"],"5176359":[126,"NCST","8wtpcOFbxB5E"],"5314225":[127,"KU","vVt1cbFQLmw2"],"5041954":[128,"MICH","NGtrcgFLW9Vx"],"5287474":[129,"DUKE","19tbcKF4Yr5K"],"5176309":[130,"DUKE","d6tOcgFRgwQ5"],"4873111":[131,"MSU","Met5ckFx1v2r"],"4895776":[132,"VILL","A7tmc1FJRYBp"],"5144166":[133,"VAN","wWtlcNFWxo2q"],"5226071":[134,"ISU","LxtJcmFN1WpW"],"5196931":[135,"MSU","WbtlcDFOyL6r"],"5217196":[136,"ISU","Plt1cDF5WvBD"],"5108093":[137,"HOU","6qt4cvFjPVoj"],"5152763":[138,"USC","optxcAFl5yV9"],"5060730":[139,"IU","gQtVcRFykQa4"],"4711400":[140,"UK","Rqt3c3FkQL0K"],"5144097":[141,"ARIZ","m3t8cxFy97l2"],"4685687":[142,"MIZ","r8t4c1FeQxAg"],"5210802":[143,"TEX","Jltrc5FG6y2D/2027"],"4873181":[144,"UNC","NGtrcgFLVgpb"],"5196877":[145,"UNC","EGt3cMFwEBLQ"],"5177211":[146,"LOU","xwtYcEFLG1Vp"],"4685654":[147,"MIZ","wWtlcNFWRJNQ"],"4873183":[148,"UK","0ytNcgFG7ymO"],"5103631":[149,"NEB","Plt1cDF5gbyq"],"5242127":[150,"LOU","NGtrcgFLBa6q"],"5176481":[151,"IOWA","GxtacOF4g97l"],"5095154":[152,"VAN","extmcdFMpd57"],"5221321":[153,"UCLA","NGtrcgFLBdOB"],"5238200":[154,"FLA","Jltrc5FG61YV"],"5214635":[155,"SJU","GxtacOF4PamO/2027"],"4895753":[156,"CONN","95tbclFJK0ar"],"5101798":[157,"MSU","yktdcvFBkWlQ"],"5176315":[158,"SJSU","8wtpcOFbxB9E"],"5177227":[159,"LOU","jxtRc6FPR05B"],"5142719":[160,"ARIZ","Jltrc5FG55p3/2027"],"5107804":[161,"PROV","Met5ckFxJBVg"],"5106280":[162,"TULN","r8t4c1FeWG92"],"5144554":[163,"ALA","LxtJcmFNL15Y/2027"],"5144124":[164,"CONN","GxtacOF4gPQK"],"5142709":[165,"MIA","WbtlcDFO66Nw"],"5307569":[166,"ILL","3AtwcWF7k5pW/2027"],"5142723":[167,"MIA","pgt3cvFNwww3/2027"],"5177188":[168,"PROV","r8t4c1FemaRm"],"5314722":[169,"PORT","ObtEc8Fw2VxB"],"5105569":[170,"XAV","VjtqcVFeG3Dv"],"5240539":[171,"SJU","yktdcvFBJPWb"],"5174935":[172,"MIA","extmcdFMqo2Q"],"5454840":[173,"UK","xwtYcEFLvLyr/2027"]};
/* Dennis's CBB boost order: these always go first, in this order, and get
   at least the rarity shown (5 Legendary, 4 Epic) whatever their projection,
   as long as they're playing and not hurt. */
const CBB_PIN = { 4711255: [1, 5], 5187600: [2, 5], 5080489: [3, 5], 5142731: [4, 4], 4858604: [5, 4] };   // Fears, Tanner, Haugh, Stokes, Sandfort
// Player shots Dennis made for the Buys list (img/cbb/<id>.png).
/* Legendary boosts. Daily packs are Dennis's four (the team card's numbers are
   his: team packs aren't in pack data); weekly packs are his gallery. CFB
   season is the year it starts (2025 = 2025-26). */
const LEG_KEY = 'legboost_stats_v1';
const LEG_DAILY = [
  { name: 'Eric Weatherly', season: 2025, id: 505394 },
  { name: 'Sam Jackson V', season: 2025, id: 228721 },
  { name: 'Kiael Kelly', season: 2025, id: 220706 },
  { name: 'Ball State team card', season: 2025, team: 'ball st', teamVia: 220706, odds: 0.90, boost: 23.8 }   // teamVia: a Ball State player, to find the team's id
];
const LEG_WEEKLY = [
  { name: 'Michael Johnson Jr.', season: 2025, id: 570465 }, { name: 'Donovan Hamilton', season: 2025, id: 523814 },
  { name: 'Ty Robinson', season: 2025, id: 203781 },        { name: 'Koby Gross', season: 2025, id: 212712 },
  { name: 'Qian Magwood', season: 2025, id: 470499 },      { name: 'Malcolm Gillie', season: 2025, id: 511372 },
  { name: 'Elijah Owens', season: 2026, id: 584060 },      { name: 'DJ Williams', season: 2026, id: 595598 },
  { name: 'Erik Sandvik', season: 2026, id: 501184 },      { name: 'Jeremiah Beck', season: 2026, id: 554256 },
  { name: 'Xavier Terrell', season: 2024, id: 515055 },    { name: 'Isaiah Hankins', season: 2024, id: 224067 },
  { name: 'Jack Sawyer', season: 2024, id: 207626 }
];
// The pack data tab's sums: a pack is 3 of a player's card plays, its booster matches the best card.
const legFrom = (a, n) => n < 3 || a < 3 ? 0 : (a * (a - 1) * (a - 2)) / (n * (n - 1) * (n - 2));
function packOdds(n, k) { n = Number(n) || 0; k = Number(k) || 0; if (k <= 0 || n < 3) return 0; if (k > n - 3) return 1; return 1 - ((n - k) * (n - k - 1) * (n - k - 2)) / (n * (n - 1) * (n - 2)); }
function avgBooster(r) {
  const n = Number(r.plays) || 0; if (n < 3) return null;
  const ic = Number(r.iconic) || 0, my = Number(r.mystic) || 0, lg = Number(r.legendary) || 0, ep = Number(r.epic) || 0;
  const low = Math.max(0, n - ic - my - lg - ep), M = [10, 15, 25, 50, 100];
  const up = [low, low + ep, low + ep + lg, low + ep + lg + my, n].map(a => a >= n ? 1 : legFrom(a, n));
  let prev = 0, out = 0; for (let i = 0; i < 5; i++) { out += (up[i] - prev) * M[i]; prev = up[i]; } return out;
}
const CBB_SHOTS = new Set([4711255, 5187600, 5080489, 5174657, 5106275, 5044426, 5103630, 5142609, 4858604, 5060709, 5095152, 5054083, 5142722, 5142715, 5311832, 5101833, 4869764, 4873209, 5142731, 5347090, 5164368, 5142729, 4848637, 4684634, 5174954, 5210407, 5174971, 5311846, 5196916, 4894445, 5239838, 5101809, 5254159, 4873184, 4712832, 5175007, 5177233, 5174955, 5238195, 5144105, 5311896, 5144495, 4873093, 5144108, 5060732, 5241360, 5101623, 4873219, 5101849, 4845361, 4684276, 5060700, 5149078, 4711256, 5165276, 5060705, 5150404, 5060685, 5312258, 5105534, 5174952, 4869770, 5311991, 4872740, 4683680, 4845373, 5238184, 5093142, 5214642, 5143604]);
const FRESH_LINE = { PTS: 11, REB: 4.5, AST: 2, STL: 0.9, BLK: 0.5, '3PM': 1.3 };
const STAT_COL = { PTS: 'pts', REB: 'reb', AST: 'ast', STL: 'stl', BLK: 'blk' };
const statKey = x => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const DEF_POS = /^(DB|CB|S|FS|SS|LB|ILB|OLB|MLB|DL|DE|DT|NT|EDGE|DEF)$/i;
const DEF_STAT = new Set(['INT', 'TKL', 'SACK', 'FF', 'TFL']);
// Real's football booster attributes, read off the stored stat line.
function footStat(o, stat, pos) {
  const n = v => { const m = String(v == null ? '' : v).match(/^-?\d+(\.\d+)?/); return m ? Number(m[0]) : 0; };
  const def = DEF_POS.test(String(pos || ''));
  if (DEF_STAT.has(stat) !== def && !(stat === 'FGM')) return null;      // the other side's attribute
  switch (stat) {
    case 'TKL': return n(o.solo) + n(o.ast);
    case 'SACK': return n(o.sack);
    case 'INT': return n(o.int);
    case 'FF': return n(o.ff);
    case 'TFL': return n(o.tfl);
    case 'TD': return o.td != null ? n(o.td) : n(o.rutd) + n(o.retd);
    case 'PTD': return n(o.ptd);
    case 'RUYDS': return n(o.ruyds);
    case 'REC': return n(o.rec);
    case 'FGM': return o['fg%'] != null ? n(o['fg%']) : null;
    default: { const w = statKey(stat); for (const [k, v] of Object.entries(o)) if (statKey(k) === w) return n(v); return 0; }
  }
}
const statOf = (row, stat) => {
  if (stat === '3PM') { const m = String(row.fg3 || '').match(/^(\d+)/); return m ? Number(m[1]) : (row.fg3 == null ? null : 0); }
  const c = STAT_COL[stat]; if (c && row[c] != null) return Number(row[c]);
  // Football: the sport's own stat line.
  if ('stats' in row) {
    let o = row._s; if (o === undefined) { try { o = JSON.parse(row.stats || '{}'); } catch (e) { o = {}; } row._s = o; }
    return footStat(o || {}, stat, row.position);
  }
  return null;
};
const boostName = n => String(n || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, '').replace(/[^a-z]/g, '');
// ESPN's injury report for the sport, by player name. Kept 2 hours. Entries
// older than 30 days are dropped (the college lists carry years-old ones).
async function boostInjuries(env, sp, force) {
  const key = `boostinj_v1_${sp}`;
  if (!force) { try { const c = JSON.parse((await env.RATEBOARD_KV.get(key)) || 'null'); if (c) return c.map; } catch (e) {} }
  const map = {};
  try {
    const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${ESPN_PATH[sp]}/injuries`);
    const d = r.ok ? await r.json() : {};
    for (const t of (d.injuries || [])) for (const x of (t.injuries || [])) {
      if (!x.athlete || !x.status || /^active$/i.test(x.status)) continue;
      if (x.date && Date.now() - Date.parse(x.date) > 30 * 86400000) continue;
      map[boostName(x.athlete.displayName)] = { status: x.status, note: String(x.shortComment || '').slice(0, 140) };
    }
  } catch (e) {}
  try { await env.RATEBOARD_KV.put(key, JSON.stringify({ at: Date.now(), map }), { expirationTtl: 3 * 86400 }); } catch (e) {}
  return map;
}
/* Each team's own injury list, from its ESPN roster (2026-11-04: the league
   list ESPN publishes missed Lamar Jackson, out for the season, so he was
   still given a booster). Kept 2 hours per team, then read again the next
   time someone loads their boosts. */
async function boostTeamInj(env, sp, ids, force) {
  const out = {};
  await Promise.all([...new Set(ids.filter(Boolean).map(String))].slice(0, 40).map(async id => {
    const key = `boostteaminj_v1_${sp}_${id}`;
    let m = null;
    if (!force) { try { const c = JSON.parse((await env.RATEBOARD_KV.get(key)) || 'null'); if (c && Date.now() - c.at < 2 * 3600000) m = c.m; } catch (e) {} }
    if (!m) {
      try {
        const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${ESPN_PATH[sp]}/teams/${id}/roster`);
        const d = r.ok ? await r.json() : null;
        if (d) {
          m = {};
          const items = (d.athletes || []).flatMap(g => Array.isArray(g.items) ? g.items : [g]);
          for (const a of items) {
            if (!a || !a.displayName) continue;
            const ij = (a.injuries || []).slice().sort((x, y) => Date.parse(y.date || 0) - Date.parse(x.date || 0))[0];
            if (ij && ij.status && !/^active$/i.test(ij.status)) m[boostName(a.displayName)] = { status: String(ij.status), note: '' };
          }
          try { await env.RATEBOARD_KV.put(key, JSON.stringify({ at: Date.now(), m }), { expirationTtl: 86400 }); } catch (e) {}
        }
      } catch (e) {}
      if (!m) { try { const c = JSON.parse((await env.RATEBOARD_KV.get(key)) || 'null'); if (c) m = c.m; } catch (e) {} }
    }
    if (m) Object.assign(out, m);
  }));
  return out;
}
/* NFL depth charts for the teams on the slate, by player name: slot 1 is the
   starter (top two at RB, three WRs). Kept 6 hours per team. */
async function boostDepth(env, sched, force, only) {
  const out = {};
  // Every team at once (one after another took seconds on a full Sunday).
  const ms = await Promise.all([...new Set(only || Object.values(sched.teams).map(t => t.id).filter(Boolean))].map(async id => {
    const key = `boostdepth_v1_${id}`;
    let m = null, old = null;
    if (!force) { try { const c = JSON.parse((await env.RATEBOARD_KV.get(key)) || 'null'); if (c) { old = c.m; if (Date.now() - (c.at || 0) < 6 * 3600000) m = c.m; } } catch (e) {} }
    if (m) return m;
    try {
      const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${id}/depthcharts`);
      if (!r.ok) return old || {};
      const d = await r.json(); m = {};
      for (const g of (d.depthchart || [])) for (const [pos, v] of Object.entries(g.positions || {})) {
        (v.athletes || []).forEach((a, i) => {
          const nm = boostName(a.displayName), slot = i + 1;
          const starter = slot === 1 || (pos === 'rb' && slot <= 2);
          const cur = m[nm];
          if (!cur || (starter && !cur.starter) || (!cur.starter && slot < cur.slot)) m[nm] = { pos, slot, starter };
        });
      }
    } catch (e) { return old || {}; }
    try { await env.RATEBOARD_KV.put(key, JSON.stringify({ at: Date.now(), m }), { expirationTtl: 3 * 86400 }); } catch (e) {}
    return m;
  }));
  for (const m of ms) Object.assign(out, m);
  return out;
}


/* ---- Golf boosts (2026-11-04) ----------------------------------------------
   Upcoming PGA Tour events from ESPN's calendar, each with its field once
   ESPN has it (usually the Tuesday before). A tournament is the "game". */
const GOLF_SEASON = [2026, 2025];
async function golfEvents(env, force) {
  const key = 'boostgolf_v1';
  if (!force) { try { const c = JSON.parse((await env.RATEBOARD_KV.get(key)) || 'null'); if (c && Date.now() - c.at < 2 * 3600000) return c.events; } catch (e) {} }
  const etDate = iso => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
  let d;
  try { const r = await fetch('https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard'); if (!r.ok) throw new Error(String(r.status)); d = await r.json(); }
  catch (e) { try { const c = JSON.parse((await env.RATEBOARD_KV.get(key)) || 'null'); if (c) return c.events; } catch (e2) {} return []; }
  const now = Date.now();
  const cal = (((d.leagues || [])[0] || {}).calendar || []).filter(c => c && c.startDate && Date.parse(c.endDate || c.startDate) > now - 12 * 3600000 && Date.parse(c.startDate) < now + 13 * 86400000);
  const fieldOf = ev => ((((ev.competitions || [])[0] || {}).competitors) || []).map(x => x.athlete && x.athlete.displayName).filter(Boolean);
  const events = [];
  for (const c of cal.slice(0, 3)) {
    let ev = (d.events || []).find(e => String(e.id) === String(c.id));
    if (!ev) { try { const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard?dates=${etDate(c.startDate).replace(/-/g, '')}`);
      if (r.ok) { const x = await r.json(); ev = (x.events || []).find(e => String(e.id) === String(c.id)) || (x.events || [])[0]; } } catch (e) {} }
    events.push({ id: String(c.id), name: c.label, start: c.startDate, end: c.endDate, day: etDate(c.startDate), field: ev ? fieldOf(ev) : [] });
  }
  try { await env.RATEBOARD_KV.put(key, JSON.stringify({ at: Date.now(), events }), { expirationTtl: 3 * 86400 }); } catch (e) {}
  return events;
}
const golfNorm = s => String(s || '').toLowerCase().replace(/\s+(pres\.?|presented)\s+by\s+.*$/, '').replace(/[^a-z0-9]+/g, ' ').trim();
/* One row per golf pass the member holds: form (last 8 events this season and
   last), and history at this event / this course from every season stored,
   weighed in by how many times he's played it (up to half the projection). */
async function golfRows(env, db, cards, day) {
  const events = await golfEvents(env);
  const ev = events.find(e => e.day === day) || events.find(e => e.day <= day && etDayOf(e.end) >= day);
  if (!ev) return { error: 'No PGA Tour event that week.' };
  const field = new Set(ev.field.map(boostName));
  let tours = [];
  try { tours = ((await db.prepare("SELECT season, gameId, name, course FROM tournament WHERE sport='golf'").all()).results) || []; } catch (e) {}
  const target = golfNorm(ev.name), tw = target.split(' ').filter(w => w.length > 3);
  let same = tours.filter(t => golfNorm(t.name) === target);
  if (!same.length && tw.length) same = tours.filter(t => { const w = new Set(golfNorm(t.name).split(' ')); return tw.filter(x => w.has(x)).length / tw.length >= 0.6; });
  const latest = same.slice().sort((a, b) => b.season - a.season)[0];
  const course = latest && latest.course;
  const histIds = [...new Set([...same.map(t => Number(t.gameId)), ...(course ? tours.filter(t => t.course === course).map(t => Number(t.gameId)) : [])])];
  const ids = [...new Set(cards.players.map(p => Number(p.id)).filter(Number.isFinite))];
  const recent = new Map(), hist = new Map();
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90), ph = part.map(() => '?').join(',');
    try { const r = await db.prepare(`SELECT playerId, player, team, day, rax, position FROM gamelog WHERE sport='golf' AND season IN (?, ?) AND rax IS NOT NULL AND day < ? AND playerId IN (${ph}) ORDER BY day DESC`)
        .bind(GOLF_SEASON[0], GOLF_SEASON[1], day, ...part).all();
      for (const x of (r.results || [])) { const a = recent.get(Number(x.playerId)) || recent.set(Number(x.playerId), []).get(Number(x.playerId)); if (a.length < 8) a.push(x); } } catch (e) {}
    if (histIds.length) {
      try { const r = await db.prepare(`SELECT playerId, player, season, rax, position FROM gamelog WHERE sport='golf' AND rax IS NOT NULL AND day < ? AND gameId IN (${histIds.map(() => '?').join(',')}) AND playerId IN (${ph})`)
          .bind(day, ...histIds, ...part).all();
        for (const x of (r.results || [])) (hist.get(Number(x.playerId)) || hist.set(Number(x.playerId), []).get(Number(x.playerId))).push(x); } catch (e) {}
    }
  }
  const rows = [], idle = [];
  const avg = a => a.length ? a.reduce((t, x) => t + Number(x.rax || 0), 0) / a.length : null;
  const posN = p => { const n = parseInt(String(p || '').replace(/^T/, ''), 10); return Number.isFinite(n) ? n : null; };
  for (const p of cards.players) {
    const rc = recent.get(Number(p.id)) || [], hs = hist.get(Number(p.id)) || [];
    const name = p.name || (rc[0] && rc[0].player) || (hs[0] && hs[0].player) || 'Player ' + p.id;
    if (ev.field.length && !field.has(boostName(name))) { idle.push(name); continue; }
    const form = avg(rc), cuts = rc.filter(x => String(x.position).toUpperCase() === 'CUT').length;
    const ha = avg(hs), hn = hs.length, best = hs.map(x => posN(x.position)).filter(x => x != null).sort((a, b) => a - b)[0];
    const w = hn ? Math.min(0.5, hn / (hn + 3)) : 0;
    let proj = form != null ? form * (1 - w) + (hn ? ha * w : 0) : hn ? ha : null;
    const flags = [];
    if (!ev.field.length) flags.push('Field not out yet');
    if (rc.length >= 4 && cuts >= Math.ceil(rc.length / 2)) flags.push(`Missed ${cuts} of his last ${rc.length} cuts`);
    const basis = [form != null ? `form ${Math.round(form * 10) / 10} over ${rc.length} event${rc.length === 1 ? '' : 's'}` : 'no recent events',
      hn ? `here ${Math.round(ha * 10) / 10} over ${hn} (best ${best != null ? (best === 1 ? 'win' : '#' + best) : '-'})` : 'no history here'].join(' · ');
    rows.push({ id: p.id, passId: p.passId, name, team: (rc[0] && rc[0].team) || null, tid: null, pos: '', opp: ev.name, home: true, at: ev.start, exp: {},
      avg: form == null ? null : Math.round(form * 10) / 10, games: rc.length, avgLast: hn ? Math.round(ha * 10) / 10 : null, course: hn ? { n: hn, avg: Math.round(ha * 10) / 10, best } : null,
      proj: proj == null ? null : Math.round(proj * 10) / 10, basis, flags, skip: false, fresh: false, noData: proj == null });
  }
  return { rows, idle, sched: { games: 1, event: ev.name, course: course || null, field: ev.field.length } };
}
const etDayOf = iso => iso ? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso)) : '';


/* ---- Projections (2026-11-05) ----------------------------------------------
   Each player's rax by the end of his regular season: what he has, plus his
   per-game projection (the Boosts formula) for each game his team has left,
   adjusted for that opponent. "On pace" is plain: rax / games played x the
   team's regular-season games. Rebuilt at most every 6 hours, kept in KV. */
const PROJ_SEASON = { ncaaf: [2026, 2025], nfl: [2026, 2025], ncaam: [2027, 2026], nba: [2027, 2026], nhl: [2026, 2025], soccer: [2026, 2025] };
const PROJ_PATH = { ...ESPN_PATH, nba: 'basketball/nba', nhl: 'hockey/nhl' };
// Real's team codes that ESPN writes differently.
const PROJ_ALIAS = { nba: { GSW: 'GS', NOP: 'NO', NYK: 'NY', SAS: 'SA', UTA: 'UTAH', WAS: 'WSH' }, nhl: { LAK: 'LA', NJD: 'NJ', SJS: 'SJ', TBL: 'TB', UTA: 'UTAH' } };
const projAlias = (sp, t) => (PROJ_ALIAS[sp] && PROJ_ALIAS[sp][t]) || boostAlias(sp, t);
// Daily schedules: [first day, last regular-season day, ESPN extra].
const PROJ_DAYS = { ncaam: ['2026-11-01', '2027-03-08', '&groups=50&limit=500'], nba: ['2026-10-15', '2027-04-20', '&limit=100'], nhl: ['2026-10-01', '2027-04-22', '&limit=100'] };
/* FC: every game counts on Real (league, cups, Europe, internationals), and a
   player's "conference" is his club's league, not the competition, so the
   games left come from how often his club has played so far (league, cups and
   Europe together) times the days left to that league's last day, less its
   winter break, and never more than the league's length plus 15 cup and
   European games. Clubs are keyed by league and code together (MIL is AC Milan
   in Serie A and Millwall in the EFL). */
const FC_END = { EPL: ['2027-05-23', 0, 38], LIGA: ['2027-05-23', 14, 38], SERA: ['2027-05-30', 10, 38], BUN: ['2027-05-22', 21, 34], LIG1: ['2027-05-22', 14, 34],
  EFL: ['2027-05-08', 0, 46], LIGAMX: ['2027-04-25', 25, 34], MLS: ['2027-10-31', 30, 34], UCL: ['2027-05-29', 40, 17], UEL: ['2027-05-26', 40, 17] };
const FC_LEAGUE = FC_END;
/* The whole regular season's schedule from ESPN: football a week at a time,
   CBB, NBA and NHL a day at a time. */
async function projSchedule(env, sp) {
  const key = `projsched_v2_${sp}`;   // v2: home/away kept
  try { const c = JSON.parse((await env.RATEBOARD_KV.get(key)) || 'null'); if (c && Date.now() - c.at < 6 * 3600000) return c; } catch (e) {}
  const base = `https://site.api.espn.com/apis/site/v2/sports/${PROJ_PATH[sp]}/scoreboard`;
  const urls = sp === 'nfl' ? [...Array(18).keys()].map(w => `${base}?seasontype=2&week=${w + 1}&dates=2026&limit=100`)
    : sp === 'ncaaf' ? [...Array(16).keys()].map(w => `${base}?seasontype=2&week=${w + 1}&dates=2026&groups=80&limit=400`)
    : (() => { const [d0, d1, ex] = PROJ_DAYS[sp], out = []; for (let t = Date.parse(d0 + 'T12:00:00Z'); t <= Date.parse(d1 + 'T12:00:00Z'); t += 86400000)
        out.push(`${base}?dates=${new Date(t).toISOString().slice(0, 10).replace(/-/g, '')}${ex}`); return out; })();
  const teams = {}, ids = {}, seen = new Set();
  let ok = 0;
  for (let i = 0; i < urls.length; i += 16) {
    const res = await Promise.all(urls.slice(i, i + 16).map(async u => { try { const r = await fetch(u); return r.ok ? await r.json() : null; } catch (e) { return null; } }));
    for (const d of res) {
      if (!d) continue; ok++;
      for (const ev of (d.events || [])) {
        if (seen.has(ev.id) || (ev.season && Number(ev.season.type) !== 2)) continue;
        seen.add(ev.id);
        const c = (ev.competitions || [])[0]; if (!c) continue;
        const cs = c.competitors || []; if (cs.length !== 2) continue;
        const done = !!(ev.status && ev.status.type && ev.status.type.completed);
        cs.forEach((x, k) => { const t = x.team || {}, o = (cs[1 - k] || {}).team || {}; if (!t.abbreviation) return;
          if (t.id) ids[t.abbreviation] = t.id;
          (teams[t.abbreviation] = teams[t.abbreviation] || []).push([ev.date, o.abbreviation || '', done ? 1 : 0, x.homeAway === 'home' ? 'home' : 'away']); });
      }
    }
  }
  for (const k of Object.keys(teams)) teams[k].sort((a, b) => Date.parse(a[0]) - Date.parse(b[0]));
  const out = { at: Date.now(), teams, ids, pages: ok, of: urls.length };
  if (ok >= urls.length * 0.8) { try { await env.RATEBOARD_KV.put(key, JSON.stringify(out), { expirationTtl: 3 * 86400 }); } catch (e) {} }
  else { try { const c = JSON.parse((await env.RATEBOARD_KV.get(key)) || 'null'); if (c) return c; } catch (e) {} }
  return out;
}
/* The projection model (2026-11-05, v2), tuned by replaying last season: the
   projection made at a point in the season against what each player actually
   made after it (top 300 players). Per sport:
     k     how many games' worth of his prior his own games are weighed against
     hl    recency: a game this many games back counts half
     a0/ka availability: the share of his team's games he plays, pulled toward
           a0 (a typical regular) with the weight of ka games
     np    a player with no last season starts at np x the league average
     k2/yoy last season's rate pulled toward the league average with the weight
           of k2 games, then x yoy
   look/miss: missing `miss` of his team's last `look` games = he's not playing
   now, and only 30% of the games left are counted. */
const PROJ_P = {
  // Replayed: NBA 2025-26 (from early Nov and mid Dec), NHL 2025-26, FC 2025-26
  // (club games), CBB 2025-26 (after 1-2 games, a week in, a month in), NFL 2025.
  // Average miss on the top 300 vs the old formula: NBA 48 -> 40 rax, NHL 60 -> 37,
  // FC 115 -> 70, CBB 69 -> 46, NFL 53 -> 40. CFB uses NFL's.
  nba:    { k: 4, hl: 4,  a0: 0.9,  ka: 40, np: 1.2, k2: 40, yoy: 1.0, look: 5, miss: 5 },
  nhl:    { k: 8, hl: 8,  a0: 1.0,  ka: 3,  np: 1.2, k2: 10, yoy: 1.0, look: 5, miss: 5 },
  soccer: { k: 8, hl: 60, a0: 0.85, ka: 8,  np: 1.0, k2: 10, yoy: 1.0, look: 5, miss: 5 },
  ncaam:  { k: 1, hl: 60, a0: 0.9,  ka: 8,  np: 1.0, k2: 10, yoy: 0.9, look: 5, miss: 5 },
  nfl:    { k: 4, hl: 10, a0: 0.8,  ka: 3,  np: 1.0, k2: 10, yoy: 0.9, look: 3, miss: 2 },
  ncaaf:  { k: 4, hl: 10, a0: 0.8,  ka: 3,  np: 1.0, k2: 10, yoy: 0.9, look: 3, miss: 2 }
};
/* Real's team codes that don't match ESPN's (most CBB ones): learnt from the
   games themselves - a team whose opponent on a day is known can only be the
   other side of that day's game. */
function projLearnAlias(sp, cur, sched) {
  const etd = iso => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
  const byDay = new Map();
  for (const [ab, gl] of Object.entries(sched.teams || {})) for (const g of gl) { const d = etd(g[0]); (byDay.get(d) || byDay.set(d, []).get(d)).push([ab, g[1]]); }
  const map = {};
  const res = c => c == null ? null : map[c] || (sched.teams[projAlias(sp, c)] ? projAlias(sp, c) : null);
  const seen = new Set(), games = [];
  for (const x of cur) { const k = x.team + '|' + x.day; if (!x.team || !x.opponent || seen.has(k)) continue; seen.add(k); games.push([x.team, x.day, x.opponent]); }
  const shift = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  for (let pass = 0; pass < 3; pass++) {
    const votes = new Map();
    for (const [t, d, o] of games) {
      if (res(t)) continue; const oe = res(o); if (!oe) continue;
      for (const dd of [d, shift(d, -1), shift(d, 1)]) for (const [a, b] of (byDay.get(dd) || [])) if (b === oe) { const v = votes.get(t) || votes.set(t, new Map()).get(t); v.set(a, (v.get(a) || 0) + 1); }
    }
    let added = 0;
    for (const [t, v] of votes) { const s2 = [...v.entries()].sort((a, b) => b[1] - a[1]); if (s2[0] && (!s2[1] || s2[0][1] >= 2 * s2[1][1])) { map[t] = s2[0][0]; added++; } }
    if (!added) break;
  }
  return c => c == null ? null : map[c] || projAlias(sp, c);
}
const PROJ_MIN = new Set(['nba', 'soccer', 'ncaam']);   // DNP rows (0 minutes) don't count as games played (NHL has no minutes)
async function projBuild(env, db, sp) {
  const [se, prev] = PROJ_SEASON[sp], P = PROJ_P[sp];
  const fc = sp === 'soccer', useMin = PROJ_MIN.has(sp);
  const sched = fc ? { teams: {}, ids: {} } : await projSchedule(env, sp);
  const inj = {};
  if (!fc) {
    try { const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${PROJ_PATH[sp]}/injuries`); const d = r.ok ? await r.json() : {};
      for (const t of (d.injuries || [])) for (const x of (t.injuries || [])) if (x.athlete && x.status && !/^active$/i.test(x.status)) inj[boostName(x.athlete.displayName)] = { status: x.status }; } catch (e) {}
  }
  // NFL: each team's own injury list too (the league list misses some - Lamar, 2026-11-04).
  if (sp === 'nfl') { try { Object.assign(inj, await boostTeamInj(env, sp, Object.values(sched.ids || {}))); } catch (e) {} }
  const cur = ((await db.prepare(`SELECT playerId, player, team, position, day, rax, min, opponent, homeAway${fc ? ', conference' : ''} FROM gamelog WHERE sport=? AND season=?
      AND rax IS NOT NULL AND (seasonType IS NULL OR seasonType='regularseason')`).bind(sp, Number(se)).all()).results) || [];
  const played = x => !useMin || x.min == null || Number(x.min) > 0;
  const alias = fc ? (c => c) : projLearnAlias(sp, cur, sched);
  // Last season, per game actually played.
  const old = new Map();
  let lgPrev = null;
  try { const r = await db.prepare(`SELECT playerId, SUM(rax) AS s, ${useMin ? 'SUM(CASE WHEN min IS NULL OR min > 0 THEN 1 ELSE 0 END)' : 'COUNT(*)'} AS n FROM gamelog
        WHERE sport=? AND season=? AND rax IS NOT NULL AND (seasonType IS NULL OR seasonType='regularseason') GROUP BY playerId`).bind(sp, prev).all();
    let ts = 0, tn = 0;
    for (const x of (r.results || [])) { const n = Number(x.n) || 0; if (n) { old.set(Number(x.playerId), [Number(x.s) / n, n]); ts += Number(x.s); tn += n; } }
    if (tn) lgPrev = ts / tn; } catch (e) {}
  const P_ = cur.filter(played);
  // League average a game played; early in a season, last season's.
  const lgCur = P_.length ? P_.reduce((t, x) => t + Number(x.rax || 0), 0) / P_.length : null;
  const lg = lgCur != null && P_.length >= 2000 ? lgCur : (lgPrev ?? lgCur ?? 1);
  // Opponents and home/away, from everyone's games this season and last (ESPN's team codes).
  const oppT = new Map(), haT = { home: [0, 0], away: [0, 0] };
  for (const x of P_) { const o = x.opponent ? alias(x.opponent) : null; if (o) { const v = oppT.get(o) || [0, 0]; v[0] += Number(x.rax || 0); v[1]++; oppT.set(o, v); }
    if (haT[x.homeAway]) { haT[x.homeAway][0] += Number(x.rax || 0); haT[x.homeAway][1]++; } }
  const of = {}; for (const [o, [t, n]] of oppT) of[o] = Math.round(Math.max(0.85, Math.min(1.15, 1 + (t / n / lgCur - 1) * n / (n + 300))) * 1000) / 1000;
  const hf = {}; for (const h of ['home', 'away']) hf[h] = haT[h][1] >= 200 && lgCur ? Math.round(Math.max(0.9, Math.min(1.1, haT[h][0] / haT[h][1] / lgCur)) * 1000) / 1000 : 1;
  const by = new Map();
  for (const x of cur) (by.get(Number(x.playerId)) || by.set(Number(x.playerId), []).get(Number(x.playerId))).push(x);
  // FC: each club's game days so far (league + cups + Europe), keyed by league and code.
  const club = new Map(), clubKey = x => x.conference + '|' + x.team;
  if (fc) for (const x of cur) {
    if (!x.team || !x.conference || ['WC', '-', 'UNL'].includes(x.conference)) continue;
    const c = club.get(clubKey(x)) || club.set(clubKey(x), { lg: x.conference, all: new Set() }).get(clubKey(x));
    c.all.add(x.day);
  }
  const etd = iso => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
  const near = (days, d0) => { const t = Date.parse(d0 + 'T12:00:00Z'); return days.some(d => Math.abs(Date.parse(d + 'T12:00:00Z') - t) <= 86400000); };
  const r1 = x => x == null ? null : Math.round(x * 10) / 10, r2 = x => x == null ? null : Math.round(x * 100) / 100;
  const rows = [];
  for (const [id, gs0] of by) {
    const gs = gs0.slice().sort((a, b) => String(a.day).localeCompare(String(b.day)));
    const pg = gs.filter(played), last = gs[gs.length - 1];
    const rax = gs.reduce((t, x) => t + Number(x.rax || 0), 0);
    if (!(rax > 0) || !pg.length) continue;
    // 1. His rate a game played: his games (recent ones count more) against his prior.
    const ws = pg.map((x, i) => Math.pow(0.5, (pg.length - 1 - i) / P.hl));
    const wsum = ws.reduce((t, w) => t + w, 0), wx = pg.reduce((t, x, i) => t + ws[i] * Number(x.rax || 0), 0);
    const ov = old.get(id);
    let prior, priorHow;
    if (ov) { prior = (ov[1] * ov[0] + P.k2 * lg) / (ov[1] + P.k2) * P.yoy; priorHow = `last season ${r1(ov[0])} a game over ${ov[1]}`; }
    else if (sp === 'ncaam' && CBB_TOP175[id]) { const rk = CBB_TOP175[id][0]; prior = Math.max(lg * P.np, Math.max(6.5, 12.5 - 0.035 * (rk - 1)) * 0.6); priorHow = `#${rk} on the CBB top 175`; }
    else { prior = lg * P.np; priorHow = 'no last season: league average'; }
    const rate = (wx + P.k * prior) / (wsum + P.k);
    // 2. Games left and how many of them he'll play.
    const flags = [];
    let total = null, rest = [], ab = null, tgDone = 0, fcx = null, teamDays = [], myClub = null;
    if (fc) {
      const cl = gs.slice().reverse().find(x => club.has(clubKey(x)));
      const c = cl ? club.get(clubKey(cl)) : null;
      if (c) {
        ab = cl.team; myClub = clubKey(cl);
        teamDays = [...c.all].sort();
        const E = FC_END[c.lg] || ['2027-05-23', 14, 38];
        const d0 = Date.parse(teamDays[0] + 'T12:00:00Z'), now = Date.now(), dEnd = Date.parse(E[0] + 'T12:00:00Z');
        const perDay = teamDays.length / Math.max(14, (now - d0) / 86400000);
        const daysLeft = Math.max(0, (dEnd - now) / 86400000 - E[1]);
        const left = Math.max(0, Math.min(Math.round(perDay * daysLeft), E[2] + 15 - teamDays.length));
        total = teamDays.length + left; tgDone = teamDays.length;
        rest = [...Array(left).keys()].map(() => [null, null, 0, null]);
        fcx = { lg: c.lg, played: teamDays.length, perWeek: Math.round(perDay * 7 * 10) / 10, daysLeft: Math.round(daysLeft), end: E[0] };
      } else flags.push('Club not found');
    } else {
      ab = last.team ? alias(last.team) : null;
      const tg = ab ? sched.teams[ab] : null;
      if (tg) {
        total = tg.length;
        rest = tg.filter(g => !g[2] && Date.parse(g[0]) > Date.now() - 4 * 3600000);
        teamDays = tg.filter(g => g[2]).map(g => etd(g[0])); tgDone = teamDays.length;
      } else flags.push('Team schedule not found');
    }
    // Share of his team's games (since his first) he has played, pulled toward a regular's.
    // (FC: his club games only - internationals aren't on the club's schedule.)
    const mine = myClub ? pg.filter(x => clubKey(x) === myClub) : pg;
    const first = (mine[0] || gs[0]).day, days = mine.map(x => x.day);
    const since = teamDays.filter(d => d >= first || near([first], d)).length || mine.length;
    let avail = (mine.length + P.ka * P.a0) / (Math.max(since, mine.length) + P.ka);
    const recent = teamDays.slice(-P.look), missed = recent.filter(d => !near(days, d)).length;
    const ij = inj[boostName(last.player || '')];
    let skipNext = false;
    if (ij && /^injured reserve/i.test(ij.status)) { flags.push('Injured reserve - no more games counted'); avail = 0; }
    else {
      if (ij && /^(out|suspen)/i.test(ij.status)) { flags.push(ij.status + ' - next game not counted'); skipNext = true; }
      else if (ij && /^(doubtful|questionable|day-to-day)/i.test(ij.status)) flags.push(ij.status);
      if (recent.length >= P.look && missed >= P.miss) { flags.push(`Missed ${missed} of his ${fc ? 'club' : 'team'}'s last ${recent.length} - only 30% of the games left counted`); avail *= 0.3; }
    }
    avail = Math.min(1, avail);
    // 3. Each game left: his rate x the chance he plays x opponent x home/away.
    let add = 0;
    rest.forEach((g, i) => { if (i === 0 && skipNext) return; add += rate * avail * (g[1] && of[g[1]] ? of[g[1]] : 1) * (g[3] && hf[g[3]] ? hf[g[3]] : 1); });
    const gp = pg.length;
    rows.push({ i: id, n: last.player || ('Player ' + id), t: last.team || '', p: last.position || '', gp, r: Math.round(rax), a: r1(rax / gp),
      pg: r1(rate * avail), l: rest.length, tg: total, nx: rest[0] && rest[0][1] ? rest[0][1] : null,
      pr: Math.round(rax + add), pc: total ? Math.round(rax / gp * total) : null, f: flags.length ? flags : undefined,
      x: { rate: r2(rate), prior: r2(prior), ph: priorHow, av: r2(avail), since, ab, sk: skipNext ? 1 : 0, w: r1(wsum), fc: fcx || undefined } });
  }
  rows.sort((x, y) => y.pr - x.pr);
  const out = { at: Date.now(), sport: sp, season: se, model: 2, lg: r2(lg), of, hf, rows: rows.slice(0, 4000), players: rows.length, schedPages: sched.pages, schedOf: sched.of };
  try { await env.RATEBOARD_KV.put(`proj_v3_${sp}`, JSON.stringify(out), { expirationTtl: 3 * 86400 }); } catch (e) {}
  return out;
}
/* One player's breakdown: his part of the saved list, and his team's games
   left with each one's projection. */
async function projDetail(env, sp, row, c) {
  const out = { games: [], k: (PROJ_P[sp] || {}).k, lg: c && c.lg };
  if (!row || !row.x || sp === 'soccer' || !row.x.ab) return out;
  let sched = null; try { sched = JSON.parse((await env.RATEBOARD_KV.get(`projsched_v2_${sp}`)) || 'null'); } catch (e) {}
  const tg = sched && sched.teams && sched.teams[row.x.ab]; if (!tg) return out;
  const of = (c && c.of) || {}, hf = (c && c.hf) || {};
  const rest = tg.filter(g => !g[2] && Date.parse(g[0]) > Date.now() - 4 * 3600000);
  out.games = rest.map(([at, opp, , h], i) => { const f = (of[opp] || 1) * (hf[h] || 1), counted = !(i === 0 && row.x.sk);
    return { at, opp, h, f: Math.round(f * 100) / 100, v: counted ? Math.round(row.x.rate * row.x.av * f * 10) / 10 : 0, counted }; });
  out.played = tg.filter(g => g[2]).length;
  return out;
}

const SCAN_EVERY_KEY = 'swap_scan_every_v1';
async function scanEvery(env) {
  let v = null; try { v = Number(await env.RATEBOARD_KV.get(SCAN_EVERY_KEY)); } catch (e) {}
  return v === 15 ? 15 : 180;
}

// Any error comes back as a readable message rather than a bare 500.
/* Step times for one request, so a slow page open says where the time went. */
const MARKS = new WeakMap();
const mark = (req, what) => { const m = MARKS.get(req); if (m) m.push(`${what} ${Date.now() - m.t}`); };
export async function onRequest(ctx) {
  const t0 = Date.now();
  try { const m = []; m.t = t0; MARKS.set(ctx.request, m); } catch (e) {}
  try { const r = await handle(Object.assign({}, ctx, { env: watchEnv(ctx.env, ctx.request, ctx.waitUntil) }));
    // Page-opening calls that took long, so a slow page can be traced (shown on the health page, no names).
    try { const op = new URL(ctx.request.url).searchParams.get('op') || ''; const ms = Date.now() - t0;
      if (ms > 1500 && PAGE_OPS.has(op)) noteSlowRequest(ctx.env, ctx.waitUntil, { at: new Date().toISOString(), ms, sql: 'whole request: ' + (MARKS.get(ctx.request) || []).join(' · '), where: '/api/swaps?op=' + op }); } catch (e) {}
    return r; }
  catch (e) { return json({ error: 'Swaps hit an error: ' + String((e && e.message) || e).slice(0, 300) }, 500); }
}

/* Linking a different Real username (/username): the member names the Real
   account, DMs @raxacademy.app "confirm username change" from it, and taps
   verify. Once the bot sees that message from that account, it becomes the
   Real account Swaps uses for them. Their Pro check and scan start over. */
const RN_PHRASE = 'CONFIRM USERNAME CHANGE';
async function renameFlow(env, db, url, acc, op, waitUntil) {
  if (!acc.who) return json({ error: 'Sign in on the board first.' }, 401);
  try { await alterOnce(db, 'ALTER TABLE users ADD COLUMN rsName TEXT'); } catch (e) {}
  const kvKey = 'rn_v1_' + acc.who;
  if (op === 'rnstatus') {
    let p = null; try { p = JSON.parse((await env.RATEBOARD_KV.get(kvKey)) || 'null'); } catch (e) {}
    return json({ board: acc.who, real: await realName(db, acc.who), pending: p && p.name });
  }
  if (op === 'rnstart') {
    const name = String(url.searchParams.get('user') || '').trim().replace(/^@/, '');
    const k = name.toLowerCase();
    if (!/^[a-z0-9._-]{2,40}$/i.test(name)) return json({ error: 'Enter a Real username.' }, 400);
    if (!(await allow(url.origin, 'rnstart:' + acc.who, 6, 3600))) return json({ error: 'Too many tries - wait an hour.' }, 429);
    if (k !== String(acc.who).toLowerCase()) {
      const other = await db.prepare('SELECT key FROM users WHERE (LOWER(key)=? OR LOWER(rsName)=?) AND key<>?').bind(k, k, acc.who).first();
      if (other) return json({ error: 'That Real username is already linked to another board account. Message Dennis if it is yours.' }, 409);
    }
    await env.RATEBOARD_KV.put(kvKey, JSON.stringify({ name, at: Date.now() }), { expirationTtl: 3600 });
    return json({ pending: name, phrase: 'confirm username change', bot: 'raxacademy.app' });
  }
  // rncheck
  let p = null; try { p = JSON.parse((await env.RATEBOARD_KV.get(kvKey)) || 'null'); } catch (e) {}
  if (!p || !p.name) return json({ error: 'Enter the Real username first.' }, 400);
  if (!(await allow(url.origin, 'rncheck:' + acc.who, 4, 60))) return json({ error: 'Give it a few seconds and try again.' }, 429);
  if (!(await allow(url.origin, 'rncheck-all', 20, 60))) return json({ error: HIGH_VOL }, 429);
  const auth = swapToken(env);
  if (!auth) return json({ error: 'The bot is not set up.' }, 503);
  const found = await findCodeInDms(auth, String(p.name).toLowerCase(), RN_PHRASE);
  if (found.error) return json({ waiting: true, error: 'Could not reach Real just now - try again in a minute.' });
  if (!found.ok) return json({ waiting: true, error: `No "confirm username change" message from @${p.name} yet. Send it to @raxacademy.app from that account, then tap verify again.` });
  await db.prepare('UPDATE users SET rsName=? WHERE key=?').bind(p.name, acc.who).run();
  await stat(db, 'rename_ok');
  try { await db.prepare(SPRO_DDL).run(); await db.prepare('DELETE FROM swap_pro WHERE key=?').bind(acc.who).run(); } catch (e) {}
  try { await db.prepare('UPDATE swap_users SET rsUser=?, hashId=NULL, passes=NULL, scannedAt=NULL WHERE key=?').bind(p.name, acc.who).run(); } catch (e) {}
  await env.RATEBOARD_KV.delete(kvKey);
  try {
    waitUntil((async () => {
      if (found.request) { try { await fetch(`https://web.realapp.com/messages/channels/${found.request}/acceptrequest`, { method: 'PUT', headers: { ...rsHeaders(auth), 'content-type': 'application/json' }, body: '{}' }); } catch (e) {} }
      if (found.channel) {
        try { await dmSend(auth, found.channel, `Username confirmed; board account ${acc.who} now uses this Real account on https://raxacademy.app`); await stat(db, 'dm_rename'); } catch (e) { await botFail(db, 'dm_rename', e.message); }
        // That chat is how Swaps reaches them now.
        try { if (found.hashId) await db.prepare(`INSERT INTO swap_dm (hashId, userName, channelId, openedAt) VALUES (?, ?, ?, ?) ON CONFLICT(hashId) DO UPDATE SET channelId=excluded.channelId`).bind(found.hashId, p.name, found.channel, Date.now()).run(); } catch (e) {}
      }
    })());
  } catch (e) {}
  return json({ ok: true, real: p.name });
}

async function proCheck(env, db, url, acc) {
  if (!acc.who) return json({ error: 'Sign in on the board first.' }, 401);
  if (acc.swaps) return json({ access: true });
  if (!SWAPS_OPEN) return json({ error: 'Swaps is not open yet.' }, 403);
  await db.prepare(SPRO_DDL).run();
  let had = await db.prepare('SELECT pro, at FROM swap_pro WHERE key=?').bind(acc.who).first();
  if (had && !had.pro && Date.now() - (Number(had.at) || 0) > PRO_RETRY_MS) {
    if (url.searchParams.get('peek') === '1') return json({ access: false, checked: false, retry: true });
    await db.prepare('DELETE FROM swap_pro WHERE key=?').bind(acc.who).run(); had = null;
  }
  if (had) return json({ access: !!had.pro, checked: true, pro: !!had.pro,
    retryIn: had.pro ? null : Math.max(1, Math.ceil(((Number(had.at) || 0) + PRO_RETRY_MS - Date.now()) / 86400000)) });
  if (url.searchParams.get('peek') === '1') return json({ access: false, checked: false });
  // One real check per member, ever; this only guards against double taps.
  if (!(await allow(url.origin, 'procheck:' + acc.who, 3, 600))) return json({ error: 'Wait a few minutes and try again.' }, 429);
  if (!(await allow(url.origin, 'procheck-all', 20, 60))) return json({ error: HIGH_VOL }, 429);
  const auth = swapToken(env);
  if (!auth) return json({ error: 'The check is not set up yet.' }, 503);
  let d;
  const rn = await realName(db, acc.who);
  try { d = await rsGetJson(`https://web.realapp.com/searchusers?query=${encodeURIComponent(rn)}`, scanTok(env)); }
  catch (e) { return json({ error: 'Could not reach Real just now - try again in a minute.' }, 502); }
  if (!d || !Array.isArray(d.users)) return json({ error: 'Could not reach Real just now - try again in a minute.' }, 502);
  const u = d.users.find(x => String(x.userName || '').toLowerCase() === rn.toLowerCase()) || null;
  const pro = !!(u && u.isRealPro);
  await db.prepare('INSERT INTO swap_pro (key, pro, tier, rsId, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(key) DO NOTHING')
    .bind(acc.who, pro ? 1 : 0, u && u.realProTier != null ? Number(u.realProTier) : null, u ? String(u.id) : null, Date.now()).run();
  await stat(db, 'pro_check'); if (pro) await stat(db, 'pro_yes');
  return json({ access: pro, checked: true, pro, retryIn: pro ? null : 3, notFound: !u });
}

async function handle({ request, env, waitUntil }) {
  const url = new URL(request.url);
  const db = env.RATEBOARD_DB;
  const op = url.searchParams.get('op') || '';
  // Password resets happen signed out, so they come before the access check.
  if (op === 'resetstart' || op === 'resetcheck') return resetFlow(env, db, url, request, op, waitUntil);
  /* The page a member's DM links to: their swaps at one hour. No sign-in; the
     link's signature is the key. */
  /* The hour page's time menu: every swap time this member had in the last
     14 days and has coming up, each with its own signed page link. The page's
     own signature is the key. */
  // The hour page's Packs today panel (signed like the page itself).
  if (op === 'hourpacks') {
    const key = String(url.searchParams.get('u') || ''), due = Number(url.searchParams.get('d'));
    if (!key || !due || url.searchParams.get('t') !== await hourSig(env, key, due)) return json({ error: 'This link is not valid.' }, 403);
    const u = await db.prepare('SELECT key FROM swap_users WHERE LOWER(key)=?').bind(key.toLowerCase()).first();
    if (!u) return json({ error: 'No swaps found.' }, 404);
    let b = null; if (request.method === 'POST') { try { b = await request.json(); } catch (e) { b = {}; } }
    return json(await packsToday(env, db, u.key, b));
  }
  /* Admin only (Dennis, 2026-11-05): "Swaps by hour" on his own hour page -
     every swap at one hour, past or coming, with who gets what and whether
     each side was warned and messaged. His signed link is the pass. */
  if (op === 'hourall') {
    const key = String(url.searchParams.get('u') || ''), due = Number(url.searchParams.get('d'));
    if (!key || !due || url.searchParams.get('t') !== await hourSig(env, key, due)) return json({ error: 'This link is not valid.' }, 403);
    if (!ADMINS.includes(key.toLowerCase())) return json({ error: 'Admins only.' }, 403);
    await matchCols(db);
    const now = Date.now();
    const hrs = ((await db.prepare(`SELECT dueAt AS d, COUNT(*) AS n, SUM(CASE WHEN status IN ('cancelled','cancelling') THEN 1 ELSE 0 END) AS off FROM swap_matches
      WHERE dueAt BETWEEN ? AND ? AND status <> 'cleared' GROUP BY dueAt ORDER BY dueAt`).bind(now - 7 * 86400000, now + 3 * 86400000).all()).results) || [];
    const hours = hrs.map(r => ({ due: Number(r.d), swaps: Number(r.n) - Number(r.off || 0), off: Number(r.off || 0) }));
    let at = Math.floor(Number(url.searchParams.get('at')) / 3600000) * 3600000;
    if (!at) { const nx = hours.find(h => h.due >= now - 3600000); at = nx ? nx.due : Math.ceil(now / 3600000) * 3600000; }
    const ms = ((await db.prepare("SELECT * FROM swap_matches WHERE dueAt=? AND status <> 'cleared' ORDER BY id").bind(at).all()).results) || [];
    const ks = [...new Set(ms.flatMap(m => [m.a, m.b]))], users = new Map();
    for (let i = 0; i < ks.length; i += 90) { const part = ks.slice(i, i + 90);
      for (const r of (((await db.prepare(`SELECT key, rsUser, hashId FROM swap_users WHERE key IN (${part.map(() => '?').join(',')})`).bind(...part).all()).results) || [])) users.set(r.key, r); }
    const nc = new Map(), side = async (m, s0) => { const k = s0 === 'A' ? m.a : m.b, u0 = users.get(k) || {};
      return { user: u0.rsUser || k, url: profileUrl(u0.rsUser || k, u0.hashId), gets: await indexName(db, s0 === 'A' ? m.aGets : m.bGets, nc),
        warned: m['warn' + s0] || null, contacted: m['done' + s0] || null, page: `/hour?u=${encodeURIComponent(k)}&d=${at}&t=${await hourSig(env, k, at)}` }; };
    const swaps = [];
    for (const m of ms) swaps.push({ id: m.id, status: m.status, note: m.note || null, made: Number(m.createdAt) || null, a: await side(m, 'A'), b: await side(m, 'B') });
    return json({ at, now, hours, swaps });
  }
  if (op === 'hourlist') {
    const key = String(url.searchParams.get('u') || ''), due = Number(url.searchParams.get('d'));
    if (!key || !due || url.searchParams.get('t') !== await hourSig(env, key, due)) return json({ error: 'This link is not valid.' }, 403);
    const u = await db.prepare('SELECT key FROM swap_users WHERE LOWER(key)=?').bind(key.toLowerCase()).first();
    if (!u) return json({ hours: [] });
    await matchCols(db);
    const rows = ((await db.prepare(`SELECT dueAt AS d, COUNT(*) AS n, SUM(CASE WHEN status IN ('cancelled','cancelling') THEN 1 ELSE 0 END) AS off FROM swap_matches
      WHERE (a=? OR b=?) AND dueAt > ? AND status <> 'cleared' GROUP BY dueAt ORDER BY dueAt DESC LIMIT 200`).bind(u.key, u.key, Date.now() - 14 * 86400000).all()).results) || [];
    const hours = [];
    for (const r of rows) { const d = Number(r.d), live = Number(r.n) - Number(r.off || 0); if (live <= 0) continue;
      hours.push({ due: d, swaps: live, url: `/hour?u=${encodeURIComponent(u.key)}&d=${d}&t=${await hourSig(env, u.key, d)}` }); }
    return json({ hours, now: Date.now() });
  }
  if (op === 'hourview') {
    const key = String(url.searchParams.get('u') || ''), due = Number(url.searchParams.get('d'));
    if (!key || !due || url.searchParams.get('t') !== await hourSig(env, key, due)) return json({ error: 'This link is not valid.' }, 403);
    await matchCols(db);
    const u = await db.prepare('SELECT key FROM swap_users WHERE LOWER(key)=?').bind(key.toLowerCase()).first();
    if (!u) return json({ error: 'No swaps found.' }, 404);
    const ms = ((await db.prepare("SELECT * FROM swap_matches WHERE (a=? OR b=?) AND dueAt=? AND status NOT IN ('cancelled','cleared') ORDER BY id").bind(u.key, u.key, due).all()).results) || [];
    // Partners: only their name and comment (not their whole pass list).
    const cache = new Map(), mem = async k => cache.has(k) ? cache.get(k) : (cache.set(k, await db.prepare('SELECT key, rsUser, hashId, comment FROM swap_users WHERE key=?').bind(k).first()), cache.get(k));
    const me = await loadMember(db, u.key), out = [];
    for (const m of ms) {
      const side = m.a === u.key ? 'A' : 'B', o = await mem(side === 'A' ? m.b : m.a);
      const recv = side === 'A' ? m.aGets : m.bGets, give = side === 'A' ? m.bGets : m.aGets;
      out.push({ id: m.id, status: m.status, partner: o && o.rsUser, partnerUrl: o ? profileUrl(o.rsUser, o.hashId) : null, comment: (o && o.comment) || null,
        receive: playerName(me, recv), receiveUrl: playerUrl(recv),
        give: playerName(me, give), giveUrl: playerUrl(give), yourCard: me ? passUrl(me, give) : null, off: m.status === 'cancelling' });
    }
    return json({ user: (me && me.rsUser) || u.key, due, swaps: out, admin: ADMINS.includes(u.key.toLowerCase()) || undefined });
  }
  /* Most picked players, for everyone on the hour page (Dennis, 2026-11-05):
     how many active members are swapping for each player, most first. */
  if (op === 'hourtop') {
    const key = String(url.searchParams.get('u') || ''), due = Number(url.searchParams.get('d'));
    if (!key || !due || url.searchParams.get('t') !== await hourSig(env, key, due)) return json({ error: 'This link is not valid.' }, 403);
    let c = null; try { c = JSON.parse((await env.RATEBOARD_KV.get('swap_wanttop_v1')) || 'null'); } catch (e) {}
    if (!c || Date.now() - c.at > 300000) {
      const n = {}; let members = 0;
      for (const r of ((await db.prepare(`SELECT wants FROM swap_users WHERE active=1 AND wants IS NOT NULL AND wants <> '[]'`).all()).results || [])) {
        members++; for (const w of parse(r.wants, []).slice(0, MAX_WANTS)) n[w] = (n[w] || 0) + 1; }
      const nc = new Map(), top = Object.entries(n).sort((a, b) => b[1] - a[1]).slice(0, 60);
      const rows = []; for (const [k, v] of top) rows.push({ key: k, name: await indexName(db, k, nc), n: v, url: playerUrl(k) });
      c = { at: Date.now(), members, rows };
      try { await env.RATEBOARD_KV.put('swap_wanttop_v1', JSON.stringify(c)); } catch (e) {}
    }
    const r = await db.prepare('SELECT wants FROM swap_users WHERE LOWER(key)=?').bind(key.toLowerCase()).first();
    const mine = new Set(parse(r && r.wants, []));
    return json({ at: c.at, members: c.members, rows: c.rows.map(x => ({ ...x, mine: mine.has(x.key) || undefined })) });
  }
  /* Admin only for now (Dennis, 2026-11-05): the top 50 rax earners in game
     data - every sport and season but FC - under Most picked. A snapshot:
     taken once and kept (the numbers are set), retaken only with rebuild=1.
     With each: Real owners, and how many members here have that pass. */
  if (op === 'hourrax') {
    const key = String(url.searchParams.get('u') || ''), due = Number(url.searchParams.get('d'));
    if (!key || !due || url.searchParams.get('t') !== await hourSig(env, key, due)) return json({ error: 'This link is not valid.' }, 403);
    if (!ADMINS.includes(key.toLowerCase())) return json({ error: 'Admins only.' }, 403);
    let c = null; try { c = JSON.parse((await env.RATEBOARD_KV.get('swap_raxtop_snap_v2')) || 'null'); } catch (e) {}
    if (!c || url.searchParams.get('rebuild') === '1') {
      const ss = ((await (await fetch(`${url.origin}/api/rax?gamelog=seasons`)).json()).seasons || []).filter(x => x.sport !== 'soccer').map(x => `${x.sport}:${x.season}`);
      const j = await (await fetch(`${url.origin}/api/rax?gamelog=query&mode=players&seasons=${encodeURIComponent(ss.join(','))}&sort=rax&dir=desc&limit=250`)).json();
      if (!j || !Array.isArray(j.rows)) return json({ error: (j && j.error) || 'Game data did not answer - try again.' }, 502);
      const SP = { nba: 'NBA', ncaam: 'CBB', nfl: 'NFL', ncaaf: 'CFB', nhl: 'NHL', mlb: 'MLB', wnba: 'WNBA', golf: 'Golf' };
      // 250 kept: the list shown leaves out passes someone is swapping for, so it needs spares.
      const top = j.rows.filter(r => r.sport !== 'soccer').slice(0, 250).map(r => ({ k: `${r.sport}:${r.season}:${r.playerId}`, r }));
      // Counted in the database (reading every member's passes here ran out of memory).
      const have = new Map(), ks = top.map(x => x.k);
      for (let i = 0; i < ks.length; i += 90) { const part = ks.slice(i, i + 90);
        try { for (const r of (((await db.prepare(`SELECT json_extract(j.value, '$.key') AS k, COUNT(DISTINCT u.key) AS n FROM swap_users u, json_each(u.passes) j
            WHERE u.passes IS NOT NULL AND json_extract(j.value, '$.key') IN (${part.map(() => '?').join(',')}) AND COALESCE(json_extract(j.value, '$.kind'), '') <> 'team' GROUP BY k`).bind(...part).all()).results) || []))
          have.set(r.k, Number(r.n) || 0); } catch (e) {} }
      c = { at: Date.now(), seasons: ss.length, rows: top.map(({ k, r }) => ({ key: k, name: r.player, sport: SP[r.sport] || r.sport, season: r.season, rax: Number(r.rax) || 0, owners: r.owners == null ? null : Number(r.owners), onSite: have.get(k) || 0, url: playerUrl(k) })) };
      try { await env.RATEBOARD_KV.put('swap_raxtop_snap_v2', JSON.stringify(c)); } catch (e) {}
    }
    // Only passes nobody is swapping for right now (checked live; the numbers are the snapshot's).
    const swapped = new Set();
    for (const r of ((await db.prepare(`SELECT wants FROM swap_users WHERE active=1 AND wants IS NOT NULL AND wants <> '[]'`).all()).results || [])) for (const w of parse(r.wants, []).slice(0, MAX_WANTS)) swapped.add(w);
    const free = c.rows.filter(x => !swapped.has(x.key));
    return json({ at: c.at, seasons: c.seasons, left: free.length < 50 ? free.length : undefined, skipped: c.rows.slice(0, c.rows.indexOf(free[49]) + 1 || c.rows.length).length - Math.min(50, free.length), rows: free.slice(0, 50) });
  }
  /* Your players and hours, from the hour page (Dennis, 2026-11-05): see them,
     remove or add a player, and change daily hours - the same saves (and the
     same calling-off of swaps still to come) as on /swaps. */
  if (op === 'hourpicks') {
    const key = String(url.searchParams.get('u') || ''), due = Number(url.searchParams.get('d'));
    if (!key || !due || url.searchParams.get('t') !== await hourSig(env, key, due)) return json({ error: 'This link is not valid.' }, 403);
    await matchCols(db);
    const u = await db.prepare('SELECT key FROM swap_users WHERE LOWER(key)=?').bind(key.toLowerCase()).first();
    if (!u) return json({ error: 'Scan your passes on /swaps first.' }, 404);
    const me = u.key, auth = swapToken(env);
    let calledOff = 0, late = 0, msg = null;
    if (request.method === 'POST') {
      let b = {}; try { b = await request.json(); } catch (e) {}
      if (!(await allow(url.origin, 'hourpicks:' + me, 40, 600))) return json({ error: 'Slow down a little - try again in a few minutes.' }, 429);
      const r = await db.prepare('SELECT wants, slots, sched, passes, keep FROM swap_users WHERE key=?').bind(me).first();
      let wants = parse(r.wants, []), slots = parse(r.slots, []), sched = parse(r.sched, null);
      if (b.act === 'drop') wants = wants.filter(w => w !== String(b.key || ''));
      else if (b.act === 'add') {
        const k = String(b.key || ''), own = parse(r.passes, []).find(p => p.key === k && p.kind !== 'team');
        if (!own || /^(soccer|ufc):/.test(k) || seasonOff(k)) return json({ error: "You can only add a pass you own that can be swapped." }, 400);
        if (parse(r.keep, []).includes(k)) return json({ error: "That's one of your keeps - take it off your keeps on /swaps first." }, 400);
        if (wants.length >= MAX_WANTS) return json({ error: `You can swap for up to ${MAX_WANTS} players at once - remove one first.` }, 400);
        if (!wants.includes(k)) wants.push(k);
      } else if (b.act === 'slots') {
        if (sched && sched.mode && sched.mode !== 'daily') return json({ error: 'Your hours are set by day of the week or for one date - change those on /swaps.' }, 400);
        slots = [...new Set((Array.isArray(b.slots) ? b.slots : []).map(Number).filter(h => Number.isInteger(h) && h >= 0 && h < 24))].slice(0, MAX_SLOTS);
        sched = { mode: 'daily' };
      } else return json({ error: 'Nothing to change.' }, 400);
      await db.prepare('UPDATE swap_users SET wants=?, slots=?, sched=?, updatedAt=? WHERE key=?').bind(JSON.stringify(wants), JSON.stringify(slots), JSON.stringify(sched || { mode: 'daily' }), Date.now(), me).run();
      try { await env.RATEBOARD_KV.delete('swap_wantcounts_v1'); await env.RATEBOARD_KV.delete('swap_hourcounts_v1'); } catch (e) {}
      try { const res = await afterCallOff(env, db, auth, me, await cancelDropped(db, me, new Set(wants), new Set(slots), sched)); calledOff = res.n; late = res.late; } catch (e) {}
      msg = 'Saved.';
    }
    const r = await db.prepare('SELECT wants, slots, sched, passes, keep, active FROM swap_users WHERE key=?').bind(me).first();
    const mine = { key: me, passes: parse(r.passes, []) }, wants = parse(r.wants, []), keep = new Set(parse(r.keep, []));
    const options = mine.passes.filter(p => p.kind !== 'team' && !/^(soccer|ufc):/.test(p.key) && !seasonOff(p.key) && !wants.includes(p.key) && !keep.has(p.key))
      .map(p => ({ key: p.key, name: playerName(mine, p.key) })).sort((a, b) => a.name.localeCompare(b.name));
    return json({ ok: true, msg, calledOff, late, active: !!Number(r.active), wants: wants.map(k => ({ key: k, name: playerName(mine, k), url: playerUrl(k) })),
      slots: parse(r.slots, []), sched: parse(r.sched, null) || { mode: 'daily' }, options, maxWants: MAX_WANTS, maxSlots: MAX_SLOTS });
  }
  /* The hour page's Report button (Dennis, 2026-11-05): a report on one partner
     of that hour, straight from the signed page - same list as REPORT on /swaps. */
  if (op === 'hourreport' && request.method === 'POST') {
    const key = String(url.searchParams.get('u') || ''), due = Number(url.searchParams.get('d'));
    if (!key || !due || url.searchParams.get('t') !== await hourSig(env, key, due)) return json({ error: 'This link is not valid.' }, 403);
    let b = {}; try { b = await request.json(); } catch (e) {}
    const REASONS = { nooffer: "Didn't send me an offer", nobuy: "Didn't buy my pack", wrong: 'Sent the wrong offer', other: 'Other' };
    const reason = REASONS[b.reason] || REASONS.other, note = String(b.detail || '').trim().slice(0, 800);
    if (reason === REASONS.other && note.length < 5) return json({ error: 'Say what happened.' }, 400);
    await matchCols(db);
    const u = await db.prepare('SELECT key FROM swap_users WHERE LOWER(key)=?').bind(key.toLowerCase()).first();
    const m = u && await db.prepare('SELECT * FROM swap_matches WHERE id=? AND (a=? OR b=?) AND dueAt=?').bind(Number(b.id), u.key, u.key, due).first();
    if (!m) return json({ error: 'That swap was not found.' }, 404);
    const side = m.a === u.key ? 'A' : 'B', o = await loadMember(db, side === 'A' ? m.b : m.a), me = await loadMember(db, u.key);
    const target = (o && o.rsUser) || (side === 'A' ? m.b : m.a);
    if (!(await allow(url.origin, 'swapreport:' + u.key, 10, 3600))) return json({ error: 'You have sent a lot of reports - try again later.' }, 429);
    const detail = `${reason} - swap #${m.id} (${new Date(due).toISOString().slice(0, 16).replace('T', ' ')} UTC): they were to get ${me ? playerName(me, side === 'A' ? m.bGets : m.aGets) : '?'}, this member was to get ${me ? playerName(me, side === 'A' ? m.aGets : m.bGets) : '?'}. From the swap page.` + (note ? `\n${note}` : '');
    await db.prepare(SREPORT_DDL).run();
    try { await alterOnce(db, 'ALTER TABLE swap_reports ADD COLUMN matchId INTEGER'); } catch (e) {}
    await db.prepare('INSERT INTO swap_reports (ts, by_user, kind, target, detail, status, matchId) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(Date.now(), u.key, 'user', target, detail, 'open', m.id).run();
    await stat(db, 'report_user');
    return json({ ok: true });
  }
  /* The hour page's "On Android, request DM" buttons: the full old-style
     warning or contact DM for that hour, sent once each. */
  if (op === 'hourdm' && request.method === 'POST') {
    const key = String(url.searchParams.get('u') || ''), due = Number(url.searchParams.get('d')), kind = url.searchParams.get('kind') === 'contact' ? 'contact' : 'warn';
    if (!key || !due || url.searchParams.get('t') !== await hourSig(env, key, due)) return json({ error: 'This link is not valid.' }, 403);
    if (kind === 'contact' && Date.now() < due - 30000) return json({ error: 'The swap DM opens at swap time.' }, 400);
    const once = `hourdm_v1_${key.toLowerCase()}_${due}_${kind}`;
    if (await env.RATEBOARD_KV.get(once)) return json({ error: 'Already sent - check your DMs from @raxacademy.app.' }, 429);
    const auth = swapToken(env);
    const u = await db.prepare('SELECT key FROM swap_users WHERE LOWER(key)=?').bind(key.toLowerCase()).first();
    if (!u || !auth) return json({ error: 'No swaps found.' }, 404);
    await matchCols(db);
    const ms = ((await db.prepare("SELECT * FROM swap_matches WHERE (a=? OR b=?) AND dueAt=? AND status NOT IN ('cancelled','cancelling','cleared') ORDER BY id").bind(u.key, u.key, due).all()).results) || [];
    const cache = new Map(), member = async k => cache.has(k) ? cache.get(k) : (cache.set(k, await loadMember(db, k)), cache.get(k));
    const items = []; for (const m of ms) { const l = await sideLines(member, m, m.a === u.key ? 'A' : 'B'); if (l) items.push(l); }
    if (!items.length) return json({ error: 'No swaps left at that time.' }, 404);
    const me = await member(u.key);
    if (!me || !me.hashId) return json({ error: 'The bot can\'t reach you - do step 1 on the Swaps page.' }, 400);
    await env.RATEBOARD_KV.put(once, '1', { expirationTtl: 2 * 86400 });
    const msgs = kind === 'warn' ? warnGrouped(items) : contactGrouped(items, []);
    try { waitUntil((async () => {
      const ch = await dmChannel(db, auth, me.hashId, me.rsUser, env);
      for (let i = 0; i < msgs.length; i++) {
        if (i) await sleep(4500);
        try { await dmSendRetry(auth, ch, msgs[i]); await stat(db, 'dm_requested'); }
        catch (e) { await queueDm(db, ch, msgs.slice(i), `${kind} (asked) @${me.rsUser}`); await botFail(db, 'dm_' + kind, `@${me.rsUser} asked DM part ${i + 1}/${msgs.length}: ${e.message || e}`); break; }
      }
    })().catch(() => {})); } catch (e) {}
    return json({ ok: true, messages: msgs.length });
  }
  if (op === 'dmtick') {
    const k = await dmTickKey(env);
    if (!k || url.searchParams.get('k') !== k) return json({ error: 'no' }, 403);
    // Only one run at a time across the site: a claim row per minute.
    const minute = new Date().toISOString().slice(0, 16);
    let go = false;
    try { await db.prepare('CREATE TABLE IF NOT EXISTS dm_runs (minute TEXT PRIMARY KEY, at INTEGER)').run();
      const c = await db.prepare('INSERT OR IGNORE INTO dm_runs (minute, at) VALUES (?, ?)').bind(minute, Date.now()).run(); go = !!(c && c.meta && c.meta.changes);
      if (Math.random() < 0.02) await db.prepare('DELETE FROM dm_runs WHERE at < ?').bind(Date.now() - 86400000).run(); } catch (e) {}
    if (go) { try { waitUntil(dmTick(env).catch(() => {})); } catch (e) {} }
    return json({ ok: true, started: go });
  }
  const acc = await swapAccess(env, request);
  mark(request, 'access');
  if (op === 'procheck') return proCheck(env, db, url, acc);
  if (op === 'rnstatus' || op === 'rnstart' || op === 'rncheck') return renameFlow(env, db, url, acc, op, waitUntil);
  // Boosts (BETA) is open to every signed-in member; its calls say page=boosts.
  // Limited to Dennis (admins) while in beta: set BOOSTS_OPEN to open it to everyone signed in.
  const boostCall = BOOSTS_OPEN && url.searchParams.get('page') === 'boosts' && BOOST_OPS.has(op) && !!acc.who;
  if (!acc.ok && !boostCall) return forbidden(acc.who ? 'Your account does not have this page yet.' : 'Sign in on the board first.');
  if (!acc.admin && !boostCall && !((acc.swaps && MEMBER_OPS.has(op)) || (acc.otd && OTD_OPS.has(op)))) return forbidden('Your account does not have this.');
  const me = acc.who;
  await ready(db);
  mark(request, 'ready');
  const auth = swapToken(env);

  /* Why haven't I matched? Run when they tap the button, never on its own. */
  /* ✕ on a pick: saved straight away, and that player's swaps still to come are called off. */
  if (op === 'dropwant' && request.method === 'POST') {
    let b = {}; try { b = await request.json(); } catch (e) {}
    const k = String(b.key || '');
    await matchCols(db);
    const r = await db.prepare('SELECT wants, slots, sched FROM swap_users WHERE key=?').bind(me).first();
    if (!r) return json({ ok: true, wants: [], calledOff: 0 });
    const wants = parse(r.wants, []).filter(w => w !== k);
    await db.prepare('UPDATE swap_users SET wants=?, updatedAt=? WHERE key=?').bind(JSON.stringify(wants), Date.now(), me).run();
    try { await env.RATEBOARD_KV.delete('swap_wantcounts_v1'); } catch (e) {}
    let res = { n: 0, late: 0 }; try { res = await afterCallOff(env, db, auth, me, await cancelDropped(db, me, new Set(wants), new Set(parse(r.slots, [])), parse(r.sched, null))); } catch (e) {}
    return json({ ok: true, wants, calledOff: res.n, late: res.late });
  }
  /* Hours save the moment they're ticked or unticked (Dennis, 2026-11-04: an
     unticked hour that was never saved still got swaps). Unticking one calls
     off its swaps still to come, under the same late-change rule. */
  if (op === 'saveslots' && request.method === 'POST') {
    let b = {}; try { b = await request.json(); } catch (e) {}
    const sched = cleanSched(b.sched);
    const slots = schedUtc(sched) || [...new Set((Array.isArray(b.slots) ? b.slots : []).map(Number).filter(h => Number.isInteger(h) && h >= 0 && h < 24))].slice(0, MAX_SLOTS);
    await matchCols(db);
    const r = await db.prepare('SELECT wants FROM swap_users WHERE key=?').bind(me).first();
    if (!r) return json({ ok: true, slots, calledOff: 0, late: 0 });
    await db.prepare('UPDATE swap_users SET slots=?, sched=?, updatedAt=? WHERE key=?').bind(JSON.stringify(slots), JSON.stringify(sched), Date.now(), me).run();
    try { await env.RATEBOARD_KV.delete('swap_hourcounts_v1'); } catch (e) {}
    let res = { n: 0, late: 0 }; try { res = await afterCallOff(env, db, auth, me, await cancelDropped(db, me, new Set(parse(r.wants, [])), new Set(slots), sched)); } catch (e) {}
    return json({ ok: true, slots, sched, calledOff: res.n, late: res.late });
  }
  /* Pause: no new matches until they save again; swaps already set keep going.
     End all: paused, and every swap still to come is called off too. */
  if ((op === 'pause' || op === 'endall') && request.method === 'POST') {
    await matchCols(db);
    await db.prepare('UPDATE swap_users SET active=0, updatedAt=? WHERE key=?').bind(Date.now(), me).run();
    try { await env.RATEBOARD_KV.delete('swap_hourcounts_v1'); await env.RATEBOARD_KV.delete('swap_wantcounts_v1'); } catch (e) {}
    let res = { n: 0, late: 0, soon: 0 };
    if (op === 'endall') {
      const rows = ((await db.prepare(`SELECT * FROM swap_matches WHERE status IN ('pending','warned') AND (a=? OR b=?)`).bind(me, me).all()).results) || [];
      for (const m of rows) await callOff(db, m, `called off: @${me} ended their swaps`, res);
      try { await afterCallOff(env, db, auth, me, res); } catch (e) {}
    }
    return json({ ok: true, paused: true, calledOff: res.n, late: res.late });
  }

  /* A member's own swaps: coming up, and the last two weeks of past ones. */
  /* Packs today (see packsToday): signed in on /swaps. */
  if (op === 'myhour') {
    await matchCols(db);
    const now = Date.now();
    const n = await db.prepare("SELECT MIN(dueAt) AS d FROM swap_matches WHERE (a=? OR b=?) AND dueAt > ? AND status IN ('pending','sending','warned','sent')").bind(me, me, now - 3600000).first();
    const l = n && n.d ? null : await db.prepare("SELECT MAX(dueAt) AS d FROM swap_matches WHERE (a=? OR b=?) AND status <> 'cleared'").bind(me, me).first();
    const at = Number((n && n.d) || (l && l.d)) || Math.ceil(now / 3600000) * 3600000;
    return json({ url: `/hour?u=${encodeURIComponent(me)}&d=${at}&t=${await hourSig(env, me, at)}`, next: !!(n && n.d) });
  }
  if (op === 'packstoday') {
    let b = {}; if (request.method === 'POST') { try { b = await request.json(); } catch (e) {} }
    return json(await packsToday(env, db, me, request.method === 'POST' ? b : null));
  }
  if (op === 'myswaps') {
    if (!(await allow(url.origin, 'myswaps:' + me, 40, 600))) return json({ error: 'Wait a few minutes and try again.' }, 429);
    await matchCols(db);
    const rows = ((await db.prepare(`SELECT id, a, b, aGets, bGets, slot, createdAt, dueAt, status, note, warnA, warnB, doneA, doneB FROM swap_matches
      WHERE (a=? OR b=?) AND createdAt > ? AND status <> 'cleared' ORDER BY COALESCE(dueAt, createdAt) DESC LIMIT 150`)
      .bind(me, me, Date.now() - 14 * 86400000).all()).results) || [];
    /* Partners: only their name and comment link (not their whole pass list -
       that made this call take seconds). Their card links come straight out
       of the saved list in the database, for the swaps still to come. */
    const mine = await loadMember(db, me), now = Date.now(), out = [];
    const pk = [...new Set(rows.map(m => (m.a === me ? m.b : m.a)))], who = new Map();
    for (let i = 0; i < pk.length; i += 90) {
      const part = pk.slice(i, i + 90);
      const r = ((await db.prepare(`SELECT key, rsUser, hashId, comment FROM swap_users WHERE key IN (${part.map(() => '?').join(',')})`).bind(...part).all()).results) || [];
      for (const x of r) who.set(x.key, x);
    }
    const isUp = m => !['cancelled', 'cancelling'].includes(m.status) && ['pending', 'sending', 'warned'].includes(m.status);
    const want = [...new Set(rows.filter(m => isUp(m) || now - (sideDue(m) || 0) < 86400000).slice(0, 60)
      .map(m => { const side = m.a === me ? 'A' : 'B'; return `${side === 'A' ? m.b : m.a}|${side === 'A' ? m.aGets : m.bGets}`; }))];
    const cardOf = new Map();
    try {
      const res = want.length ? await db.batch(want.map(x => { const [k, key] = x.split('|');
        return db.prepare(`SELECT json_extract(j.value, '$.passId') AS passId FROM swap_users u, json_each(u.passes) j
          WHERE u.key=? AND json_extract(j.value, '$.key')=? LIMIT 1`).bind(k, key); })) : [];
      res.forEach((r, i) => { const p = r && r.results && r.results[0]; if (p && p.passId) cardOf.set(want[i], `https://www.realapp.com/${routeId([18, 0, 0, Number(p.passId)])}`); });
    } catch (e) {}
    for (const m of rows) {
      const side = m.a === me ? 'A' : 'B', ok = side === 'A' ? m.b : m.a, o = who.get(ok);
      const give = side === 'A' ? m.bGets : m.aGets, get = side === 'A' ? m.aGets : m.bGets, due = sideDue(m);
      const off = m.status === 'cancelled' || m.status === 'cancelling', done = !!m['done' + side];
      out.push({ id: m.id, due, made: m.createdAt, partner: (o && o.rsUser) || null, partnerUrl: o ? profileUrl(o.rsUser, o.hashId) : null, comment: (o && o.comment) || null,
        give: mine ? playerName(mine, give) : give, giveUrl: playerUrl(give), giveCard: mine ? passUrl(mine, give) : null,
        get: mine ? playerName(mine, get) : get, getUrl: playerUrl(get), getCard: cardOf.get(`${ok}|${get}`) || null,
        warnedAt: m['warn' + side] || null, contactedAt: m['done' + side] || null,
        state: off ? 'off' : done ? 'done' : m['warn' + side] ? 'warned' : 'scheduled',
        upcoming: !off && !done && ['pending', 'sending', 'warned'].includes(m.status), note: off ? (m.note || 'called off') : null,
        byMe: off && String((String(m.note || '').match(/called off: @(\S+)/) || [])[1] || '').toLowerCase() === String(me).toLowerCase() });
    }
    // Each swap time's own page (the one the DMs link to), signed for this member.
    const hp = new Map();
    for (const x of out) if (x.due && !hp.has(x.due)) hp.set(x.due, `/hour?u=${encodeURIComponent(me)}&d=${x.due}&t=${await hourSig(env, me, x.due)}`);
    for (const x of out) x.hourUrl = hp.get(x.due) || null;
    return json({ swaps: out, now });
  }

  if (op === 'whynot') {
    if (!(await allow(url.origin, 'whynot:' + me, 6, 600))) return json({ error: 'Wait a few minutes and try again.' }, 429);
    if (!(await allow(url.origin, 'whynot-all', 30, 60))) return json({ error: HIGH_VOL }, 429);
    await matchCols(db);
    const r = await db.prepare('SELECT * FROM swap_users WHERE key=?').bind(me).first();
    const u = r ? { ...r, wants: parse(r.wants, []), keep: new Set(parse(r.keep, [])), slots: parse(r.slots, []), passes: parse(r.passes, []) } : null;
    const why = [];
    let dm = false;
    if (u && u.hashId) { try { await db.prepare(DM_DDL).run(); dm = !!(await db.prepare('SELECT 1 AS x FROM swap_dm WHERE hashId=? AND channelId IS NOT NULL').bind(u.hashId).first()); } catch (e) {} }
    if (!dm) why.push('Step 1 is not verified - the bot cannot DM you, so you are never matched.');
    if (!u || !u.comment) why.push('No comment link saved (step 2).');
    if (!u || !u.passes.length) why.push('Your passes have not been scanned (step 3).');
    const wantsAll = u ? u.wants.slice(0, MAX_WANTS) : [], want = wantsAll[0];
    if (!want) why.push('You have not picked a pass to swap for (step 4).');
    else if (wantsAll.some(w => !u.passes.some(p => p.key === w))) why.push('A pass you picked is not in your last scan - scan again or pick another.');
    if (!u || !u.slots.length) why.push('No hours picked (step 5).');
    if (u && !u.active) why.push('Your swap is not saved.');
    if (u && want) {
      const g = await goalRoom(db, new Map(), u, (x, w) => usedSince(db, x, w));
      if (g.reached) why.push(`Your pass is at ${g.rating}, which already meets your goal of ${g.goal}.`);
      else if (g.limited && g.left <= 0) why.push(`You already have the ${g.need} swap${g.need === 1 ? '' : 's'} it should take to reach your goal (about ${g.avg} rating a pack of 3 cards). New ones start after your next daily scan.`);
    }
    const open = await db.prepare(`SELECT COUNT(*) AS n FROM swap_matches WHERE (a=? OR b=?) AND (status IN ('pending','sending','warned') OR (status='sent' AND sentAt > ?))`).bind(me, me, Date.now() - 86400000).first();
    if (u && Number(u.dayCap) > 0 && Number(open && open.n) >= Number(u.dayCap)) why.push(`You have ${open.n} swap${open.n == 1 ? '' : 's'} going - your Scale limit is ${u.dayCap} a day (step 6). Raise it for more.`);
    if (u && wantsAll.length) {
      const caps = parse(u.caps, {}) || {}, full = [];
      for (const w of wantsAll) { const c = caps[w]; if (!c) continue;
        if (Number(c.n) > 0 && c.at && await usedFor(db, me, w, c.at) >= Number(c.n)) { full.push(w); continue; }
        if (Number(c.d) > 0 && await usedFor(db, me, w, Date.now() - 86400000) >= Number(c.d)) full.push(w); }
      if (full.length && full.length === wantsAll.length) why.push(`Every player you picked has reached your Scale limit for him (step 6). Raise a limit or pick another player.`);
    }
    // Who could swap with them.
    let can = 0, hour = 0, both = 0;
    if (u && want && !why.length) {
      const others = await pagedRows(db, `SELECT key, wants, keep, slots, passes FROM swap_users WHERE active=1 AND passes IS NOT NULL AND key<>?
          AND wants IS NOT NULL AND wants <> '[]' AND hashId IN (SELECT hashId FROM swap_dm WHERE channelId IS NOT NULL)`, [me]);
      const mine = new Set(u.passes.filter(p => p.kind !== 'team' && !u.keep.has(p.key)).map(p => p.key));
      for (const o of others) {
        const op_ = parse(o.passes, []), ok = new Set(parse(o.keep, []));
        if (!op_.some(p => wantsAll.includes(p.key) && p.kind !== 'team' && !ok.has(p.key))) continue;
        can++;
        if (!parse(o.slots, []).some(h => u.slots.includes(h))) continue;
        hour++;
        if (parse(o.wants, []).slice(0, MAX_WANTS).some(w => mine.has(w))) both++;
      }
      if (!can) why.push('Nobody signed up has your pass free to swap yet.');
      else if (!hour) why.push(`${can} member${can === 1 ? ' has' : 's have'} your pass free, but none share your hours - try adding hours.`);
      else if (!both) why.push(`${hour} member${hour === 1 ? '' : 's'} with your pass share your hours, but none of them want a pass you have free. Untick some keeps to give them more options.`);
      else why.push(`${both} member${both === 1 ? ' is' : 's are'} a match. Matching runs every hour at :30 - you should be matched in the next run.`);
    }
    return json({ why, ready: !!(u && want && dm), can, hour, both });
  }

  // Admin: what the bot has done today and the last week, and what failed.
  if (op === 'botstats') {
    await botTables(db); await matchCols(db); await db.prepare(DM_DDL).run();
    const days = []; for (let i = 0; i < 7; i++) days.push(etDay(Date.now() - i * 86400000));
    const rows = ((await db.prepare(`SELECT day, k, n FROM bot_stats WHERE day IN (${days.map(() => '?').join(',')})`).bind(...days).all()).results) || [];
    const by = {}; for (const r of rows) (by[r.day] = by[r.day] || {})[r.k] = r.n;
    const fails = ((await db.prepare('SELECT at, kind, msg FROM bot_log ORDER BY at DESC LIMIT 30').all()).results) || [];
    const one = async (sql, ...b) => { try { const r = await db.prepare(sql).bind(...b).first(); return Number(r && r.n) || 0; } catch (e) { return 0; } };
    try { await db.prepare(SPRO_DDL).run(); } catch (e) {}
    return json({ days: days.map(d => ({ day: d, ...(by[d] || {}) })), fails,
      chats: await one('SELECT COUNT(*) AS n FROM swap_dm WHERE channelId IS NOT NULL'),
      swappers: await one(`SELECT COUNT(*) AS n FROM swap_users WHERE active=1 AND passes IS NOT NULL AND wants IS NOT NULL AND wants <> '[]'`),
      open: await one(`SELECT COUNT(*) AS n FROM swap_matches WHERE status IN ('pending','warned')`),
      errors: await one(`SELECT COUNT(*) AS n FROM swap_matches WHERE status='error'`),
      proYes: await one('SELECT COUNT(*) AS n FROM swap_pro WHERE pro=1'), proNo: await one('SELECT COUNT(*) AS n FROM swap_pro WHERE pro=0'),
      newChatsLeft: await newChatsLeft(env) });
  }

  // How many saved swappers picked each player, kept 5 minutes.
  if (op === 'wantcounts') {
    let c = null; try { c = JSON.parse((await env.RATEBOARD_KV.get('swap_wantcounts_v1')) || 'null'); } catch (e) {}
    if (!c || Date.now() - c.at > 300000) {
      const n = {};
      for (const r of ((await db.prepare(`SELECT wants FROM swap_users WHERE active=1 AND wants IS NOT NULL AND wants <> '[]'`).all()).results || []))
        { for (const w of parse(r.wants, []).slice(0, MAX_WANTS)) n[w] = (n[w] || 0) + 1; }
      c = { at: Date.now(), n };
      try { await env.RATEBOARD_KV.put('swap_wantcounts_v1', JSON.stringify(c)); } catch (e) {}
    }
    return json(c);
  }

  // How many saved swappers picked each hour (UTC), kept 5 minutes.
  if (op === 'hourcounts') {
    let c = null; try { c = JSON.parse((await env.RATEBOARD_KV.get('swap_hourcounts_v1')) || 'null'); } catch (e) {}
    if (!c || Date.now() - c.at > 300000) {
      const n = Array(24).fill(0);
      for (const r of ((await db.prepare(`SELECT slots FROM swap_users WHERE active=1 AND slots IS NOT NULL AND slots <> '[]'`).all()).results || []))
        for (const h of parse(r.slots, [])) if (h >= 0 && h < 24) n[h]++;
      c = { at: Date.now(), n };
      try { await env.RATEBOARD_KV.put('swap_hourcounts_v1', JSON.stringify(c)); } catch (e) {}
    }
    return json(c);
  }

  // Reports from the Swaps page: someone misusing swaps, or a problem with it.
  if (op === 'report' && request.method === 'POST') {
    let b = {}; try { b = await request.json(); } catch (e) {}
    const kind = b.kind === 'problem' ? 'problem' : b.kind === 'refund' ? 'refund' : 'user';
    let target = String(b.target || '').trim().replace(/^@/, '').slice(0, 60), detail = String(b.detail || '').trim().slice(0, 1000), matchId = null;
    if (kind === 'refund') {
      // A called-off swap they were in: rax back for the pack, or a replacement swap.
      await matchCols(db);
      const m = await db.prepare(`SELECT * FROM swap_matches WHERE id=? AND (a=? OR b=?) AND status IN ('cancelled','cancelling')`).bind(Number(b.matchId), me, me).first();
      if (!m) return json({ error: 'Pick the called-off swap.' }, 400);
      if (String((String(m.note || '').match(/called off: @(\S+)/) || [])[1] || '').toLowerCase() === String(me).toLowerCase())
        return json({ error: 'You called that swap off yourself, so there is no rax back for it.' }, 400);
      const side = m.a === me ? 'A' : 'B', o = await loadMember(db, side === 'A' ? m.b : m.a), mine = await loadMember(db, me);
      matchId = m.id; target = (o && o.rsUser) || (side === 'A' ? m.b : m.a);
      const want = b.want === 'replace' ? 'a replacement swap' : 'rax back for the pack';
      const nc = new Map(), gaveP = await indexName(db, side === 'A' ? m.bGets : m.aGets, nc), getP = await indexName(db, side === 'A' ? m.aGets : m.bGets, nc);
      detail = `Called-off swap #${m.id} (${new Date(sideDue(m)).toISOString().slice(0, 16).replace('T', ' ')} UTC) with @${target}: they bought ${gaveP} (for @${target}), and were to get ${getP} from @${target}. Wants ${want}.` + (detail ? `\n${detail}` : '');
    } else if (detail.length < 5) return json({ error: 'Say what happened.' }, 400);
    if (kind === 'user' && target.length < 2) return json({ error: 'Enter their Real username.' }, 400);
    if (!(await allow(url.origin, 'swapreport:' + me, 6, 3600))) return json({ error: 'You have sent a lot of reports - try again later.' }, 429);
    await db.prepare(SREPORT_DDL).run();
    try { await alterOnce(db, 'ALTER TABLE swap_reports ADD COLUMN matchId INTEGER'); } catch (e) {}
    await db.prepare('INSERT INTO swap_reports (ts, by_user, kind, target, detail, status, matchId) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(Date.now(), me, kind, target || null, detail, 'open', matchId).run();
    await stat(db, kind === 'user' ? 'report_user' : 'report_problem');
    return json({ ok: true });
  }
  // Admin: what one member's saved scan holds, by sport and season; ?clear=1 lets them scan again now.
  if (op === 'passcounts') {
    const name = String(url.searchParams.get('user') || '').trim().replace(/^@/, '').toLowerCase();
    const r = await db.prepare('SELECT key, rsUser, passes, scannedAt, boostScanAt FROM swap_users WHERE LOWER(key)=? OR LOWER(rsUser)=?').bind(name, name).first();
    if (!r) return json({ error: 'No Swaps scan saved for that member.' }, 404);
    if (url.searchParams.get('clear') === '1') { await db.prepare('UPDATE swap_users SET scannedAt=NULL, boostScanAt=NULL WHERE key=?').bind(r.key).run(); return json({ cleared: true, key: r.key }); }
    const c = {}; for (const p of parse(r.passes, [])) { const k = `${p.sport} ${p.season}${p.kind === 'team' ? ' team' : ''}`; c[k] = (c[k] || 0) + 1; }
    return json({ key: r.key, rsUser: r.rsUser, scannedAt: r.scannedAt, boostScanAt: r.boostScanAt, total: parse(r.passes, []).length,
      counts: Object.entries(c).sort((a, b) => a[0].localeCompare(b[0])) });
  }

  /* Admin: every saved swapper - their picks (names from their own passes,
     picked out in the database), hours, Scale limits, and a count of their
     matches; ?user= adds that member's matches, newest first. */
  if (op === 'swappers') {
    await matchCols(db);
    const rows = ((await db.prepare(`SELECT key, rsUser, wants, slots, dayCap, caps, goal, scannedAt, updatedAt, active, hashId,
        (SELECT json_group_array(json_object('key', w.value,
             'name', (SELECT json_extract(p.value, '$.name') FROM json_each(swap_users.passes) p WHERE json_extract(p.value, '$.key') = w.value LIMIT 1),
             'rating', (SELECT json_extract(p.value, '$.rating') FROM json_each(swap_users.passes) p WHERE json_extract(p.value, '$.key') = w.value LIMIT 1),
             'level', (SELECT json_extract(p.value, '$.levelLabel') FROM json_each(swap_users.passes) p WHERE json_extract(p.value, '$.key') = w.value LIMIT 1),
             'progress', (SELECT json_extract(p.value, '$.progress') FROM json_each(swap_users.passes) p WHERE json_extract(p.value, '$.key') = w.value LIMIT 1)))
           FROM json_each(swap_users.wants) w) AS picks
        FROM swap_users WHERE wants IS NOT NULL AND wants <> '[]' ORDER BY updatedAt DESC LIMIT 500`).all()).results) || [];
    const since = Date.now() - 14 * 86400000;
    const cnt = ((await db.prepare(`SELECT k, SUM(CASE WHEN status IN ('pending','sending','warned') THEN 1 ELSE 0 END) AS open, COUNT(*) AS n FROM (
        SELECT a AS k, status FROM swap_matches WHERE createdAt > ? AND status <> 'cleared' UNION ALL SELECT b AS k, status FROM swap_matches WHERE createdAt > ? AND status <> 'cleared') GROUP BY k`).bind(since, since).all()).results) || [];
    const cm = new Map(cnt.map(x => [x.k, x]));
    let restricted = new Set(); try { await db.prepare(RESTRICT_DDL).run(); restricted = new Set((((await db.prepare('SELECT key FROM restricted').all()).results) || []).map(x => x.key)); } catch (e) {}
    const users = rows.map(r => ({ key: r.key, rsUser: r.rsUser || r.key, active: !!r.active, restricted: restricted.has(r.key), slots: parse(r.slots, []),
      picks: parse(r.picks, []), goal: r.goal ?? null, dayCap: r.dayCap ?? null, caps: parse(r.caps, {}) || {}, scannedAt: r.scannedAt, updatedAt: r.updatedAt,
      open: Number((cm.get(r.key) || {}).open) || 0, matches14: Number((cm.get(r.key) || {}).n) || 0 }));
    let matches = null;
    const who = String(url.searchParams.get('user') || '');
    if (who) {
      const ms = ((await db.prepare(`SELECT * FROM swap_matches WHERE (a=? OR b=?) AND createdAt > ? AND status <> 'cleared' ORDER BY COALESCE(dueAt, createdAt) DESC LIMIT 100`).bind(who, who, since).all()).results) || [];
      const cache = new Map(), member = async k => cache.has(k) ? cache.get(k) : (cache.set(k, await loadMember(db, k)), cache.get(k));
      const mine = await member(who);
      matches = [];
      for (const m of ms) {
        const side = m.a === who ? 'A' : 'B', o = await member(side === 'A' ? m.b : m.a);
        const give = side === 'A' ? m.bGets : m.aGets, get = side === 'A' ? m.aGets : m.bGets;
        matches.push({ id: m.id, due: sideDue(m), status: m.status, note: m.note || null, partner: (o && o.rsUser) || (side === 'A' ? m.b : m.a),
          give: mine ? playerName(mine, give) : give, get: mine ? playerName(mine, get) : get,
          warned: !!m['warn' + side], contacted: !!m['done' + side], followed: !!m['follow' + side] });
      }
    }
    return json({ users, matches });
  }

  // Admin: who picked each hour (UTC), with their rank for it and their pick.
  if (op === 'hourusers') {
    // Just the name of their first pick, picked out in the database rather than shipping every pass.
    const rows = ((await db.prepare(`SELECT key, rsUser, slots, wants,
        (SELECT json_extract(j.value, '$.name') FROM json_each(swap_users.passes) j WHERE json_extract(j.value, '$.key') = json_extract(swap_users.wants, '$[0]') LIMIT 1) AS wantName
        FROM swap_users WHERE active=1 AND slots IS NOT NULL AND slots <> '[]'`).all()).results) || [];
    const hours = Array.from({ length: 24 }, () => []);
    for (const r of rows) {
      const want = parse(r.wants, [])[0] || null;
      const p = want ? { name: r.wantName } : null;
      parse(r.slots, []).forEach((h, i) => { if (h >= 0 && h < 24) hours[h].push({ key: r.key, rsUser: r.rsUser || r.key, rank: i + 1, want, wantName: p && p.name || null }); });
    }
    for (const l of hours) l.sort((a, b) => a.rank - b.rank || String(a.rsUser).localeCompare(String(b.rsUser)));
    return json({ hours, members: rows.length });
  }

  // Admin: the reports, and closing one out.
  /* Admin: send one member everything for one swap hour again - the warning
     and the contact message, for every swap of theirs in that hour that's
     still on. Their swaps aren't touched; it's only the messages. */
  if (op === 'resendhour' && request.method === 'POST') {
    let b = {}; try { b = await request.json(); } catch (e) {}
    const who = String(b.user || ''), due = Number(b.due);
    if (!who || !due) return json({ error: 'Pick a member and a swap hour.' }, 400);
    await matchCols(db);
    const ms = ((await db.prepare(`SELECT * FROM swap_matches WHERE (a=? OR b=?) AND dueAt=? AND status NOT IN ('cancelled','cancelling','cleared')`).bind(who, who, due).all()).results) || [];
    if (!ms.length) return json({ error: 'No swaps of theirs in that hour.' }, 404);
    const cache = new Map(), member = async k => cache.has(k) ? cache.get(k) : (cache.set(k, await loadMember(db, k)), cache.get(k));
    const items = [];
    for (const m of ms) { const l = await sideLines(member, m, m.a === who ? 'A' : 'B'); if (l) items.push(l); }
    const me2 = await member(who);
    if (!me2 || !me2.hashId) return json({ error: 'They have no Real account on file.' }, 400);
    let ch; try { ch = await dmChannel(db, auth, me2.hashId, me2.rsUser, env); } catch (e) { return json({ error: 'No chat with them: ' + String(e.message || e).slice(0, 120) }, 400); }
    const msgs = [...warnGrouped(items), ...contactGrouped(items, [])];
    let sentN = 0;
    for (let i = 0; i < msgs.length; i++) {
      try { await dmSendRetry(auth, ch, msgs[i]); sentN++; await stat(db, 'dm_resend'); await sleep(1500); }
      catch (e) { await queueDm(db, ch, msgs.slice(i), `resend @${me2.rsUser}`); break; }
    }
    return json({ ok: true, swaps: ms.length, messages: msgs.length, sent: sentN, queued: msgs.length - sentN });
  }

  /* ---- Admin inbox ---- */
  if (op === 'inbox') return json({ items: await inboxItems(env, db) });
  if (op === 'inboxact' && request.method === 'POST') {
    let b = {}; try { b = await request.json(); } catch (e) {}
    const action = ['done', 'declined', 'delete', 'reply', 'replyabout', 'restrict', 'ban', 'refunded'].includes(b.action) ? b.action : null;
    if (!action) return json({ error: 'bad action' }, 400);
    const item = (await inboxItems(env, db)).find(x => x.src === b.src && x.id === String(b.id));
    if (!item) return json({ error: 'That one is already closed.' }, 404);
    const out = { ok: true };
    // A custom message to the person who was reported (outcome notes only ever go to whoever reported).
    if (action === 'replyabout') {
      const text = String(b.text || '').trim().slice(0, 1000);
      if (!text) return json({ error: 'Write a message first.' }, 400);
      if (!item.about) return json({ error: 'Nobody is named in this report.' }, 400);
      const head = `This message is in reference to a ${item.src === 'swap' ? 'Swaps' : 'board'} report made about you`;
      out.dm = await adminDm(db, auth, item.about, `${head}\n-\n${text}`, `${item.src}:${item.id}:about`);
      return json(out);
    }
    if (action === 'reply') {
      const text = String(b.text || '').trim().slice(0, 1000);
      if (!text) return json({ error: 'Write a reply first.' }, 400);
      // Says what it's about at the top, then a dash line, then the reply.
      const q = String(item.src === 'feature' ? item.title || item.detail || '' : item.detail || '').replace(/\s+/g, ' ').trim();
      const quote = q.length > 140 ? q.slice(0, 140) + '…' : q;
      const head = `This message is in reference to your ${item.src === 'feature' ? 'feature request' : 'report'} for "${quote}"`;
      out.dm = await adminDm(db, auth, item.from, `${head}\n-\n${text}`, `${item.src}:${item.id}`);
      return json(out);
    }
    // Rax sent back by hand for a called-off swap: marked on the swap, report completed, reporter told.
    if (action === 'refunded') {
      const mid = Number(b.matchId) || item.matchId; const m = mid ? await db.prepare('SELECT a, b FROM swap_matches WHERE id=?').bind(mid).first() : null;
      if (!m || !item.from) return json({ error: 'No called-off swap to mark.' }, 400);
      const side = m.a === item.from.key ? 'A' : m.b === item.from.key ? 'B' : null;
      if (!side) return json({ error: 'They were not in that swap.' }, 400);
      await db.prepare(`UPDATE swap_matches SET refund${side}=? WHERE id=?`).bind(Date.now(), mid).run();
      await closeItem(env, db, item, 'done');
      if (b.notify !== false) out.dm = await adminDm(db, auth, item.from, `Your rax for the called-off swap with @${item.target || 'your partner'} has been refunded. Your report has been completed.`, `${item.src}:${item.id}`);
      return json(out);
    }
    if (action === 'restrict' || action === 'ban') {
      const t = item.about; if (!t || !t.key) return json({ error: 'No board account found for the reported user.' }, 404);
      await db.prepare(RESTRICT_DDL).run();
      await db.prepare('INSERT OR REPLACE INTO restricted (key, at, why) VALUES (?, ?, ?)').bind(t.key, Date.now(), `${item.src}:${item.id}`).run();
      await db.prepare('UPDATE swap_users SET active=0 WHERE key=?').bind(t.key).run();
      await db.prepare('DELETE FROM offers WHERE user=?').bind(t.key).run().catch(() => {});
      try { await db.prepare("UPDATE swap_matches SET status='cancelling' WHERE status IN ('pending','warned') AND (a=? OR b=?)").bind(t.key, t.key).run(); } catch (e) {}
      if (action === 'ban') await db.prepare('UPDATE users SET banned=1 WHERE key=?').bind(t.key).run();
    }
    const status = action === 'declined' ? 'declined' : action === 'delete' ? 'delete' : 'done';
    await closeItem(env, db, item, status);
    if (status !== 'delete' && b.notify !== false) out.dm = await adminDm(db, auth, item.from, outcomeText(item, status), `${item.src}:${item.id}`);
    return json(out);
  }
  // Every called-off swap in the last 30 days, both sides, with who was told to buy and who's been refunded.
  if (op === 'calledoff') {
    await matchCols(db);
    const mark = url.searchParams.get('refund'), side = url.searchParams.get('side');
    if (mark && (side === 'A' || side === 'B')) await db.prepare(`UPDATE swap_matches SET refund${side}=CASE WHEN refund${side} IS NULL THEN ? ELSE NULL END WHERE id=?`).bind(Date.now(), Number(mark)).run();
    const rows = ((await db.prepare(`SELECT * FROM swap_matches WHERE status IN ('cancelled','cancelling') AND createdAt > ? ORDER BY COALESCE(dueAt, createdAt) DESC LIMIT 300`).bind(Date.now() - 30 * 86400000).all()).results) || [];
    try { await alterOnce(db, 'ALTER TABLE swap_reports ADD COLUMN matchId INTEGER'); } catch (e) {}
    const reps = new Set((((await db.prepare("SELECT matchId, by_user FROM swap_reports WHERE matchId IS NOT NULL").all()).results) || []).map(r => `${r.matchId}|${r.by_user}`));
    // Names without loading anyone's passes: Real usernames from swap_users, player names from the search index.
    const keys = [...new Set(rows.flatMap(m => [m.a, m.b]))], rs = new Map();
    for (let i = 0; i < keys.length; i += 50) { const part = keys.slice(i, i + 50);
      for (const r of (((await db.prepare(`SELECT key, rsUser FROM swap_users WHERE key IN (${part.map(() => '?').join(',')})`).bind(...part).all()).results) || [])) rs.set(r.key, r.rsUser || r.key); }
    const pn = new Map(), pname = async k => { if (pn.has(k)) return pn.get(k); const [sp, se, id] = String(k).split(':'); let n = null;
      try { const r = await db.prepare('SELECT player FROM swap_index WHERE sport=? AND season=? AND playerId=? LIMIT 1').bind(sp, Number(se), Number(String(id).replace(/^t/, ''))).first(); n = r && r.player; } catch (e) {}
      const v = `${n || 'Player ' + id} ${se}`; pn.set(k, v); return v; };
    const out = [];
    for (const m of rows) {
      out.push({ id: m.id, due: sideDue(m), note: m.note || null, status: m.status,
        a: { key: m.a, rsUser: rs.get(m.a) || m.a, buys: await pname(m.bGets), told: !!(m.warnA || m.doneA), refunded: m.refundA || null, reported: reps.has(`${m.id}|${m.a}`) },
        b: { key: m.b, rsUser: rs.get(m.b) || m.b, buys: await pname(m.aGets), told: !!(m.warnB || m.doneB), refunded: m.refundB || null, reported: reps.has(`${m.id}|${m.b}`) } });
    }
    return json({ rows: out });
  }
  // Take a restriction off again.
  if (op === 'unrestrict' && request.method === 'POST') {
    let b = {}; try { b = await request.json(); } catch (e) {}
    await db.prepare(RESTRICT_DDL).run();
    await db.prepare('DELETE FROM restricted WHERE key=?').bind(String(b.key || '')).run();
    if (b.unban) await db.prepare('UPDATE users SET banned=0 WHERE key=?').bind(String(b.key || '')).run();
    return json({ ok: true });
  }
  // Everyone Dennis has messaged through the bot, newest first, with whether they wrote back.
  if (op === 'dmlog') {
    await db.prepare(ADMIN_DM_DDL).run();
    const rows = ((await db.prepare(`SELECT key, rsUser, hashId, channelId, MAX(ts) AS last, COUNT(*) AS n,
        (SELECT text FROM admin_dm d2 WHERE d2.channelId = admin_dm.channelId ORDER BY ts DESC LIMIT 1) AS lastText
        FROM admin_dm GROUP BY channelId ORDER BY last DESC LIMIT 60`).all()).results) || [];
    const check = url.searchParams.get('check') === '1';
    for (const [i, r] of rows.entries()) {
      if (!check || i >= 25) continue;
      try { Object.assign(r, await chatState(auth, r.channelId, r.hashId, Number(r.last))); } catch (e) { r.error = String(e.message || e).slice(0, 120); }
    }
    return json({ rows, checked: check });
  }
  // "check": puts the chat at the top of the bot's DMs, so the whole conversation is easy to find on Real.
  if (op === 'dmcheck' && request.method === 'POST') {
    let b = {}; try { b = await request.json(); } catch (e) {}
    const who = await whoIs(db, b.who);
    if (!who || !who.channelId) return json({ error: 'No open chat with the bot.' }, 404);
    return json(await adminDm(db, auth, who, 'check', 'check'));
  }
  // A message to anyone the bot has a chat with.
  if (op === 'dmsend' && request.method === 'POST') {
    let b = {}; try { b = await request.json(); } catch (e) {}
    const who = await whoIs(db, b.who), text = String(b.text || '').trim().slice(0, 1000);
    if (!text) return json({ error: 'Write a message first.' }, 400);
    if (!who || !who.channelId) return json({ error: 'No open chat with the bot.' }, 404);
    return json(await adminDm(db, auth, who, text, 'direct'));
  }

  if (op === 'reports') {
    await db.prepare(SREPORT_DDL).run();
    const id = Number(url.searchParams.get('close'));
    if (id) await db.prepare("UPDATE swap_reports SET status='closed' WHERE rowid=?").bind(id).run();
    const rows = ((await db.prepare("SELECT rowid AS id, ts, by_user, kind, target, detail FROM swap_reports WHERE status='open' ORDER BY ts DESC LIMIT 200").all()).results) || [];
    return json({ rows });
  }

  if (op === 'search') {
    const q = String(url.searchParams.get('q') || '').trim().toLowerCase().replace(/[%_]/g, '');
    try { waitUntil(indexOne(db).catch(() => {})); } catch (e) {}
    if (q.length < 2) return json({ rows: [] });
    let rows = [];
    try {
      rows = (await db.prepare(`SELECT sport, season, playerId, player, team, rax, games FROM swap_index
        WHERE lname LIKE ? OR lname LIKE ? ORDER BY rax DESC LIMIT 40`).bind(q + '%', '% ' + q + '%').all()).results || [];
    } catch (e) { rows = []; }
    // Owners from each player-season's latest daily count.
    if (rows.length) {
      try {
        const res = await db.batch(rows.map(r => db.prepare(
          'SELECT owners FROM owners WHERE sport=? AND season=? AND playerId=? ORDER BY day DESC LIMIT 1').bind(r.sport, r.season, r.playerId)));
        res.forEach((x, i) => { const o = x.results && x.results[0]; rows[i].owners = o ? o.owners : null; });
      } catch (e) {}
    }
    return json({ rows });
  }
  /* OTD optimiser: every game of every pass the member holds, as
     [MM-DD, rax] pairs, one query per sport-season. */
  if (op === 'games') {
    const u = await db.prepare('SELECT passes FROM swap_users WHERE key=?').bind(me).first();
    const passes = parse(u && u.passes, []);
    const groups = {};
    for (const p of passes) if (p.kind !== 'team') (groups[`${p.sport}|${p.season}`] = groups[`${p.sport}|${p.season}`] || []).push(p.id);
    const out = {};
    /* Team passes: there's no team game log, so each team's per-day rax comes
       from Real's earnings screen for that team (the same one the player rax
       comes from), kept for a day. */
    await db.prepare(`CREATE TABLE IF NOT EXISTS swap_teamrax (sport TEXT, season INTEGER, teamId INTEGER,
      days TEXT, at INTEGER, PRIMARY KEY (sport, season, teamId))`).run();
    const teams = passes.filter(p => p.kind === 'team' && p.sport !== 'ufc');   // UFC isn't on the OTD page
    let fetched = 0;
    for (const t of teams) {
      const row = await db.prepare('SELECT days, at FROM swap_teamrax WHERE sport=? AND season=? AND teamId=?').bind(t.sport, t.season, t.id).first();
      let days = row && Date.now() - row.at < 86400000 ? parse(row.days, null) : null;
      if (!days && auth && fetched < 60) {
        try {
          const d = await rsGetJson(`https://web.realapp.com/userpassearnings/${t.sport}/season/${t.season}/entity/team/${t.id}`, auth);
          days = ((d && d.earnings) || []).filter(e => e && e.day && Number(e.earnings) > 0)
            .map(e => [String(e.day).slice(5, 10), Number(e.earnings)]);
          await db.prepare('INSERT OR REPLACE INTO swap_teamrax (sport, season, teamId, days, at) VALUES (?, ?, ?, ?, ?)')
            .bind(t.sport, t.season, t.id, JSON.stringify(days), Date.now()).run();
          fetched++;
          await sleep(200);
        } catch (e) { days = row ? parse(row.days, []) : []; }
      }
      if (days && days.length) out[t.key] = days;
    }
    // Each season's games come from a saved copy shared by everyone (see
    // otdSeason), so a load reads KV instead of the game log.
    for (const [g, ids] of Object.entries(groups)) {
      const [sp, se] = g.split('|');
      const games = await otdSeason(env, db, sp, Number(se));
      for (const id of ids) { const v = games[id]; if (v && v.length) out[`${sp}:${se}:${id}`] = v; }
    }
    return json({ passes, games: out });
  }

  if (op === 'buildindex') {
    // A few seasons per call with a breather between, so building the
    // table never crowds the database.
    const done = [];
    const j = await indexOne(db); if (j) done.push(j);
    return json({ built: done });
  }

  // Which token names exist (names only, never values).
  if (op === 'env') {
    // Every setting's name (never a value), so a token saved under any name can be spotted.
    return json({ settingNames: Object.keys(env).filter(k => typeof env[k] === 'string'), swapTokenFound: !!auth });
  }

  if (op === 'me') {
    touchSeen(env, me, waitUntil);
    // The member's row, whether the bot has a chat with them, and their Real name: one trip.
    try { await db.prepare(DM_DDL).run(); } catch (e) {}
    try { await alterOnce(db, 'ALTER TABLE users ADD COLUMN rsName TEXT'); } catch (e) {}
    let u = null, connected = false, realN = String(me);
    try {
      const [r1, r2, r3] = await db.batch([
        db.prepare('SELECT * FROM swap_users WHERE key=?').bind(me),
        db.prepare('SELECT 1 AS x FROM swap_dm WHERE hashId=(SELECT hashId FROM swap_users WHERE key=?) AND channelId IS NOT NULL').bind(me),
        db.prepare('SELECT rsName FROM users WHERE key=?').bind(me)]);
      u = (r1.results || [])[0] || null; connected = !!(r2.results || []).length;
      const rn = (r3.results || [])[0]; if (rn && rn.rsName) realN = String(rn.rsName);
    } catch (e) {
      u = await db.prepare('SELECT * FROM swap_users WHERE key=?').bind(me).first();
      realN = await realName(db, me);
    }
    mark(request, 'row' + (u && u.passes ? '(' + Math.round(u.passes.length / 1024) + 'kb)' : ''));
    // Passes scanned before a name source existed get their names now.
    if (u && u.passes) {
      const ps = parse(u.passes, []);
      // Only passes never looked up before (a freshman with no games yet can't
      // be named, and used to be looked up - and the row rewritten - on every open).
      const need = ps.filter(p => (!p.name || /^player$/i.test(p.name)) && !p.nameTried);
      if (need.length) {
        const before = JSON.stringify(ps.map(p => p.name));
        await fillNames(db, ps);
        for (const p of need) p.nameTried = 1;
        u.passes = JSON.stringify(ps);
        try { await db.prepare('UPDATE swap_users SET passes=? WHERE key=?').bind(u.passes, me).run(); } catch (e) {}
        void before;
      }
    }
    mark(request, 'names');
    // Boosts only needs how many passes are on file, not the list (or the play counts).
    const lite = url.searchParams.get('page') === 'boosts';
    const lowP = u && !lite ? await (async () => { try { return [...await lowPlays(env, db, parse(u.passes, []).filter(p => p.kind !== 'team').map(p => p.key))]; } catch (e) { return []; } })() : [];
    mark(request, 'plays');
    return json({ key: me, admin: acc.admin, swaps: acc.swaps, otd: acc.otd, boostModes: acc.admin || BOOST_FAST.has(String(me || '').toLowerCase()), tokenFound: !!auth, connected, profile: u ? { rsUser: u.rsUser, hashId: u.hashId, wants: parse(u.wants, []),
      keep: parse(u.keep, []), touch: parse(u.touch, []), slots: parse(u.slots, []), sched: parse(u.sched, null), passes: lite ? [] : parse(u.passes, []), passCount: (() => { try { return parse(u.passes, []).length; } catch (e) { return 0; } })(), lowPlays: lowP, scannedAt: u.scannedAt, active: !!u.active, comment: u.comment || '', goal: u.goal ?? null, dayCap: u.dayCap ?? null, caps: parse(u.caps, {}) || {} } : null, real: realN });
  }

  // A tick in the passes list saves at once: the passes they won't give.
  /* Step 3's untouchable list: the ones they'll swap anyway. Turning one back
     to "never swap" calls off its swaps still to come, like a kept pass. */
  if (op === 'touch' && request.method === 'POST') {
    let b = {}; try { b = await request.json(); } catch (e) {}
    const touch = (Array.isArray(b.touch) ? b.touch : []).map(String).filter(k => /^[a-z]+:\d{4}:t?\d+$/.test(k)).slice(0, 2000);
    await matchCols(db);
    const r = await db.prepare('SELECT passes FROM swap_users WHERE key=?').bind(me).first();
    if (!r) return json({ error: 'Scan your passes first.' }, 400);
    await db.prepare('UPDATE swap_users SET touch=?, updatedAt=? WHERE key=?').bind(JSON.stringify(touch), Date.now(), me).run();
    const t = new Set(touch), never = new Set(parse(r.passes, []).filter(p => p.untouchable && !t.has(p.key)).map(p => p.key));
    const res = await afterCallOff(env, db, auth, me, await cancelKept(db, me, never));
    return json({ ok: true, touch: touch.length, cancelled: res.n, late: res.late });
  }
  if (op === 'keep' && request.method === 'POST') {
    let b = {}; try { b = await request.json(); } catch (e) {}
    const keep = (Array.isArray(b.keep) ? b.keep : []).map(String).filter(k => /^[a-z]+:\d{4}:t?\d+$/.test(k)).slice(0, 3000);
    await db.prepare(`INSERT INTO swap_users (key, keep, updatedAt, active, wants, slots) VALUES (?, ?, ?, 0, '[]', '[]')
      ON CONFLICT(key) DO UPDATE SET keep=excluded.keep, updatedAt=excluded.updatedAt`).bind(me, JSON.stringify(keep), Date.now()).run();
    const res = await afterCallOff(env, db, auth, me, await cancelKept(db, me, new Set(keep)));
    return json({ ok: true, keep: keep.length, cancelled: res.n, late: res.late });
  }

  if (op === 'save' && request.method === 'POST') {
    try { await db.prepare(RESTRICT_DDL).run(); if (await db.prepare('SELECT 1 AS x FROM restricted WHERE key=?').bind(me).first()) return json({ error: 'Your account can no longer use Swaps.' }, 403); } catch (e) {}
    let b = {};
    try { b = await request.json(); } catch (e) {}
    const wants = (Array.isArray(b.wants) ? b.wants : []).map(String).filter(k => /^[a-z]+:\d{4}:t?\d+$/.test(k)).slice(0, MAX_WANTS);
    const keep = (Array.isArray(b.keep) ? b.keep : []).map(String).filter(k => /^[a-z]+:\d{4}:t?\d+$/.test(k)).slice(0, 2000);
    const sched = cleanSched(b.sched);
    const slots = schedUtc(sched) || [...new Set((Array.isArray(b.slots) ? b.slots : []).map(Number).filter(h => Number.isInteger(h) && h >= 0 && h < 24))].slice(0, MAX_SLOTS);
    const rsUser = await realName(db, me);   // their Real account: board username, or the one they linked
    const mine = await db.prepare('SELECT passes FROM swap_users WHERE key=?').bind(me).first();
    const owned = new Set(parse(mine && mine.passes, []).filter(p => p.kind !== 'team').map(p => p.key));
    if (wants.some(w => !owned.has(w))) return json({ error: 'You can only swap for passes you own - scan your passes, then pick from them.' }, 400);
    if (wants.some(w => seasonOff(w))) return json({ error: '2026-27 CBB and NBA passes can\'t be swapped yet.' }, 400);
    { const low = await lowPlays(env, db, wants);
      if (low.size) return json({ error: `Only players with ${MIN_PLAYS}+ collectible plays can be swapped for - remove ${[...low].length === 1 ? 'the one' : 'the ones'} marked "under ${MIN_PLAYS} plays".`, low: [...low] }, 400); }
    const comment = String(b.comment || '').trim();
    if (!SWAP_COMMENT_RE.test(comment)) return json({ error: 'That link is not a comment under the swap post. Open the swap post, copy the link to your comment, and paste it in step 2.' }, 400);
    const goal = b.goal === '' || b.goal == null ? null : Number(b.goal);
    if (goal != null && !(goal > 0 && goal < 100000)) return json({ error: 'Goal rating has to be a number.' }, 400);
    await matchCols(db);
    // Scale (optional): swaps a day, and swaps per player overall.
    const dayCap = b.dayCap === '' || b.dayCap == null ? null : Number(b.dayCap);
    if (dayCap != null && !(Number.isInteger(dayCap) && dayCap >= 1 && dayCap <= 999)) return json({ error: 'Swaps a day has to be a whole number, 1 or more.' }, 400);
    const oldCaps = parse((await db.prepare('SELECT caps FROM swap_users WHERE key=?').bind(me).first() || {}).caps, {}) || {};
    const caps = {};
    const capNum = v => { if (v === '' || v == null) return null; const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= 999 ? n : NaN; };
    for (const w of wants) {
      const v = (b.caps && b.caps[w]) || {};
      const n = capNum(typeof v === 'object' ? v.n : v), d = capNum(typeof v === 'object' ? v.d : null);
      if (Number.isNaN(n) || Number.isNaN(d)) return json({ error: 'Swap limits have to be whole numbers, 1 or more.' }, 400);
      const gv = typeof v === 'object' && v.g !== '' && v.g != null ? Number(v.g) : null;
      if (gv != null && !(gv > 0 && gv < 100000)) return json({ error: 'Goal rating has to be a number.' }, 400);
      if (n == null && d == null && gv == null) continue;
      const c = {};
      if (gv != null) c.g = gv;   // goal rating for this player
      // The total counts from when it is set; saving it again unchanged keeps the count going.
      if (n != null) { c.n = n; c.at = oldCaps[w] && Number(oldCaps[w].n) === n && oldCaps[w].at ? oldCaps[w].at : Date.now(); }
      if (d != null) c.d = d;
      caps[w] = c;
    }
    await db.prepare(`INSERT INTO swap_users (key, rsUser, wants, keep, slots, updatedAt, active, comment, goal) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(key) DO UPDATE SET rsUser=excluded.rsUser, wants=excluded.wants, keep=excluded.keep,
        slots=excluded.slots, updatedAt=excluded.updatedAt, active=1, comment=excluded.comment, goal=excluded.goal`)
      .bind(me, rsUser, JSON.stringify(wants), JSON.stringify(keep), JSON.stringify(slots), Date.now(), comment.slice(0, 300), goal).run();
    await db.prepare('UPDATE swap_users SET dayCap=?, caps=?, sched=? WHERE key=?').bind(dayCap, JSON.stringify(caps), JSON.stringify(sched), me).run();
    try { await env.RATEBOARD_KV.delete('swap_hourcounts_v1'); await env.RATEBOARD_KV.delete('swap_wantcounts_v1'); } catch (e) {}
    let calledOff = 0, late = 0;
    try { const a = await cancelKept(db, me, new Set(keep)), d = await cancelDropped(db, me, new Set(wants), new Set(slots), sched);
      const res = await afterCallOff(env, db, auth, me, { n: a.n + d.n, late: a.late + d.late, soon: a.soon + d.soon }); calledOff = res.n; late = res.late; } catch (e) {}
    return json({ ok: true, wants, keep: keep.length, slots, calledOff, late });
  }

  /* One scan for the whole site (Swaps, Boosts, OTD). The page keeps asking
     (each ask works ~20s and saves progress); if the page goes away, the
     server's every-minute job carries the scan on, so people can tap scan and
     leave. A line keeps it to SCAN_AT_ONCE scans at a time. */
  if (op === 'scanstatus') {
    await scanTables(db);
    const q = await db.prepare('SELECT joinedAt, startedAt FROM scan_queue WHERE key=?').bind(me).first();
    const job = await loadJob(db, me);
    if (job) return json({ state: 'running' });
    if (q && !q.startedAt) {
      const ahead = await db.prepare('SELECT COUNT(*) AS n FROM scan_queue WHERE startedAt IS NULL AND joinedAt < ?').bind(Number(q.joinedAt) || 0).first();
      return json({ state: 'queued', position: (Number(ahead && ahead.n) || 0) + 1 });
    }
    return json({ state: 'none' });
  }
  if (op === 'scan') {
    if (!auth) return json({ error: 'No swap token found in the Cloudflare settings.' }, 503);
    await scanTables(db);
    const now = Date.now();
    // A scan already under way (started here, or carried on by the server) just continues.
    let job = await loadJob(db, me);
    if (job) {
      try { await db.prepare('UPDATE scan_queue SET lastSeen=? WHERE key=?').bind(now, me).run(); } catch (e) {}
      return json(await scanWork(env, db, me, job, auth));
    }
    const u = await db.prepare('SELECT rsUser, hashId, scannedAt, passes FROM swap_users WHERE key=?').bind(me).first();
    const fast = acc.admin || BOOST_FAST.has(String(me || '').toLowerCase());
    if (!fast) {
      const every = await scanEvery(env);
      const lastAt = Number(u && u.scannedAt) || 0, left = lastAt + every * 60000 - now;
      if (left > 0 && u && u.passes) {
        const m = Math.ceil(left / 60000);
        return json({ done: true, hashId: u.hashId, passes: parse(u.passes, []), errors: [], cached: true, scannedAt: lastAt,
          note: `From your last scan. A fresh scan is allowed once every ${every >= 60 ? every / 60 + ' hours' : every + ' minutes'} - next in ${m >= 60 ? Math.floor(m / 60) + 'h ' + (m % 60) + 'm' : m + ' min'}.` });
      }
    } else if (!(await allow(url.origin, 'swapscan:' + me, 20, 600))) return json({ error: 'Twenty scans per ten minutes.' }, 429);
    // The line. Admins skip it.
    if (!acc.admin) {
      const q = await scanQueueTurn(db, me, now);
      if (!q.go) return json({ queued: true, position: q.position, wait: q.wait });
    }
    // Members scan their own Real account; an admin may name another (OTD).
    const over = acc.admin && url.searchParams.get('rsUser') ? String(url.searchParams.get('rsUser')).trim().replace(/^@/, '') : null;
    job = await newScanJob(env, db, me, over, u);
    if (job.error) { try { await db.prepare('DELETE FROM scan_queue WHERE key=?').bind(me).run(); } catch (e) {} return json({ error: job.error }, job.status || 400); }
    return json(await scanWork(env, db, me, job, auth));
  }

  // Admin: how often members may scan - 180 (every 3 hours) or 15 minutes.
  if (op === 'scanevery') {
    const v = Number(url.searchParams.get('set'));
    if (v === 15 || v === 180) { try { await env.RATEBOARD_KV.put(SCAN_EVERY_KEY, String(v)); } catch (e) {} }
    return json({ every: await scanEvery(env) });
  }

  /* ---- Boosts (BETA) ------------------------------------------------------
     Which of a member's passes play on a day, what each should earn, and
     which booster to put on it. Schedule from ESPN's public scoreboard (kept
     3 hours), averages from the board's game log, the pass multiplier from
     the member's last scan. */
  /* A member's boosters, from Real's collection stats page (the bottom of
     web.realapp.com/collection/<sport>/season/<season>/user/<id>/stats).
     Kept 30 minutes. While its shape is being learned the raw answer comes
     back too, trimmed. */
  /* Buys (CBB): the first 70 of the top 175 (renumbered 1-173), with whether the member holds a pass for each; anyone they
     don't hold is a recommended buy, with his link. */
  if (op === 'buys') {
    const u = await db.prepare('SELECT passes, scannedAt FROM swap_users WHERE key=?').bind(me).first();
    const own = new Set(parse(u && u.passes, []).filter(p => p.sport === 'ncaam' && Number(p.season) === 2027 && p.kind !== 'team').map(p => Number(p.id)));
    const list = Object.entries(CBB_TOP175).map(([id, v]) => ({ id: Number(id), rank: v[0], team: v[1], link: 'https://www.realapp.com/' + v[2] }))
      .sort((a, b) => a.rank - b.rank).slice(0, 70);
    const ids = list.map(x => x.id), names = new Map();
    try { const r = await db.prepare(`SELECT playerId, MAX(player) AS n FROM gamelog WHERE sport='ncaam' AND season IN (2027, 2026, 2025) AND playerId IN (${ids.map(() => '?').join(',')}) GROUP BY playerId`).bind(...ids).all();
      for (const x of (r.results || [])) names.set(Number(x.playerId), x.n); } catch (e) {}
    const passName = new Map(parse(u && u.passes, []).filter(p => p.sport === 'ncaam').map(p => [Number(p.id), p.name]));
    const passIdOf = new Map(parse(u && u.passes, []).filter(p => p.sport === 'ncaam' && Number(p.season) === 2027 && p.kind !== 'team' && p.passId).map(p => [Number(p.id), p.passId]));
    for (const x of list) { x.name = CBB_TOP175[x.id][3] || names.get(x.id) || passName.get(x.id) || null; x.owned = own.has(x.id); x.passId = passIdOf.get(x.id) || null; if (CBB_SHOTS.has(x.id)) x.img = `/img/cbb/${x.id}.png`; }
    return json({ scannedAt: (u && u.scannedAt) || null, scanned: !!(u && u.passes), list, missing: list.filter(x => !x.owned).length });
  }

  /* Legendary boosts (CFB): packs whose booster is nearly always legendary.
     Leg odds and the expected booster come from pack data (the same sums as
     the board's Pack data tab), pulled once and kept; an admin can refresh. */
  if (op === 'legboosts') {
    let stats = null;
    try { stats = JSON.parse((await env.RATEBOARD_KV.get(LEG_KEY)) || 'null'); } catch (e) {}
    if (!stats || (acc.admin && url.searchParams.get('refresh') === '1')) {
      const by = {};
      for (const se of [...new Set(LEG_WEEKLY.concat(LEG_DAILY).filter(x => x.id).map(x => x.season))]) {
        try {
          const r = await fetch(`${url.origin}/api/rax?plays=board&seasons=ncaaf:${se}&min=1`);
          const j = await r.json();
          for (const row of (j.rows || [])) by[`${se}:${row.playerId}`] = row;
        } catch (e) {}
      }
      const fresh = {};
      for (const x of LEG_WEEKLY.concat(LEG_DAILY)) {
        const r = x.id ? by[`${x.season}:${x.id}`] : null;
        if (r) fresh[`${x.season}:${x.id}`] = { plays: r.plays, legendary: r.legendary, odds: packOdds(r.plays, r.legendary), boost: avgBooster(r) };
      }
      if (Object.keys(fresh).length) { stats = { at: Date.now(), by: fresh }; try { await env.RATEBOARD_KV.put(LEG_KEY, JSON.stringify(stats)); } catch (e) {} }
    }
    const u = await db.prepare('SELECT passes, scannedAt FROM swap_users WHERE key=?').bind(me).first();
    const ps = parse(u && u.passes, []).filter(p => p.sport === 'ncaaf');
    // Team cards: the team's id from one of its players' plays (kept), so ownership goes by id, not by name.
    const teamIds = {};
    for (const x of LEG_DAILY.concat(LEG_WEEKLY).filter(x => x.teamVia)) {
      const k = `legteam_${x.season}_${x.teamVia}`;
      let tid = null; try { tid = Number(await env.RATEBOARD_KV.get(k)) || null; } catch (e) {}
      if (!tid) { try { const r = await db.prepare('SELECT teamId FROM plays WHERE sport=? AND season=? AND playerId=? AND teamId IS NOT NULL GROUP BY teamId ORDER BY COUNT(*) DESC LIMIT 1').bind('ncaaf', x.season, x.teamVia).first();
        tid = r && Number(r.teamId) || null; if (tid) await env.RATEBOARD_KV.put(k, String(tid)); } catch (e) {} }
      teamIds[x.name] = tid;
    }
    const ownPass = x => x.team ? ps.find(p => p.kind === 'team' && Number(p.season) === x.season && ((teamIds[x.name] && Number(p.id) === teamIds[x.name]) || new RegExp(x.team.replace(' ', '\\s*'), 'i').test(String(p.name || ''))))
      : ps.find(p => p.kind !== 'team' && Number(p.season) === x.season && Number(p.id) === x.id);
    const owns = x => !!ownPass(x);
    const out = list => list.map(x => { const st = x.id && stats && stats.by[`${x.season}:${x.id}`];
      const odds = st ? st.odds : x.odds ?? null, boost = st ? st.boost : x.boost ?? null;
      const mine = ownPass(x);
      // The name opens their own card when they hold it (like the CBB list), else the player on Real.
      const card = mine && mine.passId ? `https://www.realapp.com/${routeId([18, 0, 0, Number(mine.passId)])}` : null;
      // A team's page on Real: record type 3 (the type UFC fighters use), CFB code 11.
      const teamPage = x.team && teamIds[x.name] ? `https://www.realapp.com/${routeId([3, 11, 0, teamIds[x.name]])}/${x.season}` : null;
      return { name: x.name, season: x.season, team: !!x.team, link: card || teamPage || (x.id ? playerUrl(`ncaaf:${x.season}:${x.id}`) : null), card: !!card,
        playerLink: x.id ? playerUrl(`ncaaf:${x.season}:${x.id}`) : null, odds, boost, plays: st ? st.plays : null, owned: !!mine }; });
    /* Their own base rax: every CFB 2026 card they hold, total rax over total
       games this season. Kept until their next scan. */
    let myBase = null;
    const myIds = [...new Set(ps.filter(p => p.kind !== 'team' && Number(p.season) === 2026).map(p => Number(p.id)).filter(Number.isFinite))];
    if (myIds.length && u && u.scannedAt) {
      const bk = `legbase_v1_${me}`;
      try { const c = JSON.parse((await env.RATEBOARD_KV.get(bk)) || 'null'); if (c && c.scannedAt === u.scannedAt && Date.now() - c.at < 12 * 3600000) myBase = c.v; } catch (e) {}
      if (!myBase) {
        let rax = 0, games = 0;
        for (let i = 0; i < myIds.length; i += 90) { const part = myIds.slice(i, i + 90);
          try { const r = await db.prepare(`SELECT SUM(rax) AS r, COUNT(*) AS g FROM gamelog WHERE sport='ncaaf' AND season=2026 AND rax IS NOT NULL AND playerId IN (${part.map(() => '?').join(',')})`).bind(...part).first();
            rax += Number(r && r.r) || 0; games += Number(r && r.g) || 0; } catch (e) {} }
        myBase = games ? { rax, games, players: myIds.length, avg: Math.round(rax / games * 10) / 10 } : null;
        try { await env.RATEBOARD_KV.put(bk, JSON.stringify({ at: Date.now(), scannedAt: u.scannedAt, v: myBase }), { expirationTtl: 86400 }); } catch (e) {}
      }
    }
    const weekly = out(LEG_WEEKLY).sort((a, b) => (b.odds ?? -1) - (a.odds ?? -1));   // highest leg odds first
    return json({ daily: out(LEG_DAILY), weekly, myBase, at: stats && stats.at, scanned: !!(u && u.passes), scannedAt: (u && u.scannedAt) || null, admin: acc.admin });
  }

  /* Resell / replacements (CBB 2026-27). Their CBB cards, worst rax a game
     first, with anyone out for the season flagged; the best replacements
     (highest rax a game, 4+ games this season, else last season while this
     one is young); and, per booster, what swapping would make over the games
     left. Getting rid of a card costs whatever it has earned past 100 rax, and
     a new one costs 200. */
  /* CFB too (Dennis, 2026-11-04): a 12-game regular season, 5+ games to count,
     offensive players only as buys, and no sells at all for anyone holding
     fewer than 100 CFB 2026 passes - they're shown buys instead. */
  if (op === 'resell') {
    const SP = url.searchParams.get('sport') === 'ncaaf' ? 'ncaaf' : 'ncaam';
    // HIT: a good game's rax, for how often a player gets there (consistency).
    const CFG = SP === 'ncaaf' ? { SEASON: 2026, PREV: 2025, SEASON_GAMES: 12, MIN_G: 5, offense: true, sellMin: 100, HIT: 20 }
                               : { SEASON: 2027, PREV: 2026, SEASON_GAMES: 31, MIN_G: 4, offense: false, sellMin: 100, HIT: 10 };
    const { SEASON, PREV, SEASON_GAMES, MIN_G } = CFG, PACK = 200;
    const OFF = /^(QB|RB|HB|FB|WR|TE)$/i;
    try { await alterOnce(db, 'ALTER TABLE swap_users ADD COLUMN noSell TEXT'); } catch (e) {}
    const u = await db.prepare('SELECT passes, scannedAt, noSell FROM swap_users WHERE key=?').bind(me).first();
    if (!u || !u.passes) return json({ error: 'Read your passes on the Boosts tab first.' }, 400);
    const noSell = new Set((parse(u.noSell, []) || []).map(String));
    const mine = parse(u.passes, []).filter(p => p.sport === SP && Number(p.season) === SEASON && p.kind !== 'team');
    const sells = mine.length >= CFG.sellMin;
    // Every CBB player's rax a game this season and last (one grouped read each, kept 30 minutes).
    const rkey = 'resell_rpg_v4_' + SP;
    let R = null; try { R = JSON.parse((await env.RATEBOARD_KV.get(rkey)) || 'null'); } catch (e) {}
    if (!R || Date.now() - R.at > 30 * 60000) {
      const grab = async se => ((await db.prepare(`SELECT playerId AS id, MAX(player) AS n, MAX(team) AS t, MAX(position) AS pos, COUNT(*) AS g, SUM(rax) AS r, MAX(rax) AS mx,
          SUM(CASE WHEN rax >= ? THEN 1 ELSE 0 END) AS hit, ROUND(AVG(min), 1) AS m
        FROM gamelog WHERE sport=? AND season=? AND rax IS NOT NULL AND seasonType IN ('regularseason','postseason') GROUP BY playerId`).bind(CFG.HIT, SP, se).all()).results) || [];
      // Games each team has played this season (regular season, then postseason apart), from every game in the log.
      const tg = ((await db.prepare(`SELECT team AS t, SUM(CASE WHEN seasonType='regularseason' THEN 1 ELSE 0 END) AS reg, SUM(CASE WHEN seasonType='postseason' THEN 1 ELSE 0 END) AS post
          FROM (SELECT DISTINCT team, gameId, seasonType FROM gamelog WHERE sport=? AND season=? AND team IS NOT NULL) GROUP BY team`).bind(SP, SEASON).all()).results) || [];
      R = { at: Date.now(), cur: await grab(SEASON), prev: await grab(PREV), teams: tg };
      try { await env.RATEBOARD_KV.put(rkey, JSON.stringify(R), { expirationTtl: 3600 }); } catch (e) {}
    }
    const cur = new Map(R.cur.map(x => [Number(x.id), x])), prev = new Map(R.prev.map(x => [Number(x.id), x]));
    // Out for the season: ESPN's injury list, any date, read for "season" / "indefinitely".
    let out = {};
    try { const c = JSON.parse((await env.RATEBOARD_KV.get('resell_out_v1_' + SP)) || 'null'); if (c && Date.now() - c.at < 6 * 3600000) out = c.m; else throw 0; }
    catch (e) {
      try { const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${ESPN_PATH[SP]}/injuries`); const d = r.ok ? await r.json() : {};
        for (const t of (d.injuries || [])) for (const x of (t.injuries || [])) {
          const txt = `${x.status || ''} ${x.shortComment || ''} ${x.longComment || ''}`;
          if (x.athlete && /season|indefinite/i.test(txt) && !/^active$/i.test(x.status || '')) out[boostName(x.athlete.displayName)] = String(x.shortComment || x.status || '').slice(0, 140);
        } } catch (e2) {}
      try { await env.RATEBOARD_KV.put('resell_out_v1_' + SP, JSON.stringify({ at: Date.now(), m: out }), { expirationTtl: 86400 }); } catch (e) {}
    }
    const MULTS = [['none', 1], ['rare', 10], ['epic', 15], ['legendary', 25]];
    const rate = id => { const c = cur.get(id), o = prev.get(id);
      if (c && c.g >= MIN_G) return { rpg: c.r / c.g, games: c.g, basis: 'this season' };
      if (c && c.g && o && o.g >= 10) return { rpg: (c.r + (o.r / o.g) * MIN_G) / (c.g + MIN_G), games: c.g, basis: `${c.g} game${c.g === 1 ? '' : 's'} this season + last season` };
      if (c && c.g) return { rpg: c.r / c.g, games: c.g, basis: `${c.g} game${c.g === 1 ? '' : 's'} this season` };
      if (o && o.g >= 10) return { rpg: o.r / o.g, games: 0, basis: 'last season' };
      return null; };
    const played = id => (cur.get(id) || {}).g || 0;
    /* Games left go by his team, not by how many he played (a game he sat out
       still counts as gone): the regular season left, and once a team is in
       the postseason (bowl, CFP, March) those games are counted as they're played. */
    const teamG = new Map((R.teams || []).map(x => [x.t, x]));
    const teamOf = id => (cur.get(id) || {}).t || null;
    const left = id => { const t = teamG.get(teamOf(id)); return t ? (Number(t.post) > 0 ? 0 : Math.max(0, SEASON_GAMES - Number(t.reg))) : Math.max(0, SEASON_GAMES - played(id)); };
    const teamPlayed = id => { const t = teamG.get(teamOf(id)); return t ? Number(t.reg) + Number(t.post) : null; };
    const owned = new Set(mine.map(p => Number(p.id)));
    const cards = mine.map(p => { const id = Number(p.id), r = rate(id), nm = p.name || (SP === 'ncaam' && CBB_TOP175[id] && CBB_TOP175[id][3]) || (cur.get(id) || prev.get(id) || {}).n || 'Player ' + id;
      const earned = Number(p.earned) || 0, isOut = out[boostName(nm)] || null;
      return { id, name: nm, team: (cur.get(id) || prev.get(id) || {}).t || (SP === 'ncaam' && CBB_TOP175[id] && CBB_TOP175[id][1]) || null, link: playerUrl(`${SP}:${SEASON}:${id}`),
        card: p.passId ? `https://www.realapp.com/${routeId([18, 0, 0, Number(p.passId)])}` : null,
        rpg: r ? Math.round(r.rpg * 10) / 10 : null, basis: r ? r.basis : 'no games yet', played: played(id),
        left: isOut ? 0 : left(id), teamPlayed: teamPlayed(id), earned, sellCost: Math.max(0, earned - 100), out: isOut, noSell: noSell.has(String(id)) }; })
      .sort((a, b) => (b.out ? 1 : 0) - (a.out ? 1 : 0) || (a.rpg ?? -1) - (b.rpg ?? -1));
    /* Consistency: his average with his best game left out (one huge game can't
       carry it), and how often he clears a good game (CFB 20+, CBB 10+). Buys
       rank on steady rax a game x (0.6 + 0.4 x that hit rate); profits use the
       steady figure. */
    const steadyOf = x => x.g >= 4 ? (x.r - x.mx) / (x.g - 1) : x.r / x.g;
    const scoreOf = x => steadyOf(x) * (0.6 + 0.4 * (x.g ? x.hit / x.g : 0));
    // Replacements: not already held, highest rax a game, 4+ games this season (or last season's figure early on).
    const pool = [];
    for (const id of new Set([...cur.keys(), ...prev.keys()])) {
      if (owned.has(id)) continue;
      const c = cur.get(id), o = prev.get(id);
      const nm = (c || o).n;
      if (out[boostName(nm)]) continue;
      if (CFG.offense && !OFF.test(String((c || o).pos || ''))) continue;      // CFB buys: offence only
      const base = (x, basis, games) => ({ id, name: nm, team: (c || o).t, avg: x.r / x.g, rpg: steadyOf(x), hitRate: x.g ? x.hit / x.g : 0, best: x.mx, score: scoreOf(x), games, basis });
      if (c && c.g >= MIN_G) pool.push(base(c, 'this season', c.g));
      else if (o && o.g >= 10 && c && c.g) pool.push(base(o, `last season (fewer than ${MIN_G} games yet)`, c.g));
    }
    const thisSeasonEnough = pool.some(x => x.basis === 'this season');
    const reps = pool.filter(x => !thisSeasonEnough || x.basis === 'this season').sort((a, b) => b.score - a.score).slice(0, 15)
      .map(x => ({ ...x, pos: (cur.get(x.id) || prev.get(x.id) || {}).pos || null, rpg: Math.round(x.rpg * 10) / 10, avg: Math.round(x.avg * 10) / 10,
        hitPct: Math.round(x.hitRate * 100), score: Math.round(x.score * 10) / 10, left: left(x.id), teamPlayed: teamPlayed(x.id), link: playerUrl(`${SP}:${SEASON}:${x.id}`),
        // A straight buy: his rax over his games left x the booster, less the 200 pack.
        buy: MULTS.map(([k, m]) => ({ booster: k, mult: m, profit: Math.round(left(x.id) * x.rpg * m - PACK) })) }));
    // For each of their worst 10: the best replacement, and swap vs keep per booster over the games left.
    // Worst card gets the best replacement, the next worst the next one, so no one is suggested twice.
    const plans = (sells ? cards.filter(c => !c.noSell) : []).slice(0, 10).map((c, i) => {
      const best = reps[i] || null;
      const per = MULTS.map(([k, m]) => {
        const keep = c.rpg != null ? Math.round(c.left * c.rpg * m) : 0;
        const swap = best ? Math.round(best.left * best.rpg * m - PACK - c.sellCost) : null;
        return { booster: k, mult: m, keep, swap, gain: swap == null ? null : swap - keep };
      });
      const leg = per.find(x => x.booster === 'legendary');
      return { ...c, replaceWith: best, per, verdict: !best ? 'no replacement yet' : leg.gain > 0 ? 'replace' : 'keep - let him sit, don\'t boost' };
    });
    return json({ sport: SP, scannedAt: u.scannedAt || null, cards, plans, replacements: reps, seasonGames: SEASON_GAMES, minGames: MIN_G, pack: PACK, earlySeason: !thisSeasonEnough,
      sells, held: mine.length, sellMin: CFG.sellMin, offenseOnly: CFG.offense, hitBar: CFG.HIT, kept: cards.filter(c => c.noSell) });
  }
  // "Don't sell" on a card: it's left out of the resell suggestions until switched back.
  if (op === 'nosell' && request.method === 'POST') {
    let b = {}; try { b = await request.json(); } catch (e) {}
    try { await alterOnce(db, 'ALTER TABLE swap_users ADD COLUMN noSell TEXT'); } catch (e) {}
    const r = await db.prepare('SELECT noSell FROM swap_users WHERE key=?').bind(me).first();
    const set = new Set((parse(r && r.noSell, []) || []).map(String)), id = String(Number(b.id) || '');
    if (!id) return json({ error: 'bad player' }, 400);
    if (b.on) set.add(id); else set.delete(id);
    await db.prepare('UPDATE swap_users SET noSell=? WHERE key=?').bind(JSON.stringify([...set].slice(0, 500)), me).run();
    return json({ ok: true, noSell: [...set] });
  }

  if (op === 'boostinv') {
    const sp = BOOST_SEASON[url.searchParams.get('sport')] || url.searchParams.get('sport') === 'golf' ? url.searchParams.get('sport') : 'nfl';
    const u = await db.prepare('SELECT hashId FROM swap_users WHERE key=?').bind(me).first();
    if (!u || !u.hashId) return json({ error: 'Re-read your passes first so the board knows your Real account.' }, 400);
    const want = url.searchParams.get('fresh') === '1';
    const fast = acc.admin || BOOST_FAST.has(String(me || '').toLowerCase());
    if (want && !fast && !(await allow(url.origin, 'boostinv-all', 15, 60))) return json({ error: HIGH_VOL }, 429);
    const all = await boostInventoryAll(env, env.RS_AUTH_TOKEN || auth, u.hashId, want, fast);
    if (all.error) return json({ error: all.error }, 502);
    return json({ sport: sp, at: all.at, next: all.next, cached: !!all.cached, boosters: (all.sports || {})[sp] || [], sports: all.sports });
  }

  /* The next 4 days (up to 12 ahead) on which at least one of the member's
     passes plays, for the day picker. Teams the same way the plan finds them:
     this season's last game, the CBB list, last season's team. */
  /* Projections page: the saved list (rebuilt in the background when it's
     over 6 hours old), plus which of the players the member holds a pass for. */
  /* Admin, one-off (2026-11-05): Real's raw pass records for the admin's own
     account, one sport-season, to see which fields Real sends (looking for an
     "untouchable" flag). Read-only; nothing saved. */
  /* Admin, for tracing a member's DMs: their swaps from the last day, every
     column (times as ISO), partner names and the players as names. */
  /* Admin: priority swappers - read, add, remove (by board or Real username). */
  /* Admin, Users & access: who has swaps taken away, who's restricted by a
     report (no posts, no swaps), and turning either off or on. */
  if (op === 'blocks') {
    if (!acc.admin) return forbidden('Admin only.');
    await db.prepare(SBLOCK_DDL).run(); await db.prepare(RESTRICT_DDL).run();
    const key = String(url.searchParams.get('key') || '');
    if (key && request.method === 'POST') {
      const what = url.searchParams.get('what'), on = url.searchParams.get('on') === '1';
      if (what === 'swaps') {
        if (on) {
          await db.prepare('INSERT OR REPLACE INTO swap_block (key, at) VALUES (?, ?)').bind(key, Date.now()).run();
          await db.prepare('UPDATE swap_users SET active=0 WHERE key=?').bind(key).run();
          // Their swaps still to come are called off (warned ones go ahead, as with any late change).
          const ms = ((await db.prepare("SELECT * FROM swap_matches WHERE status IN ('pending','warned') AND (a=? OR b=?)").bind(key, key).all()).results) || [];
          const res = { n: 0, late: 0, soon: 0 };
          for (const m of ms) await callOff(db, m, `called off: @${key} can no longer swap`, res);
          ACCESS_MEMO.delete(key);
        } else await db.prepare('DELETE FROM swap_block WHERE key=?').bind(key).run();
      } else if (what === 'restricted' && !on) await db.prepare('DELETE FROM restricted WHERE key=?').bind(key).run();
      ACCESS_MEMO.delete(key);
    }
    const sb = ((await db.prepare('SELECT key FROM swap_block').all()).results || []).map(r => r.key);
    const rs = ((await db.prepare('SELECT key FROM restricted').all()).results || []).map(r => r.key);
    return json({ swapBlocked: sb, restricted: rs });
  }
  if (op === 'priority') {
    if (!acc.admin) return forbidden('Admin only.');
    let list = []; try { list = JSON.parse((await env.RATEBOARD_KV.get(PRIO_KEY)) || '[]') || []; } catch (e) {}
    const add = String(url.searchParams.get('add') || '').trim().replace(/^@/, '').toLowerCase(), del = String(url.searchParams.get('remove') || '').trim().toLowerCase();
    if (add && request.method === 'POST') {
      const u = await db.prepare('SELECT key, rsUser FROM swap_users WHERE LOWER(key)=? OR LOWER(rsUser)=?').bind(add, add).first();
      if (!u) return json({ error: `No swapper called @${add}.`, list }, 404);
      if (!list.map(x => x.toLowerCase()).includes(u.key.toLowerCase())) list.push(u.key);
    }
    if (del && request.method === 'POST') list = list.filter(x => x.toLowerCase() !== del);
    if (request.method === 'POST') await env.RATEBOARD_KV.put(PRIO_KEY, JSON.stringify(list));
    const names = {}; for (const k of list) { try { const r = await db.prepare('SELECT rsUser FROM swap_users WHERE key=?').bind(k).first(); names[k] = (r && r.rsUser) || k; } catch (e) {} }
    return json({ list: list.map(k => ({ key: k, real: names[k] })) });
  }
  /* Admin: who didn't get a swap DM in the last day (Real refused it, or it
     gave up retrying), newest first, one line per member. */
  if (op === 'undelivered') {
    if (!acc.admin) return forbidden('Admin only.');
    const rows = ((await db.prepare("SELECT at, kind, msg FROM bot_log WHERE kind LIKE 'dm_%' AND at > ? ORDER BY at DESC LIMIT 3000").bind(Date.now() - 86400000).all()).results) || [];
    const by = new Map();
    for (const r of rows) {
      const m = String(r.msg || '').match(/@([A-Za-z0-9._-]+)/) || String(r.msg || '').match(/^([A-Za-z0-9._-]{2,40}):/);
      if (!m) continue;
      const u = m[1].toLowerCase(), why = /403/.test(r.msg) ? 'Real won\'t let the bot message them ("Cannot message this channel")' : /too long/i.test(r.msg) ? 'message too long' : /429|slowmode/i.test(r.msg) ? 'Real slowmode' : /gave up/i.test(r.msg) ? 'gave up after an hour of retries' : /never verified/i.test(r.msg) ? 'never verified (step 1)' : String(r.msg).slice(0, 80);
      const kind = String(r.kind).replace(/^dm_/, '');
      const x = by.get(u) || by.set(u, { user: u, last: r.at, kinds: new Set(), whys: new Set(), n: 0 }).get(u);
      x.n++; x.kinds.add(kind); x.whys.add(why);
    }
    return json({ users: [...by.values()].map(x => ({ user: x.user, last: new Date(x.last).toISOString(), tries: x.n, what: [...x.kinds], why: [...x.whys] })) });
  }
  if (op === 'matchraw') {
    if (!acc.admin) return forbidden('Admin only.');
    const who0 = String(url.searchParams.get('user') || '').trim().replace(/^@/, '').toLowerCase();
    const u = await db.prepare('SELECT key FROM swap_users WHERE LOWER(key)=? OR LOWER(rsUser)=?').bind(who0, who0).first();
    if (!u) return json({ error: 'No swapper by that name.' }, 404);
    await matchCols(db);
    const ms = ((await db.prepare('SELECT * FROM swap_matches WHERE (a=? OR b=?) AND COALESCE(dueAt, createdAt) > ? ORDER BY COALESCE(dueAt, createdAt), id').bind(u.key, u.key, Date.now() - 30 * 3600000).all()).results) || [];
    const mem = new Map(), get = async k => mem.has(k) ? mem.get(k) : (mem.set(k, await loadMember(db, k)), mem.get(k));
    const iso = v => v ? new Date(Number(v)).toISOString().slice(5, 19).replace('T', ' ') : null;
    const me0 = await get(u.key), out = [];
    for (const m of ms) { const side = m.a === u.key ? 'A' : 'B', o = await get(side === 'A' ? m.b : m.a);
      out.push({ id: m.id, due: iso(sideDue(m)), made: iso(m.createdAt), status: m.status, note: m.note, partner: o && o.rsUser,
        receives: me0 ? playerName(me0, side === 'A' ? m.aGets : m.bGets) : null, gives: me0 ? playerName(me0, side === 'A' ? m.bGets : m.aGets) : null,
        myWarn: iso(m['warn' + side]), myContact: iso(m['done' + side]), theirWarn: iso(m['warn' + (side === 'A' ? 'B' : 'A')]), theirContact: iso(m['done' + (side === 'A' ? 'B' : 'A')]) }); }
    let q = []; try { q = ((await db.prepare('SELECT label, tries, at, parts FROM dm_retry').all()).results || []).filter(r => String(r.label).toLowerCase().includes('@' + who0)).map(r => ({ label: r.label, tries: r.tries, at: iso(r.at), parts: parse(r.parts, []).length })); } catch (e) {}
    let log = []; try { log = ((await db.prepare("SELECT at, kind, msg FROM bot_log WHERE at > ? AND LOWER(msg) LIKE ? ORDER BY at DESC LIMIT 40").bind(Date.now() - 30 * 3600000, '%' + who0 + '%').all()).results || []).map(r => ({ at: iso(r.at), kind: r.kind, msg: String(r.msg).slice(0, 200) })); } catch (e) {}
    return json({ user: u.key, swaps: out, retryQueue: q, botLog: log });
  }
  if (op === 'passraw') {
    if (!acc.admin) return forbidden('Admin only.');
    const sp = String(url.searchParams.get('sport') || 'nba').replace(/[^a-z]/g, ''), se = Number(url.searchParams.get('season')) || 2027;
    const u = await db.prepare('SELECT hashId, rsUser FROM swap_users WHERE key=?').bind(me).first();
    if (!u || !u.hashId) return json({ error: 'Scan your passes once first so the board knows your Real account.' }, 400);
    const base = `https://web.realapp.com/userpasses/${encodeURIComponent(u.hashId)}/passes?entityType=player&season=${se}&sport=${sp}`;
    let d;
    try { d = await rsGetJson(base, scanTok(env)); } catch (e) { return json({ error: 'Real: ' + String(e.message || e).slice(0, 200) }, 502); }
    const rows = rowsOf(d);
    // Every field name used across the passes (nested ones as a.b), and which ones differ between passes.
    const seen = new Map();
    const walk = (o, pre, i) => { for (const [k, v] of Object.entries(o || {})) { const path = pre ? pre + '.' + k : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, path, i);
      else { const m = seen.get(path) || seen.set(path, new Set()).get(path); if (m.size < 6) m.add(JSON.stringify(v).slice(0, 60)); } } };
    rows.forEach((r, i) => walk(r, '', i));
    return json({ sport: sp, season: se, account: u.rsUser, passes: rows.length, topKeys: Object.keys(d || {}),
      fields: Object.fromEntries([...seen].map(([k, v]) => [k, [...v]])), first3: rows.slice(0, 3) });
  }
  if (op === 'projections') {
    // Dennis only for now (2026-11-05).
    if (!acc.admin) return json({ error: 'This page is not open yet.' }, 403);
    const sp = PROJ_SEASON[url.searchParams.get('sport')] ? url.searchParams.get('sport') : 'ncaaf';
    let c = null; try { c = JSON.parse((await env.RATEBOARD_KV.get(`proj_v3_${sp}`)) || 'null'); } catch (e) {}
    // One player's breakdown (tapping his line).
    const pid = Number(url.searchParams.get('pid'));
    if (pid) { const row = c && (c.rows || []).find(r => r.i === pid); return json({ row: row || null, ...(await projDetail(env, sp, row, c)) }); }
    const lockK = `proj_lock_v1_${sp}`;
    const stale = !c || Date.now() - c.at > 6 * 3600000 || (acc.admin && url.searchParams.get('refresh') === '1');
    if (stale) {
      let locked = false; try { locked = !!(await env.RATEBOARD_KV.get(lockK)); } catch (e) {}
      if (!locked) {
        try { await env.RATEBOARD_KV.put(lockK, '1', { expirationTtl: 120 }); } catch (e) {}
        const job = projBuild(env, db, sp).finally(() => env.RATEBOARD_KV.delete(lockK).catch(() => {}));
        if (!c) c = await job.catch(e => ({ error: 'Could not build the projections: ' + String(e.message || e).slice(0, 100) }));
        else { try { waitUntil(job.catch(() => {})); } catch (e) {} }
      }
    }
    if (!c) return json({ building: true, note: 'Building the projections - try again in a minute.' });
    if (c.error) return json({ error: c.error }, 500);
    const u = await db.prepare('SELECT passes FROM swap_users WHERE key=?').bind(me).first();
    const [se] = PROJ_SEASON[sp];
    // Their passes for this season, with the card's id so a name can open their own card.
    const mine = parse(u && u.passes, []).filter(p => p.sport === sp && Number(p.season) === se && p.kind !== 'team').map(p => [Number(p.id), p.passId ? Number(p.passId) : null]);
    return json({ ...c, of: undefined, hf: undefined, rows: (c.rows || []).map(({ x, ...r }) => r), mine });
  }
  if (op === 'boostdays') {
    const sp = String(url.searchParams.get('sport') || '');
    if (sp === 'golf') {
      // Golf: the next tournaments, and how many of the member's golfers are in each field.
      const u = await db.prepare('SELECT passes FROM swap_users WHERE key=?').bind(me).first();
      const names = new Set(parse(u && u.passes, []).filter(p => p.sport === 'golf' && Number(p.season) === GOLF_SEASON[0] && p.kind !== 'team').map(p => boostName(p.name)));
      const evs = await golfEvents(env);
      return json({ passes: names.size, days: evs.map(e => ({ day: e.day, event: e.name, fieldOut: e.field.length > 0,
        players: e.field.length ? e.field.filter(n => names.has(boostName(n))).length : names.size })) });
    }
    if (!BOOST_SEASON[sp]) return json({ error: 'Pick CBB, CFB or NFL.' }, 400);
    const [se, prev] = BOOST_SEASON[sp];
    const u = await db.prepare('SELECT passes FROM swap_users WHERE key=?').bind(me).first();
    const ps = parse(u && u.passes, []).filter(p => p.sport === sp && Number(p.season) === se && p.kind !== 'team');
    const ids = [...new Set(ps.map(p => Number(p.id)).filter(Number.isFinite))];
    const cur = new Map(), old = new Map();
    for (let i = 0; i < ids.length; i += 90) {
      const part = ids.slice(i, i + 90);
      try { const r = await db.prepare(`SELECT playerId, season, team, MAX(day) AS d FROM gamelog WHERE sport=? AND season IN (?, ?) AND playerId IN (${part.map(() => '?').join(',')}) AND team IS NOT NULL GROUP BY playerId, season`)
          .bind(sp, se, prev, ...part).all();
        for (const x of (r.results || [])) (Number(x.season) === se ? cur : old).set(Number(x.playerId), x.team); } catch (e) {}
    }
    // One team per player: this season's, else the CBB list's, else last season's.
    const teamOf = ids.map(id => { const t = cur.get(id) || (sp === 'ncaam' && CBB_TOP175[id] ? CBB_TOP175[id][1] : null) || old.get(id); return t ? boostAlias(sp, t) : null; }).filter(Boolean);
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
    const cand = [...Array(12).keys()].map(i => fmt.format(new Date(Date.now() + i * 86400000)));
    const scheds = await Promise.all(cand.map(d => boostSchedule(env, sp, d).catch(() => ({ error: 1 }))));
    const days = [];
    cand.forEach((d, i) => { const sc = scheds[i]; if (!sc || sc.error || days.length >= 4) return;
      const n = teamOf.filter(t => sc.teams && sc.teams[t]).length; if (n) days.push({ day: d, players: n }); });
    return json({ days, passes: ids.length });
  }
  if (op === 'boostplan') {
    const sp = String(url.searchParams.get('sport') || '');
    if (!BOOST_SEASON[sp] && sp !== 'golf') return json({ error: 'Pick CBB, CFB, NFL or Golf.' }, 400);
    const day = String(url.searchParams.get('date') || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return json({ error: 'Pick a date.' }, 400);
    let mode = BOOST_MODES[url.searchParams.get('mode')] ? url.searchParams.get('mode') : 'balanced';
    // Heavy Legendary and Boost saver are only for Dennis and quas23 for now; Custom is for everyone.
    if (mode !== 'balanced' && mode !== 'custom' && !acc.admin && !BOOST_FAST.has(String(me || '').toLowerCase())) mode = 'balanced';
    /* Custom (2026-11-04): the member's own projected-rax bar for each rarity
       and the most of each they'll use on the day. Empty = that rarity off
       (bar) or no limit (max). */
    const cnum = (k, lo, hi) => { const v = url.searchParams.get(k); if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null; };
    const CUS = mode === 'custom' ? { leg: cnum('cl', 0, 500), epic: cnum('ce', 0, 500), rare: cnum('cr', 0, 500),
      max: { 5: cnum('ml', 0, 999), 4: cnum('me', 0, 999), 3: cnum('mr', 0, 999) } } : null;
    const [se, prev] = sp === 'golf' ? GOLF_SEASON : BOOST_SEASON[sp];
    // What they own: the passes from their last scan (the same read Swaps
    // uses). Rarity and pass level are not counted.
    const u = await db.prepare('SELECT passes, scannedAt, rsUser FROM swap_users WHERE key=?').bind(me).first();
    if (!u || !u.passes) return json({ error: 'Scan your passes first.' }, 400);
    const cards = { at: u.scannedAt || null, players: parse(u.passes, [])
      .filter(p => p.sport === sp && Number(p.season) === se && p.kind !== 'team')
      .map(p => ({ id: Number(p.id), name: p.name || '', passId: p.passId || null })) };
    let sched = null, depth = null, inv = null, rows = [], idle = [];
    if (sp === 'golf') {
      // Golf: the tournament is the game; form plus course history (see golfRows).
      const gr = await golfRows(env, db, cards, day);
      if (gr.error) return json({ error: gr.error }, 404);
      ({ sched, rows, idle } = gr);
      // Their golf boosters, read with the other sports' (caps the plan at what they hold).
      try { const uu = await db.prepare('SELECT hashId FROM swap_users WHERE key=?').bind(me).first();
        if (uu && uu.hashId) { const r = await boostInventory(env, env.RS_AUTH_TOKEN || auth, uu.hashId, 'golf', false); if (!r.error && r.list && r.list.length) inv = r.list; } } catch (e) {}
    } else {
      sched = await boostSchedule(env, sp, day);
      if (sched.error) return json({ error: sched.error }, 502);
      const inj = await boostInjuries(env, sp);
      // Game-by-game for this season and averages for last, from the game log.
      const ids = [...new Set(cards.players.map(p => Number(p.id)).filter(Number.isFinite))];
      const games = new Map(), old = new Map();
      for (let i = 0; i < ids.length; i += 90) {
        const part = ids.slice(i, i + 90), ph = part.map(() => '?').join(',');
        try {
          const r = await db.prepare(`SELECT playerId, day, rax, min, team, position, player, pts, reb, ast, stl, blk, fg3${sp === 'ncaam' ? '' : ', stats'} FROM gamelog
            WHERE sport=? AND season=? AND rax IS NOT NULL AND playerId IN (${ph}) ORDER BY day`).bind(sp, se, ...part).all();
          for (const x of (r.results || [])) (games.get(Number(x.playerId)) || games.set(Number(x.playerId), []).get(Number(x.playerId))).push(x);
        } catch (e) {}
        try {
          const r = await db.prepare(`SELECT playerId, team, position, day, rax, min, player, pts, reb, ast, stl, blk, fg3${sp === 'ncaam' ? '' : ', stats'} FROM gamelog
            WHERE sport=? AND season=? AND rax IS NOT NULL AND seasonType='regularseason' AND playerId IN (${ph}) ORDER BY day`).bind(sp, prev, ...part).all();
          for (const x of (r.results || [])) { const k = Number(x.playerId); const o = old.get(k) || { rows: [] }; o.rows.push(x); old.set(k, o); }
        } catch (e) {}
      }
      // NFL starters from ESPN's depth charts, for the teams playing that day.
      for (const [k, o] of old) {
        const rs = o.rows, l = rs[rs.length - 1];
        Object.assign(o, { team: l.team, position: l.position, last: l.day, g: rs.length, player: l.player,
          avg: rs.reduce((t, x) => t + Number(x.rax || 0), 0) / rs.length,
          min: rs.some(x => x.min != null) ? rs.reduce((t, x) => t + Number(x.min || 0), 0) / rs.length : null });
      }
      depth = sp === 'nfl' ? await boostDepth(env, sched) : null;
      // The member's boosters, if Real will give them.
      try { const uu = await db.prepare('SELECT hashId FROM swap_users WHERE key=?').bind(me).first();
        if (uu && uu.hashId) { const r = await boostInventory(env, env.RS_AUTH_TOKEN || auth, uu.hashId, sp, false); if (!r.error) inv = r.list; } } catch (e) {}
      // Current teams from ESPN's rosters (CBB: transfers and freshmen), and
      // how much each opponent gave up last season and this one.
      let roster = {}, match = {};
      if (sp === 'ncaam') { try { roster = (JSON.parse((await env.RATEBOARD_KV.get('boostrostermap_v1_ncaam')) || 'null') || {}).m || {}; } catch (e) {} }
      try { match = (JSON.parse((await env.RATEBOARD_KV.get('boostmatch_v1_' + sp)) || 'null') || {}).f || {}; } catch (e) {}
      // Freshmen and anyone new: Real's owner counts stand in for hype.
      const ownersBy = new Map();
      const noGames = ids.filter(id => !games.has(id) && !old.has(id));
      for (let i = 0; i < noGames.length; i += 90) {
        const part = noGames.slice(i, i + 90);
        try { const r = await db.prepare(`SELECT playerId, MAX(owners) AS o FROM owners WHERE sport=? AND season=? AND playerId IN (${part.map(() => '?').join(',')}) GROUP BY playerId`).bind(sp, se, ...part).all();
          for (const x of (r.results || [])) ownersBy.set(Number(x.playerId), Number(x.o) || 0); } catch (e) {}
      }
      const avg = a => a.length ? a.reduce((t, x) => t + Number(x.rax || 0), 0) / a.length : null;
      const dayMs = Date.parse(day + 'T12:00:00Z');
      rows = []; idle = [];
      for (const p of cards.players) {
        const gs = games.get(Number(p.id)) || [], o = old.get(Number(p.id));
        const lastG = gs[gs.length - 1];
        const name = p.name || (sp === 'ncaam' && CBB_TOP175[p.id] && CBB_TOP175[p.id][3]) || (lastG && lastG.player) || (o && o.player) || 'Player ' + p.id;
        const ros = sp === 'ncaam' ? roster[boostName(name)] : null;
        // A game this season wins; then ESPN's current roster; then last season's team.
        // The CBB list carries each player's current team too (transfers, freshmen).
        const listTeam = sp === 'ncaam' && CBB_TOP175[p.id] ? CBB_TOP175[p.id][1] : null;
        const teamAb = lastG && lastG.team ? boostAlias(sp, lastG.team) : listTeam ? boostAlias(sp, listTeam)
          : ros ? ros.ab : o && o.team ? boostAlias(sp, o.team) : null;
        const team = (lastG && lastG.team) || listTeam || (ros && ros.ab) || (o && o.team) || null;
        const g = teamAb ? sched.teams[teamAb] : null;
        if (!g) { idle.push(name); continue; }
        const pos = (lastG && lastG.position) || (o && o.position) || (ros && ros.pos) || '';
        const mf = g.oppAb && match[g.oppAb] ? match[g.oppAb] : 1;
        const ca = avg(gs), r4 = avg(gs.slice(-4)), oa = o ? Number(o.avg) : null, cg = gs.length;
        let proj = null, basis = '';
        if (cg >= 4) { proj = oa != null ? 0.5 * r4 + 0.3 * ca + 0.2 * oa : 0.6 * r4 + 0.4 * ca; basis = `last 4 games weighted, ${cg} this season`; }
        else if (cg && oa != null) { proj = 0.5 * ca + 0.5 * oa; basis = `${cg} game${cg === 1 ? '' : 's'} this season + last season`; }
        else if (cg) { proj = ca; basis = `${cg} game${cg === 1 ? '' : 's'} this season`; }
        else if (oa != null) { proj = oa; basis = 'last season (regular season)'; }
        // No college games at all: a freshman (or new arrival) estimate from how
        // many people own him on Real.
        let fresh = false, noData = false;
        if (proj == null) {
          const rk = sp === 'ncaam' && CBB_TOP175[p.id] ? CBB_TOP175[p.id][0] : null;
          if (rk) {
            // Rank 1 is about 12.5 rax a game, falling to about 6.5 at 175 (freshmen run a little under returners).
            proj = Math.round(Math.max(6.5, 12.5 - 0.035 * (rk - 1)) * 10) / 10; fresh = true;
            basis = `freshman · #${rk} on the top 175`;
          } else { noData = true; basis = 'not enough data'; }
        }
        if (proj != null && mf !== 1) basis += ` · matchup x${mf}`;
        const flags = [];
        let skip = false, k = 1;
        // Injury report.
        const ij = inj[boostName(name)];
        if (ij) {
          if (/^(out|injured reserve|doubtful|suspension)/i.test(ij.status)) { skip = true; flags.push(`${ij.status}${ij.note ? ': ' + ij.note : ''}`); }
          else if (/questionable/i.test(ij.status)) { k *= 0.75; flags.push(`Questionable${ij.note ? ': ' + ij.note : ''}`); }
        }
        // Starter or not.
        if (depth) {
          const d = depth[boostName(name)];
          if (d && !d.starter) { skip = true; flags.push(`Backup (${d.pos.toUpperCase()}${d.slot})`); }
        }
        // Hasn't been playing: no game in the last 15 days of a season under way (football).
        if (sp !== 'ncaam' && cg && lastG && dayMs - Date.parse(lastG.day + 'T12:00:00Z') > 15 * 86400000) { skip = true; flags.push(`No game since ${lastG.day}`); }
        if (sp !== 'ncaam' && !cg && o) { k *= 0.6; flags.push('No games this season yet'); }
        // Basketball minutes: recent ones if there are any, else last season's.
        if (sp === 'ncaam') {
          const m3 = gs.slice(-3).map(x => Number(x.min)).filter(Number.isFinite);
          const mAvg = m3.length ? m3.reduce((a, b) => a + b, 0) / m3.length : (o && o.min != null ? Number(o.min) : null);
          if (m3.length >= 2 && mAvg < 12) { skip = true; flags.push(`${Math.round(mAvg)} min a game lately`); }
          else if (!m3.length && mAvg != null && mAvg < 15) { k *= 0.7; flags.push(`${Math.round(mAvg)} min a game last season`); }
        }
        // Expected count of each boostable stat: recent games most, then this season, then last.
        const exp = {};
        const want = inv ? [...new Set(inv.flatMap(b => (b.attrs || []).map(a => a.stat)))] : Object.keys(STAT_BARS);
        for (const st of want) {
          const m = a => { const v = a.map(x => statOf(x, st)).filter(x => x != null); return v.length ? v.reduce((t, x) => t + x, 0) / v.length : null; };
          const c4 = m(gs.slice(-4)), cA = m(gs), oA = o ? m(o.rows) : null;
          let e = null;
          if (cg >= 4) e = oA != null ? 0.5 * c4 + 0.3 * cA + 0.2 * oA : 0.6 * c4 + 0.4 * cA;
          else if (cA != null && oA != null) e = 0.5 * cA + 0.5 * oA;
          else e = cA ?? oA;
          if (e == null && fresh && sp === 'ncaam' && FRESH_LINE[st] != null) {
            // A starter's line scaled to his estimate, guards toward assists and threes, bigs toward boards and blocks.
            const big = /^(F|C|PF|C-F|F-C)$/i.test(pos), sc = proj / 8;
            e = FRESH_LINE[st] * sc * (big ? ({ REB: 1.35, BLK: 1.8, AST: 0.6, '3PM': 0.5 }[st] || 1) : ({ AST: 1.3, '3PM': 1.3, REB: 0.8, BLK: 0.5 }[st] || 1));
          }
          if (e != null) exp[st] = Math.round(e * k * mf * 100) / 100;
        }
        rows.push({ id: p.id, passId: p.passId, name, team, tid: g.id, pos, opp: g.opp, home: g.home, at: g.at, exp,
          avg: ca == null ? null : Math.round(ca * 10) / 10, games: cg, avgLast: oa == null ? null : Math.round(oa * 10) / 10,
          proj: proj == null ? null : Math.round(proj * k * mf * 10) / 10, basis, flags, skip, fresh, noData });
      }
    }
    /* Each team's own injury list too (the league list misses some, like a
       star placed on IR mid-week): out, IR, doubtful or suspended - no booster. */
    try {
      const tinj = await boostTeamInj(env, sp, rows.map(r => r.tid));
      for (const r of rows) {
        const ij = tinj[boostName(r.name)]; if (!ij || r.skip) continue;
        if (/^(out|injured reserve|doubtful|suspen)/i.test(ij.status)) { r.skip = true; r.flags.push(ij.status); }
        else if (/questionable/i.test(ij.status) && !r.flags.some(f => /^questionable/i.test(f))) {
          r.flags.push('Questionable');
          if (r.proj != null) r.proj = Math.round(r.proj * 0.75 * 10) / 10;
          for (const st of Object.keys(r.exp)) r.exp[st] = Math.round(r.exp[st] * 0.75 * 100) / 100;
        }
      }
    } catch (e) {}
    const pinOf = r => sp === 'ncaam' && CBB_PIN[r.id] && !r.skip ? CBB_PIN[r.id] : null;
    rows.sort((a, b) => (a.skip - b.skip) || (((pinOf(a) || [99])[0]) - ((pinOf(b) || [99])[0]))
      || ((a.noData ? 1 : 0) - (b.noData ? 1 : 0)) || ((b.proj ?? -1) - (a.proj ?? -1)));
    const bars = BOOST_BARS[sp].map(x => Math.round(x * BOOST_MODES[mode] * 10) / 10);
    const RK = { 5: 'legendary', 4: 'epic', 3: 'rare' };
    let used = null;
    /* Rarity from projected rax, by setting (CBB numbers; football scaled):
         balanced  Legendary 14.5+ (at most 15% of Legendaries held), Epic 10+, Rare 5+
         heavy     Legendary 11.5+ (at most 40%), Epic 9+, Rare 5+
         saver     Legendary 18+, Epic 14.5+, everyone else 5+ a Rare
       capped by what the member holds; pinned CBB players go first. */
    const left = inv ? inv.map(b => ({ ...b })) : null;
    const scale = { ncaam: 1, ncaaf: 2.17, nfl: 1.65 }[sp] || 1;
    const MODE_RULES = { balanced: { leg: 14.5, epic: 10, cap: 0.15 }, heavy: { leg: 11.5, epic: 9, cap: 0.4 }, saver: { leg: 18, epic: 14.5, cap: 1 } };
    const R = { ...(MODE_RULES[mode] || MODE_RULES.balanced) };
    /* CFB on Balanced (Dennis, 2026-11-04): 67 players make 25+ rax a game over
       5+ games, so Legendary from 27.5 projected and Epic from 26, and up to 70%
       of the Legendaries held go out in a week (one slate a week in college football). */
    /* CFB bars of its own, per week. Set from the season so far (2026-11-04):
       of the CFB players with 4+ games, 26 average 27.5+ rax, 113 average 23+,
       268 average 20+ and about 990 average 15+. Legendaries are easy to come
       by in CFB, so they're spent freely - the old bars (27.5 / 23 / 30) left
       most of them unused and put Rares on 20-rax players.
         balanced  Legendary 22+ (up to 70% of Legendaries), Epic 15+
         heavy     Legendary 18+ (all of them can go), Epic 12+
         saver     Legendary 27.5+ (at most 20%), Epic 20+
       and no Rare under 10 projected on any of them. */
    const CFB_RULES = { balanced: { leg: 22, epic: 15, cap: 0.7 }, heavy: { leg: 18, epic: 12, cap: 1 }, saver: { leg: 27.5, epic: 20, cap: 0.2 } };
    /* Golf (2026-11-04): a whole tournament's rax, 0 to about 36 a player; the
       top 3% of finishes make 26+, the top 10% 22+, the median about 11. As
       projections (form and course averages): Legendary 19+, Epic 15+, Rare 10+. */
    const GOLF_RULES = { balanced: { leg: 19, epic: 15, cap: 0.5 }, heavy: { leg: 17, epic: 13.5, cap: 1 }, saver: { leg: 22, epic: 18, cap: 0.25 } };
    const cfb = sp === 'ncaaf' ? CFB_RULES[mode] || CFB_RULES.balanced : sp === 'golf' ? GOLF_RULES[mode] || GOLF_RULES.balanced : null;
    if (cfb) R.cap = cfb.cap;
    let legBar = cfb ? cfb.leg : R.leg * scale, epicBar = cfb ? cfb.epic : R.epic * scale, rareFloor = sp === 'ncaaf' || sp === 'golf' ? 10 : 5;
    const cutAt = null;
    if (CUS) { legBar = CUS.leg ?? Infinity; epicBar = CUS.epic ?? Infinity; rareFloor = CUS.rare ?? Infinity; }
    bars.splice(0, 3, Math.round(legBar * 10) / 10, Math.round(epicBar * 10) / 10, rareFloor);
    const held = r => inv ? inv.filter(b => b.rarity === r).reduce((t, b) => t + b.count, 0) : 0;
    const dayCap = CUS ? { 5: CUS.max[5] ?? Infinity, 4: CUS.max[4] ?? Infinity, 3: CUS.max[3] ?? Infinity }
      : { 5: held(5) ? Math.max(1, Math.floor(held(5) * R.cap)) : 0, 4: Infinity, 3: Infinity };
    const usedR = { 5: 0, 4: 0, 3: 0 };
    // Custom maxes hold even when Real won't say what boosters they have.
    const own = r => left ? Math.min(held(r), dayCap[r]) - usedR[r] : CUS ? dayCap[r] - usedR[r] : Infinity;
    const NR = { 5: 'legendary', 4: 'epic', 3: 'rare' };
    const gainOf = (r, b) => {
      // A two-attribute booster counts whichever side the player produces on.
      let best = null;
      for (const a of (b.attrs || [])) { const e = r.exp[a.stat]; if (e == null) continue; const g = e * a.boost; if (!best || g > best.g) best = { g, a, e }; }
      return best;
    };
    // 1. Rarity for each player.
    for (const r of rows) {
      let want = null;
      if (!r.skip && r.proj != null) {
        want = r.proj >= legBar ? 5 : r.proj >= epicBar ? 4 : r.proj >= rareFloor ? 3 : null;
        // Pinned players keep their spot in line, and outside Boost saver their minimum rarity too.
        const pin = pinOf(r); if (pin && mode !== 'saver' && !CUS && (!want || want < pin[1])) want = pin[1];
      }
      while (want && (left || CUS) && own(want) <= 0) want = want > 3 ? want - 1 : null;
      r.boost = want ? NR[want] : null;
      r._r = want;
      if (want && (left || CUS)) usedR[want]++;
      r.belowCut = false;
    }
    /* 2. Attributes, per rarity, for the most rax across everyone rather
       than player by player: the best player-booster pairs are taken first,
       then any two players swap boosters whenever that adds up to more. So a
       steals or blocks booster goes to the player who'll actually use it,
       even if he'd have made a little more with points, because the points
       booster earns more on someone else. */
    if (left) for (const rr of [5, 4, 3]) {
      const ps = rows.filter(r => r._r === rr);
      const groups = left.filter(b => b.rarity === rr && b.count > 0);
      if (!ps.length || !groups.length) continue;
      const g = (r, b) => { const x = gainOf(r, b); return x ? x.g : 0; };
      const pairs = [];
      for (const r of ps) for (const b of groups) pairs.push({ r, b, v: g(r, b) });
      pairs.sort((x, y) => y.v - x.v || y.b.count - x.b.count);
      const pick = new Map();
      for (const q of pairs) { if (pick.has(q.r) || q.b.count <= 0) continue; pick.set(q.r, q.b); q.b.count--; }
      // Swaps between two players, and trading a player's booster for an unused one.
      for (let pass = 0, better = true; better && pass < 6; pass++) {
        better = false;
        const arr = [...pick.keys()];
        for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) {
          const a = arr[i], c = arr[j], ba = pick.get(a), bc = pick.get(c);
          if (ba === bc) continue;
          if (g(a, bc) + g(c, ba) > g(a, ba) + g(c, bc) + 1e-9) { pick.set(a, bc); pick.set(c, ba); better = true; }
        }
        for (const a of arr) { const ba = pick.get(a);
          for (const b of groups) if (b !== ba && b.count > 0 && g(a, b) > g(a, ba) + 1e-9) { b.count--; ba.count++; pick.set(a, b); better = true; break; } }
      }
      const lab = (b, x) => x ? `${x.a.stat} +${x.a.boost}` : `${b.stat}`;
      const pack = (b, r) => { const x = gainOf(r, b); return { label: lab(b, x), avg: x ? Math.round(x.e * 100) / 100 : null, gain: x ? Math.round(x.g * 100) / 100 : null, mult: b.mult || 1 }; };
      for (const r of ps) {
        const b = pick.get(r);
        if (b) r.best = pack(b, r);
        // Second option: the next best booster of this rarity for him.
        const alt = groups.filter(x => x !== b).map(x => ({ x, v: g(r, x) })).sort((p, q) => q.v - p.v)[0];
        if (alt) r.alt = pack(alt.x, r);
      }
    }
    for (const r of rows) {
      if (!r._r) continue;
      // The booster's rarity multiplies the base projection (x10/15/25); the
      // attribute's extra is added on top and is never multiplied.
      r.mult = r.best ? r.best.mult : ({ 5: 25, 4: 15, 3: 10 })[r._r] || 1;
      r.withBoost = r.proj != null ? Math.round((r.proj * r.mult + ((r.best && r.best.gain) || 0)) * 10) / 10 : null;
      delete r._r;
    }
    const totals = { base: 0, boosted: 0, recBoosted: 0 };
    for (const r of rows) {
      if (r.skip || r.proj == null) continue;
      totals.base += r.proj;
      totals.boosted += r.withBoost ?? r.proj;
      totals.recBoosted += r.boost && !r.belowCut ? (r.withBoost ?? r.proj) : r.proj;
    }
    for (const k of Object.keys(totals)) totals[k] = Math.round(totals[k]);
    if (inv) used = inv.map((b, i) => ({ ...b, used: b.count - left[i].count }));

    return json({ sport: sp, season: se, date: day, mode, bars: bars.map(x => Number.isFinite(x) ? x : null), cutAt, totals, legCap: inv && Number.isFinite(dayCap[5]) ? dayCap[5] : null, inv: used, statMode: !!used, rsUser: u.rsUser, cardsAt: cards.at, games: sched.games, event: sched.event || null, course: sched.course || null, field: sched.field ?? null, depth: !!depth,
      rows, notPlaying: idle.length, players: cards.players.length });
  }

  if (op === 'matches') {
    const rows = (await db.prepare(`SELECT * FROM swap_matches WHERE status <> 'cleared' ORDER BY id DESC LIMIT 200`).all()).results || [];
    // Only the members in these matches, a page at a time (all passes at once is past D1's 50 MB).
    const keys = [...new Set(rows.flatMap(m => [m.a, m.b]))];
    const users = [];
    for (let i = 0; i < keys.length; i += 20) {
      const part = keys.slice(i, i + 20);
      users.push(...(((await db.prepare(`SELECT key, rsUser, passes FROM swap_users WHERE key IN (${part.map(() => '?').join(',')})`).bind(...part).all()).results) || []));
    }
    const want = new Set(rows.flatMap(m => [m.aGets, m.bGets]));
    const names = {};
    for (const u of users) for (const p of parse(u.passes, [])) if (want.has(p.key)) names[p.key] = p.name;
    const rs = Object.fromEntries(users.map(u => [u.key, u.rsUser]));
    return json({ matches: rows.map(m => ({ ...m, aUser: rs[m.a], bUser: rs[m.b], aGetsName: names[m.aGets], bGetsName: names[m.bGets] })) });
  }

  if (op === 'run') return json({ made: await runMatching(db, env) });

  // A raw look at a Real endpoint with the swap token: GET only, and only the
  // paths swaps need, for working out response shapes.
  /* Admin: one member's Real profile, raw, to see whether Real says if they
     have Real Pro. Looks the username up, then tries the likely profile
     addresses, and lists every field whose name looks like a plan or badge. */
  if (op === 'proprobe') {
    if (!auth) return json({ error: 'No swap token found.' }, 503);
    const name = String(url.searchParams.get('user') || '').trim().replace(/^@/, '');
    if (!name) return json({ error: 'Enter a Real username.' }, 400);
    if (url.searchParams.get('clear') === '1') {
      await db.prepare(SPRO_DDL).run();
      const r = await db.prepare('DELETE FROM swap_pro WHERE key=?').bind(name.toLowerCase()).run();
      return json({ cleared: !!(r.meta && r.meta.changes) });
    }
    if (!(await allow(url.origin, 'proprobe', 6, 600))) return json({ error: 'Six checks per ten minutes.' }, 429);
    const LOOK = /pro|premium|subscri|plus|tier|plan|badge|verified|member|vip|paid|level|perk/i;
    const hits = [];
    const walk = (o, path, src) => {
      if (!o || typeof o !== 'object') return;
      for (const [k, v] of Object.entries(o)) {
        const p2 = path ? path + '.' + k : k;
        if (LOOK.test(k) && !/profileimage|projection|prestige|property/i.test(k)) hits.push({ src, field: p2, value: typeof v === 'object' ? JSON.stringify(v).slice(0, 200) : v });
        if (v && typeof v === 'object' && hits.length < 80) walk(v, p2, src);
      }
    };
    const out = { user: name, tried: [] };
    let found = null;
    try {
      const d = await rsGetJson(`https://web.realapp.com/searchusers?query=${encodeURIComponent(name)}`, auth);
      found = ((d && d.users) || []).find(x => String(x.userName || '').toLowerCase() === name.toLowerCase()) || null;
      out.search = found; if (found) walk(found, '', 'searchusers');
    } catch (e) { out.searchError = String(e.message || e).slice(0, 200); }
    if (!found) return json({ ...out, error: 'No Real user with that exact username.' }, 404);
    out.pro = { isRealPro: !!found.isRealPro, realProTier: found.realProTier ?? null, supporterTier: found.supporterTier ?? null, emblems: found.emblemIds || [] };
    out.hits = hits;
    return json(out);
  }

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

  /* Full test of the DM flow on one Real username: opens (or reuses) the
     bot's chat with them and sends a message. Capped like the test send. */
  // A member says they've messaged the bot: re-read its chat list.
  if (op === 'connect') {
    if (!auth) return json({ error: 'No swap token found.' }, 503);
    if (!(await allow(url.origin, 'swapdm-connect:' + me, 4, 600))) return json({ error: 'Too many checks - wait a few minutes and try again.' }, 429);
    if (!(await allow(url.origin, 'swapdm-connect-all', 20, 60))) return json({ error: HIGH_VOL }, 429);
    // Their Real account: from a scan, else the Pro check, else one lookup of their board username.
    let u = await db.prepare('SELECT hashId FROM swap_users WHERE key=?').bind(me).first();
    if (!u || !u.hashId) {
      let hid = null;
      try { await db.prepare(SPRO_DDL).run(); const pr = await db.prepare('SELECT rsId FROM swap_pro WHERE key=?').bind(me).first(); hid = pr && pr.rsId; } catch (e) {}
      const rn = await realName(db, me);
      if (!hid) { try { hid = await resolveHashId(rn, scanTok(env)); } catch (e) { return json({ error: 'Could not reach Real just now - try again in a minute.' }, 502); } }
      if (!hid) return json({ error: `No Real account called ${rn}. If your Real username is different, link it at raxacademy.app/username.` }, 404);
      await db.prepare(`INSERT INTO swap_users (key, rsUser, hashId) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET hashId=excluded.hashId, rsUser=excluded.rsUser`)
        .bind(me, rn, hid).run();
      u = { hashId: hid };
    }
    try { await acceptRequests(db, auth); } catch (e) {}
    try { await syncChats(db, auth); } catch (e) { return json({ error: String(e.message || e) }, 502); }
    const c = await db.prepare('SELECT channelId FROM swap_dm WHERE hashId=? AND channelId IS NOT NULL').bind(u.hashId).first();
    await stat(db, 'verify_try'); if (c) await stat(db, 'verify_ok');
    /* A "Confirmed" reply in their chat once they're verified (Dennis, 2026-11-05), sent once.
       If Real won't let the bot message them, the page says why. */
    let confirmFailed = false;
    if (c) {
      try { await db.prepare('CREATE TABLE IF NOT EXISTS bot_once (campaign TEXT, key TEXT, at INTEGER, ok INTEGER, PRIMARY KEY (campaign, key))').run();
        const done = await db.prepare("SELECT 1 AS x FROM bot_once WHERE campaign='confirm' AND key=?").bind(String(me).toLowerCase()).first();
        if (!done) {
          try { await dmSendRetry(auth, c.channelId, 'Confirmed');
            await db.prepare("INSERT OR IGNORE INTO bot_once (campaign, key, at, ok) VALUES ('confirm', ?, ?, 1)").bind(String(me).toLowerCase(), Date.now()).run(); await stat(db, 'dm_confirm'); }
          catch (e) { const m = String(e.message || e); if (/send 403|cannot message/i.test(m)) { confirmFailed = true; await stat(db, 'dm_confirm_failed'); } else await botFail(db, 'dm_confirm', `${me}: ${m}`); }
        }
      } catch (e) {}
    }
    return json({ connected: !!c, confirmFailed: confirmFailed || undefined });
  }

  /* Who has Swaps: the named list (and whether each name matches a board
     account), anyone granted by hand, and a user search to grant more. */
  if (op === 'access') {
    await db.prepare(SACCESS_DDL).run();
    const key = String(url.searchParams.get('key') || '');
    const act = url.searchParams.get('act');
    await db.prepare(OTD_DDL).run();
    const tbl = url.searchParams.get('what') === 'otd' ? 'otd_access' : 'swap_access';
    if (act === 'grant' || act === 'revoke') {
      const u = await db.prepare('SELECT key FROM users WHERE key=?').bind(key).first();
      if (!u) return json({ error: 'no such account' }, 404);
      if (act === 'grant') await db.prepare(`INSERT INTO ${tbl} (key, grantedAt) VALUES (?, ?) ON CONFLICT DO NOTHING`).bind(key, Date.now()).run();
      else await db.prepare(`DELETE FROM ${tbl} WHERE key=?`).bind(key).run();
    }
    const otdGranted = ((await db.prepare('SELECT key FROM otd_access').all()).results || []).map(r => r.key);
    const ph = SWAP_MEMBERS.map(() => '?').join(',');
    const hits = (await db.prepare(`SELECT key, name FROM users WHERE LOWER(key) IN (${ph}) OR LOWER(name) IN (${ph})`)
      .bind(...SWAP_MEMBERS, ...SWAP_MEMBERS).all()).results || [];
    const named = SWAP_MEMBERS.map(n => {
      const u = hits.find(h => String(h.key).toLowerCase() === n || String(h.name || '').toLowerCase() === n);
      return { name: n, account: u ? u.key : null };
    });
    const granted = (await db.prepare('SELECT a.key, u.name FROM swap_access a LEFT JOIN users u ON u.key=a.key ORDER BY a.grantedAt DESC').all()).results || [];
    const q = String(url.searchParams.get('q') || '').trim().toLowerCase().replace(/[%_]/g, '');
    const found = q.length >= 2 ? ((await db.prepare(
      `SELECT key, name FROM users WHERE COALESCE(banned, 0) = 0 AND (LOWER(key) LIKE ? OR LOWER(name) LIKE ?) ORDER BY LENGTH(key) LIMIT 20`)
      .bind(`%${q}%`, `%${q}%`).all()).results || []) : [];
    const has = new Set(granted.map(g => g.key));
    return json({ named, granted, otd: otdGranted, found: found.map(f => ({ ...f, access: has.has(f.key) })) });
  }

  if (op === 'chats') {
    if (!auth) return json({ error: 'No swap token found.' }, 503);
    let synced = null, err = null;
    let reqs = null;
    if (url.searchParams.get('sync') === '1') {
      try { reqs = await acceptRequests(db, auth); } catch (e) { err = 'requests: ' + String(e.message || e); }
      try { synced = await syncChats(db, auth); } catch (e) { err = String(e.message || e); }
    }
    await db.prepare(DM_DDL).run();
    const n = await db.prepare('SELECT COUNT(*) AS n FROM swap_dm').first();
    return json({ synced, requests: reqs, error: err, chatsKnown: n ? n.n : 0, newChatsLeftToday: await newChatsLeft(env) });
  }

  if (op === 'dmopen') {
    if (!auth) return json({ error: 'No swap token found.' }, 503);
    const user = String(url.searchParams.get('user') || '').trim().replace(/^@/, '');
    const text = String(url.searchParams.get('text') || 'Swap bot test').slice(0, 300);
    if (!/^[\w.\-]{2,40}$/.test(user)) return json({ error: 'enter a Real username' }, 400);
    if (!(await allow(url.origin, 'swapdm-test', 5, 600))) return json({ error: 'Five test messages per ten minutes.' }, 429);
    try {
      const hashId = await resolveHashId(user, auth);
      if (!hashId) return json({ error: `No Real user called ${user}.` }, 404);
      const ch = await dmChannel(db, auth, hashId, user, env);
      await dmSend(auth, ch, text);
      return json({ ok: true, user, hashId, channelId: ch });
    } catch (e) { return json({ error: String(e.message || e) }, 502); }
  }

  // Sends one match right now, whatever its slot - for testing.
  // Admin: put a match back on schedule (its DMs go out again at the normal times).
  if (op === 'resetmatch' && request.method === 'POST') {
    await matchCols(db);
    const id = Number(url.searchParams.get('id'));
    const r = await db.prepare(`UPDATE swap_matches SET status='pending', warnA=NULL, warnB=NULL, doneA=NULL, doneB=NULL, followA=NULL, followB=NULL, sentAt=NULL, note='reset to schedule' WHERE id=? AND status <> 'cleared'`).bind(id).run();
    return json({ ok: !!(r.meta && r.meta.changes) });
  }

  if (op === 'sendnow' && request.method === 'POST') {
    if (!auth) return json({ error: 'No swap token found.' }, 503);
    const id = Number(url.searchParams.get('id'));
    await matchCols(db);
    const m = await db.prepare('SELECT * FROM swap_matches WHERE id=?').bind(id).first();
    if (!m) return json({ error: 'no such match' }, 404);
    try {
      const note = await sendMatch(env, db, auth, m);
      await db.prepare(`UPDATE swap_matches SET note=? WHERE id=?`).bind(note.slice(0, 300), id).run();
      return json({ ok: true, note, status: m.status });
    } catch (e) {
      await db.prepare(`UPDATE swap_matches SET note=? WHERE id=?`).bind(String(e.message || e).slice(0, 300), id).run();
      return json({ error: String(e.message || e) }, 502);
    }
  }

  return json({ error: 'unknown op' }, 400);
}
