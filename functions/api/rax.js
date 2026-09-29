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
const LIST_MAX_PAGES = 700;          // player-list ceiling: 700 x 20 = 14,000
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

  // Try a fixed list of candidate URL shapes and report which ones answer.
  // Used once, to find the screens behind "games played" and the owners count.
  if (url.searchParams.get('probeMany')) {
    const which = url.searchParams.get('probeMany').toLowerCase();
    const pid = /^\d+$/.test(probePlayer || '') ? probePlayer : '5041935';
    const B = 'https://web.realapp.com';
    const LISTS = {
      leaders: [
        `${B}/playerstatleaders/${sport}/season/${season}?mode=totals&statType=50&before=0`,
        `${B}/playerstatleaders/${sport}/season/${season}/stat/50?mode=totals&before=0`,
        `${B}/playerstatleaders/${sport}/season/${season}/statType/50?mode=totals&before=0`,
        `${B}/playerstatleaders/${sport}/seasons/${season}?mode=totals&statType=50`,
        `${B}/playerstatleaders/${sport}?season=${season}&statType=50&mode=totals&before=0`,
        `${B}/playerstatleaders/${sport}/${season}/50?mode=totals&before=0`
      ],
      owners: [
        `${B}/players/${pid}/sport/${sport}/owners?season=${season}`,
        `${B}/players/${pid}/sport/${sport}/holders?season=${season}`,
        `${B}/players/${pid}/sport/${sport}/collectors?season=${season}`,
        `${B}/players/${pid}/sport/${sport}/passholders?season=${season}`,
        `${B}/userpassshop/${sport}/season/${season}/entity/player/${pid}`,
        `${B}/userpassshop/${sport}/season/${season}/entity/player/${pid}/owners`,
        `${B}/collection/${sport}/season/${season}/entity/player/${pid}/owners`
      ]
    };
    const list = LISTS[which];
    if (!list) return json({ error: 'probeMany must be leaders or owners' }, 400);
    const out = [];
    for (const u of list) {
      const tail = u.replace(B, '');
      try {
        const d = await rsGet(u, auth);
        const rows = rowsOf(d);
        out.push({ path: tail, ok: true, keys: Object.keys(d || {}).slice(0, 25),
                   rowCount: rows.length, firstRowKeys: rows[0] ? Object.keys(rows[0]).slice(0, 30) : [],
                   sample: JSON.stringify(d).slice(0, 600) });
      } catch (e) {
        out.push({ path: tail, ok: false, why: String((e && e.message) || e).slice(0, 160) });
      }
      await sleep(250);
    }
    return json({ probeMany: which, results: out });
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

  // Games played is only on a player's own season screen, one player at a
  // time, and RS has no bulk version of it. A Worker can only make so many
  // outbound calls in one request, so the figures are collected a slice at a
  // time into KV and the CSV reads them from there. Re-opening the collector
  // picks up where it left off; it is finished when it says every player has
  // a figure.
  //
  //   ?games=1            -> collect the next slice (default 800 players)
  //   ?games=1&rebuild=1  -> rebuild the player list first
  //   ?games=status       -> how far along it is, without fetching anything
  const GAMES_KEY = `games_${sport}_${season}`;
  const readGames = async () => {
    try {
      const raw = await env.RATEBOARD_KV.get(GAMES_KEY);
      const o = raw ? JSON.parse(raw) : null;
      return (o && typeof o === 'object') ? { ids: o.ids || [], games: o.games || {}, updated: o.updated || 0 }
                                          : { ids: [], games: {}, updated: 0 };
    } catch (e) { return { ids: [], games: {}, updated: 0 }; }
  };

  // A page that drives the collector to the end on its own, so the whole
  // season can be gathered from one click instead of a dozen reloads.
  if (url.searchParams.get('games') === 'go') {
    const q = `sport=${encodeURIComponent(sport)}&season=${encodeURIComponent(season)}`;
    const html = `<!doctype html><meta charset="utf-8">
<title>Games played - ${sport} ${season}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root{color-scheme:light dark}
  body{font:15px/1.5 system-ui,sans-serif;margin:0;padding:20px;max-width:760px}
  h1{font-size:18px;margin:0 0 4px}
  p{margin:0 0 14px;opacity:.75}
  #bar{height:10px;border-radius:5px;background:#8883;overflow:hidden;margin:14px 0}
  #fill{height:100%;width:0;background:#2b8a3e;transition:width .4s}
  #log{white-space:pre-wrap;font:12px/1.45 ui-monospace,monospace;background:#8881;
       border-radius:8px;padding:10px;max-height:50vh;overflow:auto}
  a.btn{display:inline-block;margin-top:14px;padding:9px 14px;border-radius:8px;
        background:#2b8a3e;color:#fff;text-decoration:none;font-weight:600}
  a.btn[hidden]{display:none}
</style>
<h1>Games played &mdash; ${sport} ${season}</h1>
<p id="sub">Starting&hellip; leave this tab open.</p>
<div id="bar"><div id="fill"></div></div>
<div id="log"></div>
<a class="btn" id="dl" hidden href="/api/rax?${q}&combined=1&format=csv">Download the CSV</a>
<script>
const sub=document.getElementById('sub'),fill=document.getElementById('fill'),
      log=document.getElementById('log'),dl=document.getElementById('dl');
let stalled=0;
function say(t){log.textContent+=t;log.scrollTop=log.scrollHeight}
async function pass(){
  const r=await fetch('/api/rax?${q}&games=1&limit=800',{cache:'no-store'});
  const rd=r.body.getReader(),dec=new TextDecoder();let buf='',state=null;
  for(;;){const{done,value}=await rd.read();if(done)break;
    const t=dec.decode(value,{stream:true});buf+=t;say(t);
    const m=buf.match(/##STATE (\\d+) (\\d+) (\\d+)/);
    if(m)state={have:+m[1],total:+m[2],left:+m[3]};}
  return state;
}
(async()=>{
  for(let i=0;i<40;i++){
    let s=null;
    try{s=await pass()}catch(e){say('\\nnetwork hiccup: '+e+'\\nretrying...\\n');await new Promise(r=>setTimeout(r,4000));continue}
    if(!s){say('\\n(building the player list - continuing)\\n');await new Promise(r=>setTimeout(r,1500));continue}
    fill.style.width=(100*s.have/Math.max(1,s.total)).toFixed(1)+'%';
    sub.textContent=s.have.toLocaleString()+' of '+s.total.toLocaleString()+' players done';
    if(s.left<=0){sub.textContent='Done - '+s.total.toLocaleString()+' players.';dl.hidden=false;return}
    if(s.left===stalled){say('\\nno progress on that pass - stopping.\\n');dl.hidden=false;return}
    stalled=s.left;
    say('\\n--- next pass ---\\n');
  }
  sub.textContent='Stopped after 40 passes - reopen this page to carry on.';dl.hidden=false;
})();
</script>`;
    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
  }

  const gamesArg = url.searchParams.get('games');
  if (gamesArg === 'status') {
    const st = await readGames();
    const have = st.ids.filter(id => st.games[id] != null).length;
    return json({ players: st.ids.length, withGames: have,
                  remaining: Math.max(0, st.ids.length - have),
                  updated: st.updated ? new Date(st.updated).toISOString() : null });
  }

  if (gamesArg === '1') {
    const LIMIT = Math.min(850, Math.max(25, parseInt(url.searchParams.get('limit') || '800', 10) || 800));
    const { readable, writable } = new TransformStream();
    const w = writable.getWriter();
    const enc = new TextEncoder();
    const send = t => w.write(enc.encode(t));

    (async () => {
      try {
        const store = await readGames();

        if (!store.ids.length || url.searchParams.get('rebuild') === '1') {
          await send(`building the ${sport} ${season} player list...\n`);
          const ids = [];
          let before = 0;
          for (let i = 0; i < LIST_MAX_PAGES; i++) {
            if (i) await sleep(GAP_MS);
            const rows = rowsOf(await rsGet(
              `https://web.realapp.com/userpassshop/${sport}/season/${season}/entity/player/section/earningstotal?before=${before}`, auth));
            for (const r of rows) if (r && r.id != null) ids.push(String(r.id));
            before += PAGE;
            await send(`  ${ids.length} players\n`);
            if (rows.length < PAGE) break;
          }
          store.ids = ids;
          if (url.searchParams.get('rebuild') === '1') store.games = {};
          await env.RATEBOARD_KV.put(GAMES_KEY, JSON.stringify(store));
          await send(`player list: ${ids.length}\n`);
          // Building the list uses most of one request's outbound-call budget,
          // so the games themselves start on the next pass.
          await send(`list saved - collecting starts on the next pass.\n`);
          await w.close();
          return;
        }

        const missing = store.ids.filter(id => store.games[id] == null).slice(0, LIMIT);
        if (!missing.length) {
          await send(`nothing left to collect - all ${store.ids.length} players have a games figure.\n`);
          await send(`##STATE ${store.ids.length} ${store.ids.length} 0\n`);
          await w.close();
          return;
        }
        await send(`collecting games played for ${missing.length} of ${store.ids.length} players...\n`);

        let done = 0, blank = 0;
        for (const id of missing) {
          try {
            const d = await rsGet(
              `https://web.realapp.com/players/${id}/sport/${sport}/seasonfeed?limit=1&season=${season}&view=recent&viewFrame=default`, auth);
            const g = d && d.statsInfo && d.statsInfo.games;
            store.games[id] = (g == null ? 0 : Number(g) || 0);
            if (g == null) blank++;
          } catch (e) {
            // Leave this one unset so the next run retries it.
          }
          done++;
          if (done % 50 === 0) {
            store.updated = Date.now();
            await env.RATEBOARD_KV.put(GAMES_KEY, JSON.stringify(store));
            await send(`  ${done} / ${missing.length}\n`);
          }
          await sleep(120);
        }
        store.updated = Date.now();
        await env.RATEBOARD_KV.put(GAMES_KEY, JSON.stringify(store));

        const have = store.ids.filter(id => store.games[id] != null).length;
        const left = store.ids.length - have;
        await send(`\ncollected ${done} this run${blank ? ` (${blank} had no stats line)` : ''}.\n`);
        await send(left > 0
          ? `${have} of ${store.ids.length} players done - ${left} to go.\n`
          : `all ${store.ids.length} players have a games figure. The CSV will include it now.\n`);
        await send(`##STATE ${have} ${store.ids.length} ${left}\n`);
      } catch (e) {
        await send(`\nstopped: ${String((e && e.message) || e).replace(/\n/g, ' ')}\n`);
      }
      await w.close();
    })();

    return new Response(readable, {
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
    });
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

        const gs = (await readGames()).games || {};
        await send(['rank', 'player', 'rax', 'purchases', 'gamesPlayed', 'playerId', 'teamId',
                    'jersey', 'firstName', 'lastName', 'sport', 'season'].join(',') + '\n');
        let n = 0;
        await walk('earningstotal', async rows => {
          for (const r of rows) {
            n++;
            const e = r.entity || {};
            await send([n, r.label || '', r.value, purchases.has(r.id) ? purchases.get(r.id) : '',
                        gs[String(r.id)] == null ? '' : gs[String(r.id)],
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
