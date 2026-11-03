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
import { isAdminRequest, sessionKey, forbidden, allow, clientIp, touchSeen, ADMINS } from '../../lib/auth.js';
import { watchEnv } from '../../lib/dbwatch.js';

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
async function scanPasses(hashId, auth, only) {
  const out = [], errors = [];
  let sample = null;
  for (const [sport, seasons] of Object.entries(only || SWAP_SEASONS)) {
    for (const season of seasons) {
      // Player passes, then team passes (UFC fighters are filed as teams).
      for (const kind of (only ? ['player'] : ['player', 'team'])) {
        try {
          const d = await rsGetJson(`https://web.realapp.com/userpasses/${encodeURIComponent(hashId)}/passes`
            + `?entityType=${kind}&season=${season}&sport=${sport}`, auth);
          const rows = rowsOf(d);
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
      if (found.channel) { try { await dmSend(auth, found.channel, 'Code confirmed; password reset available on https://raxacademy.app'); } catch (e) {} }
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
  for (const c of chans) if (hasCode(c.o)) return { ok: true, request: c.isReq ? c.ch : null, channel: c.ch };
  for (const c of chans.slice(0, 1)) {
    try {
      const m = await rsGetJson(`https://web.realapp.com/messages/channels/${c.ch}/messages`, auth);
      if (hasCode(m)) return { ok: true, request: c.isReq ? c.ch : null, channel: c.ch };
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
const OTD_DDL = `CREATE TABLE IF NOT EXISTS otd_access (key TEXT PRIMARY KEY, grantedAt INTEGER)`;
/* Who can use Swaps and who can use OTD optimization - two separate grants.
   ok means either; swaps and otd say which. */
export async function swapAccess(env, request) {
  const who = await sessionKey(env, request);
  if (!who) return { who: null, admin: false, ok: false, swaps: false, otd: false };
  const admin = await isAdminRequest(env, request);
  if (admin) return { who, admin, ok: true, swaps: true, otd: true };
  const db = env.RATEBOARD_DB;
  const norm = x => String(x || '').trim().toLowerCase().replace(/^@/, '');
  let swaps = SWAP_MEMBERS.includes(norm(who)), otd = false;
  try {
    if (!swaps) {
      const u = await db.prepare('SELECT name FROM users WHERE key=?').bind(who).first();
      swaps = !!u && SWAP_MEMBERS.includes(norm(u.name));
    }
    await db.prepare(SACCESS_DDL).run();
    await db.prepare(OTD_DDL).run();
    const [a, b] = await db.batch([
      db.prepare('SELECT 1 AS x FROM swap_access WHERE key=?').bind(who),
      db.prepare('SELECT 1 AS x FROM otd_access WHERE key=?').bind(who)]);
    swaps = swaps || !!(a.results && a.results.length);
    otd = !!(b.results && b.results.length);
  } catch (e) {}
  return { who, admin: false, ok: swaps || otd, swaps, otd };
}
// What a member (not an admin) may do: their own swap and nothing else, and
// for OTD their own passes and games.
const MEMBER_OPS = new Set(['me', 'save', 'scan', 'search', 'connect']);
const OTD_OPS = new Set(['me', 'scan', 'games', 'boostplan']);
const BOOST_OPS = new Set(['me', 'scan', 'boostplan', 'boostinv', 'buys']);
const BOOSTS_OPEN = true;   // opened to everyone signed in, 2026-11-02

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
const BOOST_BARS = { ncaam: [11.5, 10, 7.5], ncaaf: [25, 20, 12], nfl: [19, 15, 8.5] };   // Legendary ~top 1% game, Epic ~top 3-5%
const BOOST_MODES = { balanced: 1, heavy: 1, saver: 1 };
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

const BOOST_REFRESH_HOURS = [10, 17];
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
/* All three sports' boosters in one read, at most once every 4 hours per
   member; inside that the saved copy is used. */
const BOOSTINV_EVERY = 2 * 3600000;
// Members whose pass and booster reads on Boosts are never held back.
const BOOST_FAST = new Set(['quas23']);
async function boostInventoryAll(env, tok, hashId, fresh, admin) {
  const key = `boostinv_v5_${hashId}`;
  let c = null;
  try { c = JSON.parse((await env.RATEBOARD_KV.get(key)) || 'null'); } catch (e) {}
  if (c && (!fresh || (!admin && Date.now() - c.at < BOOSTINV_EVERY))) return { ...c, next: admin ? Date.now() : c.at + BOOSTINV_EVERY, cached: !!fresh };
  const sports = {};
  for (const sp of Object.keys(BOOST_SEASON)) {
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
const CBB_SHOTS = new Set([4711255, 5187600, 5080489, 5174657, 5106275, 5044426, 5103630, 5142609, 4858604, 5060709, 5095152, 5054083, 5142722, 5142715, 5311832, 5101833, 4869764, 4873209]);
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
/* NFL depth charts for the teams on the slate, by player name: slot 1 is the
   starter (top two at RB, three WRs). Kept 6 hours per team. */
async function boostDepth(env, sched, force, only) {
  const out = {};
  for (const id of (only || Object.values(sched.teams).map(t => t.id).filter(Boolean))) {
    const key = `boostdepth_v1_${id}`;
    let m = null;
    if (!force) { try { const c = JSON.parse((await env.RATEBOARD_KV.get(key)) || 'null'); if (c) m = c.m; } catch (e) {} }
    if (!m) {
      m = {};
      try {
        const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${id}/depthcharts`);
        const d = r.ok ? await r.json() : {};
        for (const g of (d.depthchart || [])) for (const [pos, v] of Object.entries(g.positions || {})) {
          (v.athletes || []).forEach((a, i) => {
            const nm = boostName(a.displayName), slot = i + 1;
            const starter = slot === 1 || (pos === 'rb' && slot <= 2);
            const cur = m[nm];
            if (!cur || (starter && !cur.starter) || (!cur.starter && slot < cur.slot)) m[nm] = { pos, slot, starter };
          });
        }
      } catch (e) {}
      try { await env.RATEBOARD_KV.put(key, JSON.stringify({ at: Date.now(), m }), { expirationTtl: 3 * 86400 }); } catch (e) {}
    }
    Object.assign(out, m);
  }
  return out;
}

const SCAN_EVERY_KEY = 'swap_scan_every_v1';
async function scanEvery(env) {
  let v = null; try { v = Number(await env.RATEBOARD_KV.get(SCAN_EVERY_KEY)); } catch (e) {}
  return v === 15 ? 15 : 180;
}

// Any error comes back as a readable message rather than a bare 500.
export async function onRequest(ctx) {
  try { return await handle(Object.assign({}, ctx, { env: watchEnv(ctx.env, ctx.request, ctx.waitUntil) })); }
  catch (e) { return json({ error: 'Swaps hit an error: ' + String((e && e.message) || e).slice(0, 300) }, 500); }
}

async function handle({ request, env, waitUntil }) {
  const url = new URL(request.url);
  const db = env.RATEBOARD_DB;
  const op = url.searchParams.get('op') || '';
  // Password resets happen signed out, so they come before the access check.
  if (op === 'resetstart' || op === 'resetcheck') return resetFlow(env, db, url, request, op, waitUntil);
  const acc = await swapAccess(env, request);
  // Boosts (BETA) is open to every signed-in member; its calls say page=boosts.
  // Limited to Dennis (admins) while in beta: set BOOSTS_OPEN to open it to everyone signed in.
  const boostCall = BOOSTS_OPEN && url.searchParams.get('page') === 'boosts' && BOOST_OPS.has(op) && !!acc.who;
  if (!acc.ok && !boostCall) return forbidden(acc.who ? 'Your account does not have this page yet.' : 'Sign in on the board first.');
  if (!acc.admin && !boostCall && !((acc.swaps && MEMBER_OPS.has(op)) || (acc.otd && OTD_OPS.has(op)))) return forbidden('Your account does not have this.');
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
    const u = await db.prepare('SELECT * FROM swap_users WHERE key=?').bind(me).first();
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
    let connected = false;
    if (u && u.hashId) {
      try { await db.prepare(DM_DDL).run();
        connected = !!(await db.prepare('SELECT channelId FROM swap_dm WHERE hashId=? AND channelId IS NOT NULL').bind(u.hashId).first()); } catch (e) {}
    }
    return json({ key: me, admin: acc.admin, swaps: acc.swaps, otd: acc.otd, boostModes: acc.admin || BOOST_FAST.has(String(me || '').toLowerCase()), tokenFound: !!auth, connected, profile: u ? { rsUser: u.rsUser, hashId: u.hashId, wants: parse(u.wants, []),
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
    const u = await db.prepare('SELECT rsUser, hashId, scannedAt, passes FROM swap_users WHERE key=?').bind(me).first();
    /* Members can scan once per interval (3 hours, or 15 minutes when Dennis
       switches it on); the last scan time is the one saved with their passes,
       so it holds wherever they scan from. Admins aren't limited. */
    if (!acc.admin && !(url.searchParams.get('page') === 'boosts' && BOOST_FAST.has(String(me || '').toLowerCase()))) {
      const every = url.searchParams.get('page') === 'boosts' ? 120 : await scanEvery(env);
      const left = (Number(u && u.scannedAt) || 0) + every * 60000 - Date.now();
      // Too soon for a fresh scan: hand back the last one instead.
      if (left > 0 && u && u.passes) {
        const m = Math.ceil(left / 60000);
        return json({ hashId: u.hashId, passes: parse(u.passes, []), errors: [], cached: true, scannedAt: Number(u.scannedAt) || null,
          note: `From your last scan. A fresh scan is allowed once every ${every >= 60 ? every / 60 + ' hours' : every + ' minutes'} - next in ${m >= 60 ? Math.floor(m / 60) + 'h ' + (m % 60) + 'm' : m + ' min'}.` });
      }
    } else if (!(await allow(url.origin, 'swapscan:' + me, 20, 600))) return json({ error: 'Twenty scans per ten minutes.' }, 429);
    const rsUser = String(url.searchParams.get('rsUser') || (u && u.rsUser) || '').trim();
    if (!rsUser) return json({ error: 'Enter your Real username first.' }, 400);
    let hashId = u && u.rsUser === rsUser ? u.hashId : null;
    try { if (!hashId) hashId = await resolveHashId(rsUser, auth); } catch (e) { return json({ error: String(e.message || e) }, 502); }
    if (!hashId) return json({ error: `No Real user called ${rsUser}.` }, 404);
    // From Boosts only its three current seasons are read (6 calls, not ~80),
    // and the member's other passes are kept as they were.
    const boostsOnly = url.searchParams.get('page') === 'boosts';
    const only = boostsOnly ? Object.fromEntries(Object.entries(BOOST_SEASON).map(([k, v]) => [k, [v[0]]])) : null;
    // Site-wide: at most 40 pass reads a minute, so a crowd can't trip Real's limits.
    if (!acc.admin && !BOOST_FAST.has(String(me || '').toLowerCase()) && !(await allow(url.origin, 'passread-all', 15, 60))) return json({ error: 'Lots of people are reading passes right now - try again in a minute.' }, 429);
    const r = await scanPasses(hashId, auth, only);
    if (boostsOnly) {
      const prevP = parse(u && u.passes, []);
      const fresh = new Set(Object.entries(only).map(([k, v]) => `${k}:${v[0]}`));
      r.passes = prevP.filter(p => !(fresh.has(`${p.sport}:${p.season}`) && p.kind !== 'team')).concat(r.passes);
    }
    await fillNames(db, r.passes);
    await db.prepare(`INSERT INTO swap_users (key, rsUser, hashId, passes, scannedAt, updatedAt, wants, keep, slots) VALUES (?, ?, ?, ?, ?, ?, '[]', '[]', '[]')
      ON CONFLICT(key) DO UPDATE SET rsUser=excluded.rsUser, hashId=excluded.hashId, passes=excluded.passes,
        scannedAt=excluded.scannedAt, updatedAt=excluded.updatedAt`)
      .bind(me, rsUser, hashId, JSON.stringify(r.passes), Date.now(), Date.now()).run();
    return json({ hashId, passes: r.passes, errors: r.errors, sample: r.sample });
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

  if (op === 'boostinv') {
    const sp = BOOST_SEASON[url.searchParams.get('sport')] ? url.searchParams.get('sport') : 'nfl';
    const u = await db.prepare('SELECT hashId FROM swap_users WHERE key=?').bind(me).first();
    if (!u || !u.hashId) return json({ error: 'Re-read your passes first so the board knows your Real account.' }, 400);
    const want = url.searchParams.get('fresh') === '1';
    const fast = acc.admin || BOOST_FAST.has(String(me || '').toLowerCase());
    if (want && !fast && !(await allow(url.origin, 'boostinv-all', 15, 60))) return json({ error: 'Lots of people are loading boosters right now - try again in a minute.' }, 429);
    const all = await boostInventoryAll(env, env.RS_AUTH_TOKEN || auth, u.hashId, want, fast);
    if (all.error) return json({ error: all.error }, 502);
    return json({ sport: sp, at: all.at, next: all.next, cached: !!all.cached, boosters: (all.sports || {})[sp] || [], sports: all.sports });
  }

  if (op === 'boostplan') {
    const sp = String(url.searchParams.get('sport') || '');
    if (!BOOST_SEASON[sp]) return json({ error: 'Pick CBB, CFB or NFL.' }, 400);
    const day = String(url.searchParams.get('date') || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return json({ error: 'Pick a date.' }, 400);
    let mode = BOOST_MODES[url.searchParams.get('mode')] ? url.searchParams.get('mode') : 'balanced';
    // Heavy Legendary and Boost saver are only for Dennis and quas23 for now.
    if (mode !== 'balanced' && !acc.admin && !BOOST_FAST.has(String(me || '').toLowerCase())) mode = 'balanced';
    const [se, prev] = BOOST_SEASON[sp];
    // What they own: the passes from their last scan (the same read Swaps
    // uses). Rarity and pass level are not counted.
    const u = await db.prepare('SELECT passes, scannedAt, rsUser FROM swap_users WHERE key=?').bind(me).first();
    if (!u || !u.passes) return json({ error: 'Scan your passes first.' }, 400);
    const cards = { at: u.scannedAt || null, players: parse(u.passes, [])
      .filter(p => p.sport === sp && Number(p.season) === se && p.kind !== 'team')
      .map(p => ({ id: Number(p.id), name: p.name || '', passId: p.passId || null })) };
    const sched = await boostSchedule(env, sp, day);
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
    const depth = sp === 'nfl' ? await boostDepth(env, sched) : null;
    // The member's boosters, if Real will give them.
    let inv = null;
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
    const rows = [], idle = [];
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
      rows.push({ id: p.id, passId: p.passId, name, team, pos, opp: g.opp, home: g.home, at: g.at, exp,
        avg: ca == null ? null : Math.round(ca * 10) / 10, games: cg, avgLast: oa == null ? null : Math.round(oa * 10) / 10,
        proj: proj == null ? null : Math.round(proj * k * mf * 10) / 10, basis, flags, skip, fresh, noData });
    }
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
    const R = MODE_RULES[mode] || MODE_RULES.balanced;
    const legBar = R.leg * scale, epicBar = R.epic * scale, rareFloor = 5, cutAt = null;
    bars.splice(0, 3, Math.round(legBar * 10) / 10, Math.round(epicBar * 10) / 10, rareFloor);
    const held = r => inv ? inv.filter(b => b.rarity === r).reduce((t, b) => t + b.count, 0) : 0;
    const dayCap = { 5: held(5) ? Math.max(1, Math.floor(held(5) * R.cap)) : 0, 4: Infinity, 3: Infinity };
    const usedR = { 5: 0, 4: 0, 3: 0 };
    const own = r => left ? Math.min(held(r), dayCap[r]) - usedR[r] : Infinity;
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
        const pin = pinOf(r); if (pin && mode !== 'saver' && (!want || want < pin[1])) want = pin[1];
      }
      while (want && left && own(want) <= 0) want = want > 3 ? want - 1 : null;
      r.boost = want ? NR[want] : null;
      r._r = want;
      if (want && left) usedR[want]++;
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

    return json({ sport: sp, season: se, date: day, mode, bars, cutAt, totals, legCap: inv ? dayCap[5] : null, inv: used, statMode: !!used, rsUser: u.rsUser, cardsAt: cards.at, games: sched.games, depth: !!depth,
      rows, notPlaying: idle.length, players: cards.players.length });
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
  /* Admin: one member's Real profile, raw, to see whether Real says if they
     have Real Pro. Looks the username up, then tries the likely profile
     addresses, and lists every field whose name looks like a plan or badge. */
  if (op === 'proprobe') {
    if (!auth) return json({ error: 'No swap token found.' }, 503);
    const name = String(url.searchParams.get('user') || '').trim().replace(/^@/, '');
    if (!name) return json({ error: 'Enter a Real username.' }, 400);
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
