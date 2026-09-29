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
const GAP_MS = 350;                  // breathing room between pages
const RETRIES = 3;                   // RS answers 429 under load
const SPORTS = new Set(['ncaam', 'ncaaf', 'nfl', 'soccer', 'nba', 'mlb', 'nhl', 'ufc', 'wnba']);
const SECTIONS = new Set(['earningstotal']);

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

  // One call walks a handful of pages and reports where to pick up, so the
  // caller can work through a whole season without any single request
  // running long enough to be killed.
  const start = Math.max(0, parseInt(url.searchParams.get('start') || '0', 10));
  const out = [];
  let next = start, done = false;
  try {
    for (let i = 0; i < CHUNK_PAGES; i++) {
      if (i) await sleep(GAP_MS);
      const rows = rowsOf(await rsGet(page(next), auth));
      out.push(...rows);
      next += PAGE;
      if (rows.length < PAGE) { done = true; break; }
    }
  } catch (e) {
    return json({ error: String((e && e.message) || e), got: out.length, nextStart: next }, 502);
  }

  if (url.searchParams.get('format') === 'csv') {   // single chunk only
    const cell = v => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const cols = [...new Set(out.flatMap(r => Object.keys(r)))]
      .filter(k => out.some(r => r[k] == null || typeof r[k] !== 'object'));
    const csv = [cols.join(',')]
      .concat(out.map(r => cols.map(c => cell(r[c])).join(',')))
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
