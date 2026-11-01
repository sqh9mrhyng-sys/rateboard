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
      // Player passes, then team passes (UFC fighters are filed as teams).
      for (const kind of ['player', 'team']) {
        try {
          const d = await rsGetJson(`https://web.realapp.com/userpasses/${encodeURIComponent(hashId)}/passes`
            + `?entityType=${kind}&season=${season}&sport=${sport}`, auth);
          const rows = rowsOf(d);
          if (rows.length && !sample) sample = { sport, season, keys: Object.keys(d || {}), first: rows[0] };
          for (const r of rows) { const p = passOf(r, sport, season, kind); if (p) out.push(p); }
        } catch (e) { errors.push(`${sport} ${season} ${kind}: ${String(e.message || e).slice(0, 100)}`); }
        await sleep(200);
      }
    }
  }
  return { passes: out, errors, sample };
}

const parse = (s, d) => { try { return JSON.parse(s || ''); } catch (e) { return d; } };

/* Greedy two-way matching. For every pair of active members who share an
   hour: does A have a giveable pass B wants, and B one A wants? Each member
   gets at most one match per run, and the passes in it are spoken for. */
async function runMatching(db) {
  // Only members the bot already has a chat with: new chats are capped at
  // five a day, so a match with anyone else might never be delivered.
  await db.prepare(DM_DDL).run();
  const users = ((await db.prepare(`SELECT * FROM swap_users WHERE active=1 AND passes IS NOT NULL
      AND hashId IN (SELECT hashId FROM swap_dm WHERE channelId IS NOT NULL)`).all()).results || [])
    .map(u => ({ ...u, wants: parse(u.wants, []), keep: new Set(parse(u.keep, [])), slots: parse(u.slots, []),
                 passes: parse(u.passes, []) }));
  const open = ((await db.prepare(`SELECT a, b, aGets, bGets FROM swap_matches WHERE status IN ('pending','sending') OR (status='sent' AND sentAt > ?)`).bind(Date.now() - 86400000).all()).results || []);
  const busy = new Set(), promised = new Set();
  for (const m of open) {
    busy.add(m.a); busy.add(m.b);
    promised.add(`${m.b}|${m.aGets}`); promised.add(`${m.a}|${m.bGets}`);     // passes already offered
  }
  // FC and UFC have no packs to swap, so neither is ever offered or matched.
  const swappable = k => !/^(soccer|ufc):/.test(k);
  for (const u of users) u.wants = u.wants.filter(swappable);
  const gives = u => new Set(u.passes.map(p => p.key).filter(k => swappable(k) && !u.keep.has(k) && !promised.has(`${u.key}|${k}`)));
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

async function dmSend(auth, channelId, text) {
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
  const d = await rsGetJson('https://web.realapp.com/messages/channels', auth);
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
  walk(d);
  for (const [hashId, userName, ch] of found) {
    await db.prepare(`INSERT INTO swap_dm (hashId, userName, channelId, openedAt) VALUES (?, ?, ?, ?)
      ON CONFLICT(hashId) DO UPDATE SET channelId=excluded.channelId, userName=COALESCE(excluded.userName, swap_dm.userName)`)
      .bind(hashId, userName, ch, Date.now()).run();
  }
  return found.length;
}
const BOT_ID = 'jvbj4p6v';   // raxacademy.app

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

// Sends one match to both members. Returns a note for the record.
async function sendMatch(env, db, auth, m) {
  const load = async k => {
    const u = await db.prepare('SELECT key, rsUser, hashId, passes FROM swap_users WHERE key=?').bind(k).first();
    return u ? { ...u, passes: parse(u.passes, []) } : null;
  };
  const A = await load(m.a), B = await load(m.b);
  if (!A || !B || !A.hashId || !B.hashId) throw new Error('member missing or never scanned');
  // Both chats first, so a member is never messaged when the other can't be.
  const chA = await dmChannel(db, auth, A.hashId, A.rsUser, env);
  const chB = await dmChannel(db, auth, B.hashId, B.rsUser, env);
  await dmSend(auth, chA, matchText(A, B, m.aGets, m.bGets, m.slot));
  await sleep(1200);
  await dmSend(auth, chB, matchText(B, A, m.bGets, m.aGets, m.slot));
  return `sent to @${A.rsUser} (${chA}) and @${B.rsUser} (${chB})`;
}

/* Called once a minute from the collector tick. Matching runs once an hour;
   pending matches go out in the hour of their shared slot, a few a minute. */
export async function swapTick(env) {
  if (!DM_ON) return null;
  const db = env.RATEBOARD_DB, auth = swapToken(env);
  if (!db || !auth) return null;
  await ready(db);
  const hourKey = 'swap_match_hour_v1', hour = new Date().toISOString().slice(0, 13);
  let last = null; try { last = await env.RATEBOARD_KV.get(hourKey); } catch (e) {}
  if (last !== hour) {
    try { await env.RATEBOARD_KV.put(hourKey, hour); } catch (e) {}
    try { await acceptRequests(db, auth); } catch (e) {}
    try { await syncChats(db, auth); } catch (e) {}
    try { await runMatching(db); } catch (e) {}
  }
  const h = new Date().getUTCHours();
  const due = (await db.prepare(`SELECT * FROM swap_matches WHERE status='pending' AND slot=? ORDER BY id LIMIT 3`).bind(h).all()).results || [];
  const out = [];
  for (const m of due) {
    // Claim it first, so two ticks running at once can't both send it.
    const c = await db.prepare(`UPDATE swap_matches SET status='sending' WHERE id=? AND status='pending'`).bind(m.id).run();
    if (!(c && c.meta && c.meta.changes)) continue;
    let status = 'sent', note = '';
    try { note = await sendMatch(env, db, auth, m); }
    catch (e) { status = /5 new chats/.test(String(e.message)) ? 'pending' : 'error'; note = String(e.message || e).slice(0, 300); }
    await db.prepare('UPDATE swap_matches SET status=?, sentAt=?, note=? WHERE id=?')
      .bind(status, status === 'sent' ? Date.now() : null, note, m.id).run();
    out.push({ id: m.id, status, note });
    if (status === 'pending') break;
  }
  return out;
}

/* Who can use Swaps besides admins: these Real usernames, matched against
   the board account's key or display name. */
const SWAP_MEMBERS = ['scantrawn', 'prod', 'nebula57', 'thinkpoker', 'harris', 'reschny', 'six',
  'uawheel', 'topfloorboss', 'aayan.t', 'nicohoerner', 'gabby', 'rhjin', 'lax', 'thathuey5', 'puka', 'mar'];
const SACCESS_DDL = `CREATE TABLE IF NOT EXISTS swap_access (key TEXT PRIMARY KEY, grantedAt INTEGER)`;
export async function swapAccess(env, request) {
  const who = await sessionKey(env, request);
  if (!who) return { who: null, admin: false, ok: false };
  const admin = await isAdminRequest(env, request);
  if (admin) return { who, admin, ok: true };
  const norm = x => String(x || '').trim().toLowerCase().replace(/^@/, '');
  let ok = SWAP_MEMBERS.includes(norm(who));
  if (!ok) {
    try {
      const u = await env.RATEBOARD_DB.prepare('SELECT name FROM users WHERE key=?').bind(who).first();
      ok = !!u && SWAP_MEMBERS.includes(norm(u.name));
    } catch (e) {}
  }
  if (!ok) {
    try {
      await env.RATEBOARD_DB.prepare(SACCESS_DDL).run();
      ok = !!(await env.RATEBOARD_DB.prepare('SELECT 1 AS x FROM swap_access WHERE key=?').bind(who).first());
    } catch (e) {}
  }
  return { who, admin: false, ok };
}
// What a member (not an admin) may do: their own swap and nothing else.
const MEMBER_OPS = new Set(['me', 'save', 'scan', 'search', 'connect']);

export async function onRequest({ request, env, waitUntil }) {
  const url = new URL(request.url);
  const db = env.RATEBOARD_DB;
  const op = url.searchParams.get('op') || '';
  const acc = await swapAccess(env, request);
  if (!acc.ok) return forbidden(acc.who ? 'Your account does not have Swaps yet.' : 'Sign in on the board first.');
  if (!acc.admin && !MEMBER_OPS.has(op)) return forbidden('Admin only.');
  const me = acc.who;
  await ready(db);
  const auth = swapToken(env);

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
    for (const [g, ids] of Object.entries(groups)) {
      const [sp, se] = g.split('|');
      for (let i = 0; i < ids.length; i += 90) {
        const r = await db.prepare(`SELECT playerId, substr(day, 6, 5) AS d, rax FROM gamelog
          WHERE sport=? AND season=? AND playerId IN (${ids.slice(i, i + 90).filter(Number.isFinite).join(',') || 0}) AND rax > 0`)
          .bind(sp, Number(se)).all();
        for (const x of (r.results || [])) (out[`${sp}:${se}:${x.playerId}`] = out[`${sp}:${se}:${x.playerId}`] || []).push([x.d, x.rax]);
      }
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
    const u = await db.prepare('SELECT * FROM swap_users WHERE key=?').bind(me).first();
    // Passes scanned before a name source existed get their names now.
    if (u && u.passes) {
      const ps = parse(u.passes, []);
      if (ps.some(p => !p.name || /^player$/i.test(p.name))) {
        await fillNames(db, ps);
        u.passes = JSON.stringify(ps);
        try { await db.prepare('UPDATE swap_users SET passes=? WHERE key=?').bind(u.passes, me).run(); } catch (e) {}
      }
    }
    let connected = false;
    if (u && u.hashId) {
      try { await db.prepare(DM_DDL).run();
        connected = !!(await db.prepare('SELECT channelId FROM swap_dm WHERE hashId=? AND channelId IS NOT NULL').bind(u.hashId).first()); } catch (e) {}
    }
    return json({ key: me, admin: acc.admin, tokenFound: !!auth, connected, profile: u ? { rsUser: u.rsUser, hashId: u.hashId, wants: parse(u.wants, []),
      keep: parse(u.keep, []), slots: parse(u.slots, []), passes: parse(u.passes, []), scannedAt: u.scannedAt, active: !!u.active } : null });
  }

  if (op === 'save' && request.method === 'POST') {
    let b = {};
    try { b = await request.json(); } catch (e) {}
    const wants = (Array.isArray(b.wants) ? b.wants : []).map(String).filter(k => /^[a-z]+:\d{4}:t?\d+$/.test(k)).slice(0, 20);
    const keep = (Array.isArray(b.keep) ? b.keep : []).map(String).filter(k => /^[a-z]+:\d{4}:t?\d+$/.test(k)).slice(0, 2000);
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

  /* Full test of the DM flow on one Real username: opens (or reuses) the
     bot's chat with them and sends a message. Capped like the test send. */
  // A member says they've messaged the bot: re-read its chat list.
  if (op === 'connect') {
    if (!auth) return json({ error: 'No swap token found.' }, 503);
    if (!(await allow(url.origin, 'swapdm-connect', 6, 600))) return json({ error: 'Too many checks - try again in a few minutes.' }, 429);
    const u = await db.prepare('SELECT hashId FROM swap_users WHERE key=?').bind(me).first();
    if (!u || !u.hashId) return json({ error: 'Scan your passes first so the bot knows your Real account.' }, 400);
    try { await acceptRequests(db, auth); } catch (e) {}
    try { await syncChats(db, auth); } catch (e) { return json({ error: String(e.message || e) }, 502); }
    const c = await db.prepare('SELECT channelId FROM swap_dm WHERE hashId=? AND channelId IS NOT NULL').bind(u.hashId).first();
    return json({ connected: !!c });
  }

  /* Who has Swaps: the named list (and whether each name matches a board
     account), anyone granted by hand, and a user search to grant more. */
  if (op === 'access') {
    await db.prepare(SACCESS_DDL).run();
    const key = String(url.searchParams.get('key') || '');
    const act = url.searchParams.get('act');
    if (act === 'grant' || act === 'revoke') {
      const u = await db.prepare('SELECT key FROM users WHERE key=?').bind(key).first();
      if (!u) return json({ error: 'no such account' }, 404);
      if (act === 'grant') await db.prepare('INSERT INTO swap_access (key, grantedAt) VALUES (?, ?) ON CONFLICT DO NOTHING').bind(key, Date.now()).run();
      else await db.prepare('DELETE FROM swap_access WHERE key=?').bind(key).run();
    }
    const named = [];
    for (const n of SWAP_MEMBERS) {
      const u = await db.prepare('SELECT key, name FROM users WHERE LOWER(key)=? OR LOWER(name)=? LIMIT 1').bind(n, n).first();
      named.push({ name: n, account: u ? u.key : null });
    }
    const granted = (await db.prepare('SELECT a.key, u.name FROM swap_access a LEFT JOIN users u ON u.key=a.key ORDER BY a.grantedAt DESC').all()).results || [];
    const q = String(url.searchParams.get('q') || '').trim().toLowerCase().replace(/[%_]/g, '');
    const found = q.length >= 2 ? ((await db.prepare(
      `SELECT key, name FROM users WHERE COALESCE(banned, 0) = 0 AND (LOWER(key) LIKE ? OR LOWER(name) LIKE ?) ORDER BY LENGTH(key) LIMIT 20`)
      .bind(`%${q}%`, `%${q}%`).all()).results || []) : [];
    const has = new Set(granted.map(g => g.key));
    return json({ named, granted, found: found.map(f => ({ ...f, access: has.has(f.key) })) });
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
  if (op === 'sendnow' && request.method === 'POST') {
    if (!auth) return json({ error: 'No swap token found.' }, 503);
    const id = Number(url.searchParams.get('id'));
    const m = await db.prepare('SELECT * FROM swap_matches WHERE id=?').bind(id).first();
    if (!m) return json({ error: 'no such match' }, 404);
    try {
      const note = await sendMatch(env, db, auth, m);
      await db.prepare(`UPDATE swap_matches SET status='sent', sentAt=?, note=? WHERE id=?`).bind(Date.now(), note, id).run();
      return json({ ok: true, note });
    } catch (e) {
      await db.prepare(`UPDATE swap_matches SET note=? WHERE id=?`).bind(String(e.message || e).slice(0, 300), id).run();
      return json({ error: String(e.message || e) }, 502);
    }
  }

  return json({ error: 'unknown op' }, 400);
}
