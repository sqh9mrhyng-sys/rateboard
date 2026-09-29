// GET /api/rax?sport=ncaam&season=2026
//
// Season earnings ("rax") straight from RS's own leaderboard endpoint —
// the same one the app's "Earnings (Total)" screen uses:
//   /userpassshop/<sport>/season/<year>/entity/player/section/earningstotal?before=N
//
//   ?probe=1        -> the raw first page, so the payload shape can be read
//   (no args)       -> walks every page and returns JSON
//   ?format=csv     -> the same, as a CSV download
//
// Read-only, and the sport/section are whitelisted: this is not a general
// proxy for the account token sitting in RS_AUTH_TOKEN.

const PAGE = 20;
const CHUNK_PAGES = 8;               // pages per request, so one call stays quick
const ALL_MAX_PAGES = 250;           // ?all=1 ceiling: 250 x 20 = 5,000 players
const GAP_MS = 350;                  // breathing room between pages
const RETRIES = 3;                   // RS answers 429 under load
const SPORTS = new Set(['ncaam', 'ncaaf', 'nfl', 'soccer', 'nba', 'mlb', 'nhl', 'ufc', 'wnba']);
const SECTIONS = new Set(['earningstotal', 'hotseason']);   // earnings | purchases

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status, headers: { 'content-type': 'application/json' }
  });
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

const sleep = ms => new Promise(r => setTimeout(r, ms));

// RS throttles hard when pages are pulled back to back, so each page is spaced
// out and a 429 is waited on rather than thrown straight at the caller.
async function rsGet(url, auth) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: rsHeaders(auth) });
    if (res.ok) return res.json();
    const body = await res.text().catch(() => '');
    if (res.status === 429 && attempt < RETRIES) {
      await sleep(1500 * (attempt + 1));
      continue;
    }
    throw new Error(`RS ${res.status}: ${body.slice(0, 200)}`);
  }
}

// The list rows come back under a few possible keys depending on the section,
// so take whichever array is actually there rather than assuming one shape.
function rowsOf(data) {
  for (const k of ['entities', 'items', 'results', 'players', 'data']) {
    if (Array.isArray(data && data[k])) return data[k];
  }
  return [];
}

