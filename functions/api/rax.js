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
const LIST_CHUNK_PAGES = 60;         // pages per call, so a scheduled run finishes in time
const OWNERS_CHUNK_PAGES = 45;
// The leaderboard walk misses anyone too lightly owned to make it onto the
// shop list, so the leftovers are asked for one at a time. This is the size of
// one tick's worth of those.
const OWNERTOP_CHUNK = 45;
// Players per pass of the tournament-name and finishing-position walk.
const GOLFMETA_CHUNK = 25;
// While the queue is resting between seasons, the backfill keeps going but at
// a slower drip - the rest exists so the account doesn't look like a crawler,
// and 45 player lookups a minute for two hours would undo that.
const OWNERTOP_REST_CHUNK = 12;
const CONF_CHUNK = 60;               // teams per conference-backfill pass
const GAP_MS = 350;                  // breathing room between pages
const RETRIES = 3;                   // RS answers 429 under load
const SPORTS = new Set(['ncaam', 'ncaaf', 'nfl', 'soccer', 'nba', 'mlb', 'nhl', 'ufc', 'wnba',
                        'golf', 'tennis']);
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


// ---------------------------------------------------------------------------
// Game-by-game logs
//
// Every game a player appeared in comes back on their season feed, each with
// the rax that game earned plus the full box line. One player per call, so the
// season is gathered a slice at a time into D1 and exported from there.

const GAMELOG_DDL = `CREATE TABLE IF NOT EXISTS gamelog (
  sport TEXT NOT NULL,
  season INTEGER NOT NULL,
  playerId INTEGER NOT NULL,
  gameId INTEGER NOT NULL,
  player TEXT, team TEXT, conference TEXT, jersey INTEGER, position TEXT,
  day TEXT, seasonType TEXT, opponent TEXT, homeAway TEXT,
  teamScore INTEGER, oppScore INTEGER, result TEXT,
  rating REAL,
  rax INTEGER,
  played INTEGER, min INTEGER, pts INTEGER, reb INTEGER, oreb INTEGER, dreb INTEGER,
  ast INTEGER, stl INTEGER, blk INTEGER, tov INTEGER, pf INTEGER, plusMinus INTEGER,
  fg TEXT, fgPct REAL, fg3 TEXT, fg3Pct REAL, ft TEXT, ftPct REAL, tsPct REAL,
  fantasyPts REAL, comments INTEGER,
  PRIMARY KEY (sport, season, playerId, gameId)
)`;

// One row per event. Golf's game rows carry a gameId but nothing that names
// the tournament, and the name is the only thing that ties the same event
// together across years.
const TOURNAMENT_DDL = `CREATE TABLE IF NOT EXISTS tournament (
  sport TEXT NOT NULL, season INTEGER NOT NULL, gameId INTEGER NOT NULL,
  name TEXT, course TEXT, day TEXT,
  PRIMARY KEY (sport, season, gameId)
)`;

const OWNERS_DDL = `CREATE TABLE IF NOT EXISTS owners (
  sport TEXT NOT NULL,
  season INTEGER NOT NULL,
  playerId INTEGER NOT NULL,
  day TEXT NOT NULL,
  owners INTEGER,
  player TEXT,
  PRIMARY KEY (sport, season, playerId, day)
)`;

const GAMELOG_COLS = ['sport','season','playerId','gameId','player','team','conference','jersey','position',
  'day','seasonType','opponent','homeAway','teamScore','oppScore','result','rax','rating',
  'played','min','pts','reb','oreb','dreb','ast','stl','blk','tov','pf','plusMinus',
  'fg','fgPct','fg3','fg3Pct','ft','ftPct','tsPct','fantasyPts','comments'];

// rax is filled by its own pass from the earnings screen, so the box-score
// insert leaves that column alone rather than blanking it.
const GAMELOG_FEED_COLS = GAMELOG_COLS.filter(c => c !== 'rax');

// Earlier versions stored the game rating in a column called rax. Both
// statements are no-ops once they have run.
async function migrateGamelog(db) {
  await db.prepare(GAMELOG_DDL).run();
  try { await db.prepare('ALTER TABLE gamelog RENAME COLUMN rax TO rating').run(); } catch (e) {}
  try { await db.prepare('ALTER TABLE gamelog ADD COLUMN rax INTEGER').run(); } catch (e) {}
  try { await db.prepare('ALTER TABLE gamelog ADD COLUMN conference TEXT').run(); } catch (e) {}
  // Without these the per-player owner lookup rescans the snapshot table for
  // every row, which turns a season view into a half-minute wait.
  try { await db.prepare(
    'CREATE INDEX IF NOT EXISTS owners_lookup ON owners (sport, season, playerId, day)').run(); } catch (e) {}
  try { await db.prepare(
    'CREATE INDEX IF NOT EXISTS owners_latest ON owners (sport, season, day)').run(); } catch (e) {}
  try { await db.prepare(
    'CREATE INDEX IF NOT EXISTS gamelog_scope ON gamelog (sport, season, playerId)').run(); } catch (e) {}
  try { await db.prepare('ALTER TABLE gamelog ADD COLUMN position TEXT').run(); } catch (e) {}
  try { await db.prepare(TOURNAMENT_DDL).run(); } catch (e) {}
  try { await db.prepare(
    'CREATE INDEX IF NOT EXISTS gamelog_event ON gamelog (sport, season, gameId)').run(); } catch (e) {}
  try { await db.prepare(
    'CREATE INDEX IF NOT EXISTS tournament_name ON tournament (sport, name)').run(); } catch (e) {}
}

// Turns one box score from the season feed into a flat row.
function gamelogRow(sport, season, b) {
  const sv = {};
  for (const x of (b.statValues || [])) if (x && x.label) sv[x.label] = x;
  const val = k => { const x = sv[k]; return x && x.value != null ? x.value : null; };
  const numv = k => { const v = val(k); const n = Number(v); return Number.isFinite(n) ? n : null; };
  const pct = k => { const x = sv[k]; if (!x) return null;
    const n = Number(String(x.secondaryValue == null ? '' : x.secondaryValue).replace('%', ''));
    return Number.isFinite(n) ? n : null; };

  const isHome = b.homeTeamId != null && b.teamId != null && b.homeTeamId === b.teamId;
  const oppTeam = isHome ? (b.awayTeam || {}) : (b.homeTeam || {});
  const p = b.player || {};
  const t = b.team || {};
  const rating = Number(b.value);

  return {
    sport, season: Number(season), playerId: b.playerId, gameId: b.gameId,
    player: [p.firstName, p.lastName].filter(Boolean).join(' ').trim() || null,
    team: t.key || null, conference: t.conference || null,
    jersey: p.jersey == null ? null : Number(p.jersey), position: b.position || null,
    day: b.day || null, seasonType: b.seasonType || null,
    opponent: oppTeam.key || null, homeAway: isHome ? 'home' : 'away',
    teamScore: isHome ? b.homeTeamScore : b.awayTeamScore,
    oppScore: isHome ? b.awayTeamScore : b.homeTeamScore,
    result: b.gameResultLabel || null,
    rating: Number.isFinite(rating) ? rating : null,
    played: b.played ? 1 : 0,
    min: numv('min'), pts: numv('pts'), reb: numv('reb'), oreb: numv('oreb'), dreb: numv('dreb'),
    ast: numv('ast'), stl: numv('stl'), blk: numv('blk'), tov: numv('to'), pf: numv('pf'),
    plusMinus: numv('+/-'),
    fg: val('fg') == null ? null : String(val('fg')), fgPct: pct('fg') != null ? pct('fg') : numv('fg%'),
    fg3: val('3fg') == null ? null : String(val('3fg')), fg3Pct: pct('3fg'),
    ft: val('fts') == null ? null : String(val('fts')), ftPct: pct('fts'),
    tsPct: numv('ts%'),
    fantasyPts: b.fantasyStats && b.fantasyStats.default != null ? Number(b.fantasyStats.default) : null,
    comments: b.commentCount == null ? null : Number(b.commentCount)
  };
}

// A page that keeps calling a collector until it reports nothing left, so a
// whole season can be gathered from one click.
function runnerHtml(opts) {
  const esc = t => String(t).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  return '<!doctype html><meta charset="utf-8">'
    + '<title>' + esc(opts.title) + '</title>'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<style>'
    + ':root{color-scheme:light dark}'
    + 'body{font:15px/1.5 system-ui,sans-serif;margin:0;padding:20px;max-width:760px}'
    + 'h1{font-size:18px;margin:0 0 4px}p{margin:0 0 14px;opacity:.75}'
    + '#bar{height:10px;border-radius:5px;background:#8883;overflow:hidden;margin:14px 0}'
    + '#fill{height:100%;width:0;background:#2b8a3e;transition:width .4s}'
    + '#log{white-space:pre-wrap;font:12px/1.45 ui-monospace,monospace;background:#8881;'
    + 'border-radius:8px;padding:10px;max-height:50vh;overflow:auto}'
    + 'a.btn{display:inline-block;margin-top:14px;padding:9px 14px;border-radius:8px;'
    + 'background:#2b8a3e;color:#fff;text-decoration:none;font-weight:600}a.btn[hidden]{display:none}'
    + '</style>'
    + '<h1>' + esc(opts.title) + '</h1>'
    + '<p id="sub">Starting&hellip; leave this tab open.</p>'
    + '<div id="bar"><div id="fill"></div></div><div id="log"></div>'
    + '<a class="btn" id="dl" hidden href="' + esc(opts.dlUrl) + '">' + esc(opts.dlLabel || 'Download the CSV') + '</a>'
    + '<script>\n'
    + 'var PASS=' + JSON.stringify(opts.passUrl) + ';\n'
    + 'var sub=document.getElementById("sub"),fill=document.getElementById("fill"),'
    + 'log=document.getElementById("log"),dl=document.getElementById("dl"),stalled=-1;\n'
    + 'function say(t){log.textContent+=t;log.scrollTop=log.scrollHeight}\n'
    + 'async function pass(){\n'
    + '  var r=await fetch(PASS,{cache:"no-store"});\n'
    + '  var rd=r.body.getReader(),dec=new TextDecoder(),buf="",state=null;\n'
    + '  for(;;){var c=await rd.read();if(c.done)break;var t=dec.decode(c.value,{stream:true});\n'
    + '    buf+=t;say(t);var m=buf.match(/##STATE (\\d+) (\\d+) (\\d+)/);\n'
    + '    if(m)state={have:+m[1],total:+m[2],left:+m[3]};}\n'
    + '  return state;}\n'
    + '(async function(){\n'
    + '  for(var i=0;i<60;i++){var s=null;\n'
    + '    try{s=await pass()}catch(e){say("\\nnetwork hiccup: "+e+"\\nretrying...\\n");await new Promise(r=>setTimeout(r,4000));continue}\n'
    + '    if(!s){say("\\n(setting up - continuing)\\n");await new Promise(r=>setTimeout(r,1500));continue}\n'
    + '    fill.style.width=(100*s.have/Math.max(1,s.total)).toFixed(1)+"%";\n'
    + '    sub.textContent=s.have.toLocaleString()+" of "+s.total.toLocaleString()+" players done";\n'
    + '    if(s.left<=0){sub.textContent="Done - "+s.total.toLocaleString()+" players.";dl.hidden=false;return}\n'
    + '    if(s.left===stalled){say("\\nno progress on that pass - stopping.\\n");dl.hidden=false;return}\n'
    + '    stalled=s.left;say("\\n--- next pass ---\\n");}\n'
    + '  sub.textContent="Stopped after 60 passes - reopen this page to carry on.";dl.hidden=false;})();\n'
    + '</' + 'script>';
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
  for (const k of ['entities', 'items', 'results', 'players', 'data', 'listings']) {
    if (Array.isArray(data && data[k])) return data[k];
  }
  return [];
}

