// One shared ET-day formatter: building one per call was slow and memory-hungry (2026-11-14).
const ET_DAY_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
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
import { pushTo, vapidKeys, PUSH_DDL } from '../../lib/webpush.js';
import { isAdminRequest, sessionKey, forbidden, allow, clientIp, touchSeen, ADMINS, etDay } from '../../lib/auth.js';
import { watchEnv, noteSlowRequest } from '../../lib/dbwatch.js';
import { TESTER_PAGES, TESTER_LINKS, TESTER_KV, testerMap, testerPagesFor } from '../../lib/testers.js';
import { predPortSync, predPortTok, dfsPull } from './rax.js';   // Dennis's portfolio sync (circular import is fine: called at run time only)

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
    SELECT sport, season, playerId, MAX(player), LOWER(MAX(player)), MAX(CASE WHEN seasonType = 'allstar' THEN NULL ELSE team END), COALESCE(SUM(rax), 0), COUNT(*)
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

/* Boosts' "Read my passes" breakdown (2026-11-09): passes per sport-season,
   teams apart, and how many of each pass rarity. */
function passSummary(ps) {
  const m = new Map();
  for (const p of ps) { const k = p.sport + ':' + p.season; const o = m.get(k) || m.set(k, { sport: p.sport, season: p.season, n: 0, teams: 0, by: {} }).get(k);
    o.n++; if (p.kind === 'team') o.teams++; const l = p.levelLabel || (p.rarity != null ? 'R' + p.rarity : ''); if (l) o.by[l] = (o.by[l] || 0) + 1; }
  return [...m.values()].sort((a, b) => b.n - a.n);
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
/* The market account does nothing but collect performances until they're all
   in (Dennis, 2026-11-09) - the flag perf_all_done_v1 ends that. Until then
   scans and lookups that used it go through the board account instead. */
let PERF_ONLY = true, PERF_ONLY_AT = 0;
async function perfOnlyRefresh(env) {
  if (Date.now() - PERF_ONLY_AT < 120000) return PERF_ONLY;
  try { PERF_ONLY = !(await env.RATEBOARD_KV.get('perf_all_done_v1')); PERF_ONLY_AT = Date.now(); } catch (e) {}
  return PERF_ONLY;
}
// Account 2 no longer helps with scans or lookups (2026-11-13, Dennis): bulk-rating auctions only.
const marketTok = env => null;
function scanToks(env) {
  // The market account first: it sits idle unless a market pull is queued,
  // while the board account is busy with the game-data collectors all day.
  const t = [marketTok(env), env.RS_AUTH_TOKEN].filter(x => typeof x === 'string' && x.length > 20);
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
/* Only players with 30+ (27+ until 2026-11-10) collectible plays can be swapped for (Dennis,
   2026-11-04): a pack of a thin player is mostly the same few cards. Counts
   come from pack data (each season's saved board), kept 12 hours as a small
   id -> plays map. A season with no pack data at all isn't held back. */
/* A pass's own multiplier, worked out from its rating (Dennis, 2026-11-11).
   Real's own figure is fine below Legendary (Rare 4x, Epic 10x), but from
   Legendary up it sends two kinds: "Legendary 2" 28x, "Iconic 1" 150x - and
   for some passes just "Legendary" 2.5x, "Mystic" 4x, "Iconic" 6x. So from
   380 rating (Legendary 1) the level and its multiplier come from the
   rating, on the same ladder as Pack data. */
const CARD_LADDER = [[380, 25], [520, 28], [720, 32], [1000, 35], [1180, 40], [1380, 75], [1560, 79], [1760, 83], [1980, 87], [2220, 91], [2480, 95], [2760, 98], [3000, 101], [3180, 103], [3250, 105],
  [3380, 150], [3820, 153], [4320, 156], [4920, 159], [5620, 163], [6420, 167], [7320, 171], [8320, 175], [9420, 180], [10620, 185], [12000, 190], [13600, 196], [15400, 202], [17500, 208], [19900, 214], [22700, 220], [26000, 226], [29000, 233], [34500, 240], [40000, 250]];
/* The card's own multiplier from its rarity and level (2026-11-15, a member: a boosted
   Legendary read as x50 - Real's multiplier on a pass includes a booster that's on it,
   so with "Include my card rarities" the booster was counted twice). Base by label:
   General 1, Common 2, Uncommon 3, Rare 4, Epic 10; Legendary/Mystic/Iconic by level. */
const CARD_BASE = { general: 1, common: 2, uncommon: 3, rare: 4, epic: 10 };
function cardMultOf(p) {
  const lab = String((p && p.levelLabel) || '').trim().toLowerCase(), lm = lab.match(/^(legendary|mystic|iconic)\s*(\d+)?$/);
  if (CARD_BASE[lab] != null) return CARD_BASE[lab];
  if (lm) { const lv = Math.max(1, Number(lm[2]) || 1), at = { legendary: 0, mystic: 5, iconic: 15 }[lm[1]] + lv - 1;
    if (CARD_LADDER[at] && (lm[1] !== 'legendary' || lv <= 5) && (lm[1] !== 'mystic' || lv <= 10)) return CARD_LADDER[at][1]; }
  const r = Number(p && p.rating);
  if (Number.isFinite(r) && r >= 380) { let m = 25; for (const [at, x] of CARD_LADDER) if (r >= at) m = x; return m; }
  return (p && p.mult) || null;
}
const MIN_PLAYS = 30;   // 27 until 2026-11-10
// Plays and average card rating per player, from the pack data (Bulk's Grind tab, 2026-11-15).
async function packInfo(env, db, sp, se) {
  const k = `pack_info_v1_${sp}_${se}`;
  try { const c = JSON.parse((await env.RATEBOARD_KV.get(k)) || 'null'); if (c && Date.now() - c.at < 12 * 3600000) return c.m; } catch (e) {}
  let m = null;
  try { const r = await db.prepare('SELECT body FROM pack_snap WHERE sport=? AND season=?').bind(sp, Number(se)).first();
    const rows = parse(r && r.body, null);
    if (Array.isArray(rows) && rows.length) { m = {}; for (const x of rows) if (x && x.playerId != null) m[x.playerId] = [Number(x.plays) || 0, Number(x.avgRating) || null]; } } catch (e) {}
  try { await env.RATEBOARD_KV.put(k, JSON.stringify({ at: Date.now(), m }), { expirationTtl: 86400 }); } catch (e) {}
  return m;
}
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
/* Thin players (Dennis, 2026-11-25): Dennis alone can swap for players with 10-29 plays. Each member who gives
   him one can't be matched to give him that same player again for 168 hours (from the swap's time, not the 7am day). */
const THIN_MIN = 10, THIN_OWNER = 'dennis', THIN_GAP_MS = 168 * 3600000;
async function lowPlays(env, db, keys, thin, who) {
  const bySeason = new Map(), low = new Set();
  for (const k of keys) { const [sp, se, id] = String(k).split(':'); if (/^t/.test(id)) continue; (bySeason.get(`${sp}:${se}`) || bySeason.set(`${sp}:${se}`, []).get(`${sp}:${se}`)).push([k, id]); }
  // Every season at once rather than one after another.
  await Promise.all([...bySeason].map(async ([ss, list]) => { const [sp, se] = ss.split(':');
    let c = playsMemo.get(ss);
    if (!c || Date.now() - c.at > 30 * 60000) { c = { at: Date.now(), m: await playsMap(env, db, sp, se) }; playsMemo.set(ss, c); }
    const m = c.m; if (!m) return; for (const [k, id] of list) { const n = m[id] || 0; if (n < MIN_PLAYS) { if (n >= THIN_MIN && thin) thin.add(k); if (!(String(who || '').toLowerCase() === THIN_OWNER && n >= THIN_MIN)) low.add(k); } } }));
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
/* Real lets a member open 30 packs a day per sport + season, so a member
   GIVES in at most 25 swaps a swap day per sport + season (5 spare as a
   safety net). Receiving isn't limited (Dennis, 2026-11-08). */
const SEASON_GIVE_MAX = 25;
/* 160s (Dennis, 2026-11-08). A seller with a pass whose pack wasn't used in a
   swap opens it at their hour; a buyer who wants that player offers 160 rax
   on a card from it, and the seller sends the 160 back. One-way: the seller
   gives, the buyer receives. Made after the swaps in each matching run, so
   swaps come first; the seller's pack counts as given (once a swap day, and
   toward the 25 per sport + season), the buyer's as received (their goal and
   per-day limits). warnS / warnB = seller / buyer told (30 min before). */
const T160_DDL = `CREATE TABLE IF NOT EXISTS swap_160 (id INTEGER PRIMARY KEY AUTOINCREMENT, buyer TEXT, seller TEXT, pass TEXT, slot INTEGER, dueAt INTEGER, createdAt INTEGER, status TEXT, warnS INTEGER, warnB INTEGER, note TEXT)`;
const MAX_160_HOUR = 15;
/* Niche players. A player fewer than NICHE_UNDER active swappers own (active =
   in a swap in the last 7 days) can't find swap partners, so the member who
   wants him can ask N opted-in members to BUY the player and a pack at an hour
   they share; the requester pays full price for the cards. Someone is only
   asked while they hold fewer than 85 players of a season being played, or
   fewer than 100 of an old one. One niche buy an hour, two a swap day each. */
const NICHE_UNDER = 30,   // fewer than 30 OTHER active swappers own him (Dennis, 2026-11-10; was 20 counting everyone)
      NICHE_MAX_ASK = 40, NICHE_DAY_MAX = 2, NICHE_HOUR_MAX = 1, NICHE_LIVE_CAP = 85, NICHE_OLD_CAP = 100;
const NICHE_KEY = 'swap_ownercounts_v4';
const NICHE_OVER = new Set(['mlb:2026', 'wnba:2026']);   // newest season, but finished: counts as an old one (under 100)
const nicheLiveSeason = k => { const [sp, se] = String(k).split(':'); return Number(se) === (SWAP_SEASONS[sp] || [])[0] && !NICHE_OVER.has(`${sp}:${se}`); };
// A member's own limits on niche buys (step 6): { h: an hour, d: a swap day }.
const nicheLim = u => { const l = parse(u.nicheLim, {}) || {}; return { h: Math.max(1, Math.min(10, Math.floor(Number(l.h)) || NICHE_HOUR_MAX)), d: Math.max(1, Math.min(40, Math.floor(Number(l.d)) || NICHE_DAY_MAX)) }; };
/* How many active swappers own each pass. Worked out by the hourly matching
   run, which already has every member's passes in hand, and kept in KV: the
   database is never asked (2026-11-10: unpacking every member's passes in a
   query overloaded it). Active = in a swap in the last 7 days. */
async function ownerCounts(env) {
  try { const c = JSON.parse((await env.RATEBOARD_KV.get(NICHE_KEY)) || 'null'); if (c && c.n) return c; } catch (e) {}
  return { at: 0, active: 0, n: {} };
}
/* Everyone in a swap in the last 7 days, their passes read a few rows at a
   time in the worker (not unpacked in the database, which overloaded it), and
   counted. Once an hour, from the minute run, outside the matching window. */
async function saveOwnerCounts(env, db) {
  const LOCK = 'swap_ownercounts_lock';
  try { if (await env.RATEBOARD_KV.get(LOCK)) return; await env.RATEBOARD_KV.put(LOCK, '1', { expirationTtl: 600 }); } catch (e) { return; }
  try {
    const act = [...new Set((((await db.prepare(`SELECT DISTINCT a AS k FROM swap_matches WHERE createdAt > ?1 AND status NOT IN ('cancelled','cancelling')
        UNION SELECT DISTINCT b FROM swap_matches WHERE createdAt > ?1 AND status NOT IN ('cancelled','cancelling')`).bind(Date.now() - 7 * 86400000).all()).results) || []).map(r => r.k))];
    const n = {}; let read = 0;
    for (let i = 0; i < act.length; i += 8) {
      const part = act.slice(i, i + 8);
      const rows = ((await db.prepare(`SELECT key, passes FROM swap_users WHERE key IN (${part.map(() => '?').join(',')})`).bind(...part).all()).results) || [];
      for (const r of rows) { read++; const seen = new Set(); for (const p of parse(r.passes, [])) if (p && p.kind !== 'team' && p.key && !seen.has(p.key)) { seen.add(p.key); n[p.key] = (n[p.key] || 0) + 1; } }
      await sleep(150);
    }
    if (read) await env.RATEBOARD_KV.put(NICHE_KEY, JSON.stringify({ at: Date.now(), active: act.length, read, n, act }), { expirationTtl: 3 * 86400 });
  } catch (e) { try { await botFail(db, 'scan_bg', 'owner counts: ' + String(e.message || e).slice(0, 120)); } catch (e2) {} }
  try { await env.RATEBOARD_KV.delete(LOCK); } catch (e) {}
}
const seasonOf = k => String(k || '').split(':').slice(0, 2).join(':');
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
  return { mode: 'daily', tz };   // tz kept for the 3am confirm DM's times
}
// The UTC hours a weekly/date schedule touches (today's offset), for counts and filters.
function schedUtc(sc) {
  if (!sc || sc.mode === 'daily') return null;
  const off = (() => { const l = localAt(Date.now(), sc.tz); return l ? ((l.hour - new Date().getUTCHours()) % 24 + 24) % 24 : 0; })();
  const loc = sc.mode === 'weekly' ? Object.values(sc.week || {}).flat() : (sc.hours || []);
  return [...new Set(loc.map(h => ((h - off) % 24 + 24) % 24))];
}
const MATCH_AHEAD_MS = 3 * 3600000 + 30 * 60000;   // a run fills the hours starting in the next 3.5 hours
const MAX_SLOTS = 24;    // hours a member can pick, per day: no limit (Dennis, 2026-11-06; was 10)
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
/* Notifications (Dennis, 2026-11-12): every message the board sends a member
   (replies, outcomes, warnings and strikes) is also kept for their
   Notifications page - so those the bot can't message still see it. */
const NOTE_DDL = 'CREATE TABLE IF NOT EXISTS user_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT, ts INTEGER, kind TEXT, text TEXT)';
async function addNote(db, key, kind, text) {
  try { if (!key) return; await db.prepare(NOTE_DDL).run();
    await db.prepare('INSERT INTO user_notes (key, ts, kind, text) VALUES (?, ?, ?, ?)').bind(String(key).toLowerCase(), Date.now(), kind, String(text).slice(0, 1500)).run(); } catch (e) {}
  // Every note also goes out as a push to browsers the member turned on (2026-11-16). Never waits or throws.
  if (PUSH_ENV) pushIf(PUSH_ENV, db, key, p => !(p.notes && p.notes.on === false), { title: PUSH_TITLE[kind] || 'Rax Academy', body: String(text).slice(0, 180), url: '/notifications', tag: 'note-' + kind }).catch(() => {});
}
/* Push notifications (2026-11-16). PUSH_ENV is the latest env this module saw (requests and ticks set it). */
let PUSH_ENV = null;
/* What each member wants pushed (Dennis, 2026-11-16, the Notifications page): swaps (warnings, swap time,
   confirm times), boost reminders per sport with how many hours before that day's first game (up to 36),
   and messages to them (replies, moderation - on unless turned off). Swaps and boosts are off until they
   activate them. KV per member. */
const PUSH_PREF = k => 'push_prefs_v1_' + String(k || '').toLowerCase();
async function pushPrefs(env, key) { try { return JSON.parse((await env.RATEBOARD_KV.get(PUSH_PREF(key))) || '{}') || {}; } catch (e) { return {}; } }
async function pushIf(env, db, key, test, msg) { try { const p = await pushPrefs(env, key); if (test(p)) await pushTo(env, db, key, msg); } catch (e) {} }
const BOOST_PUSH_SP = { nfl: 'NFL', ncaaf: 'CFB', nba: 'NBA', ncaam: 'CBB', nhl: 'NHL' };
const PUSH_TITLE = { mod: 'Swaps moderation', reply: 'Reply from Dennis', swap: 'Swaps', news: "What's new" };
/* What's new on the site, newest first - shown to everyone on Notifications. */
const SITE_NEWS = [
  ['2026-11-13', 'Only here to sell 160s? You can now also opt in to buy niche players for others, at the hours you sell 160s.'],
  ['2026-11-12', 'Top players on Boosts: every sport\'s top 100 by projected rax for any of the next 7 days, plus all sports together.'],
  ['2026-11-12', '160s can be rated with stars, the same as swaps.'],
  ['2026-11-12', 'Rating stars stay bright after you tick Done, until you submit a rating.'],
  ['2026-11-12', 'Boosts keeps a separate day for each sport, and "Re-read them" reads your boosters fresh after you use some.'],
  ['2026-11-12', 'Warnings and strikes now say which swap: who reported and the players both ways.'],
  ['2026-11-12', 'Liga MX players can be searched on the FC board.'],
  ['2026-11-12', 'OTD (By player and Every game) is open to every member.'],
  ['2026-11-12', 'The site moved to its own server - faster, and no more late swap DMs from an overloaded database.'],
  ['2026-11-11', 'Swaps moderation: a first report is a warning, then strikes; 3 strikes removes Swaps access, with an unban request on /swaps.'],
  ['2026-11-11', 'Late heads-up reports on the swap page, and each 160 links to the other member\'s comment.'],
  ['2026-11-10', 'Pack data team cards: best performances, best plays and the odds breakdown for each team.'],
  ['2026-11-09', 'Tag finder: every game that earned a performance tag.'],
  ['2026-11-09', 'New Home page with every page in one place, and one sign-in for the whole site.']];
async function adminDm(db, auth, who, text, ref) {
  if (who) await addNote(db, who.key || who.name, 'reply', text);
  if (!who || !who.channelId) return { sent: false, why: 'no open chat with the bot - kept on their Notifications page' };
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
/* Most picked players: how many active members swap for each, most first,
   with names and card links. Kept 5 minutes; the hour page's leaderboard and
   step 3's recommended buys both read it. */
async function wantTop(env, db) {
  let c = null; try { c = JSON.parse((await env.RATEBOARD_KV.get('swap_wanttop_v2')) || 'null'); } catch (e) {}
  if (c && Date.now() - c.at <= 300000) return c;
  const n = {}; let members = 0;
  for (const r of ((await db.prepare(`SELECT wants FROM swap_users WHERE active=1 AND wants IS NOT NULL AND wants <> '[]' AND hashId IN (SELECT v.hashId FROM swap_ver v JOIN swap_dm d ON d.hashId = v.hashId WHERE d.channelId IS NOT NULL)`).all()).results || [])) {
    members++; for (const w of parse(r.wants, []).slice(0, MAX_WANTS)) n[w] = (n[w] || 0) + 1; }
  const nc = new Map(), top = Object.entries(n).sort((a, b) => b[1] - a[1]).slice(0, 80);
  const rows = []; for (const [k, v] of top) rows.push({ key: k, name: await indexName(db, k, nc), n: v, url: playerUrl(k) });
  c = { at: Date.now(), members, rows };
  try { await env.RATEBOARD_KV.put('swap_wanttop_v2', JSON.stringify(c)); } catch (e) {}
  return c;
}
async function indexName(db, k, cache) {
  if (cache && cache.has(k)) return cache.get(k);
  const [sp, se, id] = String(k).split(':'); let n = null;
  try { const r = await db.prepare('SELECT player FROM swap_index WHERE sport=? AND season=? AND playerId=? LIMIT 1').bind(sp, Number(se), Number(String(id).replace(/^t/, ''))).first(); n = r && r.player; } catch (e) {}
  const v = `${n || 'Player ' + id} ${({ nba: 'NBA', ncaam: 'CBB', nfl: 'NFL', ncaaf: 'CFB', nhl: 'NHL', mlb: 'MLB', wnba: 'WNBA', golf: 'Golf' })[sp] || sp} ${se}`;
  if (cache) cache.set(k, v); return v;
}
/* Everyone named in the inbox, looked up together (2026-11-08: the inbox
   stopped loading - it looked each person up one at a time, ~6 queries a
   name plus ~40 per Swaps report, thousands in all once the reports piled
   up). Same answer as whoIs, a handful of queries for the lot. */
async function whoMany(db, names) {
  const ns = [...new Set(names.map(n => String(n || '').trim().replace(/^@/, '').toLowerCase()).filter(Boolean))];
  const out = new Map(); if (!ns.length) return out;
  await db.prepare(DM_DDL).run(); await db.prepare(RESTRICT_DDL).run();
  const chunks = (a, n) => { const r = []; for (let i = 0; i < a.length; i += n) r.push(a.slice(i, i + n)); return r; };
  const qs = a => a.map(() => '?').join(',');
  const all = async (sql, b) => ((await db.prepare(sql).bind(...b).all()).results) || [];
  const su = [];
  for (const c of chunks(ns, 45)) su.push(...await all(`SELECT key, rsUser, hashId, comment, active FROM swap_users WHERE LOWER(key) IN (${qs(c)}) OR LOWER(rsUser) IN (${qs(c)})`, [...c, ...c]));
  const uOf = new Map();
  for (const r of su) { const k = String(r.key || '').toLowerCase(), n = String(r.rsUser || '').toLowerCase(); if (k && !uOf.has(k)) uOf.set(k, r); }
  for (const r of su) { const n = String(r.rsUser || '').toLowerCase(); if (n && !uOf.has(n)) uOf.set(n, r); }
  const bKeys = [...new Set(ns.map(n => { const u = uOf.get(n); return u ? String(u.key).toLowerCase() : n; }))];
  const bOf = new Map();
  for (const c of chunks(bKeys, 90)) { try { for (const r of await all(`SELECT key, banned FROM users WHERE LOWER(key) IN (${qs(c)})`, c)) bOf.set(String(r.key).toLowerCase(), r); } catch (e) {} }
  const hashes = [...new Set(su.map(r => r.hashId).filter(Boolean))], chByHash = new Map(), chByName = new Map();
  for (const c of chunks(hashes, 90)) for (const r of await all(`SELECT hashId, channelId FROM swap_dm WHERE channelId IS NOT NULL AND hashId IN (${qs(c)})`, c)) chByHash.set(r.hashId, r);
  const dmNames = [...new Set(ns.map(n => { const u = uOf.get(n); return u && u.rsUser ? String(u.rsUser).toLowerCase() : n; }))];
  for (const c of chunks(dmNames, 90)) for (const r of await all(`SELECT LOWER(userName) AS nm, hashId, channelId FROM swap_dm WHERE channelId IS NOT NULL AND LOWER(userName) IN (${qs(c)})`, c)) if (!chByName.has(r.nm)) chByName.set(r.nm, r);
  const rKeys = ns.map(n => { const u = uOf.get(n), b = bOf.get(u ? String(u.key).toLowerCase() : n); return b ? b.key : (u ? u.key : n); });
  const restr = new Set();
  for (const c of chunks([...new Set(rKeys)], 90)) for (const r of await all(`SELECT key FROM restricted WHERE key IN (${qs(c)})`, c)) restr.add(r.key);
  ns.forEach((n, i) => {
    const u = uOf.get(n) || null, b = bOf.get(u ? String(u.key).toLowerCase() : n) || null;
    const ch = (u && u.hashId && chByHash.get(u.hashId)) || chByName.get(u && u.rsUser ? String(u.rsUser).toLowerCase() : n) || null;
    out.set(n, { name: n, key: b ? b.key : (u ? u.key : null), rsUser: (u && u.rsUser) || null, hashId: (u && u.hashId) || (ch && ch.hashId) || null,
      comment: (u && u.comment) || null, channelId: ch ? Number(ch.channelId) : null, banned: !!(b && b.banned), restricted: restr.has(rKeys[i]), swapper: !!(u && u.active) });
  });
  return out;
}
// Player names for pass keys ("sport:season:id"), in batches.
async function indexNames(db, keys) {
  const ks = [...new Set(keys.filter(Boolean).map(String))], out = new Map(), raw = new Map();
  const parts = ks.map(k => { const [sp, se, id] = k.split(':'); return [k, sp, Number(se), Number(String(id).replace(/^t/, ''))]; }).filter(x => x[1] && x[2] && x[3]);
  for (let i = 0; i < parts.length; i += 30) {
    const c = parts.slice(i, i + 30);
    try { for (const r of (((await db.prepare(`SELECT sport, season, playerId, player FROM swap_index WHERE ${c.map(() => '(sport=? AND season=? AND playerId=?)').join(' OR ')}`)
        .bind(...c.flatMap(x => [x[1], x[2], x[3]])).all()).results) || [])) { const k = `${r.sport}:${r.season}:${r.playerId}`; if (!raw.has(k)) raw.set(k, r.player); } } catch (e) {}
  }
  const LG = { nba: 'NBA', ncaam: 'CBB', nfl: 'NFL', ncaaf: 'CFB', nhl: 'NHL', mlb: 'MLB', wnba: 'WNBA', golf: 'Golf' };
  for (const k of ks) { const [sp, se, id] = k.split(':'); const n = raw.get(`${sp}:${se}:${Number(String(id).replace(/^t/, ''))}`);
    out.set(k, `${n || 'Player ' + id} ${LG[sp] || sp} ${se}`); }
  return out;
}
async function inboxItems(env, db, only) {
  let out = [];
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
  if (only) out = out.filter(x => x.src === only.src && x.id === String(only.id));
  const who = await whoMany(db, out.flatMap(x => [x.by, x.target]));
  const look = n => who.get(String(n || '').trim().replace(/^@/, '').toLowerCase()) || null;
  for (const x of out) { x.from = x.by ? look(x.by) : null; x.about = x.target ? look(x.target) : null; }
  // Swaps reports: the called-off swaps (last 30 days) the reporter was in, and whether they were refunded.
  try { await matchCols(db); } catch (e) {}
  const repKeys = [...new Set(out.filter(x => x.src === 'swap' && x.from && x.from.key).map(x => x.from.key))];
  const byKey = new Map(repKeys.map(k => [k, []]));
  for (let i = 0; i < repKeys.length; i += 45) {
    const c = repKeys.slice(i, i + 45), q = c.map(() => '?').join(',');
    const ms = ((await db.prepare(`SELECT * FROM swap_matches WHERE status='cancelled' AND createdAt > ? AND (a IN (${q}) OR b IN (${q})) ORDER BY id DESC`).bind(Date.now() - 30 * 86400000, ...c, ...c).all()).results) || [];
    for (const m of ms) for (const k of [m.a, m.b]) { const l = byKey.get(k); if (l && l.length < 20 && !l.includes(m)) l.push(m); }
  }
  const names = await indexNames(db, [...byKey.values()].flat().flatMap(m => [m.aGets, m.bGets]));
  for (const x of out) if (x.src === 'swap' && x.from && x.from.key) {
    const k = x.from.key;
    x.offs = (byKey.get(k) || []).map(m => { const side = m.a === k ? 'A' : 'B';
      // The players in it: what the reporter was to buy (give) and what they were to get.
      const gives = side === 'A' ? m.bGets : m.aGets, gets = side === 'A' ? m.aGets : m.bGets;
      return { id: m.id, due: sideDue(m), partner: side === 'A' ? m.b : m.a, side, told: !!(m['warn' + side] || m['done' + side]), refunded: m['refund' + side] || null,
        note: m.note || null, reported: x.matchId === m.id, buys: names.get(String(gives)) || null, gets: names.get(String(gets)) || null }; });
  }
  // Board reports: every board listing (with its comment link) of the person reported, once per person.
  const offersOf = new Map();
  for (const x of out) if (x.src === 'board' && x.about) {
    const t = String(x.about.key || x.target).toLowerCase();
    if (!offersOf.has(t)) { let l = []; try { l = ((await db.prepare('SELECT id, sport, player, rate, link, ts FROM offers WHERE LOWER(user)=? ORDER BY ts DESC LIMIT 100').bind(t).all()).results) || []; } catch (e) {} offersOf.set(t, l); }
    x.about = { ...x.about, offers: offersOf.get(t) };
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
// Members given Dennis's own matching priority for a while (2026-11-12): { key: untilMs }.
const BOSS_KEY = 'swap_boss_v1';
/* Ratings (Dennis, 2026-11-06). After a swap each side can rate the other
   1-5 stars on the swap page - once per person (they can change it). A
   member's score is their average, pulled toward RATE_PRIOR until they have a
   few ratings. Anyone spamming 1 stars loses rating, and none of their
   ratings count. */
const RATE_PRIOR = 3.5, RATE_PRIOR_N = 10;
/* Swap Score (Dennis, 2026-11-16: "quantity of swaps + rating combined", "99/100 5 stars should be
   higher than 5/5"). 0-100:
   - Stars, 60 pts: the average pulled toward 3.5 as if everyone starts with 10 votes of 3.5, so
     it takes many ratings to get near 5 (100 votes, 99 fives -> 4.86 stars; 5 fives -> 4.0).
     3.5 or less is 0 pts, 5.0 is 60.
   - Swaps, 40 pts: grows quickly at first and slows down (log), full at 500 swaps all time
     (200 for the month board, 60 for the week). */
const SWAPS_FULL = { all: 500, month: 200, week: 60 };
const starScore = (sum, n) => (Number(sum || 0) + RATE_PRIOR * RATE_PRIOR_N) / (Number(n || 0) + RATE_PRIOR_N);
const swapScore = (sum, n, t, per = 'all') => 60 * Math.max(0, Math.min(1, (starScore(sum, n) - 3.5) / 1.5)) + 40 * Math.min(1, Math.log1p(t || 0) / Math.log1p(SWAPS_FULL[per] || 500));
const RL_MIN = 10;   // votes to be ranked on the rating leaderboard
const RATE_ON_MEMBERS = 10, RATE_ON_VOTES = 20;
// Ratings off entirely until the next swap day starts, 3am Alaska Sat Nov 7 (Dennis, 2026-11-06).
const RATE_OFF_UNTIL = Date.UTC(2026, 10, 7, 12);
const ratingsOff = () => Date.now() < RATE_OFF_UNTIL;   // ratings count in matching once 10 members have 20+ ratings each
const RATE_DDL = 'CREATE TABLE IF NOT EXISTS swap_ratings (rater TEXT, ratee TEXT, stars INTEGER, at INTEGER, matchId INTEGER, PRIMARY KEY (rater, ratee))';
const RATE_BLOCK_DDL = 'CREATE TABLE IF NOT EXISTS swap_rate_block (key TEXT PRIMARY KEY, at INTEGER, why TEXT)';
async function ratingScores(db) {
  const out = new Map();
  try {
    await db.prepare(RATE_DDL).run(); await db.prepare(RATE_BLOCK_DDL).run();
    const rows = ((await db.prepare('SELECT ratee, SUM(stars) AS s, COUNT(*) AS n FROM swap_ratings WHERE rater NOT IN (SELECT key FROM swap_rate_block) GROUP BY ratee').all()).results) || [];
    // Ratings only count once enough people have been rated a lot (Dennis, 2026-11-06).
    if (ratingsOff() || rows.filter(r => Number(r.n) >= RATE_ON_VOTES).length < RATE_ON_MEMBERS) return out;
    for (const r of rows) out.set(r.ratee, (Number(r.s) + RATE_PRIOR * RATE_PRIOR_N) / (Number(r.n) + RATE_PRIOR_N));
  } catch (e) {}
  return out;
}
/* Trust levels (member suggestion, 2026-11-11): New, then Trusted at 25+
   trades and 4.5+ stars, then Vet at 100+ trades. A trade is a swap whose
   time has passed and that went ahead for them. Stars are the weighted score
   (pulled toward 3.5 until a member has a few ratings), so 99 fives and a
   four beat four fives. Worked out at most every 30 minutes. */
const TRUST_KEY = 'swap_trust_v5';
/* Swap tags (Dennis, 2026-11-16 rework): by Swap Score, with a floor of swaps and stars for each,
   so a few perfect ratings or lots of swaps with poor ratings can't jump the line:
     Rising   score 50+, 31+ swaps
     Trusted  score 65+, 60+ swaps, 4.3+ stars
     Vet      score 75+, 150+ swaps, 4.5+ stars
     Legend   score 82+, 300+ swaps, 4.6+ stars
   The three best scores (Trusted or better) show 🐐 / 🥈 / 🥉, and Dennis shows Owner.
   Raised 2026-11-27 (a member: "Legend only needs 300 swaps, I do that in a week") - Elite added between Vet and Legend:
     Rising 50+ / 40+ swaps · Trusted 65+ / 100+ / 4.3 · Vet 75+ / 250+ / 4.5 · Elite 78+ / 500+ / 4.6 · Legend 82+ / 1,000+ / 4.7
   Stars here are the pulled-toward-3.5 stars (starScore). */
const trustOf = (t, sc, st) => sc >= 82 && t >= 1000 && st >= 4.7 ? 'legend' : sc >= 78 && t >= 500 && st >= 4.6 ? 'elite' : sc >= 75 && t >= 250 && st >= 4.5 ? 'vet' : sc >= 65 && t >= 100 && st >= 4.3 ? 'trusted' : sc >= 50 && t >= 40 ? 'rising' : 'new';
const TAG_RANK = { new: 0, rising: 1, trusted: 2, vet: 3, elite: 4, legend: 5 };
const TAG_OWNER = 'dennis';
async function tradeCounts(db, since = 0) {
  const now = Date.now(), out = new Map();
  const rows = ((await db.prepare(`SELECT k, COUNT(*) AS n FROM (
      SELECT a AS k FROM swap_matches WHERE dueAt < ?1 AND dueAt >= ?2 AND status NOT IN ('cancelled','cancelling') AND (warnA IS NOT NULL OR doneA IS NOT NULL)
      UNION ALL SELECT b AS k FROM swap_matches WHERE dueAt < ?1 AND dueAt >= ?2 AND status NOT IN ('cancelled','cancelling') AND (warnB IS NOT NULL OR doneB IS NOT NULL)) GROUP BY k`).bind(now, since).all()).results) || [];
  for (const r of rows) out.set(String(r.k), Number(r.n) || 0);
  return out;
}
async function trustMap(env, db) {
  try { const c = JSON.parse((await env.RATEBOARD_KV.get(TRUST_KEY)) || 'null'); if (c && Date.now() - c.at < 30 * 60000) return c.m; } catch (e) {}
  const m = {};
  try {
    await db.prepare(RATE_DDL).run(); await db.prepare(RATE_BLOCK_DDL).run();
    const tc = await tradeCounts(db);
    const rs = ((await db.prepare('SELECT ratee, SUM(stars) AS s, COUNT(*) AS n FROM swap_ratings WHERE rater NOT IN (SELECT key FROM swap_rate_block) GROUP BY ratee').all()).results) || [];
    const sc = new Map(rs.map(r => [String(r.ratee), [Number(r.s), Number(r.n)]]));
    for (const k of new Set([...tc.keys(), ...sc.keys()])) { const t = tc.get(k) || 0, [sum, n] = sc.get(k) || [0, 0], st = starScore(sum, n), pts = swapScore(sum, n, t);
      m[k] = { t, s: Math.round(st * 100) / 100, n, pts: Math.round(pts * 10) / 10, lvl: trustOf(t, pts, st), lv: trustOf(t, pts, st) }; }
    const top = Object.entries(m).filter(([k, v]) => k.toLowerCase() !== TAG_OWNER && TAG_RANK[v.lvl] >= 2).sort((a, b) => b[1].pts - a[1].pts || b[1].t - a[1].t).slice(0, 3);
    top.forEach(([k], i) => { m[k].lv = ['goat', 'silver', 'bronze'][i]; });
    for (const k of Object.keys(m)) if (k.toLowerCase() === TAG_OWNER) m[k].lv = 'owner';
    await env.RATEBOARD_KV.put(TRUST_KEY, JSON.stringify({ at: Date.now(), m }), { expirationTtl: 86400 });
  } catch (e) {}
  return m;
}
/* Spamming 1 stars. Dennis, 2026-11-11: honest 1 stars for partners who
   never opened packs were tripping the old rule (5 one-stars in a day), so a
   1 star now only counts against the rater when the person they rated is
   well rated by everyone else (3+ other ratings averaging 4+ stars).
   Blocked: 5+ ratings given with 60%+ of them such 1 stars, or 4+ in a day. */
async function rateSpam(db, rater) {
  const r = await db.prepare(`SELECT COUNT(*) AS n,
      SUM(CASE WHEN x.stars=1 AND o.n >= 3 AND o.s * 1.0 / o.n >= 4 THEN 1 ELSE 0 END) AS bad,
      SUM(CASE WHEN x.stars=1 AND o.n >= 3 AND o.s * 1.0 / o.n >= 4 AND x.at > ?2 THEN 1 ELSE 0 END) AS bad24
    FROM swap_ratings x LEFT JOIN (SELECT ratee, SUM(stars) AS s, COUNT(*) AS n FROM swap_ratings WHERE rater <> ?1 GROUP BY ratee) o ON o.ratee = x.ratee
    WHERE x.rater = ?1`).bind(rater, Date.now() - 86400000).first();
  const n = Number(r && r.n) || 0, bad = Number(r && r.bad) || 0, bad24 = Number(r && r.bad24) || 0;
  return { n, bad, bad24, spam: (n >= 5 && bad / n >= 0.6) || bad24 >= 4 };
}
async function rateModerate(db, rater) {
  const g = await rateSpam(db, rater);
  if (g.spam) {
    await db.prepare('INSERT OR IGNORE INTO swap_rate_block (key, at, why) VALUES (?, ?, ?)').bind(rater, Date.now(), `${g.bad} of ${g.n} ratings were 1 star for well-rated partners${g.bad24 >= 4 ? `, ${g.bad24} in a day` : ''}`).run();
    await stat(db, 'rate_blocked'); return true;
  }
  return false;
}
// Blocks made under the old rule are checked again; anyone it was unfair to gets rating back.
async function rateRecheck(env, db) {
  await db.prepare(RATE_DDL).run(); await db.prepare(RATE_BLOCK_DDL).run();
  const bl = ((await db.prepare('SELECT key, why FROM swap_rate_block').all()).results) || [];
  let freed = 0;
  for (const b of bl) { if (/well-rated|by admin/i.test(String(b.why || ''))) continue;
    if (!(await rateSpam(db, b.key)).spam) { await db.prepare('DELETE FROM swap_rate_block WHERE key=?').bind(b.key).run(); freed++; } }
  if (freed) { try { await env.RATEBOARD_KV.delete(TRUST_KEY); } catch (e) {} }
  return freed;
}
/* One matching run at a time (2026-11-06): two runs 10 seconds apart (a
   member's save refresh) each made the same swap - Dennis got Pete
   Crow-Armstrong to give twice to one partner. A lock row in D1; the hourly
   run waits for it, a save refresh just skips. */
async function runMatching(db, env, wait = false) {
  await db.prepare('CREATE TABLE IF NOT EXISTS run_lock (k TEXT PRIMARY KEY, until INTEGER)').run();
  for (let i = 0; ; i++) {
    const now = Date.now();
    const c = await db.prepare("INSERT INTO run_lock (k, until) VALUES ('match', ?) ON CONFLICT(k) DO UPDATE SET until=excluded.until WHERE run_lock.until < ?").bind(now + 90000, now).run();
    if (c.meta && c.meta.changes) break;
    if (!wait || i >= 20) { const e = []; e.skipped = true; return e; }
    await sleep(1000);
  }
  try { return await runMatchingInner(db, env); }
  finally { try { await db.prepare("UPDATE run_lock SET until=0 WHERE k='match'").run(); } catch (e) {} }
}
async function runMatchingInner(db, env) {
  // Each step's time is logged as it finishes, so a run that's cut off shows where (2026-11-08).
  const T = [Date.now()], lap = () => { T.push(Date.now()); const n = T.length - 1;
    return db.prepare("INSERT INTO bot_log (at, kind, msg) VALUES (?, 'match', ?)").bind(Date.now(), `step ${n} at ${((T[n] - T[0]) / 1000).toFixed(1)}s`).run().catch(() => {}); };
  // Only members the bot already has a chat with: new chats are capped at
  // five a day, so a match with anyone else might never be delivered.
  await db.prepare(DM_DDL).run();
  try { await db.prepare(RESTRICT_DDL).run(); } catch (e) {}
  try { await db.prepare(SBLOCK_DDL).run(); } catch (e) {}
  try { await db.prepare(DM403_DDL).run(); } catch (e) {}
  try { await matchCols(db); } catch (e) {}
  /* Their swaps not yet warned are called off, and their unwarned 160s, so no
     partner buys packs for someone the bot can't reach. */
  try { const out = new Set((((await db.prepare(DM403_OUT).bind(Date.now() - 86400000).all()).results) || []).map(r => r.key));
    if (out.size) { const res = { n: 0, late: 0, soon: 0 };
      for (const m of (((await db.prepare(`SELECT * FROM swap_matches WHERE status='pending' AND warnA IS NULL AND warnB IS NULL AND dueAt > ?`).bind(Date.now() + 5 * 60000).all()).results) || [])) {
        const who = out.has(String(m.a).toLowerCase()) ? m.a : out.has(String(m.b).toLowerCase()) ? m.b : null;
        if (who) await callOff(db, m, `called off: Real won't let the bot message @${who} right now`, res); }
      for (const r of (((await db.prepare(`SELECT id, seller, buyer FROM swap_160 WHERE status='pending' AND warnS IS NULL AND warnB IS NULL AND dueAt > ?`).bind(Date.now() + 5 * 60000).all()).results) || [])) {
        const who = out.has(String(r.seller).toLowerCase()) ? r.seller : out.has(String(r.buyer).toLowerCase()) ? r.buyer : null;
        if (who) await db.prepare(`UPDATE swap_160 SET status='cancelled', note=? WHERE id=? AND status='pending'`).bind(`called off: Real won't let the bot message @${who} right now`, r.id).run(); }
      if (res.n) await stat(db, 'dm403_calledoff', res.n); } } catch (e) {}
  const users = (await pagedRows(db, `SELECT * FROM swap_users WHERE active=1 AND passes IS NOT NULL
      AND ((wants IS NOT NULL AND wants <> '[]') OR s160=1 OR only160=1 OR nicheIn=1) AND ((slots IS NOT NULL AND slots <> '[]') OR s160=1 OR only160=1)
      AND key NOT IN (SELECT key FROM restricted) AND key NOT IN (SELECT key FROM swap_block)
      AND LOWER(key) NOT IN (SELECT key FROM dm_403 WHERE n >= 3 AND last - first >= 600000 AND last > ${Date.now() - 86400000})
      AND hashId IN (SELECT v.hashId FROM swap_ver v JOIN swap_dm d ON d.hashId = v.hashId WHERE d.channelId IS NOT NULL)`))
    .map(u => ({ ...u, nicheReq: parse(u.niche, {}) || {}, bl: new Set((parse(u.blist, []) || []).map(k => String(k).toLowerCase())), lock1: new Set(parse(u.lock1, []) || []), noSp: parse(u.noSp, {}) || {} }))
    .map(u => ({ ...u, sched: parse(u.sched, null), wants: parse(u.wants, []), keep: new Set(parse(u.keep, [])), touch: new Set(parse(u.touch, [])), slots: parse(u.slots, []),
                 passes: parse(u.passes, []), caps: parse(u.caps, {}) || {} }))
    // Only here for 160s: no swaps for them (their picks are ignored), and they sell.
    // ...but the players they had picked stay theirs: never sold in a 160 (Dennis, 2026-11-08).
    .map(u => u.only160 ? { ...u, wants: [], hold: new Set(u.wants), s160: 1, b160: 0 } : u)
    .map(u => ({ ...u, sellHours: new Set(parse(u.sell160h, []).map(Number)) }));
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
  const recent2d = ((await db.prepare(`SELECT a, b, aGets, bGets, slot, createdAt, dueAt, followA, followB, warnA, warnB, doneA, doneB, status, note FROM swap_matches WHERE createdAt > ?`).bind(Date.now() - 2 * 86400000).all()).results || []);
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
  // Swaps each member gives in, per sport + season and swap day (the 25-a-day limit).
  const gaveSeason = new Map(), giveSeason = (k, w, d) => bump(gaveSeason, `${k}|${seasonOf(w)}|${d}`);
  const seasonRoom = (k, w, d) => (gaveSeason.get(`${k}|${seasonOf(w)}|${d}`) || 0) < SEASON_GIVE_MAX;
  for (const m of open) {
    const d = swapDay(sideDue(m));
    given.add(`${m.b}|${m.aGets}|${d}`); given.add(`${m.a}|${m.bGets}|${d}`);     // B gave aGets, A gave bGets: each pass goes out once a swap day
    giveSeason(m.b, m.aGets, d); giveSeason(m.a, m.bGets, d);
    bump(count, `${m.a}|${d}`); bump(count, `${m.b}|${d}`);
    bump(recv, `${m.a}|${m.aGets}|${d}`); bump(recv, `${m.b}|${m.bGets}|${d}`);
    // Finished swaps are marked (followA/followB) but no longer close the swap day.
  }
  /* A called-off swap only uses up the pass of a side that had already been
     warned (told to buy - they may have bought it). Called off before any
     warning, both passes are free again the same swap day (Dennis, 2026-11-05). */
  /* Swaps from the bot outage (2026-11-19, Dennis: "the players they gave away can't be put in swaps for rest of day"):
     members did them by hand, so both passes count as given that swap day. */
  const BOT_OUT_END = Date.UTC(2026, 10, 19, 16, 30);   // swaps due before the 8am hold (later ones were called off ahead of time)
  const botDown = m => /^called off: the swap bot/.test(m.note || '') && sideDue(m) < BOT_OUT_END;
  for (const m of offTold) { const d = swapDay(sideDue(m));
    if (botDown(m)) { given.add(`${m.b}|${m.aGets}|${d}`); giveSeason(m.b, m.aGets, d); given.add(`${m.a}|${m.bGets}|${d}`); giveSeason(m.a, m.bGets, d); continue; }
    if (m.warnB || m.doneB) { given.add(`${m.b}|${m.aGets}|${d}`); giveSeason(m.b, m.aGets, d); }
    if (m.warnA || m.doneA) { given.add(`${m.a}|${m.bGets}|${d}`); giveSeason(m.a, m.bGets, d); } }
  // Packs a member marked as used today themselves (Packs today tab): not given again this swap day.
  // Those packs were opened too, so they count toward the day's 25 for that sport + season.
  for (const u of users) { const pu = parse(u.packsUsed, null); if (pu && pu.day && Array.isArray(pu.keys)) for (const k of pu.keys) { if (!given.has(`${u.key}|${k}|${pu.day}`)) giveSeason(u.key, k, pu.day); given.add(`${u.key}|${k}|${pu.day}`); } }
  // 160s already made: the seller's pack is given, the buyer's received.
  try { await drop160Held(db, ((await db.prepare(`SELECT * FROM swap_160 WHERE status='pending' AND warnS IS NULL AND dueAt > ?`).bind(Date.now()).all()).results) || []); } catch (e) {}
  let live160 = [];
  try { live160 = ((await db.prepare(`SELECT buyer, seller, pass, dueAt, createdAt, status, warnS, kind, note FROM swap_160 WHERE createdAt > ? AND (status <> 'cancelled' OR warnS IS NOT NULL OR note LIKE 'called off: the swap bot%')`).bind(Date.now() - 2 * 86400000).all()).results) || []; } catch (e) {}
  for (const r of live160) { const d = swapDay(Number(r.dueAt));
    if (r.status === 'cancelled' && /^called off: the swap bot/.test(r.note || '') && Number(r.dueAt) >= BOT_OUT_END) continue;
    if (!given.has(`${r.seller}|${r.pass}|${d}`)) giveSeason(r.seller, r.pass, d);
    given.add(`${r.seller}|${r.pass}|${d}`);
    if (r.status !== 'cancelled') bump(recv, `${r.buyer}|${r.pass}|${d}`); }
  await lap();   // 1: members + swaps read
  // FC and UFC have no packs to swap, so neither is ever offered or matched.
  const swappable = k => !/^(soccer|ufc):/.test(k) && !seasonOff(k);
  // Up to 5 players each, in their order, and only passes they own: they buy cards for those.
  for (const u of users) { const own = new Set(u.passes.filter(p => p.kind !== 'team').map(p => p.key)); u.wants = u.wants.filter(k => swappable(k) && own.has(k)).slice(0, MAX_WANTS); }
  // Players with fewer than MIN_PLAYS (30) collectible plays are never matched, even if picked before the rule.
  const thin = new Set();   // 10-29 plays: only Dennis keeps these
  if (env) { try { const low = await lowPlays(env, db, [...new Set(users.flatMap(u => u.wants))], thin); if (low.size) for (const u of users) u.wants = u.wants.filter(k => !low.has(k) || (String(u.key).toLowerCase() === THIN_OWNER && thin.has(k))); } catch (e) {} }
  for (const u of users) if (String(u.key).toLowerCase() !== THIN_OWNER) u.wants = u.wants.filter(k => !thin.has(k));
  /* Who has given Dennis each thin player, and when it was due: no one gives the same one again within 168 hours.
     A swap counts unless it was called off before the giver was warned (same as the day rule). */
  const thinDue = new Map(), thinAdd = (g, k, t) => (thinDue.get(g + '|' + k) || thinDue.set(g + '|' + k, []).get(g + '|' + k)).push(Number(t) || 0);
  const thinOk = (g, k, due) => !thin.has(k) || !(thinDue.get(g + '|' + k) || []).some(t => Math.abs(due - t) < THIN_GAP_MS);
  if (thin.size) { try { const t0 = Date.now() - 8 * 86400000;
    for (const m of (((await db.prepare(`SELECT a, b, aGets, bGets, dueAt, status, warnA, warnB, doneA, doneB FROM swap_matches WHERE dueAt > ? AND (a = ? OR b = ?)`).bind(t0, THIN_OWNER, THIN_OWNER).all()).results) || [])) {
      const live = !['cancelled', 'cancelling', 'cleared'].includes(m.status);
      if (m.a === THIN_OWNER && thin.has(m.aGets) && (live || m.warnB || m.doneB)) thinAdd(m.b, m.aGets, m.dueAt);
      if (m.b === THIN_OWNER && thin.has(m.bGets) && (live || m.warnA || m.doneA)) thinAdd(m.a, m.bGets, m.dueAt); }
    for (const r of (((await db.prepare(`SELECT seller, pass, dueAt FROM swap_160 WHERE buyer = ? AND dueAt > ? AND (status <> 'cancelled' OR warnS IS NOT NULL)`).bind(THIN_OWNER, t0).all()).results) || []))
      if (thin.has(r.pass)) thinAdd(r.seller, r.pass, r.dueAt);
  } catch (e) {} }
  /* Goal rating, per player they want: how many more swaps that pass can take.
     The counts come from one read of the live swaps, done here in memory
     (2026-11-05: a count query per member per player - hundreds once goals
     went per player - ran matching past its time limit and no swaps were
     made from 22:20 UTC). */
  const recvAt = new Map();
  const recvDue = new Map();
  for (const m of (((await db.prepare("SELECT a, b, aGets, bGets, createdAt, dueAt FROM swap_matches WHERE status IN ('pending','sending','warned','sent')").all()).results) || []))
    for (const [k, w] of [[m.a, m.aGets], [m.b, m.bGets]]) { const kk = k + '|' + w; (recvAt.get(kk) || recvAt.set(kk, []).get(kk)).push(Number(m.createdAt) || 0); (recvDue.get(kk) || recvDue.set(kk, []).get(kk)).push(Number(m.dueAt) || 0); }
  for (const r of live160) if (r.status !== 'cancelled') { const kk = r.buyer + '|' + r.pass; (recvAt.get(kk) || recvAt.set(kk, []).get(kk)).push(Number(r.createdAt) || 0); (recvDue.get(kk) || recvDue.set(kk, []).get(kk)).push(Number(r.dueAt) || 0); }
  const countSince = (k, w, since) => { const t0 = Number(since) || 0; let n = 0; for (const t of (recvAt.get(k + '|' + w) || [])) if (t > t0) n++; return n; };
  // Swaps not yet done (their cards aren't in the pass yet): due after 20 minutes before the fresh read.
  const countAhead = (k, w, at) => { let n = 0; for (const t of (recvDue.get(k + '|' + w) || [])) if (t > at - 20 * 60000) n++; return n; };
  /* A fresh read of each member's passes who has a rating goal on a player they're swapping for
     (Dennis, 2026-11-16: "scan my account right before matching so I don't go over"). One request
     a member (every pass at once), 4 at a time, at most 25 seconds; anyone not read in time keeps
     their last scan. The goal then counts from the pass's rating right now plus swaps still to come. */
  const freshAt = new Map(); let freshMs = 0;
  if (env) { try { const tok = scanTok(env), t0 = Date.now();
    const gl = users.filter(u => u.hashId && u.wants.some(w => Number(u.caps[w] && u.caps[w].g) > 0 || Number(u.goal) > 0)).slice(0, 100);
    let qi = 0, slow = false;
    await Promise.all([0, 1, 2, 3].map(async () => { while (qi < gl.length && !slow && Date.now() - t0 < 25000) { const u = gl[qi++];
      try { const ac = new AbortController(), tm = setTimeout(() => ac.abort(), 6000);
        const r = await fetch(`https://web.realapp.com/userpasses/${encodeURIComponent(u.hashId)}/passes`, { headers: rsHeaders(tok), signal: ac.signal }); clearTimeout(tm);
        if (r.status === 429) { slow = true; break; } if (!r.ok) continue;
        const rt = new Map();
        for (const x of rowsOf(await r.json())) { const e = (x && (x.pass || x.entity)) || x || {};
          const p = passOf(x, String(x.sport || e.sport || '').toLowerCase(), Number(x.season || e.season), String(x.entityType || e.entityType || '').toLowerCase());
          if (p && u.wants.includes(p.key) && p.rating != null) rt.set(p.key, p.rating); }
        for (const p of u.passes) if (rt.has(p.key)) p.rating = rt.get(p.key);
        freshAt.set(u.key, Date.now());
      } catch (e) {} } }));
    freshMs = Date.now() - t0; } catch (e) {} }
  await lap();   // 2: low plays + live swaps read
  const cache = new Map(), goalLeft = new Map();
  // Every season that has a goal set, read at once rather than one after another.
  { const need = new Map(); for (const u of users) for (const w of u.wants) { const g = Number(u.caps[w] && u.caps[w].g) || Number(u.goal); if (g > 0) need.set(String(w).split(':').slice(0, 2).join(':'), w); }
    await Promise.all([...need.values()].map(w => packAvg(db, cache, w).catch(() => null))); }
  for (const u of users) for (const w of u.wants) {
    let left = Infinity;
    try { const g = await goalRoom(db, cache, u, (x, ww) => freshAt.has(x.key) ? countAhead(x.key, ww, freshAt.get(x.key)) : countSince(x.key, ww, x.scannedAt), w); if (g.limited) left = g.left; } catch (e) {}
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
  /* What each member could give, worked out once (2026-11-08: it was rebuilt
     from every pass they hold for every pair and hour - millions of steps
     with members' full pass lists - and matching ran out of time). The
     day-by-day checks are made only for the few players the partner wants. */
  const canGive = new Map(users.map(u => [u.key, new Set(u.passes.filter(p => p.kind !== 'team' && !(p.untouchable && !u.touch.has(p.key))).map(p => p.key).filter(k => swappable(k) && !u.keep.has(k) && !u.wants.includes(k) && !(u.hold && u.hold.has(k))))]));
  const givesOne = (u, k, d) => canGive.get(u.key).has(k) && !given.has(`${u.key}|${k}|${d}`) && seasonRoom(u.key, k, d) && (u.noSp || {})[String(k).split(':')[0]] !== d;
  /* Every possible pair and shared hour, best first: an hour someone picked
     first is their primary, so pairs on both members' earliest picks go
     ahead - when two people want the same player, the one whose primary
     hour it is gets it. */
  /* An hour closes to new matches once its warning has gone out (30 min
     before): the 11:30 run can't add anyone to 12:00, so everyone in an
     hour got the same warning. That hour's next turn is the following day. */
  await lap();   // 3: goals
  const made = [], now = Date.now(), cands = [];
  /* Only the next few hours are filled each run (Dennis, 2026-11-04), in time
     order: the tops of the hour from just after the next warning out to
     MATCH_AHEAD_MS. Each member's schedule says whether (and how high) they
     swap at each one. */
  const dues = [];
  for (let t = Math.floor((now + 30 * 60000) / 3600000) * 3600000 + 3600000; t - now <= MATCH_AHEAD_MS; t += 3600000) if (!noSwapHour(t)) dues.push(t);
  /* Priority members (Dennis picks them on the Swaps page, 2026-11-05): every
     hour they pick counts as their 1st, and their pairs go ahead of everyone
     but Dennis's - so when two people want the same player, they get it. */
  let prio = new Set(); try { prio = new Set((JSON.parse((env && await env.RATEBOARD_KV.get(PRIO_KEY)) || '[]') || []).map(k => String(k).toLowerCase())); } catch (e) {}
  let boss = {}; try { boss = JSON.parse((env && await env.RATEBOARD_KV.get(BOSS_KEY)) || '{}') || {}; } catch (e) {}
  const isBoss = k => Number(boss[String(k).toLowerCase()] || 0) > Date.now();
  const isPrio = k => prio.has(String(k).toLowerCase()), bossOf = k => ADMINS.includes(String(k).toLowerCase()) || isBoss(k) ? 2 : isPrio(k) ? 1 : 0;
  // Every hour a member picks counts the same (Dennis, 2026-11-06: "primary" was too easy to game).
  const ranks = new Map(users.map(u => [u.key, dues.map(t => rankAt(u, t) >= 0 ? 0 : -1)]));
  /* Ratings decide toss-ups (Dennis, 2026-11-06): when two people want the same
     player, the pair with the better ratings goes first. A small random nudge
     each run lets a lower-rated member win some, so they can build a rating. */
  const score = await ratingScores(db);
  // Trusted and Vet members (2026-11-11) get a small edge in toss-ups - a reason to care about their rating.
  let tmM = {}; try { if (env) tmM = await trustMap(env, db); } catch (e) {}
  // The higher the tag, the bigger the edge (Dennis, 2026-11-15): Rising < Trusted < Vet < Legend < 🥉 < 🥈 < 🐐.
  const TAG_EDGE = { owner: 0.5, goat: 0.5, silver: 0.45, bronze: 0.4, legend: 0.35, elite: 0.3, vet: 0.25, trusted: 0.15, rising: 0.05 };
  /* Toss-ups go by Swap Score (2026-11-16): 0-100 shown to members, here /20 (0-5) plus the tag edge.
     Before ratings switch on (score empty), stars stay out and only swaps and the tag count. */
  const rs = k => { const v = tmM[k] || {}; const base = score.size ? (v.pts != null ? v.pts / 20 : (score.get(k) ?? RATE_PRIOR)) : RATE_PRIOR;
    return base + (TAG_EDGE[v.lv] || 0); };
  // Either one has blacklisted the other: never matched - swaps, 160s or niche (2026-11-11).
  const byKey = new Map(users.map(u => [u.key, u]));
  const blocked = (a, b) => { const A = typeof a === 'string' ? byKey.get(a) : a, B = typeof b === 'string' ? byKey.get(b) : b;
    return !!(A && B && ((A.bl && A.bl.has(String(B.key).toLowerCase())) || (B.bl && B.bl.has(String(A.key).toLowerCase())))); };
  for (let i = 0; i < users.length; i++) for (let j = i + 1; j < users.length; j++) {
    const A = users[i], B = users[j];
    if (!A.wants.length || !B.wants.length) continue;
    if (blocked(A, B)) continue;
    const RA = ranks.get(A.key), RB = ranks.get(B.key);
    dues.forEach((due, k) => {
      const ra = RA[k], rb = RB[k]; if (ra < 0 || rb < 0) return;
      cands.push({ A, B, slot: new Date(due).getUTCHours(), due, i, boss: Math.max(bossOf(A.key), bossOf(B.key)), rate: rs(A.key) + rs(B.key) + Math.random() * 1.2 });
    });
  }
  // Dennis (and priority members) first; then the soonest hour; then the better-rated pair.
  cands.sort((x, y) => (y.boss - x.boss) || x.due - y.due || (y.rate - x.rate) || x.i - y.i);
  for (const { A, B, slot, due } of cands) {
    const d = swapDay(due);
    if (!roomFor(A.key, d) || !roomFor(B.key, d)) continue;
    // The same two can swap again, even in the same hour, while each still has a pass the other wants.
    for (;;) {
    if (!roomFor(A.key, d) || !roomFor(B.key, d)) break;
    // The best pair of picks that works both ways (earlier picks first). The
    // exact same pass both ways is no swap; the same player in two seasons is fine.
    const aOk = A.wants.filter(w => givesOne(B, w, d) && thinOk(B.key, w, due) && goalOk(A.key, w) && perDayOk(A.key, w, d)), bOk = B.wants.filter(w => givesOne(A, w, d) && thinOk(A.key, w, due) && goalOk(B.key, w) && perDayOk(B.key, w, d));
    let pick = null;
    for (let s = 0; s < aOk.length + bOk.length && !pick; s++)
      for (let x = 0; x <= s && !pick; x++) { const aw = aOk[x], bw = bOk[s - x]; if (!aw || !bw || aw === bw) continue;
        // A locked pass only goes out for its owner's 1st pick (B gives aw and gets bw; A gives bw and gets aw).
        if (B.lock1 && B.lock1.has(aw) && bw !== B.wants[0]) continue;
        if (A.lock1 && A.lock1.has(bw) && aw !== A.wants[0]) continue;
        pick = [aw, bw]; }
    if (!pick) break;
    const [aGets, bGets] = pick;
    made.push({ a: A.key, b: B.key, aGets, bGets, slot, due });
    if (thin.has(aGets)) thinAdd(B.key, aGets, due); if (thin.has(bGets)) thinAdd(A.key, bGets, due);
    given.add(`${B.key}|${aGets}|${d}`); given.add(`${A.key}|${bGets}|${d}`);
    giveSeason(B.key, aGets, d); giveSeason(A.key, bGets, d);
    bump(count, `${A.key}|${d}`); bump(count, `${B.key}|${d}`);
    bump(recv, `${A.key}|${aGets}|${d}`); bump(recv, `${B.key}|${bGets}|${d}`);
    goalLeft.set(`${A.key}|${aGets}`, (goalLeft.get(`${A.key}|${aGets}`) ?? Infinity) - 1);
    goalLeft.set(`${B.key}|${bGets}`, (goalLeft.get(`${B.key}|${bGets}`) ?? Infinity) - 1);
    }
  }
  /* 160s: what's left after the swaps. Each hour, buyers take turns (one 160
     a turn, Dennis and priority members first, then better ratings) so one
     buyer can't take every seller's pack; each pack goes to the seller with
     the fewest 160s so far that hour. */
  const made160 = [];
  { const sellers = users.filter(u => u.s160), buyers = users.filter(u => u.b160 && u.wants.length);
    if (sellers.length && buyers.length) dues.forEach((due, k) => {
      const d = swapDay(due), slot = new Date(due).getUTCHours();
      // A seller sells at their swap hours, or at the hour(s) they picked for 160s.
      const S = sellers.filter(u => (u.sell160m === 'one' || u.sell160m === 'multi') ? u.sellHours.has(slot) : ranks.get(u.key)[k] >= 0); if (!S.length) return;
      const B = buyers.filter(u => ranks.get(u.key)[k] >= 0).map(u => [u, rs(u.key) + Math.random() * 1.2]).sort((x, y) => (bossOf(y[0].key) - bossOf(x[0].key)) || (y[1] - x[1])).map(x => x[0]);
      const got = new Map(), sold = new Map();
      for (let round = 0; round < MAX_160_HOUR; round++) {
        let any = false;
        for (const b of B) {
          if ((got.get(b.key) || 0) >= MAX_160_HOUR) continue;
          for (const w of b.wants) {
            if (!goalOk(b.key, w) || !perDayOk(b.key, w, d)) continue;
            const can = S.filter(x => x.key !== b.key && !blocked(b, x) && !(x.lock1 && x.lock1.has(w)) && givesOne(x, w, d) && thinOk(x.key, w, due));
            if (!can.length) continue;
            const sl = can.reduce((m, x) => (sold.get(x.key) || 0) < (sold.get(m.key) || 0) ? x : m, can[0]);
            made160.push({ buyer: b.key, seller: sl.key, pass: w, slot, due });
            given.add(`${sl.key}|${w}|${d}`); giveSeason(sl.key, w, d); if (thin.has(w)) thinAdd(sl.key, w, due);
            bump(recv, `${b.key}|${w}|${d}`); goalLeft.set(`${b.key}|${w}`, (goalLeft.get(`${b.key}|${w}`) ?? Infinity) - 1);
            bump(got, b.key); bump(sold, sl.key); any = true; break;
          }
        }
        if (!any) break;
      }
    }); }
  /* Niche players: after swaps and 160s. Each request still short of its number
     is handed, hour by hour, to opted-in members who swap at that hour, don't
     own the player and have room for one more in that season. */
  const madeNiche = [];
  try {
    /* Members only here to sell 160s can buy niche players too (a member,
       2026-11-13): they're available at the hours they sell 160s. */
    const helpers = users.filter(u => u.nicheIn), askers = users.filter(u => u.wants.some(w => u.nicheReq[w] && Number(u.nicheReq[w].n) > 0));
    if (helpers.length && askers.length) {
      const past = ((await db.prepare("SELECT buyer, seller, pass, dueAt, createdAt FROM swap_160 WHERE kind='niche' AND status <> 'cancelled'").all()).results) || [];
      const asked = new Map(), usedBy = new Set(), hourOf = new Map(), dayOf = new Map(), pend = new Map();
      const lim = new Map(helpers.map(h => [h.key, nicheLim(h)]));
      const seas = k => String(k).split(':').slice(0, 2).join(':');
      const note = (b, sl, w, due, at) => { (asked.get(b + '|' + w) || asked.set(b + '|' + w, []).get(b + '|' + w)).push(Number(at) || 0);
        usedBy.add(`${b}|${w}|${sl}`); usedBy.add(`*|${w}|${sl}`); bump(hourOf, `${sl}|${due}`); bump(dayOf, `${sl}|${swapDay(due)}`); };
      for (const r of past) { note(r.buyer, r.seller, r.pass, Number(r.dueAt), r.createdAt); if (Number(r.dueAt) > now - 86400000) bump(pend, `${r.seller}|${seas(r.pass)}`); }
      const owns = new Map(helpers.map(h => [h.key, new Set(h.passes.map(p => p.key))]));
      const held = new Map(helpers.map(h => { const m = new Map(); for (const p of h.passes) if (p.kind !== 'team') bump(m, `${p.sport}:${p.season}`); return [h.key, m]; }));
      const room = (h, w) => (held.get(h.key).get(seas(w)) || 0) + (pend.get(`${h.key}|${seas(w)}`) || 0) < (nicheLiveSeason(w) ? NICHE_LIVE_CAP : NICHE_OLD_CAP);
      dues.forEach((due, k) => {
        const d = swapDay(due), slot = new Date(due).getUTCHours();
        const H = helpers.filter(h => ranks.get(h.key)[k] >= 0 || (h.only160 && h.sellHours && h.sellHours.has(slot))); if (!H.length) return;
        for (const b of askers) {
          if (ranks.get(b.key)[k] < 0) continue;
          for (const w of b.wants) {
            const q = b.nicheReq[w]; if (!q || !(Number(q.n) > 0)) continue;
            let left = Math.min(NICHE_MAX_ASK, Number(q.n)) - (asked.get(b.key + '|' + w) || []).filter(t => t >= (Number(q.at) || 0)).length;
            while (left > 0) {
              if (!goalOk(b.key, w) || !perDayOk(b.key, w, d)) break;
              const can = H.filter(h => h.key !== b.key && !blocked(b, h) && !owns.get(h.key).has(w) && !usedBy.has(`*|${w}|${h.key}`) && (hourOf.get(`${h.key}|${due}`) || 0) < lim.get(h.key).h
                && (dayOf.get(`${h.key}|${d}`) || 0) < lim.get(h.key).d && room(h, w) && seasonRoom(h.key, w, d) && thinOk(h.key, w, due));
              if (!can.length) break;
              const h = can.reduce((m, x) => (dayOf.get(`${x.key}|${d}`) || 0) < (dayOf.get(`${m.key}|${d}`) || 0) ? x : m, can[Math.floor(Math.random() * can.length)]);
              madeNiche.push({ buyer: b.key, seller: h.key, pass: w, slot, due }); if (thin.has(w)) thinAdd(h.key, w, due);
              note(b.key, h.key, w, due, now); bump(pend, `${h.key}|${seas(w)}`); giveSeason(h.key, w, d);
              bump(recv, `${b.key}|${w}|${d}`); goalLeft.set(`${b.key}|${w}`, (goalLeft.get(`${b.key}|${w}`) ?? Infinity) - 1);
              left--;
            }
          }
        }
      });
    }
  } catch (e) { await botFail(db, 'matching', `niche: ${e.message}`); }
  await lap();   // 4: pairing
  // Never the same swap twice on one swap day, even if two runs overlap: checked against the
  // live swaps read at the start (in memory), then saved 50 at a time.
  try { await alterOnce(db, 'ALTER TABLE swap_matches ADD COLUMN dueAt INTEGER'); } catch (e) {}
  const sig = (a, b, ag, bg, d) => a < b ? `${a}|${b}|${ag}|${bg}|${d}` : `${b}|${a}|${bg}|${ag}|${d}`;
  // Read again right before saving (not the copy from the start of the run).
  /* Swaps called off while the bot was down count as done for this (2026-11-19, js4: "it's tryna get me to swap a lot of
     people that I already did earlier" - members swapped them by hand). */
  const fresh = ((await db.prepare(`SELECT a, b, aGets, bGets, slot, createdAt, dueAt FROM swap_matches WHERE createdAt > ? AND (status IN ('pending','sending','warned','sent') OR (status IN ('cancelled','cancelling') AND note LIKE 'called off: the swap bot%' AND dueAt < ?))`).bind(Date.now() - 2 * 86400000, Date.now()).all()).results) || [];
  const seen = new Set(fresh.map(x => sig(x.a, x.b, x.aGets, x.bGets, swapDay(sideDue(x)))));
  const ins = [];
  for (const m of made) { const k = sig(m.a, m.b, m.aGets, m.bGets, swapDay(m.due)); if (seen.has(k)) continue; seen.add(k);
    ins.push(db.prepare(`INSERT INTO swap_matches (a, b, aGets, bGets, slot, createdAt, status, dueAt) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`).bind(m.a, m.b, m.aGets, m.bGets, m.slot, now, m.due)); }
  for (let i = 0; i < ins.length; i += 50) await db.batch(ins.slice(i, i + 50));
  // The 160s: never the same buyer, seller and pass twice on one swap day.
  { const sig1 = (b, s0, p, d) => `${b}|${s0}|${p}|${d}`, seen1 = new Set(live160.filter(r => (r.status !== 'cancelled' || /^called off: the swap bot/.test(r.note || '')) && r.kind !== 'niche').map(r => sig1(r.buyer, r.seller, r.pass, swapDay(Number(r.dueAt)))));
    const ins1 = [];
    for (const m of made160) { const k = sig1(m.buyer, m.seller, m.pass, swapDay(m.due)); if (seen1.has(k)) continue; seen1.add(k);
      ins1.push(db.prepare(`INSERT INTO swap_160 (buyer, seller, pass, slot, dueAt, createdAt, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')`).bind(m.buyer, m.seller, m.pass, m.slot, m.due, now)); }
    try { for (let i = 0; i < ins1.length; i += 50) await db.batch(ins1.slice(i, i + 50)); } catch (e) { await botFail(db, 'matching', `160s not saved: ${e.message}`); }
    made.n160 = ins1.length; }
  if (madeNiche.length) { try { const insN = madeNiche.map(m => db.prepare(`INSERT INTO swap_160 (buyer, seller, pass, slot, dueAt, createdAt, status, kind) VALUES (?, ?, ?, ?, ?, ?, 'pending', 'niche')`).bind(m.buyer, m.seller, m.pass, m.slot, m.due, now));
      for (let i = 0; i < insN.length; i += 50) await db.batch(insN.slice(i, i + 50)); made.nNiche = insN.length; } catch (e) { await botFail(db, 'matching', `niche not saved: ${e.message}`); } }
  await lap();   // 5: saved
  made.timing = `${made.n160 || 0} 160s, ${made.nNiche || 0} niche, members ${users.length}, goal scans ${freshAt.size} in ${freshMs}ms, read ${T[1] - T[0]}ms, plays ${T[2] - T[1]}ms, goals ${T[3] - T[2]}ms, pairing ${T[4] - T[3]}ms, save ${T[5] - T[4]}ms`;
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
/* Stop switch (Dennis, 2026-11-19 07:27 AK emergency stop): no bot DMs at all while the swaps hold is on. It's set
   from KV each tick, and comes off by itself once the hold lifts (Real accepts the bot again, checked twice, or
   a new RS_SWAP_TOKEN). */
let DM_STOP = false;
const DM_DDL = `CREATE TABLE IF NOT EXISTS swap_dm (hashId TEXT PRIMARY KEY, userName TEXT, channelId INTEGER, openedAt INTEGER)`;
/* Verified (Dennis, 2026-11-27): only members who tapped "I sent it - check" and had a chat with the current bot.
   Any chat used to count, so @rax.academy's old chats from its market-account days all counted at the switch. */
const VER_DDL = 'CREATE TABLE IF NOT EXISTS swap_ver (hashId TEXT PRIMARY KEY, key TEXT, at INTEGER)';

async function dmChannel(db, auth, hashId, userName, env) {
  await db.prepare(DM_DDL).run();
  const had = await db.prepare('SELECT channelId FROM swap_dm WHERE hashId=?').bind(hashId).first();
  if (had && had.channelId) return had.channelId;
  if (!env || !(await newChatAllowed(env))) throw new Error('no chat with this member yet and today\'s 5 new chats are used - ask them to message @rax.academy');
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
/* Members Real won't let the bot message (2026-11-12: 200+ "Cannot message
   this channel right now" refusals in a day, and swaps where one side never
   got a warning or contact). Three refusals in a row over 10+ minutes keeps
   them out of matching for a day; any message that goes through clears it. */
const DM403_DDL = 'CREATE TABLE IF NOT EXISTS dm_403 (key TEXT PRIMARY KEY, n INTEGER, first INTEGER, last INTEGER)';
async function dm403(db, who, failed) {
  try { await db.prepare(DM403_DDL).run(); const k = String(who || '').toLowerCase(); if (!k) return;
    if (!failed) { await db.prepare('DELETE FROM dm_403 WHERE key=?').bind(k).run(); return; }
    const t = Date.now();
    await db.prepare('INSERT INTO dm_403 (key, n, first, last) VALUES (?, 1, ?, ?) ON CONFLICT(key) DO UPDATE SET n=n+1, last=excluded.last').bind(k, t, t).run(); } catch (e) {}
}
const DM403_OUT = `SELECT key FROM dm_403 WHERE n >= 3 AND last - first >= 600000 AND last > ${'?'}`;
async function botFail(db, kind, msg) {
  try { await botTables(db); await stat(db, 'fail');
    await db.prepare('INSERT INTO bot_log (at, kind, msg) VALUES (?, ?, ?)').bind(Date.now(), kind, String(msg || '').slice(0, 300)).run();
    if (Math.random() < 0.05) await db.prepare('DELETE FROM bot_log WHERE at < ?').bind(Date.now() - 14 * 86400000).run(); } catch (e) {}
}

// A send that waits and tries again when Real is busy (429) or hiccups (5xx).
async function dmSendRetry(auth, channelId, text, prio = 2) {
  if (DM_STOP) throw new Error('DMs stopped (emergency stop)');
  let last;
  for (const wait of [0, 2500, 6000]) {
    if (wait) await sleep(wait);
    try { return await dmSend(auth, channelId, text, prio); } catch (e) { last = e; if (!/send (429|5\d\d)/.test(String(e.message || e))) throw e; }
  }
  throw last;
}
/* Parts that still wouldn't go: kept in order and sent again each minute
   (tick) until they do, for up to an hour. */
/* At :30 and :00 the bot has a lot to send (an hour can hold 180 swaps and
   50+ people). It sends up to 20 messages a minute, and pass scans stay off
   the bot from :25 to :40 and :55 to :10 so Real doesn't throttle it while
   the warnings and contacts go out. */
const DM_PER_TICK = 60;   // a cap per run; time is the real limit
const CANCEL_DM_ON = false;   // called-off notices (Dennis, 2026-11-04: too many extra DMs) - flip to bring them back   // Real's message slowmode: 10, then the rest of the minute off
const dmWindow = (t = new Date()) => { const m = t.getUTCMinutes(); return (m >= 25 && m < 40) || m >= 50 || m < 10; };
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
  // A second look more than 25 minutes overdue is dropped (its swap is past) - 2026-11-12.
  await db.prepare('DELETE FROM dm_verify WHERE checkAt < ?').bind(Date.now() - 10 * 60000).run();
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
  /* Swap messages first; notices (moderation, top-15, unban, scan done) after
     them, so a batch of notices never holds up a swap warning (2026-11-12).
     A swap message more than 25 minutes old is dropped instead - by then its
     swap is minutes away or past, and a late one just confuses. */
  const LOW = /^(mod|top15|unban|scan done)\b/;
  const all = ((await db.prepare('SELECT * FROM dm_retry ORDER BY id LIMIT 60').all()).results) || [];
  for (const r of all) if (!LOW.test(String(r.label || '')) && Date.now() - Number(r.at || 0) > 15 * 60000) {
    await db.prepare('DELETE FROM dm_retry WHERE id=?').bind(r.id).run(); await botFail(db, 'dm_retry', `${r.label}: dropped, over 15 minutes late`); }
  const rows = all.filter(r => LOW.test(String(r.label || '')) || Date.now() - Number(r.at || 0) <= 15 * 60000)
    .sort((a, b) => (LOW.test(String(a.label || '')) ? 1 : 0) - (LOW.test(String(b.label || '')) ? 1 : 0) || a.id - b.id).slice(0, 20);
  const usedCh = new Set();
  for (const r of rows) {
    if (usedCh.has(Number(r.channelId))) continue;   // that chat already got a message this minute
    if (TICK_T0 && tickLeft() < 14000) break;   // leave the rest of the minute for the swaps' own DMs
    if (LOW.test(String(r.label || '')) && dmWindow()) continue;   // notices wait out the :25-:40 / :55-:10 swap rush
    let parts = parse(r.parts, []);
    parts = parts.flatMap(fitDm);   // queued before the length fix: cut down to size
    usedCh.add(Number(r.channelId));
    try { await dmSendRetry(auth, r.channelId, parts[0], /^(warn|contact)\b/.test(String(r.label || '')) ? 0 : 2); parts.shift(); await stat(db, 'dm_retried'); await sleep(400); }
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
/* On the droplet every message shares one line through one process, so it's a
   priority line (2026-11-13: confirm, 160 and resend messages queued ahead
   held the swap warnings and swap DMs back 10-25 minutes). Swap warnings and
   swap DMs (0) go before 160s (1), and those before everything else (2) -
   still one message every 3 seconds. */
const PQ = []; let pqBusy = false;
function pqPump() {
  if (pqBusy) return; pqBusy = true;
  (async () => { try { while (PQ.length) { const w = dmNextAt - Date.now(); if (w > 0) await sleep(w);
    PQ.sort((a, b) => a.p - b.p || a.t - b.t); const x = PQ.shift(); dmNextAt = Date.now() + DM_GAP_MS; x.go(); } } finally { pqBusy = false; if (PQ.length) pqPump(); } })();
}
const dmWaitAhead = () => ON_DROPLET ? 0 : Math.max(0, dmNextAt - Date.now());
async function dmPace(prio = 2) {
  if (ON_DROPLET) return new Promise(go => { PQ.push({ p: prio, t: Date.now(), go }); pqPump(); });
  const t = Date.now(), at = Math.max(t, dmNextAt); dmNextAt = at + DM_GAP_MS; if (at > t) await sleep(at - t);
}
let LAST_SWAP_DM = 0;   // last swap DM sent (anything but the giveaway's prio 9), for the giveaway's quiet gaps
async function dmSend(auth, channelId, text, prio = 2) {
  if (DM_STOP) throw new Error('DMs stopped (emergency stop)');
  await dmPace(prio); if (prio < 9) LAST_SWAP_DM = Date.now();
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
      if (found.channel) { try { await dmSend(auth, found.channel, 'Code confirmed; password reset available on https://raxacademy.app/board'); await stat(db, 'dm_reset'); } catch (e) { await botFail(db, 'dm_reset', e.message); } }
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


/* ---- Drafts (Dennis, 2026-11-15) ------------------------------------------
   Real's "player rating contests": pick 5 players, each slot multiplies his
   Real rating (2.0, 1.8, 1.6, 1.4, 1.2). Daily sport drafts also give some
   players a bonus that adds to the slot (+2.4x in the 2.0x slot = 4.4x);
   game drafts have no bonus. Goal: the highest total rating.
   Contests come from a saved list (found by drafts discovery, or added by an
   admin from a Real link); each one's player pool is read on account 1 and
   kept 10 minutes. Ratings are projected from the game log's Real rating. */
const DRAFT_LIST_KV = 'draft_contests_v1';
const BULK_MEMO = { text: null, at: 0, building: null };   // Bulk ratings' shared data, per server process
// The first two, from the links Dennis sent (2026-11-15).
const DRAFT_SEED = [{ id: 2460, type: 'sport', sport: 'nfl', day: '2026-11-16' }, { id: 55724, type: 'game', sport: 'nfl', day: '2026-11-16', gameId: 19603, post: 'https://www.realapp.com/YDiptOFGvRM', title: 'Ravens @ Chargers' }];
async function draftList(env) { try { const v = await env.RATEBOARD_KV.get(DRAFT_LIST_KV); return v ? (JSON.parse(v) || []) : DRAFT_SEED.slice(); } catch (e) { return []; } }
async function draftSaveList(env, l) { await env.RATEBOARD_KV.put(DRAFT_LIST_KV, JSON.stringify(l.slice(-1500))); }
async function draftInfo(env, id, type) {
  const tok = env.RS_AUTH_TOKEN; if (!tok) return null;
  const r = await fetch(`https://web.realapp.com/games/playerratingcontest/${id}/draftinfo?contestType=${type}`, { headers: rsHeaders(tok) });
  if (!r.ok) return { status: r.status };
  const d = await r.json().catch(() => null); return d && d.info ? { status: 200, info: d.info } : { status: 0 };
}
// Best 5 for a pool: a player's worth in a slot = projected rating x (slot + his bonus).
// Highest projection gets the highest slot (the bonus doesn't depend on the slot), so pick by DP over players sorted by projection.
function draftBest(players, slots) {
  const c = players.filter(p => p.proj != null && !p.out).sort((a, b) => b.proj - a.proj), K = slots.length;
  const dp = Array.from({ length: c.length + 1 }, () => Array(K + 1).fill(-Infinity)), take = Array.from({ length: c.length + 1 }, () => Array(K + 1).fill(false));
  for (let i = 0; i <= c.length; i++) dp[i][0] = 0;
  for (let i = 1; i <= c.length; i++) for (let k = 1; k <= K; k++) {
    const skip = dp[i - 1][k], use = dp[i - 1][k - 1] + c[i - 1].proj * (slots[k - 1] + (c[i - 1].bonus || 0));
    if (use > skip) { dp[i][k] = use; take[i][k] = true; } else dp[i][k] = skip; }
  const pick = []; for (let i = c.length, k = K; i > 0 && k > 0; i--) if (take[i][k]) { pick.unshift(c[i - 1]); k--; }
  return { score: dp[c.length][K] === -Infinity ? null : dp[c.length][K], lineup: pick.map((p, j) => ({ ...p, slot: slots[j], mult: Math.round((slots[j] + (p.bonus || 0)) * 10) / 10, pts: Math.round(p.proj * (slots[j] + (p.bonus || 0)) * 10) / 10 })) };
}
async function draftBuild(env, db, c) {
  const K = `draft_v1_${c.type}_${c.id}`;
  try { const x = JSON.parse((await env.RATEBOARD_KV.get(K)) || 'null'); if (x && Date.now() - x.at < 10 * 60000) return x; } catch (e) {}
  const tok = env.RS_AUTH_TOKEN; if (!tok) return { error: 'No account 1 token.' };
  const di = await draftInfo(env, c.id, c.type); if (!di || di.status !== 200) return { error: `Real didn't give the draft (${di && di.status}).` };
  const info = di.info, sp = info.sport || c.sport, gameId = info.gameId || c.gameId || null;
  const slots = (Array.isArray(info.defaultMultipliers) && info.defaultMultipliers.length ? info.defaultMultipliers : [2, 1.8, 1.6, 1.4, 1.2]).map(Number).slice(0, info.lineupSize || 5);
  /* The player pool. Real's list stops at 50, but its search (query=) finds players by the
     start of a first or last name - so each letter a-z is searched (two letters where one
     letter fills 50) and everything found is put together (2026-11-16). Kept 6 hours. */
  const PK = `draft_pool_v1_${c.type}_${c.id}`;
  let pool = null; try { const pc = JSON.parse((await env.RATEBOARD_KV.get(PK)) || 'null'); if (pc && Date.now() - pc.at < 6 * 3600000) pool = pc.pool; } catch (e) {}
  if (!pool) {
    const base = `https://web.realapp.com/players/sport/${sp}/search?contestId=${c.id}${gameId ? '&gameId=' + gameId : ''}&includeNoOneOption=false&searchType=ratingLineup`;
    const got = new Map(), ask = async q => { await sleep(700); const r = await fetch(base + (q ? '&query=' + encodeURIComponent(q) : ''), { headers: rsHeaders(tok) });
      if (!r.ok) throw new Error(`Real didn't give the players (${r.status}).`); const ps = (((await r.json().catch(() => ({}))) || {}).players) || []; for (const p of ps) got.set(Number(p.id), p); return ps.length; };
    try {
      if (await ask('') >= 50) {
        for (const a of 'abcdefghijklmnopqrstuvwxyz') if (await ask(a) >= 50) for (const b of 'abcdefghijklmnopqrstuvwxyz') await ask(a + b);
      }
    } catch (e) { if (!got.size) return { error: String(e.message || e) }; }
    pool = [...got.values()];
    try { await env.RATEBOARD_KV.put(PK, JSON.stringify({ at: Date.now(), pool }), { expirationTtl: 86400 }); } catch (e) {}
  }
  // The contest's post on Real, for "Open in Real" (Real's code 7: [7, sport, 0, postId]).
  let post = c.post || null;
  if (!post) { try { await sleep(1000); const rv = await fetch(`https://web.realapp.com/games/playerratingcontest/${c.id}?contestType=${c.type}`, { headers: rsHeaders(tok) });
    const v = rv.ok ? await rv.json().catch(() => null) : null, pid = v && v.info && v.info.contest && v.info.contest.postId;
    if (pid && REAL_SPORT[sp]) post = `https://www.realapp.com/${routeId([7, REAL_SPORT[sp][1], 0, Number(pid)])}`; } catch (e) {} }
  // Projected Real rating: last 5 games weighted with the season, from the game log; last season if no games yet.
  const [se, prev] = PROJ_SEASON[sp] || [null, null], ids = pool.map(p => Number(p.id)).filter(Number.isFinite), by = new Map(), old = new Map();
  const minSp = sp === 'nba' || sp === 'ncaam' || sp === 'wnba' || sp === 'soccer', foot = sp === 'nfl' || sp === 'ncaaf';
  const played = x => (!minSp || x.min == null || Number(x.min) > 0) && !(foot && !x.stats && !(Number(x.rax) > 0));
  for (let i = 0; i < ids.length; i += 90) { const part = ids.slice(i, i + 90), ph = part.map(() => '?').join(',');
    for (const [s0, m] of [[se, by], [prev, old]]) { if (!s0) continue;
      try { for (const x of (((await db.prepare(`SELECT playerId, day, rating, min, rax${foot ? ', stats' : ''} FROM gamelog WHERE sport=? AND season=? AND rating IS NOT NULL AND COALESCE(seasonType, 'regularseason') <> 'preseason' AND playerId IN (${ph}) ORDER BY day`).bind(sp, s0, ...part).all()).results) || []))
        if (played(x)) (m.get(Number(x.playerId)) || m.set(Number(x.playerId), []).get(Number(x.playerId))).push(Number(x.rating)); } catch (e) {} } }
  const avg = a => a.length ? a.reduce((t, v) => t + v, 0) / a.length : null;
  const players = pool.map(p => { const g = by.get(Number(p.id)) || [], o = old.get(Number(p.id)) || [];
    let proj = null, basis = '';
    if (g.length >= 3) { proj = 0.6 * avg(g.slice(-5)) + 0.4 * avg(g); basis = `last 5 weighted, ${g.length} games`; }
    else if (g.length) { proj = o.length ? 0.5 * avg(g) + 0.5 * avg(o) : avg(g); basis = `${g.length} game${g.length === 1 ? '' : 's'}${o.length ? ' + last season' : ''}`; }
    else if (o.length) { proj = avg(o) * 0.9; basis = 'last season'; }
    const st = String(p.injuryStatus || '');
    const out = /^(out|injured|ir|suspend|doubtful)/i.test(st);
    if (proj != null && /question|day-to-day/i.test(st)) proj *= 0.9;
    return { id: Number(p.id), name: `${p.firstName || ''} ${p.lastName || ''}`.trim() || p.displayName, team: (p.team && p.team.key) || '', pos: p.position || '', status: st || null, out,
      bonus: Number(p.multiplierBonus) || 0, proj: proj == null ? null : Math.round(proj * 100) / 100, games: g.length, basis, url: playerUrl(`${sp}:${se}:${p.id}`) }; });
  const best = draftBest(players, slots);
  const x = { at: Date.now(), id: c.id, type: c.type, sport: sp, day: info.day || c.day, slots, entered: !!info.isEntered, best, players: players.sort((a, b) => (b.proj ?? -1) - (a.proj ?? -1)), post, gameId,
    teams: [...new Set(pool.map(p => p.team && p.team.key).filter(Boolean))].slice(0, 2) };
  try { await env.RATEBOARD_KV.put(K, JSON.stringify(x), { expirationTtl: 3 * 86400 }); } catch (e) {}
  return x;
}
/* Daily sport drafts are numbered in order: once an hour, read the next few
   numbers past the last one known and add any that exist (a handful of reads a day). */
// One-off check (2026-11-16): build one draft now and keep the result's size.
export async function draftGap(env) {
  if (await env.RATEBOARD_KV.get('draft_gap_1116')) return; await env.RATEBOARD_KV.put('draft_gap_1116', '1', { expirationTtl: 86400 });
  const out = [];
  for (const id of [55767, 55770, 55780, 55800, 55850, 55900, 56000, 56200, 56500, 57000, 58000, 60000, 65000, 70000]) {
    await sleep(1500); const d = await draftInfo(env, id, 'game').catch(() => null); out.push(`${id}:${d ? d.status : 'x'}${d && d.info ? ':' + d.info.sport + ':' + d.info.day : ''}`); }
  await env.RATEBOARD_KV.put('draft_gap_1116_r', JSON.stringify(out), { expirationTtl: 86400 });
}
export async function draftCheck(env) {
  if (await env.RATEBOARD_KV.get('draft_check_1116')) return; await env.RATEBOARD_KV.put('draft_check_1116', '1', { expirationTtl: 86400 });
  const t0 = Date.now(); let x = null; try { x = await draftBuild(env, env.RATEBOARD_DB, { id: 2466, type: 'sport', sport: 'nhl', day: '2026-11-16' }); } catch (e) { x = { error: String(e.message || e) }; }
  await env.RATEBOARD_KV.put('draft_check_1116_r', JSON.stringify({ ms: Date.now() - t0, err: x.error || null, n: x.players && x.players.length, teams: x.players ? [...new Set(x.players.map(p => p.team))].join(' ') : null, score: x.best && x.best.score, lineup: x.best && x.best.lineup.map(p => `${p.name} ${p.proj}x${p.mult}=${p.pts}`) }), { expirationTtl: 86400 });
}
/* Scans first (Dennis, 2026-11-17): Real answers "high volume" 429s at busy times, and every call the server
   makes shares the allowance. While a member's scan is running, or for 3 minutes after a scan was refused,
   the background collectors (Bulk listings, FC game log, game drafts) wait. Predictions is left alone. */
export async function realBusy(env) {
  try { const t = Number(await env.RATEBOARD_KV.get('real_busy_at')) || 0; if (Date.now() - t < 3 * 60000) return true; } catch (e) {}
  try { const q = await env.RATEBOARD_DB.prepare('SELECT COUNT(*) AS n FROM scan_queue WHERE startedAt IS NOT NULL').first(); return !!(q && q.n > 0); } catch (e) { return false; }
}
// The same, but a collector never waits more than maxMs in a row (so Bulk deals and FC data don't go stale).
export async function realWait(env, name, maxMs = 15 * 60000) {
  const k = 'real_last_go_' + name; let last = 0; try { last = Number(await env.RATEBOARD_KV.get(k)) || 0; } catch (e) {}
  if (Date.now() - last < maxMs && await realBusy(env)) return true;
  try { await env.RATEBOARD_KV.put(k, String(Date.now()), { expirationTtl: 86400 }); } catch (e) {}
  return false;
}
async function portToBets(env, who = 'dennis') {
  let x = {}, l = [], ev = {}; try { x = JSON.parse((await env.RATEBOARD_KV.get('pred_port_v1' + (who === 'dennis' ? '' : '_' + who))) || '{}') || {}; l = JSON.parse((await env.RATEBOARD_KV.get('pred_bets_v1_' + who)) || '[]') || []; ev = JSON.parse((await env.RATEBOARD_KV.get('pred_ev_v1')) || '{}') || {}; } catch (e) { return null; }
  let upd = 0, add = 0; const seen = new Set();
  for (const p of (x.pos || [])) { if (p.settled || !(p.cost > 0) || !(p.pays > 0)) continue;
    const g = (ev.games || []).find(y => y.id === p.marketId), si = p.si >= 0 ? p.si : -1; if (si < 0) continue;
    seen.add(p.marketId + ':' + si);
    const price = Math.round(p.cost / p.pays * 1e4) / 1e4, b = l.find(y => y.gid === p.marketId && y.side === si && !y.res);
    if (b) { if (Math.abs((b.amt || 0) - p.cost) > 0.5 || b.pay == null || Math.abs(b.pay - p.pays) > 0.5) { b.amt = Math.round(p.cost * 100) / 100; b.pay = Math.round(p.pays * 100) / 100; b.price = price; b.real = true; upd++; } else b.real = true; }
    else { const sd = g && g.sides[si];
      l.unshift({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), gid: p.marketId, side: si, sport: p.sport || (g && g.sport) || '', game: (g && g.game) || p.game || '', name: (sd && (sd.name || sd.label)) || p.team || '',
        price, fair: 0, ev: p.evIn || 0, u: 0, amt: Math.round(p.cost * 100) / 100, pay: Math.round(p.pays * 100) / 100, teams: g ? g.sides.map(y => y.name || y.label) : [], start: (g && g.start) || '', logo: (sd && sd.logo) || '', at: Date.now(), real: true, fromReal: true }); add++; } }
  let off = 0; for (const b of l) if (!b.res && !b.custom && b.gid > 0 && !seen.has(b.gid + ':' + b.side)) { if (!b.notOnReal) off++; b.notOnReal = true; } else if (b.notOnReal && seen.has(b.gid + ':' + b.side)) delete b.notOnReal;
  await env.RATEBOARD_KV.put('pred_bets_v1_' + who, JSON.stringify(l.slice(0, 300)));
  return { updated: upd, added: add, notOnReal: l.filter(b => b.notOnReal && !b.res).length };
}
export async function draftScan(env) {
  if (await realWait(env, 'draft', 40 * 60000)) return;
  const tok = env.RS_AUTH_TOKEN; if (!tok) return;
  const k = 'draft_scan_v2'; let last = 0; try { last = Number(await env.RATEBOARD_KV.get(k)) || 0; } catch (e) {}
  if (Date.now() - last < 20 * 60000) return; await env.RATEBOARD_KV.put(k, String(Date.now()));   // every 20 minutes (new game drafts show up through the day)
  const l = await draftList(env);
  let top = Math.max(2459, ...l.filter(c => c.type === 'sport').map(c => c.id)), miss = 0;
  for (let id = top + 1; miss < 3 && id < top + 25; id++) {
    const d = await draftInfo(env, id, 'sport').catch(() => null); await sleep(4000);
    if (!d || d.status !== 200) { miss++; continue; }
    miss = 0; if (!l.some(c => c.type === 'sport' && c.id === id)) l.push({ id, type: 'sport', sport: d.info.sport, day: d.info.day, endDay: d.info.endDay || null, added: Date.now() });
  }
  /* Game drafts, every sport. They're numbered in order but made in batches days ahead, so
     numbers don't follow game days (2026-11-16: 55724 was Monday's, 55725-55764 Saturday's).
     So: find the newest number that exists (jumping ahead, then halving), then read back from
     it until a long run of drafts for days already past - that picks up today's and the coming
     days'. After the first catch-up only new numbers are read. Spaced 1.5 seconds. */
  const etd0 = d => ET_DAY_FMT.format(d), today0 = etd0(new Date());
  const ex = async id => { await sleep(1500); const d = await draftInfo(env, id, 'game').catch(() => null); return d && d.status === 200 ? d : null; };
  const add = (id, d) => { if (!l.some(c => c.type === 'game' && c.id === id)) l.push({ id, type: 'game', sport: d.info.sport, day: d.info.day, gameId: d.info.gameId || null, added: Date.now() }); };
  /* The numbers have gaps (2026-11-16: nothing from 55767 to 55799, then 55800 on), so: look
     ahead every 10 numbers until 12 in a row (120 numbers) are empty, then read every number up
     to the last one found. "dk" is the furthest number already read one by one. */
  const FK = 'draft_gdone_v1'; let done = Number(await env.RATEBOARD_KV.get(FK)) || Math.max(55724, ...l.filter(c => c.type === 'game').map(c => c.id));
  let lastHit = done, emptyRun = 0, t = done, reads = 0;
  while (emptyRun < 12 && reads < 60) { t += 10; reads++; if (await ex(t)) { lastHit = t; emptyRun = 0; } else emptyRun++; }
  let dense = 0;
  for (let id = done + 1; id <= lastHit + 9 && dense < 450; id++) { dense++; const d = await ex(id); if (d) add(id, d); done = id; }
  await env.RATEBOARD_KV.put(FK, String(done));
  // Old games off the list (a week back), so it stays small.
  const wk = etd0(new Date(Date.now() - 7 * 86400000));
  for (let k = l.length - 1; k >= 0; k--) if (l[k].type === 'game' && l[k].day && l[k].day < wk) l.splice(k, 1);
  await draftSaveList(env, l);
  // Build today's and tomorrow's ahead, so the page opens fast.
  const etd = d => ET_DAY_FMT.format(d), days = [etd(new Date()), etd(new Date(Date.now() + 86400000))];
  const newest = new Map(); for (const c of l.filter(c => c.type === 'sport' && days.includes(c.day))) { const k = c.sport + c.day; if (!newest.has(k) || newest.get(k).id < c.id) newest.set(k, c); }
  for (const c of newest.values()) { try { await draftBuild(env, env.RATEBOARD_DB, c); } catch (e) {} await sleep(3000); }
}
/* Real's own link codes (hashids, salt 'routing', min length 11): a player is
   [2, sport code, 0, id], a pass is [18, 0, 0, passId]. */
/* Board auto-moderation (Dennis, 2026-11-27: "I want the moderation to be automatic").
   Every listing's comment is read on Real - comments/news/{post}/replies/{comment}?limit=1 gives the
   comment itself as parentComment. A deleted comment (deletedAt set, or gone) or one with replies
   turned off means sellers can't reach the buyer, so the listing comes down and the buyer gets a
   note. A comment posted by someone other than the listing's owner is only flagged for Dennis.
   New listings are read first, then each one again every 3 hours. A few a minute on the market
   account; a 429 rests it 10 minutes. */
const AM_DDL = 'CREATE TABLE IF NOT EXISTS board_cm (offerId TEXT PRIMARY KEY, link TEXT, checkedAt INTEGER, state TEXT, author TEXT)';
const AM_LOG = 'board_automod_log_v1';
export function routeDecode(id) {
  const ALPHA0 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890', SEPS0 = 'cfhistuCFHISTU', salt = Array.from('routing');
  const shuffle = (alpha, sl) => { if (!sl.length) return alpha; const t = alpha.slice();
    for (let i = t.length - 1, v = 0, p = 0; i > 0; i--, v++) { v %= sl.length; const n = sl[v].codePointAt(0); p += n; const j = (n + v + p) % i; [t[i], t[j]] = [t[j], t[i]]; } return t; };
  let alpha = [...new Set(Array.from(ALPHA0))], seps = Array.from(SEPS0).filter(c => alpha.includes(c));
  alpha = alpha.filter(c => !seps.includes(c)); seps = shuffle(seps, salt);
  if (!seps.length || alpha.length / seps.length > 3.5) { let sl = Math.ceil(alpha.length / 3.5); if (sl === 1) sl = 2;
    if (sl > seps.length) { const d = sl - seps.length; seps = seps.concat(alpha.slice(0, d)); alpha = alpha.slice(d); } else seps = seps.slice(0, sl); }
  alpha = shuffle(alpha, salt);
  const gc = Math.ceil(alpha.length / 12); let guards; if (alpha.length < 3) { guards = seps.slice(0, gc); seps = seps.slice(gc); } else { guards = alpha.slice(0, gc); alpha = alpha.slice(gc); }
  try { const parts = String(id).split(new RegExp('[' + guards.join('') + ']')); let b = parts.length === 3 || parts.length === 2 ? parts[1] : parts[0];
    const lottery = b[0]; b = b.slice(1); let a = alpha; const out = [];
    for (const s of b.split(new RegExp('[' + seps.join('') + ']'))) { a = shuffle(a, [lottery].concat(salt, a).slice(0, a.length)); let n = 0; for (const c of s) { const i = a.indexOf(c); if (i < 0) return null; n = n * a.length + i; } out.push(n); }
    return out; } catch (e) { return null; }
}
const AM_TYPE = { 15: 'news', 14: 'posts' };
export async function readComment(env, link, tokIn) {
  const m = String(link || '').match(/realapp\.com\/([A-Za-z0-9]+)\/(\d{6,})/); if (!m) return { state: 'badlink' };
  const nums = routeDecode(m[1]); if (!nums || nums.length < 4) return { state: 'badlink' };
  const kind = AM_TYPE[nums[0]]; if (!kind) return { state: 'unknown' };
  const tok = tokIn || env.RS_MARKET_TOKEN; if (!tok) return { state: 'notoken' };
  let r; try { r = await fetch(`https://web.realapp.com/comments/${kind}/${nums[3]}/replies/${m[2]}?limit=1`, { headers: rsHeaders(tok) }); } catch (e) { return { state: 'error' }; }
  if (r.status === 429) return { state: 'busy' };
  if (r.status === 404) return { state: 'missing' };
  if (!r.ok) return { state: 'error', status: r.status };
  const j = await r.json().catch(() => null), c = j && j.parentComment; if (!c) return { state: 'missing' };
  const u = c.user || {}, author = String(u.userName || u.username || u.name || '').toLowerCase();
  return { state: c.deletedAt ? 'deleted' : c.repliesClosed ? 'closed' : 'ok', author, text: String(c.plainText || '').slice(0, 200) };
}
async function amLog(env, e) { let l = []; try { l = JSON.parse((await env.RATEBOARD_KV.get(AM_LOG)) || '[]') || []; } catch (x) {}
  l.unshift({ at: Date.now(), ...e }); await env.RATEBOARD_KV.put(AM_LOG, JSON.stringify(l.slice(0, 150))); }
/* Goal rating (Dennis, 2026-11-27): a buyer names the rarity they're grinding to; once their pass for that player
   is there, the listing comes down. Their passes are read once per run (one request for every pass they own). */
const AM_SP = { CFB: ['ncaaf', 2026], NFL: ['nfl', 2026], NHL: ['nhl', 2026], NBA: ['nba', 2027], CBB: ['ncaam', 2027], FC: ['soccer', 2026], UFC: ['ufc', null], MLB: ['mlb', 2026], WNBA: ['wnba', 2026], GOLF: ['golf', 2026] };
const amNorm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '').replace(/\s+/g, ' ').trim();
// Every pass a member has for one board sport this season (paged - one call doesn't return them all).
// Board season label -> Real's season number ('2025-26' FC -> 2025, NBA -> 2026, CFB '2024' -> 2024). Blank = the current one.
function boardSeasonKey(bs, lbl) {
  const m = String(lbl || '').match(/^(\d{4})(?:-(\d{2}))?$/); if (!m) return bs === 'FC' ? 2026 : null;
  const y = Number(m[1]); return m[2] && (bs === 'NBA' || bs === 'CBB') ? y + 1 : y;
}
// Board sport for a pass's sport, and the label members see for its season.
const BOARD_OF = { ncaaf: 'CFB', nfl: 'NFL', nhl: 'NHL', nba: 'NBA', ncaam: 'CBB', soccer: 'FC', ufc: 'UFC', mlb: 'MLB', wnba: 'WNBA', golf: 'GOLF' };
function boardSeasonLbl(bs, se) { se = Number(se); if (!se || bs === 'UFC') return '';
  if (bs === 'CFB' || bs === 'NFL' || bs === 'MLB' || bs === 'WNBA' || bs === 'GOLF') return String(se);
  const a = bs === 'NBA' || bs === 'CBB' ? se - 1 : se; return `${a}-${String(a + 1).slice(2)}`; }
async function boardSportPasses(hid, bsport, tok, only) {
  const [sp, se0] = AM_SP[bsport] || []; if (!sp) return [];
  const seasons = only ? [only] : bsport === 'FC' ? [2026, 2025] : bsport === 'UFC' ? (SWAP_SEASONS.ufc || []) : [se0], kinds = bsport === 'UFC' ? ['team', 'player'] : ['player'], out = [];
  for (const se of seasons) for (const kind of kinds) {
    const base = `https://web.realapp.com/userpasses/${encodeURIComponent(hid)}/passes?entityType=${kind}&season=${se}&sport=${sp}`;
    const d = await rsGetJson(base, tok); const rows = rowsOf(d); rows.push(...(await morePassPages(base, tok, d, rows)));
    for (const x of rows) { const p = passOf(x, sp, se, kind); if (p && p.name && p.rating != null) out.push(p); } }
  return out;
}
async function amPasses(env, db, user, tok, memo, bsport, only) {
  const k = String(user).toLowerCase() + '|' + bsport + '|' + (only || ''), uk = String(user).toLowerCase(); if (memo.has(k)) return memo.get(k);
  let list = null;
  try { let hid = (await db.prepare('SELECT hashId FROM swap_users WHERE LOWER(key)=?').bind(uk).first().catch(() => null) || {}).hashId;
    if (!hid) { const n = await db.prepare('SELECT rsName FROM users WHERE LOWER(key)=?').bind(uk).first().catch(() => null); try { hid = await resolveHashId((n && n.rsName) || user, tok); } catch (e) {} }
    if (hid) list = (await boardSportPasses(hid, bsport, tok, only)).map(p => ({ sp: p.sport, se: p.season, n: amNorm(p.name), r: p.rating }));
  } catch (e) { list = /429/.test(String(e && e.message)) ? 'busy' : null; }
  memo.set(k, list); return list;
}
// Which account reads: the swap bot while Swaps are on hold (it's idle), else the market account.
async function amToken(env) { let hold = false; try { hold = !!(await env.RATEBOARD_KV.get('swaps_hold')); } catch (e) {}
  return (hold && env.RS_SWAP_TOKEN) || env.RS_MARKET_TOKEN || env.RS_SWAP_TOKEN; }
// One listing: read its comment, take it down if Real says it was deleted, flag the rest. Returns the state.
async function amCheck(env, db, o, tok, memo = new Map()) {
  const r = await readComment(env, o.link, tok);
  if (r.state === 'busy' || r.state === 'error' || r.state === 'notoken') return r.state;
  const was = await db.prepare('SELECT state FROM board_cm WHERE offerId=?').bind(o.id).first().catch(() => null);
  await db.prepare('INSERT INTO board_cm (offerId, link, checkedAt, state, author) VALUES (?, ?, ?, ?, ?) ON CONFLICT(offerId) DO UPDATE SET link=excluded.link, checkedAt=excluded.checkedAt, state=excluded.state, author=excluded.author')
    .bind(o.id, o.link, Date.now(), r.state, r.author || null).run();
  const base = { user: o.user, player: o.player, sport: o.sport, rate: o.rate, link: o.link };
  if (r.state === 'deleted') {
    const row = await db.prepare('SELECT * FROM offers WHERE id=?').bind(o.id).first().catch(() => null);
    await db.prepare('DELETE FROM offers WHERE id=?').bind(o.id).run();
    await addNote(db, o.user, 'mod', `Your ${o.player} ${o.rate}/1 listing on the board was taken down: your comment was deleted. If you're still buying, post it again with a new comment.`);
    await amLog(env, { act: 'removed', why: 'deleted', ...base, row });
    return 'deleted';
  }
  // Goal reached: their pass for this player is at (or past) the rarity they said they're grinding to.
  if (Number(o.goal) > 0) { const ps = await amPasses(env, db, o.user, tok, memo, o.sport, boardSeasonKey(o.sport, o.season));
    if (ps === 'busy') return 'busy';
    if (Array.isArray(ps)) { const [sp, se0] = AM_SP[o.sport] || []; const se = boardSeasonKey(o.sport, o.season) || se0, nm = amNorm(o.player);
      const hit = ps.filter(p => p.sp === sp && (se == null || p.se === se) && p.n === nm).sort((a, b) => b.r - a.r)[0];
      if (hit && hit.r >= Number(o.goal)) { const row = await db.prepare('SELECT * FROM offers WHERE id=?').bind(o.id).first().catch(() => null);
        await db.prepare('DELETE FROM offers WHERE id=?').bind(o.id).run();
        await db.prepare("UPDATE board_cm SET state='goal' WHERE offerId=?").bind(o.id).run().catch(() => {});
        await addNote(db, o.user, 'mod', `Your ${o.player} pass hit your goal of ${o.goal_name || o.goal} (it's at ${Math.round(hit.r)}), so your ${o.rate}/1 listing on the board was taken down. Congrats!`);
        await amLog(env, { act: 'removed', why: 'goal', goal: o.goal_name || String(o.goal), rating: Math.round(hit.r), ...base, row });
        return 'goal'; } } }
  if ((r.state === 'missing' || r.state === 'closed') && (!was || was.state !== r.state)) await amLog(env, { act: 'flag', why: r.state, ...base });
  if (r.state === 'ok' && r.author) {
    const n = await db.prepare('SELECT u.rsName AS a, s.rsUser AS b FROM (SELECT ? AS k) q LEFT JOIN users u ON LOWER(u.key)=q.k LEFT JOIN swap_users s ON LOWER(s.key)=q.k').bind(String(o.user).toLowerCase()).first().catch(() => null);
    const names = [o.user, n && n.a, n && n.b].filter(Boolean).map(x => String(x).toLowerCase().replace(/^@/, ''));
    if (!names.includes(r.author) && !(was && was.state === 'ok')) await amLog(env, { act: 'flag', why: 'notyours', author: r.author, ...base });
  }
  return r.state;
}
/* Board auto-moderation (Dennis, 2026-11-27 10:48am AK): every listing's comment once a day from 1:00am Alaska
   (5am ET - Swaps and Bulk are quiet), a few a minute until all are read; and straight away for the member named
   in a new board report. A report whose member turns out to have a deleted comment closes itself - their listing
   comes down and the reporter is told. */
export async function boardAutoMod(env) {
  const db = env.RATEBOARD_DB; if (!db) return;
  if (await env.RATEBOARD_KV.get('automod_rest')) return;
  if (await env.RATEBOARD_KV.get('automod_lock')) return; await env.RATEBOARD_KV.put('automod_lock', '1', { expirationTtl: 120 });
  const tok = await amToken(env); if (!tok) { await env.RATEBOARD_KV.delete('automod_lock'); return; }
  const pause = () => new Promise(res => setTimeout(res, 1500));
  try { await db.prepare(AM_DDL).run();
    for (const c of ['goal INTEGER', 'goal_name TEXT']) { try { await alterOnce(db, 'ALTER TABLE offers ADD COLUMN ' + c); } catch (e) {} }
    // 1) Reports first: the reported member's listings, right away.
    let q = []; try { q = JSON.parse((await env.RATEBOARD_KV.get('automod_q')) || '[]') || []; } catch (e) {}
    if (q.length) { const job = q[0], who = String(job.target || '').toLowerCase().replace(/^@/, '');
      const offs = ((await db.prepare(`SELECT id, user, sport, player, rate, link, season, goal, goal_name FROM offers WHERE link <> '' AND (LOWER(user)=?
          OR LOWER(user) IN (SELECT LOWER(key) FROM users WHERE LOWER(rsName)=?) OR LOWER(user) IN (SELECT LOWER(key) FROM swap_users WHERE LOWER(rsUser)=?)) LIMIT 30`).bind(who, who, who).all().catch(() => ({ results: [] }))).results) || [];
      let gone = [], busy = false; const memo = new Map();
      for (const o of offs) { const st = await amCheck(env, db, o, tok, memo); if (st === 'busy') { busy = true; break; } if (st === 'deleted' || st === 'goal') gone.push({ ...o, st }); await pause(); }
      if (busy) { await env.RATEBOARD_KV.put('automod_rest', '1', { expirationTtl: 600 }); return; }
      if (gone.length && job.id) { try { const m = JSON.parse((await env.RATEBOARD_KV.get(BOARD_KV)) || '{}') || {}; const r = (m.reports || []).find(x => x.id === job.id);
          if (r && r.status === 'open') { const why = gone.every(o => o.st === 'goal') ? 'goal' : 'deleted'; r.status = 'closed'; r.auto = why === 'goal' ? 'goal reached' : 'deleted comment'; await env.RATEBOARD_KV.put(BOARD_KV, JSON.stringify(m));
            await addNote(db, r.by, 'reply', `Thanks for the report on @${r.target} - ${why === 'goal' ? 'they already reached their goal' : 'their comment was deleted'}, so their ${gone.map(o => o.player).join(', ')} listing${gone.length === 1 ? ' was' : 's were'} taken down.`);
            await amLog(env, { act: 'report', why, user: gone[0].user, reporter: r.by, player: gone.map(o => o.player).join(', '), sport: gone[0].sport }); } } catch (e) {} }
      q.shift(); await env.RATEBOARD_KV.put('automod_q', JSON.stringify(q)); return; }
    // 2) The daily sweep, from 1:00am Alaska until every listing has been read today.
    const ak = new Date(Date.now() - 9 * 3600000), day = ak.toISOString().slice(0, 10);
    let sw = {}; try { sw = JSON.parse((await env.RATEBOARD_KV.get('automod_sweep')) || '{}') || {}; } catch (e) {}
    if (ak.getUTCHours() < 1 || sw.done === day) return;
    if (sw.day !== day) { sw = { day, from: Date.now(), n: 0 }; }
    const due = ((await db.prepare(`SELECT o.id, o.user, o.sport, o.player, o.rate, o.link, o.season, o.goal, o.goal_name FROM offers o LEFT JOIN board_cm c ON c.offerId = o.id
      WHERE o.link IS NOT NULL AND o.link <> '' AND (c.offerId IS NULL OR c.checkedAt < ?) ORDER BY c.checkedAt LIMIT 8`).bind(sw.from).all()).results) || [];
    if (!due.length) { sw.done = day; sw.end = Date.now(); await env.RATEBOARD_KV.put('automod_sweep', JSON.stringify(sw)); return; }
    const memo = new Map(); for (const o of due) { const st = await amCheck(env, db, o, tok, memo); if (st === 'busy') { await env.RATEBOARD_KV.put('automod_rest', '1', { expirationTtl: 600 }); break; } sw.n++; await pause(); }
    await env.RATEBOARD_KV.put('automod_sweep', JSON.stringify(sw));
  } catch (e) { try { await env.RATEBOARD_KV.put('automod_err', String(e.message || e).slice(0, 200), { expirationTtl: 86400 }); } catch (x) {} }
  finally { try { await env.RATEBOARD_KV.delete('automod_lock'); } catch (e) {} }
}

/* Swap comments (Dennis, 2026-11-27): once a day at pack reset (7am ET - the hour with no swaps), while Swaps are
   on, every active member's swap comment is read on Real. Deleted, or replies turned off, means partners can't
   offer on it, so their swaps are paused (as if they tapped Pause: swaps and 160s not yet messaged are called off)
   and they get a note to post a new comment and save again. */
export async function swapCommentSweep(env) {
  const db = env.RATEBOARD_DB; if (!db || etHour(Date.now()) !== 7) return;
  if (await env.RATEBOARD_KV.get('swaps_hold')) return;
  if (await env.RATEBOARD_KV.get('swcm_rest') || await env.RATEBOARD_KV.get('swcm_lock')) return;
  const day = ET_DAY_FMT.format(new Date()); let sw = {}; try { sw = JSON.parse((await env.RATEBOARD_KV.get('swcm_sweep')) || '{}') || {}; } catch (e) {}
  if (sw.done === day) return; if (sw.day !== day) sw = { day, from: Date.now(), n: 0, paused: 0 };
  await env.RATEBOARD_KV.put('swcm_lock', '1', { expirationTtl: 120 });
  try { try { await alterOnce(db, 'ALTER TABLE swap_users ADD COLUMN cmAt INTEGER'); } catch (e) {}
    const tok = env.RS_MARKET_TOKEN || env.RS_SWAP_TOKEN;
    const due = ((await db.prepare("SELECT key, comment FROM swap_users WHERE active=1 AND comment IS NOT NULL AND comment <> '' AND (cmAt IS NULL OR cmAt < ?) LIMIT 8").bind(sw.from).all()).results) || [];
    if (!due.length) { sw.done = day; await env.RATEBOARD_KV.put('swcm_sweep', JSON.stringify(sw)); return; }
    for (const u of due) {
      const r = await readComment(env, u.comment, tok);
      if (r.state === 'busy') { await env.RATEBOARD_KV.put('swcm_rest', '1', { expirationTtl: 600 }); break; }
      if (r.state === 'error') { await new Promise(res => setTimeout(res, 1500)); continue; }
      await db.prepare('UPDATE swap_users SET cmAt=? WHERE key=?').bind(Date.now(), u.key).run(); sw.n++;
      if (r.state === 'deleted' || r.state === 'closed') {
        const me = u.key, res = { n: 0, late: 0, soon: 0 }, why = r.state === 'deleted' ? 'your swap comment was deleted' : 'replies on your swap comment are turned off';
        await db.prepare('UPDATE swap_users SET active=0, updatedAt=? WHERE key=?').bind(Date.now(), me).run();
        try { await db.prepare(`UPDATE swap_160 SET status='cancelled', note=? WHERE status='pending' AND warnS IS NULL AND warnB IS NULL AND (buyer=? OR seller=?)`).bind(`called off: @${me}'s swap comment is gone`, me, me).run(); } catch (e) {}
        for (const m of ((await db.prepare(`SELECT * FROM swap_matches WHERE status IN ('pending','warned') AND (a=? OR b=?)`).bind(me, me).all()).results) || []) await callOff(db, m, `called off: @${me}'s swap comment is gone`, res);
        try { await afterCallOff(env, db, swapToken(env), me, res); } catch (e) {}
        await addNote(db, me, 'mod', `Your swaps are paused: ${why}, so partners can't offer on it. Post a new swap comment, put its link in step 2 on raxacademy.app/swaps, and tap Save my swap to start again.`);
        sw.paused++; await amLog(env, { act: 'swappaused', why: r.state, user: me, link: u.comment });
        try { await env.RATEBOARD_KV.delete('swap_hourcounts_v3'); await env.RATEBOARD_KV.delete('swap_wantcounts_v3'); } catch (e) {}
      }
      await new Promise(res => setTimeout(res, 1500));
    }
    await env.RATEBOARD_KV.put('swcm_sweep', JSON.stringify(sw));
  } catch (e) { try { await env.RATEBOARD_KV.put('swcm_err', String(e.message || e).slice(0, 200), { expirationTtl: 86400 }); } catch (x) {} }
  finally { try { await env.RATEBOARD_KV.delete('swcm_lock'); } catch (e) {} }
}

/* Player alerts on Bulk (Dennis, 2026-11-27, from a member: "notified when a certain number of a specific card are
   on the market"): a member picks a player (sport + season) and the most rax per rating point they'll pay; when at
   least N live listings of that player are at or under it (buy now, else the current / minimum bid), they get a push.
   Each listing is only told about once. Checked every 5 minutes; at most 25 alerts a member. */
const BW_DDL = 'CREATE TABLE IF NOT EXISTS bulk_watch (id TEXT PRIMARY KEY, who TEXT, sport TEXT, season INTEGER, playerId INTEGER, name TEXT, maxRpr REAL, minN INTEGER, at INTEGER, lastAt INTEGER, told TEXT)';
const BW_SPN = { nba: 'NBA', ncaam: 'CBB', nfl: 'NFL', ncaaf: 'CFB', nhl: 'NHL', mlb: 'MLB', wnba: 'WNBA', golf: 'Golf', soccer: 'FC', ufc: 'UFC' };
const bwPrice = x => Number(x.buyNow) > 0 ? Number(x.buyNow) : Math.max(Number(x.minBid) || 0, Number(x.curBid) || 0) || null;
async function bwMatches(db, w) {
  const rows = ((await db.prepare('SELECT id, endsAt, rarity, rating, buyNow, minBid, curBid FROM bulk_listings WHERE sport=? AND season=? AND playerId=? AND endsAt > ?').bind(w.sport, w.season, w.playerId, Date.now()).all().catch(() => ({ results: [] }))).results) || [];
  return rows.map(x => ({ ...x, price: bwPrice(x) })).filter(x => x.price && Number(x.rating) > 0).map(x => ({ ...x, rpr: x.price / Number(x.rating) }))
    .filter(x => x.rpr <= Number(w.maxRpr) + 1e-9).sort((a, b) => a.rpr - b.rpr);
}
export async function bulkWatchTick(env) {
  const db = env.RATEBOARD_DB; if (!db) return;
  const last = Number(await env.RATEBOARD_KV.get('bw_last')) || 0; if (Date.now() - last < 5 * 60000) return;
  await env.RATEBOARD_KV.put('bw_last', String(Date.now()));
  try { await db.prepare(BW_DDL).run();
    const ws = ((await db.prepare('SELECT * FROM bulk_watch LIMIT 2000').all()).results) || [];
    for (const w of ws) {
      const hit = await bwMatches(db, w); if (hit.length < Math.max(1, Number(w.minN) || 1)) continue;
      const told = new Set(parse(w.told, []) || []), fresh = hit.filter(x => !told.has(String(x.id))); if (!fresh.length) continue;
      const c = hit[0], nm = `${w.name} ${BW_SPN[w.sport] || w.sport} ${w.season}`;
      await pushTo(env, db, w.who, { title: hit.length > 1 ? `🔔 ${w.name}: ${hit.length} listed at ${Number(w.maxRpr).toFixed(2)} rax/rating or less` : `🔔 ${w.name} listed at ${c.rpr.toFixed(2)} rax/rating`,
        body: `Cheapest: ${c.rarity || ''} ${Math.round(c.rating)} for ${Math.round(c.price).toLocaleString()} rax (${c.rpr.toFixed(2)}/rating)${Number(c.buyNow) > 0 ? ' buy now' : ' bid'} · ${nm}`,
        url: '/bulk#watch=' + encodeURIComponent(`${w.sport}:${w.season}:${w.playerId}`), tag: 'bw-' + w.id });
      for (const x of hit) told.add(String(x.id));
      await db.prepare('UPDATE bulk_watch SET lastAt=?, told=? WHERE id=?').bind(Date.now(), JSON.stringify([...told].slice(-300)), w.id).run();
    }
  } catch (e) { try { await env.RATEBOARD_KV.put('bw_err', String(e.message || e).slice(0, 200), { expirationTtl: 86400 }); } catch (x) {} }
}

/* Niche owners and their requester (Dennis, 2026-11-27, from a member: "the people that bought my niche grind don't
   always get to open it, my times vary"): once a day, for every member who bought a niche player for someone who is
   still swapping for that player, if their swap times share no hour, the owner is told one of the requester's hours to
   add so they get matched. Daily schedules only; once a week per pair. Only while Swaps are on. */
export async function nicheNudge(env) {
  const db = env.RATEBOARD_DB; if (!db || etHour(Date.now()) !== 8) return;
  if (await env.RATEBOARD_KV.get('swaps_hold')) return;
  const day = ET_DAY_FMT.format(new Date()); if ((await env.RATEBOARD_KV.get('niche_nudge_day')) === day) return;
  await env.RATEBOARD_KV.put('niche_nudge_day', day, { expirationTtl: 3 * 86400 });
  try {
    const rows = ((await db.prepare("SELECT DISTINCT seller, buyer, pass FROM swap_160 WHERE kind='niche' AND status <> 'cancelled' AND dueAt < ? AND dueAt > ?").bind(Date.now(), Date.now() - 60 * 86400000).all()).results) || [];
    const U = new Map(); const get = async k => { if (!U.has(k)) U.set(k, await db.prepare('SELECT key, rsUser, wants, slots, sched, active, passes FROM swap_users WHERE key=?').bind(k).first().catch(() => null)); return U.get(k); };
    let sent = 0;
    for (const r of rows) {
      const own = await get(r.seller), req = await get(r.buyer); if (!own || !req || !own.active || !req.active) continue;
      if (!(parse(req.wants, []) || []).includes(r.pass)) continue;   // they've moved on from that player
      if (!parse(own.passes, []).some(p => p.key === r.pass)) continue;   // the owner no longer has it
      const so = parse(own.sched, null) || {}, sr = parse(req.sched, null) || {};
      if ((so.mode && so.mode !== 'daily') || (sr.mode && sr.mode !== 'daily')) continue;
      const a = new Set((parse(own.slots, []) || []).map(Number)), b = (parse(req.slots, []) || []).map(Number).filter(h => !noSwapHour(Date.UTC(2026, 10, 20, h)));
      if (!b.length || b.some(h => a.has(h))) continue;
      const k = `niche_nudge_${own.key}_${req.key}`; if (await env.RATEBOARD_KV.get(k)) continue;
      // The requester's hour closest to one the owner already has.
      const dist = h => a.size ? Math.min(...[...a].map(x => Math.min(Math.abs(x - h), 24 - Math.abs(x - h)))) : 0;
      const h = b.slice().sort((x, y) => dist(x) - dist(y))[0], tz = so.tz || 'America/New_York';
      let when; try { when = new Date(Date.UTC(2026, 10, 20, h)).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric' }); } catch (e) { when = `${h}:00 UTC`; }
      const pl = (parse(own.passes, []).find(p => p.key === r.pass) || {}).name || 'the niche player';
      await addNote(db, own.key, 'reply', `@${req.rsUser || req.key} is still swapping for ${pl}, which you bought through niche - but your swap times never overlap, so you aren't matched. Add ${when} (your time) to your swap times in step 4 and you'll be paired to open packs for each other.`);
      await env.RATEBOARD_KV.put(k, '1', { expirationTtl: 7 * 86400 }); sent++;
      if (sent >= 40) break;
    }
    await env.RATEBOARD_KV.put('niche_nudge_last', JSON.stringify({ at: Date.now(), pairs: rows.length, sent }), { expirationTtl: 7 * 86400 });
  } catch (e) { try { await env.RATEBOARD_KV.put('niche_nudge_err', String(e.message || e).slice(0, 200), { expirationTtl: 86400 }); } catch (x) {} }
}

/* OTD reminder (Dennis, 2026-11-27): at the time a member picks, "Claim your OTD - you have X today". X is today's
   claim, worked out the way the OTD breakdown page does it: each pass's rax on today's date from its player's past games,
   times its multiplier (none at General or once its all-time cap is used), then the claim limit (2 per sport, plus 1
   spare with 3 claims). */
const OTD_LV = [[2, 10], [3, 30], [4, 80], [10, 180], [25, 380], [28, 520], [32, 720], [35, 1000], [40, 1180], [75, 1380], [79, 1560], [83, 1760], [87, 1980], [91, 2220], [95, 2480], [98, 2760], [101, 3000], [103, 3180], [105, 3250],
  [150, 3380], [153, 3820], [156, 4320], [159, 4920], [163, 5620], [167, 6420], [171, 7320], [175, 8320], [180, 9420], [185, 10620], [190, 12000], [196, 13600], [202, 15400], [208, 17500], [214, 19900], [220, 22700], [226, 26000], [233, 29000], [240, 34500], [250, 40000]];
const OTD_TIER = i => i < 4 ? i + 1 : i < 9 ? 5 : i < 19 ? 6 : 7;
const OTD_NAMES = ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary 1', 'Legendary 2', 'Legendary 3', 'Legendary 4', 'Legendary 5', 'Mystic 1', 'Mystic 2', 'Mystic 3', 'Mystic 4', 'Mystic 5', 'Mystic 6', 'Mystic 7', 'Mystic 8', 'Mystic 9', 'Mystic 10'];
const OTD_CAP = { Common: 1000, Uncommon: 1500, Rare: 2000, Epic: 5000, 'Legendary 1': 12500, 'Legendary 2': 14000, 'Legendary 3': 16000, 'Legendary 4': 17500, 'Legendary 5': 20000,
  'Mystic 1': 37500, 'Mystic 2': 39500, 'Mystic 3': 41500, 'Mystic 4': 43500, 'Mystic 5': 45500, 'Mystic 6': 47500, 'Mystic 7': 49000, 'Mystic 8': 50500, 'Mystic 9': 51500, 'Mystic 10': 52500 };
const OTD_TEAM = [[1.2, 30, 1], [1.4, 90, 2], [1.6, 240, 3], [2, 540, 4], [2.5, 1140, 5], [4, 4140, 6], [6, 10140, 7]], OTD_TEAM_CAP = { 1: 1500, 2: 2500, 3: 4000, 4: 6000, 5: 12000, 6: 24000, 7: 128000 };
const OTD_UFC = [1.2, 1.4, 1.6, 2, 5, 5.4, 5.8, 6.2, 6.6, 10, 10.2, 10.4, 10.6, 10.8, 11, 11.2, 11.4, 11.6, 11.8, 20, 20.3, 20.6, 20.9, 21.2, 21.5, 21.8, 22.1, 22.4, 22.7, 23, 23.3, 23.6, 23.9, 24.2, 24.5, 24.8, 26], OTD_UFC_CAP = { 1: 1500, 2: 3000, 3: 6000, 4: 12000, 5: 24000, 6: 48000 };
const OTD_UNCAP = new Set(['nba:2027', 'ncaam:2027', 'nfl:2026', 'ncaaf:2026', 'nhl:2026']);
function otdMult(p) {   // [multiplier, cap left] for one pass
  const team = p.kind === 'team' && p.sport !== 'ufc', r = Number(p.rating) || 0;
  let lv = -1, mult = 0, tier = 0, cap = Infinity;
  if (team) { OTD_TEAM.forEach((l, i) => { if (r >= l[1]) lv = i; }); if (lv < 0) return [0, 0]; mult = OTD_TEAM[lv][0]; tier = OTD_TEAM[lv][2]; cap = OTD_TEAM_CAP[tier]; }
  else { const L = p.sport === 'ufc' ? OTD_LV.slice(0, OTD_UFC.length) : OTD_LV; L.forEach((l, i) => { if (r >= l[1]) lv = i; }); if (lv < 0) return [0, 0];
    mult = p.sport === 'ufc' ? OTD_UFC[lv] : L[lv][0]; tier = OTD_TIER(lv);
    cap = tier === 7 ? Infinity : p.sport === 'ufc' ? (OTD_UFC_CAP[tier] ?? 0) : (OTD_CAP[OTD_NAMES[lv]] ?? 0); }
  if (OTD_UNCAP.has(`${p.sport}:${p.season}`)) cap = Infinity;
  const left = cap - (Number(p.earned) || 0); if (left <= 0) return [0, 0];
  return [Number(p.mult) || mult, left];
}
export async function otdToday(env, db, who, claims = 3, tz = 'America/New_York') {
  const u = await db.prepare('SELECT passes FROM swap_users WHERE LOWER(key)=?').bind(String(who).toLowerCase()).first(); const passes = parse(u && u.passes, []);
  if (!passes.length) return null;
  const r = await otdGamesFor(env, db, who, passes, '', false); const G = (r && r.games) || {};
  let md; try { md = new Intl.DateTimeFormat('en-CA', { timeZone: tz, month: '2-digit', day: '2-digit' }).format(new Date()); } catch (e) { md = ET_DAY_FMT.format(new Date()).slice(5); }
  const list = [];
  for (const p of passes) { const [m, left] = otdMult(p); if (!(m > 0)) continue;
    for (const [d, rax] of (G[p.key] || [])) if (d === md && rax > 0) list.push({ sport: p.sport, name: p.name, rax: Math.min(rax * m, left) }); }
  const by = new Map(); for (const x of list) (by.get(x.sport) || by.set(x.sport, []).get(x.sport)).push(x);
  let earned = 0; const spare = [], won = [];
  for (const arr of by.values()) { arr.sort((a, b) => b.rax - a.rax); arr.forEach((x, n) => { if (n < 2) { earned += x.rax; won.push(x); } else spare.push(x); }); }
  if (claims >= 3 && spare.length) { spare.sort((a, b) => b.rax - a.rax); earned += spare[0].rax; won.push(spare[0]); }
  return { earned: Math.round(earned), won: won.sort((a, b) => b.rax - a.rax).map(x => x.name), pending: r && r.pending };
}
export async function otdReminders(env) {
  const db = env.RATEBOARD_DB; if (!db) return;
  let users = []; try { users = JSON.parse((await env.RATEBOARD_KV.get('push_otd_users_v1')) || '[]') || []; } catch (e) {}
  for (const who of users) {
    let p = {}; try { p = (JSON.parse((await env.RATEBOARD_KV.get('push_prefs_v1_' + who)) || '{}') || {}).otd || {}; } catch (e) {}
    if (!p.on) continue;
    const tz = p.tz || 'America/New_York'; let hh, mm, day;
    try { const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date()); hh = Number(f.find(x => x.type === 'hour').value); mm = Number(f.find(x => x.type === 'minute').value);
      day = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date()); } catch (e) { continue; }
    if (hh * 60 + mm < Number(p.at) || hh * 60 + mm > Number(p.at) + 30) continue;
    const K = 'otd_push_' + who; if ((await env.RATEBOARD_KV.get(K)) === day) continue;
    await env.RATEBOARD_KV.put(K, day, { expirationTtl: 2 * 86400 });
    try { const o = await otdToday(env, db, who, Number(p.claims) === 2 ? 2 : 3, tz); if (!o || !(o.earned > 0)) continue;
      await pushTo(env, db, who, { title: `Claim your OTD - you have ${o.earned.toLocaleString()} today`, body: o.won.length ? `${o.won.slice(0, 3).join(', ')}${o.won.length > 3 ? ` +${o.won.length - 3} more` : ''}` : 'Open Real to claim.', url: '/otd-breakdown', tag: 'otd-' + day });
    } catch (e) {}
  }
}

export function routeId(numbers) {
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
/* Player names for push notifications (Dennis, 2026-11-17): a DM shows a Real player link as his name,
   a notification can't, so each link is remembered with the name to put in its place. */
const PLAYER_NAMES = new Map();
function nameUrl(k, ...owners) { const u = playerUrl(k); if (!u) return; for (const w of owners) { const p = w && (w.passes || []).find(x => x.key === k);
  if (p && p.name && !/^player$/i.test(p.name)) { PLAYER_NAMES.set(u, p.name); if (PLAYER_NAMES.size > 5000) PLAYER_NAMES.delete(PLAYER_NAMES.keys().next().value); return; } } }
function pushText(t) {
  return String(t || '').replace(/,?\s*all details on\s+https?:\/\/\S+/i, '. Tap for the details.')
    .replace(/https:\/\/www\.realapp\.com\/\S+/g, u => PLAYER_NAMES.get(u.replace(/[.,]$/, '')) || 'a player')
    .replace(/https?:\/\/\S+/g, '').replace(/\s*\n+\s*/g, '\n').replace(/[ \t]+/g, ' ').trim().slice(0, 400);
}
async function sideLines(member, m, side) {
  const o = await member(side === 'A' ? m.b : m.a), me = await member(side === 'A' ? m.a : m.b);
  if (!o || !me) return null;
  const gets = side === 'A' ? m.bGets : m.aGets;
  return {
    // What to buy; the player they receive goes at the top of its own message instead of on every line.
    buy: `${playerUrl(gets) || playerName(me, gets)} ${String(gets).split(':')[1]} - ${passUrl(me, gets) || '(pass link not found)'}`,
    recvKey: side === 'A' ? m.aGets : m.bGets,
    recv: (() => { const k = side === 'A' ? m.aGets : m.bGets; nameUrl(k, o, me); return `${playerUrl(k) || playerName(me, k)} ${String(k).split(':')[1]}`; })(),
    // @partner - their comment | the player you give (with season) / your card of him (Dennis, 2026-11-04).
    contact: `@${o.rsUser} - ${o.comment || '(no comment link)'} | ${playerUrl(gets) || playerName(me, gets)} ${String(gets).split(':')[1]} / ${passUrl(me, gets) || '(card link not found)'}`
  };
}
async function matchCols(db) {
  for (const c of ['warnA', 'warnB', 'doneA', 'doneB', 'followA', 'followB', 'dueAt', 'mDoneAt']) { try { await alterOnce(db, `ALTER TABLE swap_matches ADD COLUMN ${c} INTEGER`); } catch (e) {} }
  try { await alterOnce(db, 'ALTER TABLE swap_matches ADD COLUMN mDoneBy TEXT'); } catch (e) {}
  try { await alterOnce(db, 'ALTER TABLE swap_users ADD COLUMN comment TEXT'); } catch (e) {}
  /* Niche players (Dennis, 2026-11-09): niche = { passKey: { n, at } } - how many
     people a member asked to buy a player few active swappers own; nicheIn = they
     opted in to be asked. The requests made live in swap_160 with kind='niche'. */
  try { await alterOnce(db, 'ALTER TABLE swap_users ADD COLUMN niche TEXT'); } catch (e) {}
  try { await alterOnce(db, 'ALTER TABLE swap_users ADD COLUMN nicheIn INTEGER'); } catch (e) {}
  try { await alterOnce(db, 'ALTER TABLE swap_users ADD COLUMN nicheLim TEXT'); } catch (e) {}
  // Blacklist (Dennis, 2026-11-11): members they never want to be matched with, as a JSON list of keys.
  try { await alterOnce(db, 'ALTER TABLE swap_users ADD COLUMN blist TEXT'); } catch (e) {}
  /* Member suggestions (2026-11-11): lock1 = passes only given in a swap for
     their 1st pick; noSp = { sport: swap day } - sports they've maxed today,
     given nothing in until that swap day ends. */
  try { await alterOnce(db, 'ALTER TABLE swap_users ADD COLUMN lock1 TEXT'); } catch (e) {}
  try { await alterOnce(db, 'ALTER TABLE swap_users ADD COLUMN noSp TEXT'); } catch (e) {}
  try { await alterOnce(db, T160_DDL); await alterOnce(db, 'ALTER TABLE swap_160 ADD COLUMN kind TEXT'); } catch (e) {}
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
  try { await alterOnce(db, 'ALTER TABLE swap_users ADD COLUMN confirmDay TEXT'); } catch (e) {}   // the swap day they confirmed their times for
  // Called-off swaps: when Dennis marked each side refunded (rax back) by hand.
  for (const c of ['refundA', 'refundB']) { try { await alterOnce(db, `ALTER TABLE swap_matches ADD COLUMN ${c} INTEGER`); } catch (e) {} }
  // 160s (2026-11-08): opted in to buy, to sell, or only here to sell 160s (no swaps).
  for (const c of ['b160', 's160', 'only160']) { try { await alterOnce(db, `ALTER TABLE swap_users ADD COLUMN ${c} INTEGER`); } catch (e) {} }
  // When a seller sells 160s: 'one' (one hour a day), 'swaps' (their swap hours), 'multi' (hours they pick); sell160h = those UTC hours.
  for (const c of ['sell160m', 'sell160h']) { try { await alterOnce(db, `ALTER TABLE swap_users ADD COLUMN ${c} TEXT`); } catch (e) {} }
  try { await alterOnce(db, T160_DDL); } catch (e) {}
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
/* No swaps at 7am ET (3am Alaska), from Saturday Nov 7 (Dennis, 2026-11-06):
   packs reset then and the swap day turns over, so a swap at that hour
   could land before the new pack. Checked in ET so it follows the clocks. */
const NO_SWAP_FROM = Date.UTC(2026, 10, 7, 9);   // Sat Nov 7, 00:00 Alaska
const etHour = ms => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(new Date(ms)));
const noSwapHour = ms => ms >= NO_SWAP_FROM && etHour(ms) === 7;
const sideDue = m => Number(m.dueAt) || dueFor(m.slot, Number(m.createdAt) || Date.now());

/* Runs every minute. Groups the open matches by member and sends whatever
   is due, about 9 DMs a minute in all. */
async function runDms(env, db, auth, rows, max, force) {
  const now = Date.now(), notes = [];
  // Drop any swap where a giver now keeps the pass they'd give.
  // Everyone's keeps in one read (2026-11-06: one read per member, for every swap two days out,
  // took most of each run's 26 seconds - warnings were trickling out at 3 a minute).
  const keeps = new Map(), ks0 = [...new Set(rows.flatMap(m => [m.a, m.b]))];
  for (const k of ks0) keeps.set(k, new Set());
  for (let i = 0; i < ks0.length; i += 90) { const part = ks0.slice(i, i + 90);
    try { for (const r of (((await db.prepare(`SELECT key, keep FROM swap_users WHERE key IN (${part.map(() => '?').join(',')})`).bind(...part).all()).results) || [])) keeps.set(r.key, new Set(parse(r.keep, []))); } catch (e) {} }
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
    let pushN = 0;
    /* A push too, for browsers the member turned on (2026-11-16). If they chose notifications only for this
       one (no DM) and a push actually reached a device, the DM is skipped; if no push got through, the DM
       still goes so they never miss their swaps. */
    if (kind === 'warn' || kind === 'contact') { try { const first = String((Array.isArray(text) ? text[0] : text) || ''), link = (first.match(/https:\/\/raxacademy\.app\/\S+/) || [])[0];
      const pp = await pushPrefs(env, who), sw = pp.swaps || {}, want = sw.on && (kind === 'warn' ? sw.warn !== false : sw.live !== false), noDm = want && (kind === 'warn' ? sw.dmWarn === false : sw.dmLive === false);
      if (want) { const msg = { title: kind === 'warn' ? 'Swaps in 30 minutes' : 'Your swaps are live', body: pushText(first), url: link ? link.replace('https://raxacademy.app', '') : '/swaps', tag: 'swap-' + kind, urgent: true };
        /* Once per message (2026-11-19): a DM that keeps failing is retried every minute, and the push went with
           every retry - a member got one a minute. Now the push goes once and later tries reuse its result. */
        let h = 0; for (const c of kind + who + first) h = (h * 31 + c.charCodeAt(0)) | 0; const PK = 'swpush_' + (h >>> 0).toString(36);
        const was = await env.RATEBOARD_KV.get(PK).catch(() => null);
        if (was != null) pushN = Number(was) || 0;
        else { pushN = await pushTo(env, db, who, msg).catch(() => 0); await env.RATEBOARD_KV.put(PK, String(pushN), { expirationTtl: 3 * 3600 }).catch(() => {}); }
        if (noDm && pushN > 0) { if (was == null) await stat(db, 'push_instead_' + kind); return true; } } } catch (e) {} }
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
        try { await dmSendRetry(auth, ch, msgs[i], kind === 'warn' || kind === 'contact' ? 0 : 1); }
        catch (e) { if (i === 0) throw e; await queueDm(db, ch, msgs.slice(i), `${kind} @${me.rsUser}`); await botFail(db, 'dm_' + kind, `@${me.rsUser} part ${i + 1}/${msgs.length} queued for retry: ${e.message || e}`); break; }
        sent++; await stat(db, 'dm_' + kind);
      }
      // A second look in a few minutes: read the chat back and re-send any part that isn't there.
      // (The read-back second look is off: Real stores links differently from what was sent, so it re-sent messages that had landed.)
      await dm403(db, who, false);
      notes.push(`${kind} sent to @${me.rsUser} (${msgs.length} message${msgs.length === 1 ? '' : 's'})`); return true;
    }
    catch (e) { notes.push(`${kind} to @${me.rsUser} failed: ${String(e.message || e).slice(0, 160)}`); await botFail(db, 'dm_' + kind, `@${me.rsUser}: ${e.message || e}`);
      if (/send 403/.test(String(e.message || e))) { NO_MSG.set(who, Date.now() + 4 * 60000); await dm403(db, who, true); }   // try them again in a few minutes, not every tick
      /* Bot's Real login rejected (401, 2026-11-19): tell Dennis once every 6 h, and when the push reached the
         member, count it as delivered so it isn't retried all hour. */
      if (/send 401/.test(String(e.message || e))) {
        try { if (!(await env.RATEBOARD_KV.get('bot401_alert'))) { await env.RATEBOARD_KV.put('bot401_alert', String(Date.now()), { expirationTtl: 6 * 3600 });
          await pushTo(env, db, 'dennis', { title: 'Swap bot is logged out', body: 'Real is rejecting the bot account (401) - swap DMs are not going out. Put a fresh RS_SWAP_TOKEN in /opt/rax/.env and restart.', url: '/admin', tag: 'bot401', urgent: true }); } } catch (x) {}
        if (pushN > 0) { await stat(db, 'push_only_bot401_' + kind); return true; } }
      return false; }
  };
  // Soonest (or most overdue) first, so a busy hour can't leave earlier ones waiting.
  const order = [...per.values()].sort((x, y) => Math.min(...x.map(z => z.due)) - Math.min(...y.map(z => z.due)));
  /* Members are worked two at a time; every send waits its turn in dmPace,
     DM_GAP_MS apart, so Real never gets a burst. */
  const doList = async list => {
    if (sent >= max || Date.now() - now > RUN_MS || (TICK_T0 && !force && tickLeft() - dmWaitAhead() < 6000)) return;   // never past the tick's time
    const who = list[0].who;
    if (!force && (NO_MSG.get(who) || 0) > Date.now()) return;   // Real refused them a minute ago: not every tick
    const first = Math.min(...list.map(x => x.due)), last = Math.max(...list.map(x => x.due));
    // 1. warn: every pack for the day, once.
    // 1. warn: 30 min before each swap hour, that hour's packs only.
    const warnHours = new Map();
    // From :25 (35 minutes before the hour).
    // Past :55 the contact message carries it instead.
    for (const x of list) if (!x.m['warn' + x.side] && (force || (now >= x.due - 30 * 60000 && now < x.due - 5 * 60000))) { const k = force ? 'now' : x.due; (warnHours.get(k) || warnHours.set(k, []).get(k)).push(x); }
    let warnFail = false;
    for (const [, wh0] of warnHours) {
      if (sent >= max || Date.now() - now > RUN_MS || (TICK_T0 && !force && tickLeft() - dmWaitAhead() < 6000)) break;   // never past the tick's time
      const wh = await claim(wh0, 'warn');
      if (!wh.length) continue;
      const items = []; for (const x of wh) { const l = await sideLines(member, x.m, x.side); if (l) items.push(l); }
      let wmsg = warnGrouped(items);
      { const me0 = await member(who);   // always the site message now (Dennis, 2026-11-05), whatever the size
        // 160s at the same hour ride along (2026-11-08, Dennis's wording).
        let x160 = '', b160w = 0;
        try { const c = await db.prepare(`SELECT SUM(CASE WHEN seller=?1 AND kind IS NULL THEN 1 ELSE 0 END) AS s, SUM(CASE WHEN buyer=?1 AND kind IS NULL THEN 1 ELSE 0 END) AS b,
              SUM(CASE WHEN seller=?1 AND kind='niche' THEN 1 ELSE 0 END) AS ns, SUM(CASE WHEN buyer=?1 AND kind='niche' THEN 1 ELSE 0 END) AS nb FROM swap_160 WHERE dueAt=?2 AND status <> 'cancelled' AND (seller=?1 OR buyer=?1)`).bind(who, wh[0].due).first();
          const sN = Number(c && c.s) || 0, bN = Number(c && c.b) || 0, nsN = Number(c && c.ns) || 0, nbN = Number(c && c.nb) || 0; b160w = bN;
          x160 = [nsN ? nicheLine(nsN, true) : '', nbN ? nicheLine(nbN, false) : '', sN ? `You're also selling ${sN} player${sN === 1 ? '' : 's'} through 160s` : '', bN ? `You're also receiving ${bN} player${bN === 1 ? '' : 's'} through 160s` : ''].filter(Boolean).join('\n'); } catch (e) {}
        wmsg = [siteDm('Heads up - you swap in 30 min. Buy your packs now.', items.length, await hourLink(env, who, wh[0].due), recvSummary(me0, items), x160 || undefined, b160w)]; }
      if (!(items.length && await send(who, wmsg, 'warn'))) { await unclaim(wh, 'warn'); warnFail = true; }
    }
    if (warnFail) return;
    // 2-4. contact: one per swap hour that has come.
    const byHour = new Map();
    /* From :55 (Dennis, 2026-11-23: "change it to :55 and DMs also don't start till :55"; was :50 since 11-13). */
    for (const x of list) if (!x.m['done' + x.side] && now >= x.due - 5 * 60000) { const k = force ? 'now' : x.due; (byHour.get(k) || byHour.set(k, []).get(k)).push(x); }
    for (const [, hr0] of byHour) {
      if (sent >= max || Date.now() - now > RUN_MS || (TICK_T0 && !force && tickLeft() - dmWaitAhead() < 6000)) break;   // never past the tick's time
      const noWarn = hr0.filter(x => !x.m['warn' + x.side]);
      const hr = await claim(hr0, 'done');
      if (!hr.length) continue;
      const items = [], buy = [];
      for (const x of hr) { const l = await sideLines(member, x.m, x.side); if (!l) continue; items.push(l); if (noWarn.includes(x)) buy.push(l); }
      let cmsg = contactGrouped(items, buy);
      { const me0 = await member(who);   // always the site message now
        let b160c = 0; try { const c = await db.prepare(`SELECT COUNT(*) AS n FROM swap_160 WHERE dueAt=? AND buyer=? AND status <> 'cancelled' AND kind IS NULL`).bind(hr[0].due, who).first(); b160c = Number(c && c.n) || 0; } catch (e) {}
        cmsg = [siteDm('', items.length, await hourLink(env, who, hr[0].due, 'offer'), recvSummary(me0, items), buy.length ? `You weren't warned earlier: buy the ${buy.length} pack${buy.length === 1 ? '' : 's'} on the site first.` : '', b160c)]; }
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
  await Promise.all([0, 1, 2, 3].map(async () => { while (qi < order.length) { const l = order[qi++]; try { await doList(l); } catch (e) { notes.push('list failed: ' + String(e.message || e).slice(0, 80)); } } }));
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
  /* 160s and niche buys too (2026-11-10: a member who unpicked 4:00 was still
     down for 10 160s then). Not yet messaged ones only, as with every call-off
     of a 160: a buyer's need the player still picked and the hour; a seller's
     the hour, unless they sell 160s at hours of their own. */
  try {
    const u = await db.prepare('SELECT sell160m FROM swap_users WHERE key=?').bind(who).first();
    const ownHours = u && (u.sell160m === 'one' || u.sell160m === 'multi');
    const r1 = ((await db.prepare(`SELECT id, buyer, seller, pass, dueAt, kind FROM swap_160 WHERE status='pending' AND warnS IS NULL AND warnB IS NULL AND dueAt > ? AND (buyer=? OR seller=?)`)
      .bind(Date.now(), who, who).all()).results) || [];
    for (const r of r1) {
      const hourGone = rankAt(me, Number(r.dueAt)) < 0, isBuyer = r.buyer === who;
      const why = isBuyer ? (!wants.has(r.pass) ? 'no longer swapping for that player' : hourGone ? 'no longer picks that hour' : null)
        : (hourGone && (r.kind === 'niche' || !ownHours) ? 'no longer picks that hour' : null);
      if (why) { await db.prepare(`UPDATE swap_160 SET status='cancelled', note=? WHERE id=? AND status='pending' AND warnS IS NULL AND warnB IS NULL`).bind(`called off: @${who} ${why}`, r.id).run(); res.n++; }
    }
  } catch (e) {}
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
const SCAN_AT_ONCE = 6;            // scans running at the same time; the rest wait in line (3 until 2026-11-10, when a scan became one call)
const SCAN_HOLD_MS = 45 * 60000;   // a place in line is kept this long after the page stops asking (2026-11-08: tap scan and leave - the server runs it)
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
      AND NOT EXISTS (SELECT 1 FROM scan_queue q WHERE q.startedAt IS NULL AND q.joinedAt < ? AND q.key <> ? AND q.lastSeen > ?)`)
    .bind(now, me, SCAN_AT_ONCE, joined, me, now - 20000).run();   // only those ahead still on the page hold you up; the server runs the rest
  if (c && c.meta && c.meta.changes) return { go: true };
  const ahead = await db.prepare('SELECT COUNT(*) AS n FROM scan_queue WHERE startedAt IS NULL AND joinedAt < ?').bind(joined).first();
  const pos = (Number(ahead && ahead.n) || 0) + 1, secs = Math.ceil(pos / SCAN_AT_ONCE) * 25;
  return { go: false, position: pos, wait: secs < 60 ? `${secs} seconds` : `${Math.ceil(secs / 60)} minute${secs > 60 ? 's' : ''}` };
}
async function newScanJob(env, db, me, over, u, opts) {
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
    // Full by default; the quick one only when asked for (bought into an old season - 2026-11-05: new golf passes went unseen).
    if (pr && prev.length && !(opts && opts.full) && Date.now() - (Number(pr.fullScanAt) || 0) < 7 * 86400000) {
      const had = new Set(prev.map(p => `${p.sport}:${p.season}`));
      // ...and every season a recommended buy is in, so buying one shows up on the next scan.
      try { for (const x of (await wantTop(env, db)).rows) if (x.n >= 3) had.add(String(x.key).split(':').slice(0, 2).join(':')); } catch (e) {}
      const current = new Set(Object.entries(SWAP_SEASONS).flatMap(([sp, v]) => v.slice(0, 2).map(se => `${sp}:${se}`)));   // this season and last, every sport
      steps = SCAN_STEPS.filter(([sp, se]) => had.has(`${sp}:${se}`) || current.has(`${sp}:${se}`)); full = false;
    }
  } catch (e) {}
  const job = { rsUser, hashId, passes: [], errors: [], at: Date.now(), idx: 0, failed: [], ri: 0, still: [], steps, full, self: !over };
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
  const toks0 = [...new Set([auth, marketTok(env) || env.RS_AUTH_TOKEN].filter(x => typeof x === 'string' && x.length > 20))];
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
    if (res.status === 429) { TOK_COOL.set(tok, Date.now() + 3 * 60000); try { await env.RATEBOARD_KV.put('real_busy_at', String(Date.now()), { expirationTtl: 600 }); } catch (e) {} }
    if (!res.ok) throw new Error(`Real ${res.status}: ${text.slice(0, 80)}`);
    let d = null; try { d = JSON.parse(text); } catch (e) {}
    // Only a reply that says it's an error counts as a failure; an empty or
    // differently-shaped reply just means no passes in that season.
    if (d && typeof d === 'object' && !Array.isArray(d) && !rowsOf(d).length
        && (d.error || (Number(d.statusCode) >= 400) || /high volume|rate limit|too many/i.test(String(d.message || '')))) throw new Error(`Real said: ${String(d.message || d.error || d.statusCode).slice(0, 80)}`);
    const rows = rowsOf(d); job.okReads = (job.okReads || 0) + 1;
    rows.push(...(await morePassPages(base, tok, d, rows)));
    for (const r of rows) { const p = passOf(r, sport, season, kind); if (p) job.passes.push(p); }
  };
  const STEPS = job.steps || SCAN_STEPS;
  /* One call for everything (2026-11-10): Real returns every pass a member
     holds, every sport, season and kind, from the address with no filters -
     about 1,000 passes in under a second, against 76 calls (25s+) one season
     at a time. Each pass says its own sport, season and kind. If that call
     fails, or finds clearly fewer passes than the last scan, the scan goes
     on the old way. */
  if (job.idx === 0 && !job.oneTried) {
    job.oneTried = 1;
    try {
      const tok = pickTok(), tq = Date.now();
      const res = await fetch(`https://web.realapp.com/userpasses/${encodeURIComponent(job.hashId)}/passes`, { headers: rsHeaders(tok) });
      job.calls = (job.calls || 0) + 1; job.callMs = (job.callMs || 0) + (Date.now() - tq);
      if (res.status === 429) TOK_COOL.set(tok, Date.now() + 3 * 60000);
      if (!res.ok) throw new Error(`Real ${res.status}`);
      const d = JSON.parse(await res.text()), rows = rowsOf(d);
      const want = new Set(SCAN_STEPS.map(([sp, se, k]) => `${sp}:${se}:${k}`)), got = [];
      for (const x of rows) {
        const e = (x && (x.pass || x.entity)) || x || {};
        const sp = String(x.sport || e.sport || '').toLowerCase(), se = Number(x.season || e.season), k = String(x.entityType || e.entityType || '').toLowerCase();
        if (!want.has(`${sp}:${se}:${k}`)) continue;
        const p = passOf(x, sp, se, k); if (p) got.push(p);
      }
      const pr = await db.prepare('SELECT passes FROM swap_users WHERE key=?').bind(me).first();
      const before = parse(pr && pr.passes, []).length;
      if (rows.length && !got.length) throw new Error('passes came back without sport/season');
      if (before > 20 && got.length < before * 0.9) throw new Error(`one call found ${got.length}, last scan ${before}`);
      job.passes = got; job.idx = SCAN_STEPS.length; job.one = 1; job.full = true; job.steps = null;
    } catch (e) { job.oneErr = String(e.message || e).slice(0, 100); }
  }
  while (job.idx < STEPS.length && budget()) {
    const step = STEPS[job.idx++];
    /* When Real answers "high volume" (429), every read at this pace fails and
       the whole scan is then read a second time (2026-11-09: 76 of 76, scans
       of 1-4 minutes). So after the first 429 the scan slows to a pace Real
       accepts, and the step that failed is tried again there and then. */
    try { await read(step, pickTok()); } catch (e) {
      if (!job.firstErr) job.firstErr = String(e.message || e).slice(0, 120);
      if (/429|high volume|too many/i.test(String(e.message || e))) {
        job.slow = 1; job.r429 = (job.r429 || 0) + 1; await sleep(900);
        try { await read(step, pickTok()); } catch (e2) { job.failed.push(step); job.r429++; }
      } else job.failed.push(step);
      /* Real refusing everything (2026-11-25: every read 429'd for 25+ minutes, scans ground on 3-7 minutes and
         still kept the old passes): after 8 refusals and not one read through, stop - the passes from the last scan
         stay, the member is told in seconds, and the calls stop adding to the load. */
      if (!job.okReads && job.r429 >= 8) { job.realDown = 1; job.failed.push(...STEPS.slice(job.idx)); job.idx = STEPS.length; job.ri = job.failed.length; job.still.push(...job.failed); job.errors.push('Real is refusing reads right now (429)'); }
    }
    await sleep(job.slow ? 650 : 200);
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
  const stamp = job.realDown ? Number((await db.prepare('SELECT scannedAt FROM swap_users WHERE key=?').bind(me).first() || {}).scannedAt) || 0 : job.kept ? Date.now() - (await scanEvery(env)) * 60000 + 5 * 60000 : Date.now();
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
      calls: job.calls || 0, avgMs: job.calls ? Math.round(job.callMs / job.calls) : null, failed: job.failed.length, firstErr: job.firstErr || null, botTok: !!auth, one: job.one ? 1 : 0, oneErr: job.oneErr || null });
    await env.RATEBOARD_KV.put(k, JSON.stringify(l.slice(0, 15))); } catch (e) {}
  if (job.kept) { await stat(db, 'scan_partial'); await botFail(db, 'scan', `${me}: ${job.kept} season(s) kept from last scan - ${job.errors.slice(0, 3).join(' | ')}`); }
  else await stat(db, 'scan_ok');
  return { done: true, job: { self: job.self, hashId: job.hashId, rsUser: job.rsUser }, hashId: job.hashId, passes: job.passes, errors: job.errors, scannedAt: Date.now(),
    note: job.realDown ? 'Real is limiting reads right now, so nothing could be read - your passes from your last scan are kept. Try again in 15-30 minutes.' : job.kept ? `${job.kept} season${job.kept === 1 ? '' : 's'} couldn't be read from Real just now, so ${job.kept === 1 ? 'it keeps' : 'they keep'} your passes from your last scan. Scan again in 5 minutes to refresh ${job.kept === 1 ? 'it' : 'them'}.` : null };
}
/* "Scan done" DMs (Dennis, 2026-11-08): tap scan, leave, and the bot tells
   you when it's finished. Sent when the server finished the scan (the page
   was gone - someone watching sees it finish). Only in a chat the bot
   already has with them (Real allows 5 new chats a day; those stay for
   swaps), and kept until outside the :25-:40 / :55-:10 swap-DM rush. */
const SCAN_DONE_TEXT = 'Your profile scan is complete, swaps should now be updated for you on https://raxacademy.app/swaps';
const SCANDM_DDL = 'CREATE TABLE IF NOT EXISTS scan_dm (key TEXT PRIMARY KEY, hashId TEXT, rsUser TEXT, at INTEGER)';
async function scanChat(db, hashId) {
  if (!hashId) return null;
  try { await db.prepare(DM_DDL).run(); const r = await db.prepare('SELECT channelId FROM swap_dm WHERE hashId=?').bind(hashId).first(); return r && r.channelId ? Number(r.channelId) : null; } catch (e) { return null; }
}
async function scanDoneLater(db, key, job) {
  if (!job || job.self === false || !job.hashId) return;
  try { await db.prepare(SCANDM_DDL).run();
    await db.prepare('INSERT OR REPLACE INTO scan_dm (key, hashId, rsUser, at) VALUES (?, ?, ?, ?)').bind(key, job.hashId, job.rsUser || null, Date.now()).run(); } catch (e) {}
}
async function scanDoneDms(db, auth, t0) {
  if (dmWindow()) return;
  await db.prepare(SCANDM_DDL).run();
  await db.prepare('DELETE FROM scan_dm WHERE at < ?').bind(Date.now() - 3 * 3600000).run();
  const rows = ((await db.prepare('SELECT * FROM scan_dm ORDER BY at LIMIT 6').all()).results) || [];
  for (const r of rows) {
    if (Date.now() - t0 > 24000) break;
    await db.prepare('DELETE FROM scan_dm WHERE key=?').bind(r.key).run();
    const ch = await scanChat(db, r.hashId);
    if (!ch) { await stat(db, 'scan_dm_nochat'); continue; }
    try { await dmSendRetry(auth, ch, SCAN_DONE_TEXT); await stat(db, 'scan_dm'); }
    catch (e) { await queueDm(db, ch, [SCAN_DONE_TEXT], `scan done ${r.key}`); await stat(db, 'scan_dm_retry'); }
  }
}
/* The server's share, once a minute (its own run - op=scantick - so it goes
   on through the swap-DM rush too, on the non-bot accounts then): carry on
   scans whose page went away, start whoever is next in line if they've left
   the page, and send the "scan done" DMs. */
/* One-off (Dennis, 2026-11-12): at 8:45am Alaska, a DM to the 15 members with
   the most swaps that went out (messaged, not called off, time passed). */
const TOP15_AT = Date.UTC(2026, 10, 12, 17, 45);
async function topSwapCounts(db, since = 0, limit = 25) {
  await matchCols(db);
  const k = `topswap_${since}`;
  return ((await db.prepare(`SELECT k, COUNT(*) AS n FROM (
      SELECT a AS k FROM swap_matches WHERE status NOT IN ('cancelled','cancelling','cleared') AND (warnA IS NOT NULL OR warnB IS NOT NULL) AND dueAt <= ?1 AND dueAt >= ?2
      UNION ALL SELECT b FROM swap_matches WHERE status NOT IN ('cancelled','cancelling','cleared') AND (warnA IS NOT NULL OR warnB IS NOT NULL) AND dueAt <= ?1 AND dueAt >= ?2)
    GROUP BY k ORDER BY n DESC LIMIT ?3`).bind(Date.now(), since, limit).all()).results) || [];
}
async function top15Dm(env, db) {
  if (Date.now() < TOP15_AT || Date.now() > TOP15_AT + 6 * 3600000) return;
  const K = 'oneoff_top15_1112';
  try { const o = JSON.parse((await env.RATEBOARD_KV.get(K)) || 'null'); if (o && (o.done || Date.now() - (o.at || 0) < 3 * 60000)) return;
    await env.RATEBOARD_KV.put(K, JSON.stringify({ at: Date.now(), running: 1 }), { expirationTtl: 7 * 86400 }); } catch (e) { return; }
  const out = { at: Date.now(), sent: 0, noChat: 0, failed: 0 };
  try {
    const auth = swapToken(env); if (!auth) throw new Error('no bot token');
    const top = (await topSwapCounts(db, 0, 30)).filter(r => !ADMINS.includes(String(r.k).toLowerCase())).slice(0, 15);
    let rank = 0;
    for (const r of top) {
      rank++;
      const u = await db.prepare('SELECT key, rsUser, hashId FROM swap_users WHERE key=?').bind(r.k).first();
      if (!u || !u.hashId) { out.noChat++; continue; }
      const text = `Hi, you've made the #${rank} most swaps on Rax Academy, at ${Number(r.n).toLocaleString('en-US')} swaps. What changes would you like to see to the site? Whatever you request will almost certainly be added.`;
      try { const ch = await dmChannel(db, auth, u.hashId, u.rsUser, env); await queueDm(db, ch, [text], 'top15 ' + u.key); out.sent++; }
      catch (e) { out.failed++; await botFail(db, 'top15', `${u.key}: ${e.message || e}`); }
    }
    out.done = 1;
  } catch (e) { out.err = String(e.message || e).slice(0, 150); }
  try { await env.RATEBOARD_KV.put(K, JSON.stringify(out), { expirationTtl: 7 * 86400 }); } catch (e) {}
}
/* Untouchables kept fresh before swaps (Dennis, 2026-11-12: a member got
   matched to give passes he'd set untouchable on Real - the site only learns
   that from a scan). Each minute, up to 6 members with a swap 31-100 minutes
   out (not yet messaged) whose untouchables weren't re-read in 3 hours get one
   pass read; only the untouchable flags are updated, and any swap that would
   give an untouchable pass is called off before its messages go out. */
async function untouchRefresh(env, db) {
  const tok = scanTok(env); if (!tok) return;
  try { await alterOnce(db, 'ALTER TABLE swap_users ADD COLUMN untouchAt INTEGER'); } catch (e) {}
  const now = Date.now(), lo = now + 31 * 60000, hi = now + 100 * 60000;
  const due = ((await db.prepare(`SELECT u.key, u.hashId, u.passes, u.touch FROM swap_users u
      WHERE u.hashId IS NOT NULL AND (u.untouchAt IS NULL OR u.untouchAt < ?) AND u.key IN (
        SELECT a FROM swap_matches WHERE status='pending' AND warnA IS NULL AND warnB IS NULL AND dueAt BETWEEN ? AND ?
        UNION SELECT b FROM swap_matches WHERE status='pending' AND warnA IS NULL AND warnB IS NULL AND dueAt BETWEEN ? AND ?)
      LIMIT 6`).bind(now - 3 * 3600000, lo, hi, lo, hi).all()).results) || [];
  for (const u of due) {
    let fresh = null;
    try { const r = await fetch(`https://web.realapp.com/userpasses/${encodeURIComponent(u.hashId)}/passes`, { headers: rsHeaders(tok) });
      if (r.status === 429) break; if (!r.ok) throw new Error(String(r.status));
      const rows = rowsOf(await r.json()); fresh = new Map();
      for (const x of rows) { const e = (x && (x.pass || x.entity)) || x || {};
        const sp = String(x.sport || e.sport || '').toLowerCase(), se = Number(x.season || e.season), k = String(x.entityType || e.entityType || '').toLowerCase();
        const p = passOf(x, sp, se, k); if (p) fresh.set(p.key, !!p.untouchable); }
    } catch (e) { await db.prepare('UPDATE swap_users SET untouchAt=? WHERE key=?').bind(now - 2 * 3600000, u.key).run(); continue; }
    const passes = parse(u.passes, []); let changed = false;
    if (fresh.size) for (const p of passes) { if (!fresh.has(p.key)) continue; const t = fresh.get(p.key);
      if (t && !p.untouchable) { p.untouchable = 1; changed = true; } else if (!t && p.untouchable) { delete p.untouchable; changed = true; } }
    await db.prepare(`UPDATE swap_users SET untouchAt=?${changed ? ', passes=?' : ''} WHERE key=?`).bind(...(changed ? [now, JSON.stringify(passes), u.key] : [now, u.key])).run();
    if (!changed) continue;
    const touch = new Set(parse(u.touch, [])), un = new Set(passes.filter(p => p.untouchable && !touch.has(p.key)).map(p => p.key));
    const ms = ((await db.prepare(`SELECT * FROM swap_matches WHERE status='pending' AND warnA IS NULL AND warnB IS NULL AND dueAt > ? AND (a=? OR b=?)`).bind(now, u.key, u.key).all()).results) || [];
    const res = { n: 0, late: 0, soon: 0 };
    for (const m of ms) { const gives = m.a === u.key ? m.bGets : m.aGets;
      if (un.has(gives)) { await callOff(db, m, `called off: @${u.key} set that pass untouchable`, res); await stat(db, 'untouch_calledoff'); } }
  }
}
async function backgroundScans(env, db, auth) {
  try { await perfOnlyRefresh(env); } catch (e) {}
  await scanTables(db);
  const now = Date.now(), t0 = now;
  const done = async (key, r) => { if (r && r.done) { await stat(db, 'scan_background'); await scanDoneLater(db, key, r.job); } };
  const gone = ((await db.prepare(`SELECT q.key FROM scan_queue q JOIN scan_jobs j ON j.key = q.key WHERE q.startedAt IS NOT NULL AND q.lastSeen < ? ORDER BY q.startedAt LIMIT 3`)
    .bind(now - SCAN_PAGE_GONE_MS).all()).results) || [];
  for (const { key } of gone) {
    if (Date.now() - t0 > 24000) break;
    const job = await loadJob(db, key);
    if (job) await done(key, await scanWork(env, db, key, job, auth));
  }
  // Next in line but not on the page: start them here, as many as there's room and time for.
  /* A scan is one call now (2026-11-10), a few seconds each, so the line is
     worked through while the minute lasts rather than three at a time - and
     someone still on the page doesn't hold up those behind who left. */
  const skip = new Set();
  for (let i = 0; i < 15 && Date.now() - t0 < 20000; i++) {
    const running = await db.prepare('SELECT COUNT(*) AS n FROM scan_queue WHERE startedAt IS NOT NULL').first();
    if ((Number(running && running.n) || 0) >= SCAN_AT_ONCE) break;
    const first = await db.prepare(`SELECT key, lastSeen FROM scan_queue WHERE startedAt IS NULL AND lastSeen < ? ${skip.size ? `AND key NOT IN (${[...skip].map(() => '?').join(',')})` : ''} ORDER BY joinedAt LIMIT 1`).bind(Date.now() - 20000, ...skip).first();
    if (!first) break;   // everyone left in line is on the page: their page starts them
    skip.add(first.key);
    const c = await db.prepare('UPDATE scan_queue SET startedAt=?, lastSeen=? WHERE key=? AND startedAt IS NULL').bind(Date.now(), Date.now() - SCAN_PAGE_GONE_MS, first.key).run();
    if (!(c && c.meta && c.meta.changes)) continue;
    const u = await db.prepare('SELECT rsUser, hashId, scannedAt, passes FROM swap_users WHERE key=?').bind(first.key).first();
    const job = await newScanJob(env, db, first.key, null, u, { full: true });
    if (job.error) await db.prepare('DELETE FROM scan_queue WHERE key=?').bind(first.key).run();
    else await done(first.key, await scanWork(env, db, first.key, job, auth));
  }
  try { await scanDoneDms(db, auth, t0); } catch (e) { await botFail(db, 'scan_dm', e.message); }
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
/* On the droplet nothing cuts a tick off at 30 seconds, so the bot sends for
   almost the whole minute (2026-11-13: with ~25s of each minute, a big hour's
   swap DMs went out 15-20 minutes late). */
const ON_DROPLET = !!(globalThis.process && globalThis.process.env && globalThis.process.env.ROLE);
const RUN_MS = ON_DROPLET ? 55000 : 40000;
const tickLeft = () => TICK_BUDGET - (Date.now() - TICK_T0);
const NO_MSG = new Map();   // members Real just refused a DM for -> when to try again
/* The DMs' own run (2026-11-05): the collector tick calls /api/swaps?op=dmtick
   once a minute, so the warnings and contacts get a whole background slot to
   themselves instead of sharing one with matching and scans. The key is
   derived from the bot's token, so only the board can start it. */
/* Bot DMs to Dennis himself (2026-11-19, "have the bot dm me the auctions and +ev ... only for my account and on
   top of the notifications"): bulk auctions in his range and value alerts, as a DM in his chat with the bot.
   His own switches on Notifications (Bot DMs); held while swaps are on hold; at most 40 an hour. Never throws. */
// Off 2026-11-19 11:57 PM AK with the bulk alerts (Dennis: "End the DMs and notifications").
const DM_OWNER_ON = false;
/* Group giveaway DM (Dennis, 2026-11-26; his wording). Only members the bot already has a chat with: each chat's
   username is looked up in group 60099's member search (board account, one every 10 s), and the exact matches get
   Dennis's message from the bot once, about one a minute, never within 5 minutes of a swap (swaps run almost all the time) and always behind swap
   DMs. Stop any time: KV grpdm_stop. Finishes on its own; ends Saturday 12am ET. */
const GRPDM = { group: 60099, key: 'grpdm_v1', until: Date.parse('2026-11-28T05:00:00Z'),
  text: "You\u2019re in https://www.realapp.com/nlvcQFNFg4k , to automatically enter a 25k giveaway leave it by 12am est Saturday\n\nIf you use EV on edge, it\u2019s provided here aswell but all features free and numbers are more accurate\nhttps://www.realapp.com/beI8FMFdORk" };
const GRPDM_DDL = 'CREATE TABLE IF NOT EXISTS grpdm_list (userName TEXT PRIMARY KEY, channelId INTEGER, foundAt INTEGER, sentAt INTEGER, leftAt INTEGER)';
async function grpDmCols(db) { await db.prepare(GRPDM_DDL).run(); for (const c of ['checkedAt', 'heldAt']) { try { await db.prepare(`ALTER TABLE grpdm_list ADD COLUMN ${c} INTEGER`).run(); } catch (e) {} } }
export async function grpDmTick(env) {
  const db = env.RATEBOARD_DB; if (!db) return;
  await grpDmCols(db);
  /* After the deadline (Saturday 12am ET): check everyone on the list against the group again, 6 a minute; anyone no
     longer found gets leftAt - they're in the giveaway. Runs until each has been checked once (checkedAt). */
  if (Date.now() > GRPDM.until) {
    if (Date.now() > GRPDM.until + 3 * 86400000) return;
    try { await db.prepare('ALTER TABLE grpdm_list ADD COLUMN checkedAt INTEGER').run(); } catch (e) {}
    const lk = 'grpdm_check_lock'; if (await env.RATEBOARD_KV.get(lk)) return; await env.RATEBOARD_KV.put(lk, '1', { expirationTtl: 240 });
    try { const tok = env.RS_AUTH_TOKEN; const due = ((await db.prepare('SELECT userName FROM grpdm_list WHERE checkedAt IS NULL LIMIT 6').all()).results) || [];
      for (const { userName: u } of due) {
        const r = await fetch(`https://web.realapp.com/groups/${GRPDM.group}/searchmembers?permissionsFilter=all&query=${encodeURIComponent(u)}`, { headers: rsHeaders(tok) });
        if (r.status === 429) break; if (!r.ok) { await sleep(10000); continue; }
        const j = await r.json().catch(() => null), still = ((j && j.users) || []).some(x => String(x.userName || '').toLowerCase() === String(u).toLowerCase());
        await db.prepare('UPDATE grpdm_list SET checkedAt = ?, leftAt = ? WHERE userName = ?').bind(Date.now(), still ? null : Date.now(), u).run();
        await sleep(10000); }
    } catch (e) {}
    try { await env.RATEBOARD_KV.delete(lk); } catch (e) {}
    return;
  }
  const note = (u, ch, sent) => db.prepare('INSERT INTO grpdm_list (userName, channelId, foundAt, sentAt) VALUES (?, ?, ?, ?) ON CONFLICT(userName) DO UPDATE SET sentAt = COALESCE(excluded.sentAt, grpdm_list.sentAt)').bind(u, ch, Date.now(), sent ? Date.now() : null).run().catch(() => {});
  return;   // Giveaway DMs ended for good (Dennis, 2026-11-27: "make sure no more giveaway DMs"). Only the Saturday check above runs.
  let st = null; try { st = JSON.parse((await env.RATEBOARD_KV.get(GRPDM.key)) || 'null'); } catch (e) {}
  if (st && st.lock && Date.now() - st.lock < 4 * 60000) return;
  if (!st) { const rows = ((await db.prepare('SELECT hashId, userName, channelId FROM swap_dm WHERE userName IS NOT NULL AND channelId IS NOT NULL').all()).results) || [];
    st = { look: rows.map(r => [r.userName, r.channelId]), hit: [], sent: [], fail: 0, looked: 0, at: Date.now() }; }
  st.lock = Date.now(); await env.RATEBOARD_KV.put(GRPDM.key, JSON.stringify(st), { expirationTtl: 7 * 86400 });
  if (!st.listed) { for (const [u, ch] of st.hit) await note(u, ch, false); for (const u of st.sent) await note(u, null, true); st.listed = 1; }   // the ones found before the list existed
  const save = async () => { st.lock = 0; await env.RATEBOARD_KV.put(GRPDM.key, JSON.stringify(st), { expirationTtl: 7 * 86400 }); };
  try {
    /* One minute's work (Dennis, 2026-11-26: send every 10-15 s in the quiet gaps): while a gap is quiet and someone
       confirmed is waiting, send to them, then wait 10-15 s; otherwise look up the next chat in the group (10 s). */
    const tok = env.RS_AUTH_TOKEN, stopAt = Date.now() + 55000;
    const quiet = async () => { if (DM_STOP || PQ.length > 0 || Date.now() - LAST_SWAP_DM < 120000) return false;
      const near = await db.prepare("SELECT COUNT(*) AS n FROM swap_matches WHERE dueAt BETWEEN ? AND ? AND status NOT IN ('cancelled','cleared')").bind(Date.now() - 5 * 60000, Date.now() + 5 * 60000).first().catch(() => ({ n: 1 }));
      if (near && near.n) { st.why = 'swap near ' + near.n; return false; } return true; };
    while (Date.now() < stopAt) {
      // Dennis can hold anyone on /grpdm: they stay waiting and are skipped until he lets them go.
      let held = new Set(); try { held = new Set((((await db.prepare('SELECT userName FROM grpdm_list WHERE heldAt IS NOT NULL').all()).results) || []).map(r => String(r.userName).toLowerCase())); } catch (e) {}
      const hi = st.hit.findIndex(([u]) => !held.has(String(u).toLowerCase()));
      if (hi >= 0 && await quiet()) { const [u, ch] = st.hit.splice(hi, 1)[0];
        const bad = await db.prepare('SELECT n FROM dm_403 WHERE key=? AND n >= 3').bind(String(u).toLowerCase()).first().catch(() => null);
        if (!bad) { try { await dmSend(swapToken(env), ch, GRPDM.text, 9); st.sent.push(u); await note(u, ch, true); await stat(db, 'grpdm'); }
          catch (e) { st.fail++; st.lastErr = String(e.message || e).slice(0, 100); if (/429/.test(st.lastErr)) { st.hit.unshift([u, ch]); break; } } }
        await sleep(10000 + Math.floor(Math.random() * 5000)); continue; }
      if (hi >= 0) st.waits = (st.waits || 0) + 1;
      if (st.look.length && tok && !(st.rest > Date.now())) { const [u, ch] = st.look[0];
        const r = await fetch(`https://web.realapp.com/groups/${GRPDM.group}/searchmembers?permissionsFilter=all&query=${encodeURIComponent(u)}`, { headers: rsHeaders(tok) });
        if (r.status === 429) { st.rest = Date.now() + 10 * 60000; continue; }
        st.look.shift(); st.looked++;
        if (r.ok) { const j = await r.json().catch(() => null); if (((j && j.users) || []).some(x => String(x.userName || '').toLowerCase() === String(u).toLowerCase())) { st.hit.push([u, ch]); await note(u, ch, false); } }
        await sleep(10000); continue; }
      if (hi < 0) break;   // no one left to send to but held members
      await sleep(10000);   // nothing to look up and not quiet: wait for a gap
    }
    if (!st.look.length && !st.hit.length) st.done = st.done || Date.now();
  } catch (e) { st.lastErr = String(e.message || e).slice(0, 100); }
  await save();
}
export async function grpDmStatus(env) { try { const st = JSON.parse((await env.RATEBOARD_KV.get(GRPDM.key)) || 'null'); if (!st) return null;
  return { toLook: st.look.length, looked: st.looked, matched: st.hit.length + st.sent.length, sent: st.sent.length, waiting: st.hit.length, fail: st.fail, waits: st.waits, why: st.why, lastErr: st.lastErr, done: st.done, stopped: !!(await env.RATEBOARD_KV.get('grpdm_stop')) }; } catch (e) { return null; } }
export async function dmOwner(env, kind, text) {
  if (!DM_OWNER_ON) return false;
  try {
    const db = env.RATEBOARD_DB, p = await pushPrefs(env, 'dennis'), o = p.owner || {};
    if (kind === 'bulk' ? o.dmBulk === false : o.dmEv === false) return false;
    if (await env.RATEBOARD_KV.get('swaps_hold')) return false;
    const HK = 'dmowner_n_' + Math.floor(Date.now() / 3600000), n = Number(await env.RATEBOARD_KV.get(HK)) || 0; if (n >= 40) return false;
    const who = await whoIs(db, 'dennis'), auth = swapToken(env); if (!who || !who.channelId || !auth) return false;
    await env.RATEBOARD_KV.put(HK, String(n + 1), { expirationTtl: 7200 });
    await dmSend(auth, who.channelId, String(text).slice(0, 1900)); await stat(db, 'dm_owner_' + kind); return true;
  } catch (e) { try { await botFail(env.RATEBOARD_DB, 'dm_owner', String(e.message || e)); } catch (x) {} return false; }
}
/* One test value alert for Dennis (2026-11-20, "Send a fake prediction notification and we'll try"): sent once at
   09:05 UTC, to check the tap opens the alert after switching apps. Not saved as his last alert, so
   only the tap itself can take him there. */
export async function testPredPushOnce(env) {
  const K = 'oneoff_testpush_1120c'; if (Date.now() < 1795166160000) return;
  try { if (await env.RATEBOARD_KV.get(K)) return; await env.RATEBOARD_KV.put(K, String(Date.now()), { expirationTtl: 7 * 86400 }); } catch (e) { return; }
  let x = {}; try { x = JSON.parse((await env.RATEBOARD_KV.get('pred_ev_v1')) || '{}') || {}; } catch (e) {}
  const g = (x.games || []).find(y => !y.locked && !y.live && y.sides && y.sides.length) || (x.games || []).find(y => !y.locked && y.sides && y.sides.length);
  const db = env.RATEBOARD_DB;
  if (!g) { await pushTo(env, db, 'dennis', { title: 'Test alert', body: 'No open market right now - tap me, this should open Predictions.', url: '/predictions', tag: 'pv-test', urgent: true }); return; }
  const sd = g.sides[0], q = Math.round((Number(sd.price) || 0.5) * 100);
  const n = await pushTo(env, db, 'dennis', { title: `Value · ${sd.name || sd.label} (test)`, body: `Test 3 - tap me. This should open ${g.game} with the bet on top.`, url: `/predictions#g=${g.id}&s=0&a=500&q=${q}`, tag: 'pv-test', urgent: true });
  try { await env.RATEBOARD_KV.put(K, JSON.stringify({ at: Date.now(), sent: n, game: g.game }), { expirationTtl: 7 * 86400 }); } catch (e) {}
}
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
/* Dennis's wording (2026-11-16): the link inline, then roughly what the run costs - 241 rax a swap
   pack, 271 for each 160 they're buying - then the players coming to them. */
const siteDm = (pre, n, link, sum, extra, b160 = 0) => { const cost = n * 241 + b160 * 271;
  return fitOne(`${pre ? pre + '\n\n' : ''}You have ${n} swap${n === 1 ? '' : 's'}, all details on ${link}\nThis will cost roughly ${cost.toLocaleString('en-US')} rax${b160 ? ` (${n} x 241 + ${b160} x 271 for 160s)` : ''}\nPlayers you're receiving this run: ${sum}${extra ? '\n\n' + extra : ''}`); };
/* One-off check (Dennis, 2026-11-05): everyone in the 8:00 AKST run (17:00
   UTC). Each member's chat is read back and looked for their swap link (its
   short code); anyone without it gets the swap DM again. A few chats each
   tick, after the regular DMs. Dennis gets a DM with who was resent. If the
   first few all come back "missing", the read-back can't see links and the
   check stops instead of sending everyone a repeat. */
const AUDIT_DUE = Date.UTC(2026, 10, 5, 17, 0, 0);
/* One-off (Dennis, 2026-11-17, his wording): everyone in the 4:00pm Eastern run (21:00 UTC) gets a DM about
   push notifications. Only to chats the bot already has, and it stops for good at 3:30pm Eastern, when that
   run's warning DMs start - whoever isn't reached by then is skipped. Hard end date, so it can never rerun. */
const PROMO_DUE = Date.UTC(2026, 10, 17, 21, 0, 0), PROMO_STOP = PROMO_DUE - 30 * 60000;
const PROMO_TEXT = 'Tired of inconsistent times from the bot, or missing the notification because it becomes 1 of 50 for real? Push notifications available for swaps now! Follow instructions on https://raxacademy.app/notifications to activate';
/* One-off (Dennis, 2026-11-17, his wording and his list): ask these members for Predictions feedback. Only
   chats the bot already has; each member claimed in the database first so two processes can't both send.
   Ends at midnight UTC tonight. */
const PREDASK_END = Date.UTC(2026, 10, 18, 9, 0, 0);
const PREDASK_TEXT = 'Hey we were interested in your feedback, what do you think about https://raxacademy.app/predictions what changes would make you stay longterm?';
const PREDASK_USERS = ['bill', 'blaps', 'bryson', 'tovw', 'pup', 'maobappe', 'watto', 'ryanthegoat1as', 'raxrothschild', 'z.brian', 'ethand_', 'matt_boldy12', 'mac', 'lfed', 'kn1cks5', 'fears_'];
async function predAsk(env, db, auth) {
  if (Date.now() >= PREDASK_END) return;
  const K = 'dm_predask_v1';
  let st = null; try { st = JSON.parse((await env.RATEBOARD_KV.get(K)) || 'null'); } catch (e) {}
  st = st || { sent: [], noChat: [], notFound: [], failed: [] };
  if (st.logged) return;
  await db.prepare('CREATE TABLE IF NOT EXISTS dm_once (k TEXT PRIMARY KEY, at INTEGER)').run();
  for (const u of PREDASK_USERS) {
    if (TICK_T0 && tickLeft() - dmWaitAhead() < 9000) break;
    const c = await db.prepare('INSERT OR IGNORE INTO dm_once (k, at) VALUES (?, ?)').bind('predask:' + u, Date.now()).run();
    if (!(c && c.meta && c.meta.changes)) continue;   // already handled, here or by another process
    const r = await db.prepare('SELECT key, hashId FROM swap_users WHERE LOWER(rsUser)=? LIMIT 1').bind(u).first();
    if (!r || !r.hashId) { st.notFound.push(u); }
    else { const had = await db.prepare('SELECT channelId FROM swap_dm WHERE hashId=?').bind(r.hashId).first();
      if (!had || !had.channelId) st.noChat.push(u);
      else { try { await dmSendRetry(auth, had.channelId, PREDASK_TEXT, 3); st.sent.push(u); await stat(db, 'dm_predask'); } catch (e) { st.failed.push(u + ': ' + String(e.message || e).slice(0, 60)); } } }
    try { const cur = JSON.parse((await env.RATEBOARD_KV.get(K)) || 'null'); if (cur) for (const f of ['sent', 'noChat', 'notFound', 'failed']) st[f] = [...new Set([...(cur[f] || []), ...st[f]])]; } catch (e) {}
    await env.RATEBOARD_KV.put(K, JSON.stringify(st), { expirationTtl: 3 * 86400 }); await sleep(400);
  }
  // Once everyone is handled, one line in the bot log (Admin) with who wasn't reached.
  if (st.sent.length + st.noChat.length + st.notFound.length + st.failed.length >= PREDASK_USERS.length && !st.logged) {
    const c = await db.prepare('INSERT OR IGNORE INTO dm_once (k, at) VALUES (?, ?)').bind('predask:logged', Date.now()).run();
    if (c && c.meta && c.meta.changes) { st.logged = true; await env.RATEBOARD_KV.put(K, JSON.stringify(st), { expirationTtl: 3 * 86400 });
      try { await db.prepare("INSERT INTO bot_log (at, kind, msg) VALUES (?, 'predask', ?)").bind(Date.now(), `Predictions feedback DM: sent ${st.sent.length}` + (st.noChat.length ? ` · no chat with the bot: @${st.noChat.join(', @')}` : '') + (st.notFound.length ? ` · not on the site: @${st.notFound.join(', @')}` : '') + (st.failed.length ? ` · failed: ${st.failed.join('; ')}` : '')).run(); } catch (e) {} } }
}
async function pushPromo(env, db, auth) {
  if (Date.now() >= PROMO_STOP) return;
  const K = 'dm_promo_' + PROMO_DUE;
  let st = null; try { st = JSON.parse((await env.RATEBOARD_KV.get(K)) || 'null'); } catch (e) {}
  st = st || { done: [], sent: 0, skipped: 0, failed: 0, startedAt: Date.now() };
  const save = () => env.RATEBOARD_KV.put(K, JSON.stringify(st), { expirationTtl: 3 * 86400 });
  const ms = ((await db.prepare("SELECT * FROM swap_matches WHERE dueAt BETWEEN ? AND ? AND status NOT IN ('cancelled','cancelling','cleared')").bind(PROMO_DUE - 3600000, PROMO_DUE + 3600000).all()).results) || [];
  const who = new Set(); for (const m of ms) for (const side of ['A', 'B']) if (sideDue(m) === PROMO_DUE) who.add(String(side === 'A' ? m.a : m.b));
  st.total = who.size;
  for (const k of [...who].sort()) {
    if (Date.now() >= PROMO_STOP) break;
    if (TICK_T0 && tickLeft() - dmWaitAhead() < 9000) break;
    if (st.done.includes(k)) continue;
    st.done.push(k);   // marked first: a send that errors is never retried, so nobody gets it twice
    try {
      const me = await loadMember(db, k);
      const had = me && me.hashId ? await db.prepare('SELECT channelId FROM swap_dm WHERE hashId=?').bind(me.hashId).first() : null;
      if (!had || !had.channelId) { st.skipped++; await save(); continue; }
      await dmSendRetry(auth, had.channelId, PROMO_TEXT, 3); st.sent++; await stat(db, 'dm_promo');
    } catch (e) { st.failed++; }
    await save(); await sleep(400);
  }
  await save();
}
async function auditHour(env, db, auth) {
  if (Date.now() > AUDIT_DUE + 86400000) return;   // never again (it re-ran a week later, 2026-11-12)
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
/* Nov 12, 9:00am Alaska (18:00 UTC) run: many swap DMs never arrived (the
   DM line was jammed by the re-run Nov 5 check). Each member in that hour has
   their chat read back for their hour link; anyone without it gets the swap DM
   now. Runs only until 10:30am Alaska; state kept with no expiry. */
const FIX_DUE = Date.UTC(2026, 10, 12, 18, 0, 0);
async function fixHourDms(env, db, auth) {
  if (Date.now() < FIX_DUE || Date.now() > FIX_DUE + 55 * 60000) return;   // ended 9:55 (Dennis, 2026-11-12: DMs running late)
  const K = 'dm_fix_' + FIX_DUE;
  let st = null; try { st = JSON.parse((await env.RATEBOARD_KV.get(K)) || 'null'); } catch (e) {}
  if (st && st.finished) return;
  st = st || { done: [], ok: [], resent: [], failed: [], startedAt: Date.now() };
  const save = () => env.RATEBOARD_KV.put(K, JSON.stringify(st));
  await matchCols(db);
  const ms = ((await db.prepare("SELECT * FROM swap_matches WHERE dueAt BETWEEN ? AND ? AND status NOT IN ('cancelled','cancelling','cleared')").bind(FIX_DUE - 3600000, FIX_DUE + 3600000).all()).results) || [];
  const per = new Map();
  for (const m of ms) for (const side of ['A', 'B']) if (sideDue(m) === FIX_DUE) { const who = side === 'A' ? m.a : m.b; (per.get(who) || per.set(who, []).get(who)).push({ m, side }); }
  let s160 = [];
  try { s160 = ((await db.prepare("SELECT seller, buyer FROM swap_160 WHERE dueAt=? AND status <> 'cancelled'").bind(FIX_DUE).all()).results) || []; } catch (e) {}
  for (const r of s160) for (const who of [r.seller, r.buyer]) if (!per.has(who)) per.set(who, []);
  const cache = new Map(), member = async k => cache.has(k) ? cache.get(k) : (cache.set(k, await loadMember(db, k)), cache.get(k));
  for (const [who, list] of [...per.entries()].sort()) {
    if (TICK_T0 && tickLeft() - dmWaitAhead() < 8000) break;
    if (st.done.includes(who)) continue;
    const me = await member(who), name = '@' + ((me && me.rsUser) || who);
    try {
      if (!me || !me.hashId) throw new Error('never verified');
      const had = await db.prepare('SELECT channelId FROM swap_dm WHERE hashId=?').bind(me.hashId).first();
      if (!had || !had.channelId) throw new Error('no chat with the bot');
      const lo = await hourLink(env, who, FIX_DUE, 'offer'), lb = await hourLink(env, who, FIX_DUE);
      const blob = JSON.stringify((await rsGetJson(`https://web.realapp.com/messages/channels/${had.channelId}/messages`, auth)) || '');
      if (blob.includes(lo.split('/').pop()) || blob.includes(lb.split('/').pop())) st.ok.push(name);
      else {
        const items = []; for (const x of list) { const l = await sideLines(member, x.m, x.side); if (l) items.push(l); }
        const text = items.length ? siteDm('Your 9:00am (Alaska) swaps - sorry this is late, the bot was backed up.', items.length, lo, recvSummary(me, items), '')
          : fitOne(`Your 9:00am (Alaska) 160s - sorry this is late, the bot was backed up. Everything is here: ${lb}`);
        await dmSendRetry(auth, had.channelId, text); await stat(db, 'dm_fix_resend'); st.resent.push(name);
      }
    } catch (e) { st.failed.push(`${name} (${String(e.message || e).slice(0, 50)})`); }
    st.done.push(who); await save(); await sleep(300);
  }
  if (per.size && [...per.keys()].every(k => st.done.includes(k))) st.finished = true;
  if (st.finished && !st.told) {
    st.told = Date.now();
    try { const dn = await loadMember(db, 'dennis');
      if (dn && dn.hashId) { const ch = await dmChannel(db, auth, dn.hashId, dn.rsUser, env);
        await dmSend(auth, ch, fitOne(`9:00 fix: ${per.size} people. ${st.ok.length} had their DM. Resent to ${st.resent.length}: ${st.resent.join(', ') || 'nobody'}.${st.failed.length ? ` Couldn't reach: ${st.failed.join(', ')}.` : ''}`)); } } catch (e) {}
  }
  await save();
}
/* Daily confirm (Dennis, 2026-11-06), from Saturday Nov 7's swap day.
   - At the start of each swap day (7am ET = 3am Alaska, no swaps that hour)
     everyone with hours that day gets a DM: their times, in their own time,
     and a deadline 30 minutes before the first; confirm on /swaps.
   - 30 minutes before each hour, before any warning goes out, the swaps of
     anyone who hasn't confirmed for that swap day are called off (nobody
     warned, so both passes are free again) and that member is told to
     confirm for their next time - again at each hour until they do. */
const CONFIRM_FROM_DAY = '2026-11-07';
// Nothing of it shows or counts before 2:30am Alaska, Sat Nov 7 (Dennis). From then a confirm
// counts for the swap day starting at 3am - confirming is open from 30 minutes before the day turns.
const CONFIRM_SHOW_AT = Date.UTC(2026, 10, 7, 11, 30);
const confirmDayNow = (ms = Date.now()) => swapDay(ms + 30 * 60000);
const confirmOn = day => day >= CONFIRM_FROM_DAY;
const isConfirmed = (u, day) => !!u && String(u.confirmDay || '') === day;
const swapDayStart = ms => { let t = Math.floor(ms / 3600000) * 3600000; for (let i = 0; i < 26 && swapDay(t - 3600000) === swapDay(ms); i++) t -= 3600000; return t; };
const hLabel = (ms, tz) => { try { return new Intl.DateTimeFormat('en-US', { timeZone: tz || 'America/New_York', hour: 'numeric', minute: '2-digit' }).format(new Date(ms)).replace(':00', '').replace(' AM', 'am').replace(' PM', 'pm'); } catch (e) { return new Date(ms).toISOString().slice(11, 16) + ' UTC'; } };
const tzOf = u => { const sc = u && (typeof u.sched === 'string' ? parse(u.sched, null) : u.sched); return (sc && sc.tz && sc.tz !== 'UTC') ? sc.tz : null; };
function hoursToday(u, start) {   // the swap times (UTC ms) this member has picked in the swap day starting at `start`
  const uu = { ...u, sched: typeof u.sched === 'string' ? parse(u.sched, null) : u.sched, slots: Array.isArray(u.slots) ? u.slots : parse(u.slots, []) };
  const out = []; for (let i = 0; i < 24; i++) { const t = start + i * 3600000; if (!noSwapHour(t) && rankAt(uu, t) >= 0) out.push(t); }
  return out;
}
/* Adding a time once the day's confirm DMs have started (2:30am Alaska)
   counts as confirming for that swap day (Dennis, 2026-11-07): they just
   chose it, so there's nothing to confirm. */
/* Confirm bypass (Dennis, 2026-11-17: a member who sleeps through the confirm window): members Dennis adds in
   Admin count as confirmed every swap day - their confirm day is filled in each minute, so no prompt, no
   reminder and nothing called off for not confirming. */
const CONF_BYPASS_KV = 'confirm_bypass_v1';
async function bypassList(env) { try { return JSON.parse((await env.RATEBOARD_KV.get(CONF_BYPASS_KV)) || '[]') || []; } catch (e) { return []; } }
async function confirmBypass(env, db) {
  const l = await bypassList(env); if (!l.length) return;
  const day = confirmDayNow();
  await db.prepare(`UPDATE swap_users SET confirmDay=? WHERE LOWER(key) IN (${l.map(() => '?').join(',')}) AND (confirmDay IS NULL OR confirmDay <> ?)`).bind(day, ...l.map(x => x.k), day).run();
}
async function autoConfirm(db, key, before, after) {
  const now = Date.now(), day = confirmDayNow(now);
  if (now < CONFIRM_SHOW_AT || !confirmOn(day)) return false;
  const start = swapDayStart(now + 30 * 60000);
  const was = new Set(before ? hoursToday({ slots: before.slots, sched: before.sched }, start) : []);
  const now2 = hoursToday({ slots: after.slots, sched: after.sched }, start);
  if (!now2.some(t => !was.has(t) && t > now)) return false;
  await db.prepare('UPDATE swap_users SET confirmDay=? WHERE key=?').bind(day, key).run();
  return true;
}
async function onceFor(db, campaign, key) {
  await db.prepare('CREATE TABLE IF NOT EXISTS bot_once (campaign TEXT, key TEXT, at INTEGER, ok INTEGER, PRIMARY KEY (campaign, key))').run();
  const c = await db.prepare('INSERT OR IGNORE INTO bot_once (campaign, key, at, ok) VALUES (?, ?, ?, 1)').bind(campaign, String(key).toLowerCase(), Date.now()).run();
  return !!(c.meta && c.meta.changes);
}
/* Sent from 30 minutes before the swap day turns (2:30am Alaska, Dennis
   2026-11-07: so the set is done before the first hour's warnings at 3:30),
   people whose first time is the day's first hour (8am ET) first, then by
   first time. Runs until 45 minutes into the day for anyone not reached. */
async function confirmPrompts(env, db, auth) {
  const now = Date.now(), day = confirmDayNow(now), start = swapDayStart(now + 30 * 60000);
  if (now < CONFIRM_SHOW_AT || !confirmOn(day) || now < start - 30 * 60000 || now - start > 45 * 60000) return;
  await matchCols(db);
  /* Who gets it (2026-11-07: some members had their swaps called off without
     ever getting this DM - only active members with players and hours were
     asked, but paused members' swaps already set still go ahead and still
     needed confirming). Now: everyone with hours today, plus everyone with a
     swap set for today, and the times listed are both together. */
  const us = ((await db.prepare(`SELECT key, rsUser, hashId, slots, sched, confirmDay FROM swap_users WHERE active=1 AND hashId IS NOT NULL AND wants IS NOT NULL AND wants <> '[]'`).all()).results) || [];
  const byKey = new Map(us.map(u => [u.key, u])), dues = new Map();
  const pend = ((await db.prepare(`SELECT a, b, slot, createdAt, dueAt FROM swap_matches WHERE status IN ('pending','warned') AND dueAt >= ? AND dueAt < ?`).bind(start, start + 24 * 3600000).all()).results) || [];
  for (const m of pend) { const t = sideDue(m); if (swapDay(t) !== day) continue; for (const k of [m.a, m.b]) { if (!dues.has(k)) dues.set(k, new Set()); dues.get(k).add(t); } }
  for (const k of dues.keys()) if (!byKey.has(k)) { const u = await db.prepare('SELECT key, rsUser, hashId, slots, sched, confirmDay FROM swap_users WHERE key=?').bind(k).first(); if (u && u.hashId) byKey.set(k, u); }
  // Only members verified with the current bot (2026-11-27: after the switch to @rax.academy it tried everyone and failed).
  let ver = new Set(); try { ver = new Set((((await db.prepare('SELECT v.hashId FROM swap_ver v JOIN swap_dm d ON d.hashId = v.hashId WHERE d.channelId IS NOT NULL').all()).results) || []).map(r => String(r.hashId))); } catch (e) {}
  const todo = [...byKey.values()].filter(u => ver.has(String(u.hashId)) && !isConfirmed(u, day)).map(u => {
    const hrs = [...new Set([...hoursToday(u, start), ...(dues.get(u.key) || [])])].filter(t => t > now).sort((x, y) => x - y);
    return { u, hrs };
  }).filter(x => x.hrs.length).sort((a, b) => a.hrs[0] - b.hrs[0]);
  let sent = 0, failed = 0, waiting = 0;
  // Who already has it - one read, not a write per member every minute.
  let had = new Set(); try { had = new Set((((await db.prepare('SELECT key FROM bot_once WHERE campaign=?').bind('cprompt_' + day).all()).results) || []).map(r => String(r.key))); } catch (e) {}
  for (const { u, hrs } of todo) {
    if (had.has(String(u.key).toLowerCase())) continue;
    if (TICK_T0 && tickLeft() - dmWaitAhead() < 6000) { waiting = todo.length; break; }
    if (!(await onceFor(db, 'cprompt_' + day, u.key))) continue;
    const tz = tzOf(u), z = tz ? '' : ' ET';
    const times = hrs.map(t => hLabel(t, tz)).join(', ') + z, by = hLabel(hrs[0] - 30 * 60000, tz) + z;
    try { const ch = await dmChannel(db, auth, u.hashId, u.rsUser, env);
      await dmSendRetry(auth, ch, fitOne(`You have the selected times ${times} - you have until ${by} to confirm, go on https://raxacademy.app/swaps and click "Confirm set times" on the top of the page`));
      await stat(db, 'dm_confirm_prompt'); sent++;
      pushIf(env, db, u.key, p => p.swaps && p.swaps.on && p.swaps.confirm !== false && !(Number(p.swaps.confirmLead) > 0), { title: 'Confirm your swap times', body: `Your times today: ${times}. Confirm by ${by}.`, url: '/swaps', tag: 'swap-confirm', urgent: true }).catch(() => {});
      try { await db.prepare('UPDATE bot_once SET ok=2 WHERE campaign=? AND key=?').bind('cprompt_' + day, String(u.key).toLowerCase()).run(); } catch (e) {} }   // 2 = the DM went
    catch (e) { failed++; await botFail(db, 'dm_confirm_prompt', `${u.key}: ${e.message || e}`);
      // Tried again next minute - there's an hour to get them all out - unless Real won't let the bot message them at all.
      if (!/send 403/.test(String(e.message || e))) { try { await db.prepare('DELETE FROM bot_once WHERE campaign=? AND key=?').bind('cprompt_' + day, String(u.key).toLowerCase()).run(); } catch (e2) {} } }
  }
  try { await env.RATEBOARD_KV.put('confirm_run_' + day, JSON.stringify({ at: now, toAsk: todo.length, sentNow: sent, failedNow: failed, waiting }), { expirationTtl: 3 * 86400 }); } catch (e) {}
}
/* Safety net: the same swap twice (same two members, same cards, same swap
   day) - the later copies are called off, every minute, before warnings. */
async function dedupeSweep(db) {
  const ms = ((await db.prepare(`SELECT id, a, b, aGets, bGets, slot, createdAt, dueAt FROM swap_matches WHERE status IN ('pending','warned') AND dueAt > ? AND createdAt > ? ORDER BY id`).bind(Date.now(), Date.now() - 2 * 86400000).all()).results) || [];
  const first = new Map();
  for (const m of ms) {
    const k = (m.a < m.b ? [m.a, m.b, m.aGets, m.bGets] : [m.b, m.a, m.bGets, m.aGets]).join('|') + '|' + swapDay(sideDue(m));
    if (!first.has(k)) { first.set(k, m.id); continue; }
    await db.prepare(`UPDATE swap_matches SET status='cancelled', note=? WHERE id=? AND status IN ('pending','warned')`).bind(`called off: same swap as #${first.get(k)}`, m.id).run();
    await stat(db, 'dupe_calledoff');
  }
}
/* 160s warnings, 30 min before (:30 to :55). Someone who also has swaps that
   hour gets no extra DM - their swap warning's link opens the same page, with
   the 160s on it. Everyone else gets one: sellers how many packs to open,
   buyers how many 160s for which player, and the page link. */
/* A 160 whose seller now has that player picked (even with swaps off - "only
   here for 160s" keeps the picks) or kept is called off before its warning
   (Dennis, 2026-11-08: told to sell K9 and Sheppard, both still picked). */
async function drop160Held(db, rows) {
  const live = rows.filter(r => r.status === 'pending' && !r.warnS); if (!live.length) return rows;
  const ks = [...new Set(live.map(r => r.seller))], held = new Map();
  for (let i = 0; i < ks.length; i += 90) { const part = ks.slice(i, i + 90);
    for (const u of (((await db.prepare(`SELECT key, wants, keep FROM swap_users WHERE key IN (${part.map(() => '?').join(',')})`).bind(...part).all()).results) || []))
      held.set(u.key, new Set([...parse(u.wants, []), ...parse(u.keep, [])])); }
  const out = [];
  for (const r of rows) {
    if (r.kind !== 'niche' && r.status === 'pending' && !r.warnS && (held.get(r.seller) || new Set()).has(r.pass)) {
      await db.prepare(`UPDATE swap_160 SET status='cancelled', note='called off: the seller has that player picked or kept' WHERE id=? AND status='pending' AND warnS IS NULL`).bind(r.id).run(); continue; }
    out.push(r);
  }
  return out;
}
// Niche DM lines: the member asked to buy, and the member who asked.
const nicheLine = (n, buying) => buying
  ? `Niche request: buy ${n} player${n === 1 ? '' : 's'} you don't own and a pack of ${n === 1 ? 'him' : 'each'} - the member who asked pays full price`
  : `${n} member${n === 1 ? ' is' : 's are'} buying your niche player and a pack - you pay full price for the cards`;
async function dm160(env, db, auth) {
  const now = Date.now();
  await matchCols(db);
  /* From 38 minutes out and up to 8 a minute (2026-11-12: at 4 a minute from
     :30, 170 of the 2pm and 3pm 160s never got their warning). */
  let rows = ((await db.prepare(`SELECT * FROM swap_160 WHERE status='pending' AND dueAt > ? AND dueAt <= ? AND (warnS IS NULL OR warnB IS NULL) ORDER BY dueAt, id LIMIT 400`)
    .bind(now, now + 38 * 60000).all()).results) || [];
  if (!rows.length) return;
  rows = await drop160Held(db, rows);
  const per = new Map();
  for (const r of rows) for (const [who, col] of [[r.seller, 'warnS'], [r.buyer, 'warnB']]) {
    if (r[col]) continue; const k = who + '|' + r.dueAt;
    (per.get(k) || per.set(k, { who, due: Number(r.dueAt), list: [] }).get(k)).list.push([r, col]); }
  let sentN = 0;
  for (const g of per.values()) {
    // A few a minute: this runs ahead of the swap warnings, which mustn't wait on it.
    if (sentN >= 5 || (TICK_T0 && tickLeft() - dmWaitAhead() < 6000)) break;   // 5 a minute leaves most of it for the swap warnings
    const got = [];
    for (const [r, col] of g.list) { const c = await db.prepare(`UPDATE swap_160 SET ${col}=? WHERE id=? AND ${col} IS NULL`).bind(now, r.id).run(); if (c && c.meta && c.meta.changes) got.push([r, col]); }
    if (!got.length) continue;
    const sw = await db.prepare("SELECT 1 AS x FROM swap_matches WHERE (a=? OR b=?) AND dueAt=? AND status NOT IN ('cancelled','cleared','cancelling') LIMIT 1").bind(g.who, g.who, g.due).first();
    if (sw) { await stat(db, 'dm_160_withswaps'); continue; }
    const me = await loadMember(db, g.who);
    if (!me || !me.hashId) continue;
    // Dennis's wording (2026-11-08). Counted from every 160 they have that hour.
    const all0 = ((await db.prepare("SELECT seller, buyer, kind FROM swap_160 WHERE dueAt=? AND status <> 'cancelled' AND (seller=? OR buyer=?)").bind(g.due, g.who, g.who).all()).results) || [];
    const all1 = all0.filter(r => r.kind !== 'niche'), nAll = all0.filter(r => r.kind === 'niche');
    const nBuy = nAll.filter(r => r.seller === g.who).length, nGet = nAll.filter(r => r.buyer === g.who).length;
    const sells = all1.filter(r => r.seller === g.who).length, buys = all1.filter(r => r.buyer === g.who).length;
    const pl = n => `${n} player${n === 1 ? '' : 's'}`, link = await hourLink(env, g.who, g.due);
    const nTxt = [nBuy ? nicheLine(nBuy, true) : '', nGet ? nicheLine(nGet, false) : ''].filter(Boolean).join('\n');
    const text = (sells
      ? `You're selling ${pl(sells)}\nGo to ${link} to see them all\nPlease buy within 30 mins` + (buys ? `\n\nYou're also receiving ${pl(buys)} through 160s` : '')
      : buys ? `You're receiving ${pl(buys)} through 160s\nGo to ${link} to see them all`
      : `${nTxt}\nGo to ${link} to see them all` + (nBuy ? '\nPlease buy within 30 mins' : ''))
      + ((sells || buys) && nTxt ? '\n\n' + nTxt : '');
    if (!sells && !buys && !nBuy && !nGet) continue;
    try { const ch = await dmChannel(db, auth, me.hashId, me.rsUser, env); await dmSendRetry(auth, ch, text, 1); await stat(db, 'dm_160'); sentN++; await dm403(db, g.who, false); }
    catch (e) { for (const [r, col] of got) await db.prepare(`UPDATE swap_160 SET ${col}=NULL WHERE id=? AND ${col}=?`).bind(r.id, now).run();
      if (/send 403/.test(String(e.message || e))) await dm403(db, g.who, true);
      await botFail(db, 'dm_160', `${g.who}: ${e.message || e}`); }
  }
}
async function confirmGate(env, db, auth) {
  const now = Date.now();
  if (now < CONFIRM_SHOW_AT) return;
  await matchCols(db);
  const ms = ((await db.prepare(`SELECT * FROM swap_matches WHERE status='pending' AND warnA IS NULL AND warnB IS NULL AND dueAt > ? AND dueAt <= ?`).bind(now, now + 31 * 60000).all()).results) || [];
  const cache = new Map(), get = async k => { if (!cache.has(k)) cache.set(k, await db.prepare('SELECT key, rsUser, hashId, confirmDay FROM swap_users WHERE key=?').bind(k).first()); return cache.get(k); };
  const told = new Map(), asked = new Map();
  for (const m of ms) {
    const due = sideDue(m), day = swapDay(due); if (!confirmOn(day)) continue;
    // Only someone the confirm DM actually reached can lose swaps for not confirming.
    if (!asked.has(day)) { const rs = ((await db.prepare(`SELECT key FROM bot_once WHERE campaign=? AND ok ${day === '2026-11-07' ? 'IN (1,2)' : '= 2'}`).bind('cprompt_' + day).all()).results) || [];   /* Nov 7's were sent before ok=2 was kept */ asked.set(day, new Set(rs.map(r => r.key))); }
    /* Dennis, 2026-11-12: members who never confirmed were still getting
       swaps when the morning DM hadn't reached them. Confirming is required
       of everyone now (the button is always on /swaps; adding a time counts). */
    // Back to only those the morning DM reached (Dennis, 2026-11-12: calling off and DMing everyone else jammed the swap DMs).
    const was = k => asked.get(day).has(String(k).toLowerCase());
    const ua = await get(m.a), ub = await get(m.b), noA = !isConfirmed(ua, day) && was(m.a), noB = !isConfirmed(ub, day) && was(m.b);
    if (!noA && !noB) continue;
    const who = [noA && m.a, noB && m.b].filter(Boolean);
    const c = await db.prepare(`UPDATE swap_matches SET status='cancelled', note=? WHERE id=? AND status='pending' AND warnA IS NULL AND warnB IS NULL`).bind(`called off: ${who.map(k => '@' + ((cache.get(k) || {}).rsUser || k)).join(', ')} didn't confirm today`, m.id).run();
    if (c.meta && c.meta.changes) { await stat(db, 'confirm_calledoff'); for (const k of who) told.set(k, due); }
  }
  // 160s the same way: off before their warning if the buyer or seller didn't confirm.
  // From 40 minutes out (2026-11-15): 160 warnings go from 38 minutes out, so at 31 they were already warned and never came off.
  try { await matchCols(db);
    for (const r of (((await db.prepare(`SELECT * FROM swap_160 WHERE status='pending' AND warnS IS NULL AND warnB IS NULL AND dueAt > ? AND dueAt <= ?`).bind(now, now + 40 * 60000).all()).results) || [])) {
      const day = swapDay(Number(r.dueAt)); if (!confirmOn(day)) continue;
      if (!asked.has(day)) { const rs = ((await db.prepare('SELECT key FROM bot_once WHERE campaign=? AND ok = 2').bind('cprompt_' + day).all()).results) || []; asked.set(day, new Set(rs.map(x => x.key))); }
      const was = k => asked.get(day).has(String(k).toLowerCase());
      const no = [r.buyer, r.seller].filter(k => was(k));
      const off = []; for (const k of no) if (!isConfirmed(await get(k), day)) off.push(k);
      if (off.length) { await db.prepare(`UPDATE swap_160 SET status='cancelled', note=? WHERE id=? AND status='pending'`).bind(`called off: ${off.map(k => '@' + k).join(', ')} didn't confirm today`, r.id).run(); await stat(db, 'confirm_calledoff_160'); for (const k of off) if (!told.has(k)) told.set(k, Number(r.dueAt)); }
    } } catch (e) {}
  /* Everyone whose swaps were called off for this (2026-11-07: 36 swaps came
     off at 4am Alaska but only 2 people were told - a tick that ran out of
     time lost the rest). Rebuilt from the called-off swaps each minute, so a
     DM missed one minute goes the next; onceFor keeps it to one per hour. */
  const off = ((await db.prepare(`SELECT a, b, slot, createdAt, dueAt FROM swap_matches WHERE status='cancelled' AND note LIKE '%didn''t confirm today%' AND dueAt > ? AND dueAt <= ?`).bind(now, now + 31 * 60000).all()).results) || [];
  for (const m of off) { const due = sideDue(m), day = swapDay(due);
    for (const k of [m.a, m.b]) if (!told.has(k) && !isConfirmed(await get(k), day)) told.set(k, due); }
  /* The "you didn't confirm" DMs go after the swap warnings and swap DMs, not
     before (2026-11-13: sent here first, they took most of each minute from
     :30 and the 1pm warnings never went out). dmTick calls the returned job last. */
  return async () => { for (const [k, due] of told) {
    if (TICK_T0 && tickLeft() < 8000) break;
    const u = cache.get(k); if (!u || !u.hashId) continue;
    if (!(await onceFor(db, 'noconf_' + due, k))) continue;
    try { const ch = await dmChannel(db, auth, u.hashId, u.rsUser, env);
      await dmSendRetry(auth, ch, `You didn't confirm your swaps, go to https://raxacademy.app/swaps to confirm it for your next set time`);
      await stat(db, 'dm_noconfirm'); }
    catch (e) { await botFail(db, 'dm_noconfirm', `${k}: ${e.message || e}`); }
  } };
}
async function dmTick(env) {
  TICK_T0 = Date.now(); TICK_BUDGET = ON_DROPLET ? 57000 : 26000;
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
  // Unconfirmed members' swaps come off before any warning goes out; the day's confirm DMs at its start.
  try { await dedupeSweep(db); } catch (e) { await botFail(db, 'dedupe', e.message); }
  let gateDms = null;
  try { gateDms = await confirmGate(env, db, auth); } catch (e) { await botFail(db, 'confirm_gate', e.message); }
  /* On the droplet the resends and 160 warnings run alongside the swap DMs and
     the priority line puts swap warnings/DMs first (2026-11-13); on
     Cloudflare they still go one after another. */
  const retryJob = () => retryDms(db, auth).catch(e => botFail(db, 'dm_retry', e.message));
  if (!ON_DROPLET) await retryJob();   // unsent parts first
  /* Swap warnings and swap DMs first, the day's confirm DMs after (2026-11-08:
     the confirm run ate the whole minute from 3:30 to 3:45am Alaska and no
     4am warning went out). */
  let out = [];
  try {
    // Only what's due soon (warnings from 30 minutes out, swap DMs at the hour) plus call-offs.
    const rows = ((await db.prepare(`SELECT * FROM swap_matches WHERE status IN ('pending','warned','cancelling') AND createdAt > ? AND (status='cancelling' OR (dueAt <= ? AND dueAt > ?)) ORDER BY COALESCE(dueAt, createdAt), id LIMIT 800`)
      .bind(Date.now() - 2 * 86400000, Date.now() + 45 * 60000, Date.now() - 3 * 3600000).all()).results) || [];
    const j160 = () => dm160(env, db, auth).catch(e => botFail(db, 'dm_160', e.message));
    if (ON_DROPLET) { const r = await Promise.all([retryJob(), j160(), rows.length ? runDms(env, db, auth, rows, DM_PER_TICK, false) : []]); out = r[2] || []; }
    else { await j160(); if (rows.length) out = await runDms(env, db, auth, rows, DM_PER_TICK, false); }
  } catch (e) { await botFail(db, 'dm_run', e.message); }
  try { if (typeof gateDms === 'function') await gateDms(); } catch (e) { await botFail(db, 'dm_noconfirm', e.message); }
  try { await confirmPrompts(env, db, auth); } catch (e) { await botFail(db, 'dm_confirm_prompt', e.message); }
  // auditHour was a one-off for Nov 5's 8:00 run; it ran again on Nov 12 when its saved state expired and resent week-old swaps. Off for good.
  // try { await auditHour(env, db, auth); } catch (e) { await botFail(db, 'dm_audit', e.message); }
  try { await fixHourDms(env, db, auth); } catch (e) { await botFail(db, 'dm_fix', e.message); }
  try { await pushPromo(env, db, auth); } catch (e) { await botFail(db, 'dm_promo', e.message); }
  try { await predAsk(env, db, auth); } catch (e) { await botFail(db, 'dm_predask', e.message); }
  /* Dennis, 2026-11-12: once the 10:00am Alaska swap DMs are out, everything
     still waiting in the resend lines is deleted, so nobody gets an old message. */
  try { if (Date.now() >= Date.UTC(2026, 10, 12, 19, 8) && !(await env.RATEBOARD_KV.get('dm_purge_1112'))) {
    await env.RATEBOARD_KV.put('dm_purge_1112', String(Date.now()));
    await db.prepare(DMQ_DDL).run(); await db.prepare(DMV_DDL).run();
    const a = await db.prepare('DELETE FROM dm_retry').run(), b = await db.prepare('DELETE FROM dm_verify').run();
    await env.RATEBOARD_KV.put('dm_purge_1112_n', JSON.stringify({ at: Date.now(), retry: a.meta && a.meta.changes, verify: b.meta && b.meta.changes }));
  } } catch (e) { await botFail(db, 'dm_purge', e.message); }
  return out;
}
/* Boost reminders (2026-11-16): for each member who turned them on, a push N hours (they pick, up to 36)
   before the first game of each day in each sport they chose. First-game times come from ESPN's
   scoreboards for today and tomorrow (ET), read every 30 minutes. Each reminder goes once. */
async function boostReminders(env, db) {
  let ix = []; try { ix = JSON.parse((await env.RATEBOARD_KV.get('push_boost_users_v1')) || '[]') || []; } catch (e) {}
  if (!ix.length) return;
  const now = Date.now();
  const lk = Number(await env.RATEBOARD_KV.get('push_boost_lock')) || 0; if (now - lk < 55000) return; await env.RATEBOARD_KV.put('push_boost_lock', String(now));
  let fg = null; try { fg = JSON.parse((await env.RATEBOARD_KV.get('push_firstgame_v1')) || 'null'); } catch (e) {}
  if (!fg || now - fg.at > 30 * 60000) {
    const days = [0, 1, 2].map(i => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(now + i * 86400000)).replace(/-/g, ''));
    fg = { at: now, m: {} };
    for (const sp of Object.keys(BOOST_PUSH_SP)) for (const d of days) {
      try { const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${ESPN_PATH[sp]}/scoreboard?dates=${d}${sp === 'ncaaf' ? '&groups=80&limit=300' : sp === 'ncaam' ? '&groups=50&limit=400' : ''}`);
        const j = r.ok ? await r.json() : null; const ts = ((j && j.events) || []).map(e => Date.parse(e.date)).filter(Number.isFinite);
        if (ts.length) fg.m[`${sp}|${d}`] = Math.min(...ts); } catch (e) {} }
    try { await env.RATEBOARD_KV.put('push_firstgame_v1', JSON.stringify(fg), { expirationTtl: 86400 }); } catch (e) {}
  }
  let sent = {}; try { sent = JSON.parse((await env.RATEBOARD_KV.get('push_boost_sent_v1')) || '{}') || {}; } catch (e) {}
  let ch = false;
  /* Only sports they can boost (member feedback, 2026-11-17: a CFB reminder with no CFB passes): a sport
     counts when their last scan has a current-season player pass in it. No scan on file = remind as before. */
  const heldSp = async who => { try { const u = await db.prepare('SELECT passes FROM swap_users WHERE key=?').bind(who).first();
    if (!u || !u.passes) return null; const P = parse(u.passes, []); if (!P.length) return null;
    return new Set(P.filter(x => x.kind !== 'team' && BOOST_SEASON[x.sport] && Number(x.season) === BOOST_SEASON[x.sport][0]).map(x => x.sport)); } catch (e) { return null; } };
  for (const who of ix) {
    const p = await pushPrefs(env, who); if (!(p.boosts && p.boosts.on)) continue;
    const held = await heldSp(who), canSp = sp => !held || held.has(sp);
    // "All": one reminder before the earliest first game across the sports picked, to the All sports list.
    if (p.boosts.all) {
      const on = Object.entries(p.boosts.sports || {}).filter(([, x]) => x.on).map(([sp]) => sp).filter(canSp), byDay = {};
      for (const [k, t] of Object.entries(fg.m)) { const [sp, d] = k.split('|'); if (on.includes(sp) && (!byDay[d] || t < byDay[d].t)) byDay[d] = { t, sp }; }
      for (const [d, { t, sp }] of Object.entries(byDay)) { if (t <= now || now < t - (Number(p.boosts.allHours) || 2) * 3600000) continue;
        const sk = `${who}|all|${d}`; if (sent[sk]) continue; sent[sk] = now; ch = true;
        const tm = new Date(t).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' });
        await pushTo(env, db, who, { title: 'Boost reminder', body: `First game ${tm} ET (${BOOST_PUSH_SP[sp]}) - set your boosters.`, url: '/boosts?sport=all', tag: 'boost-all' }); }
      continue;
    }
    for (const [sp, x] of Object.entries(p.boosts.sports || {})) { if (!x.on || !canSp(sp)) continue;
      for (const [k, t] of Object.entries(fg.m)) { if (!k.startsWith(sp + '|') || t <= now) continue;
        if (now < t - (Number(x.hours) || 2) * 3600000) continue;
        const sk = `${who}|${k}`; if (sent[sk]) continue; sent[sk] = now; ch = true;
        const tm = new Date(t).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' });
        await pushTo(env, db, who, { title: `Boost reminder · ${BOOST_PUSH_SP[sp]}`, body: `First ${BOOST_PUSH_SP[sp]} game ${tm} ET - set your boosters.`, url: '/boosts?sport=' + sp, tag: 'boost-' + sp }); } } }
  if (ch) { for (const k of Object.keys(sent)) if (now - sent[k] > 3 * 86400000) delete sent[k]; try { await env.RATEBOARD_KV.put('push_boost_sent_v1', JSON.stringify(sent)); } catch (e) {} }
}
/* Confirm reminders at the member's own timing (2026-11-16): N minutes before their confirm deadline
   (30 minutes before their first swap time today), if they haven't confirmed. Opens /swaps. */
async function confirmReminders(env, db) {
  let ix = []; try { ix = JSON.parse((await env.RATEBOARD_KV.get('push_confirm_users_v1')) || '[]') || []; } catch (e) {}
  const now = Date.now(); if (!ix.length || now < CONFIRM_SHOW_AT) return;
  const lk = Number(await env.RATEBOARD_KV.get('push_confirm_lock')) || 0; if (now - lk < 55000) return; await env.RATEBOARD_KV.put('push_confirm_lock', String(now));
  const day = confirmDayNow(now); if (!confirmOn(day)) return;
  const start = swapDayStart(now + 30 * 60000);
  let sent = {}; try { sent = JSON.parse((await env.RATEBOARD_KV.get('push_confirm_sent_v1')) || '{}') || {}; } catch (e) {}
  let ch = false;
  for (const who of ix) {
    const sk = `${who}|${day}`; if (sent[sk]) continue;
    const p = await pushPrefs(env, who), lead = Number((p.swaps || {}).confirmLead) || 0; if (!(p.swaps && p.swaps.on && p.swaps.confirm !== false && lead > 0)) continue;
    const u = await db.prepare('SELECT key, slots, sched, confirmDay FROM swap_users WHERE LOWER(key)=?').bind(who).first(); if (!u || isConfirmed(u, day)) continue;
    const pend = ((await db.prepare(`SELECT a, b, slot, createdAt, dueAt FROM swap_matches WHERE status IN ('pending','warned') AND (a=?1 OR b=?1) AND dueAt >= ?2 AND dueAt < ?3`).bind(u.key, start, start + 24 * 3600000).all()).results) || [];
    const hrs = [...new Set([...hoursToday(u, start), ...pend.map(m => sideDue(m))])].filter(t => t > now).sort((a, b) => a - b);
    if (!hrs.length) continue;
    const by = hrs[0] - 30 * 60000; if (now >= by || now < by - lead * 60000) continue;
    sent[sk] = now; ch = true;
    try { await env.RATEBOARD_KV.put('push_confirm_sent_v1', JSON.stringify(sent)); } catch (e) {}   // saved before the push, so a later error can't repeat it next minute
    const tz = tzOf(u), z = tz ? '' : ' ET';
    await pushTo(env, db, who, { title: 'Confirm your swap times', body: `Your times today: ${hrs.map(t => hLabel(t, tz)).join(', ')}${z}. Confirm by ${hLabel(by, tz)}${z}.`, url: '/swaps', tag: 'swap-confirm', urgent: true });
  }
  if (ch) { for (const k of Object.keys(sent)) if (now - sent[k] > 3 * 86400000) delete sent[k]; try { await env.RATEBOARD_KV.put('push_confirm_sent_v1', JSON.stringify(sent)); } catch (e) {} }
}
export async function swapTick(env) {
  PUSH_ENV = env;
  try { DM_STOP = !!(await env.RATEBOARD_KV.get('swaps_hold')); } catch (e) { DM_STOP = true; }
  if (!DM_STOP) { confirmReminders(env, env.RATEBOARD_DB).catch(() => {});   // not awaited, like boostReminders
    boostReminders(env, env.RATEBOARD_DB).catch(() => {}); }   // not awaited: never holds up the swap DMs (and not while the bot is down)
  otdBackground(env).catch(() => {});   // OTD data kept built (2026-11-25); not awaited
  TICK_T0 = Date.now();
  if (!DM_ON) return null;
  const db = env.RATEBOARD_DB, auth = swapToken(env);
  if (!db || !auth) return null;
  await ready(db);
  /* Leave the old ones (Dennis, 2026-11-19 07:27 AK: "the old times shouldn't be sent anymore just leave them"):
     once, every swap / 160 already due or due within 35 min that never fully went is called off, and every queued
     DM retry is dropped, so nothing from the bot-down hours goes out late. */
  try { if (!(await env.RATEBOARD_KV.get('stale_clear_1119'))) { await env.RATEBOARD_KV.put('stale_clear_1119', String(Date.now()), { expirationTtl: 30 * 86400 });
    const cut = Date.now() + 35 * 60000, note = 'called off: the swap bot was down - not sent late';
    const a = await db.prepare(`UPDATE swap_matches SET status='cancelled', note=? WHERE status IN ('pending','warned','sending') AND dueAt <= ?`).bind(note, cut).run();
    const b = await db.prepare(`UPDATE swap_160 SET status='cancelled', note=? WHERE status IN ('pending','warned','sending') AND dueAt <= ?`).bind(note, cut).run().catch(() => null);
    let q = null; try { await db.prepare(DMQ_DDL).run(); q = await db.prepare('DELETE FROM dm_retry').run(); } catch (e) {}
    await env.RATEBOARD_KV.put('stale_clear_1119_n', JSON.stringify({ at: Date.now(), m: (a.meta || {}).changes || 0, s: ((b || {}).meta || {}).changes || 0, q: ((q || {}).meta || {}).changes || 0 }), { expirationTtl: 30 * 86400 }); } } catch (e) {}
  /* Fix (2026-11-19 09:06 AK, pollo: all-time swap counts fell): the late-DM clear-out also hit old, finished swaps -
     they sit as 'warned'/'sending' once their DMs went - so the leaderboards lost them. Every one due before the
     outage that had a DM go out is put back as 'sent' (sent is never messaged again); unmessaged ones stay off. */
  try { if (!(await env.RATEBOARD_KV.get('stale_undo_1119'))) { await env.RATEBOARD_KV.put('stale_undo_1119', String(Date.now()), { expirationTtl: 30 * 86400 });
    const cut = Date.UTC(2026, 10, 19, 11, 55), nt = 'called off: the swap bot was down - not sent late';
    const a = await db.prepare(`UPDATE swap_matches SET status='sent', note=NULL WHERE note=? AND status='cancelled' AND dueAt < ? AND (warnA IS NOT NULL OR warnB IS NOT NULL OR doneA IS NOT NULL OR doneB IS NOT NULL)`).bind(nt, cut).run();
    const b = await db.prepare(`UPDATE swap_160 SET status='sent', note=NULL WHERE note=? AND status='cancelled' AND dueAt < ? AND (warnS IS NOT NULL OR warnB IS NOT NULL)`).bind(nt, cut).run().catch(() => null);
    const left = await db.prepare(`SELECT COUNT(*) AS n FROM swap_matches WHERE note=? AND dueAt < ?`).bind(nt, cut).first();
    await env.RATEBOARD_KV.put('stale_undo_1119_n', JSON.stringify({ at: Date.now(), m: (a.meta || {}).changes || 0, s: ((b || {}).meta || {}).changes || 0, stillOff: left ? left.n : null }), { expirationTtl: 30 * 86400 }); } } catch (e) { try { await env.RATEBOARD_KV.put('stale_undo_1119_n', JSON.stringify({ err: String(e.message || e).slice(0, 160) }), { expirationTtl: 86400 }); } catch (x) {} }
  /* One-off (2026-11-19 11:03 AK): swaps still ahead today where someone would give a pass they already gave by hand
     during the bot outage (swaps due before the 8am hold) are called off. Same for 160s they'd sell. */
  try { if (!(await env.RATEBOARD_KV.get('outgive_clear_1119'))) { await env.RATEBOARD_KV.put('outgive_clear_1119', String(Date.now()), { expirationTtl: 30 * 86400 });
    const n0 = Date.now(), END = Date.UTC(2026, 10, 19, 16, 30), since = n0 - 30 * 3600000, blk = new Set();
    for (const x of (((await db.prepare("SELECT a, b, aGets, bGets, slot, createdAt, dueAt FROM swap_matches WHERE status IN ('cancelled','cancelling') AND note LIKE 'called off: the swap bot%' AND dueAt > ? AND dueAt < ?").bind(since, END).all()).results) || [])) {
      const d = swapDay(sideDue(x)); blk.add(`${x.b}|${x.aGets}|${d}`); blk.add(`${x.a}|${x.bGets}|${d}`); }
    try { for (const x of (((await db.prepare("SELECT seller, pass, dueAt FROM swap_160 WHERE status='cancelled' AND note LIKE 'called off: the swap bot%' AND dueAt > ? AND dueAt < ?").bind(since, END).all()).results) || [])) blk.add(`${x.seller}|${x.pass}|${swapDay(Number(x.dueAt))}`); } catch (e) {}
    let off = 0, off1 = 0;
    for (const x of (((await db.prepare("SELECT id, a, b, aGets, bGets, slot, createdAt, dueAt FROM swap_matches WHERE status='pending' AND warnA IS NULL AND warnB IS NULL AND dueAt > ?").bind(n0 + 30 * 60000).all()).results) || [])) {
      const d = swapDay(sideDue(x)), who = blk.has(`${x.b}|${x.aGets}|${d}`) ? x.b : blk.has(`${x.a}|${x.bGets}|${d}`) ? x.a : null;
      if (who) { await db.prepare("UPDATE swap_matches SET status='cancelled', note=? WHERE id=? AND status='pending'").bind(`called off: @${who} already gave that pass today`, x.id).run(); off++; } }
    try { for (const x of (((await db.prepare("SELECT id, seller, pass, dueAt FROM swap_160 WHERE status='pending' AND warnS IS NULL AND warnB IS NULL AND dueAt > ?").bind(n0 + 30 * 60000).all()).results) || []))
      if (blk.has(`${x.seller}|${x.pass}|${swapDay(Number(x.dueAt))}`)) { await db.prepare("UPDATE swap_160 SET status='cancelled', note=? WHERE id=? AND status='pending'").bind(`called off: @${x.seller} already gave that pass today`, x.id).run(); off1++; } } catch (e) {}
    await env.RATEBOARD_KV.put('outgive_clear_1119_n', JSON.stringify({ at: Date.now(), blocked: blk.size, off, off160: off1 }), { expirationTtl: 30 * 86400 }); } } catch (e) { try { await env.RATEBOARD_KV.put('outgive_clear_1119_n', JSON.stringify({ err: String(e.message || e).slice(0, 160) }), { expirationTtl: 86400 }); } catch (x) {} }
  /* One-off (2026-11-19 08:35 AK): today's swaps after the bot came back that repeat a swap from the bot-down hours
     (same two members, same cards, same swap day) are called off - those were done by hand. Same for 160s. */
  try { if (!(await env.RATEBOARD_KV.get('repeat_clear_1119'))) { await env.RATEBOARD_KV.put('repeat_clear_1119', String(Date.now()), { expirationTtl: 30 * 86400 });
    const n0 = Date.now(), since = n0 - 30 * 3600000;
    const down = ((await db.prepare("SELECT a, b, aGets, bGets, slot, createdAt, dueAt FROM swap_matches WHERE status IN ('cancelled','cancelling') AND note LIKE 'called off: the swap bot%' AND dueAt > ? AND dueAt < ?").bind(since, n0).all()).results) || [];
    const sg = (x, d) => x.a < x.b ? `${x.a}|${x.b}|${x.aGets}|${x.bGets}|${d}` : `${x.b}|${x.a}|${x.bGets}|${x.aGets}|${d}`;
    const had = new Set(down.map(x => sg(x, swapDay(sideDue(x)))));
    const up = ((await db.prepare("SELECT id, a, b, aGets, bGets, slot, createdAt, dueAt FROM swap_matches WHERE status IN ('pending','warned') AND dueAt >= ?").bind(n0 - 10 * 60000).all()).results) || [];
    let off = 0; for (const x of up) if (had.has(sg(x, swapDay(sideDue(x))))) { await db.prepare("UPDATE swap_matches SET status='cancelled', note='called off: you already did this swap earlier today' WHERE id=? AND status IN ('pending','warned')").bind(x.id).run(); off++; }
    let off1 = 0; try { const d1 = ((await db.prepare("SELECT buyer, seller, pass, dueAt FROM swap_160 WHERE status='cancelled' AND note LIKE 'called off: the swap bot%' AND dueAt > ? AND dueAt < ?").bind(since, n0).all()).results) || [];
      const h1 = new Set(d1.map(x => `${x.buyer}|${x.seller}|${x.pass}|${swapDay(Number(x.dueAt))}`));
      const u1 = ((await db.prepare("SELECT id, buyer, seller, pass, dueAt FROM swap_160 WHERE status IN ('pending','warned') AND dueAt >= ? AND (kind IS NULL OR kind <> 'niche')").bind(n0 - 10 * 60000).all()).results) || [];
      for (const x of u1) if (h1.has(`${x.buyer}|${x.seller}|${x.pass}|${swapDay(Number(x.dueAt))}`)) { await db.prepare("UPDATE swap_160 SET status='cancelled', note='called off: you already did this earlier today' WHERE id=? AND status IN ('pending','warned')").bind(x.id).run(); off1++; } } catch (e) {}
    await env.RATEBOARD_KV.put('repeat_clear_1119_n', JSON.stringify({ at: Date.now(), down: down.length, off, off160: off1 }), { expirationTtl: 30 * 86400 }); } } catch (e) { try { await env.RATEBOARD_KV.put('repeat_clear_1119_n', JSON.stringify({ err: String(e.message || e).slice(0, 120) }), { expirationTtl: 86400 }); } catch (x) {} }
  /* Bot down hold (Dennis, 2026-11-19 07:21 AK: "Stop all swaps for 8am until fixed" - Real rejects the bot's login).
     While held: no matching, no DMs, and every swap and 160 still ahead is called off. It lifts by itself as soon
     as the server has a different RS_SWAP_TOKEN (he puts a fresh one in .env and restarts). */
  try {
    let h = 0; for (const c of String(auth)) h = (h * 31 + c.charCodeAt(0)) | 0; const tok = (h >>> 0).toString(36);
    if (!(await env.RATEBOARD_KV.get('swaps_hold_set_1119'))) { await env.RATEBOARD_KV.put('swaps_hold_set_1119', '1', { expirationTtl: 30 * 86400 });
      await env.RATEBOARD_KV.put('swaps_hold', JSON.stringify({ at: Date.now(), tok, why: 'swap bot is logged out' })); }
    /* New bot account (Dennis, 2026-11-27: the bot moves to @rax.academy, the old bot does Bulk). The old bot's
       chats can't be used by the new one, so when the bot's token changes they're set aside (swap_dm_oldbot) and
       everyone verifies again by DMing the new bot #packswap - until then they aren't matched. */
    try { await db.prepare(VER_DDL).run(); } catch (e) {}
    { const seen = await env.RATEBOARD_KV.get('bot_tok_v1');
      if (!seen) await env.RATEBOARD_KV.put('bot_tok_v1', tok);
      else if (seen !== tok) { await env.RATEBOARD_KV.put('bot_tok_v1', tok);
        await db.prepare(DM_DDL).run();
        await db.prepare('CREATE TABLE IF NOT EXISTS swap_dm_oldbot (hashId TEXT PRIMARY KEY, userName TEXT, channelId INTEGER, openedAt INTEGER)').run();
        await db.prepare('INSERT OR REPLACE INTO swap_dm_oldbot SELECT hashId, userName, channelId, openedAt FROM swap_dm').run();
        const n = await db.prepare('SELECT COUNT(*) AS n FROM swap_dm').first();
        await db.prepare('DELETE FROM swap_dm').run();
        try { await env.RATEBOARD_KV.put('grpdm_stop', 'bot switched', { expirationTtl: 30 * 86400 }); } catch (e) {}   // giveaway sending was the old bot's chats; the Saturday check still runs
        await env.RATEBOARD_KV.put('bot_switch_1127', JSON.stringify({ at: Date.now(), setAside: n && n.n }), { expirationTtl: 30 * 86400 });
        await db.prepare("INSERT INTO bot_log (at, kind, msg) VALUES (?, 'match', ?)").bind(Date.now(), `new bot account: ${n && n.n} old chats set aside, everyone verifies again`).run().catch(() => {}); } }
    /* Swaps down by hand (Dennis, 2026-11-26 2:47pm AK: "feature is down, issue getting resolved"). A manual hold
       never lifts by itself - only when he says it's fixed (swaps_hold and swaps_down deleted). */
    if (!(await env.RATEBOARD_KV.get('swaps_down_set_1126'))) { await env.RATEBOARD_KV.put('swaps_down_set_1126', '1', { expirationTtl: 30 * 86400 });
      await env.RATEBOARD_KV.put('swaps_hold', JSON.stringify({ at: Date.now(), tok, manual: true, why: 'swaps down by Dennis' }));
      await env.RATEBOARD_KV.put('swaps_down', JSON.stringify({ at: Date.now(), msg: 'Feature is down, issue getting resolved. We\u2019ll post in the big group when it\u2019s fixed.' })); }
    // Swaps back on (Dennis, 2026-11-27 3:39am AK): the hand hold and its "feature is down" notice come off, once.
    if (!(await env.RATEBOARD_KV.get('swaps_down_lift_1127'))) { await env.RATEBOARD_KV.put('swaps_down_lift_1127', '1', { expirationTtl: 30 * 86400 });
      const h0 = JSON.parse((await env.RATEBOARD_KV.get('swaps_hold')) || 'null'); if (h0 && h0.manual) await env.RATEBOARD_KV.delete('swaps_hold');
      await env.RATEBOARD_KV.delete('swaps_down'); await db.prepare("INSERT INTO bot_log (at, kind, msg) VALUES (?, 'match', ?)").bind(Date.now(), 'hand hold lifted: swaps back on for verified members').run().catch(() => {}); }
    // Down again by hand (Dennis, 2026-11-27 7:19am AK): same hold and notice; lifted only when he says.
    if (!(await env.RATEBOARD_KV.get('swaps_down_set_1127b'))) { await env.RATEBOARD_KV.put('swaps_down_set_1127b', '1', { expirationTtl: 30 * 86400 });
      await env.RATEBOARD_KV.put('swaps_hold', JSON.stringify({ at: Date.now(), tok, manual: true, why: 'swaps down by Dennis' }));
      await env.RATEBOARD_KV.put('swaps_down', JSON.stringify({ at: Date.now(), msg: 'Feature is down, issue getting resolved. We\u2019ll post in the big group when it\u2019s fixed.' })); }
    const hold = JSON.parse((await env.RATEBOARD_KV.get('swaps_hold')) || 'null');
    if (hold && !hold.manual && hold.tok !== tok) { await env.RATEBOARD_KV.delete('swaps_hold'); await env.RATEBOARD_KV.put('swaps_hold_lifted', String(Date.now()), { expirationTtl: 30 * 86400 }); await db.prepare("INSERT INTO bot_log (at, kind, msg) VALUES (?, 'match', ?)").bind(Date.now(), 'hold lifted: new bot token').run().catch(() => {}); }
    else if (hold && !hold.manual && hold.probe && hold.probe.ok >= 2) { await env.RATEBOARD_KV.delete('swaps_hold'); await env.RATEBOARD_KV.put('swaps_hold_lifted', String(Date.now()), { expirationTtl: 30 * 86400 });
      await db.prepare("INSERT INTO bot_log (at, kind, msg) VALUES (?, 'match', ?)").bind(Date.now(), 'hold lifted: Real accepts the bot again').run().catch(() => {}); }
    else if (hold) {
      /* Is the bot let back in? A read-only look at its chat list every 2 min (no message sent). Two OKs in a row lift the hold. */
      if (!hold.probe || Date.now() - hold.probe.at > 120000) { let st = 0; try { const r = await fetch('https://web.realapp.com/messages/channels', { headers: rsHeaders(auth) }); st = r.status; } catch (e) { st = -1; }
        hold.probe = { at: Date.now(), status: st, ok: st >= 200 && st < 300 ? ((hold.probe && hold.probe.ok) || 0) + 1 : 0 }; }
      const n = Date.now(), note = hold.manual ? 'called off: swaps are down while an issue is fixed' : 'called off: the swap bot is down - swaps resume once it is fixed';
      const a = await db.prepare(`UPDATE swap_matches SET status='cancelled', note=? WHERE status IN ('pending','warned') AND dueAt > ?`).bind(note, n - 5 * 60000).run();
      const b = await db.prepare(`UPDATE swap_160 SET status='cancelled', note=? WHERE status IN ('pending','warned') AND dueAt > ?`).bind(note, n - 5 * 60000).run().catch(() => null);
      hold.off = (hold.off || 0) + ((a && a.meta && a.meta.changes) || 0); hold.off160 = (hold.off160 || 0) + ((b && b.meta && b.meta.changes) || 0); hold.last = n;
      await env.RATEBOARD_KV.put('swaps_hold', JSON.stringify(hold));
      return null; }
  } catch (e) {}
  try { await confirmBypass(env, db); } catch (e) {}
  /* Joke over (Dennis, 2026-11-17 21:36 AK): put back, once, the swaps and 160s it called off that are still ahead. */
  try { if (!(await env.RATEBOARD_KV.get('joke_restore_1117'))) { await env.RATEBOARD_KV.put('joke_restore_1117', String(Date.now()), { expirationTtl: 7 * 86400 });
    const a = await db.prepare("UPDATE swap_matches SET status='pending', note=NULL WHERE note='called off: no swaps tonight until 5am Alaska' AND status IN ('cancelling','cancelled') AND warnA IS NULL AND warnB IS NULL AND dueAt > ?").bind(Date.now() + 2 * 60000).run();
    const b = await db.prepare("UPDATE swap_160 SET status='pending', note=NULL WHERE note='no swaps tonight until 5am Alaska' AND status='cancelled' AND warnS IS NULL AND warnB IS NULL AND dueAt > ?").bind(Date.now() + 2 * 60000).run();
    await env.RATEBOARD_KV.put('joke_restore_1117', JSON.stringify({ at: Date.now(), m: (a.meta || {}).changes || 0, s: (b.meta || {}).changes || 0 }), { expirationTtl: 7 * 86400 }); } } catch (e) {}
  // Once an hour at :20 (before the :30 warnings). The claim is a database row (instant everywhere), not KV,
  // so two ticks can never both run matching in the same hour.
  const hour = new Date().toISOString().slice(0, 13);
  let mine = false;
  if (new Date().getUTCMinutes() >= 20) {
    try { await db.prepare('CREATE TABLE IF NOT EXISTS swap_runs (hour TEXT PRIMARY KEY, at INTEGER)').run();
      const c = await db.prepare('INSERT OR IGNORE INTO swap_runs (hour, at) VALUES (?, ?)').bind(hour, Date.now()).run();
      mine = !!(c && c.meta && c.meta.changes);
      /* A run that was cut off (no "done" row 3 minutes on) gets another go, up
         to :27 - the next hour's warnings go at :30 (2026-11-08). */
      if (!mine && new Date().getUTCMinutes() <= 27) {
        const r = await db.prepare('SELECT at FROM swap_runs WHERE hour=?').bind(hour).first();
        const done = await db.prepare('SELECT 1 AS x FROM swap_runs WHERE hour=?').bind(hour + ':done').first();
        if (r && !done && Number(r.at) < Date.now() - 180000) {
          const u = await db.prepare('UPDATE swap_runs SET at=? WHERE hour=? AND at=?').bind(Date.now(), hour, r.at).run();
          mine = !!(u && u.meta && u.meta.changes);
          if (mine) { try { await db.prepare("UPDATE run_lock SET until=0 WHERE k='match'").run(); } catch (e) {}
            try { await db.prepare("INSERT INTO bot_log (at, kind, msg) VALUES (?, 'match', ?)").bind(Date.now(), 'retrying: the last run was cut off').run(); } catch (e) {} }
        }
      } } catch (e) {}
  }
  if (mine) {
    try { await matchCols(db); } catch (e) {}
    const t0 = Date.now();
    try { await db.prepare("INSERT INTO bot_log (at, kind, msg) VALUES (?, 'match', ?)").bind(t0, 'run started').run(); } catch (e) {}
    try { const made = await runMatching(db, env, true); await stat(db, 'matches', made.length); await stat(db, 'match_runs');
      if (!made.skipped) { try { await db.prepare('INSERT OR IGNORE INTO swap_runs (hour, at) VALUES (?, ?)').bind(hour + ':done', Date.now()).run(); } catch (e) {} }
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
      try { await env.RATEBOARD_KV.delete('swap_hourcounts_v3'); await env.RATEBOARD_KV.delete('swap_wantcounts_v3'); } catch (e) {}
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
const MEMBER_OPS = new Set(['savewants', 'confirm', 'recbuys', 'myhour', 'me', 'save', 'keep', 'touch', 'giveprefs', 'packstoday', 'scan', 'scanstatus', 'search', 'connect', 'whynot', 'hourcounts', 'wantcounts', 'ownercounts', 'usersearch', 'report', 'myswaps', 'dropwant', 'pause', 'endall', 'saveslots']);
const OTD_OPS = new Set(['me', 'scan', 'scanstatus', 'games', 'boostplan', 'search', 'otdpool']);
// Open to every signed-in member: OTD's page, and the Rate Board's Exclude owned list (2026-11-25: members without Swaps got a 403 and "0 passes left out").
const PUBLIC_OPS = new Set(['projections', 'boardtop']);
const PRED_PUB_MEMO = { at: 0, text: '' };   // the EV page for signed-out visitors   // signed-out visitors (2026-11-27); grows as pages open up
const TEST_OTD_OPS = new Set(['boardtop', 'me', 'scan', 'scanstatus', 'games', 'search', 'otdpool', 'otdloadouts', 'mypassnames', 'myboardpasses', 'myboardall', 'bulkwatch', 'bulkplayers']);

/* ---------- Moderation (Dennis, 2026-11-11) ----------
   Reports on swap / 160 partners are counted automatically:
   - only a reporter's FIRST report on someone counts (repeats count for nothing);
   - a report only counts if the two really had a swap or 160 together that
     wasn't called off, at or before the report (the swap's time is its period);
   - the first counted report is a warning, not a strike;
   - every report after it is a strike, but all reports on one swap time
     make one strike between them (5 reports on 2:00 = 1 strike);
   - strike 3 takes Swaps away (swap_block) - nothing else on the site.
   Each new warning/strike is DMed through the bot's paced queue and shown
   on /swaps. An unban (Dennis, from Admin > Reports) starts their record over. */
const MOD_DDL = [
  'CREATE TABLE IF NOT EXISTS mod_events (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT, kind TEXT, n INTEGER, period INTEGER, at INTEGER, reports INTEGER)',
  'CREATE TABLE IF NOT EXISTS mod_state (key TEXT PRIMARY KEY, resetAt INTEGER, banned INTEGER, bannedAt INTEGER)',
  'CREATE TABLE IF NOT EXISTS unban_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT, text TEXT, ts INTEGER, status TEXT, answer TEXT)'];
const MOD_STRIKES = 3;
// Swap times whose reports count for nothing (Dennis, 2026-11-12: the 9:00am Alaska DMs didn't go out).
const MOD_VOID = new Set([Date.UTC(2026, 10, 12, 18, 0, 0)]);
/* Whole days whose reports count for nothing (Dennis, 2026-11-15: swap DMs went out
   late or not at all around 1pm ET). A report sent in the window, or about a swap in it. */
const MOD_VOID_DAYS = [[Date.UTC(2026, 10, 15, 5, 0, 0), Date.UTC(2026, 10, 16, 5, 0, 0)],
  /* Bot logged out (Dennis, 2026-11-19: "Invalidate all reports since the issue started"): from the first failed DM
     (about 3am Alaska) until the hold lifts - the end is set from KV when the new token is in (moderate()). */
  [Date.UTC(2026, 10, 19, 11, 55, 0), Date.UTC(2026, 10, 20, 12, 0, 0)]];   // the whole swap day (Dennis, 11:05 AK: "make reports hold 0 value for today")
const modVoidDay = t => MOD_VOID_DAYS.some(([a, b]) => t >= a && t < b);
const MOD_AUTO = true;   // false: the 10-minute run only previews (counts kept in KV); true: it acts
const MOD_EARLY = 10 * 60000;          // (old) a report may come up to 10 min before the swap's time
/* Revenge and rushed reports (Dennis, 2026-11-16, "well documented that there's revenge reports"):
   - a no-show report only counts from 20 min after the swap time (people get a fair chance to show);
   - two members reporting each other over the same swap: neither counts until Dennis decides;
   - a report against someone who reported you first, within 3 days: held for Dennis as likely payback;
   - a warning or strike Dennis removes on appeal stays removed (its reports never count again). */
const MOD_GRACE = 20 * 60000;
const MOD_VOIDED_KV = 'mod_voided_v1', MOD_FORCE_KV = 'mod_force_v1', MOD_HELD_KV = 'mod_held_v1';
const APPEAL_DDL = 'CREATE TABLE IF NOT EXISTS mod_appeals (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT, period INTEGER, kind TEXT, n INTEGER, text TEXT, ts INTEGER, status TEXT, answer TEXT)';
const kvObj = async (env, k) => { try { return JSON.parse((await env.RATEBOARD_KV.get(k)) || '{}') || {}; } catch (e) { return {}; } };
const MOD_LOOKBACK = 3 * 86400000;     // a report naming someone looks back 3 days for their swap
// In the member's own time zone (from their hours), else Eastern (Dennis, 2026-11-11).
const modTime = (ms, tz) => { for (const z of [tz, 'America/New_York']) { if (!z) continue;
    try { return new Date(ms).toLocaleString('en-US', { timeZone: z, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }); } catch (e) {} }
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'; };
async function modRows(db, sql, binds, order, size = 1000) {
  const out = [];
  for (let off = 0; off < 50000; off += size) {
    const r = ((await db.prepare(`${sql} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...binds, size, off).all()).results) || [];
    out.push(...r); if (r.length < size) break;
  }
  return out;
}
async function modReady(db) {
  for (const d of MOD_DDL) await db.prepare(d).run();
  await db.prepare(SREPORT_DDL).run();
  try { await alterOnce(db, 'ALTER TABLE swap_reports ADD COLUMN matchId INTEGER'); } catch (e) {}
  try { await alterOnce(db, 'ALTER TABLE swap_reports ADD COLUMN m160 INTEGER'); } catch (e) {}
}
async function modBan(db, key) {
  await db.prepare(SBLOCK_DDL).run();
  await db.prepare('INSERT OR REPLACE INTO swap_block (key, at) VALUES (?, ?)').bind(key, Date.now()).run();
  await db.prepare('UPDATE swap_users SET active=0 WHERE key=?').bind(key).run();
  const ms = ((await db.prepare("SELECT * FROM swap_matches WHERE status IN ('pending','warned') AND (a=? OR b=?)").bind(key, key).all()).results) || [];
  const res = { n: 0, late: 0, soon: 0 };
  for (const m of ms) await callOff(db, m, `called off: @${key} can no longer swap`, res);
  try { await db.prepare(`UPDATE swap_160 SET status='cancelled', note=? WHERE status='pending' AND warnS IS NULL AND warnB IS NULL AND dueAt > ? AND (buyer=? OR seller=?)`)
    .bind(`called off: @${key} can no longer swap`, Date.now(), key, key).run(); } catch (e) {}
  await db.prepare('INSERT INTO mod_state (key, resetAt, banned, bannedAt) VALUES (?, 0, 1, ?) ON CONFLICT(key) DO UPDATE SET banned=1, bannedAt=excluded.bannedAt').bind(key, Date.now()).run();
  ACCESS_MEMO.delete(key);
}
/* Members who can't send reports (Dennis, 2026-11-15): their new reports are
   refused and the ones they already sent stop counting. Keyed by account key. */
const RBLOCK_KV = 'report_block_v1';
async function reportBlocks(env) { try { return JSON.parse((await env.RATEBOARD_KV.get(RBLOCK_KV)) || '{}') || {}; } catch (e) { return {}; } }
async function reportBlocked(env, key) { return !!(await reportBlocks(env))[String(key || '').toLowerCase()]; }
async function moderate(env, db, dry) {
  let out0err = null;

  // One-off: take back what the bot-down window already gave (2026-11-19).
  if (!dry) { try { if (!(await env.RATEBOARD_KV.get('mod_void_1119b'))) { await env.RATEBOARD_KV.put('mod_void_1119b', String(Date.now()));   // b: run again for the whole day
    const a1 = MOD_VOID_DAYS[1][0];
    const hit = ((await db.prepare('SELECT DISTINCT key FROM mod_events WHERE period >= ? OR at >= ?').bind(a1, a1).all()).results) || [];
    await db.prepare('DELETE FROM mod_events WHERE period >= ? OR at >= ?').bind(a1, a1).run();
    let unb = 0;
    for (const { key } of hit) {
      const st0 = await db.prepare('SELECT banned, resetAt FROM mod_state WHERE key=?').bind(key).first();
      const left = await db.prepare("SELECT COUNT(*) AS n FROM mod_events WHERE key=? AND kind='strike' AND at >= ?").bind(key, Number((st0 && st0.resetAt) || 0)).first();
      if (st0 && st0.banned && Number((left && left.n) || 0) < MOD_STRIKES) {
        await db.prepare(SBLOCK_DDL).run(); await db.prepare('DELETE FROM swap_block WHERE key=?').bind(key).run();
        await db.prepare('UPDATE mod_state SET banned=0 WHERE key=?').bind(key).run(); try { ACCESS_MEMO.delete(key); } catch (e) {} unb++;
        await addNote(db, key, 'mod', "Today's Swaps reports don't count - the swap bot was logged out, so DMs didn't go. The strikes from today are removed and your Swaps access is back. Turn your swaps back on at raxacademy.app/swaps");
      } else await addNote(db, key, 'mod', "Today's Swaps reports don't count - the swap bot was logged out, so DMs didn't go. Any warning or strike from today has been removed.");
    }
    await env.RATEBOARD_KV.put('mod_void_1119_n', JSON.stringify({ at: Date.now(), members: hit.length, unbanned: unb }), { expirationTtl: 14 * 86400 });
  } } catch (e) { out0err = String(e.message || e); } }
  await modReady(db); await matchCols(db); await db.prepare(T160_DDL).run(); await db.prepare(DM_DDL).run();
  if (!dry) { try { if (!(await env.RATEBOARD_KV.get('rate_recheck_v1'))) { const f = await rateRecheck(env, db); await env.RATEBOARD_KV.put('rate_recheck_v1', JSON.stringify({ at: Date.now(), freed: f })); } } catch (e) {} }
  // One-off: take back what today's reports already gave (warnings, strikes, a ban from them).
  if (!dry) { try { if (!(await env.RATEBOARD_KV.get('mod_void_1115'))) { await env.RATEBOARD_KV.put('mod_void_1115', String(Date.now()));
    const [a0, b0] = MOD_VOID_DAYS[0];
    const hit = ((await db.prepare('SELECT DISTINCT key FROM mod_events WHERE (period >= ? AND period < ?) OR (at >= ? AND at < ?)').bind(a0, b0, a0, b0).all()).results) || [];
    await db.prepare('DELETE FROM mod_events WHERE (period >= ? AND period < ?) OR (at >= ? AND at < ?)').bind(a0, b0, a0, b0).run();
    let unb = 0;
    for (const { key } of hit) {
      const st0 = await db.prepare('SELECT banned, bannedAt, resetAt FROM mod_state WHERE key=?').bind(key).first();
      const left = await db.prepare("SELECT COUNT(*) AS n FROM mod_events WHERE key=? AND kind='strike' AND at >= ?").bind(key, Number((st0 && st0.resetAt) || 0)).first();
      if (st0 && st0.banned && Number((left && left.n) || 0) < MOD_STRIKES) {
        await db.prepare(SBLOCK_DDL).run(); await db.prepare('DELETE FROM swap_block WHERE key=?').bind(key).run();
        await db.prepare('UPDATE mod_state SET banned=0 WHERE key=?').bind(key).run(); try { ACCESS_MEMO.delete(key); } catch (e) {} unb++;
        await addNote(db, key, 'mod', "Today's Swaps reports don't count - the bot's swap DMs were late. The strikes from today are removed and your Swaps access is back. Turn your swaps back on at raxacademy.app/swaps");
      } else await addNote(db, key, 'mod', "Today's Swaps reports don't count - the bot's swap DMs were late. Any warning or strike from today has been removed.");
    }
    await env.RATEBOARD_KV.put('mod_void_1115_n', JSON.stringify({ at: Date.now(), members: hit.length, unbanned: unb }));
  } } catch (e) { out0err = String(e.message || e); } }
  const rb = await reportBlocks(env);
  const reps = (await modRows(db, "SELECT rowid AS id, ts, by_user, target, matchId, m160 FROM swap_reports WHERE kind='user' AND status IN ('open','closed','auto')", [], 'ts, rowid'))
    .filter(r => !rb[String(r.by_user || '').toLowerCase()]);   // reporters whose reporting was taken away
  const out = { reports: reps.length, counted: 0, repeats: 0, noSwap: 0, calledOff: 0, early: 0, warned: 0, struck: 0, banned: 0, dms: 0, users: [] };
  if (!reps.length) return out;
  const since = Math.min(...reps.map(r => Number(r.ts) || 0)) - MOD_LOOKBACK;
  const [users, ms, ss, st, ev, dmr] = await Promise.all([
    modRows(db, 'SELECT key, rsUser, hashId, sched FROM swap_users', [], 'key'),
    modRows(db, 'SELECT id, a, b, aGets, bGets, slot, createdAt, dueAt, status FROM swap_matches WHERE COALESCE(dueAt, createdAt) >= ?', [since], 'id', 2000),
    modRows(db, 'SELECT id, buyer, seller, pass, kind, dueAt, status FROM swap_160 WHERE dueAt >= ?', [since], 'id', 2000),
    modRows(db, 'SELECT key, resetAt, banned FROM mod_state', [], 'key'),
    modRows(db, 'SELECT key, kind, n, at FROM mod_events', [], 'id'),
    modRows(db, 'SELECT hashId, channelId FROM swap_dm WHERE channelId IS NOT NULL', [], 'hashId', 2000)]);
  for (const m of ms) m.dueAt = sideDue(m);
  const lc = x => String(x || '').trim().replace(/^@/, '').toLowerCase();
  const byName = new Map(); for (const u of users) { byName.set(lc(u.key), u); if (u.rsUser) byName.set(lc(u.rsUser), u); }
  const byKey = new Map(users.map(u => [u.key, u]));
  const off = s => /cancel/.test(String(s || ''));
  const mById = new Map(ms.map(m => [Number(m.id), m])), sById = new Map(ss.map(s => [Number(s.id), s]));
  // Every swap / 160 between two members, for reports that only name someone.
  const pairs = new Map(), addPair = (x, y, t) => { const k = x + '|' + y; if (!pairs.has(k)) pairs.set(k, []); pairs.get(k).push(t); };
  for (const m of ms) if (!off(m.status)) { addPair(m.a, m.b, Number(m.dueAt)); addPair(m.b, m.a, Number(m.dueAt)); }
  for (const s of ss) if (!off(s.status)) { addPair(s.buyer, s.seller, Number(s.dueAt)); addPair(s.seller, s.buyer, Number(s.dueAt)); }
  const state = new Map(st.map(s => [s.key, s]));
  /* Reports that can't count close themselves, and the reporter is told why (Dennis, 2026-11-27: "shouldn't swap
     reports be auto resolved for the most part?"): the swap was called off, or no swap between them was found. */
  const shut = [];
  const first = new Map(), handled = [], voided = await kvObj(env, MOD_VOIDED_KV), force = await kvObj(env, MOD_FORCE_KV);
  for (const r of reps) {
    const by = String(r.by_user || ''), ts = Number(r.ts) || 0;
    let tgt = null, period = null, src = null;
    if (r.m160) {
      const s = sById.get(Number(r.m160));
      if (!s || (s.buyer !== by && s.seller !== by)) { out.noSwap++; shut.push({ r, why: 'noswap' }); continue; }
      if (off(s.status)) { out.calledOff++; shut.push({ r, why: 'off' }); continue; }
      tgt = s.buyer === by ? s.seller : s.buyer; period = Number(s.dueAt); src = { s, by };
    } else if (r.matchId) {
      const m = mById.get(Number(r.matchId));
      if (!m || (m.a !== by && m.b !== by)) { out.noSwap++; shut.push({ r, why: 'noswap' }); continue; }
      if (off(m.status)) { out.calledOff++; shut.push({ r, why: 'off' }); continue; }
      tgt = m.a === by ? m.b : m.a; period = Number(m.dueAt); src = { m, by };
    } else {
      const u = byName.get(lc(r.target)); if (!u || u.key === by) { out.noSwap++; shut.push({ r, why: 'noswap' }); continue; }
      const times = (pairs.get(by + '|' + u.key) || []).filter(t => t <= ts + MOD_EARLY && t >= ts - MOD_LOOKBACK);
      if (!times.length) { out.noSwap++; shut.push({ r, why: 'noswap' }); continue; }
      tgt = u.key; period = Math.max(...times);
      const m = ms.find(x => !off(x.status) && Number(x.dueAt) === period && ((x.a === by && x.b === tgt) || (x.b === by && x.a === tgt)));
      const s1 = m ? null : ss.find(x => !off(x.status) && Number(x.dueAt) === period && ((x.buyer === by && x.seller === tgt) || (x.seller === by && x.buyer === tgt)));
      src = m ? { m, by } : s1 ? { s: s1, by } : null;
    }
    if (ts < period + MOD_GRACE) { out.early++; continue; }
    if (voided[`${tgt}|${period}`]) { out.appealed = (out.appealed || 0) + 1; handled.push(r.id); continue; }
    if (MOD_VOID.has(Number(period)) || modVoidDay(Number(period)) || modVoidDay(ts)) { out.voided = (out.voided || 0) + 1; handled.push(r.id); continue; }
    const s0 = state.get(tgt); if (s0 && ts < Number(s0.resetAt || 0)) { handled.push(r.id); continue; }
    const k = by + '|' + tgt;
    if (first.has(k)) { out.repeats++; handled.push(r.id); continue; }
    first.set(k, { by, tgt, period, ts, src, id: r.id }); handled.push(r.id); out.counted++;
  }
  // Holds: mutual reports over one swap, and payback reports (see MOD_GRACE above). Dennis can count one anyway.
  const held = [];
  for (const [k, x] of [...first.entries()]) {
    const back = first.get(x.tgt + '|' + x.by), fk = `${x.by}|${x.tgt}|${x.period}`;
    if (!back || force[fk]) continue;
    let why = null;
    if (back.period === x.period) why = 'both reported each other for the same swap';
    else if (back.ts < x.ts && x.ts - back.ts < 3 * 86400000) why = 'reported someone who had reported them first';
    if (why) held.push({ k: fk, by: x.by, tgt: x.tgt, period: x.period, ts: x.ts, why, id: x.id });
  }
  for (const h of held) { first.delete(h.by + '|' + h.tgt); out.counted--; out.held = (out.held || 0) + 1; }
  if (!dry) { try { const byK = new Map(users.map(u => [u.key, u.rsUser || u.key])); await env.RATEBOARD_KV.put(MOD_HELD_KV, JSON.stringify(held.map(h => ({ ...h, byName: byK.get(h.by) || h.by, tgtName: byK.get(h.tgt) || h.tgt })))); } catch (e) {} }
  // Per reported member: their warning and strikes, in order.
  const per = new Map();
  for (const x of first.values()) { if (!per.has(x.tgt)) per.set(x.tgt, []); per.get(x.tgt).push(x); }
  const had = new Map();
  for (const e of ev) { const s0 = state.get(e.key); if (s0 && Number(e.at) < Number(s0.resetAt || 0)) continue;
    const h = had.get(e.key) || { warn: false, strikes: 0 }; if (e.kind === 'warn') h.warn = true; else if (e.kind === 'strike') h.strikes = Math.max(h.strikes, Number(e.n) || 0); had.set(e.key, h); }
  const chan = new Map(dmr.map(d => [String(d.hashId), d.channelId]));
  let acted = 0; if (!dry) await db.prepare(DMQ_DDL).run();
  for (const [key, list] of per) {
    list.sort((a, b) => a.ts - b.ts);
    const want = [{ kind: 'warn', n: 0, period: list[0].period, at: list[0].ts, reports: 1, src: list[0].src }];
    const struck = new Map();
    for (let i = 1; i < list.length; i++) { const p = list[i].period;
      if (struck.has(p)) { struck.get(p).reports++; continue; }
      if (struck.size >= MOD_STRIKES) continue;
      const e = { kind: 'strike', n: struck.size + 1, period: p, at: list[i].ts, reports: 1, src: list[i].src }; struck.set(p, e); want.push(e); }
    const h = had.get(key) || { warn: false, strikes: 0 };
    const fresh = want.filter(e => e.kind === 'warn' ? !h.warn : e.n > h.strikes);
    const s0 = state.get(key), nowStrikes = Math.max(h.strikes, ...want.filter(e => e.kind === 'strike').map(e => e.n), 0);
    const ban = nowStrikes >= MOD_STRIKES && !(s0 && s0.banned);
    const u = byKey.get(key);
    out.users.push({ key, rsUser: (u && u.rsUser) || key, reports: list.length, strikes: nowStrikes, warned: true, newEvents: fresh.length, ban });
    if (!fresh.length && !ban) continue;
    for (const e of fresh) { if (e.kind === 'warn') out.warned++; else out.struck++; }
    if (ban) out.banned++;
    if (dry) continue;
    // A run does at most 20 members (it was cut off doing 60+ one by one); the next run carries on.
    if (++acted > 20) { out.more = true; continue; }
    const stmts = fresh.map(e => db.prepare('INSERT INTO mod_events (key, kind, n, period, at, reports) VALUES (?, ?, ?, ?, ?, ?)').bind(key, e.kind, e.n, e.period, Date.now(), e.reports));
    if (ban) await modBan(db, key);
    // One message with everything new for them.
    const tz = ((u && parse(u.sched, null)) || {}).tz;
    /* Which swap it was, not just the time (a member, 2026-11-12: "I did every
       swap - say which one"): who reported and the players both ways. */
    const me0 = fresh.some(e => e.src) ? await loadMember(db, key).catch(() => null) : null;
    const which = e => { const x = e.src; if (!x) return '';
      const rep0 = byKey.get(x.by), rn = '@' + ((rep0 && rep0.rsUser) || x.by);
      if (x.m) { const give = x.m.a === key ? x.m.bGets : x.m.aGets, get = x.m.a === key ? x.m.aGets : x.m.bGets;
        return ` (swap with ${rn}: you give ${me0 ? playerName(me0, give) : give}, you get ${me0 ? playerName(me0, get) : get})`; }
      if (x.s) return x.s.seller === key ? ` (160 with ${rn}: you sell ${me0 ? playerName(me0, x.s.pass) : x.s.pass})` : ` (160 with ${rn}: you buy their ${me0 ? playerName(me0, x.s.pass) : x.s.pass})`;
      return ''; };
    const lines = fresh.map(e => e.kind === 'warn'
      ? `You've been reported for not completing a swap at ${modTime(e.period, tz)}${which(e)}. This is a warning, not a strike.`
      : `You've been reported for not doing swaps at ${modTime(e.period, tz)}${which(e)}. Strike ${e.n}/${MOD_STRIKES}.`);
    if (ban) lines.push(`That's ${MOD_STRIKES} strikes, so your Swaps access has been removed (the rest of the site still works). You can request an unban at raxacademy.app/swaps`);
    if (lines.length) await addNote(db, key, 'mod', lines.join('\n'));
    const ch = u && u.hashId && chan.get(String(u.hashId));
    if (ch && lines.length) { stmts.push(db.prepare('INSERT INTO dm_retry (channelId, parts, label, tries, at) VALUES (?, ?, ?, 0, ?)').bind(Number(ch), JSON.stringify([lines.join('\n')]), 'mod ' + key, Date.now())); out.dms++; }
    await db.batch(stmts);
  }
  if (!dry) for (let i = 0; i < handled.length; i += 80) {
    const ids = handled.slice(i, i + 80);
    await db.prepare(`UPDATE swap_reports SET status='auto' WHERE status='open' AND rowid IN (${ids.map(() => '?').join(',')})`).bind(...ids).run();
  }
  if (!dry) for (const { r, why } of shut.slice(0, 60)) {
    const c = await db.prepare("UPDATE swap_reports SET status='auto' WHERE status='open' AND rowid=?").bind(r.id).run().catch(() => null);
    if (!(c && c.meta && c.meta.changes)) continue;
    out.autoClosed = (out.autoClosed || 0) + 1;
    const who = r.target ? '@' + String(r.target).replace(/^@/, '') : 'your partner';
    await addNote(db, r.by_user, 'mod', why === 'off'
      ? `Your Swaps report on ${who} was closed: that swap was called off before it happened, so it doesn't count against them.`
      : `Your Swaps report on ${who} was closed: there's no swap between you two around that time, so it can't count. Reports need to be about a swap you were matched in.`);
  }
  if (!dry) try { await env.RATEBOARD_KV.put('mod_summary_v1', JSON.stringify({ at: Date.now(), reports: out.reports, counted: out.counted, warned: out.warned, struck: out.struck, banned: out.banned, autoClosed: out.autoClosed || 0, noSwap: out.noSwap, calledOff: out.calledOff, held: out.held || 0, early: out.early })); } catch (e) {}
  return out;
}
// A member's own record: warnings, strikes, ban and unban request.
async function modRecord(db, key) {
  await modReady(db);
  const s0 = await db.prepare('SELECT resetAt, banned FROM mod_state WHERE key=?').bind(key).first();
  const evs = ((await db.prepare('SELECT kind, n, period, reports FROM mod_events WHERE key=? AND at >= ? ORDER BY id').bind(key, Number((s0 && s0.resetAt) || 0)).all()).results) || [];
  const req = await db.prepare('SELECT status, ts, answer FROM unban_requests WHERE key=? ORDER BY id DESC LIMIT 1').bind(key).first();
  let aps = []; try { await db.prepare(APPEAL_DDL).run(); aps = ((await db.prepare('SELECT period, status, answer FROM mod_appeals WHERE key=? ORDER BY id DESC').bind(key).all()).results) || []; } catch (e) {}
  const apOf = p => aps.find(a => Number(a.period) === Number(p)) || null;
  return { banned: !!(s0 && s0.banned), strikes: evs.filter(e => e.kind === 'strike').length, max: MOD_STRIKES,
    events: evs.map(e => ({ kind: e.kind, n: e.n, at: e.period, when: modTime(e.period), reports: e.reports, appeal: apOf(e.period) })), request: req || null };
}
const BOOST_OPS = new Set(['me', 'scan', 'scanstatus', 'boostplan', 'boostdays', 'projections', 'tagview', 'boostinv', 'buys', 'legboosts', 'resell', 'nosell']);
const BOOSTS_OPEN = true;   // opened to everyone signed in, 2026-11-02
const PAGE_OPS = new Set(['projections', 'me', 'procheck', 'myswaps', 'hourcounts', 'wantcounts', 'boostplan', 'boostinv', 'buys', 'legboosts', 'resell', 'boostdays']);

/* ---- OTD: saved game lists ------------------------------------------------
   Every player's [MM-DD, rax] list for a whole sport-season, built once from
   the game log and kept in KV. A finished season never changes, so its copy
   is kept for good; a season still being played is rebuilt once a day (after
   the morning sweep has added the new games). */
const OTD_LIVE = new Set(['nba:2027', 'ncaam:2027', 'nfl:2026', 'ncaaf:2026', 'nhl:2026', 'soccer:2026', 'golf:2026']);
/* OTD games for one member (Dennis, 2026-11-25: "I waited over a minute ... speed this up now"). What made it slow:
   team and UFC passes were read from Real one at a time while you waited, and a live season's game list was rebuilt
   from the whole game log while you waited. Now nothing is ever fetched while a page waits:
   - team/UFC numbers come from what's stored; anything missing is queued and fetched in the background;
   - a stale live season is served from its last copy and rebuilt in the background;
   - each member's answer is kept (6 hours, or 3 minutes while something is still being fetched) and kept built in
     the background for everyone who has opened OTD. */
const OTD_TEAM_DDL = `CREATE TABLE IF NOT EXISTS swap_teamrax (sport TEXT, season INTEGER, teamId INTEGER, days TEXT, at INTEGER, PRIMARY KEY (sport, season, teamId))`;
async function otdGamesFor(env, db, me, passes, extra, fresh) {
  const groups = {};
  for (const p of passes) if (p.kind !== 'team') (groups[`${p.sport}|${p.season}`] = groups[`${p.sport}|${p.season}`] || []).push(p.id);
  for (const k of String(extra || '').split(',').filter(x => /^[a-z]+:\d{4}:\d+$/.test(x)).slice(0, 60)) { const [sp, se, id] = k.split(':'); (groups[`${sp}|${se}`] = groups[`${sp}|${se}`] || []).push(Number(id)); }
  const teams = passes.filter(p => p.kind === 'team');
  const sig = (() => { let h = 5381; const t = Object.entries(groups).map(([g, ids]) => g + ':' + ids.slice().sort((a, b) => a - b).join(',')).sort().join('|') + '#' + teams.map(p => p.key).sort().join(','); for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0; return h + ':' + t.length; })();
  const gKey = 'otd_games_u2_' + String(me).toLowerCase();
  if (!fresh) { try { const c = JSON.parse((await env.RATEBOARD_KV.get(gKey)) || 'null'); if (c && c.sig === sig && Date.now() - c.at < (c.pending ? 3 * 60000 : 6 * 3600000)) return c; } catch (e) {} }
  const out = {}; let pending = 0;
  if (teams.length) {
    await db.prepare(OTD_TEAM_DDL).run();
    const have = new Map(); for (const r of ((await db.prepare('SELECT sport, season, teamId, days, at FROM swap_teamrax').all()).results || [])) have.set(`${r.sport}:${r.season}:${r.teamId}`, r);
    const want = [];
    for (const t of teams) { const r = have.get(`${t.sport}:${t.season}:${t.id}`); const days = r ? parse(r.days, []) : null;
      if (days && days.length) out[t.key] = days; if (!r) { pending++; want.push(`${t.sport}:${t.season}:${t.id}`); } }
    if (want.length) { try { const Q = JSON.parse((await env.RATEBOARD_KV.get('otd_team_queue_v1')) || '[]') || []; const set = new Set(Q); want.forEach(w => set.add(w)); await env.RATEBOARD_KV.put('otd_team_queue_v1', JSON.stringify([...set].slice(-3000))); } catch (e) {} }
  }
  for (const [g, ids] of Object.entries(groups)) { const [sp, se] = g.split('|'); const games = await otdSeason(env, db, sp, Number(se)); for (const id of ids) { const v = games[id]; if (v && v.length) out[`${sp}:${se}:${id}`] = v; } }
  const rec = { sig, at: Date.now(), pending, games: out };
  if (!extra) try { await env.RATEBOARD_KV.put(gKey, JSON.stringify(rec), { expirationTtl: 7 * 86400 }); } catch (e) {}
  return rec;
}
/* Background, every minute (not awaited by the tick):
   1. Team and UFC numbers from Real, a few at a time with the bot: anything never fetched; a live team season again
      after a day. UFC (Dennis, 2026-11-25: "only rescan and refresh UFC numbers Sunday after fights and only what
      wasn't already scanned"): a fighter is fetched once, and after that only on a Sunday (Alaska) when he fought
      that weekend - from ESPN's UFC results for Friday-Saturday. Past seasons never change, so they're never fetched again.
   2. Live seasons whose saved game list is over a day old are rebuilt.
   3. Each member who opened OTD gets their copy rebuilt when it's missing or due. */
export async function otdBackground(env) {
  const db = env.RATEBOARD_DB; if (!db) return;
  const LK = 'otd_bg_lock'; try { const l = Number(await env.RATEBOARD_KV.get(LK)); if (l && Date.now() - l < 55000) return; await env.RATEBOARD_KV.put(LK, String(Date.now()), { expirationTtl: 120 }); } catch (e) { return; }
  const t0 = Date.now(), soon = ms => Date.now() - t0 < ms;
  const st = { at: Date.now(), fetched: 0, failed: 0, seasons: 0, users: 0 };
  try {
    await db.prepare(OTD_TEAM_DDL).run();
    const auth = swapToken(env); let hold = false; try { hold = !!(await env.RATEBOARD_KV.get('swaps_hold')); } catch (e) {}
    let Q = []; try { Q = JSON.parse((await env.RATEBOARD_KV.get('otd_team_queue_v1')) || '[]') || []; } catch (e) {}
    // Live team seasons over a day old go back in the queue (not UFC: Sundays only, below).
    try { for (const r of ((await db.prepare('SELECT sport, season, teamId, at FROM swap_teamrax WHERE sport != ? AND at < ?').bind('ufc', Date.now() - 86400000).all()).results || []))
      if (OTD_LIVE.has(`${r.sport}:${r.season}`)) Q.push(`${r.sport}:${r.season}:${r.teamId}`); } catch (e) {}
    // Sunday in Alaska, after the weekend's fights: only the fighters who fought.
    const ak = new Date(Date.now() - 9 * 3600000), sunKey = ak.toISOString().slice(0, 10);
    if (ak.getUTCDay() === 0 && ak.getUTCHours() >= 6) { let done = null; try { done = await env.RATEBOARD_KV.get('otd_ufc_sun_v1'); } catch (e) {}
      if (done !== sunKey) { try {
        const names = new Set(); const nm = v => String(v || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]/g, '');
        for (const back of [1, 2]) { const d = new Date(ak.getTime() - back * 86400000).toISOString().slice(0, 10).replace(/-/g, '');
          try { const j = await (await fetch(`https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard?dates=${d}`)).json();
            for (const ev of (j.events || [])) for (const c of (ev.competitions || [])) for (const x of (c.competitors || [])) { const a = x.athlete || {}; if (a.displayName) names.add(nm(a.displayName)); } } catch (e) {} }
        const fought = new Set();
        for (const r of ((await db.prepare('SELECT passes FROM swap_users WHERE passes IS NOT NULL').all()).results || [])) for (const p of parse(r.passes, [])) if (p.sport === 'ufc' && p.kind === 'team' && Number(p.season) === ak.getUTCFullYear() && names.has(nm(p.name))) fought.add(`ufc:${p.season}:${p.id}`);   // this year's pass: past seasons never change
        fought.forEach(k => Q.push(k)); st.ufcFought = fought.size; st.ufcNames = names.size;
        await env.RATEBOARD_KV.put('otd_ufc_sun_v1', sunKey, { expirationTtl: 8 * 86400 });
      } catch (e) {} } }
    Q = [...new Set(Q)];
    if (auth && !hold) {
      while (Q.length && soon(35000)) { const k = Q.shift(), [sp, se, id] = k.split(':');
        try { const d = await rsGetJson(`https://web.realapp.com/userpassearnings/${sp}/season/${se}/entity/team/${id}`, auth);
          const days = ((d && d.earnings) || []).filter(e => e && e.day && Number(e.earnings) > 0).map(e => [String(e.day).slice(5, 10), Number(e.earnings)]);
          await db.prepare('INSERT OR REPLACE INTO swap_teamrax (sport, season, teamId, days, at) VALUES (?, ?, ?, ?, ?)').bind(sp, Number(se), Number(id), JSON.stringify(days), Date.now()).run(); st.fetched++;
        } catch (e) { st.failed++; if (/401|403|429/.test(String(e.message || e))) { Q.unshift(k); break; } }
        await sleep(700); }
    }
    try { await env.RATEBOARD_KV.put('otd_team_queue_v1', JSON.stringify(Q.slice(0, 3000))); } catch (e) {}
    st.queued = Q.length;
    // 2. Live seasons due a rebuild.
    for (const job of OTD_LIVE) { if (!soon(45000)) break; try { const c = JSON.parse((await env.RATEBOARD_KV.get('otdseason_v1_' + job)) || 'null'); if (c && Date.now() - c.at < 24 * 3600000) continue; const [sp, se] = job.split(':'); await otdSeason(env, db, sp, Number(se), true); st.seasons++; } catch (e) {} }
    // 3. Members who opened OTD in the last two weeks: copy missing or due.
    let L = {}; try { L = JSON.parse((await env.RATEBOARD_KV.get('otd_users_v1')) || '{}') || {}; } catch (e) {}
    if (!L.dennis || Date.now() - L.dennis > 86400000) L.dennis = Date.now();   // the page is his for now: always kept built
    for (const [who, seen] of Object.entries(L)) { if (!soon(52000)) break; if (Date.now() - seen > 14 * 86400000) continue;
      try { const c = JSON.parse((await env.RATEBOARD_KV.get('otd_games_u2_' + who)) || 'null'); if (c && Date.now() - c.at < (c.pending ? 3 * 60000 : 5 * 3600000)) continue;
        const u = await db.prepare('SELECT passes FROM swap_users WHERE LOWER(key)=?').bind(who).first(); if (!u) continue;
        await otdGamesFor(env, db, who, parse(u.passes, []), '', true); st.users++; } catch (e) {} }
  } catch (e) { st.err = String(e.message || e).slice(0, 120); }
  st.ms = Date.now() - t0; try { await env.RATEBOARD_KV.put('otd_bg_last', JSON.stringify(st), { expirationTtl: 86400 }); } catch (e) {}
}
export async function otdSeason(env, db, sp, se, force) {
  const job = `${sp}:${se}`, key = 'otdseason_v2_' + job;
  let c = null;
  if (!force) { try { c = JSON.parse((await env.RATEBOARD_KV.get(key)) || 'null'); } catch (e) {} }
  if (c && c.games && (!OTD_LIVE.has(job) || Date.now() - c.at < 24 * 3600000 || !force)) return c.games;   // a stale live copy is still served; otdBackground rebuilds it
  const games = {};
  try {
    // One claim per player per day: a doubleheader's rax once, never twice (Dennis, 2026-11-25).
    const r = await db.prepare(`SELECT playerId, substr(day, 6, 5) AS d, MAX(rax) AS rax FROM gamelog
      WHERE sport=? AND season=? AND rax > 0 GROUP BY playerId, day`).bind(sp, se).all();
    for (const x of (r.results || [])) (games[x.playerId] = games[x.playerId] || []).push([x.d, x.rax]);
  } catch (e) { return (c && c.games) || {}; }
  try { await env.RATEBOARD_KV.put(key, JSON.stringify({ at: Date.now(), games })); } catch (e) {}
  return games;
}

/* Boosts: current season and the one before, per sport (Real's numbering). */
const BOOST_SEASON = { ncaam: [2027, 2026], ncaaf: [2026, 2025], nfl: [2026, 2025], nba: [2027, 2026], nhl: [2026, 2025] };   // NBA and NHL added 2026-11-09
/* Booster thresholds on projected rax for the game, per sport, set from
   last season's rax per game among regulars: Legendary is roughly the top
   2-3% of games, Epic the top 10%, Rare the top 25%. Boost saver raises the
   bar 15%, earning heavy lowers it 15%. */
const BOOST_BARS = { ncaam: [11.5, 10, 7.5], ncaaf: [25, 20, 12], nfl: [19, 15, 8.5], golf: [19, 15, 10], soccer: [11.2, 9, 6], nba: [99, 7.5, 4], nhl: [99, 7.5, 4] };   // Legendary ~top 1% game, Epic ~top 3-5%
const BOOST_MODES = { balanced: 1, heavy: 1, saver: 1, custom: 1 };
const ESPN_PATH = { ncaam: 'basketball/mens-college-basketball', ncaaf: 'football/college-football', nfl: 'football/nfl', nba: 'basketball/nba', nhl: 'hockey/nhl' };
const ESPN_GROUP = { ncaam: '&groups=50', ncaaf: '&groups=80', nfl: '', nba: '', nhl: '' };
// Where Real's team code differs from ESPN's.
const BOOST_ALIAS = { WISC: 'WIS', NCST: 'NCSU', BUT: 'BTLR', BSU: 'BOIS', AFA: 'AF', BUFF: 'BUF', HP: 'HPU', CHIC: 'CHST',
  CAMP: 'CAM', CLEV: 'CLE', ALB: 'UALB', IUPU: 'IUIN', ULL: 'UL', PRE: 'PRES', UALR: 'LR', SCUP: 'UPST', TAMC: 'AMCC',
  HBU: 'HCU', NIAG: 'NIA', DXST: 'UTU', IND: 'IU', JVST: 'JXST', WAS: 'WSH' };
/* Per sport (2026-11-09): the college list sent the NFL's IND (Colts) to IU,
   so Colts players never found their game. Pro leagues get their own. */
const BOOST_ALIAS_BY = { ncaam: BOOST_ALIAS, ncaaf: BOOST_ALIAS, nfl: { WAS: 'WSH' },
  nba: { GSW: 'GS', NOP: 'NO', NYK: 'NY', SAS: 'SA', UTA: 'UTAH', WAS: 'WSH', VICE: 'MIA' },
  nhl: { LAK: 'LA', NJD: 'NJ', SJS: 'SJ', TBL: 'TB', UTA: 'UTAH' } };
const boostAlias = (sp, t) => (BOOST_ALIAS_BY[sp] || BOOST_ALIAS)[t] || t;
/* Schedules, injury reports and depth charts are fetched by the daily
   refresh (boostRefresh, on the collector tick) and saved; a member's request
   only reads the saved copies. Only if a copy is missing altogether is it
   fetched once, and saved for everyone. */
async function boostSchedule(env, sp, day, force) {
  const key = `boostsched_v2_${sp}_${day}`;
  /* Kept an hour, not for good (2026-11-25: CBB holiday tournaments fill in their later rounds once the first ones
     finish - a copy saved days earlier had those games as TBD, so those teams' players showed no game). Days already
     over keep their copy. If ESPN fails, the saved copy is used. */
  let c0 = null; try { c0 = JSON.parse((await env.RATEBOARD_KV.get(key)) || 'null'); } catch (e) {}
  const past = day < new Date(Date.now() - 36 * 3600000).toISOString().slice(0, 10);
  if (!force && c0 && (past || Date.now() - (Number(c0.at) || 0) < 3600000)) return boostSchedAlias(sp, c0);
  let d;
  try {
    const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${ESPN_PATH[sp]}/scoreboard?dates=${day.replace(/-/g, '')}&limit=500${ESPN_GROUP[sp]}`);
    if (!r.ok) return c0 ? boostSchedAlias(sp, c0) : { error: 'Could not load the schedule (' + r.status + ').' };
    d = await r.json();
  } catch (e) { return c0 ? boostSchedAlias(sp, c0) : { error: 'Could not load the schedule.' }; }
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
  return boostSchedAlias(sp, out);
}
/* ESPN's scoreboard calls Utah "UTA" while its team list says "UTAH"
   (2026-11-12: Mammoth players showed as having no game). Every schedule is
   reachable under both spellings of each aliased code. */
function boostSchedAlias(sp, s) {
  const t = s && s.teams; if (!t) return s;
  for (const [a, b] of Object.entries(BOOST_ALIAS_BY[sp] || {})) {
    if (t[a] && !t[b]) t[b] = t[a];
    else if (t[b] && !t[a]) t[a] = t[b];
  }
  return s;
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
  const minSql = sp === 'ncaam' || sp === 'nba' ? ' AND min >= 10' : '';
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
    const days = [0, 1, 2, 3].map(i => ET_DAY_FMT
      .format(new Date(Date.now() + i * 86400000)));
    const steps = [];
    for (const sp of Object.keys(BOOST_SEASON)) { steps.push(['inj', sp]); for (const d of days) steps.push(['sched', sp, d]); }
    for (const d of days) steps.push(['fcsched', d]);   // FC: 12 competitions a day, one day per tick
    steps.push(['depthlist']);
    steps.push(['nflrosters']);
    for (const sp of Object.keys(BOOST_SEASON)) steps.push(['match', sp]);
    steps.push(['fcmatch']);
    steps.push(['rosterlist']);
    st = { run, steps, i: 0, done: false };
  }
  let n = 0;
  while (st.i < st.steps.length && n < (st.steps[st.i][0] === 'roster' ? 12 : 6)) {
    const [k, a, b] = st.steps[st.i];
    try {
      if (k === 'inj') await boostInjuries(env, a, true);
      else if (k === 'sched') await boostSchedule(env, a, b, true);
      else if (k === 'fcsched') { await fcSchedule(env, a, true); n += 5; }
      else if (k === 'fcmatch') await fcMatchups(env);
      else if (k === 'depthlist') {
        // Every NFL team on the saved slates, one depth chart per step.
        const ids = new Set();
        for (const s of st.steps) if (s[0] === 'sched' && s[1] === 'nfl') {
          try { const c = JSON.parse((await env.RATEBOARD_KV.get(`boostsched_v2_nfl_${s[2]}`)) || 'null'); if (c) Object.values(c.teams).forEach(t => t.id && ids.add(t.id)); } catch (e) {}
        }
        for (const id of ids) st.steps.push(['depth', id]);
      }
      else if (k === 'depth') await boostDepth(env, null, true, [a]);
      else if (k === 'nflrosters') await nflRosters(env);
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

/* NFL: every team's current roster from ESPN (2026-11-08: Jacoby Brissett was
   traded from Arizona to Baltimore on a Friday, and Boosts put him in
   Arizona's Sunday game off his last game). name -> [{ ab, pos }] (a name can
   be two players). Refreshed with the boost refresh; a team ESPN doesn't
   answer for keeps its last list. */
async function nflRosters(env) {
  let old = null; try { old = JSON.parse((await env.RATEBOARD_KV.get('boostrostermap_v1_nfl')) || 'null'); } catch (e) {}
  let ids = [];
  try { const r = await fetch('https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams'); const d = r.ok ? await r.json() : null;
    ids = ((((d || {}).sports || [])[0] || {}).leagues || [{}])[0].teams.map(t => t.team.id); } catch (e) { return; }
  const got = await Promise.all(ids.map(async id => { try { const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${id}/roster`); if (!r.ok) return null; const d = await r.json();
    const ab = (d.team || {}).abbreviation; if (!ab) return null;
    return { ab, list: (d.athletes || []).flatMap(g => g.items || []).map(a => ({ n: boostName(a.displayName), pos: (a.position || {}).abbreviation || '' })) }; } catch (e) { return null; } }));
  const byTeam = { ...((old && old.byTeam) || {}) };
  for (const g of got) if (g && g.list.length) byTeam[g.ab] = g.list;
  const m = {};
  for (const [ab, list] of Object.entries(byTeam)) for (const x of list) (m[x.n] = m[x.n] || []).push({ ab, pos: x.pos });
  try { await env.RATEBOARD_KV.put('boostrostermap_v1_nfl', JSON.stringify({ at: Date.now(), m, byTeam }), { expirationTtl: 30 * 86400 }); } catch (e) {}
}

/* A member's boosters from Real (userpassboostercards, collectionstats):
   each is a rarity (Rare 10x, Epic 15x, Legendary 25x) on one stat, with a
   boost value per stat and how many they hold. Kept 30 minutes. */
async function boostInventory(env, tok, hashId, sp, fresh) {
  const all = await boostInventoryAll(env, tok, hashId, fresh);
  if (all.error) return all;
  return { at: all.at, next: all.next, list: (all.sports || {})[sp] || [] };
}
/* One sport's boosters, kept close to live for the plan (2026-11-11: a member
   was told to use boosters he'd already used, from a read hours old). When a
   sport's saved copy is over 15 minutes old, that one sport is read again -
   one call to Real, at most 30 a minute across the site; if Real won't answer
   the saved copy is used. */
const BOOSTINV_SPORT_EVERY = 15 * 60000;
function boostListOf(d) {
  const list = [];
  for (const g of (((d && d.boosterCardInfo) || {}).rarityGroups || [])) {
    const mult = parseFloat(String(g.multiplierDisplay || '').replace(/x$/i, '')) || null;
    for (const k of (g.statBoostKeyInfo || [])) {
      const attrs = (k.info || []).map(i => ({ stat: String(i.label || ''), boost: parseFloat(i.boostValue) || 0 })).filter(a => a.stat);
      list.push({ rarity: Number(g.rarity), label: String(g.label || ''), mult, key: String(k.statBoostKey), attrs,
        stat: attrs.map(a => a.stat).join(' / '), boost: attrs.length ? attrs[0].boost : 0, count: Number(k.count) || 0 });
    }
  }
  return list;
}
async function boostInventorySport(env, tok, hashId, sp, origin, force) {
  const key = `boostinv_v8_${hashId}`;
  let c = null;
  try { c = JSON.parse((await env.RATEBOARD_KV.get(key)) || 'null'); } catch (e) {}
  const at = c ? Number((c.spAt || {})[sp] || c.at || 0) : 0;
  // force: the member tapped "Re-read" - anything over a minute old is read again.
  if (c && Date.now() - at < (force ? 60000 : BOOSTINV_SPORT_EVERY)) return { at, list: (c.sports || {})[sp] || [] };
  try {
    if (!(await allow(origin, 'boostinv-sp', 30, 60))) throw new Error('busy');
    const d = await rsGetJson(`https://web.realapp.com/userpassboostercards/undefined/entity/player?displayType=collectionstats&sport=${sp}&userId=${encodeURIComponent(hashId)}&version=stat`, tok);
    const list = boostListOf(d), now = Date.now();
    /* An empty answer when we had boosters saved is kept as a miss, not
       saved (2026-11-12: a member saw "no boosts" in every sport). */
    const had = ((c && c.sports && c.sports[sp]) || []).length;
    if (!list.length && had) { const e = Number((c.emptyN || {})[sp] || 0) + 1;
      if (e < 3) { try { await env.RATEBOARD_KV.put(key, JSON.stringify({ ...c, emptyN: { ...(c.emptyN || {}), [sp]: e } }), { expirationTtl: 30 * 86400 }); } catch (x) {}
        return { at, list: c.sports[sp], stale: true }; } }
    const n = c || { at: now, sports: {} };
    if (n.emptyN) n.emptyN = { ...n.emptyN, [sp]: 0 };
    n.sports = { ...(n.sports || {}), [sp]: list }; n.spAt = { ...(n.spAt || {}), [sp]: now };
    try { await env.RATEBOARD_KV.put(key, JSON.stringify(n), { expirationTtl: 30 * 86400 }); } catch (e) {}
    return { at: now, list };
  } catch (e) {
    if (c) return { at, list: (c.sports || {})[sp] || [], stale: true };
    return { error: 'Could not read your boosters from Real.' };
  }
}
/* All four sports' boosters (CBB, CFB, NFL, golf) in one read, at most once every 4 hours per
   member; inside that the saved copy is used. */
const BOOSTINV_EVERY = 2 * 3600000;
// Members whose pass and booster reads on Boosts are never held back.
const BOOST_FAST = new Set(['quas23']);
async function boostInventoryAll(env, tok, hashId, fresh, admin) {
  const key = `boostinv_v8_${hashId}`;   // v6: golf added (2026-11-05); v7: FC (2026-11-07); v8: NBA, NHL (2026-11-09)
  let c = null;
  try { c = JSON.parse((await env.RATEBOARD_KV.get(key)) || 'null'); } catch (e) {}
  if (c && (!fresh || (!admin && Date.now() - c.at < BOOSTINV_EVERY))) return { ...c, next: admin ? Date.now() : c.at + BOOSTINV_EVERY, cached: !!fresh };
  const sports = {};
  for (const sp of [...Object.keys(BOOST_SEASON), 'golf', 'soccer']) {
    let d;
    try { d = await rsGetJson(`https://web.realapp.com/userpassboostercards/undefined/entity/player?displayType=collectionstats&sport=${sp}&userId=${encodeURIComponent(hashId)}&version=stat`, tok); }
    catch (e) {
      // FC is new: if Real won't give its boosters, the other sports still load.
      if (sp === 'soccer' || sp === 'nba' || sp === 'nhl') { sports[sp] = (c && c.sports && c.sports[sp]) || []; continue; }
      if (c) return { ...c, next: c.at + BOOSTINV_EVERY }; return { error: 'Could not read your boosters from Real: ' + String(e.message || e).slice(0, 120) }; }
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
    // FC's booster attributes, as Real names them (no accounts), for the health page while the FC stat names are checked.
    if ((sp === 'soccer' || sp === 'nba' || sp === 'nhl') && list.length) { const lk = sp === 'soccer' ? 'fc_booster_labels' : `booster_labels_${sp}`;
      try { const seen = JSON.parse((await env.RATEBOARD_KV.get(lk)) || '[]') || [];
      const add = list.flatMap(b => (b.attrs || []).map(a => `${b.label} ${a.stat} +${a.boost}`)).filter(x => !seen.includes(x));
      if (add.length) await env.RATEBOARD_KV.put(lk, JSON.stringify(seen.concat(add).slice(-60))); } catch (e) {} }
    await sleep(700);
  }
  // Every sport empty when boosters were saved before: Real answered without them - keep the saved ones.
  const hadAny = c && Object.values(c.sports || {}).some(l => (l || []).length);
  if (hadAny && !Object.values(sports).some(l => (l || []).length)) return { ...c, next: Date.now() + 15 * 60000, stale: true };
  const out = { at: Date.now(), sports, spAt: {} };
  try { await env.RATEBOARD_KV.put(key, JSON.stringify(out), { expirationTtl: 30 * 86400 }); } catch (e) {}
  return { ...out, next: out.at + BOOSTINV_EVERY };
}
/* Per-stat bars for basketball (a starter's per-game average, last season):
   [top 10%, top 25%, median] - boost saver needs the first, balanced the
   second, earning heavy the third. */
const STAT_BARS = { PTS: [15.8, 12.7, 9.5], REB: [6.3, 4.9, 3.6], AST: [3.8, 2.4, 1.6], STL: [1.4, 1.1, 0.8], BLK: [1.0, 0.6, 0.3], '3PM': [2.5, 1.8, 1.0] };
const MODE_BAR = { saver: 0, balanced: 1, heavy: 2 };
/* Dennis's CBB top 175 for 2026-27 (player id -> [rank, team, his link]); Dent, Johnson, Mitchell Jr., Kusturica, Hall, Hubbard, Gibbs-Lawhorn and Kaufman-Renn added 2026-11-07. Used for newcomers
   with no college games: on the list they get a projection from their rank;
   off it they're listed below with "not enough data". */
const CBB_TOP175 = {"4711255":[1,"MSU","jxtRc6FPBpw9"],"5187600":[2,"VAN","aetecRFBODGq"],"5142731":[3,"KU","d6tOcgFRggge/2027","Tyran Stokes"],"5080489":[4,"FLA","6qt4cvFjPmNG"],"5174657":[5,"FLA","Plt1cDF5kJ66"],"5106275":[6,"TA&M","8wtpcOFbqPE9"],"5044426":[7,"LOU","NGtrcgFLWgPo"],"5107782":[8,"LSU","EGt3cMFwNKxK/2027","Donovan Dent"],"5103630":[9,"DUKE","A7tmc1FJ4gmr"],"5075625":[10,"SJU","8wtpcOFbq69w/2027","Keyshawn Hall"],"5142609":[11,"TENN","ObtEc8FwmmD4"],"4858604":[12,"NEB","8wtpcOFbWbR3"],"5060709":[13,"BYU","GxtacOF4w8e0"],"5095152":[14,"SJU","5mt6c5FpL2O4"],"4432741":[15,"UCF","Rqt3c3FkekAg/2027","Dior Johnson"],"5054083":[16,"CONN","jxtRc6FPWd6m"],"5142722":[17,"ARIZ","jxtRc6FPRRRL/2027","Caleb Holt"],"5347090":[18,"DUKE","5mt6c5Fpyj4O/2027","Joaquim Boumtje Boumtje"],"5142715":[19,"MIZ","19tbcKF4kkvp/2027","Jason Crowe Jr."],"5311832":[20,"ILL","xwtYcEFLJWRv"],"4433285":[21,"MIZ","lwt4cNF404aD/2027","Mark Mitchell Jr."],"5101833":[22,"ALA","wWtlcNFW7Mbg"],"4895740":[23,"MSST","0ytNcgFG71kE/2027","Josh Hubbard"],"4869764":[24,"MICH","m3t8cxFy209J"],"4873209":[25,"DUKE","2at8cpFrN62o"],"5164368":[26,"TEX","5mt6c5FpNP6r"],"5142729":[27,"ARK","k3t1cvFbddd0/2027","Jordan Smith Jr."],"4711259":[28,"TTU","A7tmc1FJ6RNv/2027","Dra Gibbs-Lawhorn"],"4848637":[29,"UK","7vtWcRFD63ab"],"4684634":[30,"USC","0ytNcgFGq3AJ"],"5174954":[31,"ARIZ","19tbcKF4kJog"],"5210407":[32,"DUKE","aetecRFBYMpk/2027","Cameron Williams"],"4897438":[33,"KU","extmcdFMmPva/2027","Trey Kaufman-Renn"],"5174971":[34,"FLA","NGtrcgFLJ2GQ"],"5311846":[35,"UVA","Rqt3c3FkpPJW"],"5196916":[36,"CONN","5mt6c5FpRrLY"],"4894445":[37,"GONZ","0ytNcgFG71LV"],"5239838":[38,"TEX","WbtlcDFOybqe"],"5101809":[39,"MIA","LxtJcmFNWJj9"],"4873184":[40,"IU","KYtEc1F3gxG8"],"5254159":[41,"TEX","4Pt5cQFaYGm3"],"4712832":[42,"COLO","bYtLcMFJbjGq"],"5175007":[43,"ILL","wWtlcNFWxgWm"],"5369499":[44,"UCLA","8wtpcOFb1bOr/2027","Nikola Kusturica"],"5177233":[45,"UNC","optxcAFl5bG1"],"5174955":[46,"ASU","2at8cpFr4oRg"],"5238195":[47,"FLA","m3t8cxFy71LG"],"5144105":[48,"MIA","jxtRc6FPRalw"],"5311896":[49,"ARIZ","A7tmc1FJ840g"],"5144495":[50,"USC","LxtJcmFNL1vW"],"5143604":[51,"TTU","aetecRFBOOm5"],"4873093":[52,"HOU","95tbclFJKYNr"],"5144108":[53,"BAY","3AtwcWF7lxaN"],"5060732":[54,"ARK","Rqt3c3FkPpxA"],"5241360":[55,"ISU","6qt4cvFjYdLr"],"5101623":[56,"IU","Rqt3c3FkPMgl"],"4873219":[57,"USC","A7tmc1FJRPAd"],"5101849":[58,"UK","extmcdFMpYK1"],"4845361":[59,"LOU","jxtRc6FP1E27"],"4684276":[60,"ALA","k3t1cvFb4BG8"],"5060700":[61,"HOU","NGtrcgFLWBQM"],"5149078":[62,"MICH","aetecRFBOw80"],"4711256":[63,"DUKE","pgt3cvFNAvYo"],"5165276":[64,"ARK","Jltrc5FG58V8"],"5060705":[65,"UK","8wtpcOFbqoJb"],"5150404":[66,"UVA","5mt6c5FpN103"],"5060685":[67,"KU","NGtrcgFLWBQ7"],"5312258":[68,"TENN","Rqt3c3FkpPy8"],"5105534":[69,"MICH","DBtPcRFW2K96"],"5174952":[70,"USC","4Pt5cQFaNVj8"],"4869770":[71,"SJU","Rqt3c3FkLqV6"],"5311991":[72,"ILL","gQtVcRFyQk35"],"4872740":[73,"MSU","95tbclFJKPON"],"4683680":[74,"XAV","B5t7coFVdG8q"],"4845373":[75,"TENN","0ytNcgFG9bkL"],"5238184":[76,"IU","95tbclFJmjy9"],"5093142":[77,"MICH","LxtJcmFNWAmj"],"5214642":[78,"ILL","YBtWcOFL6wVR"],"5174609":[79,"TENN","5mt6c5FpNY7j"],"5105527":[80,"FLA","bYtLcMFJpV15"],"4684270":[81,"GTWN","pgt3cvFNWmL9"],"5175021":[82,"VAN","5mt6c5FpNjbe"],"4683769":[83,"VILL","8wtpcOFbAKWW"],"5144086":[84,"MARQ","95tbclFJ4m5D"],"5311928":[85,"TCU","EGt3cMFw9N3D"],"5144479":[86,"KU","optxcAFl519e/2027"],"5217192":[87,"USC","pgt3cvFNkWeL/2027"],"5082704":[88,"ALA","WbtlcDFON46L"],"4895783":[89,"WISC","yktdcvFBKN44"],"4873089":[90,"AUB","EGt3cMFwxg2w"],"5079838":[91,"ISU","Plt1cDF5gqKK"],"5239571":[92,"NEB","B5t7coFV474l"],"5174665":[93,"ILL","KYtEc1F3LyP3"],"5037881":[94,"MIZ","KYtEc1F3VGxg"],"5105552":[95,"SMU","KYtEc1F3VbwK"],"5238203":[96,"MIA","jxtRc6FPawQl"],"5313054":[97,"VAN","aetecRFBbOkJ"],"4848619":[98,"WVU","EGt3cMFw01MP"],"5238207":[99,"BYU","A7tmc1FJbQEm"],"5060712":[100,"TENN","LxtJcmFNWpxK"],"5311844":[101,"UVA","gQtVcRFyQkWP"],"5311829":[102,"UNC","95tbclFJgLVm"],"5240980":[103,"TEX","gQtVcRFyMDd8"],"5240529":[104,"MSU","5mt6c5FpRlwQ"],"4683944":[105,"TENN","xwtYcEFLwmbj"],"5311502":[106,"TEX","LxtJcmFNpWbG"],"5177122":[107,"LOU","Rqt3c3FkVWg7"],"4869777":[108,"LOU","Plt1cDF50yk2"],"5315585":[109,"MD","B5t7coFVv4Am"],"5258494":[110,"WVU","jxtRc6FPaqG3"],"5177275":[111,"MISS","A7tmc1FJVDP4"],"5107312":[112,"WASH","LxtJcmFNWGov"],"5185443":[113,"ARK","r8t4c1FempjN/2027"],"5311903":[114,"GONZ","yktdcvFBYk15"],"5142356":[115,"PITT","wWtlcNFWxxLd"],"5248302":[116,"ISU","Plt1cDF5Wa7a"],"5041949":[117,"MIZ","r8t4c1FeWJqK"],"5174291":[118,"IU","k3t1cvFbdKQE"],"5176310":[119,"NEB","NGtrcgFLJ261"],"5101766":[120,"ARIZ","2at8cpFr7y6l"],"5041958":[121,"MIZ","aetecRFBkae4"],"5105577":[122,"CREI","2at8cpFr758d"],"4838704":[123,"ISU","2at8cpFrG9xq"],"5175952":[124,"PROV","r8t4c1FemK9A"],"5060696":[125,"PROV","EGt3cMFwNEoV"],"5292602":[126,"CONN","8wtpcOFbowmo"],"4873086":[127,"HOU","extmcdFMmwB7"],"5196913":[128,"GONZ","KYtEc1F3doVD"],"5313012":[129,"GONZ","WbtlcDFO76mk"],"5311967":[130,"MARQ","5mt6c5FpyLOV"],"5175058":[131,"PROV","2at8cpFr4ovW"],"5313560":[132,"CREI","r8t4c1FejmD8"],"5176232":[133,"UVA","4Pt5cQFaNVGw"],"5176359":[134,"NCST","8wtpcOFbxB5E"],"5314225":[135,"KU","vVt1cbFQLmw2"],"5041954":[136,"MICH","NGtrcgFLW9Vx"],"5287474":[137,"DUKE","19tbcKF4Yr5K"],"5176309":[138,"DUKE","d6tOcgFRgwQ5"],"4873111":[139,"MSU","Met5ckFx1v2r"],"4895776":[140,"VILL","A7tmc1FJRYBp"],"5144166":[141,"VAN","wWtlcNFWxo2q"],"5226071":[142,"ISU","LxtJcmFN1WpW"],"5196931":[143,"MSU","WbtlcDFOyL6r"],"5217196":[144,"ISU","Plt1cDF5WvBD"],"5108093":[145,"HOU","6qt4cvFjPVoj"],"5152763":[146,"USC","optxcAFl5yV9"],"5060730":[147,"IU","gQtVcRFykQa4"],"4711400":[148,"UK","Rqt3c3FkQL0K"],"5144097":[149,"ARIZ","m3t8cxFy97l2"],"4685687":[150,"MIZ","r8t4c1FeQxAg"],"5210802":[151,"TEX","Jltrc5FG6y2D/2027"],"4873181":[152,"UNC","NGtrcgFLVgpb"],"5196877":[153,"UNC","EGt3cMFwEBLQ"],"5177211":[154,"LOU","xwtYcEFLG1Vp"],"4685654":[155,"MIZ","wWtlcNFWRJNQ"],"4873183":[156,"UK","0ytNcgFG7ymO"],"5103631":[157,"NEB","Plt1cDF5gbyq"],"5242127":[158,"LOU","NGtrcgFLBa6q"],"5176481":[159,"IOWA","GxtacOF4g97l"],"5095154":[160,"VAN","extmcdFMpd57"],"5221321":[161,"UCLA","NGtrcgFLBdOB"],"5238200":[162,"FLA","Jltrc5FG61YV"],"5214635":[163,"SJU","GxtacOF4PamO/2027"],"4895753":[164,"CONN","95tbclFJK0ar"],"5101798":[165,"MSU","yktdcvFBkWlQ"],"5176315":[166,"SJSU","8wtpcOFbxB9E"],"5177227":[167,"LOU","jxtRc6FPR05B"],"5142719":[168,"ARIZ","Jltrc5FG55p3/2027"],"5107804":[169,"PROV","Met5ckFxJBVg"],"5106280":[170,"TULN","r8t4c1FeWG92"],"5144554":[171,"ALA","LxtJcmFNL15Y/2027"],"5144124":[172,"CONN","GxtacOF4gPQK"],"5142709":[173,"MIA","WbtlcDFO66Nw"],"5307569":[174,"ILL","3AtwcWF7k5pW/2027"],"5142723":[175,"MIA","pgt3cvFNwww3/2027"],"5177188":[176,"PROV","r8t4c1FemaRm"],"5314722":[177,"PORT","ObtEc8Fw2VxB"],"5105569":[178,"XAV","VjtqcVFeG3Dv"],"5240539":[179,"SJU","yktdcvFBJPWb"],"5174935":[180,"MIA","extmcdFMqo2Q"],"5454840":[181,"UK","xwtYcEFLvLyr/2027"]};
/* Dennis's CBB boost order: these always go first, in this order, and get
   at least the rarity shown (5 Legendary, 4 Epic) whatever their projection,
   as long as they're playing and not hurt. */
// No CBB players pinned (Dennis, 2026-11-10). Was: Fears, Tanner, Haugh (Legendary), Stokes, Sandfort (Epic).
const CBB_PIN = {};
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
/* An injury-map entry for this player: his own team's when we know it. A
   same-name player on another team (two Justin Jeffersons) doesn't count;
   the hand list (no team) always does. */
function injOf(map, name, tid) {
  const k = boostName(name || ''), e = map[k];
  if (e && e.manual) return e;
  if (tid != null && tid !== '' && map[k + '|' + tid]) return map[k + '|' + tid];
  if (e && e.tid && tid != null && tid !== '' && String(e.tid) !== String(tid)) return null;
  return e || null;
}
/* Questionable / day-to-day: only a small mark-down (Dennis, 2026-11-09:
   was 25% - a booster on a player who sits out is kept, so the risk is small). */
const Q_CUT = 0.95;
async function boostInjuries(env, sp, force) {
  const key = `boostinj_v3_${sp}`;
  /* Read again when 20 minutes old (2026-11-09: it was only read 4 times a
     day, so Luka stayed Out from Sunday's report after ESPN had him
     day-to-day). A failed read keeps the saved copy. */
  let old = null;
  try { old = JSON.parse((await env.RATEBOARD_KV.get(key)) || 'null'); } catch (e) {}
  if (!force && old && Date.now() - (old.at || 0) < 20 * 60000) return old.map;
  const map = {};
  try {
    const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${ESPN_PATH[sp]}/injuries`);
    if (!r.ok && old) return old.map;
    const d = r.ok ? await r.json() : {};
    for (const t of (d.injuries || [])) for (const x of (t.injuries || [])) {
      if (!x.athlete || !x.status || /^active$/i.test(x.status)) continue;
      if (x.date && Date.now() - Date.parse(x.date) > 30 * 86400000) continue;
      /* With his team (2026-11-09: a Browns Justin Jefferson, out, benched
         the Vikings' Justin Jefferson - the list was by name only). */
      const tid = String((x.athlete.team && x.athlete.team.id) || t.id || ''), e = { status: x.status, note: String(x.shortComment || '').slice(0, 140), tid };
      /* ESPN's status can lag the news (2026-11-15: Kenneth Walker was ruled out and
         still listed Questionable) - a fresh note saying he's out counts as Out. */
      const cmt = String(x.shortComment || '') + ' ' + String(x.longComment || '');
      if (!/^(out|injured reserve)/i.test(e.status) && (!x.date || Date.now() - Date.parse(x.date) < 4 * 86400000)
        && /\b(ruled out|downgraded to out|will not play|won't play|is out for|been declared out|inactive for)\b/i.test(cmt) && !/\b(not been ruled out|hasn't been ruled out|has not been ruled out)\b/i.test(cmt)) e.status = 'Out';
      map[boostName(x.athlete.displayName) + '|' + tid] = e;
      if (!map[boostName(x.athlete.displayName)]) map[boostName(x.athlete.displayName)] = e;
    }
  } catch (e) {}
  try { await env.RATEBOARD_KV.put(key, JSON.stringify({ at: Date.now(), map }), { expirationTtl: 3 * 86400 }); } catch (e) {}
  return map;
}
/* Injuries set by hand (Dennis, 2026-11-06: Malachi Toney was out for Miami
   at Notre Dame but Boosts still gave him a booster). ESPN's college lists
   carry almost nobody - its CFB injury list had 3 teams and Miami's roster
   showed Toney with no injury - so for college the hand list is the real one.
   Kept in KV per sport: { key: { name, status, note, until } }; an entry with
   `until` (an ET day) drops off after that day, one without stays until it's
   removed. The seed below is SI's Week 10 report (Nov 5) for Saturday 11/7. */
const BOOST_OUT_KEY = 'boostout_v1';
const BOOST_OUT_SEED = { ncaaf: [
  ['Malachi Toney', 'Out', 'High ankle sprain (surgery)', '2026-11-08'],
  ['Kewan Lacy', 'Out', 'Left shoulder', '2026-11-08'],
  ['Hollywood Smothers', 'Out', '', '2026-11-08'],
  ['Drayk Bowen', 'Out', 'Right ankle', '2026-11-08'],
  ['Whit Weeks', 'Doubtful', 'Fibula', '2026-11-08'],
  ['LJ Martin', 'Doubtful', 'Lower body', '2026-11-08'],
  ['Duce Robinson', 'Out', 'Torn ACL - out for the season', ''],
  ['Julian Sayin', 'Out', 'Throwing arm', '2026-11-08'],
  ['Dante Moore', 'Out', 'Concussion - out for the season', ''],
  ['Nico Iamaleava', 'Out', 'Torn ACL - out for the season', ''],
  ['Jordon Davison', 'Out', 'Lower extremity', '2026-11-08'],
  ['Ja\'Kobi Jackson', 'Out', '', '2026-11-08'],
  ['Matt Fuller', 'Out', 'Foot - out for the regular season', ''],
  ['Terry Bussey', 'Out', 'Out for the season', ''],
  ['Sire Gaines', 'Out', '', '2026-11-08'],
  ['Jett Thomalla', 'Doubtful', '', '2026-11-08'],
  ['Michael Merdinger', 'Out', '', '2026-11-08'],
  ['Ryan Estrada', 'Out', '', '2026-11-08'],
  ['Andre Devine', 'Out', '', '2026-11-08'],
  ['Malae Fonoti', 'Out', '', '2026-11-08'],
  ['Phillip Wright III', 'Out', '', '2026-11-08'],
  ['Dashawn Spears', 'Out', '', '2026-11-08'],
  ['Desmond Umeozulu', 'Out', 'Turf toe', '2026-11-08'],
  ['Cayden Jones', 'Out', 'Out for the season', ''],
  ['Charles Ross II', 'Out', '', '2026-11-08'],
  ['Amaris Williams', 'Out', 'Knee', '2026-11-08'],
  ['Pierson Watson', 'Out', '', '2026-11-08'],
  ['Ant Davis Jr.', 'Out', '', '2026-11-08'],
  ['Brayden Platt', 'Out', '', '2026-11-08'],
  ['Taylor Heim', 'Out', '', '2026-11-08'],
  ['Cole Sullivan', 'Out', '', '2026-11-08'],
  ['Jaden Robinson', 'Out', '', '2026-11-08'],
  ['Antwan Smith', 'Out', '', '2026-11-08'],
  ['Justyn Hartley', 'Out', '', '2026-11-08'],
  ['Jaedon Harmon', 'Out', 'ACL - out for the season', ''],
  ['Jalen Jones', 'Out', '', '2026-11-08'],
  ['Malcolm Simmons', 'Doubtful', '', '2026-11-08'],
  ['Jon Denman', 'Out', '', '2026-11-08'],
  ['Terry Shelton', 'Out', '', '2026-11-08'],
  ['R.J. Mosley', 'Out', 'Knee - out for the season', ''],
] };
async function boostOutList(env) {
  let kv = null; try { kv = JSON.parse((await env.RATEBOARD_KV.get(BOOST_OUT_KEY)) || 'null'); } catch (e) {}
  // One-off (2026-11-26): Gibbs was marked out by an accidental tap on Boosts. Take him off once.
  try { if (kv && kv.nfl && !(await env.RATEBOARD_KV.get('boostout_fix_gibbs_1126'))) { const k = boostName('Jahmyr Gibbs'); if (kv.nfl[k] && /Boosts/.test(kv.nfl[k].note || '')) { delete kv.nfl[k]; await env.RATEBOARD_KV.put(BOOST_OUT_KEY, JSON.stringify(kv)); await env.RATEBOARD_KV.put('proj_force_v1_nfl', String(Date.now()), { expirationTtl: 7 * 86400 }); await env.RATEBOARD_KV.delete('boosttop_v11_' + etDay(Date.now())).catch(() => {}); } await env.RATEBOARD_KV.put('boostout_fix_gibbs_1126', '1', { expirationTtl: 7 * 86400 }); } } catch (e) {}
  if (!kv) { kv = {}; for (const [sp, rows] of Object.entries(BOOST_OUT_SEED)) { kv[sp] = {}; for (const [name, status, note, until] of rows) kv[sp][boostName(name)] = { name, status, note, until, at: Date.parse('2026-11-07T06:00:00Z') }; } }
  return kv;
}
// The hand list for one sport as an injury map, today's entries only.
async function boostManualOut(env, sp, day) {
  const all = await boostOutList(env), today = day || etDay(Date.now()), m = {};
  if (sp === 'soccer') { try { Object.assign(m, await fplInjuries(env)); } catch (e) {} }   // the hand list below wins over FPL
  for (const [k, v] of Object.entries(all[sp] || {})) if (!v.until || v.until >= today) m[k] = { status: v.status, note: v.note || '', until: v.until || '', manual: true };
  return m;
}
/* Premier League injuries from the official Fantasy Premier League feed (Dennis, 2026-11-26: free, no key; nothing
   free covers the other leagues). Injured or suspended = Out / Suspension; doubtful at 25% or less = Doubtful,
   50% = Questionable, 75% = left alone. Read at most once an hour. Each player is filed under his full name, the
   short name FPL shows (when no one else has it), and first + last name, so it matches how Real spells him. */
async function fplInjuries(env) {
  const K = 'fplinj_v1'; let c = null; try { c = JSON.parse((await env.RATEBOARD_KV.get(K)) || 'null'); } catch (e) {}
  if (c && Date.now() - c.at < 3600000) return c.m;
  try { if (await env.RATEBOARD_KV.get(K + '_lock')) return (c && c.m) || {}; await env.RATEBOARD_KV.put(K + '_lock', '1', { expirationTtl: 120 }); } catch (e) {}
  try {
    const r = await fetch('https://fantasy.premierleague.com/api/bootstrap-static/', { headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error('FPL ' + r.status);
    const j = await r.json(), teams = Object.fromEntries((j.teams || []).map(t => [t.id, t.short_name])), m = {};
    const webN = {}; for (const p of (j.elements || [])) { const k = boostName(p.web_name); webN[k] = (webN[k] || 0) + 1; }
    for (const p of (j.elements || [])) {
      const ch = p.chance_of_playing_next_round;
      const status = p.status === 'i' ? 'Out' : p.status === 's' ? 'Suspension' : p.status === 'd' ? (ch == null || ch <= 25 ? 'Doubtful' : ch <= 50 ? 'Questionable' : null) : null;
      if (!status) continue;
      const v = { status, note: `${String(p.news || '').slice(0, 120)} (FPL${teams[p.team] ? ', ' + teams[p.team] : ''})`, until: '', fpl: true };
      const full = `${p.first_name} ${p.second_name}`, parts = String(p.second_name || '').split(/\s+/);
      for (const k of new Set([boostName(full), webN[boostName(p.web_name)] === 1 ? boostName(p.web_name) : '', boostName(`${String(p.first_name || '').split(/\s+/)[0]} ${parts[parts.length - 1]}`)])) if (k) m[k] = v;
    }
    c = { at: Date.now(), m }; await env.RATEBOARD_KV.put(K, JSON.stringify(c), { expirationTtl: 3 * 86400 });
  } catch (e) { if (c) { c.at = Date.now() - 3000000; try { await env.RATEBOARD_KV.put(K, JSON.stringify(c), { expirationTtl: 3 * 86400 }); } catch (e2) {} } }   // try again in 10 minutes
  try { await env.RATEBOARD_KV.delete(K + '_lock'); } catch (e) {}
  return (c && c.m) || {};
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
    if (!force) { try { const c = JSON.parse((await env.RATEBOARD_KV.get(key)) || 'null'); if (c && Date.now() - c.at < 20 * 60000) m = c.m; } catch (e) {} }
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
            if (ij && ij.status && !/^active$/i.test(ij.status)) m[boostName(a.displayName)] = { status: String(ij.status), note: '', tid: String(id) };
          }
          try { await env.RATEBOARD_KV.put(key, JSON.stringify({ at: Date.now(), m }), { expirationTtl: 86400 }); } catch (e) {}
        }
      } catch (e) {}
      if (!m) { try { const c = JSON.parse((await env.RATEBOARD_KV.get(key)) || 'null'); if (c) m = c.m; } catch (e) {} }
    }
    if (m) for (const [k, v] of Object.entries(m)) { const e = { ...v, tid: String(id) }; out[k + '|' + id] = e; if (!out[k]) out[k] = e; }
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
  const etDate = iso => ET_DAY_FMT.format(new Date(iso));
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
    rows.push({ id: p.id, passId: p.passId, pm: p.mult || null, plv: p.levelLabel || null, name, team: (rc[0] && rc[0].team) || null, tid: null, pos: '', opp: ev.name, home: true, at: ev.start, exp: {},
      avg: form == null ? null : Math.round(form * 10) / 10, games: rc.length, avgLast: hn ? Math.round(ha * 10) / 10 : null, course: hn ? { n: hn, avg: Math.round(ha * 10) / 10, best } : null,
      proj: proj == null ? null : Math.round(proj * 10) / 10, basis, flags, skip: false, fresh: false, noData: proj == null });
  }
  return { rows, idle, sched: { games: 1, event: ev.name, course: course || null, field: ev.field.length } };
}
const etDayOf = iso => iso ? ET_DAY_FMT.format(new Date(iso)) : '';

/* ---- FC boosts (2026-11-07) ------------------------------------------------
   Real scores every league game in the Premier League, Championship, La Liga,
   Serie A, Bundesliga, Ligue 1 and Liga MX, plus the Champions League, Europa
   League and Nations League - checked game by game against Real's own log
   from July to November 2026 (every one of those games is there; no domestic
   cup or friendly is). The slate is ESPN's for those competitions; starting
   lineups come from ESPN's match pages (out about an hour before kickoff),
   read every few minutes from 85 minutes before each kickoff. */
const FC_SEASON = [2026, 2025];
const FC_LEAGUES = ['eng.1', 'eng.2', 'esp.1', 'ita.1', 'ger.1', 'fra.1', 'mex.1', 'uefa.champions', 'uefa.europa', 'uefa.nations', 'fifa.worldq.uefa', 'fifa.world', 'usa.1'];
/* MLS (2026-11-07, Dennis): Real files the 2026 MLS season under FC 2025
   (2025-26), and those cards still earn. Codes -> ESPN ids, lined up the same
   way against all 450 MLS games of 2026 (every one matched). A 2025 FC card
   earns on MLS games only; a 2026 card on everything else. */
const FC_MLS_SEASON = 2025;
const FC_MLS = { ATL: 18418, ATX: 20906, CHI: 182, CIN: 18267, CLB: 183, CLT: 21300, COL: 184, DAL: 185, DC: 193, HOU: 6077, LAF: 18966, LAG: 187, MIA: 20232, MIN: 17362, MTL: 9720,
  NE: 189, NSH: 18986, NYC: 17606, NYR: 190, ORL: 12011, PHI: 10739, POR: 9723, RSL: 4771, SDG: 22529, SEA: 9726, SJ: 191, SKC: 186, STL: 21812, TOR: 7318, VAN: 9727 };
const FC_NAT_LG = new Set(['uefa.nations', 'fifa.worldq.uefa', 'fifa.world']);
const FC_NAT_CONF = new Set(['WC', 'UNL']);   // Real files national-team games under these
/* Real's team code -> ESPN team id. Worked out by lining up every game in
   Real's 2026 log with ESPN's results on the same day. Real reuses some codes
   for two or three clubs (LEV is Levante, Leverkusen and Levski; ATL is Atlas
   and Atlante; BOL Bolton and Bologna...), so those list each one and the
   player's own club is found from the lineup or the club's squad list. */
const FC_CLUBS = {"ACS": [433], "AEK": [887], "AJA": [172], "ALA": [96], "AME": [227], "ARM": [20024], "ARS": [359], "ASL": [15720], "ASM": [174], "ATA": [105], "ATH": [93], "ATL": [226,216], "ATM": [1068], "AVL": [362], "AZA": [140], "BAR": [83], "BES": [1895], "BET": [244], "BHA": [331], "BIR": [392], "BLA": [365], "BMG": [268], "BOD": [2980], "BOL": [358,107], "BOU": [349], "BRC": [333], "BRE": [337,6997], "BUR": [379], "BVB": [124], "CAG": [2925], "CAR": [347], "CDG": [219], "CEL": [85,256], "CHA": [372], "CHE": [363], "CLU": [570], "COM": [2572], "COV": [388], "CRA": [218], "CRY": [384], "DEP": [90], "DER": [374], "DIN": [597], "ELC": [3751], "ELV": [10388], "ESP": [88], "EVE": [368], "FB": [436], "FCA": [3841], "FCB": [132], "FCL": [273], "FCU": [598], "FEY": [142], "FIO": [109], "FRO": [4057], "FTC": [622], "FUL": [370], "GEN": [3263], "GET": [2922], "GS": [432], "HAC": [3236], "HBS": [13083], "HSV": [127], "HUL": [306], "INT": [110], "IPS": [373], "JAG": [11505], "JUA": [17851], "JUV": [111], "KOE": [122], "LAS": [4411], "LAZ": [112], "LEC": [113], "LEE": [357], "LEM": [2697], "LEO": [228], "LEV": [1538,131,490], "LIL": [166], "LIN": [314], "LIV": [364], "LPO": [2990], "LSK": [987], "M05": [2950], "MAL": [99], "MCI": [382], "MID": [369], "MIL": [391,103], "MON": [220,4007], "MUN": [360], "NAP": [114], "NCX": [229], "NEC": [147], "NIJ": [147], "NEW": [361], "NFO": [393], "NIC": [2502], "NOR": [381], "OFI": [1010], "OL": [167], "OLY": [435], "OM": [176], "OMO": [617], "OSA": [97], "PAC": [234], "PAD": [3307], "PAR": [115,6851], "PLZ": [11706], "PNE": [394], "POR": [385,437], "PSG": [160], "PSV": [148], "PUE": [231], "PUM": [233], "QPR": [334], "QUE": [222], "RAC": [87], "RAY": [101], "RBL": [11420], "RBS": [2790], "RCL": [175], "REN": [169], "RMA": [86], "ROM": [104], "RSC": [441], "RSO": [89], "S04": [133], "SAB": [21922], "SAS": [3997], "SCF": [126], "SCO": [7868], "SCP": [2250], "SEV": [243], "SGE": [125], "SHK": [493], "SHU": [398], "SLA": [225,494], "SLB": [1929], "SLO": [521], "SPA": [433], "SOU": [376], "STG": [5807], "STO": [336], "STR": [180], "STU": [3746], "SUN": [366], "SVW": [137], "SWA": [318], "TFC": [179], "TIG": [232], "TIJ": [10125], "TOL": [223], "TOR": [239,21615], "TOT": [367], "TRO": [170], "TSG": [7911], "UDI": [118], "VAL": [94], "VEN": [17530], "VFB": [134], "VIK": [510], "VIL": [102], "WAT": [395], "WBA": [383], "WHU": [371], "WOL": [380], "WRE": [352]};
const FC_NATS = {"NED":449,"GER":481,"SRB":6757,"GRE":455,"NOR":464,"DEN":479,"POR":482,"WAL":578,"ITA":162,"BEL":459,"TUR":465,"FRA":478,"CZE":450,"CRO":477,"ENG":448,"ESP":164};
// A code missing above (a club new to Real) falls back to ESPN's abbreviation for the day.
const fcTeamIds = (key, nat) => {
  const k = String(key || '').toUpperCase(); if (!k) return [];
  if (nat) return FC_NATS[k] ? [String(FC_NATS[k])] : [];
  return (FC_CLUBS[k] || []).map(String);
};
// ESPN team id -> Real codes (used by the game-data refresh to find who played).
export function fcKeysOf(espnId) {
  const id = Number(espnId), out = [];
  for (const [k, v] of Object.entries(FC_CLUBS)) if (v.includes(id)) out.push({ key: k, nat: false });
  for (const [k, v] of Object.entries(FC_NATS)) if (v === id) out.push({ key: k, nat: true });
  for (const [k, v] of Object.entries(FC_MLS)) if (v === id) out.push({ key: k, nat: false, mls: true });
  return out;
}
/* The day's FC games (Eastern date). ESPN lists a date's games by US time, so
   one call per competition. Kept 5 days; refreshed by the boost refresh and,
   for today, every 2 hours by the lineup tick (kickoff moves, postponements). */
export async function fcSchedule(env, day, force) {
  const key = `boostsched_v2_soccer_${day}`;
  let old = null;
  try { old = JSON.parse((await env.RATEBOARD_KV.get(key)) || 'null'); } catch (e) {}
  if (old && !force && (old.lgs || []).length === FC_LEAGUES.length) return old;   // a copy from before a competition was added is read again
  const ymd = day.replace(/-/g, '');
  const got = await Promise.all(FC_LEAGUES.map(async lg => {
    try { const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${lg}/scoreboard?dates=${ymd}`); return r.ok ? { lg, d: await r.json() } : { lg, err: r.status }; }
    catch (e) { return { lg, err: 'net' }; }
  }));
  const failed = new Set(got.filter(x => x.err).map(x => x.lg));
  if (failed.size > FC_LEAGUES.length / 2) return old || { error: 'Could not load the FC schedule from ESPN - try again in a minute.' };
  const events = [];
  for (const { lg, d } of got) if (d) for (const ev of (d.events || [])) {
    if (etDayOf(ev.date) !== day) continue;
    const c = (ev.competitions || [])[0]; if (!c) continue;
    const st = ((ev.status || {}).type) || {};
    if (/CANCEL|POSTPON|ABANDON/i.test(st.name || '')) continue;
    const side = w => { const x = (c.competitors || []).find(y => y.homeAway === w); const t = (x && x.team) || {}; return { id: String(t.id || ''), ab: t.abbreviation || '', nm: t.shortDisplayName || t.displayName || t.abbreviation || '' }; };
    const h = side('home'), a = side('away'); if (!h.id || !a.id) continue;
    events.push({ id: String(ev.id), lg, at: ev.date, state: st.state || '', h, a });
  }
  // A competition ESPN didn't answer for keeps its games from the last copy.
  if (old && failed.size) for (const e of (old.events || [])) if (failed.has(e.lg) && !events.some(x => x.id === e.id)) events.push(e);
  const teams = {};
  for (const e of events) for (const [me, op, home] of [[e.h, e.a, true], [e.a, e.h, false]])
    teams[me.id] = { id: me.id, ab: me.ab, nm: me.nm, opp: op.nm, oppAb: op.ab, oppId: op.id, home, at: e.at, ev: e.id, lg: e.lg };
  const out = { at: Date.now(), games: events.length, events, teams, lgs: FC_LEAGUES };
  try { await env.RATEBOARD_KV.put(key, JSON.stringify(out), { expirationTtl: 5 * 86400 }); } catch (e) {}
  return out;
}
/* Starting lineups: { out, teams: { espnTeamId: { f: formation, p: [{ n, j, s (1 = starting), pos }] } } }.
   ESPN's match page has no players at all until the teams are announced. */
const fcLineupKey = id => `fclineup_v1_${id}`;
async function fcLineupFetch(env, ev) {
  let d;
  try { const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${ev.lg}/summary?event=${ev.id}`); if (!r.ok) return null; d = await r.json(); } catch (e) { return null; }
  const teams = {};
  for (const t of (d.rosters || [])) {
    const ro = (t.roster || []).filter(x => x && x.athlete); if (!ro.length || !t.team) continue;
    teams[String(t.team.id)] = { f: t.formation || null, p: ro.map(x => ({ n: x.athlete.displayName || x.athlete.fullName || '', j: x.jersey != null ? String(x.jersey) : null, s: x.starter ? 1 : 0, pos: (x.position || {}).abbreviation || '' })) };
  }
  const out = { at: Date.now(), ev: ev.id, out: Object.keys(teams).length > 0, teams, kick: ev.at, final: Date.now() > Date.parse(ev.at) + 5 * 60000 };
  try { await env.RATEBOARD_KV.put(fcLineupKey(ev.id), JSON.stringify(out), { expirationTtl: 4 * 86400 }); } catch (e) {}
  return out;
}
async function fcLineup(env, ev, fresh) {
  let c = null; try { c = JSON.parse((await env.RATEBOARD_KV.get(fcLineupKey(ev.id))) || 'null'); } catch (e) {}
  const k = Date.parse(ev.at), now = Date.now();
  // Asked for on the page: a copy over 3 minutes old is read again while the lineup could still be coming or changing.
  if (fresh && now > k - 90 * 60000 && ((!c || !c.out) ? (now < k + 3 * 3600000 && (!c || now - c.at > 3 * 60000)) : (!c.final && now - c.at > 3 * 60000))) c = (await fcLineupFetch(env, ev)) || c;
  return c;
}
/* Every minute (collector tick): today's games from 85 minutes before
   kickoff to 20 after - every 3 minutes until the lineups are out, then every
   10 until kickoff, and once after it. Today's slate is re-read every 2 hours. */
export async function fcLineupTick(env) {
  const now = Date.now(), day = etDayOf(new Date(now).toISOString());
  // Once: Dennis's FC boosters, so the names Real gives FC booster stats show on the health page.
  try { if (!(await env.RATEBOARD_KV.get('fc_inv_probe_1')) && env.RATEBOARD_DB) { await env.RATEBOARD_KV.put('fc_inv_probe_1', String(now));
    const dn = await env.RATEBOARD_DB.prepare("SELECT hashId FROM swap_users WHERE key='dennis'").first();
    if (dn && dn.hashId) await boostInventoryAll(env, env.RS_AUTH_TOKEN, dn.hashId, true, true); } } catch (e) {}
  let sc = null; try { sc = JSON.parse((await env.RATEBOARD_KV.get(`boostsched_v2_soccer_${day}`)) || 'null'); } catch (e) {}
  if (!sc || now - sc.at > 2 * 3600000) {
    let tried = 0; try { tried = Number(await env.RATEBOARD_KV.get('fcsched_try_' + day)) || 0; } catch (e) {}
    if (now - tried > 10 * 60000) { try { await env.RATEBOARD_KV.put('fcsched_try_' + day, String(now), { expirationTtl: 86400 }); } catch (e) {}
      const s2 = await fcSchedule(env, day, true); if (s2 && !s2.error) sc = s2; }
  }
  if (!sc || !sc.events) return null;
  let poll = {}; try { poll = JSON.parse((await env.RATEBOARD_KV.get('fclineup_poll_v1')) || '{}') || {}; } catch (e) {}
  const due = sc.events.filter(e => { const k = Date.parse(e.at); return now > k - 85 * 60000 && now < k + 20 * 60000; }).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  let n = 0, got = 0;
  for (const e of due) {
    if (n >= 8) break;
    const k = Date.parse(e.at), last = Number(poll[e.id]) || 0;
    let c = null; try { c = JSON.parse((await env.RATEBOARD_KV.get(fcLineupKey(e.id))) || 'null'); } catch (e2) {}
    if (c && c.final) continue;
    const every = c && c.out ? (now > k ? 0 : 10 * 60000) : 3 * 60000;
    if (now - last < every) continue;
    poll[e.id] = now; n++;
    const r = await fcLineupFetch(env, e); if (r && r.out) got++;
  }
  for (const id of Object.keys(poll)) if (now - poll[id] > 2 * 86400000) delete poll[id];
  if (n) { try { await env.RATEBOARD_KV.put('fclineup_poll_v1', JSON.stringify(poll), { expirationTtl: 3 * 86400 }); } catch (e) {} }
  return n ? `fc lineups ${got}/${n}` : null;
}
// A club's squad from ESPN (only needed when a shared Real code has two of its clubs playing the same day). Kept 2 days.
async function fcSquad(env, lg, id) {
  const key = `fcsquad_v1_${id}`;
  try { const c = JSON.parse((await env.RATEBOARD_KV.get(key)) || 'null'); if (c && Date.now() - c.at < 2 * 86400000) return c.p; } catch (e) {}
  try { const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${lg}/teams/${id}/roster`); if (!r.ok) return [];
    const d = await r.json(); const p = (d.athletes || []).map(a => ({ n: a.displayName || '', j: a.jersey != null ? String(a.jersey) : null }));
    try { await env.RATEBOARD_KV.put(key, JSON.stringify({ at: Date.now(), p }), { expirationTtl: 3 * 86400 }); } catch (e) {}
    return p; } catch (e) { return []; }
}
/* Names: Real's and ESPN's differ for about one player in ten (middle names,
   a dropped first name, Kike for Enrique, ø spelled o). Scored 0-100; a shirt
   number that agrees settles a close call. Checked on 4,700 appearances:
   every exact or near match was the same man. */
const FC_CHARS = { 'ø': 'o', 'Ø': 'o', 'æ': 'ae', 'Æ': 'ae', 'ß': 'ss', 'đ': 'd', 'Đ': 'd', 'ł': 'l', 'Ł': 'l', 'ı': 'i', 'œ': 'oe', 'þ': 'th', 'ð': 'd' };
const fcTokens = n => String(n || '').replace(/[øØæÆßđĐłŁıœþð]/g, c => FC_CHARS[c]).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, ' ').split(/[^a-z]+/).filter(Boolean);
function fcLev(a, b) { if (a === b) return 0; const m = a.length, n = b.length; if (!m || !n) return m || n; let p = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) { const c = [i]; for (let j = 1; j <= n; j++) c[j] = Math.min(p[j] + 1, c[j - 1] + 1, p[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); p = c; } return p[n]; }
const fcNear = (a, b) => a === b || (a.length >= 5 && b.length >= 5 && fcLev(a, b) <= (Math.min(a.length, b.length) >= 8 ? 2 : 1));
function fcScore(a, b) {
  const A = fcTokens(a), B = fcTokens(b); if (!A.length || !B.length) return 0;
  const ka = A.join(''), kb = B.join('');
  if (ka === kb) return 100;
  if (fcNear(ka, kb)) return 92;
  const [S, L] = A.length <= B.length ? [A, B] : [B, A];
  const hit = S.filter(t => L.some(u => fcNear(t, u))).length;
  const lastA = A[A.length - 1], lastB = B[B.length - 1];
  if (hit === S.length) return S.length >= 2 ? 88 : (S[0].length >= 4 ? 75 : 0);
  if (fcNear(lastA, lastB) && A[0][0] === B[0][0]) return 80;
  if (fcNear(lastA, lastB)) return 60;
  if (S.length >= 2 && hit >= 2) return 70;
  return hit ? 30 : 0;
}
// { p, s, sure } for the best match in a list of { n, j }, or null. sure = clearly him.
function fcFind(name, list, jersey) {
  let best = null, second = 0;
  for (const p of (list || [])) {
    let s = fcScore(name, p.n);
    if (jersey != null && p.j != null && String(jersey) === String(p.j) && s >= 30) s = Math.max(s, 85) + 10;
    if (!best || s > best.s) { second = best ? best.s : 0; best = { p, s }; } else if (s > second) second = s;
  }
  if (!best || best.s < 60 || best.s - second < 10) return null;
  return { p: best.p, s: best.s, sure: best.s >= 70 };
}
/* Real's FC booster attributes, read off the stored stat line. The labels
   Real uses are matched loosely (the first boosters read are logged for the
   health page), so "Shots on target", "SOT" and "Shots On Goal" all land on
   the same count; anything not recognised adds nothing rather than a guess. */
const FC_STAT_KEY = { goal: 'goal', goals: 'goal', g: 'goal', gls: 'goal', gl: 'goal', assist: 'ast', assists: 'ast', a: 'ast', ast: 'ast', as: 'ast',
  shotsontarget: 'sot', sot: 'sot', shotsongoal: 'sot', shotontarget: 'sot', ontarget: 'sot', shots: 'chance', shot: 'chance', sh: 'chance', totalshots: 'chance',
  keypasses: 'cc', keypass: 'cc', kp: 'cc', chancescreated: 'cc', chancecreated: 'cc', cc: 'cc', bigchancescreated: 'bcc', bcc: 'bcc',
  tackles: 'tkl', tackle: 'tkl', tkl: 'tkl', tk: 'tkl', saves: 'save', save: 'save', sv: 'save', svs: 'save',
  passes: 'pass', pass: 'pass', passescompleted: 'pass', accuratepasses: 'pass', completedpasses: 'pass', pc: 'pass',
  touches: 'touch', touch: 'touch', touchesinoppbox: 'tOppBox', touchesinbox: 'tOppBox', duelswon: 'duel', duels: 'duel',
  xg: 'xG', expectedgoals: 'xG', xa: 'xA', expectedassists: 'xA', xgot: 'xGOT', goalsconceded: 'ga', conceded: 'ga' };
function fcStat(row, label) {
  let o = row._s; if (o === undefined) { try { o = JSON.parse(row.stats || '{}') || {}; } catch (e) { o = {}; } row._s = o; }
  const n = v => { const m = String(v == null ? '' : v).match(/^-?\d+(\.\d+)?/); return m ? Number(m[0]) : 0; };
  const raw = String(label || '');
  if (/\+/.test(raw)) return raw.split('+').reduce((t, part) => { const v = fcStat(row, part.trim()); return v == null ? t : (t || 0) + v; }, null);   // "G+A"
  const k = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (k === 'cleansheet' || k === 'cleansheets' || k === 'cs') return row.oppScore === 0 && (fcMin(row) >= 60) ? 1 : 0;
  const col = FC_STAT_KEY[k] || Object.keys(o).find(x => x.toLowerCase() === k);
  /* Some national-team competitions don't track every stat (Nations League has
     no duels - a member, 2026-11-12): missing there means not counted, not 0,
     so those games are left out of that stat's average. */
  if (col && (o[col] == null || o[col] === '') && FC_NAT_CONF.has(String(row.conference || '').toUpperCase())) return null;
  return col ? n(o[col]) : null;
}
// Minutes: Real leaves them off goalkeepers almost always (they play the 90).
const fcMin = x => Number(x.min) > 0 ? Number(x.min) : String(x.position || '').toUpperCase() === 'G' ? 90 : (Number(x.rax) !== 0 ? 30 : 0);
const fcPlayed = x => fcMin(x) > 0;
// A typical start's rax by position (this season's starts, Nov 2026).
const FC_POS_START = { G: 6.6, D: 6.05, M: 7.65, F: 7.2 };
/* Opponents, by Real code (codes shared by two clubs are left out; MLS on
   its own, since its codes overlap Europe's and Mexico's): how much rax his
   starters give up (f, pulled to 1 on a small sample, kept 0.85-1.2), and the
   goals he concedes a game over his last 10 (ga). Built daily by the refresh. */
async function fcMatchups(env) {
  const db = env.RATEBOARD_DB; if (!db) return;
  let rows = [], gms = [];
  try { rows = (await db.prepare(`SELECT opponent AS o, (conference = 'MLS') AS m, AVG(rax) AS a, COUNT(*) AS n FROM gamelog WHERE sport='soccer' AND season IN (?, ?) AND rax IS NOT NULL AND (min >= 55 OR position = 'G') AND opponent IS NOT NULL GROUP BY opponent, (conference = 'MLS')`).bind(FC_SEASON[0], FC_SEASON[1]).all()).results || []; } catch (e) { return; }
  try { gms = (await db.prepare(`SELECT team AS t, (conference = 'MLS') AS m, gameId AS g, MAX(day) AS d, MAX(oppScore) AS ga FROM gamelog WHERE sport='soccer' AND season IN (?, ?) AND day >= ? GROUP BY team, (conference = 'MLS'), gameId`).bind(FC_SEASON[0], FC_SEASON[1], etDayOf(new Date(Date.now() - 200 * 86400000).toISOString())).all()).results || []; } catch (e) {}
  const out = { at: Date.now(), f: {}, fm: {}, ga: {}, gam: {}, lg: 1.35 };
  for (const m of [0, 1]) {
    const rs = rows.filter(r => Number(r.m) === m), tot = rs.reduce((t, r) => t + r.a * r.n, 0), n = rs.reduce((t, r) => t + r.n, 0); if (!n) continue;
    const mean = tot / n, f = m ? out.fm : out.f;
    for (const r of rs) { if (!m && (FC_CLUBS[r.o] || []).length > 1) continue; const w = r.n / (r.n + 40); f[r.o] = Math.round(Math.min(1.2, Math.max(0.85, 1 + (r.a / mean - 1) * w)) * 100) / 100; }
  }
  const by = new Map();
  for (const g of gms) { if (!Number(g.m) && (FC_CLUBS[g.t] || []).length > 1) continue; const k = (Number(g.m) ? 'M|' : '') + g.t; (by.get(k) || by.set(k, []).get(k)).push(g); }
  let gsum = 0, gn = 0;
  for (const [k, list] of by) { list.sort((a, b) => a.d < b.d ? -1 : 1); const l = list.slice(-10).map(x => Number(x.ga) || 0); if (l.length < 3) continue;
    const a = l.reduce((t, x) => t + x, 0) / l.length; gsum += a; gn++;
    if (k.startsWith('M|')) out.gam[k.slice(2)] = Math.round(a * 100) / 100; else out.ga[k] = Math.round(a * 100) / 100; }
  if (gn) out.lg = Math.round(gsum / gn * 100) / 100;
  try { await env.RATEBOARD_KV.put('boostmatch_v2_soccer', JSON.stringify(out), { expirationTtl: 5 * 86400 }); } catch (e) {}
}
// Each player's games (this season and last) from the game log, oldest first.
async function fcGames(db, ids, before, seasons) {
  const cur = new Map(), old = new Map(), [s0, s1] = seasons || FC_SEASON;
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90), ph = part.map(() => '?').join(',');
    for (const [se, m] of [[s0, cur], [s1, old]]) {
      if (se == null) continue;
      try { const r = await db.prepare(`SELECT playerId, day, rax, min, team, conference, position, player, jersey, stats, opponent, homeAway, oppScore FROM gamelog
          WHERE sport='soccer' AND season=? AND rax IS NOT NULL AND day < ? AND playerId IN (${ph}) ORDER BY day`).bind(se, before, ...part).all();
        for (const x of (r.results || [])) (m.get(Number(x.playerId)) || m.set(Number(x.playerId), []).get(Number(x.playerId))).push(x); } catch (e) {}
    }
  }
  return { cur, old };
}
// His club (latest club game) and national team (latest national game, within a year).
function fcSides(gs, os) {
  const all = os.concat(gs);
  let club = null, nat = null;
  for (let i = all.length - 1; i >= 0 && (!club || !nat); i--) { const x = all[i];
    if (FC_NAT_CONF.has(String(x.conference || '').toUpperCase())) { if (!nat) nat = x; } else if (!club) club = x; }
  if (nat && Date.now() - Date.parse(nat.day + 'T12:00:00Z') > 400 * 86400000) nat = null;   // no cap in over a year
  return { club, nat };
}
/* The team a player turns out for on a day's slate: his club's (or his
   country's) ESPN id among the teams playing. A Real code shared by two clubs
   that both play is settled by the lineups, then the club's squad list. */
/* Clubs behind a shared Real code, by ESPN league: Real's "conference" on
   his rows (EFL, SERA, ...) says which of them is his - BOL in the
   Championship is Bolton, in Serie A Bologna (2026-11-07: Josh Sheehan was
   put in Bologna's game). Codes Real files under UCL/UEL (LEV, CEL) don't
   say, so for those he has to be found in that club's lineup or squad. */
const FC_CLUB_LG = { 226: 'mex.1', 216: 'mex.1', 358: 'eng.2', 107: 'ita.1', 337: 'eng.1', 6997: 'fra.1', 85: 'esp.1', 256: 'sco.1', 1538: 'esp.1', 131: 'ger.1', 490: 'bul.1',
  391: 'eng.2', 103: 'ita.1', 220: 'mex.1', 4007: 'ita.1', 115: 'ita.1', 6851: 'fra.1', 385: 'eng.2', 437: 'por.1', 225: 'mex.1', 494: 'cze.1', 239: 'ita.1', 21615: 'por.1' };
const FC_CONF_LG = { EPL: 'eng.1', EFL: 'eng.2', LIGA: 'esp.1', SERA: 'ita.1', BUN: 'ger.1', LIG1: 'fra.1', LIGAMX: 'mex.1' };
function fcClubIds(row) {
  let ids = fcTeamIds(row.team, false);
  if (ids.length > 1) { const lg = FC_CONF_LG[String(row.conference || '').toUpperCase()]; const f = lg ? ids.filter(id => FC_CLUB_LG[id] === lg) : [];
    if (f.length) ids = f; }
  return ids;
}
/* The team a player turns out for on a day's slate: his club's (or his
   country's) ESPN id among the teams playing. When his code could still be
   more than one club, he has to be in that club's lineup (once out) or its
   squad list - otherwise he isn't counted as playing. */
async function fcTeamOn(env, sched, sides, name, jersey, lineups) {
  const cand = [];
  if (sides.mls) {   // an MLS card: his MLS club's game, nothing else
    const x = sides.club; if (!x) return null;
    const id = FC_MLS[String(x.team).toUpperCase()] ? String(FC_MLS[String(x.team).toUpperCase()]) : (Object.values(sched.teams).find(t => t.lg === 'usa.1' && t.ab === x.team) || {}).id;
    return id && sched.teams[id] && sched.teams[id].lg === 'usa.1' ? { id, nat: false, mls: true } : null;
  }
  for (const [x, nat] of [[sides.club, false], [sides.nat, true]]) {
    if (!x) continue;
    const all = nat ? fcTeamIds(x.team, true) : fcClubIds(x);
    let ids = all.filter(id => sched.teams[id] && sched.teams[id].lg !== 'usa.1');
    if (!ids.length && !(nat ? FC_NATS : FC_CLUBS)[String(x.team).toUpperCase()])   // a code we don't know yet: ESPN's abbreviation
      ids = Object.values(sched.teams).filter(t => t.ab === x.team && t.lg !== 'usa.1' && FC_NAT_LG.has(t.lg) === nat).map(t => t.id);
    for (const id of ids) cand.push({ id, nat, check: nat || all.length > 1 });
  }
  const ok = [];
  for (const c of cand) {
    if (!c.check) { ok.push(c); continue; }
    const t = sched.teams[c.id], lu = lineups.get(t.ev), LT = lu && lu.out && lu.teams[c.id];
    if (LT) { if (fcFind(name, LT.p, jersey)) ok.push(c); continue; }
    const sq = await fcSquad(env, t.lg, c.id);
    if (sq.length >= 15) { const f = fcFind(name, sq, jersey); if (f && f.sure) ok.push(c); }
    else if (c.nat) ok.push(c);   // no call-up list from ESPN yet: his country's game counts
  }
  return ok.find(c => !c.nat) || ok[0] || null;
}
/* Real's own injury list (Dennis, 2026-11-28: Olise was out and still got a booster - FPL only covers the Premier
   League). Each player's Real record carries injuryStatus ("Out", "Doubtful", "Questionable"...) and a note such as
   "Expected return: 2026-11-29", in every league. Kept 2 hours per player, shared by everyone; at most 80 new reads
   a call, 5 at a time. */
async function realInjuries(env, sp, ids) {
  const out = {}, need = [];
  await Promise.all([...new Set(ids.map(Number).filter(Number.isFinite))].map(async id => {
    try { const c = JSON.parse((await env.RATEBOARD_KV.get(`rinj_v1_${sp}_${id}`)) || 'null'); if (c) { if (c.s) out[id] = c; return; } } catch (e) {}
    need.push(id); }));
  const tok = scanTok(env), q = need.slice(0, 80);
  const work = async () => { while (q.length) { const id = q.shift();
    try { const d = await rsGetJson(`https://web.realapp.com/players/${id}/sport/${sp}`, tok), p = (d && d.player) || {};
      const c = { s: p.injuryStatus || null, b: p.injuryBodyPart || null, n: p.injuryNotes || null };
      await env.RATEBOARD_KV.put(`rinj_v1_${sp}_${id}`, JSON.stringify(c), { expirationTtl: 7200 }); if (c.s) out[id] = c;
    } catch (e) {} } };
  await Promise.all([work(), work(), work(), work(), work()]);
  return out;
}
/* One row per FC pass the member holds whose team plays that day.
   Projection: what he earns when he starts (min 55+; last 5 starts 50%, this
   season's 30%, last season's 20%), x home 1.05 / away 0.95, x how much the
   opponent gives up. Lineups decide: on the bench or out of the squad = no
   booster. Before the lineups, a regular starter keeps his starting number;
   a rotation player's is mixed with what he gets off the bench. */
async function fcRows(env, db, cards, day, inv) {
  const sched = await fcSchedule(env, day);
  if (sched.error) return sched;
  const isM = p => Number(p.season) === FC_MLS_SEASON;
  const ids = [...new Set(cards.players.filter(p => !isM(p)).map(p => Number(p.id)).filter(Number.isFinite))];
  const idsM = [...new Set(cards.players.filter(isM).map(p => Number(p.id)).filter(Number.isFinite))];
  const { cur, old } = await fcGames(db, ids, day);
  const { cur: curM } = idsM.length ? await fcGames(db, idsM, day, [FC_MLS_SEASON, null]) : { cur: new Map() };
  const mlsOnly = a => a.filter(x => String(x.conference || '').toUpperCase() === 'MLS');
  let MT = null; try { MT = JSON.parse((await env.RATEBOARD_KV.get('boostmatch_v2_soccer')) || 'null'); } catch (e) {}
  if (!MT) { try { await fcMatchups(env); MT = JSON.parse((await env.RATEBOARD_KV.get('boostmatch_v2_soccer')) || 'null'); } catch (e) {} }
  MT = MT || { f: {}, fm: {}, ga: {}, gam: {}, lg: 1.35 };
  let hand = {}; try { hand = await boostManualOut(env, 'soccer', day); } catch (e) {}
  let rinj = {}; try { rinj = await realInjuries(env, 'soccer', cards.players.map(p => p.id)); } catch (e) {}
  /* Each club's latest logged game (2026-11-28: every MLS pass was left out as "No game since Nov 1" - the MLS
     playoffs aren't in the game log, so the gap was the log's, not the player's). Games he could have played in only:
     the log holds rows with no rax for games not played yet, which made every MLS club look like it had played Nov 7
     (min blank, rax 0) - so a game counts only with minutes or rax, keepers' rows included the same way. */
  const clubLast = new Map();
  try { for (const x of ((await db.prepare("SELECT team, season, MAX(day) AS d FROM gamelog WHERE sport='soccer' AND season IN (?, ?) AND day < ? AND rax IS NOT NULL AND (min > 0 OR rax <> 0) GROUP BY team, season").bind(FC_SEASON[0], FC_MLS_SEASON, day).all()).results || []))
    clubLast.set(`${x.season}|${x.team}`, x.d); } catch (e) {}
  // Lineups for every game on the slate that has one (read again if it could still change).
  const lineups = new Map();
  await Promise.all((sched.events || []).map(async e => { const l = await fcLineup(env, e, true); if (l) lineups.set(e.id, l); }));
  const want = inv ? [...new Set(inv.flatMap(b => (b.attrs || []).map(a => a.stat)))] : [];
  const avg = a => a.length ? a.reduce((t, x) => t + Number(x.rax || 0), 0) / a.length : null;
  const mean = (a, f) => { const v = a.map(f).filter(x => x != null); return v.length ? v.reduce((t, x) => t + x, 0) / v.length : null; };
  const blend = (r5, all, last) => r5 == null ? last : last != null ? 0.5 * r5 + 0.3 * all + 0.2 * last : 0.6 * r5 + 0.4 * all;
  const tm = iso => new Date(iso).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }) + ' ET';
  const dayMs = Date.parse(day + 'T12:00:00Z');
  const rows = [], idle = [];
  for (const p of cards.players) {
    const M = isM(p);
    const gs = (M ? mlsOnly(curM.get(Number(p.id)) || []) : (cur.get(Number(p.id)) || [])).filter(fcPlayed), os = M ? [] : (old.get(Number(p.id)) || []).filter(x => String(x.conference || '').toUpperCase() !== 'MLS').filter(fcPlayed);
    const lastG = gs[gs.length - 1] || os[os.length - 1];
    const name = p.name || (lastG && lastG.player) || 'Player ' + p.id;
    // A 2025 card that isn't an MLS player's (last season's European cards) has no games left.
    if (M && !gs.length) { idle.push(name); continue; }
    const sides = M ? { club: lastG, nat: null, mls: true } : fcSides(gs, os);
    if (!sides.club && !sides.nat) { idle.push(name); continue; }
    const jersey = (lastG && lastG.jersey != null) ? lastG.jersey : null;
    const side = await fcTeamOn(env, sched, sides, name, jersey, lineups);
    if (!side) { idle.push(name); continue; }
    const g = sched.teams[side.id];
    // Club numbers for a club game, his national-team games for a country's.
    const pick = a => a.filter(x => FC_NAT_CONF.has(String(x.conference || '').toUpperCase()) === side.nat);
    const cg = pick(gs), og = pick(os);
    const useC = cg.length >= 3 || !side.nat ? cg : gs, useO = og.length >= 3 || !side.nat ? og : os;   // too few caps: his club form stands in
    const starts = useC.filter(x => fcMin(x) >= 55), ostarts = useO.filter(x => fcMin(x) >= 55), subs = useC.filter(x => fcMin(x) < 55);
    /* In a start (2026-11-07, backtested on 14,000 starts this season): every
       start he's made (last season's, then this one's), the most recent
       counting most (weight halves every 5 starts back), half of it mixed with
       his plain average pulled toward a typical starter at his position by 8
       starts' worth - so a hot or cold run of 4-5 games doesn't swing him as
       hard. Then the opponent (rax given up, goals conceded) and home/away.
       Against "last 5 starts weighted" it picked better: the top 10% of
       projections averaged 10.4 rax against 9.8, the top 3% 11.9 against 10.9. */
    const hist = ostarts.concat(starts).map(x => Number(x.rax) || 0);
    let startProj = null, basis = '';
    if (hist.length) {
      let ws = 0, wv = 0; hist.forEach((v, i) => { const w = Math.pow(0.5, (hist.length - 1 - i) / 5); ws += w; wv += w * v; });
      const pm = FC_POS_START[String((lastG && lastG.position) || '').toUpperCase()] || 7;
      const shr = (hist.reduce((t, v) => t + v, 0) + 8 * pm) / (hist.length + 8);
      startProj = 0.5 * (wv / ws) + 0.5 * shr;
      basis = `${starts.length} start${starts.length === 1 ? '' : 's'} this season` + (ostarts.length ? ` + ${ostarts.length} last season` : '') + ', recent ones weighted most';
    } else if (useC.length) { startProj = Math.min(9, avg(useC) * 1.6); basis = 'off the bench only so far'; }
    const subProj = subs.length >= 2 ? avg(subs) : startProj != null ? startProj * 0.3 : null;
    const last5 = useC.slice(-5), startN = last5.filter(x => fcMin(x) >= 55).length, rate = last5.length ? startN / last5.length : 0;
    const flags = [];
    let skip = false, k = 1, lu = 'tbd', proj;
    // The lineup, if it's out.
    const L = lineups.get(g.ev), LT = L && L.out ? L.teams[side.id] : null;
    if (LT) {
      const f = fcFind(name, LT.p, jersey);
      if (!f) { lu = 'out'; skip = true; flags.push('Not in the matchday squad'); }
      else {
        lu = f.p.s ? 'start' : 'bench';
        if (!f.sure) flags.push(`Lineup name check: listed as ${f.p.n}`);
        if (!f.p.s) { skip = true; flags.push('On the bench' + (rate >= 0.8 ? ' (rested - he usually starts)' : '')); }
      }
    } else {
      const k0 = Date.parse(g.at);
      flags.push(Date.now() > k0 ? 'No lineup from ESPN for this game' : `Lineup not out yet - due about ${tm(new Date(k0 - 60 * 60000).toISOString())}`);
      if (last5.length >= 3 && rate < 0.6) flags.push(`Started ${startN} of his last ${last5.length}`);
      // Played a full game in the last 3 days: rotation risk.
      const prev = useC[useC.length - 1];
      if (prev && fcMin(prev) >= 80 && dayMs - Date.parse(prev.day + 'T12:00:00Z') <= 3 * 86400000) flags.push(`Played ${fcMin(prev)} min ${Math.round((dayMs - Date.parse(prev.day + 'T12:00:00Z')) / 86400000)} day(s) ago - rest risk`);
    }
    if (startProj == null) { proj = null; basis = 'not enough data'; }
    else if (lu === 'start' || (lu === 'tbd' && rate >= 0.8) || (lu === 'tbd' && last5.length < 3)) proj = startProj;
    else if (lu === 'tbd') proj = startProj * rate + (subProj ?? 0) * (1 - rate);
    else proj = lu === 'bench' ? subProj : 0;
    // Hand-set injuries (Boosts' admin list).
    const ij = hand[boostName(name)];
    if (ij && lu !== 'start') {
      if (/^(out|injured reserve|doubtful|suspen)/i.test(ij.status)) { skip = true; flags.push(`${ij.status}${ij.note ? ': ' + ij.note : ''}`); }
      else if (/questionable/i.test(ij.status)) { k *= Q_CUT; flags.push(`Questionable${ij.note ? ': ' + ij.note : ''}`); }
    }
    // Real's own injury list (2026-11-28), when the hand list says nothing about him. A starting lineup overrides it.
    const ri = !ij && rinj[Number(p.id)];
    if (ri && lu !== 'start') { const why = [ri.b, ri.n].filter(Boolean).join(' - ');
      if (/^(out|injured|doubtful|suspen)/i.test(ri.s)) { skip = true; flags.push(`${ri.s}${why ? ': ' + why : ''} (Real)`); }
      else if (/question|day-to-day/i.test(ri.s)) { k *= Q_CUT; flags.push(`Questionable${why ? ': ' + why : ''} (Real)`); } }
    // Hasn't played in three weeks while his club has: injured or dropped (a starting lineup overrides it).
    // Only when his club has played since without him; a club with nothing newer in the log is a gap in the log.
    const clubSince = lastG ? clubLast.get(`${M ? FC_MLS_SEASON : FC_SEASON[0]}|${lastG.team}`) : null;
    if (lu !== 'start' && lastG && cg.length && dayMs - Date.parse(lastG.day + 'T12:00:00Z') > 21 * 86400000 && clubSince && clubSince > lastG.day) { skip = true; flags.push(`No game since ${lastG.day}`); }
    else if (lu !== 'start' && lastG && dayMs - Date.parse(lastG.day + 'T12:00:00Z') > 21 * 86400000) flags.push(`Last logged game ${lastG.day} (his club's too - playoffs or a break)`);
    if (!cg.length && og.length && lu !== 'start') { k *= 0.7; flags.push('No games this season yet'); }
    const oppKeys = fcKeysOf(g.oppId).filter(x => x.nat === side.nat && !!x.mls === !!side.mls && !(side.mls && FC_CLUBS[x.key]));
    const ok1 = oppKeys.length === 1 ? oppKeys[0].key : null;
    const of = ok1 ? (side.mls ? MT.fm : MT.f)[ok1] : null, oga = ok1 ? (side.mls ? MT.gam : MT.ga)[ok1] : null;
    // Opponent: 70% of the rax he gives up; his goals conceded against the average, to the 0.35 (kept 0.8-1.25).
    const gfac = oga != null && MT.lg ? Math.min(1.25, Math.max(0.8, Math.pow(Math.max(0.2, oga) / MT.lg, 0.35))) : 1;
    const mf = Math.round((of ? 1 + (of - 1) * 0.7 : 1) * gfac * 100) / 100;
    const hf = g.home ? 1.05 : 0.95;
    if (proj != null && mf !== 1) basis += ` · matchup x${mf}${oga != null ? ` (they concede ${oga} a game)` : ''}`;
    // Expected count of each booster stat in a start.
    const exp = {};
    for (const st of want) {
      /* National-team games: Real doesn't count duels there (Dennis, 2026-11-15), so a duels
         booster earns nothing - no duels number, and the booster's other side or another booster is used. */
      if (side.nat && /duel/i.test(String(st))) continue;
      const e = blend(mean(starts.slice(-5), x => fcStat(x, st)), mean(starts, x => fcStat(x, st)), mean(ostarts, x => fcStat(x, st))) ?? mean(useC, x => fcStat(x, st));
      const att = /^(goals?|g|gls|assists?|a|ast)$/i.test(String(st).replace(/[^a-z]/gi, ''));
      if (e != null) exp[st] = Math.round(e * k * (att ? gfac : 1) * (lu === 'tbd' && rate < 0.8 && last5.length >= 3 ? rate : 1) * 100) / 100;
    }
    const pos = (lastG && lastG.position) || '';
    rows.push({ id: p.id, passId: p.passId, pm: p.mult || null, plv: p.levelLabel || null, season: M ? FC_MLS_SEASON : FC_SEASON[0], name, team: g.nm, tid: null, pos, opp: g.opp, home: g.home, at: g.at, exp, lu, form: LT ? LT.f : null, lg: g.lg, nat: side.nat,
      avg: avg(cg) == null ? null : Math.round(avg(cg) * 10) / 10, games: cg.length, avgLast: avg(og) == null ? null : Math.round(avg(og) * 10) / 10,
      proj: proj == null ? null : Math.round(proj * k * mf * hf * 10) / 10, basis, flags, skip, fresh: false, noData: startProj == null });
  }
  const outN = [...lineups.values()].filter(l => l.out).length;
  return { rows, idle, sched: { games: sched.games, lineups: outN, lineupsAt: Math.max(0, ...[...lineups.values()].map(l => l.at || 0)) || null } };
}


/* ---- Projections (2026-11-05) ----------------------------------------------
   Each player's rax by the end of his regular season: what he has, plus his
   per-game projection (the Boosts formula) for each game his team has left,
   adjusted for that opponent. "On pace" is plain: rax / games played x the
   team's regular-season games. Rebuilt at most every 6 hours, kept in KV. */
const PROJ_SEASON = { ncaaf: [2026, 2025], nfl: [2026, 2025], ncaam: [2027, 2026], nba: [2027, 2026], nhl: [2026, 2025], soccer: [2026, 2025] };
const PROJ_PATH = { ...ESPN_PATH, nba: 'basketball/nba', nhl: 'hockey/nhl' };
// Real's team codes that ESPN writes differently.
const PROJ_ALIAS = { nba: { GSW: 'GS', NOP: 'NO', NYK: 'NY', SAS: 'SA', UTA: 'UTAH', WAS: 'WSH', VICE: 'MIA' }, nhl: { LAK: 'LA', NJD: 'NJ', SJS: 'SJ', TBL: 'TB', UTA: 'UTAH' } };
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
  const etd = iso => ET_DAY_FMT.format(new Date(iso));
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
/* Projections are rebuilt only when the game data changes (Dennis,
   2026-11-08 - was every 6 hours whatever happened): a fingerprint of the
   season's regular-season game log (games, latest day, total rax), checked at
   most every 15 minutes per sport. */
/* ---- Tag finder (Dennis, 2026-11-09) ---------------------------------
   Performance tags (the whole game's line) and the games that earned them,
   worked out from each game's stat line in the game log. Starting with the
   NFL's Iconic ones; a tag is one entry here. sql narrows the scan (the
   database checks it), test() decides, line() is what the page shows. */
const tagJ = k => `CAST(json_extract(stats, '$."${k}"') AS REAL)`;
const tagFrac = (k, part) => { const v = `json_extract(stats, '$."${k}"')`;
  return `CAST(${part === 0 ? `substr(${v}, 1, instr(${v}, '/') - 1)` : `substr(${v}, instr(${v}, '/') + 1)`} AS INTEGER)`; };
const tn = v => { const m = String(v == null ? '' : v).match(/^-?\d+(\.\d+)?/); return m ? Number(m[0]) : 0; };
const tfrac = (v, i) => { const m = String(v || '').match(/^(\d+)\/(\d+)$/); return m ? Number(m[i + 1]) : 0; };
const tTds = o => Math.max(tn(o.td), tn(o.rutd) + tn(o.retd));
const TAG_DEFS_V = 9;   // 9: NBA Legendary   // 8: NBA   // 7: MLB   // 6: CFB   // 5: #marksman defined   // 3: Mystic NFL; 4: Legendary NFL (2026-11-09)   // 2: Real's own tags and box-score links (2026-11-09)
export const TAG_DEFS = {
  nfl: [
    { tag: '#3hundo', rarity: 'iconic', desc: '300+ rushing + receiving yards', sql: `COALESCE(${tagJ('ruyds')}, 0) + COALESCE(${tagJ('reyds')}, 0) >= 300`,
      test: o => tn(o.ruyds) + tn(o.reyds) >= 300, line: o => `${tn(o.ruyds)} rush + ${tn(o.reyds)} rec yds` },
    { tag: '#jackson', rarity: 'iconic', desc: '20+ receptions', sql: `${tagJ('rec')} >= 20`, test: o => tn(o.rec) >= 20, line: o => `${tn(o.rec)} rec, ${tn(o.reyds)} yds` },
    { tag: '#5tuddy', rarity: 'iconic', desc: '5+ TDs (not passing)', sql: `MAX(COALESCE(${tagJ('td')}, 0), COALESCE(${tagJ('rutd')}, 0) + COALESCE(${tagJ('retd')}, 0)) >= 5`,
      test: o => tTds(o) >= 5, line: o => `${tTds(o)} TDs` },
    { tag: '#tdtrick', rarity: 'iconic', desc: 'Passing, rushing and receiving touchdown in the same game', sql: `${tagJ('ptd')} >= 1 AND ${tagJ('rutd')} >= 1 AND ${tagJ('retd')} >= 1`,
      test: o => tn(o.ptd) >= 1 && tn(o.rutd) >= 1 && tn(o.retd) >= 1, line: o => `${tn(o.ptd)} pass, ${tn(o.rutd)} rush, ${tn(o.retd)} rec TD` },
    { tag: '#perfectcompletions', rarity: 'iconic', desc: '100% completions with 15+ attempts',
      sql: `json_extract(stats, '$."c/att"') LIKE '%/%' AND ${tagFrac('c/att', 0)} = ${tagFrac('c/att', 1)} AND ${tagFrac('c/att', 1)} >= 15`,
      test: o => tfrac(o['c/att'], 1) >= 15 && tfrac(o['c/att'], 0) === tfrac(o['c/att'], 1), line: o => `${o['c/att']}, ${tn(o.pyds)} yds` },
    { tag: '#air6hundo', rarity: 'iconic', desc: '600+ passing yards', sql: `${tagJ('pyds')} >= 600`, test: o => tn(o.pyds) >= 600, line: o => `${tn(o.pyds)} pass yds` },
    { tag: '#platniumarm', alias: ['platinumarm'], rarity: 'iconic', desc: '7+ passing TDs', sql: `${tagJ('ptd')} >= 7`, test: o => tn(o.ptd) >= 7, line: o => `${tn(o.ptd)} pass TDs` },
    { tag: '#eightball', alias: ['8ball'], rarity: 'iconic', desc: '8+ total TDs (passing included)', sql: `COALESCE(${tagJ('ptd')}, 0) + MAX(COALESCE(${tagJ('td')}, 0), COALESCE(${tagJ('rutd')}, 0) + COALESCE(${tagJ('retd')}, 0)) >= 8`,
      test: o => tn(o.ptd) + tTds(o) >= 8, line: o => `${tn(o.ptd) + tTds(o)} total TDs` },
    // A quarterback's "sack" and "int" are ones he took and threw, so they don't count.
    { tag: '#boogeyman', rarity: 'iconic', desc: '6+ sacks', sql: `${tagJ('sack')} >= 6 AND COALESCE(position, '') <> 'QB'`,
      test: (o, pos) => pos !== 'QB' && tn(o.sack) >= 6, line: o => `${tn(o.sack)} sacks` },
    { tag: '#magnet', rarity: 'iconic', desc: '4+ interceptions (defense)', sql: `${tagJ('int')} >= 4 AND COALESCE(position, '') <> 'QB'`,
      test: (o, pos) => pos !== 'QB' && tn(o.int) >= 4, line: o => `${tn(o.int)} INTs` },
    { tag: '#diamondboot', rarity: 'iconic', desc: '7+ field goals', sql: `json_extract(stats, '$."fg%"') LIKE '%/%' AND ${tagFrac('fg%', 0)} >= 7`,
      test: o => tfrac(o['fg%'], 0) >= 7, line: o => `${o['fg%']} FG` },
    /* Mystic (Dennis, 2026-11-09). Where an Iconic tag covers the next step up
       (300+ yards, 600+ passing, 7+ TDs, 6+ sacks, 4+ INTs, 7+ FGs), the
       Mystic one stops below it - a game gets its highest tag. */
    { tag: '#2fitty', rarity: 'mystic', desc: '250+ rushing + receiving yards', sql: `COALESCE(${tagJ('ruyds')}, 0) + COALESCE(${tagJ('reyds')}, 0) BETWEEN 250 AND 299`,
      test: o => { const y = tn(o.ruyds) + tn(o.reyds); return y >= 250 && y < 300; }, line: o => `${tn(o.ruyds)} rush + ${tn(o.reyds)} rec yds` },
    { tag: '#air5hundo', rarity: 'mystic', desc: '500+ passing yards', sql: `${tagJ('pyds')} BETWEEN 500 AND 599`, test: o => tn(o.pyds) >= 500 && tn(o.pyds) < 600, line: o => `${tn(o.pyds)} pass yds` },
    { tag: '#goldenarm', rarity: 'mystic', desc: '6 passing TDs', sql: `${tagJ('ptd')} = 6`, test: o => tn(o.ptd) === 6, line: o => `${tn(o.ptd)} pass TDs` },
    { tag: '#nightmare', rarity: 'mystic', desc: '5 sacks', sql: `${tagJ('sack')} >= 5 AND ${tagJ('sack')} < 6 AND COALESCE(position, '') <> 'QB'`,
      test: (o, pos) => pos !== 'QB' && tn(o.sack) >= 5 && tn(o.sack) < 6, line: o => `${tn(o.sack)} sacks` },
    { tag: '#enforcer', rarity: 'mystic', desc: '3+ forced fumbles', sql: `${tagJ('ff')} >= 3 AND COALESCE(position, '') <> 'QB'`,
      test: (o, pos) => pos !== 'QB' && tn(o.ff) >= 3, line: o => `${tn(o.ff)} forced fumbles` },
    { tag: '#triplepick', rarity: 'mystic', desc: '3 interceptions (defense)', sql: `${tagJ('int')} = 3 AND COALESCE(position, '') <> 'QB'`,
      test: (o, pos) => pos !== 'QB' && tn(o.int) === 3, line: o => `${tn(o.int)} INTs` },
    { tag: '#platniumboot', alias: ['platinumboot'], rarity: 'mystic', desc: '6 field goals', sql: `json_extract(stats, '$."fg%"') LIKE '%/%' AND ${tagFrac('fg%', 0)} = 6`,
      test: o => tfrac(o['fg%'], 0) === 6, line: o => `${o['fg%']} FG` },
    // Legendary (Dennis, 2026-11-09), stopping below the Mystic / Iconic ones above it the same way.
    { tag: '#2hundo', rarity: 'legendary', desc: '200+ rushing + receiving yards', sql: `COALESCE(${tagJ('ruyds')}, 0) + COALESCE(${tagJ('reyds')}, 0) BETWEEN 200 AND 249`,
      test: o => { const y = tn(o.ruyds) + tn(o.reyds); return y >= 200 && y < 250; }, line: o => `${tn(o.ruyds)} rush + ${tn(o.reyds)} rec yds` },
    { tag: '#nickeldime', rarity: 'legendary', desc: '15+ receptions', sql: `${tagJ('rec')} BETWEEN 15 AND 19`, test: o => tn(o.rec) >= 15 && tn(o.rec) < 20, line: o => `${tn(o.rec)} rec, ${tn(o.reyds)} yds` },
    { tag: '#bull', rarity: 'legendary', desc: '30+ carries', sql: `${tagJ('car')} >= 30`, test: o => tn(o.car) >= 30, line: o => `${tn(o.car)} carries, ${tn(o.ruyds)} yds` },
    { tag: '#machine', rarity: 'legendary', desc: '4 TDs (not passing)', sql: `MAX(COALESCE(${tagJ('td')}, 0), COALESCE(${tagJ('rutd')}, 0) + COALESCE(${tagJ('retd')}, 0)) = 4`,
      test: o => tTds(o) === 4, line: o => `${tTds(o)} TDs` },
    { tag: '#perfectrating', rarity: 'legendary', desc: 'Perfect passer rating (158.3)', sql: `${tagJ('rtg')} >= 158.3`, test: o => tn(o.rtg) >= 158.3, line: o => `${o['c/att'] || ''} · ${tn(o.pyds)} yds · ${tn(o.ptd)} TD · 158.3` },
    { tag: '#air4hundo', rarity: 'legendary', desc: '400+ passing yards', sql: `${tagJ('pyds')} BETWEEN 400 AND 499`, test: o => tn(o.pyds) >= 400 && tn(o.pyds) < 500, line: o => `${tn(o.pyds)} pass yds` },
    { tag: '#slapped', rarity: 'legendary', desc: '5 passing TDs', sql: `${tagJ('ptd')} = 5`, test: o => tn(o.ptd) === 5, line: o => `${tn(o.ptd)} pass TDs` },
    { tag: '#airforce', rarity: 'legendary', desc: '5+ passes defended', sql: `${tagJ('pd')} >= 5`, test: o => tn(o.pd) >= 5, line: o => `${tn(o.pd)} passes defended` },
    { tag: '#puntcity', rarity: 'legendary', desc: '10+ punts', sql: `${tagJ('punt')} >= 10`, test: o => tn(o.punt) >= 10, line: o => `${tn(o.punt)} punts, ${tn(o.puyds)} yds` },
    { tag: '#punt5hundo', rarity: 'legendary', desc: '500+ punt yards', sql: `${tagJ('puyds')} >= 500`, test: o => tn(o.puyds) >= 500, line: o => `${tn(o.puyds)} punt yds (${tn(o.punt)} punts)` },
    { tag: '#marksman', rarity: 'legendary', desc: '5+ punts inside the 20', sql: `${tagJ('p20')} >= 5`, test: o => tn(o.p20) >= 5, line: o => `${tn(o.p20)} inside the 20 (${tn(o.punt)} punts)` },
    { tag: '#2centuryboot', rarity: 'legendary', desc: '200+ yards of field goals made', sql: `${tagJ('fgyds')} >= 200`, test: o => tn(o.fgyds) >= 200, line: o => `${tn(o.fgyds)} FG yds (${o['fg%'] || ''})` }
  ]
};
/* Built one season at a time (2026-11-09: the page took ages - every load after
   a change rescanned every season's stat lines and pulled whole careers).
   Finished seasons are kept until something in them changes; only the
   season under way is redone as games come in. Each season's fingerprint:
   its game-log rows and latest day, and its performances. */
const TAG_SEASONS = { nfl: [2026, 2025, 2024, 2023] };
/* CFB (Dennis, 2026-11-09): the same tags as the NFL's (same definitions - their
   ranges already stop below the next one up), on CFB's own rarities. */
const CFB_TAG_RARITY = {
  iconic: ['#jackson', '#air6hundo', '#boogeyman', '#magnet', '#diamondboot'],
  mystic: ['#3hundo', '#5tuddy', '#tdtrick', '#perfectcompletion', '#air5hundo', '#platniumarm', '#eightball', '#nightmare', '#enforcer', '#triplepick', '#punt5hundo', '#platniumboot'],
  legendary: ['#2fitty', '#nickledime', '#perfectrating', '#slapped', '#goldenarm', '#airforce', '#puntcity', '#marksman']
};
// Dennis's CFB spellings for two of the NFL's.
const CFB_TAG_SAME = { '#perfectcompletion': '#perfectcompletions', '#nickledime': '#nickeldime' };
TAG_DEFS.ncaaf = Object.entries(CFB_TAG_RARITY).flatMap(([rarity, tags]) => tags.map(tag => {
  const base = TAG_DEFS.nfl.find(d => d.tag === (CFB_TAG_SAME[tag] || tag));
  return base ? { ...base, tag, rarity, alias: [...(base.alias || []), base.tag.slice(1)] } : null; }).filter(Boolean));
TAG_SEASONS.ncaaf = [2026, 2025, 2024, 2023];
/* MLB (Dennis, 2026-11-09). A batter's line: h/ab, r, rbi, hr, xbh, tb, sb;
   a pitcher's: ip, h, r, er, k, bb, hr (allowed), p-st (pitches-strikes),
   strk%. A two-way game (Ohtani) has both in one line, so his "h", "r" and
   "hr" can be the pitching ones: hits come from h/ab, runs scored only count
   without a pitching line, and his homers only when he had that many hits.
   Tags no box line can show (2 homers in an inning, an immaculate inning, 4
   strikeouts in an inning) come from Real's own tags only. */
const mHits = o => tfrac(o['h/ab'], 0);
const mPitch = o => o.ip != null && o.ip !== '';
const mHr = o => { const h = tn(o.hr); return !mPitch(o) ? h : (o['h/ab'] != null && h <= mHits(o) ? h : 0); };
const mRuns = o => mPitch(o) ? 0 : tn(o.r);
const mPitches = o => { const m = String(o['p-st'] || '').match(/^(\d+)-(\d+)$/); return m ? Number(m[1]) : 0; };
// Singles, doubles, triples from hits, extra-base hits and total bases.
const mCycle = o => { const h = mHits(o), hr = mHr(o), x = tn(o.xbh), tb = tn(o.tb), s1 = h - x, t3 = (tb - s1 - 4 * hr) - 2 * (x - hr), d2 = (x - hr) - t3;
  return { s1, d2, t3, hr, ok: s1 >= 1 && d2 >= 1 && t3 >= 1 && hr >= 1 }; };
const NEVER = '1 = 0';   // Real's tag only
const mHitsSql = tagFrac('h/ab', 0), mIp = `CAST(json_extract(stats, '$."ip"') AS REAL)`;
const mPitchSql = `CAST(substr(json_extract(stats, '$."p-st"'), 1, instr(json_extract(stats, '$."p-st"'), '-') - 1) AS INTEGER)`;
const mLine = o => `${o['h/ab'] || '0/0'}${tn(o.hr) ? `, ${mHr(o)} HR` : ''}${tn(o.rbi) ? `, ${tn(o.rbi)} RBI` : ''}${mRuns(o) ? `, ${mRuns(o)} R` : ''}${tn(o.sb) ? `, ${tn(o.sb)} SB` : ''}`;
const pLine = o => `${o.ip} IP, ${tn(o.h)} H, ${tn(o.r)} R, ${tn(o.bb)} BB, ${tn(o.k)} K${o['p-st'] ? `, ${o['p-st']} pitches-strikes` : ''}`;
TAG_DEFS.mlb = [
  { tag: '#runbeast', rarity: 'iconic', desc: '10+ RBIs', sql: `${tagJ('rbi')} >= 10`, test: o => tn(o.rbi) >= 10, line: mLine },
  { tag: '#quadhomer', rarity: 'iconic', desc: '4+ home runs', sql: `${tagJ('hr')} >= 4`, test: o => mHr(o) >= 4, line: mLine },
  { tag: '#shohei', rarity: 'iconic', desc: '3+ home runs and 10+ strikeouts', sql: `${tagJ('hr')} >= 3 AND ${tagJ('k')} >= 10 AND json_extract(stats, '$."h/ab"') IS NOT NULL`,
    test: o => mPitch(o) && mHr(o) >= 3 && tn(o.k) >= 10, line: o => `${mLine(o)} · ${pLine(o)}` },
  { tag: '#perfectgame', rarity: 'iconic', desc: 'Perfect game', sql: `${mIp} >= 9 AND COALESCE(${tagJ('h')}, 0) = 0 AND COALESCE(${tagJ('bb')}, 0) = 0 AND COALESCE(${tagJ('r')}, 0) = 0`,
    test: o => mPitch(o) && tn(o.ip) >= 9 && !tn(o.h) && !tn(o.bb) && !tn(o.r), line: pLine },
  { tag: '#6hits', rarity: 'mystic', desc: '6+ hits', sql: `json_extract(stats, '$."h/ab"') LIKE '%/%' AND ${mHitsSql} >= 6`, test: o => mHits(o) >= 6, line: mLine },
  { tag: '#runwave', rarity: 'mystic', desc: '9 RBIs', sql: `${tagJ('rbi')} = 9`, test: o => tn(o.rbi) === 9, line: mLine },
  { tag: '#5runs', rarity: 'mystic', desc: '5+ runs scored', sql: `${tagJ('r')} >= 5 AND json_extract(stats, '$."ip"') IS NULL`, test: o => mRuns(o) >= 5, line: mLine },
  { tag: '#2in1', rarity: 'mystic', desc: '2 home runs in 1 inning', sql: NEVER, test: () => false, line: mLine },
  // A no-hitter with no walks reads like a perfect game in the box line, so it's left to the higher tag (Real's own tag still shows it).
  { tag: '#nohitter', rarity: 'mystic', desc: 'No-hitter', sql: `${mIp} >= 9 AND COALESCE(${tagJ('h')}, 0) = 0`,
    test: o => mPitch(o) && tn(o.ip) >= 9 && !tn(o.h) && (tn(o.bb) > 0 || tn(o.r) > 0), line: pLine },
  { tag: '#immaculateinning', rarity: 'mystic', desc: '9 pitches, 9 strikes, 3 strikeouts in an inning', sql: NEVER, test: () => false, line: pLine },
  { tag: '#4kinning', rarity: 'mystic', desc: '4 strikeouts in 1 inning', sql: NEVER, test: () => false, line: pLine },
  { tag: '#5hits', rarity: 'legendary', desc: '5 hits', sql: `json_extract(stats, '$."h/ab"') LIKE '%/%' AND ${mHitsSql} = 5`, test: o => mHits(o) === 5, line: mLine },
  { tag: '#runfactory', rarity: 'legendary', desc: '8 RBIs', sql: `${tagJ('rbi')} = 8`, test: o => tn(o.rbi) === 8, line: mLine },
  { tag: '#triplehomer', rarity: 'legendary', desc: '3 home runs', sql: `${tagJ('hr')} = 3`, test: o => mHr(o) === 3, line: mLine },
  { tag: '#cycle', rarity: 'legendary', desc: 'Hit for the cycle', sql: `json_extract(stats, '$."h/ab"') LIKE '%/%' AND ${mHitsSql} >= 4 AND ${tagJ('hr')} >= 1 AND ${tagJ('xbh')} >= 3`,
    test: o => mCycle(o).ok, line: o => { const c = mCycle(o); return `${o['h/ab']}: ${c.s1} 1B, ${c.d2} 2B, ${c.t3} 3B, ${c.hr} HR`; } },
  { tag: '#ninja', rarity: 'legendary', desc: '4+ stolen bases', sql: `${tagJ('sb')} >= 4`, test: o => tn(o.sb) >= 4, line: mLine },
  { tag: '#maddux', rarity: 'legendary', desc: 'Complete-game shutout in under 100 pitches', sql: `${mIp} >= 9 AND COALESCE(${tagJ('r')}, 0) = 0 AND ${mPitchSql} BETWEEN 1 AND 99`,
    test: o => mPitch(o) && tn(o.ip) >= 9 && !tn(o.r) && mPitches(o) > 0 && mPitches(o) < 100, line: pLine },
  { tag: '#surgeon', rarity: 'legendary', desc: '80%+ strikes with 5+ innings pitched', sql: `${tagJ('strk%')} >= 80 AND ${mIp} >= 5`,
    test: o => mPitch(o) && tn(o['strk%']) >= 80 && tn(o.ip) >= 5, line: o => `${pLine(o)} · ${tn(o['strk%'])}% strikes` }
];
TAG_SEASONS.mlb = [2026, 2025, 2024, 2023];
/* NBA (Dennis, 2026-11-09): pts, reb, ast, stl, blk from the stat line. */
// "15/18/83.3%" -> [made, attempts]; nothing there = none taken.
const bShot = v => { const m = String(v || '').match(/^(\d+)\/(\d+)/); return m ? [Number(m[1]), Number(m[2])] : [0, 0]; };
const bLine = o => ['pts', 'reb', 'ast', 'stl', 'blk'].filter(k => tn(o[k])).map(k => `${tn(o[k])} ${k}`).join(', ');
TAG_DEFS.nba = [
  { tag: '#80bomb', rarity: 'iconic', desc: '80+ points', sql: `${tagJ('pts')} >= 80`, test: o => tn(o.pts) >= 80, line: bLine },
  { tag: '#jokic', rarity: 'iconic', desc: '30+ points, 20+ rebounds, 20+ assists', sql: `${tagJ('pts')} >= 30 AND ${tagJ('reb')} >= 20 AND ${tagJ('ast')} >= 20`,
    test: o => tn(o.pts) >= 30 && tn(o.reb) >= 20 && tn(o.ast) >= 20, line: bLine },
  { tag: '#grandtheft', rarity: 'iconic', desc: '10+ steals', sql: `${tagJ('stl')} >= 10`, test: o => tn(o.stl) >= 10, line: bLine },
  { tag: '#70bomb', rarity: 'mystic', desc: '70+ points', sql: `${tagJ('pts')} BETWEEN 70 AND 79`, test: o => tn(o.pts) >= 70 && tn(o.pts) < 80, line: bLine },
  { tag: '#5x5', rarity: 'mystic', desc: '5+ points, rebounds, assists, steals and blocks', sql: ['pts', 'reb', 'ast', 'stl', 'blk'].map(k => `${tagJ(k)} >= 5`).join(' AND '),
    test: o => ['pts', 'reb', 'ast', 'stl', 'blk'].every(k => tn(o[k]) >= 5), line: bLine },
  { tag: '#rodman', rarity: 'mystic', desc: '30+ rebounds', sql: `${tagJ('reb')} >= 30`, test: o => tn(o.reb) >= 30, line: bLine },
  { tag: '#blockbuster', rarity: 'mystic', desc: '10+ blocks', sql: `${tagJ('blk')} >= 10`, test: o => tn(o.blk) >= 10, line: bLine },
  // Legendary, each stopping below the Mystic / Iconic one above it.
  { tag: '#60bomb', rarity: 'legendary', desc: '60+ points', sql: `${tagJ('pts')} BETWEEN 60 AND 69`, test: o => tn(o.pts) >= 60 && tn(o.pts) < 70, line: bLine },
  { tag: '#50bomb', rarity: 'legendary', desc: '50+ points', sql: `${tagJ('pts')} BETWEEN 50 AND 59`, test: o => tn(o.pts) >= 50 && tn(o.pts) < 60, line: bLine },
  { tag: '#20/20', alias: ['2020'], rarity: 'legendary', desc: '20+ in two of points, rebounds and assists',
    sql: `(${tagJ('pts')} >= 20) + (${tagJ('reb')} >= 20) + (${tagJ('ast')} >= 20) >= 2`,
    test: o => ['pts', 'reb', 'ast'].filter(k => tn(o[k]) >= 20).length >= 2, line: bLine },
  { tag: '#4x5', rarity: 'legendary', desc: '5+ in four of points, rebounds, assists, steals and blocks',
    sql: ['pts', 'reb', 'ast', 'stl', 'blk'].map(k => `(COALESCE(${tagJ(k)}, 0) >= 5)`).join(' + ') + ' = 4',
    test: o => ['pts', 'reb', 'ast', 'stl', 'blk'].filter(k => tn(o[k]) >= 5).length === 4, line: bLine },
  { tag: '#ultrapure', rarity: 'legendary', desc: '25+ points with no free throws taken',
    sql: `${tagJ('pts')} >= 25 AND (json_extract(stats, '$."fts"') IS NULL OR json_extract(stats, '$."fts"') LIKE '0/0%')`,
    test: o => tn(o.pts) >= 25 && bShot(o.fts)[1] === 0, line: o => `${bLine(o)} · ${bShot(o.fg).slice(0, 2).join('/')} FG, 0 FTA` },
  // Every shot made, 5+ attempts; no free throws taken counts as none missed.
  { tag: '#perfect', rarity: 'legendary', desc: '100% from the field (5+ attempts) and the line', sql: `${tagJ('fg%')} >= 100`,
    test: o => { const f = bShot(o.fg), t = bShot(o.fts); return f[1] >= 5 && f[0] === f[1] && t[0] === t[1]; },
    line: o => `${bLine(o)} · ${bShot(o.fg).slice(0, 2).join('/')} FG, ${bShot(o.fts).slice(0, 2).join('/')} FT` },
  { tag: '#stockton', rarity: 'legendary', desc: '20+ assists', sql: `${tagJ('ast')} >= 20`, test: o => tn(o.ast) >= 20, line: bLine },
  { tag: '#glasscleaner', rarity: 'legendary', desc: '20+ rebounds', sql: `${tagJ('reb')} BETWEEN 20 AND 29`, test: o => tn(o.reb) >= 20 && tn(o.reb) < 30, line: bLine },
  { tag: '#blockparty', rarity: 'legendary', desc: '5+ blocks', sql: `${tagJ('blk')} BETWEEN 5 AND 9`, test: o => tn(o.blk) >= 5 && tn(o.blk) < 10, line: bLine }
];
TAG_SEASONS.nba = [2027, 2026, 2025, 2024, 2023];
async function tagSeasonSig(env, db, sp, se) {
  const k = `tagview_sig_v2_${sp}_${se}`;
  try { const c = await env.RATEBOARD_KV.get(k); if (c) return c; } catch (e) {}
  const r = await db.prepare(`SELECT COUNT(*) AS n, MAX(day) AS d FROM gamelog WHERE sport=? AND season=? AND stats IS NOT NULL`).bind(sp, se).first();
  let p = null; try { p = await db.prepare(`SELECT COUNT(*) AS n FROM performances WHERE sport=? AND season=?`).bind(sp, se).first(); } catch (e) {}
  const v = `${r && r.n}|${r && r.d}|${p && p.n}`;
  // A finished season barely moves (only Real's tags still coming in): its fingerprint is kept a day, the current one an hour.
  try { await env.RATEBOARD_KV.put(k, v, { expirationTtl: se === TAG_SEASONS[sp][0] ? 3600 : 86400 }); } catch (e) {}
  return v;
}
async function tagSig(env, db, sp) { const out = []; for (const se of TAG_SEASONS[sp]) out.push(await tagSeasonSig(env, db, sp, se)); return out.join('/'); }
const tagNt = x => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
async function tagSeasonBuild(env, db, sp, se, rids) {
  const defs = TAG_DEFS[sp];
  const byKey = defs.map(() => new Map());
  const add = (i, h) => { const k = `${h.i}|${h.d}`, o = byKey[i].get(k); if (o) { Object.assign(o, Object.fromEntries(Object.entries(h).filter(([, v]) => v != null && v !== ''))); return; } byKey[i].set(k, h); };
  // 1. Stat lines.
  const rows = ((await db.prepare(`SELECT playerId, player, team, opponent, day, position, seasonType, stats FROM gamelog
      WHERE sport=? AND season=? AND stats IS NOT NULL AND COALESCE(seasonType, 'regularseason') <> 'preseason' AND (${defs.map(d => `(${d.sql})`).join(' OR ')})
      LIMIT 3000`).bind(sp, se).all()).results) || [];
  const statOf = new Map();
  for (const r of rows) {
    let o = {}; try { o = JSON.parse(r.stats || '{}') || {}; } catch (e) {}
    const pos = String(r.position || '').toUpperCase();
    statOf.set(`${r.playerId}|${r.day}`, { o, pos });
    defs.forEach((d, i) => { if (d.test(o, pos)) add(i, { p: r.player, i: Number(r.playerId), s: se, d: r.day, tm: r.team, op: r.opponent, pos,
      po: r.seasonType && r.seasonType !== 'regularseason' ? 1 : undefined, line: d.line(o) }); });
  }
  // 2. Real's own tags.
  const ids = rids.filter(Boolean);
  if (ids.length) {
    let pr = [];
    try { pr = ((await db.prepare(`SELECT id, playerId, player, day, team, opponent, seasonType, tags FROM performances WHERE sport=? AND season=? AND tags IS NOT NULL
        AND (${ids.map(() => `instr(',' || tags || ',', ?) > 0`).join(' OR ')}) LIMIT 3000`).bind(sp, se, ...ids.map(x => `,${x},`)).all()).results) || []; } catch (e) {}
    for (const r of pr) { const tg = String(r.tags).split(',').map(Number);
      rids.forEach((rid, i) => { if (rid && tg.includes(rid)) add(i, { p: r.player, i: Number(r.playerId), s: se, d: r.day, tm: r.team, op: r.opponent, b: Number(r.id), real: 1,
        po: r.seasonType && r.seasonType !== 'regularseason' ? 1 : undefined }); }); }
  }
  // 3. Only for the games found: the box-score id (the game's card) and, for Real-only ones, the stat line.
  const all = byKey.flatMap(m => [...m.values()]);
  const pairs = [...new Map(all.map(h => [`${h.i}|${h.d}`, h])).values()];
  const bm = new Map(), gm = new Map();
  for (let k = 0; k < pairs.length; k += 40) {
    const part = pairs.slice(k, k + 40), w = part.map(() => '(playerId=? AND day=?)').join(' OR '), b = part.flatMap(h => [h.i, h.d]);
    try { for (const x of (((await db.prepare(`SELECT id, playerId, day FROM performances WHERE sport=? AND season=? AND (${w})`).bind(sp, se, ...b).all()).results) || [])) bm.set(`${x.playerId}|${x.day}`, Number(x.id)); } catch (e) {}
    const need = part.filter(h => !statOf.has(`${h.i}|${h.d}`));
    if (need.length) { const w2 = need.map(() => '(playerId=? AND day=?)').join(' OR ');
      try { for (const x of (((await db.prepare(`SELECT playerId, day, position, stats FROM gamelog WHERE sport=? AND season=? AND (${w2})`).bind(sp, se, ...need.flatMap(h => [h.i, h.d])).all()).results) || [])) {
        let o = {}; try { o = JSON.parse(x.stats || '{}') || {}; } catch (e) {} gm.set(`${x.playerId}|${x.day}`, { o, pos: String(x.position || '').toUpperCase() }); } } catch (e) {} }
  }
  defs.forEach((d, i) => { for (const h of byKey[i].values()) { const kk = `${h.i}|${h.d}`;
    if (!h.b && bm.has(kk)) h.b = bm.get(kk);
    if (!h.line) { const g = statOf.get(kk) || gm.get(kk); if (g) { h.pos = h.pos || g.pos; h.line = d.test(g.o, h.pos) ? d.line(g.o) : ''; } }
    if (!h.line) h.line = 'tagged by Real'; } });
  return defs.map((d, i) => [...byKey[i].values()]);
}
async function tagBuild(env, db, sp) {
  const defs = TAG_DEFS[sp];
  let dict = []; try { dict = ((await db.prepare(`SELECT id, hash, label FROM tags WHERE sport=? AND kind='playerboxscore'`).bind(sp).all()).results) || []; } catch (e) {}
  const idOf = d => { const ws = [tagNt(d.tag), ...(d.alias || []).map(tagNt)];
    const t = dict.find(x => ws.includes(tagNt(x.hash))) || dict.find(x => ws.includes(tagNt(x.label)));
    return t ? Number(t.id) : null; };
  const rids = defs.map(idOf);
  const out = defs.map((d, i) => ({ tag: d.tag, rarity: d.rarity, desc: d.desc, rid: rids[i], hits: [] }));
  const sigs = [];
  for (const se of TAG_SEASONS[sp]) {
    const sig = await tagSeasonSig(env, db, sp, se); sigs.push(sig);
    const k = `tagview_s_v${TAG_DEFS_V}_${sp}_${se}`;
    let c = null; try { c = JSON.parse((await env.RATEBOARD_KV.get(k)) || 'null'); } catch (e) {}
    if (!c || c.sig !== sig || String(c.rids) !== String(rids)) {
      c = { sig, rids, hits: await tagSeasonBuild(env, db, sp, se, rids) };
      try { await env.RATEBOARD_KV.put(k, JSON.stringify(c), { expirationTtl: 30 * 86400 }); } catch (e) {}
    }
    c.hits.forEach((h, i) => { if (out[i]) out[i].hits.push(...h); });
  }
  out.forEach(t => t.hits.sort((a, b) => String(b.d).localeCompare(String(a.d))));
  const c = { at: Date.now(), v: TAG_DEFS_V, sig: sigs.join('/'), sport: sp, tags: out };
  try { await env.RATEBOARD_KV.put(`tagview_v1_${sp}`, JSON.stringify(c)); } catch (e) {}
  return c;
}

const PROJ_MEM = new Map(), TAG_MEM = new Map();
const projMem = c => ({ c, read: 0, byId: new Map((c.rows || []).map(r => [r.i, r])), rowsText: JSON.stringify((c.rows || []).map(({ x, ...r }) => r)) });
const projSigOf = (n, d, s) => `${n}|${d || ''}|${Math.round(Number(s) || 0)}`;
async function projSig(env, db, sp) {
  const k = `proj_sig_v1_${sp}`;
  try { const c = await env.RATEBOARD_KV.get(k); if (c) return c; } catch (e) {}
  const r = await db.prepare(`SELECT COUNT(*) AS n, MAX(day) AS d, SUM(rax) AS s FROM gamelog WHERE sport=? AND season=? AND rax IS NOT NULL AND (seasonType IS NULL OR seasonType='regularseason')`).bind(sp, Number(PROJ_SEASON[sp][0])).first();
  const v = projSigOf(r && r.n, r && r.d, r && r.s);
  try { await env.RATEBOARD_KV.put(k, v, { expirationTtl: 900 }); } catch (e) {}
  return v;
}
async function projBuild(env, db, sp) {
  const [se, prev] = PROJ_SEASON[sp], P = PROJ_P[sp];
  const fc = sp === 'soccer', useMin = PROJ_MIN.has(sp);
  const sched = fc ? { teams: {}, ids: {} } : await projSchedule(env, sp);
  const inj = {};
  if (!fc) {
    try { const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${PROJ_PATH[sp]}/injuries`); const d = r.ok ? await r.json() : {};
      for (const t of (d.injuries || [])) for (const x of (t.injuries || [])) if (x.athlete && x.status && !/^active$/i.test(x.status)) { const tid = String((x.athlete.team && x.athlete.team.id) || t.id || ''), e = { status: x.status, tid }; inj[boostName(x.athlete.displayName) + '|' + tid] = e; if (!inj[boostName(x.athlete.displayName)]) inj[boostName(x.athlete.displayName)] = e; } } catch (e) {}
  }
  // NFL: each team's own injury list too (the league list misses some - Lamar, 2026-11-04).
  if (sp === 'nfl') { try { Object.assign(inj, await boostTeamInj(env, sp, Object.values(sched.ids || {}))); } catch (e) {} }
  // The hand-set list (Boosts' admin injury list) too.
  // FC too (2026-11-08): no injury list for soccer anywhere we read, so the hand list is the only one.
  if (['ncaaf', 'ncaam', 'nfl', 'soccer'].includes(sp)) { try { Object.assign(inj, await boostManualOut(env, sp)); } catch (e) {} }
  /* Games still waiting for Real's rax come too (2026-11-09: McDavid had 3
     of them, plus 2 games not in the log yet, and was taken for a player who
     had missed his team's last 5 - projected 224 at 151 in 18 games). They
     count as games he played, at his rate, but not in his rate. */
  const all = ((await db.prepare(`SELECT playerId, player, team, position, day, rax, min, opponent, homeAway, (stats IS NULL) AS ns${fc ? ', conference' : ''} FROM gamelog WHERE sport=? AND season=?
      AND (seasonType IS NULL OR seasonType='regularseason')`).bind(sp, Number(se)).all()).results) || [];
  /* A blank rax on a game Real has already paid his teammates for is a 0, not
     a game still waiting (2026-11-12: a CFB DL with a 0 last game showed 8
     games and 14.1 a game - 113 over 8 - instead of 9 games, 12.6). */
  const paid = new Set(all.filter(x => x.rax != null).map(x => `${x.team}|${x.day}`));
  let zf = 0; for (const x of all) if (x.rax == null && paid.has(`${x.team}|${x.day}`)) { x.rax = 0; zf++; }
  const cur = all.filter(x => x.rax != null);
  // How far the game log reaches: a team's games after this day aren't in it yet, so they aren't missed games.
  const cover = all.reduce((m, x) => String(x.day || '') > m ? String(x.day) : m, '');
  const pendBy = new Map();
  const pendFrom = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);   // older blanks are games Real never paid out on
  for (const x of all) if (x.rax == null && String(x.day) >= pendFrom) (pendBy.get(Number(x.playerId)) || pendBy.set(Number(x.playerId), []).get(Number(x.playerId))).push(x);
  /* Football keeps no minutes: a game with no stats and no rax is a game he
     sat out (2026-11-13: Malachi Toney's Notre Dame game - out hurt - read as
     a 0-rax game played, so he wasn't seen missing it). */
  const foot = sp === 'ncaaf' || sp === 'nfl';
  // FC goalkeepers (2026-11-27: none in FC projections): Real leaves their minutes at 0, so FC counts a game played the way fcMin does.
  const played = x => (fc ? fcPlayed(x) : (!useMin || x.min == null || Number(x.min) > 0)) && !(foot && Number(x.ns) === 1 && !(Number(x.rax) > 0));
  const alias = fc ? (c => c) : projLearnAlias(sp, cur, sched);
  /* Per team, not one day for everyone (2026-11-25: NFL Week 12 was logged for a few players only, so the latest day in
     the log was Week 12 and everyone else's Week 12 read as a missed game - Emmett Johnson, Burden, Barkley and Caleb
     Williams projected far too low). A team's game counts as logged once at least half as many of its players are in
     it as in its fullest game; until then it's a game still to come in the log, counted at his rate. */
  const tdN = new Map(), tdMax = new Map();
  if (!fc) { for (const x of all) { if (!x.team || !x.day) continue; const k = alias(x.team) + '|' + x.day; tdN.set(k, (tdN.get(k) || 0) + 1); }
    for (const [k, n] of tdN) { const t = k.split('|')[0]; if (n > (tdMax.get(t) || 0)) tdMax.set(t, n); } }
  const teamLogged = (t, d) => d <= cover && (tdN.get(t + '|' + d) || 0) >= Math.max(2, 0.5 * (tdMax.get(t) || 0));
  // Last season, per game actually played.
  const old = new Map();
  let lgPrev = null;
  try { const r = await db.prepare(`SELECT playerId, SUM(rax) AS s, ${useMin ? `SUM(CASE WHEN min IS NULL OR min > 0${fc ? " OR UPPER(position)='G'" : ''} THEN 1 ELSE 0 END)` : 'COUNT(*)'} AS n FROM gamelog
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
  const etd = iso => ET_DAY_FMT.format(new Date(iso));
  const near = (days, d0) => { const t = Date.parse(d0 + 'T12:00:00Z'); return days.some(d => Math.abs(Date.parse(d + 'T12:00:00Z') - t) <= 86400000); };
  const r1 = x => x == null ? null : Math.round(x * 10) / 10, r2 = x => x == null ? null : Math.round(x * 100) / 100;
  const rows = [];
  for (const [id, gs0] of by) {
    const gs = gs0.slice().sort((a, b) => String(a.day).localeCompare(String(b.day)));
    const pg = gs.filter(played);
    const pend = (pendBy.get(id) || []).filter(played).filter(x => !gs.some(g => g.day === x.day));
    const last = [...gs, ...pend].sort((a, b) => String(a.day).localeCompare(String(b.day))).pop();
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
    let total = null, rest = [], ab = null, tgDone = 0, fcx = null, teamDays = [], myClub = null, unlogged = [];
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
        // Finished games the log doesn't reach yet: still to be counted, at his rate.
        if (cover) { unlogged = tg.filter(g => g[2] && !teamLogged(ab, etd(g[0]))); teamDays = teamDays.filter(d => teamLogged(ab, d)); }
      } else flags.push('Team schedule not found');
    }
    // Share of his team's games (since his first) he has played, pulled toward a regular's.
    // (FC: his club games only - internationals aren't on the club's schedule.)
    const mine = myClub ? pg.filter(x => clubKey(x) === myClub) : pg;
    const mineAll = [...mine, ...(myClub ? pend.filter(x => clubKey(x) === myClub) : pend)];
    const first = mineAll.reduce((m, x) => String(x.day) < m ? String(x.day) : m, String((mine[0] || gs[0]).day)), days = mineAll.map(x => x.day);
    const since = teamDays.filter(d => d >= first || near([first], d)).length || mineAll.length;
    let avail = (mineAll.length + P.ka * P.a0) / (Math.max(since, mineAll.length) + P.ka);
    const recent = teamDays.slice(-P.look), missed = recent.filter(d => !near(days, d)).length;
    const ij = injOf(inj, last.player, ab && sched.ids ? sched.ids[ab] : null);
    let skipNext = false, skipN = 0;
    /* The hand-kept injury list (Admin -> Boosts injury list): a note with
       "season" in it = no more games; Out / Suspension through a day = the
       games up to that day; Out with no day = out until taken off the list.
       (2026-11-08: a torn ACL was still projected 93 - FC had no injury source.) */
    if (ij && ij.manual && (/season/i.test(ij.note || '') || (/^(out|suspen)/i.test(ij.status) && !ij.until))) {
      flags.push(/season/i.test(ij.note || '') ? `Out for the season${ij.note ? ' - ' + ij.note : ''} - no more games counted` : `${ij.status}${ij.note ? ' - ' + ij.note : ''} - no games counted until he's off the injury list`); avail = 0;
    } else if (ij && ij.manual && /^(out|suspen)/i.test(ij.status) && ij.until) {
      skipN = fc ? Math.ceil((fcx ? fcx.perWeek / 7 : 0.5) * Math.max(0, (Date.parse(ij.until + 'T23:00:00Z') - Date.now()) / 86400000)) : rest.filter(g => g[0] && etd(g[0]) <= ij.until).length;
      skipN = Math.min(skipN, rest.length);
      flags.push(`${ij.status} through ${ij.until}${ij.note ? ' - ' + ij.note : ''} - ${skipN} game${skipN === 1 ? '' : 's'} not counted`);
      if (recent.length >= P.look && missed >= P.miss) avail *= 0.3;
    }
    else if (ij && /^injured reserve/i.test(ij.status)) { flags.push('Injured reserve - no more games counted'); avail = 0; }
    else {
      if (ij && /^(out|suspen)/i.test(ij.status)) { flags.push(ij.status + ' - next game not counted'); skipNext = true; }
      else if (ij && /^(doubtful|questionable|day-to-day)/i.test(ij.status)) flags.push(ij.status);
      if (recent.length >= P.look && missed >= P.miss) { flags.push(`Missed ${missed} of his ${fc ? 'club' : 'team'}'s last ${recent.length} - only 30% of the games left counted`); avail *= 0.3; }
    }
    // Football: sat out his team's latest game - left off the day's Top players (2026-11-13, Malachi Toney).
    const ml = (sp === 'ncaaf' || sp === 'nfl') && teamDays.length && avail > 0 && !near(days, teamDays[teamDays.length - 1]) ? 1 : 0;
    if (ml && !flags.some(f => /^Missed /.test(f))) flags.push(`Missed his team's last game (${teamDays[teamDays.length - 1]})`);
    avail = Math.min(1, avail);
    // 3. Each game left: his rate x the chance he plays x opponent x home/away.
    let add = 0;
    rest.forEach((g, i) => { if ((i === 0 && skipNext) || i < skipN) return; add += rate * avail * (g[1] && of[g[1]] ? of[g[1]] : 1) * (g[3] && hf[g[3]] ? hf[g[3]] : 1); });
    // Games he played that Real hasn't posted rax for yet, and his team's games past the end of the log.
    const pendF = x => (x.opponent && of[alias(x.opponent)] ? of[alias(x.opponent)] : 1) * (x.homeAway && hf[x.homeAway] ? hf[x.homeAway] : 1);
    for (const x of pend) add += rate * pendF(x);
    const unl = avail > 0 ? unlogged.filter(g => !near(days, etd(g[0]))) : [];
    for (const g of unl) add += rate * avail * (g[1] && of[g[1]] ? of[g[1]] : 1) * (g[3] && hf[g[3]] ? hf[g[3]] : 1);
    if (pend.length || unl.length) flags.push(`${pend.length + unl.length} game${pend.length + unl.length === 1 ? '' : 's'} played but not in the rax yet - counted at his rate`);
    const gp = pg.length, waitN = pend.length + unl.length;
    rows.push({ i: id, n: last.player || ('Player ' + id), t: last.team || '', p: last.position || '', gp, r: Math.round(rax), a: r1(rax / gp),
      pg: r1(rate * avail), l: rest.length, tg: total, nx: rest[0] && rest[0][1] ? rest[0][1] : null,
      pr: Math.round(rax + add), pc: Math.round(rax + rax / gp * (rest.length + waitN)), f: flags.length ? flags : undefined,   // pc = on pace: his rate a game played over the games left (2026-11-08: was rate x all the team's games, so one 54-rax game showed 648)
      x: { rate: r2(rate), prior: r2(prior), ph: priorHow, av: r2(avail), since, ab, sk: skipNext ? 1 : 0, sn: skipN || undefined, ml: ml || undefined, w: r1(wsum), fc: fcx || undefined, wt: waitN || undefined } });
  }
  rows.sort((x, y) => y.pr - x.pr);
  // The latest game in the game data it was built from (shown at the top of the page).
  const gd = cur.reduce((m, x) => String(x.day || '') > m ? String(x.day) : m, '');
  const out = { at: Date.now(), gd: gd || null, zfix: 4, sig: projSigOf(cur.length - zf, gd, cur.reduce((t, x) => t + Number(x.rax || 0), 0)), sport: sp, season: se, model: 2, lg: r2(lg), of, hf, rows: rows.slice(0, 4000), players: rows.length, schedPages: sched.pages, schedOf: sched.of };
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
  out.games = rest.map(([at, opp, , h], i) => { const f = (of[opp] || 1) * (hf[h] || 1), counted = !(i === 0 && row.x.sk) && i >= (row.x.sn || 0);
    return { at, opp, h, f: Math.round(f * 100) / 100, v: counted ? Math.round(row.x.rate * row.x.av * f * 10) / 10 : 0, counted }; });
  out.played = tg.filter(g => g[2]).length;
  return out;
}

const SCAN_EVERY_KEY = 'swap_scan_every_v1';
async function scanEvery(env) {
  let v = null; try { v = Number(await env.RATEBOARD_KV.get(SCAN_EVERY_KEY)); } catch (e) {}
  return v === 15 ? 15 : 60;    // members rescan every hour (Dennis, 2026-11-05; was 3 hours), or every 15 minutes
}

// Any error comes back as a readable message rather than a bare 500.
/* Step times for one request, so a slow page open says where the time went. */
const MARKS = new WeakMap();
const mark = (req, what) => { const m = MARKS.get(req); if (m) m.push(`${what} ${Date.now() - m.t}`); };
/* Who could actually be matched with a member, by the matcher's own rules
   (2026-11-09: "Why haven't I matched?" said 59 matches for a member who got
   none - it skipped the rules for untouchable passes, under-30-play players,
   weekly/one-day schedules, restricted members and passes already given out
   that swap day). Counts only: no names. */
export async function whyNotFull(db, env, key) {
  await matchCols(db); await db.prepare(DM_DDL).run();
  try { await db.prepare(RESTRICT_DDL).run(); await db.prepare(SBLOCK_DDL).run(); } catch (e) {}
  const r = await db.prepare('SELECT * FROM swap_users WHERE key=?').bind(key).first();
  const out = { why: [], can: 0, hour: 0, both: 0, free: 0 };
  if (!r) { out.why.push('You have no swap saved.'); return out; }
  const prep = x => ({ ...x, sched: parse(x.sched, null), wants: parse(x.wants, []), keep: new Set(parse(x.keep, [])), touch: new Set(parse(x.touch, [])),
    slots: parse(x.slots, []), passes: parse(x.passes, []), caps: parse(x.caps, {}) || {} });
  const u = prep(r), now = Date.now();
  const one = async (sql, ...b) => { try { return await db.prepare(sql).bind(...b).first(); } catch (e) { return null; } };
  if (!(await one('SELECT 1 AS x FROM swap_ver v JOIN swap_dm d ON d.hashId = v.hashId WHERE v.hashId=? AND d.channelId IS NOT NULL', u.hashId || ''))) out.why.push('Step 1 is not verified - the bot cannot DM you, so you are never matched.');
  if (await one('SELECT 1 AS x FROM restricted WHERE key=?', key)) out.why.push('Your swaps are on hold - message Dennis.');
  if (await one('SELECT 1 AS x FROM swap_block WHERE key=?', key)) out.why.push('Your swaps are on hold - message Dennis.');
  if (!u.comment) out.why.push('No comment link saved (step 2).');
  if (!u.passes.length) out.why.push('Your passes have not been scanned (step 3).');
  if (!u.active) out.why.push('Your swap is not saved, or is paused - tap Save my swap.');
  if (u.only160) out.why.push('You chose "Only here to do 160s", so you are never put in swaps.');
  // Their picks as the matcher sees them.
  const swappable = k => !/^(soccer|ufc):/.test(k) && !seasonOff(k);
  const owned = new Set(u.passes.filter(p => p.kind !== 'team').map(p => p.key));
  const picked = u.wants.slice(0, MAX_WANTS);
  let low = new Set(); try { low = await lowPlays(env, db, picked, null, u.key); } catch (e) {}
  const wants = picked.filter(k => swappable(k) && owned.has(k) && !low.has(k));
  out.picks = picked.length; out.usable = wants.length;
  out.dropped = { notOwned: picked.filter(k => !owned.has(k)).length, lowPlays: picked.filter(k => low.has(k)).length, seasonOff: picked.filter(k => seasonOff(k)).length };
  if (!picked.length) out.why.push('You have not picked a player to swap for (step 4).');
  else if (!wants.length) out.why.push(out.dropped.lowPlays ? 'Every player you picked has under 30 plays, so none can be matched - pick others.'
    : out.dropped.notOwned ? 'The players you picked are not in your last scan - scan again.' : 'None of the players you picked can be swapped yet.');
  // The hours the next 24 really give them (a weekly or one-day schedule can leave none).
  const dues = [];
  for (let t = Math.floor(now / 3600000) * 3600000 + 3600000; t - now <= 24 * 3600000; t += 3600000) if (!noSwapHour(t)) dues.push(t);
  const myHours = dues.filter(t => rankAt(u, t) >= 0);
  out.sched = (u.sched && u.sched.mode) || 'daily'; out.hours24 = myHours.length;
  if (!myHours.length) out.why.push(out.sched === 'date' ? 'Your schedule is set to one day only, and it has no hours in the next 24 - change it in step 5.'
    : out.sched === 'weekly' ? 'Your weekly schedule has no hours in the next 24 - change it in step 5.' : 'No hours picked (step 5).');
  // What they could give: the matcher's rule.
  const giveSet = x => new Set(x.passes.filter(p => p.kind !== 'team' && !(p.untouchable && !x.touch.has(p.key))).map(p => p.key)
    .filter(k => swappable(k) && !x.keep.has(k) && !x.wants.includes(k)));
  const mine = giveSet(u);
  out.giveable = mine.size;
  if (wants.length && !mine.size) out.why.push('You have no passes free to give - untick some keeps or untouchables.');
  // Goals and Scale limits (step 6).
  if (wants.length) {
    let full = 0, reached = null;
    for (const w of wants) {
      const g = await goalRoom(db, new Map(), u, (x, ww) => usedSince(db, x, ww), w).catch(() => ({}));
      const c = u.caps[w];
      const capped = c && ((Number(c.n) > 0 && c.at && await usedFor(db, key, w, c.at) >= Number(c.n)) || (Number(c.d) > 0 && await usedFor(db, key, w, now - 86400000) >= Number(c.d)));
      if (g.reached && !reached) reached = g;
      if (g.reached || (g.limited && g.left <= 0) || capped) full++;
    }
    if (full === wants.length) out.why.push(reached && wants.length === 1 ? `Your pass is at ${reached.rating}, which already meets your goal of ${reached.goal}.`
      : 'Every player you picked has reached his goal or your Scale limit (step 6). Raise a limit or pick another player.');
    const open = await one(`SELECT COUNT(*) AS n FROM swap_matches WHERE (a=? OR b=?) AND (status IN ('pending','sending','warned') OR (status='sent' AND sentAt > ?))`, key, key, now - 86400000);
    if (Number(u.dayCap) > 0 && Number(open && open.n) >= Number(u.dayCap)) out.why.push(`You have ${open.n} swap${open.n == 1 ? '' : 's'} going - your Scale limit is ${u.dayCap} a day (step 6). Raise it for more.`);
  }
  if (out.why.length) return out;
  // Passes already going out this swap day.
  const d = swapDay(myHours[0]);
  const given = new Set();
  for (const m of ((await db.prepare(`SELECT a, b, aGets, bGets, slot, createdAt, dueAt, warnA, warnB, doneA, doneB, status FROM swap_matches WHERE createdAt > ?`).bind(now - 2 * 86400000).all()).results || [])) {
    if (swapDay(sideDue(m)) !== d) continue;
    const live = ['pending', 'sending', 'warned', 'sent'].includes(m.status);
    if (live || m.warnB || m.doneB) given.add(`${m.b}|${m.aGets}`);
    if (live || m.warnA || m.doneA) given.add(`${m.a}|${m.bGets}`);
  }
  const others = (await pagedRows(db, `SELECT * FROM swap_users WHERE active=1 AND passes IS NOT NULL AND key<>? AND (only160 IS NULL OR only160=0)
      AND wants IS NOT NULL AND wants <> '[]' AND key NOT IN (SELECT key FROM restricted) AND key NOT IN (SELECT key FROM swap_block)
      AND hashId IN (SELECT v.hashId FROM swap_ver v JOIN swap_dm d ON d.hashId = v.hashId WHERE d.channelId IS NOT NULL)`, [key])).map(prep);
  let lowO = new Set(); try { lowO = await lowPlays(env, db, [...new Set(others.flatMap(o => o.wants.slice(0, MAX_WANTS)))]); } catch (e) {}
  for (const o of others) {
    const og = giveSet(o);
    if (!wants.some(w => og.has(w))) continue;
    out.can++;
    if (!myHours.some(t => rankAt(o, t) >= 0)) continue;
    out.hour++;
    const oOwn = new Set(o.passes.filter(p => p.kind !== 'team').map(p => p.key));
    const ow = o.wants.slice(0, MAX_WANTS).filter(k => swappable(k) && oOwn.has(k) && !lowO.has(k));
    if (!ow.some(w => mine.has(w))) continue;
    out.both++;
    if (wants.some(w => og.has(w) && !given.has(`${o.key}|${w}`)) && ow.some(w => mine.has(w) && !given.has(`${key}|${w}`))) out.free++;
  }
  if (!out.can) out.why.push('Nobody signed up has a player you picked free to swap yet.');
  else if (!out.hour) out.why.push(`${out.can} member${out.can === 1 ? ' has' : 's have'} a player you picked free, but none share your hours in the next day - try adding hours.`);
  else if (!out.both) out.why.push(`${out.hour} member${out.hour === 1 ? '' : 's'} with a player you picked share your hours, but none of them want a pass you have free. Untick some keeps or untouchables to give them more options.`);
  else if (!out.free) out.why.push(`${out.both} member${out.both === 1 ? ' is a match' : 's are matches'}, but they've already given out the players you picked today (each pass goes out once a swap day). New ones open at 3am Alaska time.`);
  else out.why.push(`${out.free} member${out.free === 1 ? ' is' : 's are'} a match right now. Matching runs every hour at :20 for the next 3 hours - when several people want the same pass, it goes to the better-rated pair first.`);
  return out;
}

/* Tag finder (2026-11-09): which games earned each performance tag. Answered
   before the per-request table setup - it only reads its saved list. */
async function tagViewOp(env, db, url, acc, waitUntil) {
    /* Open to everyone signed in (Dennis, 2026-11-09). Like projections: the
       list is kept in memory per worker with its text ready, and the saved copy
       re-read at most once a minute, so a crowd costs one KV read a minute;
       the game data is checked for changes at most once an hour. */
    if (!acc.who) return json({ error: 'Sign in first (raxacademy.app).' }, 403);
    if (!acc.admin && !(await allow(url.origin, 'tagview:' + acc.who, 40, 600))) return json({ error: 'Too many refreshes - wait a few minutes.' }, 429);
    const sp = TAG_DEFS[url.searchParams.get('sport')] ? url.searchParams.get('sport') : 'nfl';
    const k = `tagview_v1_${sp}`;
    let m = TAG_MEM.get(sp);
    if (!m || Date.now() - m.read > 60000) {
      let c0 = null; try { c0 = JSON.parse((await env.RATEBOARD_KV.get(k)) || 'null'); } catch (e) {}
      if (c0) { if (!m || m.c.at !== c0.at) m = { c: c0, text: JSON.stringify(c0) }; m.read = Date.now(); TAG_MEM.set(sp, m); }
      else if (m) m.read = Date.now();
    }
    const c = m ? m.c : null;
    const lockK = `tagview_lock_${sp}`;
    // A changed tag list or new games: the last list is shown while the new one is built.
    let stale = !c || c.v !== TAG_DEFS_V;
    if (c && !stale && Date.now() - c.at > 60 * 60000 && (!m.sigAt || Date.now() - m.sigAt > 10 * 60000)) {
      m.sigAt = Date.now(); try { stale = (await tagSig(env, db, sp)) !== c.sig; } catch (e) {} }
    if (stale) {
      let locked = false; try { locked = !!(await env.RATEBOARD_KV.get(lockK)); } catch (e) {}
      if (!locked) {
        try { await env.RATEBOARD_KV.put(lockK, '1', { expirationTtl: 120 }); } catch (e) {}
        const job = tagBuild(env, db, sp).finally(() => env.RATEBOARD_KV.delete(lockK).catch(() => {}));
        // Built in the background; the page checks back (a first build of a big sport - CFB - takes a while).
        try { waitUntil(job.catch(() => {})); } catch (e) {}
        if (!c) return json({ building: true, note: 'Building the tag list for the first time - this page checks again in 20 seconds.' });
      } else if (!c) return json({ building: true, note: 'Building the tag list - try again in a minute.' });
    }
    return new Response(m.text, { headers: { 'content-type': 'application/json', 'cache-control': 'private, max-age=60' } });
  }
export async function onRequest(ctx) {
  const t0 = Date.now();
  PUSH_ENV = ctx.env;
  try { await perfOnlyRefresh(ctx.env); } catch (e) {}
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
  if (!acc.who) return json({ error: 'Sign in first (raxacademy.app).' }, 401);
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
  if (!found.ok) return json({ waiting: true, error: `No "confirm username change" message from @${p.name} yet. Send it to @rax.academy from that account, then tap verify again.` });
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
  if (!acc.who) return json({ error: 'Sign in first (raxacademy.app).' }, 401);
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
    const pk = await packsToday(env, db, u.key, b);
    /* Your stats (Dennis, 2026-11-16, and a member's request to see their own ratings): Swap Score and tag,
       stars with the split, swaps all time / this week / today, 160s today, warnings and strikes. */
    try {
      const tm = await trustMap(env, db), v = tm[u.key] || {};
      await db.prepare(RATE_DDL).run(); await db.prepare(RATE_BLOCK_DDL).run();
      const rs = ((await db.prepare('SELECT stars, COUNT(*) AS n FROM swap_ratings WHERE ratee=? AND rater NOT IN (SELECT key FROM swap_rate_block) GROUP BY stars').bind(u.key).all()).results) || [];
      const split = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 }; let tot = 0, sum = 0; for (const r of rs) { split[r.stars] = Number(r.n); tot += Number(r.n); sum += Number(r.n) * Number(r.stars); }
      const now = Date.now(), d0 = swapDayStart(now), d1 = d0 + 24 * 3600000;
      const sw = await db.prepare(`SELECT COUNT(*) AS n, SUM(CASE WHEN dueAt < ?1 THEN 1 ELSE 0 END) AS done FROM swap_matches WHERE (a=?2 OR b=?2) AND dueAt >= ?3 AND dueAt < ?4 AND status NOT IN ('cancelled','cancelling','cleared')`).bind(now, u.key, d0, d1).first();
      const s160 = await db.prepare(`SELECT SUM(CASE WHEN buyer=?1 THEN 1 ELSE 0 END) AS b, SUM(CASE WHEN seller=?1 THEN 1 ELSE 0 END) AS s FROM swap_160 WHERE (buyer=?1 OR seller=?1) AND dueAt >= ?2 AND dueAt < ?3 AND status <> 'cancelled'`).bind(u.key, d0, d1).first();
      const wk = await tradeCounts(db, now - 7 * 86400000);
      let mod = null; try { mod = await modRecord(db, u.key); } catch (e) {}
      pk.stats = { pts: v.pts != null ? v.pts : null, lv: v.lv || 'new', stars: tot ? Math.round(sum / tot * 100) / 100 : null, weighted: v.s || null, votes: tot, split,
        swaps: v.t || 0, week: wk.get(u.key) || 0, today: Number(sw && sw.n) || 0, todayDone: Number(sw && sw.done) || 0, buy160: Number(s160 && s160.b) || 0, sell160: Number(s160 && s160.s) || 0,
        strikes: mod ? mod.strikes : 0, warned: mod ? mod.events.some(e => e.kind === 'warn') : false, max: MOD_STRIKES };
    } catch (e) { pk.stats = { error: String(e.message || e) }; }
    return json(pk);
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
    const hours = [], n160 = new Map();
    try { for (const r of (((await db.prepare("SELECT dueAt AS d, COUNT(*) AS n FROM swap_160 WHERE (buyer=? OR seller=?) AND dueAt > ? AND status <> 'cancelled' GROUP BY dueAt").bind(u.key, u.key, Date.now() - 14 * 86400000).all()).results) || [])) n160.set(Number(r.d), Number(r.n)); } catch (e) {}
    for (const r of rows) { const d = Number(r.d), live = Number(r.n) - Number(r.off || 0); if (live <= 0 && !n160.has(d)) continue;
      hours.push({ due: d, swaps: live, s160: n160.get(d) || 0, url: `/hour?u=${encodeURIComponent(u.key)}&d=${d}&t=${await hourSig(env, u.key, d)}` }); n160.delete(d); }
    for (const [d, n] of n160) hours.push({ due: d, swaps: 0, s160: n, url: `/hour?u=${encodeURIComponent(u.key)}&d=${d}&t=${await hourSig(env, u.key, d)}` });
    hours.sort((a, b) => b.due - a.due);
    return json({ hours, now: Date.now() });
  }
  /* Done on the swap page (Dennis, 2026-11-23: domo06 swapped early and ticked Done, then still got the DM and
     Swaps still listed it). Ticking Done now tells the server: the swap counts as finished for both members - no
     heads-up or contact DM goes to either side, and Swaps shows it done. Unticking (before the hour is over) puts
     it back. POST { u, d, t, id, done }. */
  if (op === 'hourmark' && request.method === 'POST') {
    let b = {}; try { b = await request.json(); } catch (e) {}
    const key = String(b.u || ''), due = Number(b.d), id = Number(b.id);
    if (!key || !due || !id || String(b.t || '') !== await hourSig(env, key, due)) return json({ error: 'This link is not valid.' }, 403);
    await matchCols(db);
    const m = await db.prepare("SELECT * FROM swap_matches WHERE id=? AND dueAt=? AND (LOWER(a)=? OR LOWER(b)=?)").bind(id, due, key.toLowerCase(), key.toLowerCase()).first();
    if (!m) return json({ error: 'That swap is not on this page.' }, 404);
    if (['cancelled', 'cleared'].includes(m.status)) return json({ error: 'That swap was called off.' }, 409);
    const now = Date.now();
    if (b.done) {
      if (!m.mDoneAt) await db.prepare(`UPDATE swap_matches SET mDoneAt=?, mDoneBy=?, warnA=COALESCE(warnA, ?), warnB=COALESCE(warnB, ?), doneA=COALESCE(doneA, ?), doneB=COALESCE(doneB, ?), status='sent', sentAt=? WHERE id=?`)
        .bind(now, key.toLowerCase(), now, now, now, now, now, id).run();
    } else if (m.mDoneAt) {
      if (now > due + 3600000) return json({ error: 'That hour is over.' }, 409);
      const t = m.mDoneAt, back = c => m[c] === t ? null : m[c];
      await db.prepare(`UPDATE swap_matches SET mDoneAt=NULL, mDoneBy=NULL, warnA=?, warnB=?, doneA=?, doneB=?, status=?, sentAt=NULL WHERE id=?`)
        .bind(back('warnA'), back('warnB'), back('doneA'), back('doneB'), (back('warnA') || back('warnB') || back('doneA') || back('doneB')) ? 'warned' : 'pending', id).run();
    }
    return json({ ok: true });
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
      out.push({ id: m.id, partnerKey: side === 'A' ? m.b : m.a, status: m.status, partner: o && o.rsUser, partnerUrl: o ? profileUrl(o.rsUser, o.hashId) : null, comment: (o && o.comment) || null,
        receive: playerName(me, recv), receiveUrl: playerUrl(recv),
        give: playerName(me, give), giveUrl: playerUrl(give), yourCard: me ? passUrl(me, give) : null, off: m.status === 'cancelling', mDone: !!m.mDoneAt });
    }
    // Their ratings of these partners (the swap page shows the stars they gave).
    let rated = {}, canRate = true;
    try { await db.prepare(RATE_DDL).run(); await db.prepare(RATE_BLOCK_DDL).run();
      for (const r of ((await db.prepare('SELECT ratee, stars FROM swap_ratings WHERE rater=?').bind(u.key).all()).results || [])) rated[r.ratee] = Number(r.stars);
      canRate = !(await db.prepare('SELECT 1 AS x FROM swap_rate_block WHERE key=?').bind(u.key).first()); } catch (e) {}
    // 160s this hour: packs they open for buyers (sell), and 160s they offer on (buy).
    const sell160 = [], buy160 = [], nicheBuy = [], nicheGet = [];
    try { for (const r of (((await db.prepare("SELECT * FROM swap_160 WHERE (buyer=? OR seller=?) AND dueAt=? AND status <> 'cancelled' ORDER BY id").bind(u.key, u.key, due).all()).results) || [])) {
        const o = await mem(r.seller === u.key ? r.buyer : r.seller), x = { id: r.id, partnerKey: r.seller === u.key ? r.buyer : r.seller, user: o && o.rsUser, url: o ? profileUrl(o.rsUser, o.hashId) : null, player: playerName(me, r.pass), playerUrl: playerUrl(r.pass) };
        // Niche: the member asked buys the player and a pack; the one who asked pays full price.
        /* The member asked doesn't own the player, so his name and card come
           from the one who asked (2026-11-10: it showed "Player 8482116 2024"). */
        if (r.kind === 'niche') {
          if (r.seller === u.key) { const asker = await loadMember(db, r.buyer).catch(() => null);
            nicheBuy.push({ ...x, player: asker ? playerName(asker, r.pass) : x.player, theirCard: asker ? passUrl(asker, r.pass) : null }); }
          else nicheGet.push({ ...x, comment: (o && o.comment) || null, yourCard: me ? passUrl(me, r.pass) : null });
          continue; }
        if (r.seller === u.key) sell160.push({ ...x, comment: (o && o.comment) || null, yourCard: me ? passUrl(me, r.pass) : null });
        else buy160.push({ ...x, comment: (o && o.comment) || null });
      } } catch (e) {}
    // Each partner's trust level (2026-11-11), shown by their name.
    try { const tm = await trustMap(env, db); for (const x of out) x.lv = (tm[x.partnerKey] || {}).lv || 'new'; } catch (e) {}
    // Stars they gave, on swaps and 160s alike (2026-11-12); the partner keys stay on the server.
    for (const x of [...out, ...sell160, ...buy160, ...nicheBuy, ...nicheGet]) { if (x.partnerKey) x.myStars = rated[x.partnerKey] || null; delete x.partnerKey; }
    return json({ user: (me && me.rsUser) || u.key, due, swaps: out, sell160, buy160, nicheBuy, nicheGet, canRate, ratingsOff: ratingsOff() || undefined, admin: ADMINS.includes(u.key.toLowerCase()) || undefined });
  }
  /* Most picked players, for everyone on the hour page (Dennis, 2026-11-05):
     how many active members are swapping for each player, most first. */
  // Who's swapping for one player on Most picked (Dennis, 2026-11-15): active swappers' Real usernames.
  if (op === 'hourwho') {
    const key = String(url.searchParams.get('u') || ''), due = Number(url.searchParams.get('d'));
    if (!key || !due || url.searchParams.get('t') !== await hourSig(env, key, due)) return json({ error: 'This link is not valid.' }, 403);
    const pk = String(url.searchParams.get('k') || '').slice(0, 40);
    if (!/^[a-z]+:\d{4}:t?\d+$/.test(pk)) return json({ error: 'Pick a player.' }, 400);
    const rs = ((await db.prepare(`SELECT u.rsUser AS n, j.key AS i FROM swap_users u, json_each(u.wants) j WHERE u.active=1 AND u.hashId IN (SELECT v.hashId FROM swap_ver v JOIN swap_dm d ON d.hashId = v.hashId WHERE d.channelId IS NOT NULL) AND u.wants IS NOT NULL AND j.value=?`).bind(pk).all()).results) || [];
    const names = rs.filter(r => Number(r.i) < MAX_WANTS && r.n).map(r => r.n).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    return json({ key: pk, names });
  }
  /* Who's grinding what (Dennis, 2026-11-27): admins search members by name and see each one's picked players. */
  if (op === 'hourgrind') {
    const key = String(url.searchParams.get('u') || ''), due = Number(url.searchParams.get('d'));
    if (!key || !due || url.searchParams.get('t') !== await hourSig(env, key, due)) return json({ error: 'This link is not valid.' }, 403);
    if (!ADMINS.includes(key.toLowerCase())) return json({ error: 'Admins only.' }, 403);
    const q = String(url.searchParams.get('q') || '').trim().toLowerCase().replace(/^@/, '').replace(/[%_]/g, '').slice(0, 30);
    if (!q) return json({ users: [] });
    const rs = ((await db.prepare(`SELECT key, rsUser, wants, active, confirmDay, (hashId IN (SELECT v.hashId FROM swap_ver v JOIN swap_dm d ON d.hashId = v.hashId WHERE d.channelId IS NOT NULL)) AS ver FROM swap_users
      WHERE LOWER(key) LIKE ? OR LOWER(rsUser) LIKE ? ORDER BY (LOWER(rsUser)=? OR LOWER(key)=?) DESC, ver DESC, key LIMIT 12`).bind(q + '%', q + '%', q, q).all()).results) || [];
    const nc = new Map(), day = confirmDayNow(), users = [];
    for (const r of rs) { const ws = parse(r.wants, []).slice(0, MAX_WANTS), picks = [];
      for (const k of ws) picks.push({ key: k, name: await indexName(db, k, nc), url: playerUrl(k) });
      users.push({ name: r.rsUser || r.key, active: !!r.active, verified: !!r.ver, confirmed: r.confirmDay === day, picks }); }
    return json({ users });
  }
  if (op === 'hourtop') {
    const key = String(url.searchParams.get('u') || ''), due = Number(url.searchParams.get('d'));
    if (!key || !due || url.searchParams.get('t') !== await hourSig(env, key, due)) return json({ error: 'This link is not valid.' }, 403);
    const c = await wantTop(env, db);
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
    let c0err = null;
    if (!c || url.searchParams.get('rebuild') === '1') {
      const ss = ((await (await fetch(`${url.origin}/api/rax?gamelog=seasons`)).json()).seasons || []).filter(x => x.sport !== 'soccer').map(x => `${x.sport}:${x.season}`);
      const j = await (await fetch(`${url.origin}/api/rax?gamelog=query&mode=players&seasons=${encodeURIComponent(ss.join(','))}&sort=rax&dir=desc&limit=250`)).json();
      if (!j || !Array.isArray(j.rows)) return json({ error: (j && j.error) || 'Game data did not answer - try again.' }, 502);
      const SP = { nba: 'NBA', ncaam: 'CBB', nfl: 'NFL', ncaaf: 'CFB', nhl: 'NHL', mlb: 'MLB', wnba: 'WNBA', golf: 'Golf' };
      // 250 kept: the list shown leaves out passes someone is swapping for, so it needs spares.
      const top = j.rows.filter(r => r.sport !== 'soccer').slice(0, 250).map(r => ({ k: `${r.sport}:${r.season}:${r.playerId}`, r }));
      // Counted in the database (reading every member's passes here ran out of memory).
      const have = new Map(), ks = top.map(x => x.k);
      // One pass over everyone's passes, the 250 keys handed in as one JSON list.
      try { for (const r of (((await db.prepare(`SELECT json_extract(j.value, '$.key') AS k, COUNT(DISTINCT u.key) AS n FROM swap_users u, json_each(u.passes) j
          WHERE u.passes IS NOT NULL AND json_extract(j.value, '$.key') IN (SELECT value FROM json_each(?)) AND COALESCE(json_extract(j.value, '$.kind'), '') <> 'team' GROUP BY k`).bind(JSON.stringify(ks)).all()).results) || []))
        have.set(r.k, Number(r.n) || 0); } catch (e) { c0err = String(e.message || e); }
      c = { at: Date.now(), seasons: ss.length, rows: top.map(({ k, r }) => ({ key: k, name: r.player, sport: SP[r.sport] || r.sport, season: r.season, rax: Number(r.rax) || 0, owners: r.owners == null ? null : Number(r.owners), onSite: have.get(k) || 0, url: playerUrl(k) })) };
      // Not kept if the on-site count failed (so the next open tries again).
      if (!c0err) { try { await env.RATEBOARD_KV.put('swap_raxtop_snap_v2', JSON.stringify(c)); } catch (e) {} }
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
        sched = { mode: 'daily', ...(sched && sched.tz ? { tz: sched.tz } : {}) };
      } else return json({ error: 'Nothing to change.' }, 400);
      await db.prepare('UPDATE swap_users SET wants=?, slots=?, sched=?, updatedAt=? WHERE key=?').bind(JSON.stringify(wants), JSON.stringify(slots), JSON.stringify(sched || { mode: 'daily' }), Date.now(), me).run();
      try { await env.RATEBOARD_KV.delete('swap_wantcounts_v3'); await env.RATEBOARD_KV.delete('swap_hourcounts_v3'); } catch (e) {}
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
  /* Rating leaderboard for everyone on the swap page (Dennis, 2026-11-06):
     every rated member by average stars, with how many votes. Ratings from
     members whose rating was turned off don't count. */
  if (op === 'hourratings') {
    const key = String(url.searchParams.get('u') || ''), due = Number(url.searchParams.get('d'));
    if (!key || !due || url.searchParams.get('t') !== await hourSig(env, key, due)) return json({ error: 'This link is not valid.' }, 403);
    await db.prepare(RATE_DDL).run(); await db.prepare(RATE_BLOCK_DDL).run();
    /* Weekly and monthly boards too (2026-11-11), so new traders have a shot:
       ratings and trades from that stretch only. Ordered by the weighted
       score, so many good ratings beat a few perfect ones. */
    const period = url.searchParams.get('period') || 'all', since = period === 'week' ? Date.now() - 7 * 86400000 : period === 'month' ? Date.now() - 30 * 86400000 : 0;
    let rows = ((await db.prepare(`SELECT r.ratee AS k, AVG(r.stars) AS avg, SUM(r.stars) AS sum, COUNT(*) AS n, u.rsUser AS rsUser, u.hashId AS hashId FROM swap_ratings r LEFT JOIN swap_users u ON u.key = r.ratee
      WHERE r.rater NOT IN (SELECT key FROM swap_rate_block) AND r.at >= ? GROUP BY r.ratee LIMIT 1000`).bind(since).all()).results) || [];
    const tm = await trustMap(env, db), tcP = since ? await tradeCounts(db, since) : null;
    rows = rows.map(r => { const trades = tcP ? (tcP.get(String(r.k)) || 0) : ((tm[r.k] || {}).t || 0);
        return { ...r, trades, score: starScore(r.sum, r.n), pts: swapScore(r.sum, r.n, trades, period) }; })
      /* Ranked by Swap Score (Dennis, 2026-11-16): more ratings and more swaps place higher, so 99
         fives out of 100 beat 5 out of 5. Still shown: the plain average and the vote count. */
      .sort((a, b) => (Number(a.n) >= RL_MIN ? 0 : 1) - (Number(b.n) >= RL_MIN ? 0 : 1) || b.pts - a.pts || b.n - a.n).slice(0, 500);
    const ready = rows.filter(r => Number(r.n) >= RATE_ON_VOTES).length;
    return json({ rlMin: RL_MIN, me: key.toLowerCase(), live: ready >= RATE_ON_MEMBERS, ready, needMembers: RATE_ON_MEMBERS, needVotes: RATE_ON_VOTES, admin: ADMINS.includes(key.toLowerCase()) || undefined, rows: rows.map(r => ({ k: r.k, user: r.rsUser || r.k, url: profileUrl(r.rsUser || r.k, r.hashId), avg: Math.round(Number(r.avg) * 100) / 100, score: Math.round(r.score * 100) / 100, pts: Math.round(r.pts * 10) / 10, votes: Number(r.n), trades: r.trades, lv: (tm[r.k] || {}).lv || 'new', mine: String(r.k).toLowerCase() === key.toLowerCase() || undefined })), period });
  }
  /* Admin (Dennis, 2026-11-06): every rating one member was given, who gave
     it, and changing or removing any of them by hand. */
  if (op === 'hourratingsof' || op === 'hourrateset') {
    const key = String(url.searchParams.get('u') || ''), due = Number(url.searchParams.get('d'));
    if (!key || !due || url.searchParams.get('t') !== await hourSig(env, key, due)) return json({ error: 'This link is not valid.' }, 403);
    if (!ADMINS.includes(key.toLowerCase())) return json({ error: 'Admins only.' }, 403);
    await db.prepare(RATE_DDL).run(); await db.prepare(RATE_BLOCK_DDL).run();
    let ratee = String(url.searchParams.get('who') || '');
    if (op === 'hourrateset' && request.method === 'POST') {
      let b = {}; try { b = await request.json(); } catch (e) {}
      ratee = String(b.ratee || ''); const rater = String(b.rater || ''), stars = Math.round(Number(b.stars));
      if (!ratee || !rater) return json({ error: 'Missing member.' }, 400);
      if (stars === 0) await db.prepare('DELETE FROM swap_ratings WHERE rater=? AND ratee=?').bind(rater, ratee).run();
      else if (stars >= 1 && stars <= 5) await db.prepare('UPDATE swap_ratings SET stars=?, at=? WHERE rater=? AND ratee=?').bind(stars, Date.now(), rater, ratee).run();
      else return json({ error: 'Pick 1 to 5 stars, or 0 to remove.' }, 400);
      await stat(db, 'rate_admin_edit');
    }
    if (!ratee) return json({ error: 'Pick a member.' }, 400);
    const rows = ((await db.prepare(`SELECT r.rater, r.stars, r.at, r.matchId, u.rsUser, u.hashId, (SELECT 1 FROM swap_rate_block b WHERE b.key = r.rater) AS blocked
      FROM swap_ratings r LEFT JOIN swap_users u ON u.key = r.rater WHERE r.ratee=? ORDER BY r.at DESC`).bind(ratee).all()).results) || [];
    return json({ ratee, rows: rows.map(r => ({ rater: r.rater, user: r.rsUser || r.rater, url: profileUrl(r.rsUser || r.rater, r.hashId), stars: Number(r.stars), at: Number(r.at), matchId: r.matchId, blocked: !!r.blocked })) });
  }
  if (op === 'hourrate' && request.method === 'POST') {
    const key = String(url.searchParams.get('u') || ''), due = Number(url.searchParams.get('d'));
    if (!key || !due || url.searchParams.get('t') !== await hourSig(env, key, due)) return json({ error: 'This link is not valid.' }, 403);
    let b = {}; try { b = await request.json(); } catch (e) {}
    const stars = Math.round(Number(b.stars));
    if (ratingsOff()) return json({ error: 'Ratings are off today.' }, 400);
    if (!(stars >= 1 && stars <= 5)) return json({ error: 'Pick 1 to 5 stars.' }, 400);
    await matchCols(db); await db.prepare(RATE_DDL).run(); await db.prepare(RATE_BLOCK_DDL).run();
    const u = await db.prepare('SELECT key FROM swap_users WHERE LOWER(key)=?').bind(key.toLowerCase()).first();
    // A 160 (2026-11-12): rated like a swap partner - one rating per person either way.
    let m = null;
    if (b.k160 != null) { const r = u && await db.prepare("SELECT * FROM swap_160 WHERE id=? AND (buyer=? OR seller=?) AND dueAt=? AND status <> 'cancelled'").bind(Number(b.k160), u.key, u.key, due).first();
      if (r) m = { id: null, a: r.buyer, b: r.seller, dueAt: r.dueAt, k160: 1 }; }
    else m = u && await db.prepare("SELECT * FROM swap_matches WHERE id=? AND (a=? OR b=?) AND dueAt=? AND status NOT IN ('cancelled','cancelling','cleared')").bind(Number(b.id), u.key, u.key, due).first();
    if (!m) return json({ error: 'That swap was not found.' }, 404);
    if (Date.now() < (m.k160 ? Number(m.dueAt) : sideDue(m))) return json({ error: 'You can rate once the swap time has come.' }, 400);
    { const rbk = u && await db.prepare('SELECT why FROM swap_rate_block WHERE key=?').bind(u.key).first(); if (rbk) return json({ error: /by admin/i.test(String(rbk.why || '')) ? 'Your ability to rate has been removed.' : 'Your rating was turned off for rating unfairly.' }, 403); }
    if (!(await allow(url.origin, 'rate:' + u.key, 60, 3600))) return json({ error: 'Too many ratings at once - try again later.' }, 429);
    const ratee = m.a === u.key ? m.b : m.a;
    await db.prepare('INSERT INTO swap_ratings (rater, ratee, stars, at, matchId) VALUES (?, ?, ?, ?, ?) ON CONFLICT(rater, ratee) DO UPDATE SET stars=excluded.stars, at=excluded.at, matchId=excluded.matchId').bind(u.key, ratee, stars, Date.now(), m.id).run();
    await stat(db, 'rate_' + stars);
    if (stars === 1 && await rateModerate(db, u.key)) return json({ ok: true, blocked: true });
    return json({ ok: true, stars });
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
    if (u && await reportBlocked(env, u.key)) return json({ error: "Your ability to send reports has been removed." }, 403);
    /* "Took 30+ min, no word" (a member's idea, 2026-11-12): a heads-up only.
       The partner gets a DM with a link to make it right; it never counts
       toward warnings or strikes. One per partner per swap. */
    if (b.reason === 'late' && u) {
      if (Date.now() < due + 30 * 60000) return json({ error: 'This one opens 30 minutes after the swap time.' }, 400);
      let other = null, id = Number(b.id);
      if (b.k160) { const t = await db.prepare('SELECT buyer, seller FROM swap_160 WHERE id=? AND (buyer=? OR seller=?) AND dueAt=?').bind(id, u.key, u.key, due).first(); if (t) other = t.buyer === u.key ? t.seller : t.buyer; }
      else { const m0 = await db.prepare("SELECT a, b FROM swap_matches WHERE id=? AND (a=? OR b=?) AND dueAt=? AND status NOT IN ('cancelled','cancelling','cleared')").bind(id, u.key, u.key, due).first(); if (m0) other = m0.a === u.key ? m0.b : m0.a; }
      if (!other) return json({ error: 'That swap was not found.' }, 404);
      const once = `late_v1_${u.key}_${b.k160 ? 's' : 'm'}${id}`;
      if (await env.RATEBOARD_KV.get(once)) return json({ error: 'You already sent this one.' }, 429);
      if (!(await allow(url.origin, 'swapreport:' + u.key, 10, 3600))) return json({ error: 'You have sent a lot of reports - try again later.' }, 429);
      const me = await loadMember(db, u.key), o = await db.prepare('SELECT key, rsUser, hashId, sched FROM swap_users WHERE key=?').bind(other).first();
      await db.prepare(SREPORT_DDL).run();
      await db.prepare('INSERT INTO swap_reports (ts, by_user, kind, target, detail, status) VALUES (?, ?, ?, ?, ?, ?)').bind(Date.now(), u.key, 'late', (o && o.rsUser) || other,
        `Took 30+ min, no word - ${b.k160 ? '160' : 'swap'} #${id} (${new Date(due).toISOString().slice(0, 16).replace('T', ' ')} UTC)` + (note ? `\n${note}` : ''), 'auto').run();
      await env.RATEBOARD_KV.put(once, '1', { expirationTtl: 7 * 86400 });
      await stat(db, 'report_late');
      let sent = false;
      try { const auth = swapToken(env);
        if (auth && o && o.hashId) {
          const tz = ((parse(o.sched, null)) || {}).tz, link = await hourLink(env, o.key, due);
          const text = `This is just a heads-up report - no action will be taken. You were reported for your swap on ${modTime(due, tz)} with @${(me && me.rsUser) || u.key}. Here's the link if you would like to make it right: ${link}`;
          const ch = await dmChannel(db, auth, o.hashId, o.rsUser, env); await queueDm(db, ch, [text], 'late ' + o.key); sent = true; } } catch (e) {}
      return json({ ok: true, sent });
    }
    // A 160 partner (same rules as swaps - Dennis, 2026-11-11).
    if (b.k160 && u) {
      const t = await db.prepare('SELECT * FROM swap_160 WHERE id=? AND (buyer=? OR seller=?) AND dueAt=?').bind(Number(b.id), u.key, u.key, due).first();
      if (!t) return json({ error: 'That 160 was not found.' }, 404);
      const other = t.buyer === u.key ? t.seller : t.buyer, o = await loadMember(db, other);
      const target = (o && o.rsUser) || other;
      if (!(await allow(url.origin, 'swapreport:' + u.key, 10, 3600))) return json({ error: 'You have sent a lot of reports - try again later.' }, 429);
      if (Date.now() < due + MOD_GRACE) return json({ error: `You can report a no-show from ${new Date(due + MOD_GRACE).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' })} ET - 20 minutes after the swap time, so everyone gets a fair chance to show up.` }, 400);
      const R160 = { nooffer: "Didn't send me an offer", nobuy: "Didn't send 160 back", wrong: 'Sent the wrong offer', other: 'Other' };
      const detail = `${R160[b.reason] || R160.other} - 160 #${t.id} (${new Date(due).toISOString().slice(0, 16).replace('T', ' ')} UTC), reporter was the ${t.buyer === u.key ? 'buyer' : 'seller'}` + (note ? `\n${note}` : '');
      await modReady(db);
      await db.prepare('INSERT INTO swap_reports (ts, by_user, kind, target, detail, status, m160) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(Date.now(), u.key, 'user', target, detail, 'open', t.id).run();
      await stat(db, 'report_user');
      return json({ ok: true });
    }
    const m = u && await db.prepare('SELECT * FROM swap_matches WHERE id=? AND (a=? OR b=?) AND dueAt=?').bind(Number(b.id), u.key, u.key, due).first();
    if (!m) return json({ error: 'That swap was not found.' }, 404);
    if (Date.now() < due + MOD_GRACE) return json({ error: `You can report a no-show from ${new Date(due + MOD_GRACE).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' })} ET - 20 minutes after the swap time, so everyone gets a fair chance to show up. Use "running late" if you just want to nudge them.` }, 400);
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
    if (await env.RATEBOARD_KV.get(once)) return json({ error: 'Already sent - check your DMs from @rax.academy.' }, 429);
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
  // Background scans in a run of their own each minute (2026-11-08).
  if (op === 'scantick') {
    const k = await dmTickKey(env);
    if (!k || url.searchParams.get('k') !== k) return json({ error: 'no' }, 403);
    const minute = 'scan|' + new Date().toISOString().slice(0, 16);
    /* Never alongside the hourly matching (2026-11-08: from 17:20 UTC, the first
       run after background scans got their own minute run, matching never
       finished - scans saving big rows at the same time held the database up).
       Off from :18 to :29, and while the matching lock is held. */
    const mm = new Date().getUTCMinutes();
    if (mm >= 18 && mm <= 29) return json({ ok: true, started: false, why: 'matching' });
    try { const l = await db.prepare("SELECT until FROM run_lock WHERE k='match'").first(); if (l && Number(l.until) > Date.now()) return json({ ok: true, started: false, why: 'matching' }); } catch (e) {}
    let go = false;
    try { await db.prepare('CREATE TABLE IF NOT EXISTS dm_runs (minute TEXT PRIMARY KEY, at INTEGER)').run();
      const c = await db.prepare('INSERT OR IGNORE INTO dm_runs (minute, at) VALUES (?, ?)').bind(minute, Date.now()).run(); go = !!(c && c.meta && c.meta.changes); } catch (e) {}
    const auth0 = swapToken(env);
    if (go && auth0) { try { waitUntil(backgroundScans(env, db, auth0).catch(e => botFail(db, 'scan_bg', e.message))); } catch (e) {} }
    // Niche owner counts, refreshed once an hour.
    if (go) { try { const oc = await ownerCounts(env); if (Date.now() - (oc.at || 0) > 60 * 60000) waitUntil(saveOwnerCounts(env, db).catch(() => {})); } catch (e) {} }
    // Untouchable re-reads only at :00-:17, never while warnings (:30-:55) or contacts (:55-:10) go out... :00-:10 is light (contacts are sent by the DM tick, not here).
    if (go && new Date().getUTCMinutes() >= 1 && new Date().getUTCMinutes() < 18) { try { waitUntil(untouchRefresh(env, db).catch(() => {})); } catch (e) {} }
    if (go) { try { waitUntil(top15Dm(env, db).catch(() => {})); } catch (e) {} }
    // Moderation: reports counted into warnings / strikes / bans every 10 minutes.
    if (go) { try { const ml = Number(await env.RATEBOARD_KV.get('mod_last_v1')) || 0;
      /* Only at :11-:17 (2026-11-12): its big reads during :30-:55 overloaded the
         database while the swap warnings were going out, and members missed them. */
      const mm2 = new Date().getUTCMinutes(), quiet = mm2 >= 11 && mm2 < 18;
      if (quiet && Date.now() - ml > 25 * 60000) { await env.RATEBOARD_KV.put('mod_last_v1', String(Date.now()));
        waitUntil((MOD_AUTO ? moderate(env, db) : moderate(env, db, true).then(o => env.RATEBOARD_KV.put('mod_preview_v1', JSON.stringify({ at: Date.now(), ...o,
          users: undefined, strikesDist: o.users.reduce((a, u) => { a[u.strikes] = (a[u.strikes] || 0) + 1; return a; }, {}) }))))
          .catch(e => { botFail(db, 'moderate', e.message); return env.RATEBOARD_KV.put('mod_error_v1', JSON.stringify({ at: Date.now(), err: String(e && e.message || e).slice(0, 200) })); })); } } catch (e) {} }
    return json({ ok: true, started: go });
  }
  if (op === 'dmtick') {
    const k = await dmTickKey(env);
    if (!k || url.searchParams.get('k') !== k) return json({ error: 'no' }, 403);
    // Only one run at a time across the site: a claim row per minute.
    const minute = new Date().toISOString().slice(0, 16) + (url.searchParams.get('half') === '2' ? ':b' : '');
    let go = false;
    try { await db.prepare('CREATE TABLE IF NOT EXISTS dm_runs (minute TEXT PRIMARY KEY, at INTEGER)').run();
      const c = await db.prepare('INSERT OR IGNORE INTO dm_runs (minute, at) VALUES (?, ?)').bind(minute, Date.now()).run(); go = !!(c && c.meta && c.meta.changes);
      if (Math.random() < 0.02) await db.prepare('DELETE FROM dm_runs WHERE at < ?').bind(Date.now() - 86400000).run(); } catch (e) {}
    if (go) { try { waitUntil(dmTick(env).catch(() => {})); } catch (e) {} }
    return json({ ok: true, started: go });
  }
  const acc = await swapAccess(env, request);
  mark(request, 'access');
  /* Moderation, for anyone signed in (a member whose Swaps were taken away
     still sees their record and can ask for an unban). */
  /* Public (Dennis, 2026-11-12): today's top players to boost, from the
     projections and team schedules - player names only, nothing about members.
     Saved for 20 minutes; a crowd costs one KV read. */
  if (op === 'boosttop') {
    if (!(await allow(url.origin, 'boosttop:' + (request.headers.get('cf-connecting-ip') || ''), 30, 60))) return json({ error: 'Too many refreshes - wait a minute.' }, 429);
    /* Top players tab on Boosts (Dennis, 2026-11-12): every sport's top 100 by
       projected rax for a day (today up to 6 days ahead), plus all sports
       together. One build per day every 20 minutes, shared by everyone. */
    // One formatter, not one per call (2026-11-14: a new Intl formatter per row x per game was 25s and +2GB a build).
    const ETF = ET_DAY_FMT, etd = d => ETF.format(d);
    const days0 = [...Array(7)].map((_, i) => etd(new Date(Date.now() + i * 86400000)));
    const today = days0.includes(url.searchParams.get('day')) ? url.searchParams.get('day') : days0[0];
    const K = 'boosttop_v11_' + today;   // v10-11: FC included   // v4: no one who sat out his team's last game
    try { const c = JSON.parse((await env.RATEBOARD_KV.get(K)) || 'null'); if (c && Date.now() - c.at < 10 * 60000) return json(c); } catch (e) {}
    const out = { at: Date.now(), day: today, sports: {} };
    for (const sp of ['nfl', 'ncaaf', 'nba', 'ncaam', 'nhl', 'soccer']) {
      let pj = null, sc = null;
      try { [pj, sc] = await Promise.all([env.RATEBOARD_KV.get(`proj_v3_${sp}`), env.RATEBOARD_KV.get(`projsched_v2_${sp}`)]); pj = JSON.parse(pj || 'null'); sc = JSON.parse(sc || 'null'); } catch (e) {}
      // Built before the current model version: build again in the background (one at a time per sport).
      let pf = 0; try { pf = Number(await env.RATEBOARD_KV.get(`proj_force_v1_${sp}`)) || 0; } catch (e) {}
      if (pj && (Number(pj.zfix || 0) < 4 || pf > Number(pj.at || 0))) { try { const lk = `proj_lock_v1_${sp}`; if (!(await env.RATEBOARD_KV.get(lk))) { await env.RATEBOARD_KV.put(lk, '1', { expirationTtl: 120 });
        const job = projBuild(env, db, sp).finally(() => env.RATEBOARD_KV.delete(lk).catch(() => {})); try { waitUntil(job.catch(() => {})); } catch (e) { job.catch(() => {}); } } } catch (e) {} }
      /* FC (2026-11-28: Top players always said "No FC games that day" - FC has no season schedule to read, so it was
         skipped). The day's games from the FC schedule Boosts already uses, each player's per-start rate x how often
         he plays from the season projections, home 1.05 / away 0.95; out of a posted lineup or on the bench = left
         off; Real's injury list and the hand list = left off when Out/Doubtful/Suspended. */
      if (sp === 'soccer') {
        if (!pj) continue;
        let fs = null; try { fs = await fcSchedule(env, today); } catch (e) {}
        if (!fs || fs.error || !fs.teams) continue;
        const byAb = new Map(); for (const tm of Object.values(fs.teams)) { if (!tm.ab) continue; (byAb.get(tm.ab) || byAb.set(tm.ab, []).get(tm.ab)).push(tm); }
        const evs = new Map((fs.events || []).map(e => [e.id, e])), lus = new Map(), list = [];
        const cand = [];
        for (const r of (pj.rows || [])) { const x = r.x || {}; if (!(x.av > 0) || x.sk || x.sn || x.ml) continue;
          // His club's ESPN id the way FC boosts find it (Real's codes aren't ESPN's: Bayern is FCB on Real, MUN on ESPN).
          const lgc = String((x.fc && x.fc.lg) || '').toUpperCase();
          let ids = fcClubIds({ team: r.t, conference: lgc }).filter(id => fs.teams[id] && fs.teams[id].lg !== 'usa.1');
          if (!ids.length && !FC_CLUBS[String(r.t).toUpperCase()]) ids = (byAb.get(r.t) || []).filter(tm0 => tm0.lg === FC_CONF_LG[lgc]).map(tm0 => tm0.id);
          if (ids.length !== 1) continue; const tm = fs.teams[ids[0]];
          cand.push({ r, tm, v: x.rate * x.av * (tm.home ? 1.05 : 0.95) }); }
        cand.sort((a, b) => b.v - a.v);
        const short = cand.slice(0, 160);
        let hand = {}, rinj = {};
        try { hand = await boostManualOut(env, 'soccer', today); } catch (e) {}
        try { rinj = await realInjuries(env, 'soccer', short.map(c => c.r.i)); } catch (e) {}
        for (const c of short) { const { r, tm } = c;
          const hj = hand[boostName(r.n)], ri = rinj[Number(r.i)], st = (hj && hj.status) || (ri && ri.s) || '';
          if (/^(out|injured|doubtful|suspen)/i.test(st)) continue;
          // A posted lineup decides: not starting = no booster.
          const ev = evs.get(tm.ev); let lu = ev ? lus.get(ev.id) : null;
          if (ev && lu === undefined) { try { lu = await fcLineup(env, ev, false); } catch (e) { lu = null; } lus.set(ev.id, lu); }
          const LT = lu && lu.out ? lu.teams[tm.id] : null;
          if (LT) { const fnd = fcFind(r.n, LT.p, null); if (!fnd || !fnd.p.s) continue; }
          list.push({ id: r.i, n: r.n, u: r.i ? playerUrl(`soccer:${(PROJ_SEASON.soccer || [])[0]}:${r.i}`) : null, t: r.t, p: r.p, opp: tm.oppAb || tm.opp, h: tm.home ? 'home' : 'away', at: tm.at,
            v: Math.round(c.v * 10) / 10, a: r.a, gp: r.gp, inj: /question|day-to-day/i.test(st) ? st : undefined, lu: LT ? 'start' : undefined }); }
        list.sort((a, b) => b.v - a.v);
        const topS = list.slice(0, 100); for (const x of topS) delete x.id;
        if (topS.length) out.sports[sp] = topS;
        continue;
      }
      if (!pj || !sc || !sc.teams) continue;
      const of = pj.of || {}, hf = pj.hf || {}, list = [], todayG = new Map();
      // Each team's game that day, worked out once per team.
      for (const [ab, gs] of Object.entries(sc.teams)) { const g = (gs || []).find(t => !t[2] && t[0] && etd(new Date(t[0])) === today); if (g) todayG.set(ab, g); }
      /* Today's injury report, not the one from when the projections were built
         (2026-11-15: Kenneth Walker was ruled out and still showed Questionable). */
      let inj = {};
      if (sp !== 'soccer') {
        try { inj = { ...(await boostInjuries(env, sp)) }; } catch (e) {}
        if (sp === 'nfl' && sc.ids) { try { Object.assign(inj, await boostTeamInj(env, sp, [...todayG.keys()].map(ab => sc.ids[ab]))); } catch (e) {} }
      }
      try { Object.assign(inj, await boostManualOut(env, sp, today)); } catch (e) {}
      /* "Sat out his team's last game" only where that game is in the log (2026-11-25: NFL Week 12 wasn't logged for
         most players yet, so Gibbs, Lamb, Allen and whole teams were left off Thanksgiving). A team where most regulars
         look like they sat out is a log that hasn't caught up, not a team that sat out. */
      const mlT = new Map(); for (const r of (pj.rows || [])) { const x = r.x || {}; if (!x.ab || !(x.av > 0.5)) continue; const c = mlT.get(x.ab) || mlT.set(x.ab, [0, 0]).get(x.ab); c[1]++; if (x.ml) c[0]++; }
      const mlOk = ab => { const c = mlT.get(ab); return !c || c[1] < 3 || c[0] / c[1] <= 0.4; };
      for (const r of (pj.rows || [])) {
        const x = r.x || {}; if (!x.ab || !(x.av > 0) || x.sk || x.sn || (x.ml && mlOk(x.ab))) continue;
        const g = todayG.get(x.ab); if (!g) continue;
        const ij = injOf(inj, r.n, sc.ids ? sc.ids[x.ab] : null);
        if (ij && /^(out|injured reserve|doubtful|suspen)/i.test(ij.status)) continue;
        const injNow = ij && /questionable|day-to-day/i.test(ij.status) ? ij.status : undefined;
        const v = x.rate * x.av * (of[g[1]] || 1) * (hf[g[3]] || 1);
        list.push({ id: r.i, n: r.n, u: r.i ? playerUrl(`${sp}:${(PROJ_SEASON[sp] || [])[0]}:${r.i}`) : null, t: r.t, p: r.p, opp: g[1], h: g[3], at: g[0], v: Math.round(v * 10) / 10, a: r.a, gp: r.gp, inj: injNow });
      }
      list.sort((a, b) => b.v - a.v);
      const top = list.slice(0, 100);
      /* Football: each player's average a game of every booster stat (Dennis, 2026-11-15),
         so the best attribute can be picked from the day's booster values. */
      if ((sp === 'nfl' || sp === 'ncaaf') && top.length) {
        try { const ids = top.map(x => x.id).filter(Boolean);
          const rs = (await db.prepare(`SELECT playerId, position, rax, stats FROM gamelog WHERE sport=? AND season=? AND playerId IN (${ids.map(() => '?').join(',')}) AND COALESCE(seasonType, 'regularseason') <> 'preseason'`).bind(sp, Number((PROJ_SEASON[sp] || [])[0]), ...ids).all()).results || [];
          const acc = new Map();
          for (const g of rs) { if (!g.stats && !(Number(g.rax) > 0)) continue;   // sat out
            let o = {}; try { o = JSON.parse(g.stats || '{}') || {}; } catch (e) {}
            const a = acc.get(Number(g.playerId)) || acc.set(Number(g.playerId), { n: 0, t: {} }).get(Number(g.playerId)); a.n++;
            for (const st of ['PTD', 'RUYDS', 'REC', 'TD', 'FGM', 'TKL', 'SACK', 'INT', 'FF', 'TFL']) { const v = footStat(o, st, g.position); if (v != null) a.t[st] = (a.t[st] || 0) + v; } }
          for (const x of top) { const a = acc.get(Number(x.id)); if (a && a.n) { x.st = {}; for (const [k, v] of Object.entries(a.t)) x.st[k] = Math.round(v / a.n * 100) / 100; x.gp = a.n; } }
        } catch (e) {}
      }
      for (const x of top) delete x.id;
      if (top.length) out.sports[sp] = top;
    }
    out.all = Object.entries(out.sports).flatMap(([sp, l]) => l.map(x => ({ ...x, sp }))).sort((a, b) => b.v - a.v).slice(0, 100);
    try { await env.RATEBOARD_KV.put(K, JSON.stringify(out), { expirationTtl: 3600 }); } catch (e) {}
    return json(out);
  }
  // Bulk rating listings (Dennis only, 2026-11-15): what account 2's slow loop has read.
  // Drafts (2026-11-15): today's and tomorrow's contests with the best lineup for each.
  if (op === 'drafts') {
    if (!acc.who) return forbidden('Sign in first (raxacademy.app).');
    const l = await draftList(env), etd = d => ET_DAY_FMT.format(d), days = [etd(new Date(Date.now() - 86400000)), etd(new Date()), etd(new Date(Date.now() + 86400000)), etd(new Date(Date.now() + 2 * 86400000))];
    /* Daily: one per sport - today's, else the next one coming (Dennis, 2026-11-15: several
       days of the same sport showed). Games: today's and tomorrow's, every sport; each
       one's lineup is worked out when it's opened (op=draftone), or shown if already built. */
    const today = days[1], spSeen = new Map();
    /* The newest contest for a sport and day is the real daily one (2026-11-16: earlier numbers for the same
       day pooled every team in the league - Messi and Haaland on a day with two international games). */
    for (const c of l.filter(c => c.type === 'sport' && c.day >= today).sort((a, b) => a.day.localeCompare(b.day) || b.id - a.id)) if (!spSeen.has(c.sport)) spSeen.set(c.sport, c);
    const want = [...spSeen.values()];
    const games = [];
    for (const c of l.filter(c => c.type === 'game' && (c.day === today || c.day === days[2]))) {
      let x = null; try { x = JSON.parse((await env.RATEBOARD_KV.get(`draft_v1_game_${c.id}`)) || 'null'); } catch (e) {}
      games.push(x ? { ...x, built: true } : { id: c.id, type: 'game', sport: c.sport, day: c.day, gameId: c.gameId, title: c.title || null, post: c.post || null }); }
    const SPN0 = { nba: 'NBA', ncaam: 'CBB', nfl: 'NFL', ncaaf: 'CFB', nhl: 'NHL', mlb: 'MLB', wnba: 'WNBA', golf: 'Golf', soccer: 'FC' };
    for (const g of games) g.sportName = SPN0[g.sport] || g.sport;
    const out = [];
    /* Shown from the saved build (even a little old) so the page never waits on Real; an old or
       missing one is rebuilt in the background (a full pool is ~25 searches). */
    for (const c of want) {
      let x = null; try { x = JSON.parse((await env.RATEBOARD_KV.get(`draft_v1_${c.type}_${c.id}`)) || 'null'); } catch (e) {}
      if (!x || Date.now() - x.at > 10 * 60000) { const lk = `draft_bld_${c.type}_${c.id}`; if (!(await env.RATEBOARD_KV.get(lk))) { await env.RATEBOARD_KV.put(lk, '1', { expirationTtl: 120 }); try { waitUntil(draftBuild(env, db, c).catch(() => {})); } catch (e) {} } }
      out.push(x ? { ...x, sportName: SPN0[c.sport] || c.sport, title: c.title || null } : { id: c.id, type: c.type, sport: c.sport, day: c.day, sportName: SPN0[c.sport] || c.sport, pending: true });
    }
    return json({ admin: !!acc.admin, today: days[1], contests: out.concat(games) });
  }
  // One draft's lineup, worked out when it's opened.
  if (op === 'draftone') {
    if (!acc.who) return forbidden('Sign in first (raxacademy.app).');
    const id = Number(url.searchParams.get('id')), type = url.searchParams.get('type') === 'game' ? 'game' : 'sport';
    const c = (await draftList(env)).find(x => x.id === id && x.type === type);
    if (!c) return json({ error: 'That draft is not on the list.' }, 404);
    const x = await draftBuild(env, db, c);
    return json({ ...x, sportName: ({ nba: 'NBA', ncaam: 'CBB', nfl: 'NFL', ncaaf: 'CFB', nhl: 'NHL', mlb: 'MLB', wnba: 'WNBA', golf: 'Golf', soccer: 'FC' })[c.sport] || c.sport, title: c.title || null, built: true });
  }
  // Admin: add a contest from a Real link (the contest or player-list address; a post link can ride along).
  if (op === 'draftadd' && request.method === 'POST') {
    if (!acc.admin) return forbidden('Admin only.');
    let b = {}; try { b = await request.json(); } catch (e) {}
    const u = String(b.url || ''), m = u.match(/playerratingcontest\/(\d+)/) || u.match(/contestId=(\d+)/);
    if (!m) return json({ error: 'Paste the contest link (it has playerratingcontest/<number> or contestId=<number> in it).' }, 400);
    const id = Number(m[1]), type = /contestType=game|gameId=/.test(u) ? 'game' : 'sport', gm = u.match(/gameId=(\d+)/);
    const d = await draftInfo(env, id, type).catch(() => null);
    if (!d || d.status !== 200) return json({ error: `Real didn't find that ${type} draft (${d && d.status}).` }, 400);
    const l = await draftList(env); const i0 = l.findIndex(c => c.id === id && c.type === type);
    const c = { id, type, sport: d.info.sport, day: d.info.day, gameId: d.info.gameId || (gm ? Number(gm[1]) : null), post: String(b.post || '').trim() || null, title: String(b.title || '').trim().slice(0, 60) || null, added: Date.now() };
    if (i0 >= 0) l[i0] = { ...l[i0], ...c }; else l.push(c);
    await draftSaveList(env, l); try { await env.RATEBOARD_KV.delete(`draft_v1_${type}_${id}`); } catch (e) {}
    return json({ ok: true, contest: c });
  }
  if (op === 'draftdel' && request.method === 'POST') {
    if (!acc.admin) return forbidden('Admin only.');
    let b = {}; try { b = await request.json(); } catch (e) {}
    await draftSaveList(env, (await draftList(env)).filter(c => !(c.id === Number(b.id) && c.type === b.type)));
    return json({ ok: true });
  }
  // Prediction-market EV (Dennis only for now, 2026-11-16): what the 2-minute job saved.
  /* Who else can open Predictions (Dennis, 2026-11-16, until it goes public): KV list of member keys. */
  const PRED_ACC = 'pred_access_v1';
  const predAcc = async () => { try { return JSON.parse((await env.RATEBOARD_KV.get(PRED_ACC)) || '[]') || []; } catch (e) { return []; } };
  // Open to every signed-in member (Dennis, 2026-11-17). The list stays for if it ever goes invite-only again.
  const PRED_PUBLIC = true;
  if (op === 'predaccess') {
    if (String(acc.who || '').toLowerCase() !== 'dennis') return forbidden('Only Dennis can change this.');
    let l = await predAcc();
    const add = String(url.searchParams.get('add') || '').trim().toLowerCase(), del = String(url.searchParams.get('del') || '').trim().toLowerCase();
    if (add && !l.includes(add)) { l.push(add); await env.RATEBOARD_KV.put(PRED_ACC, JSON.stringify(l)); }
    if (del) { l = l.filter(k => k !== del); await env.RATEBOARD_KV.put(PRED_ACC, JSON.stringify(l)); }
    const rows = [];
    for (const k of l) { let r = null; try { r = await db.prepare('SELECT key, rsUser FROM swap_users WHERE LOWER(key)=?').bind(k).first(); } catch (e) {} rows.push({ key: k, rsUser: (r && r.rsUser) || k }); }
    return json({ rows });
  }
  /* Your placed bets (2026-11-16): kept per member on the server so they follow you between devices.
     POST {add: {...}} / {set: {id, amt}} / {del: id}. At most 300 kept. */
  /* Build to full size (Dennis, 2026-11-17, owner only while testing): big stakes move Real's price too much
     in one go, so a side's full size is bought in pieces before the game starts and a notification says when
     to buy the next one. Plans: { gid, side, target (rax), unit (rax), at }. */
  /* My bets lines up with Real (Dennis, 2026-11-17): after a sync, each open position is his bet on that side -
     amount = Real's cost, pays = Real's payout, price = cost / payout. A position with no bet logged is added;
     a logged open bet on a game Real shows no position for is left alone and flagged. */
  // Dennis's own Real portfolio, fetched from his account when he taps Sync (owner only).
  if (op === 'predport') {
    /* Dennis, plus members whose own Real token Dennis put in .env (2026-11-18). */
    const pw = String(acc.who || '').toLowerCase();
    if (!pw || !predPortTok(env, pw)) return forbidden('Not open yet.');
    // Only fetched when they tap Sync (Dennis, 2026-11-17: "don't pull my portfolio unless I ask").
    let synced = null;
    if (request.method === 'POST') {
      /* Linked members sync on their own every 2 min while Predictions is open (2026-11-18);
         at most one Real read per 90 s each, however many tabs. Dennis still syncs only on tap. */
      let last = 0; if (pw !== 'dennis') { try { last = (JSON.parse((await env.RATEBOARD_KV.get('pred_port_v1_' + pw)) || '{}') || {}).at || 0; } catch (e) {} }
      if (Date.now() - last > 90000) { try { await predPortSync(env, pw); } catch (e) {} synced = await portToBets(env, pw); } }
    let x = {}; try { x = JSON.parse((await env.RATEBOARD_KV.get('pred_port_v1' + (pw === 'dennis' ? '' : '_' + pw))) || '{}') || {}; } catch (e) {}
    let plans = []; try { plans = JSON.parse((await env.RATEBOARD_KV.get('pred_build_v1_' + pw)) || '[]') || []; } catch (e) {}
    return json({ at: x.at || null, pos: x.pos || [], perf: x.perf || null, err: x.err || null, plans, synced });
  }
  /* Predictions alerts for linked members (2026-11-18): their Notifications tab reads and saves these;
     rax.js predMemberAlerts sends them. */
  if (op === 'predalerts') {
    const who = String(acc.who || '').toLowerCase(); if (!who) return json({ error: 'Sign in first.' }, 401);
    // Everyone with Predictions now (Dennis, 2026-11-23: "On EV page add the notifications tab"); holdings come from synced positions or logged bets.
    if (!PRED_PUBLIC && who !== 'dennis' && !(await predAcc()).includes(who)) return forbidden('Predictions is invite-only for now - ask Dennis for access.');
    let A = {}; try { A = JSON.parse((await env.RATEBOARD_KV.get('pred_ualert_v1')) || '{}') || {}; } catch (e) {}
    const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
    if (request.method === 'POST') {
      if (!(await allow(url.origin, 'predalerts:' + who, 40, 600))) return json({ error: 'Too many saves - wait a minute.' }, 429);
      let b = {}; try { b = await request.json(); } catch (e) {}
      if (b.test) { const n = await pushTo(env, db, who, { title: 'Test · Predictions alerts', body: 'Alerts reach this device.', url: '/predictions', tag: 'pu-test' });
        return json({ ok: true, sent: n }); }
      const c = b.cfg || {};
      A[who] = { enabled: !!c.enabled, mode: c.mode === 'custom' ? 'custom' : 'simple', cap: Math.round(num(c.cap, 1, 20, 10)),
        ev: { on: !!(c.ev && c.ev.on), minEv: num(c.ev && c.ev.minEv, 0.02, 1, 0.10), minFair: num(c.ev && c.ev.minFair, 0, 0.95, 0.30) },
        add: { on: !!(c.add && c.add.on), minEv: num(c.add && c.add.minEv, 0.01, 1, 0.05) },
        sell: { on: !!(c.sell && c.sell.on), pts: num(c.sell && c.sell.pts, 1, 30, 5) },
        start: { on: !!(c.start && c.start.on) }, steady: { on: c.steady ? !!c.steady.on : true, minEv: num(c.steady && c.steady.minEv, 0.02, 1, 0.06) }, at: Date.now() };
      await env.RATEBOARD_KV.put('pred_ualert_v1', JSON.stringify(A));
    }
    const dv = await db.prepare(PUSH_DDL).run().then(() => db.prepare('SELECT COUNT(*) AS n FROM push_subs WHERE key=?').bind(who).first()).catch(() => null);
    return json({ cfg: A[who] || null, devices: Number(dv && dv.n) || 0 });
  }
  /* The last Predictions alert sent to this member (2026-11-18): when a tapped notification only brings the
     app forward (iOS), the page asks for it and opens that game. */
  /* Test alert (2026-11-18): a real-looking value alert for an open pregame game, sent through the same path,
     so a tap can be checked any time. Signed-in members with Predictions alerts only. */
  if (op === 'predtestalert' && request.method === 'POST') {
    const who = String(acc.who || '').toLowerCase(); if (!who || (who !== 'dennis' && !predPortTok(env, who))) return forbidden('Not open yet.');
    if (!(await allow(url.origin, 'predtest:' + who, 6, 600))) return json({ error: 'A few tests is plenty - try again in a few minutes.' }, 429);
    let x = {}; try { x = JSON.parse((await env.RATEBOARD_KV.get('pred_ev_v1')) || '{}') || {}; } catch (e) {}
    const g = (x.games || []).find(y => !y.locked && !y.live && y.sides && y.sides.length) || (x.games || []).find(y => !y.locked && y.sides && y.sides.length);
    if (!g) return json({ error: 'No open market to test with right now.' });
    const sd = g.sides[0], q = Math.round((Number(sd.price) || 0.5) * 100), u = `/predictions#g=${g.id}&s=0&a=500&q=${q}`, now = Date.now();
    const n = await pushTo(env, db, who, { title: `Test alert · ${sd.name || sd.label}`, body: `Tap me - this should open ${g.game} with the bet on top.`, url: u, tag: 'pv-test', urgent: true });
    try { await env.RATEBOARD_KV.put('pred_lastalert_' + who, JSON.stringify({ url: u, at: now }), { expirationTtl: 3600 }); } catch (e) {}
    return json({ ok: true, sent: n });
  }
  /* Fantasy optimizer data (2026-11-18): Dennis only. Opening the page also keeps the prop pulls running (3 h). */
  if (op === 'dfs') {
    if (String(acc.who || '').toLowerCase() !== 'dennis') return forbidden('Not open yet.');
    let pulled = null; if (request.method === 'POST') pulled = await dfsPull(env);
    let o = {}; try { o = JSON.parse((await env.RATEBOARD_KV.get('dfs_props_v1')) || '{}') || {}; } catch (e) {}
    const day = ET_DAY_FMT.format(new Date());
    return json({ at: Date.now(), pulled, lastPull: o.lastPull || null, events: o.events || [], ev: o.ev || {}, usedToday: (o.used || {})[day] || 0, budget: 30000, credits: o.credits || null, errs: o.errs || [] });
  }
  /* Notification taps (2026-11-20). POST from the notification helper (no sign-in there - the id is the secret):
     the tap is noted for that member. GET from a page coming back on screen: the tap from the last 90 s, once. */
  if (op === 'navtap') {
    const kv = env.RATEBOARD_KV, log = async ev => { try { const l = JSON.parse((await kv.get('navdiag')) || '[]'); l.push([Date.now(), ev]); await kv.put('navdiag', JSON.stringify(l.slice(-30)), { expirationTtl: 86400 }); } catch (e) {} };
    if (request.method === 'POST') { let b = {}; try { b = await request.json(); } catch (e) {}
      const nid = String(b.nid || '').replace(/[^a-f0-9]/g, '').slice(0, 12); if (!nid) { await log('tap-noid'); return json({}); }
      if (b.how === 'recv') { await log('recv'); return json({ ok: true }); }
      let p = null; try { p = JSON.parse((await kv.get('navpend_' + nid)) || 'null'); } catch (e) {}
      if (!p) { await log('tap-unknown'); return json({}); }
      await kv.put('navtap_' + p.who, JSON.stringify({ url: p.url, at: Date.now(), nid }), { expirationTtl: 300 });
      await log('tap ' + (b.how || '') + ' c' + (b.n ?? '?')); return json({ ok: true }); }
    const who = String(acc.who || '').toLowerCase(); if (!who) return json({});
    let x = null; try { x = JSON.parse((await env.RATEBOARD_KV.get('navtap_' + who)) || 'null'); } catch (e) {}
    if (x && Date.now() - x.at <= 90000) { await env.RATEBOARD_KV.delete('navtap_' + who); await env.RATEBOARD_KV.delete('navsent_' + who); await log('served-tap'); return json(x); }
    /* No tap reached us: the app coming back within 2.5 minutes of a notification goes to it - on iPhone the tap
       handler doesn't run when the app was in the background (2026-11-20 tests). Once per notification. */
    let s2 = null; try { s2 = JSON.parse((await env.RATEBOARD_KV.get('navsent_' + who)) || 'null'); } catch (e) {}
    if (s2 && Date.now() - s2.at <= 150000) { await env.RATEBOARD_KV.delete('navsent_' + who); await log('served-recent'); return json(s2); }
    return json({});
  }
  if (op === 'lastalert') {
    const who = String(acc.who || '').toLowerCase(); if (!who) return json({});
    let x = null; try { x = JSON.parse((await env.RATEBOARD_KV.get('pred_lastalert_' + who)) || 'null'); } catch (e) {}
    return json(x && Date.now() - x.at < 5 * 60000 ? x : {});
  }
  /* A member's rax and unit size, kept on the server so the site and the home-screen app
     (separate browser storage) agree (member report 2026-11-18). */
  if (op === 'predme') {
    const who = String(acc.who || '').toLowerCase(); if (!who) return json({ error: 'Sign in first.' }, 401);
    if (request.method !== 'POST') return json({ error: 'POST only.' }, 405);
    if (!(await allow(url.origin, 'predme:' + who, 60, 600))) return json({ error: 'Too many saves - wait a minute.' }, 429);
    let b = {}; try { b = await request.json(); } catch (e) {}
    const m = { bank: Math.max(0, Math.min(1e8, Math.round(Number(b.bank) || 0))), upct: [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4].includes(Number(b.upct)) ? Number(b.upct) : 1, at: Date.now() };
    await env.RATEBOARD_KV.put('pred_me_v1_' + who, JSON.stringify(m));
    return json({ ok: true, me: m });
  }
  // Dennis's value alerts settings (owner only): unit rax, on/off, the EV that counts as really good value.
  if (op === 'predcfg') {
    if (String(acc.who || '').toLowerCase() !== 'dennis') return forbidden('Not open yet.');
    let c = {}; try { c = JSON.parse((await env.RATEBOARD_KV.get('pred_owner_cfg')) || '{}') || {}; } catch (e) {}
    if (request.method === 'POST') { let b = {}; try { b = await request.json(); } catch (e) {}
      if (b.unit != null) c.unit = Math.max(0, Math.min(200000, Math.round(Number(b.unit) || 0)));
      if (b.alerts != null) c.alerts = !!b.alerts;
      if (b.minEv != null) c.minEv = Math.max(0.02, Math.min(0.5, Number(b.minEv) || 0.06));
      await env.RATEBOARD_KV.put('pred_owner_cfg', JSON.stringify(c)); }
    return json({ cfg: c });
  }
  if (op === 'predbuild') {
    const who = String(acc.who || '').toLowerCase();
    if (who !== 'dennis') return forbidden('Not open yet.');
    const K = 'pred_build_v1_' + who; let l = []; try { l = JSON.parse((await env.RATEBOARD_KV.get(K)) || '[]') || []; } catch (e) {}
    if (request.method === 'POST') { let b = {}; try { b = await request.json(); } catch (e) {}
      if (b.set) { const g = Number(b.set.gid), sd = Number(b.set.side), t = Math.max(0, Math.min(1e6, Number(b.set.target) || 0));
        l = l.filter(x => !(x.gid === g && x.side === sd)); if (g > 0 && t > 0) l.push({ gid: g, side: sd, target: Math.round(t), unit: Math.round(Number(b.set.unit) || 0), name: String(b.set.name || '').slice(0, 80), at: Date.now() }); }
      if (b.del) l = l.filter(x => !(x.gid === Number(b.del.gid) && x.side === Number(b.del.side)));
      l = l.slice(-60); await env.RATEBOARD_KV.put(K, JSON.stringify(l)); }
    return json({ plans: l });
  }
  if (op === 'predbets') {
    const who = String(acc.who || '').toLowerCase();
    if (!who) return json({ error: 'Sign in first.' }, 401);
    if (!PRED_PUBLIC && who !== 'dennis' && !(await predAcc()).includes(who)) return forbidden('Predictions is invite-only for now.');
    const K = 'pred_bets_v1_' + who; let l = []; try { l = JSON.parse((await env.RATEBOARD_KV.get(K)) || '[]') || []; } catch (e) {}
    if (request.method === 'POST') {
      let b = {}; try { b = await request.json(); } catch (e) {}
      const num = v => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : 0; };
      const str = v => String(v == null ? '' : v).slice(0, 120);
      if (b.add && typeof b.add === 'object') { const a = b.add;
        /* Stack, don't replace (Dennis, 2026-11-17): a second Bet placed on the same side adds to the open bet.
           Price becomes the one that pays the same total (amount / sum of each buy's amount / price). */
        const prev = Number(a.gid) > 0 ? l.find(x => x.gid === Number(a.gid) && x.side === Number(a.side) && !x.res) : null;
        if (prev && num(a.amt) > 0 && num(a.price) > 0) {
          const legs = prev.legs || [{ amt: prev.amt || 0, price: prev.price || 0, at: prev.at || 0 }];
          legs.push({ amt: num(a.amt), price: num(a.price), at: Date.now() });
          const amt = legs.reduce((t, x) => t + (x.amt || 0), 0), pays = legs.reduce((t, x) => t + (x.price > 0 ? x.amt / x.price : 0), 0);
          const w = (k, v) => ((prev[k] || 0) * (prev.amt || 0) + (Number(v) || 0) * num(a.amt)) / Math.max(1, amt);
          prev.fair = Math.round(w('fair', a.fair) * 1e4) / 1e4; prev.ev = Math.round(w('ev', a.ev) * 1e4) / 1e4;
          prev.u = Math.round(((prev.u || 0) + num(a.u)) * 100) / 100; prev.amt = Math.round(amt * 100) / 100; prev.price = pays > 0 ? Math.round(amt / pays * 1e4) / 1e4 : prev.price;
          if (prev.pay != null) prev.pay = Math.round((prev.pay + num(a.amt) / num(a.price)) * 100) / 100;
          prev.legs = legs.slice(-40);
          await env.RATEBOARD_KV.put(K, JSON.stringify(l.slice(0, 300)));
          return json({ bets: l.slice(0, 300), stacked: true });
        }
        if (Number(a.gid) > 0) l = l.filter(x => !(x.gid === Number(a.gid) && x.side === Number(a.side)));
        l.unshift({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), gid: Number(a.gid) || 0, side: Number(a.side) || 0, sport: str(a.sport), game: str(a.game), name: str(a.name),
          price: num(a.price), fair: num(a.fair), ev: Number(a.ev) || 0, u: num(a.u), amt: num(a.amt), teams: Array.isArray(a.teams) ? a.teams.slice(0, 3).map(str) : [], start: str(a.start), custom: !!a.custom, logo: /^https:\/\/a\.espncdn\.com\//.test(String(a.logo || '')) ? String(a.logo).slice(0, 300) : '', link: /^https:\/\/www\.realapp\.com\//.test(String(a.link || '')) ? str(a.link) : '', at: Date.now() }); }
      if (b.set && typeof b.set === 'object') { const x = l.find(y => y.id === b.set.id); if (x) { if (b.set.pay !== undefined) { if (b.set.pay === null || b.set.pay === '') delete x.pay; else x.pay = num(b.set.pay); } if (b.set.res != null) x.auto = false; if (b.set.amt != null) x.amt = num(b.set.amt); if (b.set.price != null) x.price = num(b.set.price); if (b.set.res != null) x.res = ['won', 'lost', ''].includes(b.set.res) ? b.set.res : ''; } }
      if (b.del) l = l.filter(x => x.id !== String(b.del));
      l = l.slice(0, 300); await env.RATEBOARD_KV.put(K, JSON.stringify(l));
    }
    /* Won or lost filled in automatically (unless you set it yourself): from Real's own result when we
       saw the market settle, else from ESPN's final score once the game is over (Real drops settled
       markets from its list, so ESPN is the usual route). */
    try { const S = JSON.parse((await env.RATEBOARD_KV.get('pred_settled_v1')) || '{}') || {}; let ch = false;
      const ESPN = { nhl: 'hockey/nhl', nba: 'basketball/nba', nfl: 'football/nfl', ncaaf: 'football/college-football', ncaam: 'basketball/mens-college-basketball', ufc: 'mma/ufc' };
      const nt = t => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
      const same = (a, b) => { a = nt(a); b = nt(b); return !!a && !!b && (a === b || a.endsWith(' ' + b) || b.endsWith(' ' + a)); };
      const boards = {};
      // Bets saved before teams were stored: fill them from the live market list while it's still open.
      let cur = null; for (const x of l) if (!x.res && !(x.teams || []).length) { if (!cur) { try { cur = JSON.parse((await env.RATEBOARD_KV.get('pred_ev_v1')) || '{}') || {}; } catch (e) { cur = {}; } }
        const g = (cur.games || []).find(y => y.id === x.gid); if (g) { x.teams = g.sides.map(y => y.name || y.label); x.start = g.start || x.start || new Date(x.at - 3600000).toISOString(); ch = true; } }
      for (const x of l) {
        if (x.res || x.auto === false) continue;
        const r = S[x.gid]; if (r) { x.res = r.w === x.side ? 'won' : 'lost'; x.auto = true; ch = true; continue; }
        const st = Date.parse(x.start || 0); if (!ESPN[x.sport] || !Array.isArray(x.teams) || !Number.isFinite(st) || Date.now() - st < 2 * 3600000 || Date.now() - st > 4 * 86400000) continue;
        const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(st)).replace(/-/g, ''), bk = `${x.sport}_${day}`;
        if (!(bk in boards)) { const ck = 'pred_espn_' + bk; let d = null; try { d = JSON.parse((await env.RATEBOARD_KV.get(ck)) || 'null'); } catch (e) {}
          if (!d) { try { const rr = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${ESPN[x.sport]}/scoreboard?dates=${day}${x.sport === 'ncaaf' ? '&groups=80&limit=300' : x.sport === 'ncaam' ? '&groups=50&limit=400' : ''}`); const j = rr.ok ? await rr.json() : null;
              d = ((j && j.events) || []).map(ev => { const c = (ev.competitions || [])[0] || {}; return { done: !!(c.status && c.status.type && c.status.type.completed) || !!(ev.status && ev.status.type && ev.status.type.completed), t: (c.competitors || []).map(k => ({ n: [k.team && k.team.displayName, k.team && k.team.shortDisplayName, k.athlete && k.athlete.displayName].filter(Boolean), w: !!k.winner })) }; });
              await env.RATEBOARD_KV.put(ck, JSON.stringify(d), { expirationTtl: 600 }); } catch (e) { d = []; } }
          boards[bk] = d; }
        const ev = (boards[bk] || []).find(e => e.done && x.teams.filter(t => !/^(draw|tie)$/i.test(t)).every(t => e.t.some(k => k.n.some(n => same(n, t)))));
        if (!ev) continue;
        const me = x.teams[x.side], win = ev.t.find(k => k.w);
        x.res = /^(draw|tie)$/i.test(me) ? (win ? 'lost' : 'won') : (win && win.n.some(n => same(n, me)) ? 'won' : 'lost'); x.auto = true; ch = true;
      }
      if (ch) await env.RATEBOARD_KV.put(K, JSON.stringify(l)); } catch (e) {}
    return json({ bets: l });
  }
  /* Predictions feedback (Dennis, 2026-11-16): members with access send an issue or an idea from the
     Predictions page; Dennis reads and answers them there, not in Admin. A reply also lands on the
     member's Notifications page. KV list, newest first, at most 500. */
  if (op === 'predfb') {
    const who = String(acc.who || '').toLowerCase();
    if (!who) return json({ error: 'Sign in first.' }, 401);
    const owner = who === 'dennis';
    if (!PRED_PUBLIC && !owner && !(await predAcc()).includes(who)) return forbidden('Predictions is invite-only for now.');
    const K = 'pred_fb_v1'; let l = []; try { l = JSON.parse((await env.RATEBOARD_KV.get(K)) || '[]') || []; } catch (e) {}
    if (request.method === 'POST') {
      let b = {}; try { b = await request.json(); } catch (e) {}
      const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
      if (b.add) {
        if (!owner && !(await allow(url.origin, 'predfb:' + who, 10, 3600))) return json({ error: 'That is a lot of sends - try again later.' }, 429);
        const title = str(b.add.title, 140); if (title.length < 4) return json({ error: 'Give it a line I can read at a glance.' }, 400); if (str(b.add.detail, 1500).length < 10) return json({ error: 'Add some detail - what you saw and when.' }, 400);
        l.unshift({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), by: who, kind: ['issue', 'idea', 'odds'].includes(b.add.kind) ? b.add.kind : 'idea', title, detail: str(b.add.detail, 1500), game: str(b.add.game, 120), at: Date.now(), status: 'open', replies: [] });
      }
      if (owner && b.reply) { const x = l.find(y => y.id === b.reply.id); const t = str(b.reply.text, 1000);
        if (x && t) { x.replies = (x.replies || []).concat({ at: Date.now(), text: t }); await addNote(db, x.by, 'reply', `Predictions - "${x.title}": ${t}`); } }
      if (owner && b.status) { const x = l.find(y => y.id === b.status.id); if (x && ['open', 'planned', 'done', 'declined'].includes(b.status.s)) { x.status = b.status.s;
        if (b.status.s !== 'open') await addNote(db, x.by, 'reply', `Predictions - "${x.title}" is now marked ${b.status.s}.`); } }
      if (b.del) l = l.filter(y => y.id !== String(b.del) || (!owner && y.by !== who));
      l = l.slice(0, 500); await env.RATEBOARD_KV.put(K, JSON.stringify(l));
    }
    return json({ owner: owner || undefined, items: owner ? l : l.filter(y => y.by === who) });
  }
  if (op === 'predev') {
    const who = String(acc.who || '').toLowerCase();
    /* Signed out (2026-11-27, for AdSense): the same games and EV everyone sees, nothing account-specific and no
       credit counts. Built at most once a minute; limited per address. */
    if (!who) {
      if (!(await allow(url.origin, 'pub:predev:' + (request.headers.get('cf-connecting-ip') || ''), 60, 60))) return json({ error: 'Too many loads - wait a minute.' }, 429);
      if (!PRED_PUB_MEMO.text || Date.now() - PRED_PUB_MEMO.at > 60000) { let x = null; try { x = JSON.parse((await env.RATEBOARD_KV.get('pred_ev_v1')) || 'null'); } catch (e) {}
        let gx = null; try { gx = JSON.parse((await env.RATEBOARD_KV.get('pred_gamextra_v1')) || 'null'); } catch (e) {}
        PRED_PUB_MEMO.text = JSON.stringify({ public: true, gx, at: x ? x.at : null, games: x ? x.games || [] : [] }); PRED_PUB_MEMO.at = Date.now(); }
      return new Response(PRED_PUB_MEMO.text, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    }
    if (!PRED_PUBLIC && who !== 'dennis' && !(await predAcc()).includes(who)) return forbidden('Predictions is invite-only for now - ask Dennis for access.');
    let x = null; try { x = JSON.parse((await env.RATEBOARD_KV.get('pred_ev_v1')) || 'null'); } catch (e) {}
    const owner = who === 'dennis' || undefined, port = !!predPortTok(env, who) || undefined;
    let me; try { me = JSON.parse((await env.RATEBOARD_KV.get('pred_me_v1_' + who)) || 'null') || undefined; } catch (e) {}
    let slipFit = null; try { slipFit = JSON.parse((await env.RATEBOARD_KV.get('pred_slipfit_v1')) || 'null'); } catch (e) {}
    let gx = null; try { gx = JSON.parse((await env.RATEBOARD_KV.get('pred_gamextra_v1')) || 'null'); } catch (e) {}   // 3-hour averages and team history (2026-11-23)
    return json(x ? { owner, port, me, slipFit, gx, at: x.at, games: x.games || [], credits: x.credits || null, used: x.used || null, errs: x.errs || [], keySet: !!env.ODDS_API_KEY } : { owner, port, me, at: null, games: [], keySet: !!env.ODDS_API_KEY });
  }
  // Bulk ratings (Dennis only, 2026-11-15): live listings, every ended one (history), his passes, and pack plays.
  /* Bulk ratings (open to everyone, 2026-11-15): live listings, ended ones (history),
     pack data for Grind, and the viewer's own passes. The shared part is built at most
     every 3 minutes per server process and kept as text, so a crowd costs one build. */
  // Player alerts (see bulkWatchTick): list / add / change / remove. Anyone signed in.
  if (op === 'bulkwatch') {
    const who = String(acc.who || '').toLowerCase(); if (!who) return json({ error: 'Sign in first.' }, 401);
    await db.prepare(BW_DDL).run();
    if (request.method === 'POST') { let b = {}; try { b = await request.json(); } catch (e) {}
      if (b.del) await db.prepare('DELETE FROM bulk_watch WHERE id=? AND who=?').bind(String(b.del), who).run();
      const num = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : null; };
      if (b.add) { const a = b.add, sp = String(a.sport || '').toLowerCase(), se = num(a.season, 2000, 2100), pid = num(a.playerId, 1, 1e12), mx = num(a.maxRpr, 0.01, 1000), n = num(a.minN, 1, 50) || 1;
        if (!BW_SPN[sp] || !se || !pid || !mx) return json({ error: 'Pick a player and a rax per rating.' }, 400);
        const c = await db.prepare('SELECT COUNT(*) AS n FROM bulk_watch WHERE who=?').bind(who).first(); if (c && c.n >= 25) return json({ error: 'You can have 25 alerts - remove one first.' }, 400);
        const ex = await db.prepare('SELECT id FROM bulk_watch WHERE who=? AND sport=? AND season=? AND playerId=?').bind(who, sp, se, pid).first();
        if (ex) await db.prepare('UPDATE bulk_watch SET maxRpr=?, minN=?, told=NULL WHERE id=?').bind(mx, n, ex.id).run();
        else await db.prepare('INSERT INTO bulk_watch (id, who, sport, season, playerId, name, maxRpr, minN, at, told) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)').bind(crypto.randomUUID(), who, sp, se, pid, String(a.name || 'Player').slice(0, 80), mx, n, Date.now()).run(); }
      if (b.set) { const mx = num(b.set.maxRpr, 0.01, 1000), n = num(b.set.minN, 1, 50); if (mx || n) await db.prepare('UPDATE bulk_watch SET maxRpr=COALESCE(?, maxRpr), minN=COALESCE(?, minN), told=NULL WHERE id=? AND who=?').bind(mx, n, String(b.set.id), who).run(); } }
    const ws = ((await db.prepare('SELECT id, sport, season, playerId, name, maxRpr, minN, lastAt FROM bulk_watch WHERE who=? ORDER BY at DESC').bind(who).all()).results) || [];
    for (const w of ws) { const h = await bwMatches(db, w); w.now = h.length; w.cheapest = h[0] ? { price: Math.round(h[0].price), rating: Math.round(h[0].rating), rpr: Math.round(h[0].rpr * 100) / 100, rarity: h[0].rarity } : null; w.sp = BW_SPN[w.sport] || w.sport; }
    return json({ watches: ws });
  }
  // Players to pick for an alert: anyone sold or listed on Bulk lately.
  if (op === 'bulkplayers') {
    if (!acc.who) return json({ error: 'Sign in first.' }, 401);
    const q = String(url.searchParams.get('q') || '').trim().toLowerCase().replace(/[%_]/g, '').slice(0, 40); if (q.length < 2) return json({ players: [] });
    // Auction alerts (2026-11-27): anyone sold in 60 days or listed now, with the usual sold rate to help pick one.
    const like = '%' + q + '%', since = Date.now() - 60 * 86400000;
    const sold = ((await db.prepare("SELECT sport, season, playerId, MAX(name) AS name, COUNT(*) AS n, AVG(price / rating) AS rate FROM bulk_results WHERE LOWER(name) LIKE ? AND endsAt > ? AND price IS NOT NULL AND rating > 0 GROUP BY sport, season, playerId ORDER BY n DESC LIMIT 20").bind(like, since).all().catch(() => ({ results: [] }))).results) || [];
    const live = ((await db.prepare("SELECT sport, season, playerId, MAX(name) AS name, COUNT(*) AS live FROM bulk_listings WHERE LOWER(name) LIKE ? AND endsAt > ? GROUP BY sport, season, playerId LIMIT 20").bind(like, Date.now()).all().catch(() => ({ results: [] }))).results) || [];
    const M = new Map(); for (const r of sold) M.set(`${r.sport}:${r.season}:${r.playerId}`, { ...r, live: 0 });
    for (const r of live) { const k = `${r.sport}:${r.season}:${r.playerId}`; if (M.has(k)) M.get(k).live = r.live; else M.set(k, { ...r, n: 0, rate: null }); }
    const out = [...M.values()].sort((a, b) => (b.n + b.live) - (a.n + a.live)).slice(0, 15).map(r => ({ sport: r.sport, season: r.season, playerId: r.playerId, name: r.name, n: r.n, live: r.live, rate: r.rate ? Math.round(r.rate * 100) / 100 : null, sp: BW_SPN[r.sport] || r.sport }));
    return json({ players: out });
  }
  if (op === 'bulklist') {
    if (!(await allow(url.origin, 'bulk:' + clientIp(request), 20, 60))) return json({ error: 'Too many refreshes - wait a minute.' }, 429);
    const SPN = { nba: 'NBA', ncaam: 'CBB', nfl: 'NFL', ncaaf: 'CFB', nhl: 'NHL', mlb: 'MLB', wnba: 'WNBA', golf: 'Golf', soccer: 'FC', ufc: 'UFC' };
    if (!BULK_MEMO.text || Date.now() - BULK_MEMO.at > 90000) {
      if (!BULK_MEMO.building) BULK_MEMO.building = (async () => {
        let st = {}; try { st = JSON.parse((await env.RATEBOARD_KV.get('bulk_state_v2')) || '{}') || {}; } catch (e) {}
        let rows = [], ended = [];
        try { rows = ((await db.prepare('SELECT id, endsAt, sport, season, playerId, name, rarity, rating, buyNow, minBid, curBid, bids FROM bulk_listings WHERE endsAt > ? ORDER BY endsAt LIMIT 6000').bind(Date.now()).all()).results) || []; } catch (e) {}
        // Not seen on the last read of their stretch of the list: likely gone, waiting to be checked (2026-11-26).
        { const gq = new Set((st.goneQ || []).map(Number)); if (gq.size) rows = rows.filter(r => !gq.has(Number(r.id))); }
        try { ended = ((await db.prepare("SELECT id, endsAt, sport, season, playerId, name, rarity, rating, buyNow, price, bids, how FROM bulk_results WHERE endsAt > ? AND price IS NOT NULL ORDER BY endsAt DESC LIMIT 20000").bind(Date.now() - 60 * 86400000).all()).results) || []; } catch (e) {}
        let unsold = []; try { unsold = ((await db.prepare("SELECT sport, season, playerId, endsAt FROM bulk_results WHERE endsAt > ? AND price IS NULL LIMIT 30000").bind(Date.now() - 60 * 86400000).all()).results) || []; } catch (e) {}
        const fix = r => { for (const k of Object.keys(r)) if (r[k] == null) delete r[k]; return r; };   // links are made on the page; empty fields dropped (keeps it small)
        const plays = {}, keys = new Set(ended.concat(rows).filter(r => r.sport && r.season && r.playerId).map(r => `${r.sport}:${r.season}:${r.playerId}`));
        const ss = new Set([...keys].map(k => k.split(':').slice(0, 2).join(':')));
        for (const k0 of ss) { const [sp0, se0] = k0.split(':'); let m = null; try { m = await packInfo(env, db, sp0, se0); } catch (e) {}
          if (m) for (const k of keys) if (k.startsWith(k0 + ':')) { const id = k.split(':')[2]; if (m[id] != null) plays[k] = m[id]; } }
        const state = { count: st.count || null, lastAt: st.lastAt || null, fullDone: st.fullDone || null, err: st.err || null, pauseUntil: st.pauseUntil || null };
        const body = JSON.stringify({ state, rows: rows.map(fix), ended: ended.map(fix), unsold: unsold.map(u => [`${u.sport}:${u.season}:${u.playerId}`, Number(u.endsAt)]), plays });
        BULK_MEMO.text = body.slice(0, -1); BULK_MEMO.at = Date.now();
      })().finally(() => { BULK_MEMO.building = null; });
      if (!BULK_MEMO.text) await BULK_MEMO.building;
    }
    // The viewer's own passes (Rare and up), for "My passes".
    let mine = [];
    if (acc.who) { try { const u = await db.prepare('SELECT passes FROM swap_users WHERE key=?').bind(acc.who).first();
      mine = parse(u && u.passes, []).filter(p => p.kind !== 'team' && /rare|epic|legendary|mystic|iconic/i.test(p.levelLabel || '')).map(p => ({ key: p.key, name: p.name, sport: p.sport, sp: SPN[p.sport] || p.sport, season: p.season, playerId: p.id, rating: p.rating, label: p.levelLabel || null,
        url: p.passId ? `https://www.realapp.com/${routeId([18, 0, 0, Number(p.passId)])}` : null })); } catch (e) {} }
    /* Injured players (Dennis, 2026-11-16: Drake Maye is out long-term, so everyone sells him cheap and he
       kept showing as a deal): Out / IR / Doubtful / Suspension from ESPN and the hand list, by sport and
       name, read every 10 minutes. The page leaves their current-season passes off Best deals. */
    if (!BULK_MEMO.inj || Date.now() - BULK_MEMO.injAt > 10 * 60000) {
      const inj = {};
      for (const sp of ['nfl', 'ncaaf', 'nba', 'ncaam', 'nhl', 'mlb']) {
        let m = {}; try { m = Object.assign({}, (ESPN_PATH[sp] ? await boostInjuries(env, sp) : {}) || {}, await boostManualOut(env, sp)); } catch (e) {}
        for (const [k, v] of Object.entries(m)) { if (k.includes('|') || !v || !/^(out|injured reserve|ir|doubtful|suspen)/i.test(String(v.status || ''))) continue; inj[sp + '|' + k] = String(v.status) + (v.note ? ' - ' + String(v.note).slice(0, 60) : ''); }
      }
      BULK_MEMO.inj = JSON.stringify(inj); BULK_MEMO.injAt = Date.now();
    }
    return new Response(BULK_MEMO.text + `,"inj":${BULK_MEMO.inj},"signedIn":${acc.who ? 'true' : 'false'},"grind":${String(acc.who || '').toLowerCase() === 'dennis' ? 'true' : 'false'},"mine":${JSON.stringify(mine)}}`, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  }
  /* Push notifications (2026-11-16): the public key, turning a browser on or off, a test, and status. */
  if (op === 'pushkey') return json({ key: (await vapidKeys(env)).pub });
  if (op === 'pushprefs') {
    if (!acc.who) return json({ error: 'Sign in first.' }, 401);
    const who = String(acc.who).toLowerCase(); let p = await pushPrefs(env, who);
    if (request.method === 'POST') { let b = {}; try { b = await request.json(); } catch (e) {}
      // Settings only once notifications are on for at least one device (Dennis, 2026-11-17).
      await db.prepare(PUSH_DDL).run();
      const dv = await db.prepare('SELECT COUNT(*) AS n FROM push_subs WHERE key=?').bind(who).first();
      if (!(Number(dv && dv.n) > 0)) return json({ error: 'Turn on push notifications for this device first (top of this page).', prefs: p, sports: BOOST_PUSH_SP }, 400);
      const bool = v => v === true || v === false ? v : undefined, clean = {};
      const sw = b.swaps || {}; clean.swaps = { on: !!sw.on, warn: bool(sw.warn) ?? true, live: bool(sw.live) ?? true, confirm: bool(sw.confirm) ?? true, dmWarn: bool(sw.dmWarn) ?? true, dmLive: bool(sw.dmLive) ?? true, confirmLead: [0, 15, 30, 60, 120, 240].includes(Number(sw.confirmLead)) ? Number(sw.confirmLead) : 0 };
      const bo = b.boosts || {}, sps = {}; for (const k of Object.keys(BOOST_PUSH_SP)) { const x = (bo.sports || {})[k] || {}; const h = Math.max(0.25, Math.min(36, Number(x.hours) || 2)); sps[k] = { on: !!x.on, hours: Math.round(h * 4) / 4 }; }
      clean.boosts = { on: !!bo.on, sports: sps, all: !!bo.all, allHours: Math.round(Math.max(0.25, Math.min(36, Number(bo.allHours) || 2)) * 4) / 4 }; clean.notes = { on: (b.notes || {}).on !== false };
      // Bulk alerts: Dennis only for now (2026-11-19).
      if (who === 'dennis') { const bu = b.bulk || {}, n = v => { const x = Math.round(Number(v)); return Number.isFinite(x) && x >= 0 ? Math.min(x, 10000000) : null; };
        let mn = n(bu.min) ?? 0, mx = n(bu.max) ?? 0; if (!mx) mx = 10000000; if (mx < mn) [mn, mx] = [mx, mn];
        const SPK = ['nba', 'ncaam', 'nfl', 'ncaaf', 'nhl', 'mlb', 'wnba', 'golf', 'soccer', 'ufc'], RK = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mystic', 'iconic'];
        clean.bulk = { on: !!bu.on, min: mn, max: mx, cut: [10, 15, 20, 25, 30, 40, 50].includes(Number(bu.cut)) ? Number(bu.cut) : 25, price: 'buy',
          sports: (Array.isArray(bu.sports) ? bu.sports : []).filter(x => SPK.includes(x)), rarities: (Array.isArray(bu.rarities) ? bu.rarities : []).map(x => String(x).toLowerCase()).filter(x => RK.includes(x)) };
        try { const ix = new Set(JSON.parse((await env.RATEBOARD_KV.get('push_bulk_users_v1')) || '[]')); if (clean.bulk.on) ix.add(who); else ix.delete(who); await env.RATEBOARD_KV.put('push_bulk_users_v1', JSON.stringify([...ix])); } catch (e) {} }
      // OTD reminder (2026-11-27): a time of day (minutes after midnight, their time) and 2 or 3 claims.
      { const o = b.otd || {}, at = Math.round(Number(o.at)), tz = String(o.tz || 'America/New_York').slice(0, 60); let tzOk = true; try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch (e) { tzOk = false; }
        clean.otd = { on: !!o.on, at: Number.isFinite(at) && at >= 0 && at < 1440 ? at : 600, claims: Number(o.claims) === 2 ? 2 : 3, tz: tzOk ? tz : 'America/New_York' };
        try { const ix = new Set(JSON.parse((await env.RATEBOARD_KV.get('push_otd_users_v1')) || '[]')); if (clean.otd.on) ix.add(who); else ix.delete(who); await env.RATEBOARD_KV.put('push_otd_users_v1', JSON.stringify([...ix])); } catch (e) {} }
      if (who === 'dennis') { const o = b.owner || {}; clean.owner = { dmBulk: o.dmBulk !== false, dmEv: o.dmEv !== false }; }
      p = clean; await env.RATEBOARD_KV.put(PUSH_PREF(who), JSON.stringify(p));
      // Who has boost reminders on, so the minute job doesn't read every member.
      try { const ix = new Set(JSON.parse((await env.RATEBOARD_KV.get('push_boost_users_v1')) || '[]')); if (clean.boosts.on && Object.values(sps).some(x => x.on)) ix.add(who); else ix.delete(who); await env.RATEBOARD_KV.put('push_boost_users_v1', JSON.stringify([...ix])); } catch (e) {}
      try { const ix = new Set(JSON.parse((await env.RATEBOARD_KV.get('push_confirm_users_v1')) || '[]')); if (clean.swaps.on && clean.swaps.confirm && clean.swaps.confirmLead > 0) ix.add(who); else ix.delete(who); await env.RATEBOARD_KV.put('push_confirm_users_v1', JSON.stringify([...ix])); } catch (e) {} }
    return json({ prefs: p, sports: BOOST_PUSH_SP, bulk: who === 'dennis' });   // cheap new bulk listings (2026-11-20); bot DMs stay off
  }
  if (op === 'pushsub' || op === 'pushunsub' || op === 'pushtest' || op === 'pushstatus') {
    if (!acc.who) return json({ error: 'Sign in first.' }, 401);
    const who = String(acc.who).toLowerCase(); await db.prepare(PUSH_DDL).run();
    let b = {}; if (request.method === 'POST') { try { b = await request.json(); } catch (e) {} }
    if (op === 'pushsub') {
      const sub = b.sub || {}, ep = String(sub.endpoint || ''), k = sub.keys || {};
      if (!/^https:\/\//.test(ep) || !k.p256dh || !k.auth) return json({ error: 'That browser did not give a usable subscription.' }, 400);
      if (!(await allow(url.origin, 'pushsub:' + who, 20, 3600))) return json({ error: 'Too many tries - wait a bit.' }, 429);
      await db.prepare('INSERT INTO push_subs (endpoint, key, p256dh, auth, at, ua, fails) VALUES (?, ?, ?, ?, ?, ?, 0) ON CONFLICT(endpoint) DO UPDATE SET key=excluded.key, p256dh=excluded.p256dh, auth=excluded.auth, at=excluded.at, ua=excluded.ua, fails=0')
        .bind(ep.slice(0, 600), who, String(k.p256dh).slice(0, 200), String(k.auth).slice(0, 100), Date.now(), String(request.headers.get('user-agent') || '').slice(0, 160)).run();
    }
    if (op === 'pushunsub') await db.prepare('DELETE FROM push_subs WHERE endpoint=? AND key=?').bind(String(b.endpoint || ''), who).run();
    let sent = null;
    if (op === 'pushtest') { if (!(await allow(url.origin, 'pushtest:' + who, 6, 600))) return json({ error: 'A few tests is plenty - try again in a few minutes.' }, 429);
      sent = await pushTo(env, db, who, { title: 'Rax Academy', body: 'Notifications are working. You\'ll get swap alerts and replies here.', url: '/notifications', tag: 'test' }); }
    const n = await db.prepare('SELECT COUNT(*) AS n FROM push_subs WHERE key=?').bind(who).first();
    return json({ ok: true, devices: Number(n && n.n) || 0, sent });
  }
  if (op === 'notifs') {
    if (!acc.who) return forbidden('Sign in first (raxacademy.app).');
    const me0 = String(acc.who).toLowerCase(), out = { news: SITE_NEWS.map(([d, t]) => ({ ts: Date.parse(d + 'T20:00:00Z'), text: t })) };
    try { await db.prepare(NOTE_DDL).run(); out.notes = ((await db.prepare('SELECT ts, kind, text FROM user_notes WHERE key=? ORDER BY id DESC LIMIT 60').bind(me0).all()).results) || []; } catch (e) { out.notes = []; }
    const ST = { open: 'Waiting for review', auto: 'Counted by moderation', closed: 'Completed', declined: 'Denied', done: 'Completed', withdrawn: 'Taken back' };
    out.news = [];   // "What's new" hidden for now (Dennis, 2026-11-17)
    try { await db.prepare(SREPORT_DDL).run();
      out.reports = (((await db.prepare('SELECT rowid AS id, ts, kind, target, detail, status FROM swap_reports WHERE LOWER(by_user)=? ORDER BY ts DESC LIMIT 40').bind(me0).all()).results) || [])
        .map(r => ({ id: r.id, canTake: r.kind === 'user' && !['withdrawn', 'declined'].includes(r.status), ts: r.ts, about: r.target || null, what: r.kind === 'user' ? 'Swaps report' : r.kind === 'refund' ? 'Called-off swap' : r.kind === 'late' ? 'Late heads-up' : 'Swaps problem', detail: String(r.detail || '').slice(0, 200), status: ST[r.status] || r.status })); } catch (e) { out.reports = []; }
    try { const m = JSON.parse((await env.RATEBOARD_KV.get(BOARD_KV)) || '{}') || {};
      for (const r of (m.reports || []).filter(x => String(x.by || '').toLowerCase() === me0).slice(-20)) out.reports.push({ ts: r.ts, about: r.target || null, what: 'Board report', detail: String(r.reason || '').slice(0, 200), status: ST[r.status] || r.status }); } catch (e) {}
    out.reports.sort((a, b) => b.ts - a.ts);
    try { out.features = (((await db.prepare('SELECT ts, title, status FROM features WHERE LOWER(by_user)=? ORDER BY ts DESC LIMIT 40').bind(me0).all()).results) || []).map(r => ({ ts: r.ts, title: r.title, status: ST[r.status] || r.status })); } catch (e) { out.features = []; }
    try { out.mod = await modRecord(db, acc.who); } catch (e) { out.mod = null; }
    return json(out);
  }
  /* Take a report back (Dennis, 2026-11-17): it stops counting, and the warning or strike it gave for that
     swap is removed (moderation adds it again only if someone else's report still warrants it). The
     member it was about gets a note; Swaps comes back if they drop under the strike limit. */
  if (op === 'reporttakeback' && request.method === 'POST') {
    if (!acc.who) return forbidden('Sign in first (raxacademy.app).');
    const me0 = String(acc.who).toLowerCase(); let b = {}; try { b = await request.json(); } catch (e) {}
    await db.prepare(SREPORT_DDL).run();
    const r = await db.prepare("SELECT rowid AS id, ts, kind, target, matchId, m160, status FROM swap_reports WHERE rowid=? AND LOWER(by_user)=?").bind(Number(b.id), me0).first();
    if (!r || r.kind !== 'user') return json({ error: 'That report was not found.' }, 404);
    if (r.status === 'withdrawn') return json({ ok: true, already: true });
    await db.prepare("UPDATE swap_reports SET status='withdrawn' WHERE rowid=?").bind(r.id).run();
    let tgt = null, period = null;
    try {
      if (r.m160) { const x = await db.prepare('SELECT buyer, seller, dueAt FROM swap_160 WHERE id=?').bind(Number(r.m160)).first(); if (x) { tgt = String(x.buyer).toLowerCase() === me0 ? x.seller : x.buyer; period = Number(x.dueAt); } }
      else if (r.matchId) { const m = await db.prepare('SELECT * FROM swap_matches WHERE id=?').bind(Number(r.matchId)).first(); if (m) { tgt = String(m.a).toLowerCase() === me0 ? m.b : m.a; period = Number(sideDue(m)); } }
      else { const u = await db.prepare('SELECT key FROM swap_users WHERE LOWER(key)=? OR LOWER(rsUser)=?').bind(String(r.target || '').replace(/^@/, '').toLowerCase(), String(r.target || '').replace(/^@/, '').toLowerCase()).first();
        if (u) { tgt = u.key; await modReady(db); const e = await db.prepare('SELECT period FROM mod_events WHERE key=? AND period <= ? AND period >= ? ORDER BY period DESC LIMIT 1').bind(u.key, Number(r.ts) + MOD_EARLY, Number(r.ts) - MOD_LOOKBACK).first(); if (e) period = Number(e.period); } }
    } catch (e) {}
    let removed = null;
    if (tgt && period) {
      await modReady(db);
      const ev = await db.prepare('SELECT kind, n FROM mod_events WHERE key=? AND period=?').bind(tgt, period).first();
      if (ev) {
        await db.prepare('DELETE FROM mod_events WHERE key=? AND period=?').bind(tgt, period).run(); removed = ev.kind;
        const st = await db.prepare('SELECT banned, resetAt FROM mod_state WHERE key=?').bind(tgt).first();
        const left = await db.prepare("SELECT COUNT(*) AS n FROM mod_events WHERE key=? AND kind='strike' AND at >= ?").bind(tgt, Number((st && st.resetAt) || 0)).first();
        if (st && st.banned && Number((left && left.n) || 0) < MOD_STRIKES) { await db.prepare(SBLOCK_DDL).run(); await db.prepare('DELETE FROM swap_block WHERE key=?').bind(tgt).run(); await db.prepare('UPDATE mod_state SET banned=0 WHERE key=?').bind(tgt).run(); ACCESS_MEMO.delete(tgt); }
        await addNote(db, tgt, 'mod', `A report against you for the swap at ${modTime(period)} was taken back - that ${ev.kind === 'warn' ? 'warning' : 'strike'} is removed.`);
      }
    }
    return json({ ok: true, removed });
  }
  if (op === 'modme') {
    if (!acc.who) return forbidden('Sign in first (raxacademy.app).');
    return json(await modRecord(db, acc.who));
  }
  /* Appeal a warning or strike with evidence (member request, 2026-11-16). One per event. */
  if (op === 'modappeal' && request.method === 'POST') {
    if (!acc.who) return forbidden('Sign in first (raxacademy.app).');
    let b = {}; try { b = await request.json(); } catch (e) {}
    const text = String(b.text || '').trim().slice(0, 1500), period = Number(b.at);
    if (text.length < 15) return json({ error: 'Explain what happened, and add links to screenshots if you have them.' }, 400);
    const rec = await modRecord(db, acc.who), ev0 = rec.events.find(e => Number(e.at) === period);
    if (!ev0) return json({ error: 'That warning or strike was not found.' }, 404);
    if (ev0.appeal && ev0.appeal.status === 'open') return json({ error: 'You already appealed this one - it is waiting for Dennis.' }, 400);
    if (!(await allow(url.origin, 'modappeal:' + acc.who, 5, 86400))) return json({ error: 'Too many appeals - try again tomorrow.' }, 429);
    await db.prepare(APPEAL_DDL).run();
    await db.prepare('INSERT INTO mod_appeals (key, period, kind, n, text, ts, status) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(String(acc.who), period, ev0.kind, Number(ev0.n) || 0, text, Date.now(), 'open').run();
    return json({ ok: true, ...(await modRecord(db, acc.who)) });
  }
  if (op === 'unbanreq' && request.method === 'POST') {
    if (!acc.who) return forbidden('Sign in first (raxacademy.app).');
    let b = {}; try { b = await request.json(); } catch (e) {}
    const text = String(b.text || '').trim().slice(0, 1000);
    if (text.length < 10) return json({ error: 'Say why you should get Swaps back (a sentence or two).' }, 400);
    const rec = await modRecord(db, acc.who);
    if (!rec.banned) return json({ error: 'Your Swaps access is not removed.' }, 400);
    if (rec.request && rec.request.status === 'open') return json({ error: 'You already have a request waiting.' }, 400);
    if (!(await allow(url.origin, 'unbanreq:' + acc.who, 3, 86400))) return json({ error: 'Too many requests - try again tomorrow.' }, 429);
    await db.prepare("INSERT INTO unban_requests (key, text, ts, status) VALUES (?, ?, ?, 'open')").bind(acc.who, text, Date.now()).run();
    return json({ ok: true, ...(await modRecord(db, acc.who)) });
  }
  if (op === 'procheck') return proCheck(env, db, url, acc);
  if (op === 'rnstatus' || op === 'rnstart' || op === 'rncheck') return renameFlow(env, db, url, acc, op, waitUntil);
  // Boosts (BETA) is open to every signed-in member; its calls say page=boosts.
  // Limited to Dennis (admins) while in beta: set BOOSTS_OPEN to open it to everyone signed in.
  const boostCall = BOOSTS_OPEN && url.searchParams.get('page') === 'boosts' && BOOST_OPS.has(op) && !!acc.who;
  // Pack data's rating calculator (open to everyone signed in): their passes and the site's one scan.
  const packCall = url.searchParams.get('page') === 'packs' && ['me', 'scan', 'scanstatus'].includes(op) && !!acc.who;
  /* Testers (2026-11-25): members Dennis added on the Testers page get what the OTD page needs, whatever else they
     have. Only looked up for those calls. */
  // OTD breakdown is public (2026-11-25): everything its page needs is open to every signed-in member.
  const testCall = !!acc.who && TEST_OTD_OPS.has(op);
  /* Open to signed-out visitors too (Dennis, 2026-11-27: "add whatever you want to pages without signing in" - for
     AdSense, which only sees what a visitor sees). Read-only, the same for everyone, limited per address. */
  const publicCall = !acc.who && PUBLIC_OPS.has(op);
  if (publicCall && !(await allow(url.origin, 'pub:' + op + ':' + (request.headers.get('cf-connecting-ip') || ''), 120, 60))) return json({ error: 'Too many loads - wait a minute.' }, 429);
  if (testCall || publicCall) { /* allowed */ }
  else if (!acc.ok && !boostCall && !packCall && !publicCall) return forbidden(acc.who ? 'Your account does not have this page yet.' : 'Sign in first (raxacademy.app).');
  if (!testCall && !publicCall && !acc.admin && !boostCall && !packCall && !((acc.swaps && MEMBER_OPS.has(op)) || (acc.otd && OTD_OPS.has(op)))) return forbidden('Your account does not have this.');
  const me = acc.who;
  if (op === 'tagview') return tagViewOp(env, db, url, acc, waitUntil);
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
    try { await env.RATEBOARD_KV.delete('swap_wantcounts_v3'); } catch (e) {}
    let res = { n: 0, late: 0 }; try { res = await afterCallOff(env, db, auth, me, await cancelDropped(db, me, new Set(wants), new Set(parse(r.slots, [])), parse(r.sched, null))); } catch (e) {}
    return json({ ok: true, wants, calledOff: res.n, late: res.late });
  }
  /* Hours save the moment they're ticked or unticked (Dennis, 2026-11-04: an
     unticked hour that was never saved still got swaps). Unticking one calls
     off its swaps still to come, under the same late-change rule. */
  /* Picks save as they're made (Dennis, 2026-11-27: "when you check a player it saves on all your devices") - only
     the players picked, so it never turns a paused swap back on. Same checks as Save my swap. */
  if (op === 'savewants' && request.method === 'POST') {
    let b = {}; try { b = await request.json(); } catch (e) {}
    const wants = [...new Set((Array.isArray(b.wants) ? b.wants : []).map(String).filter(k => /^[a-z]+:\d{4}:t?\d+$/.test(k)))].slice(0, MAX_WANTS);
    const r = await db.prepare('SELECT passes, wants, slots, sched FROM swap_users WHERE key=?').bind(me).first();
    if (!r) return json({ error: 'Scan your passes first.' }, 400);
    const owned = new Set(parse(r.passes, []).filter(p => p.kind !== 'team').map(p => p.key));
    if (wants.some(w => !owned.has(w))) return json({ error: 'You can only swap for passes you own - scan your passes, then pick from them.' }, 400);
    if (wants.some(w => seasonOff(w))) return json({ error: '2026-27 CBB and NBA passes can\'t be swapped yet.' }, 400);
    { const low = await lowPlays(env, db, wants, null, me); if (low.size) return json({ error: `Only players with ${MIN_PLAYS}+ collectible plays can be swapped for.`, low: [...low] }, 400); }
    await db.prepare('UPDATE swap_users SET wants=?, updatedAt=? WHERE key=?').bind(JSON.stringify(wants), Date.now(), me).run();
    try { await env.RATEBOARD_KV.delete('swap_wantcounts_v3'); } catch (e) {}
    let res = { n: 0, late: 0 }; try { res = await afterCallOff(env, db, auth, me, await cancelDropped(db, me, new Set(wants), new Set(parse(r.slots, [])), parse(r.sched, null))); } catch (e) {}
    return json({ ok: true, wants, calledOff: res.n, late: res.late });
  }
  if (op === 'saveslots' && request.method === 'POST') {
    let b = {}; try { b = await request.json(); } catch (e) {}
    const sched = cleanSched(b.sched);
    const slots = schedUtc(sched) || [...new Set((Array.isArray(b.slots) ? b.slots : []).map(Number).filter(h => Number.isInteger(h) && h >= 0 && h < 24))].slice(0, MAX_SLOTS);
    await matchCols(db);
    const r = await db.prepare('SELECT wants, slots, sched FROM swap_users WHERE key=?').bind(me).first();
    if (!r) return json({ ok: true, slots, calledOff: 0, late: 0 });
    await db.prepare('UPDATE swap_users SET slots=?, sched=?, updatedAt=? WHERE key=?').bind(JSON.stringify(slots), JSON.stringify(sched), Date.now(), me).run();
    let confirmed = false; try { confirmed = await autoConfirm(db, me, r, { slots, sched }); } catch (e) {}
    try { await env.RATEBOARD_KV.delete('swap_hourcounts_v3'); } catch (e) {}
    let res = { n: 0, late: 0 }; try { res = await afterCallOff(env, db, auth, me, await cancelDropped(db, me, new Set(parse(r.wants, [])), new Set(slots), sched)); } catch (e) {}
    return json({ ok: true, slots, sched, calledOff: res.n, late: res.late, confirmed: confirmed || undefined, day: confirmed ? confirmDayNow() : undefined });
  }
  /* Pause: no new matches until they save again; swaps already set keep going.
     End all: paused, and every swap still to come is called off too. */
  if ((op === 'pause' || op === 'endall') && request.method === 'POST') {
    await matchCols(db);
    await db.prepare('UPDATE swap_users SET active=0, updatedAt=? WHERE key=?').bind(Date.now(), me).run();
    try { await env.RATEBOARD_KV.delete('swap_hourcounts_v3'); await env.RATEBOARD_KV.delete('swap_wantcounts_v3'); } catch (e) {}
    let res = { n: 0, late: 0, soon: 0 };
    // Paused: no new matches, and their 160s and niche buys not yet messaged are called off too (2026-11-10).
    if (op === 'pause') { try { const c = await db.prepare(`UPDATE swap_160 SET status='cancelled', note=? WHERE status='pending' AND warnS IS NULL AND warnB IS NULL AND (buyer=? OR seller=?)`).bind(`called off: @${me} paused`, me, me).run(); res.n += (c && c.meta && c.meta.changes) || 0; } catch (e) {} }
    /* Pause calls off upcoming swaps not yet messaged too (Dennis, 2026-11-11:
       members paused before a swap and still got its DMs, since Pause only
       stopped NEW matches). Swaps already messaged (or under 35 min away) still go ahead. */
    {
      const rows = ((await db.prepare(`SELECT * FROM swap_matches WHERE status IN ('pending','warned') AND (a=? OR b=?)`).bind(me, me).all()).results) || [];
      for (const m of rows) await callOff(db, m, `called off: @${me} ${op === 'pause' ? 'paused' : 'ended their swaps'}`, res);
      if (op === 'pause') { try { await afterCallOff(env, db, auth, me, res); } catch (e) {} }
    }
    if (op === 'endall') {
      try { await db.prepare(`UPDATE swap_160 SET status='cancelled', note=? WHERE status='pending' AND warnS IS NULL AND warnB IS NULL AND (buyer=? OR seller=?)`).bind(`called off: @${me} ended their swaps`, me, me).run(); } catch (e) {}
      try { await afterCallOff(env, db, auth, me, res); } catch (e) {}
    }
    return json({ ok: true, paused: true, calledOff: res.n, late: res.late });
  }

  /* A member's own swaps: coming up, and the last two weeks of past ones. */
  /* Packs today (see packsToday): signed in on /swaps. */
  /* Step 3: recommended buys for swaps (Dennis, 2026-11-05) - the most picked
     players this member doesn't hold, with at least 3 people swapping for
     each, top 10: buy one and you can be matched with all of them. */
  if (op === 'recbuys') {
    const c = await wantTop(env, db);
    const u = await db.prepare('SELECT passes FROM swap_users WHERE key=?').bind(me).first();
    const own = new Set(parse(u && u.passes, []).filter(p => p.kind !== 'team').map(p => p.key));
    const rows = c.rows.filter(x => x.n >= 3 && !own.has(x.key) && !/^(soccer|ufc):/.test(x.key) && !seasonOff(x.key)).slice(0, 10);
    return json({ members: c.members, rows, scanned: !!(u && u.passes) });
  }
  if (op === 'confirm' && request.method === 'POST') {
    await matchCols(db);
    let b = {}; try { b = await request.json(); } catch (e) {}
    const now = Date.now();
    if (now < CONFIRM_SHOW_AT) return json({ error: 'Confirming opens at 2:30am Alaska time on Saturday.' }, 400);
    const day = confirmDayNow(now), start = swapDayStart(now + 30 * 60000);
    const u = await db.prepare('SELECT key, slots, sched FROM swap_users WHERE key=?').bind(me).first();
    if (!u) return json({ error: 'Scan your passes first.' }, 400);
    // Keep their time zone (daily hours had none saved) so the 3am DM shows their own times.
    let sc = parse(u.sched, null) || { mode: 'daily' };
    if (b.tz && !sc.tz) { try { new Intl.DateTimeFormat('en-US', { timeZone: String(b.tz) }); sc = { ...sc, tz: String(b.tz).slice(0, 60) }; } catch (e) {} }
    await db.prepare('UPDATE swap_users SET confirmDay=?, sched=? WHERE key=?').bind(day, JSON.stringify(sc), me).run();
    await stat(db, 'confirm_tap');
    const hrs = hoursToday({ ...u, sched: sc }, start);
    return json({ ok: true, day, times: hrs, active: confirmOn(day) });
  }
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
    /* Swaps called off because someone ELSE didn't confirm are noise in a
       member's history (member request 2026-11-18): drop them. Ones called
       off for this member's own missed confirm stay, so they can see why. */
    const meNames = [me, mine && mine.rsUser].filter(Boolean).map(x => '@' + String(x).toLowerCase());
    const otherNoConf = (status, note) => status === 'cancelled' && /didn't confirm today/.test(String(note || ''))
      && !String(note).toLowerCase().split(/[\s,:]+/).some(w => meNames.includes(w));
    for (const m of rows) {
      if (otherNoConf(m.status, m.note)) continue;
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
    /* Their 160s and niche buys too (2026-11-10), bought or sold, last 14 days. */
    const s160 = [];
    try {
      const r1 = ((await db.prepare(`SELECT id, buyer, seller, pass, dueAt, createdAt, status, note, warnS, warnB, kind FROM swap_160 WHERE (buyer=? OR seller=?) AND createdAt > ? ORDER BY dueAt DESC LIMIT 150`)
        .bind(me, me, Date.now() - 14 * 86400000).all()).results) || [];
      const ok2 = [...new Set(r1.map(r => r.buyer === me ? r.seller : r.buyer).filter(k => !who.has(k)))];
      for (let i = 0; i < ok2.length; i += 90) { const part = ok2.slice(i, i + 90);
        for (const x of (((await db.prepare(`SELECT key, rsUser, hashId, comment FROM swap_users WHERE key IN (${part.map(() => '?').join(',')})`).bind(...part).all()).results) || [])) who.set(x.key, x); }
      const nameOf = new Map();
      for (const r of r1) {
        if (otherNoConf(r.status, r.note)) continue;
        const buy = r.buyer === me, ok = buy ? r.seller : r.buyer, o = who.get(ok), off = r.status === 'cancelled', due = Number(r.dueAt);
        let nm = mine ? playerName(mine, r.pass) : r.pass;
        if (/^Player \d/.test(nm)) { if (!nameOf.has(ok)) nameOf.set(ok, await loadMember(db, ok).catch(() => null)); const om = nameOf.get(ok); if (om) nm = playerName(om, r.pass); }
        const sent = buy ? r.warnB : r.warnS;
        s160.push({ id: 's' + r.id, kind: r.kind === 'niche' ? 'niche' : '160', role: buy ? 'buy' : 'sell', due, made: r.createdAt,
          partner: (o && o.rsUser) || null, partnerUrl: o ? profileUrl(o.rsUser, o.hashId) : null, player: nm, playerUrl: playerUrl(r.pass),
          state: off ? 'off' : sent ? 'warned' : 'scheduled', upcoming: !off && r.status === 'pending' && due > now - 3600000,
          note: off ? (r.note || 'called off') : null, hourUrl: hp.get(due) || `/hour?u=${encodeURIComponent(me)}&d=${due}&t=${await hourSig(env, me, due)}` });
      }
    } catch (e) {}
    return json({ swaps: out, s160, now });
  }

  if (op === 'whynot') {
    if (!(await allow(url.origin, 'whynot:' + me, 6, 600))) return json({ error: 'Wait a few minutes and try again.' }, 429);
    if (!(await allow(url.origin, 'whynot-all', 30, 60))) return json({ error: HIGH_VOL }, 429);
    /* Dennis can check any member (2026-11-27): ?user=name */
    let who = me; const asked = String(url.searchParams.get('user') || '').trim().toLowerCase().replace(/^@/, '');
    if (asked && acc.admin) { const r = await db.prepare('SELECT key FROM swap_users WHERE LOWER(key)=? OR LOWER(rsUser)=?').bind(asked, asked).first().catch(() => null);
      if (!r) return json({ why: ['No saved swap under ' + asked + '.'], ready: false }); who = r.key; }
    const w = await whyNotFull(db, env, who);
    if (confirmOn(confirmDayNow())) { const c = await db.prepare('SELECT confirmDay FROM swap_users WHERE key=?').bind(who).first().catch(() => null);
      if (c && c.confirmDay !== confirmDayNow()) w.why.push("Today's times are not confirmed - unconfirmed swaps are called off."); }
    return json({ who: who !== me ? who : undefined, why: w.why, ready: !w.why.length || w.free > 0, can: w.can, hour: w.hour, both: w.free });
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
  // Step 4: how many OTHER active swappers own each of the caller's passes (niche under 30).
  if (op === 'ownercounts') {
    if (!acc.admin && !(await allow(url.origin, 'ownercounts:' + me, 20, 600))) return json({ error: 'Wait a few minutes and try again.' }, 429);
    const c = await ownerCounts(env), out = {};
    const u = await db.prepare('SELECT passes FROM swap_users WHERE key=?').bind(me).first();
    const selfIn = (c.act || []).includes(me) ? 1 : 0;   // they're one of the owners counted when they've swapped this week
    for (const p of parse(u && u.passes, [])) if (p.kind !== 'team') out[p.key] = Math.max(0, (c.n[p.key] || 0) - selfIn);
    return json({ at: c.at, active: c.active, under: NICHE_UNDER, n: c.at ? out : {}, ready: !!c.at });
  }
  // Blacklist search (2026-11-11): swappers whose name starts with what's typed, as they type.
  /* Testers page (Dennis only, 2026-11-25): who can open each page still being built. GET lists them with Real names;
     ?q= finds members by site or Real name; POST {page, add} / {page, del} changes a list. */
  // The giveaway list (Dennis only): every member of group 60099 the bot has a chat with, and when they were messaged.
  if (op === 'grpdm') {
    if (String(me || '').toLowerCase() !== 'dennis') return forbidden('Only Dennis can open this.');
    try { await grpDmCols(db); } catch (e) {}
    if (request.method === 'POST') { const b = await request.json().catch(() => ({})); const u = String(b.user || '').slice(0, 60);
      if (u) await db.prepare('UPDATE grpdm_list SET heldAt = ? WHERE userName = ? AND sentAt IS NULL').bind(b.hold ? Date.now() : null, u).run(); }
    const rows = ((await db.prepare('SELECT userName, foundAt, sentAt, leftAt, checkedAt, heldAt FROM grpdm_list ORDER BY foundAt').all()).results) || [];
    return json({ rows, status: await grpDmStatus(env) });
  }
  if (op === 'testers') {
    if (String(me || '').toLowerCase() !== 'dennis') return forbidden('Only Dennis can open this.');
    const q = String(url.searchParams.get('q') || '').trim().toLowerCase().replace(/^@/, '').slice(0, 30);
    if (q) { const like = q.replace(/[%_]/g, '') + '%';
      const r = ((await db.prepare(`SELECT key, rsUser FROM swap_users WHERE LOWER(key) LIKE ? OR LOWER(rsUser) LIKE ? ORDER BY key LIMIT 10`).bind(like, like).all()).results) || [];
      return json({ users: r.filter(x => String(x.key).toLowerCase() !== 'dennis').map(x => ({ key: String(x.key).toLowerCase(), name: x.rsUser || x.key })) }); }
    const m = await testerMap(env);
    if (request.method === 'POST') { let b = {}; try { b = await request.json(); } catch (e) {}
      const pg = String(b.page || ''); if (!TESTER_PAGES[pg]) return json({ error: 'Unknown page.' }, 400);
      const add = String(b.add || '').trim().toLowerCase().slice(0, 60), del = String(b.del || '').trim().toLowerCase();
      let l = m[pg] || [];
      if (add) { const u = await db.prepare('SELECT key FROM swap_users WHERE LOWER(key)=?').bind(add).first(); if (!u) return json({ error: 'No member called ' + add + '.' }, 400); if (!l.includes(add)) l = l.concat(add); }
      if (del) l = l.filter(k => k !== del);
      m[pg] = l; await env.RATEBOARD_KV.put(TESTER_KV, JSON.stringify(m)); }
    const keys = [...new Set(Object.values(m).flat())], names = {};
    for (let i = 0; i < keys.length; i += 50) { const part = keys.slice(i, i + 50);
      for (const x of (((await db.prepare(`SELECT key, rsUser FROM swap_users WHERE LOWER(key) IN (${part.map(() => '?').join(',')})`).bind(...part).all()).results) || [])) names[String(x.key).toLowerCase()] = x.rsUser || x.key; }
    return json({ pages: Object.entries(TESTER_PAGES).map(([path, title]) => ({ path, title, href: TESTER_LINKS[path] || path, users: (m[path] || []).map(k => ({ key: k, name: names[k] || k })) })) });
  }
  if (op === 'usersearch') {
    const q = String(url.searchParams.get('q') || '').trim().toLowerCase().replace(/^@/, '').slice(0, 30);
    if (q.length < 1) return json({ users: [] });
    if (!acc.admin && !(await allow(url.origin, 'usersearch:' + me, 120, 60))) return json({ users: [] });
    const r = ((await db.prepare(`SELECT key, rsUser FROM swap_users WHERE key >= ? AND key < ? AND key <> ? ORDER BY key LIMIT 8`).bind(q, q + '\uffff', me).all()).results) || [];
    return json({ users: r.map(x => ({ key: x.key, name: x.rsUser || x.key })) });
  }
  if (op === 'wantcounts') {
    try { await db.prepare(VER_DDL).run(); } catch (e) {}
    let c = null; try { c = JSON.parse((await env.RATEBOARD_KV.get('swap_wantcounts_v3')) || 'null'); } catch (e) {}
    if (!c || Date.now() - c.at > 300000) {
      const n = {};
      for (const r of ((await db.prepare(`SELECT wants FROM swap_users WHERE active=1 AND wants IS NOT NULL AND wants <> '[]' AND hashId IN (SELECT v.hashId FROM swap_ver v JOIN swap_dm d ON d.hashId = v.hashId WHERE d.channelId IS NOT NULL)`).all()).results || []))
        { for (const w of parse(r.wants, []).slice(0, MAX_WANTS)) n[w] = (n[w] || 0) + 1; }
      c = { at: Date.now(), n };
      try { await env.RATEBOARD_KV.put('swap_wantcounts_v3', JSON.stringify(c)); } catch (e) {}
    }
    return json(c);
  }

  // How many saved swappers picked each hour (UTC), kept 5 minutes.
  // Counts only people verified with the bot (2026-11-27: after the switch to @rax.academy, not the old totals).
  if (op === 'hourcounts') {
    try { await db.prepare(VER_DDL).run(); } catch (e) {}
    let c = null; try { c = JSON.parse((await env.RATEBOARD_KV.get('swap_hourcounts_v3')) || 'null'); } catch (e) {}
    if (!c || Date.now() - c.at > 300000) {
      const n = Array(24).fill(0);
      for (const r of ((await db.prepare(`SELECT slots FROM swap_users WHERE active=1 AND slots IS NOT NULL AND slots <> '[]' AND hashId IN (SELECT v.hashId FROM swap_ver v JOIN swap_dm d ON d.hashId = v.hashId WHERE d.channelId IS NOT NULL)`).all()).results || []))
        for (const h of parse(r.slots, [])) if (h >= 0 && h < 24) n[h]++;
      c = { at: Date.now(), n };
      try { await env.RATEBOARD_KV.put('swap_hourcounts_v3', JSON.stringify(c)); } catch (e) {}
    }
    return json(c);
  }

  // Reports from the Swaps page: someone misusing swaps, or a problem with it.
  if (op === 'report' && request.method === 'POST') {
    let b = {}; try { b = await request.json(); } catch (e) {}
    if (me && await reportBlocked(env, me)) return json({ error: "Your ability to send reports has been removed." }, 403);
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
  if (op === 'automod') {   // the board's automatic moderation: what it did, and what it's watching
    if (!acc.admin) return forbidden('Admins only.');
    let log = []; try { log = JSON.parse((await env.RATEBOARD_KV.get(AM_LOG)) || '[]') || []; } catch (e) {}
    try { await db.prepare(AM_DDL).run(); } catch (e) {}
    const c = await db.prepare("SELECT COUNT(*) AS n, SUM(checkedAt > ?) AS day FROM board_cm").bind(Date.now() - 86400000).first().catch(() => null);
    const left = await db.prepare("SELECT COUNT(*) AS n FROM offers o LEFT JOIN board_cm c ON c.offerId=o.id WHERE o.link <> '' AND c.offerId IS NULL").first().catch(() => null);
    // Put a taken-down listing back (Dennis's call), and don't check it again for a day.
    if (request.method === 'POST') { const b = await request.json().catch(() => ({})), e = log.find(x => x.at === Number(b.at) && x.act === 'removed');
      if (!e) return json({ error: 'That one can\u2019t be put back.' }, 400);
      const nk = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\b(jr|sr|ii|iii|iv)\b/g, '').replace(/\s+/g, ' ').trim();
      const w = e.row || { id: 'am' + e.at, user: e.user, sport: e.sport, player: e.player, player_key: nk(e.player), rate: e.rate, link: e.link, ts: Date.now(), season: null }; await db.prepare('INSERT OR IGNORE INTO offers (id, user, sport, player, player_key, rate, link, ts, season) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(w.id, w.user, w.sport, w.player, w.player_key, w.rate, w.link, w.ts, w.season ?? null).run();
      await db.prepare('UPDATE board_cm SET checkedAt=? WHERE offerId=?').bind(Date.now() + 21 * 3600000, w.id).run().catch(() => {});
      e.act = 'restored'; await env.RATEBOARD_KV.put(AM_LOG, JSON.stringify(log)); return json({ ok: true }); }
    let sweep = null; try { sweep = JSON.parse((await env.RATEBOARD_KV.get('automod_sweep')) || 'null'); } catch (e) {}
    return json({ log: log.map(({ row, ...x }) => x), checked: c && c.n, checkedDay: c && c.day, unread: left && left.n, sweep });
  }
  if (op === 'inboxact' && request.method === 'POST') {
    let b = {}; try { b = await request.json(); } catch (e) {}
    const action = ['done', 'declined', 'delete', 'reply', 'replyabout', 'restrict', 'ban', 'refunded'].includes(b.action) ? b.action : null;
    if (!action) return json({ error: 'bad action' }, 400);
    const item = (await inboxItems(env, db, { src: b.src, id: b.id })).find(x => x.src === b.src && x.id === String(b.id));
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
  /* Why isn't a member getting swap DMs? (2026-11-18) Admin only: one look at everything that decides it. */
  if (op === 'dmdiag') {
    const n = String(url.searchParams.get('who') || '').trim().replace(/^@/, '').toLowerCase(); if (!n) return json({ error: 'Type a username.' }, 400);
    const w = await whoIs(db, n); if (!w || !w.key) return json({ error: 'No member with that name.' }, 404);
    const key = String(w.key).toLowerCase(), out = { key: w.key, rsUser: w.rsUser || null, verified: !!w.hashId, chat: !!w.channelId, active: w.swapper ? 1 : 0, banned: !!w.banned, restricted: !!w.restricted };
    try { await db.prepare(DM403_DDL).run(); const r = await db.prepare('SELECT n, first, last FROM dm_403 WHERE key=?').bind(key).first(); out.blocked = r || null; } catch (e) {}
    try { const pp = await pushPrefs(env, key); out.push = pp.swaps || null; } catch (e) {}
    try { await db.prepare(PUSH_DDL).run(); out.devices = Number(((await db.prepare('SELECT COUNT(*) AS n FROM push_subs WHERE key=?').bind(key).first()) || {}).n) || 0; } catch (e) {}
    try { await matchCols(db); out.swaps = (((await db.prepare(`SELECT id, a, b, dueAt, status, note, warnA, warnB, doneA, doneB FROM swap_matches WHERE (LOWER(a)=? OR LOWER(b)=?) AND COALESCE(dueAt, createdAt) > ? ORDER BY COALESCE(dueAt, createdAt) DESC LIMIT 12`)
      .bind(key, key, Date.now() - 3 * 86400000).all()).results) || []).map(m => { const s = String(m.a).toLowerCase() === key ? 'A' : 'B';
        return { id: m.id, due: m.dueAt, status: m.status, note: m.note || null, warned: m['warn' + s] || null, live: m['done' + s] || null }; }); } catch (e) { out.swapsErr = String(e.message || e).slice(0, 80); }
    try { await botTables(db); out.log = (((await db.prepare(`SELECT at, kind, msg FROM bot_log WHERE LOWER(msg) LIKE ? ORDER BY at DESC LIMIT 15`).bind('%' + String(w.rsUser || key).toLowerCase() + '%').all()).results) || []); } catch (e) {}
    try { const ys = await whyNotFull(db, env, w.key); out.why = ys.why || []; } catch (e) {}
    return json(out);
  }
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
  /* OTD view (Dennis, 2026-11-09): any players' games, held or not. With ids:
     those players of one sport-season. Without: the season's top players by
     rax (up to 300) - the pool "best players to add" picks from. Names from
     the search index. Reads the shared saved season (otdSeason), not the log. */
  if (op === 'otdpool') {
    if (!me) return forbidden('Sign in first.');
    const sp = String(url.searchParams.get('sport') || ''), se = Number(url.searchParams.get('season'));
    if (!/^[a-z]+$/.test(sp) || !(se > 2000)) return json({ error: 'Pick a sport and season.' }, 400);
    if (!acc.admin && !(await allow(url.origin, 'otdpool:' + me, 150, 600))) return json({ error: 'Too many loads - wait a few minutes.' }, 429);   // 150 (was 30): suggestions read ~35 seasons
    const games = await otdSeason(env, db, sp, se);
    const ids = String(url.searchParams.get('ids') || '').split(',').map(Number).filter(n => n > 0).slice(0, 80);
    const tot = id => (games[id] || []).reduce((a, g) => a + g[1], 0);
    const pick = ids.length ? ids : Object.keys(games).map(Number).sort((a, b) => tot(b) - tot(a)).slice(0, 300);
    const out = {}, names = {};
    for (const id of pick) if (games[id] && games[id].length) out[id] = games[id];
    try {
      const want = Object.keys(out).map(Number);
      for (let i = 0; i < want.length; i += 90) {
        const part = want.slice(i, i + 90);
        // From the game log, All-Star games left out (2026-11-25: the index's team was the All-Star side - LEB, GIA, WLD).
        const r = await db.prepare(`SELECT playerId, MAX(player) AS player, MAX(CASE WHEN seasonType = 'allstar' THEN NULL ELSE team END) AS team FROM gamelog WHERE sport=? AND season=? AND playerId IN (${part.map(() => '?').join(',')}) GROUP BY playerId`).bind(sp, se, ...part).all();
        for (const x of (r.results || [])) names[x.playerId] = [x.player, x.team];
      }
    } catch (e) {}
    return json({ sport: sp, season: se, games: out, names });
  }
  /* OTD optimiser: every game of every pass the member holds, as
     [MM-DD, rax] pairs, one query per sport-season. */
  /* OTD loadouts (Dennis, 2026-11-25): saved sets of players added on top of your scanned passes, each at a level you
     pick. Kept on the server so they're the same on every device. Dennis only for now. GET lists them; POST { loadouts }
     replaces the list (up to 30 loadouts, 80 added players each). */
  if (op === 'otdloadouts') {
    if (!me) return forbidden('Sign in first.');
    const K = 'otd_loadouts_v1_' + String(me).toLowerCase();
    if (request.method === 'POST') {
      let b = {}; try { b = await request.json(); } catch (e) {}
      const clean = (Array.isArray(b.loadouts) ? b.loadouts : []).slice(0, 30).map(l => ({
        id: String(l.id || '').replace(/[^a-z0-9]/gi, '').slice(0, 24) || Math.random().toString(36).slice(2, 10),
        name: String(l.name || 'Loadout').replace(/[<>]/g, '').slice(0, 40) || 'Loadout', at: Date.now(), base: l.base === 'none' ? 'none' : 'acct',
        adds: (Array.isArray(l.adds) ? l.adds : []).slice(0, 80).map(x => ({ sport: String(x.sport || '').replace(/[^a-z]/g, '').slice(0, 10), season: Number(x.season) || 0, id: Number(x.id) || 0,
          name: String(x.name || '').replace(/[<>]/g, '').slice(0, 60), team: String(x.team || '').replace(/[<>]/g, '').slice(0, 40), lv: Math.max(-1, Math.min(39, Number(x.lv) || 0)), up: !!x.up })).filter(x => x.sport && x.season > 2000 && x.id > 0) }));
      await env.RATEBOARD_KV.put(K, JSON.stringify(clean));
      return json({ ok: true, loadouts: clean });
    }
    let L = []; try { L = JSON.parse((await env.RATEBOARD_KV.get(K)) || '[]') || []; } catch (e) {}
    return json({ loadouts: L });
  }
  if (op === 'games') {
    const u = await db.prepare('SELECT passes FROM swap_users WHERE key=?').bind(me).first();
    const passes = parse(u && u.passes, []);
    const extra = String(url.searchParams.get('extra') || '');
    // Remember who opens OTD, so the background job keeps their copy built (see otdBackground).
    try { const L = JSON.parse((await env.RATEBOARD_KV.get('otd_users_v1')) || '{}') || {}; if (!L[String(me).toLowerCase()] || Date.now() - L[String(me).toLowerCase()] > 3600000) { L[String(me).toLowerCase()] = Date.now(); await env.RATEBOARD_KV.put('otd_users_v1', JSON.stringify(L)); } } catch (e) {}
    const r = await otdGamesFor(env, db, me, passes, extra, url.searchParams.get('fresh') === '1');
    return json({ passes, games: r.games, cachedAt: r.at || null, pending: r.pending || 0 });
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
    try { await db.prepare(VER_DDL).run(); } catch (e) {}
    touchSeen(env, me, waitUntil);
    // The member's row, whether the bot has a chat with them, and their Real name: one trip.
    try { await db.prepare(DM_DDL).run(); } catch (e) {}
    try { await alterOnce(db, 'ALTER TABLE users ADD COLUMN rsName TEXT'); } catch (e) {}
    let u = null, connected = false, realN = String(me);
    try {
      const [r1, r2, r3] = await db.batch([
        db.prepare('SELECT * FROM swap_users WHERE key=?').bind(me),
        db.prepare('SELECT 1 AS x FROM swap_ver v JOIN swap_dm d ON d.hashId = v.hashId WHERE v.hashId=(SELECT hashId FROM swap_users WHERE key=?) AND d.channelId IS NOT NULL').bind(me),
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
    const thinP = new Set();   // Dennis's 10-29 play players, marked on his page
    const lowP = u && !lite && url.searchParams.get('page') !== 'packs' ? await (async () => { try { return [...await lowPlays(env, db, parse(u.passes, []).filter(p => p.kind !== 'team').map(p => p.key), thinP, u.key)]; } catch (e) { return []; } })() : [];
    mark(request, 'plays');
    const cDay = confirmDayNow();
    let down = null; try { down = JSON.parse((await env.RATEBOARD_KV.get('swaps_down')) || 'null'); } catch (e) {}   // the "swaps are down" notice
    /* Names of the players they picked (2026-11-27: names only lived in the browser they were picked in, so Real's
       in-app browser showed "Player 17215"). From their passes, else the game log. */
    const wantNames = {};
    try { const ws = u ? parse(u.wants, []) : [], ps = u ? parse(u.passes, []) : [], byKey = new Map(ps.map(p => [p.key, p.name]));
      for (const k of ws.slice(0, 12)) { let nm = byKey.get(k); if (!nm || /^player$/i.test(nm)) { const [sp, se, id] = String(k).split(':');
          const r = await db.prepare('SELECT player FROM gamelog WHERE sport=? AND season=? AND playerId=? AND player IS NOT NULL LIMIT 1').bind(sp, Number(se), Number(id)).first().catch(() => null); nm = r && r.player; }
        if (nm) wantNames[k] = nm; } } catch (e) {}
    return json({ down: down && down.msg || null, wantNames, confirmShow: Date.now() >= CONFIRM_SHOW_AT, confirmedToday: !!(u && u.confirmDay === cDay), confirmStarts: CONFIRM_FROM_DAY, swapToday: cDay, key: me, tests: await testerPagesFor(env, me), admin: acc.admin, swaps: acc.swaps, otd: acc.otd, boostModes: acc.admin || BOOST_FAST.has(String(me || '').toLowerCase()), tokenFound: !!auth, connected, profile: u ? { rsUser: u.rsUser, hashId: u.hashId, wants: parse(u.wants, []),
      keep: parse(u.keep, []), touch: parse(u.touch, []), slots: parse(u.slots, []), sched: parse(u.sched, null), passes: lite ? [] : parse(u.passes, []),
      // Rax earned per sport and season, added up from the passes (Dennis, 2026-11-27: shown on Boosts for the current season).
      earnedBy: lite ? (() => { const o = {}; try { for (const p of parse(u.passes, [])) { const e = Number(p.earned); if (!Number.isFinite(e) || e <= 0) continue; const k = `${p.sport}:${p.season}`; o[k] = Math.round(((o[k] || 0) + e) * 10) / 10; } } catch (e) {} return o; })() : undefined,
      passCount: (() => { try { return parse(u.passes, []).length; } catch (e) { return 0; } })(), passSummary: lite ? passSummary(parse(u.passes, [])) : undefined, lowPlays: lowP, thinPlays: String(u && u.key || '').toLowerCase() === THIN_OWNER ? [...thinP] : undefined, scannedAt: u.scannedAt, active: !!u.active, comment: u.comment || '', goal: u.goal ?? null, dayCap: u.dayCap ?? null, caps: parse(u.caps, {}) || {}, b160: !!u.b160, s160: !!u.s160, only160: !!u.only160, nicheIn: !!u.nicheIn, niche: parse(u.niche, {}) || {}, nicheLim: nicheLim(u), blist: parse(u.blist, []) || [], lock1: parse(u.lock1, []) || [], noSp: Object.entries(parse(u.noSp, {}) || {}).filter(([, d]) => d === swapDay(Date.now())).map(([sp]) => sp), sell160m: u.sell160m || null, sell160h: parse(u.sell160h, []) } : null, real: realN });
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
  // Locks to the 1st pick, and sports maxed today (2026-11-11): saved as they're tapped.
  if (op === 'giveprefs' && request.method === 'POST') {
    let b = {}; try { b = await request.json(); } catch (e) {}
    try { await matchCols(db); } catch (e) {}
    const lock = (Array.isArray(b.lock1) ? b.lock1 : []).map(String).filter(k => /^[a-z]+:\d{4}:\d+$/.test(k)).slice(0, 500);
    const today = swapDay(Date.now()), noSp = {};
    for (const sp of (Array.isArray(b.noSp) ? b.noSp : []).map(String)) if (/^[a-z]+$/.test(sp)) noSp[sp] = today;
    await db.prepare('UPDATE swap_users SET lock1=?, noSp=? WHERE key=?').bind(JSON.stringify(lock), JSON.stringify(noSp), me).run();
    // Swaps not yet messaged that now break a rule are called off.
    let n = 0;
    try { for (const m of (((await db.prepare(`SELECT * FROM swap_matches WHERE status='pending' AND warnA IS NULL AND warnB IS NULL AND (a=? OR b=?)`).bind(me, me).all()).results) || [])) {
      const iGive = m.a === me ? m.bGets : m.aGets, iGet = m.a === me ? m.aGets : m.bGets;
      const w0 = (parse((await db.prepare('SELECT wants FROM swap_users WHERE key=?').bind(me).first() || {}).wants, []) || [])[0];
      const bad = (lock.includes(iGive) && iGet !== w0) || (noSp[String(iGive).split(':')[0]] && swapDay(Number(m.dueAt)) === today);
      if (bad) { await callOff(db, m, `called off: @${me} ${lock.includes(iGive) ? 'locked that pass to their 1st pick' : 'maxed that sport today'}`, { n: 0, late: 0, soon: 0 }); n++; } } } catch (e) {}
    return json({ ok: true, lock1: lock, noSp: Object.keys(noSp), cancelled: n });
  }
  if (op === 'keep' && request.method === 'POST') {
    let b = {}; try { b = await request.json(); } catch (e) {}
    const keep = (Array.isArray(b.keep) ? b.keep : []).map(String).filter(k => /^[a-z]+:\d{4}:t?\d+$/.test(k)).slice(0, 5000);
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
    const keep = (Array.isArray(b.keep) ? b.keep : []).map(String).filter(k => /^[a-z]+:\d{4}:t?\d+$/.test(k)).slice(0, 5000);
    const sched = cleanSched(b.sched);
    const slots = schedUtc(sched) || [...new Set((Array.isArray(b.slots) ? b.slots : []).map(Number).filter(h => Number.isInteger(h) && h >= 0 && h < 24))].slice(0, MAX_SLOTS);
    const rsUser = await realName(db, me);   // their Real account: board username, or the one they linked
    const mine = await db.prepare('SELECT passes, slots, sched FROM swap_users WHERE key=?').bind(me).first();
    const owned = new Set(parse(mine && mine.passes, []).filter(p => p.kind !== 'team').map(p => p.key));
    if (wants.some(w => !owned.has(w))) return json({ error: 'You can only swap for passes you own - scan your passes, then pick from them.' }, 400);
    if (wants.some(w => seasonOff(w))) return json({ error: '2026-27 CBB and NBA passes can\'t be swapped yet.' }, 400);
    { const low = await lowPlays(env, db, wants, null, me);
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
    // 160s: buy / sell / only here to sell 160s (then no swaps, so no picks needed).
    { const only = b.only160 ? 1 : 0, sell = only || b.s160 ? 1 : 0, buy = !only && b.b160 ? 1 : 0;
      // Selling: one hour a day, the swap hours (only with players picked), or several hours.
      let sm = ['one', 'swaps', 'multi'].includes(b.sell160m) ? b.sell160m : 'one';
      if (sm === 'swaps' && (only || !wants.length)) sm = 'one';
      let sh = [...new Set((Array.isArray(b.sell160h) ? b.sell160h : []).map(Number).filter(h => Number.isInteger(h) && h >= 0 && h < 24))];
      if (sm === 'one') sh = sh.slice(0, 1);
      if (sell && sm !== 'swaps' && !sh.length) return json({ error: sm === 'one' ? 'Pick the time to sell your 160s (step 6).' : 'Pick at least one time to sell your 160s (step 6).' }, 400);
      // Niche: opted in to be asked to buy, and how many people they ask to buy each of their picks.
      try { await matchCols(db); } catch (e) {}
      // Blacklist: members only, never themselves, at most 100.
      if (Array.isArray(b.blist)) {
        const want = [...new Set(b.blist.map(k => String(k || '').trim().toLowerCase().replace(/^@/, '')).filter(k => k && k !== String(me).toLowerCase()))].slice(0, 100);
        let ok = [];
        for (let i = 0; i < want.length; i += 90) { const part = want.slice(i, i + 90);
          ok = ok.concat((((await db.prepare(`SELECT key FROM swap_users WHERE lower(key) IN (${part.map(() => '?').join(',')})`).bind(...part).all()).results) || []).map(r => String(r.key).toLowerCase())); }
        await db.prepare('UPDATE swap_users SET blist=? WHERE key=?').bind(JSON.stringify(ok), me).run();
        // Upcoming swaps and 160s with them that haven't been messaged yet are called off.
        if (ok.length) { const ph = ok.map(() => '?').join(',');
          try { for (const m of (((await db.prepare(`SELECT * FROM swap_matches WHERE status='scheduled' AND warnA IS NULL AND warnB IS NULL AND ((a=? AND lower(b) IN (${ph})) OR (b=? AND lower(a) IN (${ph})))`).bind(me, ...ok, me, ...ok).all()).results) || []))
            await callOff(db, m, `called off: @${me} blacklisted them`, { n: 0, late: 0, soon: 0 }); } catch (e) {}
          try { await db.prepare(`UPDATE swap_160 SET status='cancelled', note=? WHERE status='pending' AND warnS IS NULL AND warnB IS NULL AND ((buyer=? AND lower(seller) IN (${ph})) OR (seller=? AND lower(buyer) IN (${ph})))`).bind(`called off: @${me} blacklisted them`, me, ...ok, me, ...ok).run(); } catch (e) {} } }
      { const nIn = b.nicheIn ? 1 : 0, old = parse((await db.prepare('SELECT niche FROM swap_users WHERE key=?').bind(me).first() || {}).niche, {}) || {}, nq = {};
        let oc = null; try { oc = await ownerCounts(env); if (!oc.at) oc = null; } catch (e) {}
        for (const [w, v] of Object.entries((b.niche && typeof b.niche === 'object') ? b.niche : {})) {
          const n = Math.floor(Number(v && v.n != null ? v.n : v)); if (!wants.includes(w) || !(n > 0)) continue;
          if (!old[w] && oc && (oc.n[w] || 0) - ((oc.act || []).includes(me) ? 1 : 0) >= NICHE_UNDER) continue;   // a new ask needs a niche player; one already made stays until cancelled or filled
          const m = Math.min(NICHE_MAX_ASK, n); nq[w] = { n: m, at: old[w] && Number(old[w].n) === m && old[w].at ? old[w].at : Date.now() }; }
        const nl = { h: Math.max(1, Math.min(10, Math.floor(Number(b.nicheLim && b.nicheLim.h)) || NICHE_HOUR_MAX)), d: Math.max(1, Math.min(40, Math.floor(Number(b.nicheLim && b.nicheLim.d)) || NICHE_DAY_MAX)) };
        await db.prepare('UPDATE swap_users SET nicheIn=?, niche=?, nicheLim=? WHERE key=?').bind(nIn, JSON.stringify(nq), JSON.stringify(nl), me).run();
        // Requests not yet warned come off when they opt out, or drop the request.
        if (!nIn) await db.prepare(`UPDATE swap_160 SET status='cancelled', note='called off: they stopped buying niche players' WHERE seller=? AND kind='niche' AND status='pending' AND warnS IS NULL AND warnB IS NULL`).bind(me).run().catch(() => {});
        for (const r of (((await db.prepare(`SELECT id, pass FROM swap_160 WHERE buyer=? AND kind='niche' AND status='pending' AND warnS IS NULL AND warnB IS NULL`).bind(me).all().catch(() => ({}))).results) || []))
          if (!nq[r.pass]) await db.prepare(`UPDATE swap_160 SET status='cancelled', note='called off: the niche request was removed' WHERE id=?`).bind(r.id).run().catch(() => {}); }
      await db.prepare('UPDATE swap_users SET b160=?, s160=?, only160=?, sell160m=?, sell160h=? WHERE key=?').bind(buy, sell, only, sell ? sm : null, sell && sm !== 'swaps' ? JSON.stringify(sh) : null, me).run();
      // 160s not yet warned at an hour they no longer sell at come off.
      if (sell && sm !== 'swaps') { const keepH = new Set(sh);
        for (const r of (((await db.prepare(`SELECT id, dueAt FROM swap_160 WHERE seller=? AND kind IS NULL AND status='pending' AND warnS IS NULL AND warnB IS NULL`).bind(me).all()).results) || []))
          if (!keepH.has(new Date(Number(r.dueAt)).getUTCHours())) await db.prepare(`UPDATE swap_160 SET status='cancelled', note='called off: seller changed their 160 times' WHERE id=?`).bind(r.id).run(); }
      // Stopped buying or selling: their 160s not yet warned come off.
      if (!sell) await db.prepare(`UPDATE swap_160 SET status='cancelled', note='called off: seller stopped selling 160s' WHERE seller=? AND kind IS NULL AND status='pending' AND warnS IS NULL AND warnB IS NULL`).bind(me).run().catch(() => {});
      if (!buy) await db.prepare(`UPDATE swap_160 SET status='cancelled', note='called off: buyer stopped buying 160s' WHERE buyer=? AND kind IS NULL AND status='pending' AND warnS IS NULL AND warnB IS NULL`).bind(me).run().catch(() => {}); }
    try { await autoConfirm(db, me, mine, { slots, sched }); } catch (e) {}
    try { await env.RATEBOARD_KV.delete('swap_hourcounts_v3'); await env.RATEBOARD_KV.delete('swap_wantcounts_v3'); } catch (e) {}
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
    // dm: whether the bot can tell them it's done if they leave (it has a chat with them).
    if (job) {
      try { await db.prepare('UPDATE scan_queue SET lastSeen=? WHERE key=?').bind(now, me).run(); } catch (e) {}
      const r = await scanWork(env, db, me, job, auth); delete r.job;
      return json({ ...r, dm: job.self !== false && !!(await scanChat(db, job.hashId)) });
    }
    const u = await db.prepare('SELECT rsUser, hashId, scannedAt, passes FROM swap_users WHERE key=?').bind(me).first();
    const fast = acc.admin || BOOST_FAST.has(String(me || '').toLowerCase());
    if (!fast) {
      const every = await scanEvery(env);
      const lastAt = Number(u && u.scannedAt) || 0, left = lastAt + every * 60000 - now;
      if (left > 0 && u && u.passes) {
        const m = Math.ceil(left / 60000);
        return json({ done: true, hashId: u.hashId, passes: parse(u.passes, []), errors: [], cached: true, scannedAt: lastAt,
          note: `From your last scan. A fresh scan is allowed once every ${every >= 60 ? (every === 60 ? 'hour' : every / 60 + ' hours') : every + ' minutes'} - next in ${m >= 60 ? Math.floor(m / 60) + 'h ' + (m % 60) + 'm' : m + ' min'}.` });
      }
    } else if (!(await allow(url.origin, 'swapscan:' + me, 20, 600))) return json({ error: 'Twenty scans per ten minutes.' }, 429);
    // The line. Admins skip it.
    // Members scan their own Real account; an admin may name another (OTD).
    const over = acc.admin && url.searchParams.get('rsUser') ? String(url.searchParams.get('rsUser')).trim().replace(/^@/, '') : null;
    if (!acc.admin) {
      const q = await scanQueueTurn(db, me, now);
      if (!q.go) return json({ queued: true, position: q.position, wait: q.wait, dm: !!(await scanChat(db, u && u.hashId)) });
    } else if (!over) {
      // An admin's own scan skips the line but is still on the server's list, so it carries on if they leave.
      try { await db.prepare('INSERT INTO scan_queue (key, joinedAt, startedAt, lastSeen) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET startedAt=excluded.startedAt, lastSeen=excluded.lastSeen').bind(me, now, now, now).run(); } catch (e) {}
    }
    job = await newScanJob(env, db, me, over, u, { full: url.searchParams.get('quick') !== '1' });   // every season by default (Dennis, 2026-11-05); quick=1 for current seasons + ones they hold
    if (job.error) { try { await db.prepare('DELETE FROM scan_queue WHERE key=?').bind(me).run(); } catch (e) {} return json({ error: job.error }, job.status || 400); }
    const r = await scanWork(env, db, me, job, auth); delete r.job;
    return json({ ...r, dm: job.self !== false && !!(await scanChat(db, job.hashId)) });
  }

  // Admin: how often members may scan - 60 (every hour) or 15 minutes.
  if (op === 'scanevery') {
    const v = Number(url.searchParams.get('set'));
    if (v === 15 || v === 60) { try { await env.RATEBOARD_KV.put(SCAN_EVERY_KEY, String(v)); } catch (e) {} }
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
  /* Buys (CBB): the first 78 of the top list (181 players), with whether the member holds a pass for each; anyone they
     don't hold is a recommended buy, with his link. */
  if (op === 'buys') {
    const u = await db.prepare('SELECT passes, scannedAt FROM swap_users WHERE key=?').bind(me).first();
    const own = new Set(parse(u && u.passes, []).filter(p => p.sport === 'ncaam' && Number(p.season) === 2027 && p.kind !== 'team').map(p => Number(p.id)));
    const list = Object.entries(CBB_TOP175).map(([id, v]) => ({ id: Number(id), rank: v[0], team: v[1], link: 'https://www.realapp.com/' + v[2] }))
      .sort((a, b) => a.rank - b.rank).slice(0, 78);   // 78 (2026-11-07): the 70 plus the 8 added that day
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
    /* Every sport now (Dennis, 2026-11-16: "add the CFB resells/buys to every other sport"). HIT: a good game's
       rax, for consistency. SHARE: how many of his games a card is likely boosted in - CFB and NFL play once
       a week so every game gets a booster; CBB, NBA and NHL play too often for that, so only part of the
       games left get the booster and the rest earn plain rax. The page can change it. */
    const RS_CFG = { ncaaf: { SEASON_GAMES: 12, MIN_G: 5, offense: true, HIT: 20, SHARE: 1 }, nfl: { SEASON_GAMES: 17, MIN_G: 4, offense: true, HIT: 20, SHARE: 1 },
      ncaam: { SEASON_GAMES: 31, MIN_G: 4, offense: false, HIT: 10, SHARE: 0.4 }, nba: { SEASON_GAMES: 82, MIN_G: 5, offense: false, HIT: 15, SHARE: 0.25 },
      nhl: { SEASON_GAMES: 82, MIN_G: 5, offense: false, HIT: 8, SHARE: 0.25 } };
    const SP = RS_CFG[url.searchParams.get('sport')] ? url.searchParams.get('sport') : 'ncaam';
    const CFG = { ...RS_CFG[SP], SEASON: BOOST_SEASON[SP][0], PREV: BOOST_SEASON[SP][1], sellMin: 100 };
    const shareQ = Number(url.searchParams.get('share')); if (shareQ > 0 && shareQ <= 1) CFG.SHARE = shareQ;
    const { SEASON, PREV, SEASON_GAMES, MIN_G } = CFG, PACK = 200;
    // A booster on SHARE of his games, plain rax on the rest.
    const effM = m => CFG.SHARE * m + (1 - CFG.SHARE);
    const OFF = /^(QB|RB|HB|FB|WR|TE)$/i;
    try { await alterOnce(db, 'ALTER TABLE swap_users ADD COLUMN noSell TEXT'); } catch (e) {}
    const u = await db.prepare('SELECT passes, scannedAt, noSell FROM swap_users WHERE key=?').bind(me).first();
    if (!u || !u.passes) return json({ error: 'Read your passes on the Boosts tab first.' }, 400);
    const noSell = new Set((parse(u.noSell, []) || []).map(String));
    const mine = parse(u.passes, []).filter(p => p.sport === SP && Number(p.season) === SEASON && p.kind !== 'team');
    const sells = mine.length >= CFG.sellMin;
    // Every CBB player's rax a game this season and last (one grouped read each, kept 30 minutes).
    const rkey = 'resell_rpg_v5_' + SP;
    let R = null; try { R = JSON.parse((await env.RATEBOARD_KV.get(rkey)) || 'null'); } catch (e) {}
    if (!R || Date.now() - R.at > 30 * 60000) {
      const grab = async se => ((await db.prepare(`SELECT playerId AS id, MAX(player) AS n, MAX(CASE WHEN seasonType = 'allstar' THEN NULL ELSE team END) AS t, MAX(position) AS pos, COUNT(*) AS g, SUM(rax) AS r, MAX(rax) AS mx,
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
    /* Out for the season only on clear wording (2026-11-16: "season" anywhere in the note had Sam Darnold,
       expected to practice this week, and Lamar Jackson, out 6-10 weeks, both marked out for the season).
       "Out N(-M) weeks" takes those weeks of games off his games left instead. */
    let out = {}, outWk = {};
    const SEASON_OUT = /\b(out for the (rest of the )?season|season[- ]ending|rest of the season|remainder of the season|out indefinitely|miss the (rest|remainder) of)\b/i;
    try { const c = JSON.parse((await env.RATEBOARD_KV.get('resell_out_v2_' + SP)) || 'null'); if (c && Date.now() - c.at < 6 * 3600000) { out = c.m; outWk = c.w || {}; } else throw 0; }
    catch (e) {
      try { const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${ESPN_PATH[SP]}/injuries`); const d = r.ok ? await r.json() : {};
        for (const t of (d.injuries || [])) for (const x of (t.injuries || [])) {
          if (!x.athlete || /^active$/i.test(x.status || '')) continue;
          const txt = `${x.shortComment || ''} ${x.longComment || ''}`, nm = boostName(x.athlete.displayName);
          if (SEASON_OUT.test(txt)) { out[nm] = String(x.shortComment || x.status || '').slice(0, 140); continue; }
          const w = txt.match(/\b(\d+)\s*(?:-\s*to\s*-|-|to)\s*(\d+)\s*weeks?\b/i) || txt.match(/\b(\d+)\s*weeks?\b/i);
          if (w && /out|sideline|miss|expected/i.test(txt)) outWk[nm] = { weeks: w[2] ? (Number(w[1]) + Number(w[2])) / 2 : Number(w[1]), note: String(x.shortComment || x.status || '').slice(0, 140) };
        } } catch (e2) {}
      try { await env.RATEBOARD_KV.put('resell_out_v2_' + SP, JSON.stringify({ at: Date.now(), m: out, w: outWk }), { expirationTtl: 86400 }); } catch (e) {}
    }
    // Out-for-the-season entries on the hand list too.
    try { const mo = await boostManualOut(env, SP); for (const [k, v] of Object.entries(mo)) if (/season|indefinite/i.test(`${v.status} ${v.note}`)) out[k] = v.note || v.status; } catch (e) {}
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
    // Games a week, for "out N weeks" (from his injury note).
    const GPW = { ncaaf: 1, nfl: 1, ncaam: 2, nba: 3.5, nhl: 3.5 }[SP] || 1;
    const leftNow = (id, nm) => { const w = outWk[boostName(nm)]; return Math.max(0, left(id) - (w ? Math.ceil(w.weeks * GPW) : 0)); };
    const owned = new Set(mine.map(p => Number(p.id)));
    const cards = mine.map(p => { const id = Number(p.id), r = rate(id), nm = p.name || (SP === 'ncaam' && CBB_TOP175[id] && CBB_TOP175[id][3]) || (cur.get(id) || prev.get(id) || {}).n || 'Player ' + id;
      const earned = Number(p.earned) || 0, isOut = out[boostName(nm)] || null;
      return { id, name: nm, team: (cur.get(id) || prev.get(id) || {}).t || (SP === 'ncaam' && CBB_TOP175[id] && CBB_TOP175[id][1]) || null, link: playerUrl(`${SP}:${SEASON}:${id}`),
        card: p.passId ? `https://www.realapp.com/${routeId([18, 0, 0, Number(p.passId)])}` : null,
        rpg: r ? Math.round(r.rpg * 10) / 10 : null, basis: r ? r.basis : 'no games yet', played: played(id),
        left: isOut ? 0 : leftNow(id, nm), teamPlayed: teamPlayed(id), earned, sellCost: Math.max(0, earned - 100), out: isOut, outFor: !isOut && outWk[boostName(nm)] ? outWk[boostName(nm)] : null, noSell: noSell.has(String(id)) }; })
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
        buy: MULTS.map(([k, m]) => ({ booster: k, mult: m, profit: Math.round(left(x.id) * x.rpg * effM(m) - PACK) })) }));
    // For each of their worst 10: the best replacement, and swap vs keep per booster over the games left.
    // Worst card gets the best replacement, the next worst the next one, so no one is suggested twice.
    const plans = (sells ? cards.filter(c => !c.noSell) : []).slice(0, 10).map((c, i) => {
      const best = reps[i] || null;
      const per = MULTS.map(([k, m]) => {
        const keep = c.rpg != null ? Math.round(c.left * c.rpg * effM(m)) : 0;
        const swap = best ? Math.round(best.left * best.rpg * effM(m) - PACK - c.sellCost) : null;
        return { booster: k, mult: m, keep, swap, gain: swap == null ? null : swap - keep };
      });
      const leg = per.find(x => x.booster === 'legendary');
      return { ...c, replaceWith: best, per, verdict: !best ? 'no replacement yet' : leg.gain > 0 ? 'replace' : 'keep - let him sit, don\'t boost' };
    });
    return json({ sport: SP, scannedAt: u.scannedAt || null, cards, plans, replacements: reps, seasonGames: SEASON_GAMES, minGames: MIN_G, pack: PACK, earlySeason: !thisSeasonEnough,
      sells, held: mine.length, sellMin: CFG.sellMin, offenseOnly: CFG.offense, hitBar: CFG.HIT, share: CFG.SHARE, kept: cards.filter(c => c.noSell) });
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
    const sp = BOOST_SEASON[url.searchParams.get('sport')] || ['golf', 'soccer'].includes(url.searchParams.get('sport')) ? url.searchParams.get('sport') : 'nfl';
    const u = await db.prepare('SELECT hashId FROM swap_users WHERE key=?').bind(me).first();
    if (!u || !u.hashId) return json({ error: 'Re-read your passes first so the board knows your Real account.' }, 400);
    const want = url.searchParams.get('fresh') === '1';
    /* Booster reads are 7 calls to Real each (one a sport), and too many of them
       got the account limited (2026-11-10). Every member: one read every 2
       hours, no exceptions but admins, and at most 15 a minute / 60 every 10
       minutes across the site. */
    const fast = acc.admin;
    if (want && !fast && (!(await allow(url.origin, 'boostinv-all', 15, 60)) || !(await allow(url.origin, 'boostinv-10m', 60, 600)))) return json({ error: HIGH_VOL }, 429);
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
  /* Admin, moderation: everyone with a warning/strike, the open unban
     requests, running the count now (dry=1 to only look), and answering a request. */
  /* Admin: who has done the most swaps - ones that went out (messaged), not
     called off, and whose time has passed. 160s and niche buys not counted. */
  if (op === 'topswappers') {
    if (!acc.admin) return forbidden('Admin only.');
    await matchCols(db);
    const days = Math.min(365, Math.max(0, Number(url.searchParams.get('days')) || 0));
    const since = days ? Date.now() - days * 86400000 : 0, CK = 'topswap_cache_' + days;
    let rows = null; try { const c = JSON.parse((await env.RATEBOARD_KV.get(CK)) || 'null'); if (c && Date.now() - c.at < 10 * 60000) rows = c.rows; } catch (e) {}
    if (!rows) { try { rows = await topSwapCounts(db, since, 25); } catch (e) { return json({ error: 'The database is busy - try Refresh in a minute.' }, 503); }
      try { await env.RATEBOARD_KV.put(CK, JSON.stringify({ at: Date.now(), rows }), { expirationTtl: 3600 }); } catch (e) {} }
    const rs = new Map((((await db.prepare(`SELECT key, rsUser FROM swap_users WHERE key IN (${rows.map(() => '?').join(',') || "''"})`).bind(...rows.map(r => r.k)).all()).results) || []).map(r => [r.key, r.rsUser]));
    return json({ days, rows: rows.map(r => ({ key: r.k, rsUser: rs.get(r.k) || r.k, n: r.n })) });
  }
  // Admin: take away / give back a member's reporting, found by Real username or account (2026-11-15).
  if (op === 'reportblock' && request.method === 'POST') {
    if (!acc.admin) return forbidden('Admin only.');
    let b = {}; try { b = await request.json(); } catch (e) {}
    const q = String(b.user || '').trim().replace(/^@/, '').toLowerCase();
    if (q.length < 2) return json({ error: 'Enter a username.' }, 400);
    const u = await db.prepare('SELECT key, rsUser FROM swap_users WHERE LOWER(key)=? OR LOWER(rsUser)=?').bind(q, q).first();
    const m = await reportBlocks(env);
    const k = u ? String(u.key).toLowerCase() : q;
    if (!u && !m[k]) return json({ error: `No member named @${q}.` }, 404);
    if (b.block) m[k] = { at: Date.now(), name: (u && u.rsUser) || q }; else delete m[k];
    await env.RATEBOARD_KV.put(RBLOCK_KV, JSON.stringify(m));
    return json({ ok: true, name: (u && u.rsUser) || q, blocked: !!b.block });
  }
  // Admin: take away / give back a member's rating (Dennis, 2026-11-15). Their ratings stop counting while it's off.
  if (op === 'rateblock' && request.method === 'POST') {
    if (!acc.admin) return forbidden('Admin only.');
    let b = {}; try { b = await request.json(); } catch (e) {}
    const q = String(b.user || '').trim().replace(/^@/, '').toLowerCase();
    if (q.length < 2) return json({ error: 'Enter a username.' }, 400);
    const u = await db.prepare('SELECT key, rsUser FROM swap_users WHERE LOWER(key)=? OR LOWER(rsUser)=?').bind(q, q).first();
    if (!u) return json({ error: `No member named @${q}.` }, 404);
    await db.prepare(RATE_BLOCK_DDL).run();
    if (b.block) await db.prepare('INSERT OR REPLACE INTO swap_rate_block (key, at, why) VALUES (?, ?, ?)').bind(u.key, Date.now(), 'Turned off by admin').run();
    else await db.prepare('DELETE FROM swap_rate_block WHERE key=?').bind(u.key).run();
    try { await env.RATEBOARD_KV.delete(TRUST_KEY); } catch (e) {}
    // Taken away: an automatic DM (Dennis's wording, 2026-11-15), and it's on their Notifications page.
    let dm = false;
    if (b.block) {
      const text = 'Your ability to rate other users has been taken';
      try { await addNote(db, u.key, 'mod', text); } catch (e) {}
      try { const m0 = await db.prepare('SELECT hashId, rsUser FROM swap_users WHERE key=?').bind(u.key).first(), auth = swapToken(env);
        if (auth && m0 && m0.hashId) { const ch = await dmChannel(db, auth, m0.hashId, m0.rsUser, env); await queueDm(db, ch, [text], 'rateblock ' + u.key); dm = true; } }
      catch (e) { await botFail(db, 'dm_rateblock', `${u.key}: ${e.message || e}`); }
    }
    return json({ ok: true, name: u.rsUser || u.key, blocked: !!b.block, dm });
  }
  /* Username suggestions for the Report page (2026-11-16), signed-in members only: names that start
     with what was typed first, then names that contain it. Usernames only. */
  /* Your passes by sport, names only (2026-11-16, Board seller's "Exclude owned"): from your last pass scan. */
  /* The board's player box (Dennis, 2026-11-27): the buyer's own passes this season, with their rating right now,
     shown first. One read of every pass they own, kept 15 minutes. Their own data only. */
  // Every board sport and season from their last site Scan (Dennis, 2026-11-27: one board for all sports).
  if (op === 'myboardall') {
    if (!acc.who) return json({ error: 'Sign in first.' }, 401);
    const u = await db.prepare('SELECT passes, scannedAt FROM swap_users WHERE LOWER(key)=?').bind(String(acc.who).toLowerCase()).first().catch(() => null);
    const ps = parse(u && u.passes, []).filter(p => BOARD_OF[p.sport] && p.name && p.rating != null && (p.kind !== 'team' || p.sport === 'ufc'));
    return json({ scannedAt: (u && u.scannedAt) || null, passes: ps.map(p => { const bs = BOARD_OF[p.sport]; return { sp: bs, se: boardSeasonLbl(bs, p.season), n: p.name, r: Math.round(Number(p.rating) * 10) / 10, lv: p.levelLabel || null }; }).sort((a, b) => b.r - a.r) });
  }
  if (op === 'myboardpasses') {
    if (!acc.who) return json({ error: 'Sign in first.' }, 401);
    const bs = String(url.searchParams.get('sport') || '').toUpperCase(); if (!AM_SP[bs]) return json({ passes: [] });
    const k = String(acc.who).toLowerCase(), ck = 'mbp_v2_' + k + '_' + bs;
    try { const c = JSON.parse((await env.RATEBOARD_KV.get(ck)) || 'null'); if (c && Date.now() - c.at < 15 * 60000) return json(c); } catch (e) {}
    if (!(await allow(url.origin, 'mbp:' + k, 12, 600))) return json({ error: 'Wait a few minutes.' }, 429);
    const tok = scanTok(env); if (!tok) return json({ passes: [] });
    let hid = (await db.prepare('SELECT hashId FROM swap_users WHERE LOWER(key)=?').bind(k).first().catch(() => null) || {}).hashId;
    if (!hid) { try { hid = await resolveHashId(await realName(db, acc.who), tok); } catch (e) {} }
    if (!hid) return json({ passes: [], none: true });
    let ps; try { ps = await boardSportPasses(hid, bs, tok); } catch (e) { return json({ error: 'Could not read your passes - try again in a minute.' }, 502); }
    const res = { at: Date.now(), passes: ps.map(p => ({ n: p.name, r: Math.round(p.rating * 10) / 10, lv: p.levelLabel || null, se: p.season })).sort((a, b) => b.r - a.r) };
    try { await env.RATEBOARD_KV.put(ck, JSON.stringify(res), { expirationTtl: 3600 }); } catch (e) {}
    return json(res);
  }
  if (op === 'mypassnames') {
    if (!acc.who) return json({ error: 'Sign in first.' }, 401);
    const u = await db.prepare('SELECT passes, scannedAt FROM swap_users WHERE LOWER(key)=?').bind(String(acc.who).toLowerCase()).first().catch(() => null);
    if (!u) return json({ none: true, sports: {} });
    // Current season only (Dennis, 2026-11-16: 26-27 CFB, not last year's passes). Football keys are the start
    // year (2026 = 26-27), basketball and hockey the end year (2027 = 26-27), the rest the calendar year.
    const now0 = new Date(), y0 = now0.getUTCFullYear(), m0 = now0.getUTCMonth();
    const cur = sp => /^(nfl|ncaaf)$/.test(sp) ? (m0 >= 6 ? y0 : y0 - 1) : /^(nba|ncaam|nhl)$/.test(sp) ? (m0 >= 8 ? y0 + 1 : y0) : sp === 'soccer' ? (m0 >= 6 ? y0 + 1 : y0) : y0;
    /* The same current seasons the Boosts page uses (2026-11-17: FC read as 2027 and left out 0 passes - Real's
       current FC season is 2026 (2025-26), plus MLS on 2025; NHL is keyed 2026 for 26-27 like football). */
    const curs = sp => sp === 'soccer' ? [FC_SEASON[0], FC_MLS_SEASON] : BOOST_SEASON[sp] ? [BOOST_SEASON[sp][0]] : [cur(sp)];
    const out = {}; for (const p0 of parse(u.passes, [])) { const [sp, se] = String(p0.key || '').split(':'); if (!sp || !p0.name || !curs(sp).includes(Number(se))) continue; (out[sp] = out[sp] || []).push(p0.name); }
    return json({ sports: out, at: u.scannedAt || null });
  }
  if (op === 'confbypass') {
    if (!acc.admin) return forbidden('Admin only.');
    let l = await bypassList(env);
    if (request.method === 'POST') { let b = {}; try { b = await request.json(); } catch (e) {}
      if (b.add) { const q = String(b.add).trim().replace(/^@/, '').toLowerCase();
        const u = await db.prepare('SELECT key, rsUser FROM swap_users WHERE LOWER(rsUser)=? OR LOWER(key)=? LIMIT 1').bind(q, q).first();
        if (!u) return json({ error: 'No member with that username.', rows: l });
        if (!l.some(x => x.k === String(u.key).toLowerCase())) l.push({ k: String(u.key).toLowerCase(), u: u.rsUser || u.key, at: Date.now() }); }
      if (b.del) l = l.filter(x => x.k !== String(b.del).toLowerCase());
      await env.RATEBOARD_KV.put(CONF_BYPASS_KV, JSON.stringify(l));
      try { await confirmBypass(env, db); } catch (e) {} }
    return json({ rows: l });
  }
  if (op === 'membersearch') {
    if (!acc.who) return json({ error: 'Sign in first.' }, 401);
    if (!(await allow(url.origin, 'msearch:' + acc.who, 60, 60))) return json({ rows: [] });
    const q = String(url.searchParams.get('q') || '').trim().replace(/^@/, '').toLowerCase();
    if (q.length < 2) return json({ rows: [] });
    const like = q.replace(/[%_]/g, '');
    const rs = ((await db.prepare("SELECT DISTINCT COALESCE(rsUser, key) AS u FROM swap_users WHERE LOWER(COALESCE(rsUser, key)) LIKE ? ORDER BY CASE WHEN LOWER(COALESCE(rsUser, key)) LIKE ? THEN 0 ELSE 1 END, LENGTH(COALESCE(rsUser, key)) LIMIT 8").bind('%' + like + '%', like + '%').all()).results) || [];
    return json({ rows: rs.map(r => r.u) });
  }
  if (op === 'modlookup') {
    if (!acc.admin) return forbidden('Admin only.');
    const q = String(url.searchParams.get('q') || '').trim().replace(/^@/, '').toLowerCase();
    if (q.length < 2) return json({ rows: [] });
    const rs = ((await db.prepare("SELECT key, rsUser FROM swap_users WHERE LOWER(rsUser) LIKE ? OR LOWER(key) LIKE ? ORDER BY rsUser LIMIT 15").bind('%' + q + '%', '%' + q + '%').all()).results) || [];
    const m = await reportBlocks(env);
    let nr = new Set(); try { await db.prepare(RATE_BLOCK_DDL).run(); nr = new Set(((((await db.prepare('SELECT key FROM swap_rate_block').all()).results) || [])).map(r => r.key)); } catch (e) {}
    return json({ rows: rs.map(r => ({ key: r.key, rsUser: r.rsUser || r.key, noReport: !!m[String(r.key).toLowerCase()], noRate: nr.has(r.key) })) });
  }
  if (op === 'modlist') {
    if (!acc.admin) return forbidden('Admin only.');
    await modReady(db);
    const st = new Map((((await db.prepare('SELECT key, resetAt, banned, bannedAt FROM mod_state').all()).results) || []).map(r => [r.key, r]));
    const evs = ((await db.prepare('SELECT key, kind, n, period, at, reports FROM mod_events ORDER BY id').all()).results) || [];
    const per = new Map();
    for (const e of evs) { const s0 = st.get(e.key); if (s0 && Number(e.at) < Number(s0.resetAt || 0)) continue;
      if (!per.has(e.key)) per.set(e.key, { key: e.key, strikes: 0, events: [] }); const x = per.get(e.key);
      if (e.kind === 'strike') x.strikes++; x.events.push({ kind: e.kind, n: e.n, when: modTime(e.period), reports: e.reports }); }
    for (const [k, s0] of st) if (s0.banned && !per.has(k)) per.set(k, { key: k, strikes: MOD_STRIKES, events: [] });
    const rs = new Map((((await db.prepare('SELECT key, rsUser FROM swap_users').all()).results) || []).map(r => [r.key, r.rsUser]));
    const rows = [...per.values()].map(x => ({ ...x, rsUser: rs.get(x.key) || x.key, banned: !!(st.get(x.key) || {}).banned })).sort((a, b) => b.banned - a.banned || b.strikes - a.strikes);
    const reqs = ((await db.prepare("SELECT id, key, text, ts, status FROM unban_requests WHERE status='open' ORDER BY ts").all()).results) || [];
    let last = null; try { last = JSON.parse((await env.RATEBOARD_KV.get('mod_summary_v1')) || 'null'); } catch (e) {}
    const rb = await reportBlocks(env);
    for (const r of rows) r.noReport = !!rb[String(r.key).toLowerCase()];
    const noReport = Object.entries(rb).map(([k, v]) => ({ key: k, rsUser: v.name || rs.get(k) || k, at: v.at }));
    let noRate = []; try { await db.prepare(RATE_BLOCK_DDL).run(); noRate = (((await db.prepare('SELECT key, at, why FROM swap_rate_block ORDER BY at DESC').all()).results) || []).map(r => ({ key: r.key, rsUser: rs.get(r.key) || r.key, at: r.at, why: r.why })); } catch (e) {}
    const nrs = new Set(noRate.map(r => r.key)); for (const r of rows) r.noRate = nrs.has(r.key);
    return json({ rows, noReport, noRate, requests: reqs.map(r => ({ ...r, rsUser: rs.get(r.key) || r.key, record: per.get(r.key) || null })), last });
  }
  /* Admin: appeals and held reports (2026-11-16). */
  if (op === 'modappeals') {
    if (!acc.admin) return forbidden('Admin only.');
    await db.prepare(APPEAL_DDL).run();
    if (request.method === 'POST') {
      let b = {}; try { b = await request.json(); } catch (e) {}
      const r = await db.prepare('SELECT * FROM mod_appeals WHERE id=?').bind(Number(b.id)).first();
      if (!r) return json({ error: 'Appeal not found.' }, 404);
      const yes = !!b.approve, answer = String(b.answer || '').trim().slice(0, 500);
      await db.prepare('UPDATE mod_appeals SET status=?, answer=? WHERE id=?').bind(yes ? 'approved' : 'declined', answer || null, r.id).run();
      let note;
      if (yes) {
        // The reports behind it never count again; the event goes; Swaps comes back if they're under the limit.
        const v = await kvObj(env, MOD_VOIDED_KV); v[`${r.key}|${r.period}`] = Date.now(); await env.RATEBOARD_KV.put(MOD_VOIDED_KV, JSON.stringify(v));
        await modReady(db);
        await db.prepare('DELETE FROM mod_events WHERE key=? AND period=?').bind(r.key, Number(r.period)).run();
        const st = await db.prepare('SELECT banned, resetAt FROM mod_state WHERE key=?').bind(r.key).first();
        const left = await db.prepare("SELECT COUNT(*) AS n FROM mod_events WHERE key=? AND kind='strike' AND at >= ?").bind(r.key, Number((st && st.resetAt) || 0)).first();
        if (st && st.banned && Number((left && left.n) || 0) < MOD_STRIKES) {
          await db.prepare(SBLOCK_DDL).run(); await db.prepare('DELETE FROM swap_block WHERE key=?').bind(r.key).run();
          await db.prepare('UPDATE mod_state SET banned=0 WHERE key=?').bind(r.key).run(); ACCESS_MEMO.delete(r.key); }
        note = `Your appeal was accepted - the ${r.kind === 'warn' ? 'warning' : 'strike'} for ${modTime(r.period)} is removed.`;
      } else note = `Your appeal for the ${r.kind === 'warn' ? 'warning' : 'strike'} on ${modTime(r.period)} was declined.`;
      if (answer) note += '\n' + answer;
      await addNote(db, r.key, 'mod', note);
      const u = await db.prepare('SELECT hashId FROM swap_users WHERE key=?').bind(r.key).first();
      const d = u && u.hashId && await db.prepare('SELECT channelId FROM swap_dm WHERE hashId=? AND channelId IS NOT NULL').bind(u.hashId).first();
      if (d) await queueDm(db, d.channelId, [note], 'appeal ' + r.key);
    }
    const rows = ((await db.prepare("SELECT a.*, u.rsUser FROM mod_appeals a LEFT JOIN swap_users u ON u.key = a.key ORDER BY CASE WHEN a.status='open' THEN 0 ELSE 1 END, a.id DESC LIMIT 60").all()).results) || [];
    return json({ rows: rows.map(r => ({ ...r, when: modTime(r.period) })) });
  }
  /* Who has push notifications on (Dennis, 2026-11-17, Admin): members with at least one device, how many,
     when they turned it on, and which kinds they have on. */
  if (op === 'pushusers') {
    if (!acc.admin) return forbidden('Admin only.');
    await db.prepare(PUSH_DDL).run();
    const rows = ((await db.prepare('SELECT key, COUNT(*) AS n, MIN(at) AS first, MAX(at) AS last, GROUP_CONCAT(ua, ' + "'|'" + ') AS uas FROM push_subs GROUP BY key ORDER BY last DESC').all()).results) || [];
    const out = [];
    for (const r of rows.slice(0, 1000)) {
      const p = await pushPrefs(env, r.key), u = await db.prepare('SELECT rsUser FROM swap_users WHERE key=?').bind(r.key).first().catch(() => null);
      const sw = p.swaps || {}, bo = p.boosts || {};
      const dev = String(r.uas || '').split('|').map(x => /iPhone|iPad/.test(x) ? 'iPhone' : /Android/.test(x) ? 'Android' : /Mac/.test(x) ? 'Mac' : /Windows/.test(x) ? 'PC' : 'Other');
      out.push({ who: (u && u.rsUser) || r.key, devices: Number(r.n) || 0, kinds: [...new Set(dev)], first: r.first, last: r.last,
        swaps: !!sw.on, boosts: !!bo.on ? (bo.all ? 'all' : Object.entries(bo.sports || {}).filter(([, x]) => x.on).map(([k]) => BOOST_PUSH_SP[k]).join(', ') || 'none') : '', notes: !p.notes || p.notes.on !== false,
        noDm: !!sw.on && (sw.dmWarn === false || sw.dmLive === false) });
    }
    return json({ rows: out });
  }
  if (op === 'modheld') {
    if (!acc.admin) return forbidden('Admin only.');
    if (request.method === 'POST') { let b = {}; try { b = await request.json(); } catch (e) {}
      const k = String(b.k || ''); if (k) { const f = await kvObj(env, MOD_FORCE_KV); f[k] = Date.now(); await env.RATEBOARD_KV.put(MOD_FORCE_KV, JSON.stringify(f)); } }
    let l = []; try { l = JSON.parse((await env.RATEBOARD_KV.get(MOD_HELD_KV)) || '[]') || []; } catch (e) {}
    const f = await kvObj(env, MOD_FORCE_KV);
    return json({ rows: l.filter(h => !f[h.k]).map(h => ({ ...h, when: modTime(h.period) })) });
  }
  if (op === 'modrun') {
    if (!acc.admin) return forbidden('Admin only.');
    const dry = url.searchParams.get('dry') === '1' || request.method !== 'POST';
    return json(await moderate(env, db, dry));
  }
  if (op === 'modunban' && request.method === 'POST') {
    if (!acc.admin) return forbidden('Admin only.');
    await modReady(db);
    let b = {}; try { b = await request.json(); } catch (e) {}
    const r = b.id ? await db.prepare('SELECT * FROM unban_requests WHERE id=?').bind(Number(b.id)).first() : null;
    const key = (r && r.key) || String(b.key || '');
    if (!key) return json({ error: 'Pick a request or member.' }, 400);
    const yes = b.approve !== false, answer = String(b.answer || '').trim().slice(0, 500);
    if (yes) {
      await db.prepare(SBLOCK_DDL).run();
      await db.prepare('DELETE FROM swap_block WHERE key=?').bind(key).run();
      await db.prepare('INSERT INTO mod_state (key, resetAt, banned) VALUES (?, ?, 0) ON CONFLICT(key) DO UPDATE SET banned=0, resetAt=excluded.resetAt').bind(key, Date.now()).run();
      ACCESS_MEMO.delete(key);
    }
    if (r) await db.prepare('UPDATE unban_requests SET status=?, answer=? WHERE id=?').bind(yes ? 'approved' : 'declined', answer || null, r.id).run();
    const u = await db.prepare('SELECT hashId FROM swap_users WHERE key=?').bind(key).first();
    const d = u && u.hashId && await db.prepare('SELECT channelId FROM swap_dm WHERE hashId=? AND channelId IS NOT NULL').bind(u.hashId).first();
    const note = (b.clear ? 'Your Swaps warnings and strikes have been cleared - you have a clean record.'
      : yes ? 'Your Swaps access is back and your strikes are cleared. Turn your swaps back on at raxacademy.app/swaps'
      : 'Your unban request was declined.') + (answer ? '\n' + answer : '');
    if (b.notify !== false) await addNote(db, key, 'mod', note);
    if (d && b.notify !== false) await queueDm(db, d.channelId, [note], 'unban ' + key);
    return json({ ok: true, dm: !!d });
  }
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
  /* Admin: the hand injury list Boosts uses (see BOOST_OUT_SEED). GET lists
     it; POST { sport, name, status, note, until } adds or changes one, POST
     { sport, remove: key } takes one off. */
  if (op === 'boostout') {
    if (!acc.admin) return forbidden('Admin only.');
    const all = await boostOutList(env);
    if (request.method === 'POST') {
      let b = {}; try { b = await request.json(); } catch (e) {}
      const sp = ['ncaaf', 'ncaam', 'nfl', 'soccer', 'nba', 'nhl'].includes(b.sport) ? b.sport : null;   // NBA, NHL added 2026-11-25
      if (!sp) return json({ error: 'Pick a sport.' }, 400);
      all[sp] = all[sp] || {};
      if (b.remove) delete all[sp][String(b.remove)];
      else {
        const name = String(b.name || '').trim().slice(0, 60), k = boostName(name);
        const status = ['Out', 'Doubtful', 'Questionable', 'Suspension'].includes(b.status) ? b.status : 'Out';
        const until = /^\d{4}-\d{2}-\d{2}$/.test(String(b.until || '')) ? b.until : '';
        if (!k) return json({ error: 'Type a player name.' }, 400);
        all[sp][k] = { name, status, note: String(b.note || '').trim().slice(0, 140), until, at: Date.now() };
      }
      await env.RATEBOARD_KV.put(BOOST_OUT_KEY, JSON.stringify(all));
      // Projections read this list too: rebuild that sport's on the next open.
      try { await env.RATEBOARD_KV.put(`proj_force_v1_${sp}`, String(Date.now()), { expirationTtl: 7 * 86400 }); } catch (e) {}
    }
    const today = etDay(Date.now());
    return json({ today, sports: Object.fromEntries(['ncaaf', 'ncaam', 'nfl', 'soccer', 'nba', 'nhl'].map(sp => [sp, Object.entries(all[sp] || {})
      .map(([key, v]) => ({ key, ...v, expired: !!(v.until && v.until < today) })).sort((a, b) => a.name.localeCompare(b.name))])) });
  }
  /* Admin: give a member Dennis's own priority (level 2) until a time. */
  if (op === 'bosspri') {
    if (!acc.admin) return forbidden('Admin only.');
    let m = {}; try { m = JSON.parse((await env.RATEBOARD_KV.get(BOSS_KEY)) || '{}') || {}; } catch (e) {}
    for (const k of Object.keys(m)) if (Number(m[k]) <= Date.now()) delete m[k];
    if (request.method === 'POST') {
      let b = {}; try { b = await request.json(); } catch (e) {}
      const add = String(b.add || '').trim().replace(/^@/, '').toLowerCase(), del = String(b.remove || '').trim().toLowerCase();
      if (add) {
        const u = await db.prepare('SELECT key FROM swap_users WHERE LOWER(key)=? OR LOWER(rsUser)=?').bind(add, add).first();
        if (!u) return json({ error: `No swapper called @${add}.` }, 404);
        const until = Number(b.until);
        if (!(until > Date.now() && until < Date.now() + 366 * 86400000)) return json({ error: 'Pick an end time in the future.' }, 400);
        m[u.key.toLowerCase()] = until;
      }
      if (del) delete m[del];
      await env.RATEBOARD_KV.put(BOSS_KEY, JSON.stringify(m));
    }
    const list = [];
    for (const [k, until] of Object.entries(m)) { let real = k; try { const r = await db.prepare('SELECT rsUser FROM swap_users WHERE LOWER(key)=?').bind(k).first(); real = (r && r.rsUser) || k; } catch (e) {} list.push({ key: k, real, until }); }
    return json({ list: list.sort((a, b) => a.until - b.until) });
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
  /* Board's Top players (Dennis, 2026-11-28): each listed player's Real link, rest-of-season projection (projected
     end of season minus what he has now) and the rating members' last scans hold of him. Totals only - never who. */
  if (op === 'boardtop') {
    const sp = PROJ_SEASON[url.searchParams.get('sport')] ? url.searchParams.get('sport') : null;
    if (!sp) return json({ error: 'sport?' }, 400);
    const se = PROJ_SEASON[sp][0];
    const ids = [...new Set(String(url.searchParams.get('ids') || '').split(',').map(Number).filter(n => n > 0))].slice(0, 600);
    let pc = PROJ_MEM.get(sp) ? PROJ_MEM.get(sp).c : null;
    if (!pc) { try { pc = JSON.parse((await env.RATEBOARD_KV.get(`proj_v3_${sp}`)) || 'null'); } catch (e) {} }
    const pr = new Map(); if (pc && pc.rows) for (const r of pc.rows) pr.set(Number(r.i), r);
    const av = new Map();
    try { const q = await db.prepare('SELECT pid, SUM(rating) AS r, COUNT(*) AS n FROM board_avail WHERE sp=? AND se=? AND at>? GROUP BY pid').bind(sp, se, Date.now() - 14 * 86400000).all();
      for (const x of (q.results || [])) av.set(Number(x.pid), [Math.round(Number(x.r) * 10) / 10, Number(x.n)]); } catch (e) {}
    const out = {};
    for (const id of ids) { const r = pr.get(id), a = av.get(id);
      out[id] = { u: playerUrl(`${sp}:${se}:${id}`), ros: r ? Math.max(0, Math.round(r.pr - r.r)) : null, av: a ? a[0] : 0, an: a ? a[1] : 0 }; }
    return json({ at: pc ? pc.at : null, players: out });
  }
  if (op === 'projections') {
    // Open to everyone (2026-11-27; signed in only from 2026-11-08). Signed out: no "my passes".
    const sp = PROJ_SEASON[url.searchParams.get('sport')] ? url.searchParams.get('sport') : 'ncaaf';
    /* Kept in memory per worker, with the list already turned into text, and
       the saved copy re-read from KV at most once a minute: a crowd opening the
       page costs one KV read a minute, not a full parse and rebuild of
       thousands of rows per open. */
    let m = PROJ_MEM.get(sp);
    if (!m || Date.now() - m.read > 60000) {
      let c0 = null; try { c0 = JSON.parse((await env.RATEBOARD_KV.get(`proj_v3_${sp}`)) || 'null'); } catch (e) {}
      if (c0 && !c0.error) { if (!m || m.c.at !== c0.at) m = projMem(c0); m.read = Date.now(); PROJ_MEM.set(sp, m); }
      else if (m) m.read = Date.now();
      // An injury-list change since the last build: build again (the list isn't in the game data).
      if (m) { try { m.force = Number(await env.RATEBOARD_KV.get(`proj_force_v1_${sp}`)) || 0; } catch (e) {} }
    }
    let c = m ? m.c : null;
    // One player's breakdown (tapping his line).
    const pid = Number(url.searchParams.get('pid'));
    if (pid) { const row = m ? m.byId.get(pid) : null; return json({ row: row || null, ...(await projDetail(env, sp, row, c)) }); }
    const lockK = `proj_lock_v1_${sp}`;
    let stale = !c || (acc.admin && url.searchParams.get('refresh') === '1') || (m && m.force > c.at) || Number(c.zfix || 0) < 4;   // 4 = per-team log cutoff (2026-11-25); zfix: blank-rax 0s counted (2026-11-12); 2 = missed-last-game flag (2026-11-13)
    // Rebuilt when the game data has changed - and at most every 30 minutes while games are coming in.
    if (!stale && Date.now() - c.at > 30 * 60000) { try { stale = (await projSig(env, db, sp)) !== c.sig; } catch (e) { stale = Date.now() - c.at > 24 * 3600000; } }
    if (stale) {
      if (m) m.force = 0;   // this worker asks for the rebuild once
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
    if (!m || m.c !== c) { m = projMem(c); m.read = Date.now(); PROJ_MEM.set(sp, m); }
    if (!c.gd) { try { const k = `proj_gd_v1_${sp}`; let g = await env.RATEBOARD_KV.get(k);
      if (!g) { const r = await db.prepare('SELECT MAX(day) AS d FROM gamelog WHERE sport=? AND season=? AND rax IS NOT NULL').bind(sp, Number(PROJ_SEASON[sp][0])).first(); g = (r && r.d) || ''; if (g) await env.RATEBOARD_KV.put(k, g, { expirationTtl: 1800 }); }
      if (g) c.gd = g; } catch (e) {} }
    const u = me ? await db.prepare('SELECT passes FROM swap_users WHERE key=?').bind(me).first() : null;
    const [se] = PROJ_SEASON[sp];
    // Their passes for this season, with the card's id so a name can open their own card.
    const mine = parse(u && u.passes, []).filter(p => p.sport === sp && Number(p.season) === se && p.kind !== 'team').map(p => [Number(p.id), p.passId ? Number(p.passId) : null]);
    // The list goes out as the text made once per build; only their own passes are added.
    return new Response(`{"at":${c.at},"gd":${JSON.stringify(c.gd || null)},"sport":${JSON.stringify(c.sport)},"season":${c.season},"players":${c.players || 0},"rows":${m.rowsText},"mine":${JSON.stringify(mine)}}`,
      { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
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
    if (sp === 'soccer') {
      // FC: the next days (up to 8 ahead) on which one of the member's clubs or countries plays.
      const u = await db.prepare('SELECT passes FROM swap_users WHERE key=?').bind(me).first();
      const mine = parse(u && u.passes, []).filter(p => p.sport === 'soccer' && p.kind !== 'team');
      const ids = [...new Set(mine.filter(p => Number(p.season) === FC_SEASON[0]).map(p => Number(p.id)).filter(Number.isFinite))];
      const idsM = [...new Set(mine.filter(p => Number(p.season) === FC_MLS_SEASON).map(p => Number(p.id)).filter(Number.isFinite))];
      const fmt = ET_DAY_FMT;
      const today = fmt.format(new Date());
      const { cur, old } = await fcGames(db, ids, '9999-12-31');
      const teamSets = ids.map(id => { const sd = fcSides((cur.get(id) || []).filter(fcPlayed), (old.get(id) || []).filter(x => String(x.conference || '').toUpperCase() !== 'MLS').filter(fcPlayed));
        return { club: sd.club ? fcClubIds(sd.club) : [], clubAb: sd.club && sd.club.team, nat: sd.nat ? fcTeamIds(sd.nat.team, true) : [] }; });
      // MLS cards (FC 2025): his MLS club.
      if (idsM.length) { const { cur: cm } = await fcGames(db, idsM, '9999-12-31', [FC_MLS_SEASON, null]);
        for (const id of idsM) { const ms = (cm.get(id) || []).filter(x => String(x.conference || '').toUpperCase() === 'MLS'); const l = ms[ms.length - 1];
          if (l && FC_MLS[String(l.team).toUpperCase()]) teamSets.push({ club: [String(FC_MLS[String(l.team).toUpperCase()])], clubAb: null, nat: [] }); } }
      const days = [];
      for (let i = 0; i < 8 && days.length < 4; i++) {
        const d = fmt.format(new Date(Date.now() + i * 86400000));
        // Saved copies only past the 4 days the refresh keeps (a missing one is fetched once and saved for everyone).
        const sc = await fcSchedule(env, d).catch(() => null); if (!sc || sc.error) continue;
        const n = teamSets.filter(t => t.club.some(id => sc.teams[id]) || t.nat.some(id => sc.teams[id]) || (!t.club.length && t.clubAb && Object.values(sc.teams).some(x => x.ab === t.clubAb))).length;
        if (n) days.push({ day: d, players: n, games: sc.games });
      }
      return json({ days, passes: ids.length + idsM.length, today });
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
    const fmt = ET_DAY_FMT;
    const cand = [...Array(12).keys()].map(i => fmt.format(new Date(Date.now() + i * 86400000)));
    const scheds = await Promise.all(cand.map(d => boostSchedule(env, sp, d).catch(() => ({ error: 1 }))));
    const days = [];
    cand.forEach((d, i) => { const sc = scheds[i]; if (!sc || sc.error || days.length >= 4) return;
      const n = teamOf.filter(t => sc.teams && sc.teams[t]).length; if (n) days.push({ day: d, players: n }); });
    return json({ days, passes: ids.length });
  }
  if (op === 'boostplan') {
    const sp = String(url.searchParams.get('sport') || '');
    if (!BOOST_SEASON[sp] && sp !== 'golf' && sp !== 'soccer') return json({ error: 'Pick CBB, CFB, NFL, NBA, NHL, Golf or FC.' }, 400);
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
    const [se, prev] = sp === 'golf' ? GOLF_SEASON : sp === 'soccer' ? FC_SEASON : BOOST_SEASON[sp];
    // What they own: the passes from their last scan (the same read Swaps
    // uses). Rarity and pass level are not counted.
    const u = await db.prepare('SELECT passes, scannedAt, rsUser FROM swap_users WHERE key=?').bind(me).first();
    if (!u || !u.passes) return json({ error: 'Scan your passes first.' }, 400);
    const cards = { at: u.scannedAt || null, players: parse(u.passes, [])
      .filter(p => p.sport === sp && (Number(p.season) === se || (sp === 'soccer' && Number(p.season) === FC_MLS_SEASON)) && p.kind !== 'team')   // FC: 2025 cards for MLS
      .map(p => ({ id: Number(p.id), name: p.name || '', passId: p.passId || null, season: Number(p.season),
        mult: cardMultOf(p), levelLabel: p.levelLabel || null })) };   // the card's own rarity multiplier, for "Include my card rarities" (2026-11-09)
    let sched = null, depth = null, inv = null, rows = [], idle = [], invAt = null, binvMsg = null;
    if (sp === 'golf') {
      // Golf: the tournament is the game; form plus course history (see golfRows).
      const gr = await golfRows(env, db, cards, day);
      if (gr.error) return json({ error: gr.error }, 404);
      ({ sched, rows, idle } = gr);
      // Their golf boosters, read with the other sports' (caps the plan at what they hold).
      try { const uu = await db.prepare('SELECT hashId FROM swap_users WHERE key=?').bind(me).first();
        if (uu && uu.hashId) { const r = await boostInventorySport(env, env.RS_AUTH_TOKEN || auth, uu.hashId, 'golf', url.origin); invAt = r.at || null; if (!r.error && r.list && r.list.length) inv = r.list; } } catch (e) {}
    } else if (sp === 'soccer') {
      // FC: ESPN's slate and lineups, the game log's starts (see fcRows). Boosters first - the stat counts follow them.
      try { const uu = await db.prepare('SELECT hashId FROM swap_users WHERE key=?').bind(me).first();
        if (uu && uu.hashId) { const r = await boostInventorySport(env, env.RS_AUTH_TOKEN || auth, uu.hashId, 'soccer', url.origin); invAt = r.at || null; if (!r.error && r.list && r.list.length) inv = r.list; } } catch (e) {}
      const fr = await fcRows(env, db, cards, day, inv);
      if (fr.error) return json({ error: fr.error }, 502);
      ({ sched, rows, idle } = fr);
      // "Hide games that already started" (Dennis, 2026-11-07): those players come off before boosters are handed out, so they go to games still to come.
      if (url.searchParams.get('upcoming') === '1') { const now = Date.now(), gone = rows.filter(r => r.at && Date.parse(r.at) <= now); rows = rows.filter(r => !gone.includes(r)); sched.started = gone.length; }
    } else {
      sched = await boostSchedule(env, sp, day);
      if (sched.error) return json({ error: sched.error }, 502);
      const inj = await boostInjuries(env, sp);
      // The hand list wins over ESPN's (college lists are nearly empty).
      try { Object.assign(inj, await boostManualOut(env, sp, day)); } catch (e) {}
      // Game-by-game for this season and averages for last, from the game log.
      const ids = [...new Set(cards.players.map(p => Number(p.id)).filter(Number.isFinite))];
      const games = new Map(), old = new Map();
      /* A game he sat out isn't a game (2026-11-11: Luka read as 93 rax in 12
         games, 7.8 a game, when he'd played 10 - 9.3). Out = no minutes, or
         no minutes and no stats at all where minutes aren't kept. */
      // Only where minutes are kept (NBA, CBB, FC): NHL, NFL and CFB store 0 minutes for every game (2026-11-11: that read as every game sat out, and their boosts went blank).
      const minSp = sp === 'nba' || sp === 'ncaam' || sp === 'soccer' || sp === 'wnba';
      const sat = x => (minSp && x.min != null && Number(x.min) <= 0)
        || ((sp === 'ncaaf' || sp === 'nfl') && !x.stats && !(Number(x.rax) > 0));   // football: no stats, no rax = sat out (Toney, 2026-11-13)
      for (let i = 0; i < ids.length; i += 90) {
        const part = ids.slice(i, i + 90), ph = part.map(() => '?').join(',');
        try {
          const r = await db.prepare(`SELECT playerId, day, rax, min, team, position, player, pts, reb, ast, stl, blk, fg3${sp === 'ncaam' ? '' : ', stats'} FROM gamelog
            WHERE sport=? AND season=? AND rax IS NOT NULL AND COALESCE(seasonType, 'regularseason') <> 'preseason' AND playerId IN (${ph}) ORDER BY day`).bind(sp, se, ...part).all();   // no preseason (2026-11-09: five 0s each pulled NBA stars down)
          for (const x of (r.results || [])) if (!sat(x)) (games.get(Number(x.playerId)) || games.set(Number(x.playerId), []).get(Number(x.playerId))).push(x);
        } catch (e) {}
        try {
          const r = await db.prepare(`SELECT playerId, team, position, day, rax, min, player, pts, reb, ast, stl, blk, fg3${sp === 'ncaam' ? '' : ', stats'} FROM gamelog
            WHERE sport=? AND season=? AND rax IS NOT NULL AND seasonType='regularseason' AND playerId IN (${ph}) ORDER BY day`).bind(sp, prev, ...part).all();
          for (const x of (r.results || [])) { if (sat(x)) continue; const k = Number(x.playerId); const o = old.get(k) || { rows: [] }; o.rows.push(x); old.set(k, o); }
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
        let force = url.searchParams.get('binv') === '1';
        if (force && !(await allow(url.origin, 'binv:' + me, 4, 600))) { force = false; binvMsg = 'Re-read limit: 4 every 10 minutes'; }
        if (uu && uu.hashId) { const r = await boostInventorySport(env, env.RS_AUTH_TOKEN || auth, uu.hashId, sp, url.origin, force); invAt = r.at || null; if (!r.error) inv = r.list; } } catch (e) {}
      // Current teams from ESPN's rosters (CBB: transfers and freshmen), and
      // how much each opponent gave up last season and this one.
      let roster = {}, match = {};
      if (sp === 'ncaam') { try { roster = (JSON.parse((await env.RATEBOARD_KV.get('boostrostermap_v1_ncaam')) || 'null') || {}).m || {}; } catch (e) {} }
      // NFL: today's rosters, so a trade counts before he plays for his new team.
      let nflRos = null;
      if (sp === 'nfl') { try { nflRos = JSON.parse((await env.RATEBOARD_KV.get('boostrostermap_v1_nfl')) || 'null'); } catch (e) {}
        if (!nflRos || Date.now() - nflRos.at > 12 * 3600000) { try { await nflRosters(env); nflRos = JSON.parse((await env.RATEBOARD_KV.get('boostrostermap_v1_nfl')) || 'null'); } catch (e) {} } }
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
      /* Football: each team's latest game in the log, so a player who sat out
         his team's last game is caught even with no injury report (2026-11-13:
         Malachi Toney, Miami - out with an ankle, missed Notre Dame, CFB has no
         injury list, and his last game was inside the 15 days). */
      let teamLast = {};
      if (sp === 'ncaaf' || sp === 'nfl') {
        const tk = `boostteamlast_v1_${sp}`;
        try { const c = JSON.parse((await env.RATEBOARD_KV.get(tk)) || 'null'); if (c && Date.now() - c.at < 30 * 60000) teamLast = c.m; else throw 0; }
        catch (e) { try { const from = new Date(Date.now() - 21 * 86400000).toISOString().slice(0, 10);
          const r = await db.prepare(`SELECT team, MAX(day) AS d FROM gamelog WHERE sport=? AND season=? AND day >= ? AND team IS NOT NULL GROUP BY team`).bind(sp, se, from).all();
          teamLast = {}; for (const x of (r.results || [])) teamLast[x.team] = x.d;
          await env.RATEBOARD_KV.put(tk, JSON.stringify({ at: Date.now(), m: teamLast }), { expirationTtl: 3600 }); } catch (e2) {} }
      }
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
        let team = (lastG && lastG.team) || listTeam || (ros && ros.ab) || (o && o.team) || null;
        // NFL: on a different team's roster now (traded or signed) - that team's game, not his old one.
        let tAb = teamAb, moved = null;
        if (nflRos && nflRos.m) {
          const opts = nflRos.m[boostName(name)] || [], pos0 = String((lastG && lastG.position) || (o && o.position) || '').toUpperCase();
          const same = opts.some(x => boostAlias(sp, x.ab) === tAb);
          const pick = opts.filter(x => !pos0 || String(x.pos).toUpperCase() === pos0);
          const cand = pick.length ? pick : opts;   // Real and ESPN name defensive spots differently
          if (!same && cand.length === 1) { const nx = cand[0]; moved = { from: team, to: nx.ab }; tAb = boostAlias(sp, nx.ab); team = nx.ab; }
        }
        const g = tAb ? sched.teams[tAb] : null;
        if (!g) { idle.push(name); continue; }
        const pos = (lastG && lastG.position) || (o && o.position) || (ros && ros.pos) || '';
        const mf = g.oppAb && match[g.oppAb] ? match[g.oppAb] : 1;
        const ca = avg(gs), r4 = avg(gs.slice(-4)), oa = o ? Number(o.avg) : null, cg = gs.length;
        let proj = null, basis = '';
        // NBA / NHL: rax runs far higher this season than last, so once he has 8 games last season is left out (2026-11-09).
        if (cg >= 8 && (sp === 'nba' || sp === 'nhl')) { proj = 0.45 * r4 + 0.55 * ca; basis = `last 4 games weighted, ${cg} this season`; }
        else if (cg >= 4) { proj = oa != null ? 0.5 * r4 + 0.3 * ca + 0.2 * oa : 0.6 * r4 + 0.4 * ca; basis = `last 4 games weighted, ${cg} this season`; }
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
        if (moved) flags.push(`Now with ${moved.to} (his last game was for ${moved.from})`);
        // On no NFL roster at all (released, or on a practice squad): no booster.
        if (sp === 'nfl' && nflRos && nflRos.m && Object.keys(nflRos.m).length > 1500 && !(nflRos.m[boostName(name)] || []).length) { skip = true; flags.push('Not on an NFL roster (released or practice squad)'); }
        // Injury report.
        const ij = injOf(inj, name, g && g.id);
        if (ij) {
          if (/^(out|injured reserve|doubtful|suspension)/i.test(ij.status)) { skip = true; flags.push(`${ij.status}${ij.note ? ': ' + ij.note : ''}`); }
          else if (/questionable|day-to-day/i.test(ij.status)) { k *= Q_CUT; flags.push(`${/day/i.test(ij.status) ? 'Day-to-day' : 'Questionable'}${ij.note ? ': ' + ij.note : ''}`); }
        }
        // Starter or not.
        if (depth) {
          const d = depth[boostName(name)];
          if (d && !d.starter) { skip = true; flags.push(`Backup (${d.pos.toUpperCase()}${d.slot})`); }
        }
        // Hasn't been playing: no game in the last 15 days of a season under way (football).
        if (sp !== 'ncaam' && cg && lastG && dayMs - Date.parse(lastG.day + 'T12:00:00Z') > 15 * 86400000) { skip = true; flags.push(`No game since ${lastG.day}`); }
        // Football: sat out his team's last game (and wasn't traded) - likely hurt, no booster.
        else if (!skip && !moved && (sp === 'ncaaf' || sp === 'nfl') && cg >= 2 && lastG && lastG.team && teamLast[lastG.team] && teamLast[lastG.team] > lastG.day && teamLast[lastG.team] < day) {
          skip = true; flags.push(`Missed his team's last game (${teamLast[lastG.team]}) - likely hurt`);
        }
        if (sp !== 'ncaam' && !cg && o) { k *= 0.6; flags.push('No games this season yet'); }
        // Basketball minutes: recent ones if there are any, else last season's.
        if (sp === 'ncaam' || sp === 'nba') {
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
        rows.push({ id: p.id, passId: p.passId, pm: p.mult || null, plv: p.levelLabel || null, name, team, tid: g.id, pos, opp: g.opp, home: g.home, at: g.at, exp,
          avg: ca == null ? null : Math.round(ca * 10) / 10, games: cg, avgLast: oa == null ? null : Math.round(oa * 10) / 10,
          proj: proj == null ? null : Math.round(proj * k * mf * 10) / 10, basis, flags, skip, fresh, noData });
      }
    }
    /* Each team's own injury list too (the league list misses some, like a
       star placed on IR mid-week): out, IR, doubtful or suspended - no booster. */
    try {
      const tinj = await boostTeamInj(env, sp, rows.map(r => r.tid));
      for (const r of rows) {
        const ij = injOf(tinj, r.name, r.tid); if (!ij || r.skip) continue;
        if (/^(out|injured reserve|doubtful|suspen)/i.test(ij.status)) { r.skip = true; r.flags.push(ij.status); }
        else if (/questionable|day-to-day/i.test(ij.status) && !r.flags.some(f => /^(questionable|day-to-day)/i.test(f))) {
          r.flags.push(/day/i.test(ij.status) ? 'Day-to-day' : 'Questionable');
          if (r.proj != null) r.proj = Math.round(r.proj * Q_CUT * 10) / 10;
          for (const st of Object.keys(r.exp)) r.exp[st] = Math.round(r.exp[st] * Q_CUT * 100) / 100;
        }
      }
    } catch (e) {}
    // "Hide games that already started", every sport (Dennis, 2026-11-09; FC had it already, above):
    // those players come off before boosters are handed out, so they go to games still to come.
    if (sp !== 'soccer' && url.searchParams.get('upcoming') === '1') { const now = Date.now(), n0 = rows.length; rows = rows.filter(r => !(r.at && Date.parse(r.at) <= now)); if (sched) sched.started = n0 - rows.length; }
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
    const spread = url.searchParams.get('spread') !== '0';
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
    /* FC (2026-11-07): rax in a start, this season - half of starters make 6+,
       the top 10% 10.7+, the top 3% 13+, the very best (Yamal, Raphinha, Olise)
       17-19. Games most days, so Legendaries are held back a little. */
    // Bars moved with the steadier projection (2026-11-07) so the same share of starters clears each: Legendary ~top 4%, Epic ~top 15%.
    const FC_RULES = { balanced: { leg: 11.2, epic: 9, cap: 0.5 }, heavy: { leg: 9.8, epic: 7.8, cap: 1 }, saver: { leg: 13, epic: 10.5, cap: 0.25 } };
    /* NFL (Dennis, 2026-11-08): Balanced is Legendary 22.5+ (up to 35% of the
       Legendaries held), Epic 17+, Rare 7+. Heavy and Saver keep the scaled CBB bars. */
    const NFL_RULES = { balanced: { leg: 22.5, epic: 17, cap: 0.35 }, heavy: { leg: 11.5 * 1.65, epic: 9 * 1.65, cap: 0.4 }, saver: { leg: 18 * 1.65, epic: 14.5 * 1.65, cap: 1 } };
    /* NBA and NHL (Dennis, 2026-11-09): games almost every day all season, so
       boosters are rationed - Legendary very hard to get (only the very top
       projections, at most 1 a day), Epic at most 2 a day, and Rares at most
       10% of those held a day (1 to 6), so they can't all go at once. Bars on
       projected rax in the game, from last season's averages among regulars:
       NBA top 1% ~4.0, top 5% ~3.1, top 25% ~1.7; NHL top 1% ~5.5, top 5% ~4.2,
       top 25% ~2.5. */
    // Dennis (2026-11-09, same morning): too low - Legendary 7+ (1 a day), Epic 5+ (2 a day), Rare 3.5+ (20% of Rares held a day), both leagues, every setting.
    // Dennis (2026-11-09 5:18am): both leagues - Balanced never uses a Legendary, Epic 7.5+ (2 a day), Rare 4+ (20% a day).
    const NBA_RULES = { balanced: { leg: Infinity, epic: 7.5, cap: 0 } };
    const NHL_RULES = NBA_RULES;
    const cfb = sp === 'ncaaf' ? CFB_RULES[mode] || CFB_RULES.balanced : sp === 'golf' ? GOLF_RULES[mode] || GOLF_RULES.balanced : sp === 'soccer' ? FC_RULES[mode] || FC_RULES.balanced : sp === 'nfl' ? NFL_RULES[mode] || NFL_RULES.balanced
      : sp === 'nba' ? NBA_RULES[mode] || NBA_RULES.balanced : sp === 'nhl' ? NHL_RULES[mode] || NHL_RULES.balanced : null;
    if (cfb) R.cap = cfb.cap;
    let legBar = cfb ? cfb.leg : R.leg * scale, epicBar = cfb ? cfb.epic : R.epic * scale, rareFloor = sp === 'ncaaf' || sp === 'golf' ? 10 : sp === 'soccer' ? 6 : sp === 'nfl' && mode === 'balanced' ? 7 : sp === 'nba' || sp === 'nhl' ? 4 : 5;
    const cutAt = null;
    if (CUS) { legBar = CUS.leg ?? Infinity; epicBar = CUS.epic ?? Infinity; rareFloor = CUS.rare ?? Infinity; }
    bars.splice(0, 3, Math.round(legBar * 10) / 10, Math.round(epicBar * 10) / 10, rareFloor);
    const held = r => inv ? inv.filter(b => b.rarity === r).reduce((t, b) => t + b.count, 0) : 0;
    const dayCap = CUS ? { 5: CUS.max[5] ?? Infinity, 4: CUS.max[4] ?? Infinity, 3: CUS.max[3] ?? Infinity }
      : { 5: held(5) ? Math.max(1, Math.floor(held(5) * R.cap)) : 0, 4: Infinity, 3: Infinity };
    // NBA / NHL daily most, whatever the setting (Custom can only go lower).
    /* Custom sets its own Epic and Rare maxes on NBA/NHL (2026-11-19, member: "can't get it to give me more than 2 epic
       boosts" with Custom) - blank still means no limit. The set modes keep 2 Epic; Legendary stays at most 1. */
    // Custom is theirs (Dennis, 2026-11-27): no 1-Legendary limit, only their own Max.
    if (sp === 'nba' || sp === 'nhl') { if (!CUS) dayCap[5] = 0;
      if (!CUS) { dayCap[4] = Math.min(dayCap[4], 2); dayCap[3] = Math.min(dayCap[3], inv ? Math.max(1, Math.floor(held(3) * 0.2)) : 6); } }
    const usedR = { 5: 0, 4: 0, 3: 0 };
    // Custom maxes hold even when Real won't say what boosters they have.
    const capped = !!CUS || sp === 'nba' || sp === 'nhl';
    const own = r => left ? Math.min(held(r), dayCap[r]) - usedR[r] : capped ? dayCap[r] - usedR[r] : Infinity;
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
      while (want && (left || capped) && own(want) <= 0) want = want > 3 ? want - 1 : null;
      r.boost = want ? NR[want] : null;
      r._r = want;
      if (want && (left || capped)) usedR[want]++;
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
      const g0 = (r, b) => { const x = gainOf(r, b); return x ? x.g : 0; };
      /* Use spare types (member feedback via Dennis, 2026-11-17): most of a boost is the rarity multiplier,
         the attribute only adds a little, but always taking the best attribute burned points / goals boosters
         and left piles of saves and the like. Choosing weighs each type by how many of it you hold against the
         others of that rarity, so a plentiful type gets used when it's nearly as good. spread=0 turns it off. */
      const n0 = new Map(groups.map(b => [b, b.count])), mean = groups.reduce((t, b) => t + b.count, 0) / groups.length;
      const wOf = b => spread && groups.length > 1 && mean > 0 ? Math.min(1.25, Math.max(0.6, Math.pow(n0.get(b) / mean, 0.4))) : 1;
      const g = (r, b) => g0(r, b) * wOf(b);
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
        const alt = groups.filter(x => x !== b).map(x => ({ x, v: g0(r, x) })).sort((p, q) => q.v - p.v)[0];
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

    return json({ sport: sp, season: se, date: day, mode, binvMsg: binvMsg || undefined, bars: bars.map(x => Number.isFinite(x) ? x : null), cutAt, totals, lineups: sched.lineups ?? null, lineupsAt: sched.lineupsAt || null, started: sched.started ?? null, legCap: inv && Number.isFinite(dayCap[5]) ? dayCap[5] : null, inv: used, statMode: !!used, rsUser: u.rsUser, cardsAt: cards.at, invAt, games: sched.games, event: sched.event || null, course: sched.course || null, field: sched.field ?? null, depth: !!depth,
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
    await stat(db, 'verify_try'); if (c) { await stat(db, 'verify_ok'); await db.prepare(VER_DDL).run(); await db.prepare('INSERT OR REPLACE INTO swap_ver (hashId, key, at) VALUES (?, ?, ?)').bind(u.hashId, String(me).toLowerCase(), Date.now()).run(); }
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

/* One-off (2026-11-10, Dennis: "25 seconds a scan seems excessive"): does Real
   hand back passes for more than one season or sport in one call? A full scan
   is 76 calls, one per sport, season and kind. A few reads of Dennis's own
   passes, 2 seconds apart, results kept in KV for the health page. */
/* One-off (2026-11-12): a member was matched to give passes he set
   untouchable on Real. Does the one-call pass read carry Real's untouchable
   flag (and under which name), next to the per-sport read? Counts only. */
export async function untouchProbe(env, db) {
  const K = 'diag_untouch_1112';
  try { const o = JSON.parse((await env.RATEBOARD_KV.get(K)) || 'null'); if (o && (o.done || Date.now() - (o.at || 0) < 10 * 60000)) return; await env.RATEBOARD_KV.put(K, JSON.stringify({ at: Date.now(), running: 1 }), { expirationTtl: 3 * 86400 }); } catch (e) { return; }
  const out = { at: Date.now() };
  try {
    const u = await db.prepare("SELECT hashId FROM swap_users WHERE key='dennis'").first();
    const tok = scanTok(env); const base = `https://web.realapp.com/userpasses/${encodeURIComponent(u.hashId)}/passes`;
    const look = rows => { const keys = {}; let n = 0;
      const walk = (o, path, depth) => { if (!o || typeof o !== 'object' || depth > 3) return;
        for (const [k, v] of Object.entries(o)) { if (/untouch|lock|protect|tradeable|tradable/i.test(k)) { const kk = path + k + '=' + JSON.stringify(v).slice(0, 20); keys[kk] = (keys[kk] || 0) + 1; }
          if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, path + k + '.', depth + 1); } };
      for (const r of rows) { n++; walk(r, '', 0); } return { n, keys }; };
    for (const q of ['', 'entityType=player&season=2026&sport=nhl']) {
      const r = await fetch(base + (q ? '?' + q : ''), { headers: rsHeaders(tok) }); const d = await r.json().catch(() => null);
      out[q || 'onecall'] = { st: r.status, ...look((d && d.passes) || []) };
    }
    const c = await db.prepare(`SELECT COUNT(*) AS n FROM swap_users WHERE passes LIKE '%"untouchable":1%'`).first();
    out.membersWithUntouchableSaved = c && c.n;
    out.done = 1;
  } catch (e) { out.err = String(e.message || e).slice(0, 150); }
  try { await env.RATEBOARD_KV.put(K, JSON.stringify(out), { expirationTtl: 3 * 86400 }); } catch (e) {}
}

/* One-off (2026-11-12): one member's swaps today that give a pass he keeps
   or has untouchable - when each was made against when his keeps last
   changed. Counts and times only (no names) for the health page. */
export async function keepProbe(env, db) {
  const K = 'diag_keep_1112';
  try { const o = JSON.parse((await env.RATEBOARD_KV.get(K)) || 'null'); if (o && o.done) return; } catch (e) {}
  const out = { at: Date.now() };
  try {
    const u = await db.prepare("SELECT key, keep, touch, passes, updatedAt, untouchAt FROM swap_users WHERE LOWER(key)='uawheel'").first();
    if (!u) throw new Error('no member');
    const keep = new Set(parse(u.keep, [])), touch = new Set(parse(u.touch, [])), ps = parse(u.passes, []);
    const un = new Set(ps.filter(p => p.untouchable && !touch.has(p.key)).map(p => p.key));
    out.keepN = keep.size; out.untouchN = un.size; out.touchN = touch.size; out.passN = ps.length; out.updatedAt = u.updatedAt;
    const ms = ((await db.prepare(`SELECT * FROM swap_matches WHERE (a=? OR b=?) AND dueAt > ?`).bind(u.key, u.key, Date.now() - 20 * 3600000).all()).results) || [];
    out.matches = ms.map(m => { const gives = m.a === u.key ? m.bGets : m.aGets;
      return { st: m.status, made: m.createdAt, due: m.dueAt, warned: !!(m.warnA || m.warnB), kept: keep.has(gives), untouch: un.has(gives), touched: touch.has(gives),
        stored: (ps.find(p => p.key === gives) || {}).untouchable ? 1 : 0, sp: String(gives).split(':').slice(0, 2).join(':') }; })
      .filter(x => x.kept || x.untouch || x.touched || x.stored);
    out.allMatches = ms.length;
    out.done = 1;
  } catch (e) { out.err = String(e.message || e).slice(0, 150); }
  try { await env.RATEBOARD_KV.put(K, JSON.stringify(out), { expirationTtl: 2 * 86400 }); } catch (e) {}
}

/* One-off (2026-11-12 08:50 AK): Dennis got a "You have 6 swaps" DM with no swaps active. His own swaps around now (counts and times only). */
/* Dennis's own Real profile picture (2026-11-19, Dennis: "my real pfp, check if you can fetch it").
   Looks his account up once with his own token (account 1) and keeps the picture link in KV for the
   Graphics page. Health shows only whether it was found and the image host, not the link. */
export async function pfpProbe(env, db) {
  const K = 'gfx_pfp_dennis4';
  try { if (await env.RATEBOARD_KV.get(K)) return; await env.RATEBOARD_KV.put(K, JSON.stringify({ running: 1, at: Date.now() }), { expirationTtl: 3600 }); } catch (e) { return; }
  const out = { at: Date.now() };
  try {
    const u = await db.prepare("SELECT rsUser FROM swap_users WHERE key='dennis'").first();
    const name = (u && u.rsUser) || 'dennis';
    const d = await rsGetJson(`https://web.realapp.com/searchusers?query=${encodeURIComponent(name)}`, env.RS_AUTH_TOKEN);
    const f = ((d && d.users) || []).find(x => String(x.userName || '').toLowerCase() === String(name).toLowerCase());
    out.matched = !!f;
    if (f) {
      out.fields = Object.keys(f).filter(k => /image|pic|avatar|photo/i.test(k));
      for (const k of out.fields) { const v = f[k]; if (typeof v === 'string' && /^https?:\/\//.test(v)) { out.field = k; out.url = v; break; } }
      if (!out.url && out.fields.length) { out.raw = String(f[out.fields[0]] ?? '').slice(0, 300);
        out.shape = out.raw.replace(/[a-z]/g, 'a').replace(/[A-Z]/g, 'A').replace(/[0-9]/g, '9').slice(0, 80); }
      // avatarKey is a storage key, not a link: follow realapp.com's web app code to where it builds
      // image links (media.realapp.com), then try the likely links.
      if (!out.url && out.raw) {
        const key = out.raw, uid = f.id;
        try {
          const BASE = 'https://www.realapp.com/', seen = new Set(), queue = [];
          const html = await (await fetch(BASE, { headers: { 'User-Agent': rsHeaders('')['User-Agent'] } })).text();
          for (const m of html.matchAll(/(?:src|href)=["']([^"']+\.m?js[^"']*)["']/g)) queue.push(new URL(m[1], BASE).href);
          out.ctx = []; out.files = 0;
          while (queue.length && out.files < 60 && out.ctx.length < 8) {
            const u = queue.shift(); if (seen.has(u)) continue; seen.add(u);
            let t = ''; try { t = await (await fetch(u)).text(); } catch (e) { continue; } out.files++;
            for (const m of t.matchAll(/["'`(]((?:\.{0,2}\/|https:\/\/[a-z.]*realapp\.com\/)[A-Za-z0-9_\-./]+\.js)["'`)]/g)) { try { const v = new URL(m[1], u).href; if (!seen.has(v)) queue.push(v); } catch (e) {} }
            for (const m of t.matchAll(/avatarKey|media\.realapp\.com/g)) { out.ctx.push(t.slice(Math.max(0, m.index - 160), m.index + 160)); if (out.ctx.length >= 8) break; }
          }
        } catch (e) { out.jsErr = String(e.message || e).slice(0, 120); }
        out.tries = [];
        const cands = [`avatars/${uid}/${key}`, `avatar/${uid}/${key}`, `users/${uid}/avatars/${key}`, `users/${uid}/${key}`, `avatars/${key}`, `avatar/${key}`, `profile/${uid}/${key}`, `useravatars/${uid}/${key}`];
        for (const c of cands) for (const ext of ['', '.jpg', '.png', '.webp']) {
          const u = 'https://media.realapp.com/' + c + ext;
          try { const r = await fetch(u); const ty = r.headers.get('content-type') || '';
            out.tries.push(c.replace(String(uid), '{id}').replace(key, '{key}') + ext + ' ' + r.status);
            if (r.ok && /^image\//.test(ty)) { out.url = u; out.imgType = ty; out.host = 'media.realapp.com'; out.field = 'avatarKey'; break; } } catch (e) {}
          if (out.url) break; }
      }
    }
  } catch (e) { out.err = String(e.message || e).slice(0, 150); }
  try { await env.RATEBOARD_KV.put(K, JSON.stringify(out)); } catch (e) {}
}

export async function dennisProbe(env, db) {
  const K = 'diag_dennis_1112b';
  try { if (await env.RATEBOARD_KV.get(K)) return; } catch (e) { return; }
  const out = { at: Date.now() };
  try {
    const u = await db.prepare("SELECT active, confirmDay, updatedAt, slots, sched FROM swap_users WHERE key='dennis'").first();
    out.user = u ? { active: u.active, confirmDay: u.confirmDay, updatedAt: u.updatedAt, slots: u.slots, sched: String(u.sched || '').slice(0, 300) } : null;
    const ms = ((await db.prepare("SELECT id, a, b, status, createdAt, dueAt, slot, warnA, warnB, note FROM swap_matches WHERE (a='dennis' OR b='dennis') AND createdAt > ?").bind(Date.now() - 6 * 3600000).all()).results) || [];
    out.matches = ms.map(m => ({ id: m.id, st: m.status, made: m.createdAt, due: m.dueAt, slot: m.slot, side: m.a === 'dennis' ? 'a' : 'b', warned: m.a === 'dennis' ? m.warnA : m.warnB, note: String(m.note || '').replace(/@\S+/g, '@x').slice(0, 80) }));
    const q = ((await db.prepare("SELECT label, at, tries FROM dm_retry ORDER BY id LIMIT 40").all()).results) || [];
    out.retryQueue = q.map(r => ({ l: String(r.label || '').replace(/\s\S+$/, ''), at: r.at, t: r.tries }));
  } catch (e) { out.err = String(e.message || e).slice(0, 150); }
  try { await env.RATEBOARD_KV.put(K, JSON.stringify(out), { expirationTtl: 86400 }); } catch (e) {}
}

/* One-off (2026-11-12): where members are, for picking a server region -
   time zone counts only (from the hours they set on Swaps). Runs once. */
export async function tzProbe(env, db) {
  const K = 'diag_tz_1112';
  try { if (await env.RATEBOARD_KV.get(K)) return; await env.RATEBOARD_KV.put(K, JSON.stringify({ running: 1, at: Date.now() })); } catch (e) { return; }
  const out = { at: Date.now(), tz: {}, active: {} };
  try {
    const rows = ((await db.prepare("SELECT active, sched FROM swap_users WHERE sched IS NOT NULL").all()).results) || [];
    for (const r of rows) { let z = 'unknown'; try { z = (JSON.parse(r.sched) || {}).tz || 'unknown'; } catch (e) {}
      out.tz[z] = (out.tz[z] || 0) + 1; if (r.active) out.active[z] = (out.active[z] || 0) + 1; }
    out.n = rows.length; out.done = 1;
  } catch (e) { out.err = String(e.message || e).slice(0, 150); }
  try { await env.RATEBOARD_KV.put(K, JSON.stringify(out)); } catch (e) {}
}

export async function scanProbe(env, db) {
  const K = 'diag_scanprobe_1110';
  try { if (await env.RATEBOARD_KV.get(K)) return; await env.RATEBOARD_KV.put(K, JSON.stringify({ at: Date.now(), running: true }), { expirationTtl: 3 * 86400 }); } catch (e) { return; }
  const out = { at: Date.now(), tries: [] };
  try {
    const u = await db.prepare("SELECT hashId FROM swap_users WHERE key='dennis'").first();
    const tok = scanTok(env); if (!u || !u.hashId || !tok) throw new Error('no hashId or token');
    const base = `https://web.realapp.com/userpasses/${encodeURIComponent(u.hashId)}/passes`;
    for (const q of ['entityType=player&season=2026&sport=nfl', 'entityType=player&sport=nfl', 'entityType=player', 'season=2026&sport=nfl', '', 'entityType=player&season=2026&sport=nfl&limit=500']) {
      const t0 = Date.now(); let st = 0, n = null, keys = null, combos = null, cur = null, err = null;
      try { const r = await fetch(base + (q ? '?' + q : ''), { headers: rsHeaders(tok) }); st = r.status; const tx = await r.text();
        let d = null; try { d = JSON.parse(tx); } catch (e) { err = tx.slice(0, 80); }
        if (d) { const rows = rowsOf(d); n = rows.length; keys = Array.isArray(d) ? 'array' : Object.keys(d).slice(0, 12).join(',');
          const c = new Set(); for (const x of rows) { const p = x && (x.pass || x.entity || x); c.add([x.sport || (p && p.sport) || '?', x.season || (p && p.season) || '?', x.entityType || (p && p.entityType) || '?'].join(':')); }
          combos = [...c].slice(0, 15); cur = passCursor(d) || null; if (st >= 400) err = tx.slice(0, 100); } } catch (e) { err = String(e.message || e).slice(0, 100); }
      out.tries.push({ q: q || '(none)', st, ms: Date.now() - t0, n, keys, combos, cur: cur ? String(cur).slice(0, 30) : null, err });
      await sleep(2000);
    }
  } catch (e) { out.err = String(e.message || e).slice(0, 150); }
  try { await env.RATEBOARD_KV.put(K, JSON.stringify(out), { expirationTtl: 3 * 86400 }); } catch (e) {}
}

// One-off (2026-11-10): do booster reads take a season? (cdeck24's CBB showed 4, Real's 2026-27 page 1.)
export async function boostProbe(env, db) {
  /* Boosters are shared by every season (Dennis), so a season filter isn't it.
     What each booster entry carries, raw, for Dennis's CBB: is a booster that's
     already on a card for today still in "count"? (Real's card page shows 22
     Rare to apply; Boosts recommended 24.) */
  const K = 'diag_boostprobe_1110d';
  try { const o = JSON.parse((await env.RATEBOARD_KV.get(K)) || 'null'); if (o && (o.ok || Date.now() - (o.at || 0) < 10 * 60000)) return; await env.RATEBOARD_KV.put(K, JSON.stringify({ running: 1, at: Date.now() }), { expirationTtl: 3 * 86400 }); } catch (e) { return; }
  const out = { at: Date.now() };
  try {
    const u = await db.prepare("SELECT hashId FROM swap_users WHERE key='dennis'").first();
    const tok = env.RS_AUTH_TOKEN || scanTok(env);
    const r = await fetch(`https://web.realapp.com/userpassboostercards/undefined/entity/player?displayType=collectionstats&sport=ncaam&userId=${encodeURIComponent(u.hashId)}&version=stat`, { headers: rsHeaders(tok) });
    out.st = r.status; const t = await r.text(); let d = null; try { d = JSON.parse(t); } catch (e) {}
    const info = (d && d.boosterCardInfo) || {};
    out.topKeys = d ? Object.keys(d) : t.slice(0, 100);
    out.infoKeys = Object.keys(info);
    out.groups = (info.rarityGroups || []).map(g => ({ g: Object.fromEntries(Object.entries(g).filter(([k]) => k !== 'statBoostKeyInfo')), items: (g.statBoostKeyInfo || []).slice(0, 6) }));
    out.raw = JSON.stringify(info).slice(0, 3500);
    out.ok = r.status === 200;
  } catch (e) { out.err = String(e.message || e).slice(0, 150); }
  try { await env.RATEBOARD_KV.put(K, JSON.stringify(out), { expirationTtl: 3 * 86400 }); } catch (e) {}
}

/* One-off (Dennis, 2026-11-10): Wilt Chamberlain's 1961-62 (Real season 1962) -
   his game feed (ratings) and what a pass earned (rax). Tries again every 10
   minutes until Real answers (its 429s). */
export async function wiltProbe(env) {
  const K = 'diag_wilt_1962b';
  try { const o = JSON.parse((await env.RATEBOARD_KV.get(K)) || 'null'); if (o && (o.ok || Date.now() - (o.at || 0) < 10 * 60000)) return; await env.RATEBOARD_KV.put(K, JSON.stringify({ at: Date.now(), running: 1 }), { expirationTtl: 7 * 86400 }); } catch (e) { return; }
  const tok = env.RS_AUTH_TOKEN || scanTok(env), id = 300002552, out = { at: Date.now() };
  const get = async u => { const r = await fetch(u, { headers: rsHeaders(tok) }); const t = await r.text(); let d = null; try { d = JSON.parse(t); } catch (e) {} return { st: r.status, d, t: t.slice(0, 120) }; };
  try {
    const f = await get(`https://web.realapp.com/players/${id}/sport/nba/seasonfeed?limit=200&season=1962&view=recent&viewFrame=default`);
    out.feedSt = f.st;
    const bs = (f.d && f.d.playerBoxScores) || [];
    out.games = bs.map(b => ({ day: b.day, t: b.seasonType === 'postseason' ? 'P' : 'R', v: b.value != null ? Math.round(Number(b.value) * 100) / 100 : null, min: b.minutes, tags: b.performanceTags || b.tags || null })).slice(0, 120);
    out.feedKeys = bs[0] ? Object.keys(bs[0]).slice(0, 40) : (f.d ? Object.keys(f.d).slice(0, 20) : f.t);
    out.sample = null;
    await sleep(3000);
    const e = await get(`https://web.realapp.com/userpassearnings/nba/season/1962/entity/player/${id}`);
    out.earnSt = e.st;
    const ev = (e.d && e.d.earnings) || [];
    out.earnings = ev.map(x => ({ day: x.day, rax: x.earnings, n: (x.playerBoxScoreIds || []).length }));
    out.earnKeys = e.d ? Object.keys(e.d).slice(0, 20) : e.t;
    out.ok = f.st === 200 && e.st === 200;
  } catch (er) { out.err = String(er.message || er).slice(0, 150); }
  try { await env.RATEBOARD_KV.put(K, JSON.stringify(out), { expirationTtl: 7 * 86400 }); } catch (e) {}
}

// One-off (2026-11-11): card rarities on Boosts - do saved passes carry Real's multiplier since scans became one call?
export async function multProbe(env, db) {
  const K = 'diag_multprobe_1111';
  try { if (await env.RATEBOARD_KV.get(K)) return; await env.RATEBOARD_KV.put(K, JSON.stringify({ running: 1, at: Date.now() }), { expirationTtl: 3 * 86400 }); } catch (e) { return; }
  const out = { at: Date.now() };
  try {
    const rows = ((await db.prepare("SELECT key, passes, scannedAt FROM swap_users WHERE passes IS NOT NULL AND scannedAt > ? ORDER BY scannedAt DESC LIMIT 12").bind(Date.now() - 2 * 86400000).all()).results) || [];
    out.members = rows.map(r => { const ps = parse(r.passes, []); return { at: new Date(r.scannedAt).toISOString().slice(5, 16), n: ps.length, withMult: ps.filter(p => p.mult).length, withLevel: ps.filter(p => p.levelLabel).length, sample: ps.filter(p => p.levelLabel && p.levelLabel !== 'General').slice(0, 3).map(p => [p.levelLabel, p.mult]) }; });
    const u = await db.prepare("SELECT hashId FROM swap_users WHERE key='dennis'").first();
    const r = await fetch(`https://web.realapp.com/userpasses/${encodeURIComponent(u.hashId)}/passes`, { headers: rsHeaders(scanTok(env)) });
    out.st = r.status; const d = JSON.parse(await r.text()); const rr = rowsOf(d);
    const one = rr.find(x => x && x.boostInfo && x.boostInfo.rarityLabel && !/general/i.test(x.boostInfo.rarityLabel)) || rr[0];
    out.keys = one ? Object.keys(one) : null; out.boostInfo = one ? one.boostInfo || null : null;
    out.withBoostInfo = rr.filter(x => x && x.boostInfo).length; out.total = rr.length;
  } catch (e) { out.err = String(e.message || e).slice(0, 150); }
  try { await env.RATEBOARD_KV.put(K, JSON.stringify(out), { expirationTtl: 3 * 86400 }); } catch (e) {}
}


/* One-off (2026-11-12): Dennis's CFB 2026 player passes for a bowl-season
   projection - pass ids, levels and multipliers only (no names, no usernames). */
export async function cfbPassProbe(env, db) {
  const K = 'diag_cfbpass_1112';
  try { if (await env.RATEBOARD_KV.get(K)) return; await env.RATEBOARD_KV.put(K, JSON.stringify({ running: 1, at: Date.now() }), { expirationTtl: 86400 }); } catch (e) { return; }
  const out = { at: Date.now() };
  try {
    const u = await db.prepare("SELECT passes, scannedAt FROM swap_users WHERE key='dennis'").first();
    const ps = u && u.passes ? JSON.parse(u.passes) : [];
    out.scannedAt = u ? u.scannedAt : null;
    out.sports = [...new Set(ps.map(p => p.sport + ':' + p.season + ':' + (p.kind || '')))].slice(0, 40);
    out.cfb = ps.filter(p => (p.sport === 'ncaaf' || p.sport === 'cfb') && p.kind !== 'team')
      .map(p => ({ id: Number(p.id), se: Number(p.season), lv: p.levelLabel || null, m: cardMultOf(p) }));
    out.done = 1;
  } catch (e) { out.err = String(e.message || e).slice(0, 150); }
  try { await env.RATEBOARD_KV.put(K, JSON.stringify(out), { expirationTtl: 86400 }); } catch (e) {}
}

/* One-off (2026-11-12 evening): what went wrong today - warnings missed per
   hour, 160s/swaps called off and why, paused members matched, the bot's
   failures, and the liamthomson/cookiedagoat Suzuki 160. No usernames out. */
export async function dayProbe(env, db) {
  const K = 'diag_day_1112';
  try { if (await env.RATEBOARD_KV.get(K)) return; await env.RATEBOARD_KV.put(K, JSON.stringify({ running: 1, at: Date.now() }), { expirationTtl: 86400 }); } catch (e) { return; }
  const out = { at: Date.now() }, now = Date.now(), from = now - 26 * 3600000;
  const strip = t => String(t || '').replace(/@[\w.\-]+/g, '@x').replace(/^[\w.\-]+:/, 'u:').slice(0, 140);
  const hr = ms => new Date(Number(ms) - 9 * 3600000).toISOString().slice(5, 16);
  try {
    await matchCols(db);
    const ms = ((await db.prepare('SELECT a, b, status, note, dueAt, createdAt, warnA, warnB FROM swap_matches WHERE dueAt > ? AND dueAt < ?').bind(from, now + 20 * 3600000).all()).results) || [];
    const H = {};
    for (const m of ms) { const h = hr(m.dueAt), x = H[h] || (H[h] = { n: 0, st: {}, noWarn: 0, halfWarn: 0 });
      x.n++; x.st[m.status] = (x.st[m.status] || 0) + 1;
      if (Number(m.dueAt) < now && !['cancelled', 'cleared'].includes(m.status)) { if (!m.warnA && !m.warnB) x.noWarn++; else if (!m.warnA || !m.warnB) x.halfWarn++; } }
    out.swapsByHour = H;
    const notes = {}; for (const m of ms) if (m.status === 'cancelled') { const k = strip(m.note).replace(/\d+/g, '#'); notes[k] = (notes[k] || 0) + 1; }
    out.cancelNotes = notes;
    const t = ((await db.prepare('SELECT seller, buyer, pass, status, note, dueAt, warnS, warnB, kind, createdAt FROM swap_160 WHERE dueAt > ? AND dueAt < ?').bind(from, now + 20 * 3600000).all()).results) || [];
    const T = {}; for (const r of t) { const h = hr(r.dueAt), x = T[h] || (T[h] = { n: 0, st: {}, noWarn: 0 }); x.n++; x.st[r.status] = (x.st[r.status] || 0) + 1;
      if (Number(r.dueAt) < now && r.status !== 'cancelled' && (!r.warnS || !r.warnB)) x.noWarn++; }
    out.s160ByHour = T;
    const n2 = {}; for (const r of t) if (r.status === 'cancelled') { const k = strip(r.note).replace(/\d+/g, '#'); n2[k] = (n2[k] || 0) + 1; }
    out.cancel160Notes = n2;
    // Paused members still matched: inactive now, with a swap made after they last saved.
    const us = ((await db.prepare('SELECT key, active, updatedAt, b160, s160, only160 FROM swap_users').all()).results) || [];
    const U = new Map(us.map(u => [u.key, u]));
    const pm = []; for (const m of ms) for (const k of [m.a, m.b]) { const u = U.get(k); if (u && !u.active && Number(m.createdAt) > Number(u.updatedAt || 0) && m.status !== 'cancelled') pm.push({ made: hr(m.createdAt), due: hr(m.dueAt), saved: hr(u.updatedAt), st: m.status }); }
    out.pausedMatched = { n: pm.length, ex: pm.slice(0, 15) };
    const p1 = []; for (const r of t) for (const k of [r.seller, r.buyer]) { const u = U.get(k); if (u && !u.active && Number(r.createdAt) > Number(u.updatedAt || 0) && r.status !== 'cancelled') p1.push({ made: hr(r.createdAt), due: hr(r.dueAt), saved: hr(u.updatedAt), st: r.status, side: k === r.seller ? 'S' : 'B', s160: u.s160, b160: u.b160, only160: u.only160 }); }
    out.paused160 = { n: p1.length, ex: p1.slice(0, 15) };
    // 160s whose seller no longer owns the pass.
    const own = new Map(); let notOwned = 0; const exNO = [];
    for (const r of t) { if (r.kind === 'niche' || r.status === 'cancelled') continue;
      if (!own.has(r.seller)) { const m = await loadMember(db, r.seller).catch(() => null); own.set(r.seller, m ? new Set((m.passes || []).map(p => p.key)) : null); }
      const o = own.get(r.seller); if (o && !o.has(r.pass)) { notOwned++; if (exNO.length < 10) exNO.push({ pass: r.pass, due: hr(r.dueAt), st: r.status }); } }
    out.sellerMissingPass = { n: notOwned, ex: exNO };
    // The Suzuki 160.
    const ks = us.filter(u => /^(liamthomson|cookiedagoat)$/i.test(u.key)).map(u => u.key);
    const sz = ((await db.prepare(`SELECT * FROM swap_160 WHERE (seller IN (${ks.map(() => '?').join(',') || "''"}) AND buyer IN (${ks.map(() => '?').join(',') || "''"})) AND dueAt > ?`).bind(...ks, ...ks, from).all()).results) || [];
    out.suzuki = [];
    for (const r of sz) { const S = await loadMember(db, r.seller).catch(() => null), B = await loadMember(db, r.buyer).catch(() => null);
      out.suzuki.push({ id: r.id, pass: r.pass, kind: r.kind || null, st: r.status, note: strip(r.note), due: hr(r.dueAt), made: hr(r.createdAt), warnS: !!r.warnS, warnB: !!r.warnB,
        sellerIsLiam: /liam/i.test(r.seller), sellerOwns: S ? (S.passes || []).some(p => p.key === r.pass) : null, sellerName: S ? playerName(S, r.pass) : null, buyerName: B ? playerName(B, r.pass) : null,
        sellerScanned: S ? hr(S.scannedAt || 0) : null, sellerHeld: S ? (S.wants || []).includes(r.pass) || (S.keep || []).includes(r.pass) : null }); }
    // Bot failures and the DM queues.
    const bl = ((await db.prepare('SELECT at, kind, msg FROM bot_log WHERE at > ? ORDER BY at').bind(from).all()).results) || [];
    const BK = {}; for (const r of bl) { const k = r.kind + ' | ' + strip(r.msg).replace(/\d+/g, '#').slice(0, 90); BK[k] = (BK[k] || 0) + 1; }
    out.botFails = BK;
    out.stats = ((await db.prepare('SELECT day, k, n FROM bot_stats WHERE day >= ?').bind(new Date(from).toISOString().slice(0, 10)).all()).results) || [];
    out.retry = await db.prepare('SELECT COUNT(*) AS n, MIN(at) AS oldest FROM dm_retry').first();
    out.users = { all: us.length, active: us.filter(u => u.active).length };
    out.done = 1;
  } catch (e) { out.err = String(e.message || e).slice(0, 200); }
  try { await env.RATEBOARD_KV.put(K, JSON.stringify(out), { expirationTtl: 86400 }); } catch (e) {}
}

/* One-off (2026-11-12): Dennis's MLB player passes for an OTD plan - ids, levels, ratings, earned (no names, no usernames). */
export async function mlbPassProbe(env, db) {
  const K = 'diag_mlbpass_1112';
  try { if (await env.RATEBOARD_KV.get(K)) return; await env.RATEBOARD_KV.put(K, JSON.stringify({ running: 1 }), { expirationTtl: 86400 }); } catch (e) { return; }
  const out = { at: Date.now() };
  try { const u = await db.prepare("SELECT passes, scannedAt FROM swap_users WHERE key='dennis'").first();
    out.scannedAt = u && u.scannedAt;
    out.mlb = (u && u.passes ? JSON.parse(u.passes) : []).filter(p => p.sport === 'mlb' && p.kind !== 'team')
      .map(p => ({ id: p.id, se: p.season, lv: p.levelLabel, r: p.rating, m: p.mult, e: p.earned })); out.done = 1;
  } catch (e) { out.err = String(e.message || e).slice(0, 150); }
  try { await env.RATEBOARD_KV.put(K, JSON.stringify(out), { expirationTtl: 86400 }); } catch (e) {}
}