export async function onRequestGet({ request, env }) {
  const auth = env.RS_AUTH_TOKEN;
  if (!auth) return json({ error: 'RS_AUTH_TOKEN is not set on this deployment' }, 500);

  const url    = new URL(request.url);
  const sport  = (url.searchParams.get('sport') || 'ncaam').toLowerCase();
  const season = (url.searchParams.get('season') || '2026').replace(/[^0-9]/g, '');
  const section = (url.searchParams.get('section') || 'earningstotal').toLowerCase();
  if (!SPORTS.has(sport))     return json({ error: `sport not allowed: ${sport}` }, 400);
  if (!SECTIONS.has(section)) return json({ error: `section not allowed: ${section}` }, 400);
  if (!season)                return json({ error: 'bad season' }, 400);

  const page = before =>
    `https://web.realapp.com/userpassshop/${sport}/season/${season}/entity/player/section/${section}?before=${before}`;

  // Probes for the two other RS screens, so their payloads can be read before
  // anything is built on them. Both are fixed shapes, not a free-form proxy.
  const probePlayer = url.searchParams.get('probePlayer');
  if (probePlayer && /^\d+$/.test(probePlayer) && !url.searchParams.get('probeSub')) {
    try {
      const d = await rsGet(`https://web.realapp.com/players/${probePlayer}/sport/${sport}`, auth);
      const shape = (o, depth = 0) => {
        if (Array.isArray(o)) return [`array(${o.length})`, o.length && depth < 2 ? shape(o[0], depth + 1) : null];
        if (o && typeof o === 'object') {
          const out = {};
          for (const [k, v] of Object.entries(o)) {
            out[k] = (v && typeof v === 'object')
              ? (depth < 2 ? shape(v, depth + 1) : Array.isArray(v) ? `array(${v.length})` : 'object')
              : v;
          }
          return out;
        }
        return o;
      };
      return json({ keys: Object.keys(d || {}), shape: shape(d) });
    } catch (e) { return json({ error: String((e && e.message) || e) }, 502); }
  }

  // Probe a fixed sub-screen of a player page (the feed / stats / owners
  // panels). The suffix is whitelisted, so this stays a set of named screens
  // rather than an open path.
  const SUBS = {
    seasonfeed: 'seasonfeed?limit=10&season=SEASON&view=recent&viewFrame=default',
    stats:      'stats?season=SEASON',
    seasonstats:'seasonstats?season=SEASON',
    owners:     'owners?season=SEASON',
    holders:    'holders?season=SEASON'
  };
  const probeSub = url.searchParams.get('probeSub');
  if (probeSub && probePlayer && /^\d+$/.test(probePlayer)) {
    const suffix = SUBS[probeSub.toLowerCase()];
    if (!suffix) return json({ error: 'sub not allowed', allowed: Object.keys(SUBS) }, 400);
    const u = `https://web.realapp.com/players/${probePlayer}/sport/${sport}/${suffix.replace('SEASON', season)}`;
    try {
      const d = await rsGet(u, auth);
      return json({ sub: probeSub, raw: d });
    } catch (e) { return json({ sub: probeSub, error: String((e && e.message) || e) }, 502); }
  }

  if (url.searchParams.get('probeLeaders')) {
    const mode = (url.searchParams.get('mode') || 'averages').replace(/[^a-z]/g, '');
    try {
      const d = await rsGet(`https://web.realapp.com/playerstatleaders/${sport}/seasons?mode=${mode}`, auth);
      const firstArray = o => {
        if (Array.isArray(o)) return o;
        if (o && typeof o === 'object') for (const v of Object.values(o)) { const r = firstArray(v); if (r) return r; }
        return null;
      };
      const rows = firstArray(d) || [];
      return json({ topLevelKeys: Object.keys(d || {}), rowCount: rows.length,
                    firstRowKeys: rows[0] ? Object.keys(rows[0]) : [], firstRow: rows[0] || null });
    } catch (e) { return json({ error: String((e && e.message) || e) }, 502); }
  }

  // Probe: hand back the first page untouched, plus the keys on one row, so
  // the payload can be inspected before anything is built on top of it.
  if (url.searchParams.get('probe')) {
    try {
      const data = await rsGet(page(0), auth);
      const rows = rowsOf(data);
      return json({
        topLevelKeys: Object.keys(data || {}),
        rowCount: rows.length,
        firstRowKeys: rows[0] ? Object.keys(rows[0]) : [],
        firstRow: rows[0] || null,
        secondRow: rows[1] || null
      });
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 502);
    }
  }

  // ?combined=1&format=csv — one row per player with BOTH numbers.
  // Purchases are collected first into a lookup, then the earnings walk streams
  // rows as it goes, joined on player id. The purchases pass writes a progress
  // line per page so the connection never sits silent long enough to be cut.
  if (url.searchParams.get('combined') === '1') {
    const { readable, writable } = new TransformStream();
    const w = writable.getWriter();
    const enc = new TextEncoder();
    const send = t => w.write(enc.encode(t));
    const cell = v => {
      const t = v == null ? '' : String(v);
      return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const walk = async (sec, onPage) => {
      let before = 0;
      for (let i = 0; i < ALL_MAX_PAGES; i++) {
        if (i) await sleep(GAP_MS);
        const rows = rowsOf(await rsGet(
          `https://web.realapp.com/userpassshop/${sport}/season/${season}/entity/player/section/${sec}?before=${before}`, auth));
        await onPage(rows);
        before += PAGE;
        if (rows.length < PAGE) break;
      }
    };

    (async () => {
      const purchases = new Map();
      try {
        await send(`# building ${sport} ${season}: purchases first, then earnings\n`);
        let seen = 0;
        await walk('hotseason', async rows => {
          for (const r of rows) purchases.set(r.id, r.value);
          seen += rows.length;
          await send(`# purchases collected: ${seen}\n`);
        });

        await send(['rank', 'player', 'rax', 'purchases', 'playerId', 'teamId',
                    'jersey', 'firstName', 'lastName', 'sport', 'season'].join(',') + '\n');
        let n = 0;
        await walk('earningstotal', async rows => {
          for (const r of rows) {
            n++;
            const e = r.entity || {};
            await send([n, r.label || '', r.value, purchases.has(r.id) ? purchases.get(r.id) : '',
                        r.id, e.teamId, e.jersey, e.firstName, e.lastName, r.sport, season]
                       .map(cell).join(',') + '\n');
          }
        });
        await send(`# done: ${n} players, ${purchases.size} with a purchases figure\n`);
      } catch (e) {
        await send(`# stopped: ${String((e && e.message) || e).replace(/\n/g, ' ')}\n`);
      }
      await w.close();
    })();

    return new Response(readable, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${sport}-${season}-rax-and-purchases.csv"`,
        'cache-control': 'no-store'
      }
    });
  }

  // ?all=1&format=csv streams: a season runs to thousands of players and the
  // pages have to be spaced out, so waiting for the whole walk before replying
  // would time out. Instead the response opens immediately and each page is
  // written as it arrives, and the browser saves it as it goes.
  if (url.searchParams.get('all') === '1' && url.searchParams.get('format') === 'csv') {
    const { readable, writable } = new TransformStream();
    const w = writable.getWriter();
    const enc = new TextEncoder();
    const cell = v => {
      const t = v == null ? '' : String(v);
      return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const COLS = ['rank', 'player', 'rax', 'playerId', 'teamId', 'jersey', 'firstName', 'lastName', 'sport', 'season'];

    (async () => {
      let n = 0, before = 0;
      try {
        await w.write(enc.encode(COLS.join(',') + '\n'));
        for (let i = 0; i < ALL_MAX_PAGES; i++) {
          if (i) await sleep(GAP_MS);
          const rows = rowsOf(await rsGet(page(before), auth));
          for (const r of rows) {
            n++;
            const e = r.entity || {};
            await w.write(enc.encode([
              n, r.label || '', r.value, r.id, e.teamId, e.jersey,
              e.firstName, e.lastName, r.sport, season
            ].map(cell).join(',') + '\n'));
          }
          before += PAGE;
          if (rows.length < PAGE) break;
        }
      } catch (e) {
        // Partial file beats no file — say where it stopped, in the file.
        await w.write(enc.encode(`# stopped after ${n} players: ${String((e && e.message) || e).replace(/\n/g, ' ')}\n`));
      }
      await w.close();
    })();

    return new Response(readable, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${sport}-${season}-rax.csv"`,
        'cache-control': 'no-store'
      }
    });
  }

  // ?all=1 without csv still walks in one go, for a quick look in the browser.
  const start = Math.max(0, parseInt(url.searchParams.get('start') || '0', 10));
  const wantsAll = url.searchParams.get('all') === '1';
  const out = [];
  let next = start, done = false;
  const limit = wantsAll ? ALL_MAX_PAGES : CHUNK_PAGES;
  try {
    for (let i = 0; i < limit; i++) {
      if (i) await sleep(GAP_MS);
      const rows = rowsOf(await rsGet(page(next), auth));
      out.push(...rows);
      next += PAGE;
      if (rows.length < PAGE) { done = true; break; }
    }
  } catch (e) {
    return json({ error: String((e && e.message) || e), got: out.length, nextStart: next }, 502);
  }

  if (url.searchParams.get('format') === 'csv') {
    const cell = v => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    // Flatten the useful bits of each row: the leaderboard nests the player
    // under `entity`, and everything else on the row is chrome.
    const rows = out.map(r => ({
      player:    r.label || '',
      rax:       r.value,
      playerId:  r.id,
      teamId:    r.entity && r.entity.teamId,
      jersey:    r.entity && r.entity.jersey,
      firstName: r.entity && r.entity.firstName,
      lastName:  r.entity && r.entity.lastName,
      sport:     r.sport,
      season
    }));
    const cols = Object.keys(rows[0] || { player: '', rax: '' });
    const csv = [cols.join(',')]
      .concat(rows.map(r => cols.map(c => cell(r[c])).join(',')))
      .join('\n');
    return new Response(csv, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${sport}-${season}-${section}.csv"`
      }
    });
  }

  return json({ sport, season, section, count: out.length, done, nextStart: done ? null : next, players: out });
}