// Owner counts for the players the shop leaderboard never lists. That list is
// ordered by ownership and stops well short of the full field, so anyone held
// by a handful of people is absent from it and renders blank rather than as
// the small number they actually are. The player endpoint answers per season -
// players/{id}/sport/{sport}?season=2024 gives that season's card - so the
// leftovers are filled in one at a time from there.
// Whether the per-player owner backfill still has anyone left for this season.
async function ownerTopOutstanding(env, sport, season){
  try {
    const o = JSON.parse((await env.RATEBOARD_KV.get(`ownertop_${sport}_${season}`)) || 'null');
    if (!o || !o.doneDay) return true;
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    return o.doneDay < weekAgo;
  } catch (e) { return true; }
}

async function ownerTopSlice(env, sport, season, auth, statusOnly) {
  {
    const which = statusOnly ? 'status' : '1';
    const db = env.RATEBOARD_DB;
    const KEY = `ownertop_${sport}_${season}`;
    const today = new Date().toISOString().slice(0, 10);

    // Walks by player id rather than by "who is still missing". Plenty of
    // players have no card for a given season at all - the endpoint answers
    // for a different year and the answer is thrown away - and those would
    // otherwise come back as missing on every single pass, so the walk would
    // never get past them.
    let chunk = OWNERTOP_CHUNK;
    try {
      const pace = JSON.parse((await env.RATEBOARD_KV.get('queue_pace_v1')) || '{}') || {};
      if (pace.holdUntil && pace.holdUntil > Date.now()) chunk = OWNERTOP_REST_CHUNK;
    } catch (e) {}

    const MISSING = `SELECT g.playerId AS id, MAX(g.player) AS player
                       FROM gamelog g
                      WHERE g.sport = ? AND g.season = ? AND g.playerId > ?
                        AND NOT EXISTS (SELECT 1 FROM owners o
                                         WHERE o.sport = g.sport AND o.season = g.season
                                           AND o.playerId = g.playerId)
                      GROUP BY g.playerId
                      ORDER BY g.playerId LIMIT ?`;

    const readTop = async () => {
      try {
        const o = JSON.parse((await env.RATEBOARD_KV.get(KEY)) || 'null');
        return { doneDay: (o && o.doneDay) || '', filled: (o && o.filled) || 0,
                 afterId: (o && o.afterId) || 0 };
      } catch (e) { return { doneDay: '', filled: 0, afterId: 0 }; }
    };

    if (which === 'status') {
      const st = await readTop();
      let missing = null, left = null;
      try {
        const r = await db.prepare(
          `SELECT COUNT(*) AS n FROM (${MISSING.replace('LIMIT ?', 'LIMIT 100000')})`)
          .bind(sport, Number(season), 0).first();
        missing = r ? r.n : null;
        const l = await db.prepare(
          `SELECT COUNT(*) AS n FROM (${MISSING.replace('LIMIT ?', 'LIMIT 100000')})`)
          .bind(sport, Number(season), st.afterId).first();
        left = l ? l.n : null;
      } catch (e) {}
      return json({ missing, stillToTry: left, filledSoFar: st.filled,
                    afterId: st.afterId, lastFinished: st.doneDay || null });
    }


    const { readable, writable } = new TransformStream();
    const w = writable.getWriter();
    const enc = new TextEncoder();
    const send = t => w.write(enc.encode(t));

    (async () => {
      try {
        await db.prepare(OWNERS_DDL).run();
        const st = await readTop();

        const res = await db.prepare(MISSING)
          .bind(sport, Number(season), st.afterId, chunk + 1).all();
        const rows = (res && res.results) || [];
        if (!rows.length) {
          st.doneDay = today;
          st.afterId = 0;
          await env.RATEBOARD_KV.put(KEY, JSON.stringify(st));
          await send(`every player already has an owner count.\n`);
          await send(`##STATE ${st.filled} ${st.filled} 0\n`);
          await w.close();
          return;
        }

        const batch = rows.slice(0, chunk);
        await send(`filling owner counts one player at a time for ${sport} ${season}` +
                   ` (${rows.length > chunk ? 'more than ' : ''}${batch.length} left,` +
                   ` from player ${batch[0].id})...\n`);

        const sql = `INSERT OR REPLACE INTO owners (sport, season, playerId, day, owners, player)
                     VALUES (?, ?, ?, ?, ?, ?)`;
        const stmts = [];
        let asked = 0;
        for (const r of batch) {
          if (asked) await sleep(GAP_MS);
          asked++;
          let count = null, name = r.player || null;
          try {
            const d = await rsGet(
              `https://web.realapp.com/players/${r.id}/sport/${sport}?season=${season}`, auth);
            const pl = d && d.player;
            // Only trust the number when the card really is this season's -
            // without a season the endpoint answers with the current one, and
            // storing that against 2024 would be worse than leaving it blank.
            const info = d && d.userPassInfo;
            const ok = !info || info.season == null || Number(info.season) === Number(season);
            // A null count on the right season's card means nobody owns one,
            // which is a real answer worth storing - a blank would just send
            // the same player back round on every future pass.
            if (pl && ok) count = pl.passCount == null ? 0 : (Number(pl.passCount) || 0);
            if (pl && (pl.firstName || pl.lastName)) {
              name = `${pl.firstName || ''} ${pl.lastName || ''}`.trim() || name;
            }
          } catch (e) {}
          if (count == null) continue;
          stmts.push(db.prepare(sql).bind(
            sport, Number(season), Number(r.id), today, count, name));
        }

        for (let j = 0; j < stmts.length; j += 40) {
          const slice = stmts.slice(j, j + 40);
          if (slice.length) await db.batch(slice);
        }
        st.filled += stmts.length;
        st.afterId = Number(batch[batch.length - 1].id) || st.afterId;

        const finished = rows.length <= chunk;
        if (finished) { st.doneDay = today; st.afterId = 0; }
        await env.RATEBOARD_KV.put(KEY, JSON.stringify(st));
        await send(finished
          ? `\nfilled ${stmts.length} of ${batch.length} - that is the last of them.\n`
          : `\nfilled ${stmts.length} of ${batch.length} - continuing on the next pass.\n`);
        await send(`##STATE ${st.filled} ${st.filled} ${finished ? 0 : 1}\n`);
      } catch (e) {
        await send(`\nstopped: ${String((e && e.message) || e).replace(/\n/g, ' ')}\n`);
      }
      await w.close();
    })();

    return new Response(readable, {
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
    });
  }
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
  if (probePlayer && /^\d+$/.test(probePlayer) && !url.searchParams.get('probeSub') && !url.searchParams.get('gamelog')) {
    try {
      // With a season, to find out whether the pass count can be asked for per
      // season rather than only for the current card.
      const d = await rsGet(
        `https://web.realapp.com/players/${probePlayer}/sport/${sport}?season=${season}`, auth);
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
      return (o && typeof o === 'object')
        ? { ids: o.ids || [], games: o.games || {}, updated: o.updated || 0, building: o.building || null }
        : { ids: [], games: {}, updated: 0, building: null };
    } catch (e) { return { ids: [], games: {}, updated: 0, building: null }; }
  };

  // The card marketplace. Listings page by an end-time cursor plus an offset,
  // which is what the app itself uses.
  if (url.searchParams.get('probeMarket')) {
    const which = url.searchParams.get('probeMarket');
    const B = 'https://web.realapp.com';
    try {
      if (which === 'config') {
        const d = await rsGet(`${B}/cardmarketplaceconfiguration`, auth);
        return json({ keys: Object.keys(d || {}), raw: JSON.stringify(d).slice(0, 2500) });
      }
      const p = new URLSearchParams();
      for (const k of ['sport', 'season', 'listingType', 'rarity', 'prestige', 'cohort',
                       'beforeEndsAt', 'offset']) {
        const v = url.searchParams.get('m_' + k);
        if (v != null) p.set(k, v);
      }
      const d = await rsGet(`${B}/cardmarketplacelistings?${p.toString()}`, auth);
      const rows = rowsOf(d);
      const arr = rows.length ? rows : (Array.isArray(d) ? d : []);
      return json({
        topLevelKeys: Object.keys(d || {}),
        listingCount: d && d.listingCount,
        rowCount: arr.length,
        firstRowKeys: arr[0] ? Object.keys(arr[0]) : [],
        firstRow: arr[0] || null,
        lastRowEnds: arr.length ? (arr[arr.length - 1].endsAt || null) : null
      });
    } catch (e) { return json({ error: String((e && e.message) || e) }, 502); }
  }

  // Hunting for the market side: which shop sections exist beyond the two we
  // use, and whether there is a listings/auction endpoint at all.
  if (url.searchParams.get('scan') === 'market') {
    const SECTIONS = ['earningstotal', 'hotseason', 'trending', 'new', 'newest', 'recent',
                      'ending', 'endingsoon', 'auction', 'auctions', 'listings', 'forsale',
                      'pricehigh', 'pricelow', 'movers', 'gainers', 'losers', 'featured',
                      'popular', 'hot', 'hotweek', 'hotday', 'topsellers', 'available'];
    const PATHS = ['auctions', 'market', 'marketplace', 'listings', 'userpassauctions',
                   'userpassmarket', 'userpasslistings', 'packs', 'userpasspacks',
                   'shop', 'userpassshop', 'orders', 'trades'];
    const B = 'https://web.realapp.com';
    const sections = [], paths = [];

    for (const sec of SECTIONS) {
      try {
        const d = await rsGet(`${B}/userpassshop/${sport}/season/${season}/entity/player/section/${sec}?before=0`, auth);
        const rows = rowsOf(d);
        sections.push({ section: sec, ok: true, rows: rows.length,
                        firstRowKeys: rows[0] ? Object.keys(rows[0]) : [],
                        sample: rows[0] ? `${rows[0].label} = ${rows[0].value}` : null });
      } catch (e) {
        sections.push({ section: sec, ok: false, why: String((e && e.message) || e).slice(0, 70) });
      }
      await sleep(180);
    }

    for (const path of PATHS) {
      for (const suffix of [`/${sport}`, `/${sport}/season/${season}`, '']) {
        try {
          const d = await rsGet(`${B}/${path}${suffix}`, auth);
          paths.push({ path: path + suffix, ok: true,
                       keys: Object.keys(d || {}).slice(0, 20),
                       sample: JSON.stringify(d).slice(0, 300) });
          break;                                  // first shape that answers wins
        } catch (e) {
          const msg = String((e && e.message) || e);
          if (suffix === '') paths.push({ path, ok: false, why: msg.slice(0, 70) });
        }
        await sleep(150);
      }
    }
    return json({ sections: sections.filter(x => !x.ok || x.rows > 0), paths: paths.filter(x => x.ok) ,
                  sectionsTried: SECTIONS.length, pathsTried: PATHS.length });
  }

  // A capability sweep: which sports RS answers for, which season number is
  // live for each, and how big the player list is. Used to plan what can be
  // collected rather than guessing at it.
  if (url.searchParams.get('scan') === 'sports') {
    const CANDIDATES = ['ncaam', 'ncaaf', 'nfl', 'nba', 'mlb', 'nhl', 'soccer', 'wnba', 'ufc',
                        'golf', 'pga', 'pgatour', 'tennis', 'mma'];
    const YEARS = [2026, 2025];
    const out = [];
    for (const sp of CANDIDATES) {
      const entry = { sport: sp, seasons: {} };
      for (const y of YEARS) {
        try {
          const d = await rsGet(
            `https://web.realapp.com/userpassshop/${sp}/season/${y}/entity/player/section/earningstotal?before=0`, auth);
          const rows = rowsOf(d);
          entry.seasons[y] = { ok: true, rows: rows.length,
                               top: rows[0] ? `${rows[0].label} (${rows[0].value})` : null };
        } catch (e) {
          entry.seasons[y] = { ok: false, why: String((e && e.message) || e).slice(0, 90) };
        }
        await sleep(200);
      }
      try {
        const sd = await rsGet(`https://web.realapp.com/playerstatleaders/${sp}/seasons?mode=averages`, auth);
        entry.seasonsPayload = JSON.stringify(sd).slice(0, 700);
      } catch (e) { entry.seasonsPayload = 'n/a'; }
      await sleep(200);
      out.push(entry);
    }
    return json({ scanned: out.length, results: out });
  }

  // What a card actually earned for one game. "userpass" in the path is a
  // warning that this may be scoped to the signed-in account's own card rather
  // than to the player, which is the first thing to check here.
  if (url.searchParams.get('probeEarnings')) {
    const box = String(url.searchParams.get('probeEarnings')).replace(/[^0-9]/g, '');
    const pid = /^\d+$/.test(probePlayer || '') ? probePlayer : '5041935';
    const u = `https://web.realapp.com/userpassearnings/${sport}/season/${season}/entity/player/${pid}`
            + (box ? `?playerBoxScoreId=${box}` : '');
    try {
      return json({ playerId: pid, playerBoxScoreId: box, raw: await rsGet(u, auth) });
    } catch (e) { return json({ error: String((e && e.message) || e) }, 502); }
  }

  // One call that answers "what needs doing next?" across the whole queue.
  //
  // Without this the driver has to ask every season about every phase on every
  // firing, which at forty-odd seasons is hundreds of requests a minute for
  // nothing. Here the checks are internal reads, and a season with nothing left
  // today is remembered in a single marker so it is skipped until tomorrow.
  if (['next', 'resume', 'stuck'].includes(url.searchParams.get('queue'))) {
    const db = env.RATEBOARD_DB;
    const CLEAR_KEY = 'queue_clear_v1';
    const today = new Date().toISOString().slice(0, 10);

    // Cancels the current rest. For when a hold was set by something that was
    // not really a season's worth of collecting - the clock then says the
    // account has been working hard when it has been idle. Clearing lastJob
    // too, so the next job doesn't immediately start another rest for being a
    // different sport from whatever set this one.
    if (url.searchParams.get('queue') === 'stuck') {
      let st = {};
      try { st = JSON.parse((await env.RATEBOARD_KV.get('queue_stuck_v1')) || '{}') || {}; } catch (e) {}
      const skip = st.skip || {};
      if (url.searchParams.get('clear') === '1') {
        await env.RATEBOARD_KV.put('queue_stuck_v1', JSON.stringify({ skip: {} }));
        return json({ cleared: Object.keys(skip) });
      }
      return json({ setAsideToday: Object.entries(skip).filter(([, d]) => d === today).map(([k]) => k),
                    watching: st.tag || null, passes: st.n || 0 });
    }

    if (url.searchParams.get('queue') === 'resume') {
      let was = {};
      try { was = JSON.parse((await env.RATEBOARD_KV.get('queue_pace_v1')) || '{}') || {}; } catch (e) {}
      await env.RATEBOARD_KV.put('queue_pace_v1', JSON.stringify({ lastJob: '', holdUntil: 0 }));
      return json({ resumed: true,
                    wasRestingUntil: was.holdUntil ? new Date(was.holdUntil).toISOString() : null,
                    wasAfter: was.reason || null });
    }
    // A finished top-up is rechecked weekly rather than never, so players who
    // join a season later still pick up a count. With nothing missing the
    // recheck is one database query and no requests to Real at all.
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);

    const jobs = [];
    for (const bit of (url.searchParams.get('jobs') || '').split(',').slice(0, 120)) {
      const [sp, se] = String(bit).split(':');
      if (SPORTS.has(String(sp).toLowerCase()) && /^\d{4}$/.test(se)) {
        jobs.push([String(sp).toLowerCase(), Number(se)]);
      }
    }
    if (!jobs.length) return json({ phase: null, why: 'no jobs given' });

    let clear = {};
    try { clear = JSON.parse((await env.RATEBOARD_KV.get(CLEAR_KEY)) || '{}') || {}; } catch (e) {}

    const kv = async k => { try { return JSON.parse((await env.RATEBOARD_KV.get(k)) || 'null'); } catch (e) { return null; } };
    let changed = false;

    // Pacing. Collecting flat out for two days straight is the kind of pattern
    // that gets an account looked at, so the queue rests between seasons and
    // longer between sports. The rests are randomised rather than exact,
    // because a gap of precisely 45 minutes every time is itself a signature.
    const PACE_KEY = 'queue_pace_v1';
    const rest = (base, jitter) => base - jitter / 2 + Math.floor(Math.random() * jitter);
    const SEASON_REST = () => rest(45 * 60 * 1000, 20 * 60 * 1000);   // about 35-55 min
    const SPORT_REST  = () => rest(2 * 60 * 60 * 1000, 40 * 60 * 1000); // about 1h40-2h20
    let pace = {};
    try { pace = JSON.parse((await env.RATEBOARD_KV.get(PACE_KEY)) || '{}') || {}; } catch (e) {}

    // A phase that keeps being handed out while its own progress number stays
    // put is not working, and asking for it again every minute wedges the whole
    // queue behind it. After a few fruitless passes the phase is set aside for
    // the day and the queue moves on to work it can actually do.
    const STUCK_KEY = 'queue_stuck_v1';
    const STUCK_PASSES = 6;
    let stuck = {};
    try { stuck = JSON.parse((await env.RATEBOARD_KV.get(STUCK_KEY)) || '{}') || {}; } catch (e) {}
    if (!stuck.skip || typeof stuck.skip !== 'object') stuck.skip = {};

    const setAside = (sp, se, phase) => stuck.skip[`${sp}:${se}:${phase}`] === today;

    // Records this hand-out and says whether the phase has stopped moving.
    const wedged = async (sp, se, phase, progress) => {
      const tag = `${sp}:${se}:${phase}`;
      if (stuck.tag === tag && stuck.progress === progress) stuck.n = (stuck.n || 0) + 1;
      else { stuck.tag = tag; stuck.progress = progress; stuck.n = 1; }
      let out = false;
      if (stuck.n > STUCK_PASSES) {
        stuck.skip[tag] = today;
        stuck.tag = ''; stuck.n = 0; stuck.progress = null;
        out = true;
      }
      try { await env.RATEBOARD_KV.put(STUCK_KEY, JSON.stringify(stuck)); } catch (e) {}
      return out;
    };
    const now = Date.now();
    const holding = pace.holdUntil && pace.holdUntil > now;

    // While resting, the heavy collection waits, but a season that is already
    // finished still takes its daily owner snapshot - that is one leaderboard
    // walk, not a crawl, and skipping it would leave gaps in the history.
    if (holding) {
      for (const [sp, se] of jobs) {
        const key = `${sp}:${se}`;
        if (!clear[key] || clear[key] === today) continue;
        const own = await kv(`owners_${sp}_${se}`);
        if (!own || own.day !== today || !own.done) {
          return json({ sport: sp, season: se, phase: 'owners' });
        }
        // A rest is dead time for collection, so the per-player backfill uses
        // it - at the slower chunk the helper picks while a hold is on. The
        // season is not marked finished for the day while that is outstanding.
        const top = await kv(`ownertop_${sp}_${se}`);
        if (!top || !top.doneDay || top.doneDay < weekAgo) {
          if (changed) { try { await env.RATEBOARD_KV.put(CLEAR_KEY, JSON.stringify(clear)); } catch (e) {} }
          return json({ sport: sp, season: se, phase: 'owners' });
        }
        clear[key] = today;
        changed = true;
      }
      if (changed) { try { await env.RATEBOARD_KV.put(CLEAR_KEY, JSON.stringify(clear)); } catch (e) {} }
      return json({ phase: null, resting: true, until: new Date(pace.holdUntil).toISOString(),
                    minutesLeft: Math.ceil((pace.holdUntil - now) / 60000), after: pace.reason || null });
    }

    // Hands back the work, unless this is a different season from the one last
    // worked on - in which case that one just finished, and a rest starts.
    const heavy = async (sp, se, phase) => {
      const key = `${sp}:${se}`;
      if (pace.lastJob && pace.lastJob !== key) {
        const prevSport = String(pace.lastJob).split(':')[0];
        const movedOn = prevSport !== sp;
        const wait = movedOn ? SPORT_REST() : SEASON_REST();
        const next = { lastJob: key, holdUntil: Date.now() + wait,
                       reason: movedOn ? `finished ${prevSport}` : `finished ${pace.lastJob}` };
        try { await env.RATEBOARD_KV.put(PACE_KEY, JSON.stringify(next)); } catch (e) {}
        return json({ phase: null, resting: true, until: new Date(next.holdUntil).toISOString(),
                      minutesLeft: Math.ceil(wait / 60000), after: next.reason });
      }
      if (!pace.lastJob) {
        try { await env.RATEBOARD_KV.put(PACE_KEY, JSON.stringify({ lastJob: key, holdUntil: 0 })); } catch (e) {}
      }
      return json({ sport: sp, season: se, phase });
    };

    let ownersJob = null, topJob = null, golfJob = null;
    for (const [sp, se] of jobs) {
      const key = `${sp}:${se}`;
      if (clear[key] === today) continue;

      // Each phase reports a number that must move for it to count as working.
      const pick = async (phase, progress) => {
        if (setAside(sp, se, phase)) return null;
        if (await wedged(sp, se, phase, progress)) return null;
        return await heavy(sp, se, phase);
      };

      const games = await kv(`games_${sp}_${se}`);
      const ids = (games && games.ids) || [];
      if (!ids.length) {
        const r = await pick('list', 0);
        if (r) return r;
        continue;                       // without a player list nothing else can run
      }

      let served = null;

      const glDone = (await kv(`gamelog_done_${sp}_${se}`)) || {};
      const doneMap = glDone.done || {};
      const doneN = ids.filter(id => doneMap[id]).length;
      if (doneN < ids.length) served = await pick('gamelog', doneN);

      const rxDone = (await kv(`gamelog_rax_${sp}_${se}`)) || {};
      const raxMap = rxDone.done || {};
      const raxN = ids.filter(id => raxMap[id]).length;
      if (!served && raxN < ids.length) served = await pick('rax', raxN);

      try {
        if (!served) {
          const blanks = await db.prepare(
            `SELECT COUNT(*) AS n FROM gamelog WHERE sport = ? AND season = ? AND rax IS NULL`)
            .bind(sp, se).first();
          if (blanks && blanks.n > 0) served = await pick('zerofill', blanks.n);
        }
        if (!served) {
          const noConf = await db.prepare(
            `SELECT COUNT(*) AS n FROM (SELECT DISTINCT team FROM gamelog
               WHERE sport = ? AND season = ? AND team IS NOT NULL AND conference IS NULL)`)
            .bind(sp, se).first();
          if (noConf && noConf.n > 0) served = await pick('conf', noConf.n);
        }
      } catch (e) {}
      if (served) return served;

      // Owner work is remembered rather than done here: a season still waiting
      // to be collected at all matters more than topping up one that is
      // finished, so the loop runs to the end first and these only happen if
      // nothing is left to collect.
      const own = await kv(`owners_${sp}_${se}`);
      if (!own || own.day !== today || !own.done) {
        if (!ownersJob && !setAside(sp, se, 'owners')) ownersJob = [sp, se, (own && own.seen) || 0];
        continue;
      }

      const top = await kv(`ownertop_${sp}_${se}`);
      if (!top || !top.doneDay || top.doneDay < weekAgo) {
        if (!topJob && !setAside(sp, se, 'owners')) topJob = [sp, se, (top && top.filled) || 0];
        continue;
      }

      if (sp === 'golf') {
        const gm = await kv(`golfmeta_${sp}_${se}`);
        if (!gm || !gm.doneDay) {
          if (!golfJob && !setAside(sp, se, 'owners')) golfJob = [sp, se, (gm && gm.at) || 0];
          continue;
        }
      }

      clear[key] = today;
      changed = true;
    }

    if (changed) { try { await env.RATEBOARD_KV.put(CLEAR_KEY, JSON.stringify(clear)); } catch (e) {} }
    for (const job of [ownersJob, topJob, golfJob]) {
      if (!job) continue;
      const [sp, se, progress] = job;
      if (await wedged(sp, se, 'owners', progress)) continue;
      return json({ sport: sp, season: se, phase: 'owners' });
    }
    return json({ phase: null });
  }

  // Conference, for rows gathered before the column existed. Teams are filled
  // one at a time: pick a player from a team that has none, read the
  // conference off their feed, then stamp every row for that team and season.
  if (url.searchParams.get('conf')) {
    const which = url.searchParams.get('conf');
    const db = env.RATEBOARD_DB;

    if (which === 'status') {
      try {
        const r = await db.prepare(
          `SELECT COUNT(DISTINCT team) AS teams,
                  SUM(CASE WHEN conference IS NULL THEN 1 ELSE 0 END) AS rowsMissing
             FROM gamelog WHERE sport = ? AND season = ?`).bind(sport, Number(season)).first();
        const m = await db.prepare(
          `SELECT COUNT(*) AS n FROM (SELECT DISTINCT team FROM gamelog
             WHERE sport = ? AND season = ? AND team IS NOT NULL AND conference IS NULL)`)
          .bind(sport, Number(season)).first();
        return json({ teams: r ? r.teams : null, rowsMissing: r ? r.rowsMissing : null,
                      teamsMissing: m ? m.n : null });
      } catch (e) { return json({ error: String((e && e.message) || e) }, 500); }
    }
    if (which !== '1') return json({ error: 'conf must be 1 or status' }, 400);


    const { readable, writable } = new TransformStream();
    const w = writable.getWriter();
    const enc = new TextEncoder();
    const send = t => w.write(enc.encode(t));

    (async () => {
      try {
        await migrateGamelog(db);
        const todo = await db.prepare(
          `SELECT team, MIN(playerId) AS pid FROM gamelog
            WHERE sport = ? AND season = ? AND team IS NOT NULL AND conference IS NULL
            GROUP BY team LIMIT ?`).bind(sport, Number(season), CONF_CHUNK).all();
        const rows = (todo && todo.results) || [];
        if (!rows.length) {
          await send(`every team already has a conference for ${sport} ${season}.\n`);
          await send(`##STATE 1 1 0\n`);
          await w.close();
          return;
        }
        await send(`filling conferences for ${rows.length} teams...\n`);

        let done = 0, blank = 0;
        for (const r of rows) {
          let conf = null;
          try {
            const d = await rsGet(
              `https://web.realapp.com/players/${r.pid}/sport/${sport}/seasonfeed?limit=1&season=${season}&view=recent&viewFrame=default`, auth);
            const bs = (d && d.playerBoxScores) || [];
            for (const b of bs) {
              for (const t of [b.team, b.homeTeam, b.awayTeam]) {
                if (t && t.key === r.team && t.conference) { conf = t.conference; break; }
              }
              if (conf) break;
            }
          } catch (e) {}
          // A blank is recorded too, so a team with no conference is not
          // retried forever.
          await db.prepare(
            `UPDATE gamelog SET conference = ? WHERE sport = ? AND season = ? AND team = ?`)
            .bind(conf || '-', sport, Number(season), r.team).run();
          if (!conf) blank++;
          done++;
          await sleep(80);
        }
        await send(`\n${done} teams filled${blank ? `, ${blank} with no conference listed` : ''}.\n`);
        await send(`##STATE ${done} ${done} 1\n`);
      } catch (e) {
        await send(`\nstopped: ${String((e && e.message) || e).replace(/\n/g, ' ')}\n`);
      }
      await w.close();
    })();

    return new Response(readable, {
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
    });
  }

  // How many people hold each player's card, snapshotted once a day.
  //
  // This is a season-level figure, not a per-game one, so it lives in its own
  // table keyed by the day it was taken. One leaderboard walk covers a whole
  // sport-season - no per-player calls - but the walk is longer than a
  // scheduled run gets, so it is done in chunks with the cursor parked in KV.
  //
  //   ?owners=1       -> collect the next chunk of today's snapshot
  //   ?owners=status  -> how far along today's snapshot is

  // Tournament names, courses and finishing positions. Golf's stored rows have
  // the event's id and each player's score to par, but nothing that names the
  // event or says who missed the cut - both of those live in the same feed the
  // game logs come from, so this walks it again and fills them in.
  if (url.searchParams.get('golfmeta')) {
    const which = url.searchParams.get('golfmeta');
    const db = env.RATEBOARD_DB;
    const KEY = `golfmeta_${sport}_${season}`;
    const today = new Date().toISOString().slice(0, 10);

    const readMeta = async () => {
      try {
        const o = JSON.parse((await env.RATEBOARD_KV.get(KEY)) || 'null');
        return { at: (o && o.at) || 0, doneDay: (o && o.doneDay) || '' };
      } catch (e) { return { at: 0, doneDay: '' }; }
    };

    // Finishing positions already come down with the game logs, so this walk
    // exists only to learn each event's name - and every event shows up in the
    // feed of any player who entered it. A sample off the top of the earnings
    // list covers the whole calendar without walking the entire field.
    const GOLFMETA_SAMPLE = 60;
    let ids = [];
    try {
      const g = JSON.parse((await env.RATEBOARD_KV.get(`games_${sport}_${season}`)) || 'null');
      ids = ((g && g.ids) || []).slice(0, GOLFMETA_SAMPLE);
    } catch (e) {}

    if (which === 'status') {
      const st = await readMeta();
      let events = null, placed = null;
      try {
        const t = await db.prepare(
          'SELECT COUNT(*) AS n FROM tournament WHERE sport = ? AND season = ?')
          .bind(sport, Number(season)).first();
        events = t ? t.n : null;
        const p = await db.prepare(
          'SELECT COUNT(*) AS n FROM gamelog WHERE sport = ? AND season = ? AND position IS NOT NULL')
          .bind(sport, Number(season)).first();
        placed = p ? p.n : null;
      } catch (e) {}
      return json({ players: ids.length, walked: st.at, events, rowsWithPosition: placed,
                    lastFinished: st.doneDay || null });
    }

    if (which !== '1') return json({ error: 'golfmeta must be 1 or status' }, 400);

    const { readable, writable } = new TransformStream();
    const w = writable.getWriter();
    const enc = new TextEncoder();
    const send = t => w.write(enc.encode(t));

    (async () => {
      try {
        await migrateGamelog(db);
        const st = await readMeta();
        if (!ids.length) {
          st.doneDay = today; st.at = 0;
          await env.RATEBOARD_KV.put(KEY, JSON.stringify(st));
          await send(`no player list for ${sport} ${season}, nothing to walk.\n`);
          await send('##STATE 0 0 0\n');
          await w.close();
          return;
        }
        if (st.at >= ids.length) {
          st.doneDay = today; st.at = 0;
          await env.RATEBOARD_KV.put(KEY, JSON.stringify(st));
          await send('every player already walked.\n');
          await send('##STATE 0 0 0\n');
          await w.close();
          return;
        }

        const batch = ids.slice(st.at, st.at + GOLFMETA_CHUNK);
        await send(`tournament names and finishes for ${sport} ${season},` +
                   ` players ${st.at + 1}-${st.at + batch.length} of ${ids.length}...\n`);

        const events = new Map();
        const places = [];
        for (let i = 0; i < batch.length; i++) {
          if (i) await sleep(GAP_MS);
          try {
            const d = await rsGet(
              `https://web.realapp.com/players/${batch[i]}/sport/${sport}` +
              `/seasonfeed?limit=80&season=${season}&view=recent&viewFrame=default`, auth);
            for (const b of ((d && d.playerBoxScores) || [])) {
              if (!b || b.gameId == null) continue;
              const name = b.tournamentName || null;
              const course = (b.scoreCard && b.scoreCard.additionalInfo &&
                              b.scoreCard.additionalInfo.courseLabel) || null;
              if (name && !events.has(b.gameId)) {
                events.set(b.gameId, { name, course, day: b.day || null });
              }
              const pos = b.positionDisplay || b.position || null;
              if (pos) places.push([Number(b.gameId), Number(b.playerId), String(pos)]);
            }
          } catch (e) {}
        }

        const stmts = [];
        for (const [gid, e] of events) {
          stmts.push(db.prepare(
            `INSERT INTO tournament (sport, season, gameId, name, course, day)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(sport, season, gameId) DO UPDATE SET
               name = excluded.name, course = excluded.course, day = excluded.day`)
            .bind(sport, Number(season), Number(gid), e.name, e.course, e.day));
        }
        for (const [gid, pid, pos] of places) {
          stmts.push(db.prepare(
            'UPDATE gamelog SET position = ? WHERE sport = ? AND season = ? AND playerId = ? AND gameId = ?')
            .bind(pos, sport, Number(season), pid, gid));
        }
        for (let j = 0; j < stmts.length; j += 40) {
          const slice = stmts.slice(j, j + 40);
          if (slice.length) await db.batch(slice);
        }

        st.at += batch.length;
        const finished = st.at >= ids.length;
        if (finished) { st.doneDay = today; st.at = 0; }
        await env.RATEBOARD_KV.put(KEY, JSON.stringify(st));
        await send(`\n${events.size} events named, ${places.length} finishes recorded` +
                   (finished ? ' - that is the whole field.\n' : ' - continuing next pass.\n'));
        await send(`##STATE ${st.at} ${ids.length} ${finished ? 0 : 1}\n`);
      } catch (e) {
        await send(`\nstopped: ${String((e && e.message) || e).replace(/\n/g, ' ')}\n`);
      }
      await w.close();
    })();

    return new Response(readable, {
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
    });
  }

  // Reading side of the golf screen.
  //   ?golf=seasons                       -> which golf seasons have events
  //   ?golf=tournaments&season=2024       -> every event that season
  //   ?golf=history&name=The%20Open...    -> that event across every year
  //   ?golf=board&season=2024&gameId=...  -> one event's rax leaderboard
  if (url.searchParams.get('golf')) {
    const which = url.searchParams.get('golf');
    const db = env.RATEBOARD_DB;
    const sp = SPORTS.has(sport) ? sport : 'golf';

    // The reading side can be hit before any collector has run, and the
    // tournament table and position column are created by the collectors, so
    // make sure they exist rather than answering with a database error.
    try { await db.prepare(TOURNAMENT_DDL).run(); } catch (e) {}
    try { await db.prepare('ALTER TABLE gamelog ADD COLUMN position TEXT').run(); } catch (e) {}

    // The cut line is the highest score to par that still made the weekend.
    // Null until the finishing positions have been collected.
    const EVENT_COLS = `
      COUNT(*) AS players,
      SUM(g.rax) AS totalRax,
      ROUND(AVG(g.rax), 2) AS avgRax,
      MAX(g.rax) AS bestRax,
      SUM(CASE WHEN g.position IS NOT NULL AND g.position <> 'CUT' THEN 1 ELSE 0 END) AS madeCut,
      SUM(CASE WHEN g.position = 'CUT' THEN 1 ELSE 0 END) AS missedCut,
      MAX(CASE WHEN g.position IS NOT NULL AND g.position <> 'CUT' THEN g.plusMinus END) AS cutLine`;

    try {
      if (which === 'seasons') {
        const r = await db.prepare(
          `SELECT season, COUNT(DISTINCT gameId) AS events FROM gamelog
            WHERE sport = ? AND gameId IS NOT NULL GROUP BY season ORDER BY season DESC`)
          .bind(sp).all();
        return json({ sport: sp, seasons: (r && r.results) || [] });
      }

      if (which === 'tournaments') {
        const r = await db.prepare(
          `SELECT g.gameId, MIN(g.day) AS day, t.name, t.course, ${EVENT_COLS}
             FROM gamelog g LEFT JOIN tournament t
               ON t.sport = g.sport AND t.season = g.season AND t.gameId = g.gameId
            WHERE g.sport = ? AND g.season = ? AND g.gameId IS NOT NULL
            GROUP BY g.gameId ORDER BY day ASC`)
          .bind(sp, Number(season)).all();
        return json({ sport: sp, season: Number(season), rows: (r && r.results) || [] });
      }

      if (which === 'history') {
        const name = (url.searchParams.get('name') || '').trim();
        if (!name) return json({ error: 'name is required' }, 400);
        const r = await db.prepare(
          `SELECT g.season, g.gameId, MIN(g.day) AS day, t.course, ${EVENT_COLS}
             FROM gamelog g JOIN tournament t
               ON t.sport = g.sport AND t.season = g.season AND t.gameId = g.gameId
            WHERE g.sport = ? AND t.name = ?
            GROUP BY g.season, g.gameId ORDER BY g.season DESC`)
          .bind(sp, name).all();
        return json({ sport: sp, name, rows: (r && r.results) || [] });
      }

      if (which === 'board') {
        const gid = parseInt(url.searchParams.get('gameId') || '', 10);
        if (!gid) return json({ error: 'gameId is required' }, 400);
        const lim = Math.min(400, Math.max(1, parseInt(url.searchParams.get('limit') || '200', 10) || 200));
        const head = await db.prepare(
          `SELECT g.gameId, MIN(g.day) AS day, t.name, t.course, ${EVENT_COLS}
             FROM gamelog g LEFT JOIN tournament t
               ON t.sport = g.sport AND t.season = g.season AND t.gameId = g.gameId
            WHERE g.sport = ? AND g.season = ? AND g.gameId = ?`)
          .bind(sp, Number(season), gid).first();
        const r = await db.prepare(
          `SELECT player, team, rax, rating, plusMinus AS toPar, position
             FROM gamelog WHERE sport = ? AND season = ? AND gameId = ?
            ORDER BY rax DESC LIMIT ?`)
          .bind(sp, Number(season), gid, lim).all();
        return json({ event: head || null, rows: (r && r.results) || [] });
      }

      return json({ error: 'golf must be seasons, tournaments, history or board' }, 400);
    } catch (e) { return json({ error: String((e && e.message) || e) }, 500); }
  }

  if (url.searchParams.get('ownertop')) {
    const which = url.searchParams.get('ownertop');
    if (which !== '1' && which !== 'status') {
      return json({ error: 'ownertop must be 1 or status' }, 400);
    }
    return await ownerTopSlice(env, sport, Number(season), auth, which === 'status');
  }

  if (url.searchParams.get('owners')) {
    const which = url.searchParams.get('owners');
    const db = env.RATEBOARD_DB;
    const OWN_KEY = `owners_${sport}_${season}`;
    const today = new Date().toISOString().slice(0, 10);

    const readOwn = async () => {
      try {
        const raw = await env.RATEBOARD_KV.get(OWN_KEY);
        const o = raw ? JSON.parse(raw) : null;
        if (!o || o.day !== today) return { day: today, before: 0, seen: 0, done: false };
        return { day: o.day, before: o.before || 0, seen: o.seen || 0, done: !!o.done };
      } catch (e) { return { day: today, before: 0, seen: 0, done: false }; }
    };

    if (which === 'status') {
      const st = await readOwn();
      let rows = null, days = null;
      try {
        const r = await db.prepare(
          `SELECT COUNT(*) AS n, COUNT(DISTINCT day) AS d FROM owners WHERE sport = ? AND season = ?`)
          .bind(sport, Number(season)).first();
        rows = r ? r.n : null; days = r ? r.d : null;
      } catch (e) {}
      return json({ day: st.day, done: st.done, collectedToday: st.seen,
                    totalRows: rows, snapshotDays: days });
    }

    if (which !== '1') return json({ error: 'owners must be 1 or status' }, 400);

    // Once the day's leaderboard walk is finished there is nothing left for
    // this phase to do, so the slice goes to filling in the players that walk
    // never reaches. Keeping it under the same phase name means the deployed
    // cron driver needs no new phase to know about.
    const already = await readOwn();
    if (already.done) {
      const topLeft = await ownerTopOutstanding(env, sport, Number(season));
      if (topLeft) return await ownerTopSlice(env, sport, Number(season), auth, false);
      if (sport === 'golf') {
        const u = new URL(url.toString());
        u.searchParams.delete('owners');
        u.searchParams.set('golfmeta', '1');
        return await onRequestGet({ request: new Request(u.toString(), request), env });
      }
      return await ownerTopSlice(env, sport, Number(season), auth, false);
    }

    const { readable, writable } = new TransformStream();
    const w = writable.getWriter();
    const enc = new TextEncoder();
    const send = t => w.write(enc.encode(t));

    (async () => {
      try {
        await db.prepare(OWNERS_DDL).run();
        const st = await readOwn();
        if (st.done) {
          await send(`today's snapshot is already complete (${st.seen} players).\n`);
          await send(`##STATE ${st.seen} ${st.seen} 0\n`);
          await w.close();
          return;
        }
        await send(`owner counts for ${sport} ${season}, ${today} (${st.seen} so far)...\n`);

        const sql = `INSERT OR REPLACE INTO owners (sport, season, playerId, day, owners, player)
                     VALUES (?, ?, ?, ?, ?, ?)`;
        let finished = false;
        for (let i = 0; i < OWNERS_CHUNK_PAGES; i++) {
          if (i) await sleep(GAP_MS);
          const rows = rowsOf(await rsGet(
            `https://web.realapp.com/userpassshop/${sport}/season/${season}/entity/player/section/hotseason?before=${st.before}`, auth));
          const stmts = [];
          for (const r of rows) {
            if (!r || r.id == null) continue;
            stmts.push(db.prepare(sql).bind(
              sport, Number(season), Number(r.id), today,
              Number(r.value) || 0, r.label || null));
          }
          for (let j = 0; j < stmts.length; j += 40) {
            const batch = stmts.slice(j, j + 40);
            if (batch.length) await db.batch(batch);
          }
          st.seen += stmts.length;
          st.before += PAGE;
          await send(`  ${st.seen} players\n`);
          if (rows.length < PAGE) { finished = true; break; }
          if (st.before >= LIST_MAX_PAGES * PAGE) { finished = true; break; }
        }

        st.done = finished;
        await env.RATEBOARD_KV.put(OWN_KEY, JSON.stringify(st));
        await send(finished
          ? `\nsnapshot complete: ${st.seen} players.\n`
          : `\n${st.seen} so far - continuing on the next pass.\n`);
        await send(`##STATE ${st.seen} ${st.seen} ${finished ? 0 : 1}\n`);
      } catch (e) {
        await send(`\nstopped: ${String((e && e.message) || e).replace(/\n/g, ' ')}\n`);
      }
      await w.close();
    })();

    return new Response(readable, {
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
    });
  }

  // ---- game-by-game -------------------------------------------------------
  //   ?gamelog=probe    -> one player's feed at a high limit, to see how many
  //                        games come back in a single call
  //   ?gamelog=go       -> collect the whole season, hands-off
  //   ?gamelog=1        -> collect one slice
  //   ?gamelog=status   -> progress
  //   ?gamelog=csv      -> the export
  const glArg = url.searchParams.get('gamelog');
  if (glArg) {
    const db = env.RATEBOARD_DB;
    const DONE_KEY = `gamelog_done_${sport}_${season}`;
    const feedUrl = (id, limit) =>
      `https://web.realapp.com/players/${id}/sport/${sport}/seasonfeed?limit=${limit}&season=${season}&view=recent&viewFrame=default`;

    const readDone = async () => {
      try {
        const raw = await env.RATEBOARD_KV.get(DONE_KEY);
        const o = raw ? JSON.parse(raw) : null;
        return (o && o.done) ? o.done : {};
      } catch (e) { return {}; }
    };

    if (glArg === 'probe') {
      const pid = /^\d+$/.test(probePlayer || '') ? probePlayer : '5041935';
      const lim = Math.min(400, Math.max(1, parseInt(url.searchParams.get('limit') || '200', 10) || 200));
      try {
        const d = await rsGet(feedUrl(pid, lim), auth);
        const bs = (d && d.playerBoxScores) || [];
        return json({
          playerId: pid, askedFor: lim, gamesReturned: bs.length,
          gamesInStatsLine: d && d.statsInfo ? d.statsInfo.games : null,
          complete: !!(d && d.statsInfo && bs.length >= d.statsInfo.games),
          sampleRow: bs.length ? gamelogRow(sport, season, bs[0]) : null
        });
      } catch (e) { return json({ error: String((e && e.message) || e) }, 502); }
    }

    if (glArg === 'status') {
      const store = await readGames();
      const done = await readDone();
      const have = store.ids.filter(id => done[id]).length;
      let rows = null, withRax = null, sharedDays = null;
      try {
        const r = await db.prepare(
          `SELECT COUNT(*) AS n, SUM(CASE WHEN rax IS NOT NULL THEN 1 ELSE 0 END) AS r
             FROM gamelog WHERE sport = ? AND season = ?`).bind(sport, Number(season)).first();
        rows = r ? r.n : null; withRax = r ? r.r : null;
        // Two games on one day would make the day an ambiguous key for rax.
        const d = await db.prepare(
          `SELECT COUNT(*) AS n FROM (SELECT playerId, day FROM gamelog
             WHERE sport = ? AND season = ? GROUP BY playerId, day HAVING COUNT(*) > 1)`)
          .bind(sport, Number(season)).first();
        sharedDays = d ? d.n : null;
      } catch (e) {}
      return json({ players: store.ids.length, playersDone: have,
                    remaining: Math.max(0, store.ids.length - have),
                    gameRows: rows, rowsWithRax: withRax, playerDaysWithTwoGames: sharedDays });
    }

    if (glArg === 'go') {
      const q = `sport=${encodeURIComponent(sport)}&season=${encodeURIComponent(season)}`;
      return new Response(runnerHtml({
        title: `Game logs - ${sport} ${season}`,
        passUrl: `/api/rax?${q}&gamelog=1&limit=700`,
        dlUrl: `/api/rax?${q}&gamelog=csv`,
        dlLabel: 'Download the game-by-game CSV'
      }), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
    }

    // Filtered, sorted views over the game log, for the explorer on the board.
    // Everything the loadout optimiser needs, in one request: the biggest
    // earners in a scope and every dated game they scored in. Fetching this
    // player by player from the browser would be a hundred round trips.
    if (glArg === 'top') {
      const db = env.RATEBOARD_DB;
      const pairs = [];
      for (const bit of ((url.searchParams.get('seasons') || '').split(',')).slice(0, 30)) {
        const [sp, se] = String(bit).split(':');
        if (SPORTS.has(String(sp).toLowerCase()) && /^\d{4}$/.test(se)) {
          pairs.push([String(sp).toLowerCase(), Number(se)]);
        }
      }
      if (!pairs.length) pairs.push([sport, Number(season)]);
      const scope = '(' + pairs.map(() => '(sport = ? AND season = ?)').join(' OR ') + ')';
      const binds = [];
      for (const [sp, se] of pairs) binds.push(sp, se);

      const n = Math.min(200, Math.max(5, parseInt(url.searchParams.get('limit') || '90', 10) || 90));

      try {
        const top = await db.prepare(
          `SELECT playerId, sport, season, MAX(player) AS player, MAX(team) AS team,
                  SUM(rax) AS rax, COUNT(*) AS games
             FROM gamelog WHERE ${scope} AND rax IS NOT NULL
            GROUP BY playerId, sport, season
            ORDER BY SUM(rax) DESC LIMIT ?`).bind(...binds, n).all();
        const rows = (top && top.results) || [];
        if (!rows.length) return json({ players: [] });

        // One IN-list per sport-season keeps the bind count sane; D1 allows
        // around a hundred parameters a statement.
        const out = [];
        for (const [sp, se] of pairs) {
          const ids = rows.filter(r => r.sport === sp && r.season === se).map(r => r.playerId);
          for (let i = 0; i < ids.length; i += 60) {
            const slice = ids.slice(i, i + 60);
            if (!slice.length) continue;
            const g = await db.prepare(
              `SELECT playerId, day, rax FROM gamelog
                WHERE sport = ? AND season = ? AND rax > 0 AND day IS NOT NULL
                  AND playerId IN (${slice.map(() => '?').join(',')})`).bind(sp, se, ...slice).all();
            for (const r of (g && g.results) || []) {
              out.push({ sport: sp, season: se, playerId: r.playerId, day: r.day, rax: r.rax });
            }
          }
        }

        const byKey = new Map();
        for (const r of rows) byKey.set(`${r.sport}|${r.season}|${r.playerId}`, { ...r, games: [] });
        for (const g of out) {
          const e = byKey.get(`${g.sport}|${g.season}|${g.playerId}`);
          if (e) e.games.push([String(g.day).slice(5, 10), g.rax]);
        }
        return json({ players: [...byKey.values()].filter(p => p.games.length) });
      } catch (e) { return json({ error: String((e && e.message) || e) }, 500); }
    }

    // Every filter is bound and every sort key is checked against a list, so
    // nothing from the query string reaches the SQL as text.
    if (glArg === 'query') {
      const mode = url.searchParams.get('mode') === 'games' ? 'games' : 'players';
      const P = k => (url.searchParams.get(k) || '').trim();

      // One or more sport-seasons, given as "ncaam:2026,ncaam:2025". Falls back
      // to the single sport/season params so older links keep working.
      const pairs = [];
      for (const bit of (P('seasons') ? P('seasons').split(',') : []).slice(0, 30)) {
        const [sp, se] = String(bit).split(':');
        if (SPORTS.has(String(sp).toLowerCase()) && /^\d{4}$/.test(se)) {
          pairs.push([String(sp).toLowerCase(), Number(se)]);
        }
      }
      if (!pairs.length) pairs.push([sport, Number(season)]);

      const scope = '(' + pairs.map(() => '(sport = ? AND season = ?)').join(' OR ') + ')';
      const scopeBinds = [];
      for (const [sp, se] of pairs) scopeBinds.push(sp, se);

      const where = [scope];
      const binds = scopeBinds.slice();
      const eq = (param, col, ok) => {
        const v = P(param);
        if (!v) return;
        if (ok && !ok.includes(v)) return;
        where.push(`${col} = ?`); binds.push(v);
      };
      if (P('q')) { where.push('player LIKE ?'); binds.push('%' + P('q').replace(/[%_]/g, '') + '%'); }
      eq('team', 'team');
      eq('conference', 'conference');
      eq('opponent', 'opponent');
      eq('seasonType', 'seasonType', ['regularseason', 'postseason']);
      eq('homeAway', 'homeAway', ['home', 'away']);
      eq('result', 'result', ['W', 'L']);
      if (/^\d{4}-\d{2}-\d{2}$/.test(P('from'))) { where.push('day >= ?'); binds.push(P('from')); }
      if (/^\d{4}-\d{2}-\d{2}$/.test(P('to')))   { where.push('day <= ?'); binds.push(P('to')); }
      // A month-day window applies to every season at once. When the start is
      // later in the year than the end the range wraps over new year, which is
      // the normal case for a winter season.
      const md = k => /^\d{2}-\d{2}$/.test(P(k)) ? P(k) : '';
      if (md('fromMD') && md('toMD')) {
        if (md('fromMD') <= md('toMD')) {
          where.push('substr(day, 6) BETWEEN ? AND ?'); binds.push(md('fromMD'), md('toMD'));
        } else {
          where.push('(substr(day, 6) >= ? OR substr(day, 6) <= ?)'); binds.push(md('fromMD'), md('toMD'));
        }
      } else if (md('fromMD')) { where.push('substr(day, 6) >= ?'); binds.push(md('fromMD')); }
      else if (md('toMD'))     { where.push('substr(day, 6) <= ?'); binds.push(md('toMD')); }
      if (P('playedOnly') === '1') where.push('played = 1');
      const W = where.join(' AND ');

      const PLAYER_SORTS = ['rax','raxPerGame','rating','ratingPerGame','games','player','team',
                            'min','pts','reb','ast','stl','blk','tov','fantasyPts','bestRax',
                            'owners','ownersChange','season','conference'];
      const GAME_SORTS = ['day','player','team','opponent','rax','rating','min','pts','reb','ast',
                          'stl','blk','tov','pf','plusMinus','tsPct','fantasyPts','comments'];
      const allowed = mode === 'players' ? PLAYER_SORTS : GAME_SORTS;
      let sort = P('sort');
      if (!allowed.includes(sort)) sort = mode === 'players' ? 'rax' : 'rax';
      const dir = P('dir') === 'asc' ? 'ASC' : 'DESC';

      const asCsv = P('format') === 'csv';
      const limit = asCsv ? 50000
        : Math.min(500, Math.max(1, parseInt(P('limit') || '100', 10) || 100));
      const offset = asCsv ? 0 : Math.max(0, parseInt(P('offset') || '0', 10) || 0);
      const minGames = Math.max(0, parseInt(P('minGames') || '0', 10) || 0);

      const PLAYER_COLS = ['playerId','player','team','conference','season','games','rax','raxPerGame',
                           'bestRax','owners','ownersChange','rating','ratingPerGame','min','pts','reb',
                           'ast','stl','blk','tov','fantasyPts'];
      const GAME_COLS = ['day','player','team','conference','opponent','homeAway','result','teamScore','oppScore',
                         'seasonType','rax','rating','min','pts','reb','ast','stl','blk','tov','pf',
                         'plusMinus','fg','fg3','ft','tsPct','fantasyPts','comments','playerId'];

      // One row per player per season - a player in three seasons is three
      // rows, each with that season's own figures. Owners come from the newest
      // daily snapshot for that same sport and season.
      const ownerPick = (cutoff) => `
        (SELECT ow.owners FROM owners ow
          WHERE ow.sport = gamelog.sport AND ow.season = gamelog.season
            AND ow.playerId = gamelog.playerId
            AND ow.day = (SELECT MAX(d.day) FROM owners d
                           WHERE d.sport = ow.sport AND d.season = ow.season${cutoff}))`;

      // Ranges on the aggregates are applied outside the grouping, where the
      // totals actually exist.
      const outer = [];
      const outerBinds = [];
      const range = (param, col) => {
        const v = P(param);
        if (!/^\d+$/.test(v)) return;
        outer.push(`${col} ?`); outerBinds.push(Number(v));
      };
      const rangeGe = (param, col) => { const v = P(param); if (/^\d+$/.test(v)) { outer.push(`${col} >= ?`); outerBinds.push(Number(v)); } };
      const rangeLe = (param, col) => { const v = P(param); if (/^\d+$/.test(v)) { outer.push(`${col} <= ?`); outerBinds.push(Number(v)); } };
      rangeGe('minOwners', 'owners'); rangeLe('maxOwners', 'owners');
      rangeGe('minRax', 'rax');       rangeLe('maxRax', 'rax');
      const OUTER = outer.length ? ' WHERE ' + outer.join(' AND ') : '';

      const playerInner = `
        SELECT playerId, sport, season, MAX(player) AS player, MAX(team) AS team,
               MAX(conference) AS conference, COUNT(*) AS games,
               ${ownerPick('')} AS owners,
               ${ownerPick(" AND d.day <= date('now', '-7 day')")} AS ownersWeekAgo,
               ${ownerPick('')} - ${ownerPick(" AND d.day <= date('now', '-7 day')")} AS ownersChange,
               SUM(rax) AS rax, ROUND(AVG(rax), 2) AS raxPerGame, MAX(rax) AS bestRax,
               ROUND(SUM(rating), 2) AS rating, ROUND(AVG(rating), 2) AS ratingPerGame,
               ROUND(AVG(min), 1) AS min, ROUND(AVG(pts), 1) AS pts, ROUND(AVG(reb), 1) AS reb,
               ROUND(AVG(ast), 1) AS ast, ROUND(AVG(stl), 1) AS stl, ROUND(AVG(blk), 1) AS blk,
               ROUND(AVG(tov), 1) AS tov, ROUND(AVG(fantasyPts), 1) AS fantasyPts
          FROM gamelog WHERE ${W}
         GROUP BY playerId, sport, season HAVING COUNT(*) >= ?`;

      const playerSql = (order, lim) =>
        `SELECT * FROM (${playerInner})${OUTER} ORDER BY ${order} ${dir} ${lim}`;
      const gameSql = (order, lim) => `
        SELECT ${GAME_COLS.join(', ')} FROM gamelog WHERE ${W}
         ORDER BY ${order} ${dir} ${lim}`;

      try {
        if (asCsv) {
          const cols = mode === 'players' ? PLAYER_COLS : GAME_COLS;
          const sql = mode === 'players'
            ? playerSql(sort, `LIMIT ${limit}`)
            : gameSql(sort, `LIMIT ${limit}`);
          const args = mode === 'players'
            ? binds.concat([minGames]).concat(outerBinds)
            : binds;
          const r = await db.prepare(sql).bind(...args).all();
          const cell = v => {
            const t = v == null ? '' : String(v);
            return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
          };
          let out = cols.join(',') + '\n';
          for (const row of ((r && r.results) || [])) out += cols.map(c => cell(row[c])).join(',') + '\n';
          return new Response(out, {
            headers: {
              'content-type': 'text/csv; charset=utf-8',
              'content-disposition': `attachment; filename="${sport}-${season}-${mode}.csv"`,
              'cache-control': 'no-store'
            }
          });
        }

        const sql = mode === 'players'
          ? playerSql(sort, `LIMIT ? OFFSET ?`)
          : gameSql(sort, `LIMIT ? OFFSET ?`);
        const args = (mode === 'players'
          ? binds.concat([minGames]).concat(outerBinds)
          : binds).concat([limit, offset]);
        const r = await db.prepare(sql).bind(...args).all();

        const countSql = mode === 'players'
          ? `SELECT COUNT(*) AS n FROM (${playerInner})${OUTER}`
          : `SELECT COUNT(*) AS n FROM gamelog WHERE ${W}`;
        const c = await db.prepare(countSql)
          .bind(...(mode === 'players' ? binds.concat([minGames]).concat(outerBinds) : binds)).first();

        return json({ mode, sort, dir: dir.toLowerCase(), limit, offset,
                      pairs: pairs.map(([sp, se]) => `${sp}:${se}`),
                      total: c ? c.n : null,
                      columns: mode === 'players' ? PLAYER_COLS : GAME_COLS,
                      rows: (r && r.results) || [] });
      } catch (e) {
        return json({ error: String((e && e.message) || e) }, 500);
      }
    }

    // Which sport-seasons actually hold data, so the explorer can offer them
    // rather than assuming one season exists.
    if (glArg === 'seasons') {
      try {
        const r = await db.prepare(
          `SELECT sport, season, COUNT(*) AS rows, COUNT(DISTINCT playerId) AS players
             FROM gamelog GROUP BY sport, season ORDER BY sport, season DESC`).all();
        return json({ seasons: (r && r.results) || [] });
      } catch (e) { return json({ error: String((e && e.message) || e) }, 500); }
    }

    // The distinct teams and opponents present, to fill the filter dropdowns.
    if (glArg === 'facets') {
      try {
        const fp = [];
        for (const bit of ((url.searchParams.get('seasons') || '').split(',')).slice(0, 30)) {
          const [sp, se] = String(bit).split(':');
          if (SPORTS.has(String(sp).toLowerCase()) && /^\d{4}$/.test(se)) fp.push([String(sp).toLowerCase(), Number(se)]);
        }
        if (!fp.length) fp.push([sport, Number(season)]);
        const fScope = '(' + fp.map(() => '(sport = ? AND season = ?)').join(' OR ') + ')';
        const fBinds = [];
        for (const [sp, se] of fp) fBinds.push(sp, se);
        const t = await db.prepare(
          `SELECT DISTINCT team AS k FROM gamelog WHERE ${fScope} AND team IS NOT NULL ORDER BY team`)
          .bind(...fBinds).all();
        const cf = await db.prepare(
          `SELECT DISTINCT conference AS k FROM gamelog
            WHERE ${fScope} AND conference IS NOT NULL AND conference <> '-' ORDER BY conference`)
          .bind(...fBinds).all();
        const d = await db.prepare(
          `SELECT MIN(day) AS first, MAX(day) AS last FROM gamelog WHERE ${fScope}`)
          .bind(...fBinds).first();
        return json({ teams: ((t && t.results) || []).map(x => x.k),
                      conferences: ((cf && cf.results) || []).map(x => x.k),
                      dates: d || null });
      } catch (e) { return json({ error: String((e && e.message) || e) }, 500); }
    }

    // Reconciliation: the per-game rax summed per player should reproduce the
    // season leaderboard exactly. Anything else means the join is wrong.
    if (glArg === 'check') {
      try {
        const totals = await db.prepare(
          `SELECT playerId, player, COUNT(*) AS games,
                  SUM(rax) AS raxTotal, ROUND(SUM(rating), 2) AS ratingTotal,
                  SUM(CASE WHEN rax IS NULL THEN 1 ELSE 0 END) AS gamesWithoutRax
             FROM gamelog WHERE sport = ? AND season = ?
            GROUP BY playerId ORDER BY raxTotal DESC LIMIT 10`)
          .bind(sport, Number(season)).all();
        const tally = await db.prepare(
          `SELECT COUNT(*) AS rows, COUNT(DISTINCT playerId) AS players,
                  SUM(CASE WHEN rax IS NULL THEN 1 ELSE 0 END) AS rowsWithoutRax
             FROM gamelog WHERE sport = ? AND season = ?`).bind(sport, Number(season)).first();
        return json({ tally, topByRaxTotal: (totals && totals.results) || [] });
      } catch (e) { return json({ error: String((e && e.message) || e) }, 500); }
    }

    // A game a player earned nothing for simply has no entry on the earnings
    // screen, so a blank here means zero, not unknown - the per-player totals
    // reconcile exactly with those games counted as 0. Only run once every
    // player has been through the rax pass.
    if (glArg === 'zerofill') {
      try {
        const store = await readGames();
        const raw = await env.RATEBOARD_KV.get(`gamelog_rax_${sport}_${season}`);
        const done = raw ? (JSON.parse(raw).done || {}) : {};
        const left = store.ids.filter(id => !done[id]).length;
        if (left) return json({ error: `${left} players have not been through the rax pass yet - not safe to fill blanks`, remaining: left }, 409);
        const r = await db.prepare(
          'UPDATE gamelog SET rax = 0 WHERE sport = ? AND season = ? AND rax IS NULL')
          .bind(sport, Number(season)).run();
        return json({ ok: true, filled: (r && r.meta && r.meta.changes) || null });
      } catch (e) { return json({ error: String((e && e.message) || e) }, 500); }
    }

    // One player's game log, for spot checks.
    if (glArg === 'player') {
      const pid = String(url.searchParams.get('pid') || '').replace(/[^0-9]/g, '');
      if (!pid) return json({ error: 'pass &pid=<playerId>' }, 400);
      try {
        const r = await db.prepare(
          `SELECT day, seasonType, opponent, homeAway, teamScore, oppScore, result,
                  rax, rating, min, pts, reb, ast, fg, fg3, ft, tsPct, fantasyPts
             FROM gamelog WHERE sport = ? AND season = ? AND playerId = ?
            ORDER BY day DESC`).bind(sport, Number(season), Number(pid)).all();
        const rows = (r && r.results) || [];
        return json({ playerId: Number(pid), games: rows.length,
                      raxTotal: rows.reduce((a, x) => a + (x.rax || 0), 0),
                      ratingTotal: Math.round(rows.reduce((a, x) => a + (x.rating || 0), 0) * 100) / 100,
                      rows });
      } catch (e) { return json({ error: String((e && e.message) || e) }, 500); }
    }

    if (glArg === 'csv') {
      const { readable, writable } = new TransformStream();
      const w = writable.getWriter();
      const enc = new TextEncoder();
      const cell = v => {
        const t = v == null ? '' : String(v);
        return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
      };
      (async () => {
        try {
          await w.write(enc.encode(GAMELOG_COLS.join(',') + '\n'));
          const CHUNK = 4000;
          let offset = 0;
          for (;;) {
            const r = await db.prepare(
              `SELECT ${GAMELOG_COLS.join(', ')} FROM gamelog WHERE sport = ? AND season = ?
               ORDER BY playerId, day, gameId LIMIT ? OFFSET ?`)
              .bind(sport, Number(season), CHUNK, offset).all();
            const rows = (r && r.results) || [];
            if (!rows.length) break;
            let out = '';
            for (const row of rows) out += GAMELOG_COLS.map(c => cell(row[c])).join(',') + '\n';
            await w.write(enc.encode(out));
            offset += rows.length;
            if (rows.length < CHUNK) break;
          }
          await w.write(enc.encode(`# ${offset} game rows\n`));
        } catch (e) {
          await w.write(enc.encode(`# stopped: ${String((e && e.message) || e).replace(/\n/g, ' ')}\n`));
        }
        await w.close();
      })();
      return new Response(readable, {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="${sport}-${season}-game-by-game.csv"`,
          'cache-control': 'no-store'
        }
      });
    }

    // Whole-number rax per game, from the earnings screen. One call covers a
    // player's whole season, and the rows are matched back to the game log by
    // date. A day carrying two games is left alone rather than guessed at.
    if (glArg === 'rax' || glArg === 'raxgo' || glArg === 'raxstatus') {
      const RAX_DONE_KEY = `gamelog_rax_${sport}_${season}`;
      const readRaxDone = async () => {
        try {
          const raw = await env.RATEBOARD_KV.get(RAX_DONE_KEY);
          const o = raw ? JSON.parse(raw) : null;
          return (o && o.done) ? o.done : {};
        } catch (e) { return {}; }
      };
      const earningsUrl = id =>
        `https://web.realapp.com/userpassearnings/${sport}/season/${season}/entity/player/${id}`;

      if (glArg === 'raxstatus') {
        const store = await readGames();
        const done = await readRaxDone();
        const have = store.ids.filter(id => done[id]).length;
        return json({ players: store.ids.length, playersDone: have,
                      remaining: Math.max(0, store.ids.length - have) });
      }

      if (glArg === 'raxgo') {
        const q = `sport=${encodeURIComponent(sport)}&season=${encodeURIComponent(season)}`;
        return new Response(runnerHtml({
          title: `Rax per game - ${sport} ${season}`,
          passUrl: `/api/rax?${q}&gamelog=rax&limit=700`,
          dlUrl: `/api/rax?${q}&gamelog=csv`,
          dlLabel: 'Download the game-by-game CSV'
        }), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
      }

      const LIMIT = Math.min(800, Math.max(25, parseInt(url.searchParams.get('limit') || '700', 10) || 700));
      const { readable, writable } = new TransformStream();
      const w = writable.getWriter();
      const enc = new TextEncoder();
      const send = t => w.write(enc.encode(t));

      (async () => {
        try {
          await migrateGamelog(db);
          const store = await readGames();
          if (!store.ids.length) {
            await send('no player list yet - run the games collector first.\n');
            await w.close();
            return;
          }
          const done = await readRaxDone();
          const todo = store.ids.filter(id => !done[id]).slice(0, LIMIT);
          if (!todo.length) {
            await send(`nothing left - all ${store.ids.length} players have their rax.\n`);
            await send(`##STATE ${store.ids.length} ${store.ids.length} 0\n`);
            await w.close();
            return;
          }
          await send(`pulling rax per game for ${todo.length} of ${store.ids.length} players...\n`);

          const sql = `UPDATE gamelog SET rax = ? WHERE sport = ? AND season = ? AND playerId = ? AND day = ?`;
          let n = 0, updates = 0, skipped = 0, firstError = '';
          for (const id of todo) {
            try {
              const d = await rsGet(earningsUrl(id), auth);
              const list = (d && d.earnings) || [];
              const stmts = [];
              for (const e of list) {
                if (!e || !e.day || e.earnings == null) continue;
                if (Array.isArray(e.playerBoxScoreIds) && e.playerBoxScoreIds.length > 1) { skipped++; continue; }
                stmts.push(db.prepare(sql).bind(Number(e.earnings), sport, Number(season), Number(id), e.day));
              }
              for (let i = 0; i < stmts.length; i += 40) {
                const batch = stmts.slice(i, i + 40);
                if (batch.length) await db.batch(batch);
              }
              updates += stmts.length;
              done[id] = 1;
            } catch (e) {
              if (!firstError) {
                firstError = String((e && e.message) || e).slice(0, 300);
                await send(`  ! ${firstError.replace(/\n/g, ' ')}\n`);
              }
            }
            n++;
            if (n % 10 === 0) {
              await env.RATEBOARD_KV.put(RAX_DONE_KEY, JSON.stringify({ done, updated: Date.now() }));
              await send(`  ${n} / ${todo.length}  (${updates} game rows given a rax figure)\n`);
            }
            await sleep(80);
          }
          await env.RATEBOARD_KV.put(RAX_DONE_KEY, JSON.stringify({ done, updated: Date.now() }));

          const have = store.ids.filter(id => done[id]).length;
          const left = store.ids.length - have;
          await send(`\n${n} players this run, ${updates} game rows updated`
                     + (skipped ? `, ${skipped} skipped for sharing a date with another game` : '') + '.\n');
          await send(left > 0 ? `${have} of ${store.ids.length} players done - ${left} to go.\n`
                              : `all ${store.ids.length} players done.\n`);
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

    if (glArg === '1') {
      const LIMIT = Math.min(800, Math.max(25, parseInt(url.searchParams.get('limit') || '700', 10) || 700));
      const { readable, writable } = new TransformStream();
      const w = writable.getWriter();
      const enc = new TextEncoder();
      const send = t => w.write(enc.encode(t));

      (async () => {
        try {
          await migrateGamelog(db);
          const store = await readGames();
          if (!store.ids.length) {
            await send('no player list yet - open the same link with &games=1&rebuild=1 first.\n');
            await w.close();
            return;
          }
          const done = await readDone();
          const todo = store.ids.filter(id => !done[id]).slice(0, LIMIT);
          if (!todo.length) {
            await send(`nothing left - all ${store.ids.length} players have their game log.\n`);
            await send(`##STATE ${store.ids.length} ${store.ids.length} 0\n`);
            await w.close();
            return;
          }
          await send(`collecting game logs for ${todo.length} of ${store.ids.length} players...\n`);

          const place = '(' + GAMELOG_FEED_COLS.map(() => '?').join(',') + ')';
          let n = 0, rowsWritten = 0, firstError = '';
          for (const id of todo) {
            try {
              const d = await rsGet(feedUrl(id, 200), auth);
              const bs = (d && d.playerBoxScores) || [];
              const rows = bs.filter(b => b && b.gameId != null).map(b => gamelogRow(sport, season, b));
              // One statement per row: D1 caps how many values a single query
              // may bind, so rows go in as a batch of small statements instead
              // of one wide insert.
              // Upsert rather than replace: a plain REPLACE would drop the
              // rax figure written by the other pass.
              const keyCols = ['sport', 'season', 'playerId', 'gameId'];
              const sets = GAMELOG_FEED_COLS.filter(c => !keyCols.includes(c))
                                            .map(c => `${c}=excluded.${c}`).join(', ');
              const sql = `INSERT INTO gamelog (${GAMELOG_FEED_COLS.join(',')}) VALUES ${place} `
                        + `ON CONFLICT(${keyCols.join(',')}) DO UPDATE SET ${sets}`;
              for (let i = 0; i < rows.length; i += 40) {
                const batch = rows.slice(i, i + 40).map(r =>
                  db.prepare(sql).bind(...GAMELOG_FEED_COLS.map(c => r[c] === undefined ? null : r[c])));
                if (batch.length) await db.batch(batch);
              }
              rowsWritten += rows.length;
              done[id] = 1;
            } catch (e) {
              if (!firstError) {
                firstError = String((e && e.message) || e).slice(0, 300);
                await send(`  ! ${firstError.replace(/\n/g, ' ')}\n`);
              }
            }
            n++;
            if (n % 10 === 0) {
              await env.RATEBOARD_KV.put(DONE_KEY, JSON.stringify({ done, updated: Date.now() }));
              await send(`  ${n} / ${todo.length}  (${rowsWritten} game rows)\n`);
            }
            await sleep(80);
          }
          await env.RATEBOARD_KV.put(DONE_KEY, JSON.stringify({ done, updated: Date.now() }));

          const have = store.ids.filter(id => done[id]).length;
          const left = store.ids.length - have;
          await send(`\ncollected ${n} players this run, ${rowsWritten} game rows.\n`);
          await send(left > 0 ? `${have} of ${store.ids.length} players done - ${left} to go.\n`
                              : `all ${store.ids.length} players done.\n`);
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

    return json({ error: 'gamelog must be one of: probe, go, 1, status, rax, raxgo, raxstatus, check, zerofill, player, query, seasons, facets, csv' }, 400);
  }

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
                  listBuilding: st.building ? st.building.ids.length : null,
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
          // Built a chunk at a time and parked in KV between calls. A full
          // list is a couple of minutes of paging, which is longer than a
          // scheduled run gets, so it has to survive being stopped part way.
          if (url.searchParams.get('rebuild') === '1') store.building = null;
          const part = store.building || { ids: [], before: 0 };
          await send(`building the ${sport} ${season} player list (${part.ids.length} so far)...\n`);

          let finished = false;
          for (let i = 0; i < LIST_CHUNK_PAGES; i++) {
            if (i) await sleep(GAP_MS);
            const rows = rowsOf(await rsGet(
              `https://web.realapp.com/userpassshop/${sport}/season/${season}/entity/player/section/earningstotal?before=${part.before}`, auth));
            for (const r of rows) if (r && r.id != null) part.ids.push(String(r.id));
            part.before += PAGE;
            await send(`  ${part.ids.length} players\n`);
            if (rows.length < PAGE) { finished = true; break; }
            if (part.before >= LIST_MAX_PAGES * PAGE) { finished = true; break; }
          }

          if (finished) {
            store.ids = part.ids;
            store.building = null;
            if (url.searchParams.get('rebuild') === '1') store.games = {};
            await env.RATEBOARD_KV.put(GAMES_KEY, JSON.stringify(store));
            await send(`player list: ${part.ids.length}\n`);
            await send(`list saved - collecting starts on the next pass.\n`);
          } else {
            store.building = part;
            await env.RATEBOARD_KV.put(GAMES_KEY, JSON.stringify(store));
            await send(`${part.ids.length} players so far - continuing on the next pass.\n`);
          }
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
          if (done % 10 === 0) {
            store.updated = Date.now();
            await env.RATEBOARD_KV.put(GAMES_KEY, JSON.stringify(store));
            await send(`  ${done} / ${missing.length}\n`);
          }
          await sleep(80);
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

  // ?preview=1 — the top 20 by rax, rendered in the browser rather than
  // downloaded, as a quick check that the columns line up before pulling the
  // whole season. Owners/followers here come from each player's own screen,
  // which is also a cross-check on the purchases figure in the big list.
  if (url.searchParams.get('preview') === '1') {
    try {
      const store = await readGames();
      const rows = rowsOf(await rsGet(page(0), auth)).slice(0, 20);
      const out = [];
      for (const r of rows) {
        let owners = '', followers = '';
        try {
          const d = await rsGet(`https://web.realapp.com/players/${r.id}/sport/${sport}`, auth);
          owners = (d && d.player && d.player.passCount) || '';
          followers = (d && d.player && d.player.followCount) || '';
        } catch (e) {}
        out.push({ player: r.label || '', rax: r.value, owners, followers,
                   gamesPlayed: store.games[String(r.id)] == null ? null : store.games[String(r.id)],
                   playerId: r.id });
        await sleep(80);
      }
      return json({ sport, season, topByRax: out,
                    gamesCollected: store.ids.filter(id => store.games[id] != null).length,
                    playersKnown: store.ids.length });
    } catch (e) { return json({ error: String((e && e.message) || e) }, 502); }
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
