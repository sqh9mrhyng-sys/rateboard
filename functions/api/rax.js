import { isAdminRequest, allow, clientIp, forbidden } from '../../lib/auth.js';

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
  /* Each sport's own box line, as Real labels it. The columns above are
     basketball's, which is what the log was first built for, so a hockey
     row's time on ice or a receiver's targets had nowhere to go and were
     thrown away. This holds whatever the sport actually reports. */
  stats TEXT,
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
  'fg','fgPct','fg3','fg3Pct','ft','ftPct','tsPct','fantasyPts','comments','stats'];

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
  try { await db.prepare('ALTER TABLE gamelog ADD COLUMN stats TEXT').run(); } catch (e) {}
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
/* The box line as the sport itself reports it, kept small. Anything that
   amounts to nothing - a zero, a blank, an empty clock - is left out and
   read back as nothing, which roughly halves what a hockey row costs to
   store across a million and a half of them. */
const STAT_EMPTY = new Set(['', '0', '0.0', '00:00', '0:00', '0/0', '-', '--']);
function statBlob(b) {
  const out = {};
  for (const x of (b.statValues || [])) {
    if (!x || !x.label) continue;
    const key = String(x.label).trim();
    let v = x.value;
    if (v == null) continue;
    if (x.secondaryValue != null && String(x.secondaryValue) !== '') {
      v = `${v}/${x.secondaryValue}`;
    }
    const str = String(v).trim();
    if (STAT_EMPTY.has(str)) continue;
    const n = Number(str);
    out[key] = Number.isFinite(n) && String(n) === str ? n : str;
  }
  return Object.keys(out).length ? JSON.stringify(out) : null;
}

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
    comments: b.commentCount == null ? null : Number(b.commentCount),
    stats: statBlob(b)
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


// Forgetting what has been walked is all a requeue is: the rows stay, and the
// game-log insert updates in place, so the collector tops a season up rather
// than building it again.
async function forgetWalk(env, sport, season) {
  const keys = [`games_${sport}_${season}`,
                `gamelog_done_${sport}_${season}`,
                `gamelog_rax_${sport}_${season}`,
                `golfmeta_${sport}_${season}`];
  const gone = [];
  for (const k of keys) {
    try { await env.RATEBOARD_KV.delete(k); gone.push(k); } catch (e) {}
  }
  try {
    const today = new Date().toISOString().slice(0, 10);
    const clear = JSON.parse((await env.RATEBOARD_KV.get('queue_clear_v1')) || '{}') || {};
    delete clear[`${sport}:${season}`];
    await env.RATEBOARD_KV.put('queue_clear_v1', JSON.stringify(clear));
    const st = JSON.parse((await env.RATEBOARD_KV.get('queue_stuck_v1')) || '{}') || {};
    if (st.skip) {
      for (const k of Object.keys(st.skip)) if (k.startsWith(`${sport}:${season}:`)) delete st.skip[k];
    }
    st.tag = ''; st.n = 0; st.progress = null;
    await env.RATEBOARD_KV.put('queue_stuck_v1', JSON.stringify(st));
  } catch (e) {}
  return gone;
}

// A running season keeps gaining players and fixtures, so each one gets picked
// up again once a week on its own day - spread out so two big sports never
// land together. Days are Sunday 0 .. Saturday 6, read in Alaska time, and the
// slot opens in the morning there.
/* ---- plays ------------------------------------------------------------
   One row per play, from two feeds that each show part of the picture: a
   player's top plays for a season, and the last stretch of each game. Neither
   is complete - Real serves no full play list - so this is the high end of
   the rating range rather than every snap, which is also where the cards
   worth anything live. `cat` is Real's own collectingCategoryId and is null
   on a play that mints nothing, so it doubles as the card filter.
   ---------------------------------------------------------------------- */
const PLAYS_DDL = `CREATE TABLE IF NOT EXISTS plays (
  id INTEGER PRIMARY KEY, sport TEXT NOT NULL, season INTEGER NOT NULL,
  seasonType TEXT, gameId INTEGER, day TEXT,
  label TEXT, type TEXT, subType TEXT, cat INTEGER, value REAL,
  playerId INTEGER, player TEXT, player2Id INTEGER, player2 TEXT,
  teamId INTEGER, oppTeamId INTEGER,
  period INTEGER, clock TEXT, down INTEGER, togo INTEGER, yards INTEGER,
  epa REAL, tags TEXT, seenAt INTEGER NOT NULL)`;
const TAGS_DDL = `CREATE TABLE IF NOT EXISTS tags (
  id INTEGER NOT NULL, sport TEXT NOT NULL, label TEXT, rarity INTEGER,
  seenAt INTEGER NOT NULL, PRIMARY KEY (id, sport))`;
/* ---- rarity --------------------------------------------------------
   A tag's rarity depends on the play it sits on, not on the tag alone:
   "1st down" is the commonest tag in football and Legendary on a field
   goal. The marketplace only ever shows a tag in one context, so the
   harvested number is a base, and these rules override it per family.
   Levels: 1 common, 2 uncommon, 3 rare, 4 epic, 5 legendary, 6 mystic,
   7 iconic. Supplied by Dennis, who plays the game.
   ------------------------------------------------------------------ */
const normTag = x => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
/* Where Real's hashtag and the name the rules use are not the same word.
   The two strikeout tags end in a K that their printed label does not, and
   keying off the hashtag - which is what the scorer now does - missed them,
   so no pitcher was getting the legendary for either. */
const TAG_ALIASES = {
  twominutedrill: '2minutedrill',
  '2ptconversion': '2pt',
  immaculateinningk: 'immaculateinning',
  '4kinningk': '4kinning'
};
const tagKey = label => {
  const n = normTag(label);
  return TAG_ALIASES[n] || n;
};
/* family: football -> rush | pass | td | fg | def
          baseball -> single | double | triple | homer | strikeout
   Real's own collecting category is the reliable signal in both codes.
   Baseball: 101 single, 102 double, 103 triple, 104 home run, 105 strikeout. */
const MLB_FAMILY = { 101: 'single', 102: 'double', 103: 'triple',
                     104: 'homer', 105: 'strikeout' };
/* Basketball. Real's own category already says what counts: a made shot or a
   trip to the line. A block, a rebound, an assist, a steal, a missed field
   goal - none of them carry a category, so none of them is a play. A missed
   free throw does, which is right: 0/2 is still a card. */
const NBA_FAMILY = { 1: 'dunk', 2: 'layup', 3: 'mid', 4: 'three', 5: 'ft' };
// The women's game files its plays the same way, down to the category ids.
/* College basketball files its plays the same way too. Without it here a
   college play had no shot family, so no rule could reach it, and the only
   legendaries left were the few tags the marketplace happened to show at 5 -
   all of them new in 2025-26. Game-winner, Game-icing and Walk-off carry no
   marketplace reading at all, so the two earlier seasons scored none. */
const HOOPS = new Set(['nba', 'wnba', 'ncaam']);
/* Hockey. One row, two or three earners, and a different thing to each of
   them: a shot on goal is a shot for the man who took it and a save for the
   man who stopped it; a goal is a goal for the scorer and an assist for the
   one or two who set it up. */
const NHL_FAMILY = {
  301: { 1: 'goal', 2: 'assist', 3: 'assist' },
  303: { 1: 'shot', 2: 'save' }
};
/* A fumble recovery is a rare card at best. Only carrying it in lifts it, and
   that play is a touchdown in its own right. Without this, a tag that is
   legendary somewhere else - Beast mode on a run, Imposter on a throw - keeps
   its harvested number when it turns up on the recovery, because the rules
   have nothing to say about that context and the marketplace base is the only
   number left. */
const FUMBLE_CAP = 3;
function fumbleCap(cat, type, subType) {
  if (Number(cat) !== 206) return null;
  const t = String(type || ''), st = String(subType || '');
  if (t === 'Touchdown') return null;
  return (/fumble/i.test(t) || /fumble/i.test(st)) ? FUMBLE_CAP : null;
}

function playFamily(cat, type, subType, sportOf, slot) {
  const t = String(type || ''), st = String(subType || '');
  if (sportOf === 'nhl') {
    const m = cat == null ? null : NHL_FAMILY[cat];
    return (m && m[slot || 1]) || 'other';
  }
  if (HOOPS.has(sportOf) && cat != null && NBA_FAMILY[cat]) return NBA_FAMILY[cat];
  if (cat != null && MLB_FAMILY[cat]) return MLB_FAMILY[cat];
  if (cat === 206) return 'def';
  if (cat === 205) return 'fg';
  if (t === 'Touchdown') return 'td';
  if (cat === 201) return 'rush';
  if (cat === 202) return 'pass';
  if (st === 'Rush') return 'rush';
  if (st === 'PassCompleted') return 'pass';
  return 'other';
}
// tag -> { family: level }, '*' meaning any family. Kept per sport: the same
// tag is not worth the same in both codes - a self-pass touchdown is Iconic
// in the NFL and merely Legendary in college.
const RULES_NFL = {
  // legendary and above
  selfpasstd:     { '*': 7 },
  octopus:        { '*': 5 },
  beastmode:      { rush: 5, td: 5 },
  marathon:       { rush: 5, td: 5 },
  imposter:       { pass: 5, td: 5 },
  haymaker:       { pass: 5, td: 5 },
  thiccsix:       { td: 5 },
  rip:            { td: 5 },
  gamewinner:     { td: 5, fg: 5, def: 5 },
  walkoff:        { td: 5, fg: 5, def: 5 },
  '1stdown':      { fg: 5 },
  deadeye:        { fg: 5 },
  fumble6:        { def: 5 },
  kickreturn:     { def: 5 },
  puntreturn:     { def: 5 },
  // tags that climb a tier on a touchdown
  lateral:        { rush: 4, pass: 4, td: 6 },
  '2minutedrill': { rush: 4, fg: 4, td: 5 },
  flash:          { rush: 4, td: 5 },
  // epic
  '2pt':          { rush: 4, pass: 4 },
  bomb:           { pass: 4, td: 4 },
  '4thdown':      { td: 4, def: 4 },
  gametying:      { td: 4, fg: 4 },
  directsnap:     { td: 4 },
  reverse:        { td: 4 },
  backfield:      { td: 4 },
  openfield:      { td: 4 },
  gains:          { td: 4 },
  dot:            { td: 4 },
  burst:          { td: 4 },
  '2nddown':      { fg: 4 },
  pick6:          { def: 4 },
  // rare, pinned because a single listing can misread them
  snipe:          { '*': 3 },
  lob:            { '*': 3 }
};

const RULES_NCAAF = {
  // legendary
  octopus:        { td: 5, pass: 5, rush: 5 },
  imposter:       { td: 5, pass: 5 },
  haymaker:       { td: 5, pass: 5 },
  beastmode:      { td: 5, rush: 5 },
  marathon:       { td: 5, rush: 5 },
  selfpasstd:     { td: 5 },
  thiccsix:       { td: 5 },
  rip:            { td: 5 },
  gamewinner:     { td: 5, fg: 5, def: 5 },
  walkoff:        { td: 5, fg: 5, def: 5 },
  '1stdown':      { fg: 5 },
  deadeye:        { fg: 5 },
  fumble6:        { def: 5 },
  kickreturn:     { def: 5 },
  puntreturn:     { def: 5 },
  '2minutedrill': { td: 5, fg: 4, rush: 4 },
  flash:          { td: 5, rush: 4 },
  // epic
  '4thdown':      { td: 4, def: 4 },
  gametying:      { td: 4, fg: 4 },
  pick6:          { def: 4 },
  directsnap:     { td: 4 },
  reverse:        { td: 4 },
  backfield:      { td: 4 },
  openfield:      { td: 4 },
  gains:          { td: 4 },
  dot:            { td: 4 },
  burst:          { td: 4 },
  bomb:           { td: 4, pass: 4 },
  '2nddown':      { fg: 4 },
  '2pt':          { pass: 4, rush: 4 },
  // Epic on the play itself, mystic when it is the touchdown.
  lateral:        { pass: 4, rush: 4, td: 6 },
  // rare
  snipe:          { '*': 3 },
  lob:            { '*': 3 }
};

/* Baseball. Only four hit types and the strikeout mint anything, and the
   same tag swings three tiers across them - a Missile is Legendary on a
   single and Mystic on a triple. */
/* Baseball, transcribed from Dennis's table and complete: every context worth
   more than rare is written here. Anything not listed is not elevated - see
   CLOSED_RULES below, which is what stops a marketplace reading standing in
   for a rule that does not exist. */
const RULES_MLB = {
  // iconic / mystic
  ultimateslam:     { homer: 7 },
  '500club':        { homer: 6 },
  missile:          { single: 5, double: 5, triple: 6, homer: 6 },
  // legendary, and the epic contexts of the same tags
  battle:           { single: 4, double: 5, homer: 5 },
  fullcount:        { triple: 5 },
  gametying:        { triple: 5 },
  gamewinner:       { double: 4, triple: 5 },
  gas:              { double: 4, triple: 5, homer: 4 },
  greenlight:       { single: 4, double: 5, homer: 5 },
  grounder:         { triple: 5 },
  immaculateinning: { strikeout: 5 },
  '4kinning':       { strikeout: 5 },
  insidethepark:    { homer: 5 },
  pinchhitter:      { single: 4, double: 4, triple: 4, homer: 5 },
  popup:            { single: 4, double: 5 },
  rocket:           { single: 4, double: 4, triple: 5, homer: 4 },
  rope:             { triple: 5, homer: 4 },
  scorched:         { double: 5 },
  twostrikes:       { triple: 5 },
  walkoff:          { single: 4, double: 5, homer: 5 },
  workingit:        { single: 4, double: 5, homer: 5, strikeout: 4 },
  // epic only
  curves:           { strikeout: 4 },
  firstpitch:       { triple: 4 },
  goahead:          { triple: 4 },
  grandslam:        { homer: 4 },
  laser:            { homer: 4 },
  leadoff:          { triple: 4 },
  lucky:            { triple: 4, homer: 4 },
  moonshot:         { homer: 4 },
  towering:         { homer: 4 }
};

/* Basketball, from Dennis's table. Families are the five kinds of shot.
   walkoff is legendary on any made shot; the Finals version carries a tag of
   its own and is iconic. */
const RULES_NBA = {
  // iconic: a walk-off in the Finals, and nothing else in the game
  finalswalkoff: { '*': 7 },
  // legendary on a made shot, and their epic contexts
  blazing:     { layup: 5, dunk: 5, mid: 5, three: 5, ft: 4 },
  crunchtime:  { layup: 5, dunk: 5, mid: 5, three: 5, ft: 5 },
  equalizing:  { layup: 5, dunk: 5, mid: 5, three: 5, ft: 5 },
  dagger:      { layup: 5, dunk: 5, mid: 5, three: 5, ft: 4 },
  gameicing:   { layup: 5, dunk: 5, mid: 5, three: 5, ft: 5 },
  gamewinner:  { layup: 5, dunk: 5, mid: 5, three: 5, ft: 5 },
  walkoff:     { layup: 5, dunk: 5, mid: 5, three: 5 },
  over:        { dunk: 5, mid: 5, layup: 4, three: 4, ft: 4 },
  fadeaway:    { three: 5 },
  floater:     { three: 5 },
  halfcourter: { three: 5 },
  kingnugget:  { ft: 5 },
  // epic
  clutchtime:  { layup: 4, dunk: 4, mid: 4, three: 4, ft: 4 },
  overtime:    { dunk: 4, mid: 4 },
  firstpoints: { dunk: 4, ft: 4 },
  reverse:     { dunk: 4 },
  streaking:   { dunk: 4, mid: 4, three: 4 },
  offsteal:    { mid: 4 },
  maestro:     { mid: 4 },
  snipe:       { three: 4 },
  bank:        { three: 4 }
};

/* The women's game, from Dennis's table. The same shape as the men's, with no
   dunk column - a dunk is rare enough there that he has no rule for one - and
   no iconic: Real's Finals walk-off tag does not exist in this sport's
   dictionary at all. */
const RULES_WNBA = {
  blazing:     { layup: 5, mid: 5, three: 5, ft: 4 },
  crunchtime:  { layup: 5, mid: 5, three: 5, ft: 5 },
  equalizing:  { layup: 5, mid: 5, three: 5, ft: 5 },
  dagger:      { layup: 5, mid: 5, three: 5, ft: 4 },
  gameicing:   { layup: 5, mid: 5, three: 5, ft: 5 },
  gamewinner:  { layup: 5, mid: 5, three: 5, ft: 5 },
  walkoff:     { layup: 5, mid: 5, three: 5 },
  over:        { mid: 5, layup: 4, three: 4, ft: 4 },
  fadeaway:    { three: 5 },
  floater:     { three: 5 },
  halfcourter: { three: 5 },
  kingnugget:  { ft: 5 },
  // epic
  clutchtime:  { layup: 4, mid: 4, three: 4, ft: 4 },
  overtime:    { mid: 4 },
  firstpoints: { ft: 4 },
  streaking:   { mid: 4, three: 4 },
  offsteal:    { mid: 4 },
  maestro:     { mid: 4 },
  snipe:       { three: 4 },
  bank:        { three: 4 }
};

/* Hockey, from Dennis's table. Families are what the play is to the man
   being credited, not what kind of play it was. */
const RULES_NHL = {
  // iconic / mystic
  ovechkin:      { goal: 7, assist: 6 },
  goaliegoal:    { goal: 6 },
  // legendary
  deflection:    { goal: 5 },
  wraparound:    { goal: 5 },
  centericer:    { goal: 5 },
  lacrosse:      { goal: 5, shot: 5, save: 5 },
  batted:        { goal: 5, shot: 5, save: 5 },
  hattie:        { goal: 5, assist: 5 },
  dagger:        { goal: 5, assist: 5 },
  lateregwinner: { goal: 5, assist: 5 },
  skateoff:      { goal: 5, assist: 5 },
  // epic
  overtime:      { goal: 4, assist: 4 },
  shorthand:     { goal: 4, assist: 4 },
  emptynet:      { goal: 4, assist: 4 },
  gamewinner:    { goal: 4, assist: 4 },
  shootout:      { goal: 4 },
  slapshot:      { goal: 4 },
  tipin:         { goal: 4 },
  backhand:      { goal: 4 },
  bomb:          { goal: 4 },
  snipe:         { goal: 4 }
};

const RULES_BY_SPORT = { nfl: RULES_NFL, ncaaf: RULES_NCAAF, mlb: RULES_MLB,
                         nba: RULES_NBA, wnba: RULES_WNBA, nhl: RULES_NHL,
                         // The men's pro table, until a college one exists. It
                         // is left out of CLOSED_RULES, so a harvested reading
                         // with no rule behind it still counts as it did before.
                         ncaam: RULES_NBA };

/* The marketplace only ever shows a tag on one card, so the rarity harvested
   from it is whatever that card happened to be - Moonshot reads 4 because the
   listing was a home run, and that 4 then followed Moonshot onto a single.
   Where the rule table is complete, every context above rare is written down,
   so a harvested reading above rare that no rule backs is not believed.
   All three are complete: every football play tag reading epic or better
   already has a rule, and the ones that did not turned out to be performance
   tags, which no longer reach a play at all. */
const CLOSED_RULES = { mlb: true, nfl: true, ncaaf: true, nba: true, wnba: true,
                       nhl: true };
const BASE_CEILING = 3;
const baseCeiling = sp => CLOSED_RULES[String(sp || '').toLowerCase()] ? BASE_CEILING : 7;

/* Every id Real's own tag dictionary gives for the tags the rules name, read
   off /tagsearch rather than waited for in the marketplace. A tag that only
   ever sits on a card nobody lists - selfpasstd, ultimateslam, 500club -
   would otherwise never be learnt at all. 1217 and 1218 are the plain
   markers Real puts on every touchdown and every field goal; they carry no
   rarity of their own and are here only so they stop counting as unknown.
   `tags=seed` keeps the whole table in step with this; the map stays as the
   floor for the handful the rules depend on. */
const TAG_ID_PINS = {
  nfl:   { 2202: 'selfpasstd', 1222: 'thiccsix', 1159: 'deadeye', 1226: 'octopus',
           1271: 'kickreturn', 1272: 'puntreturn', 1270: 'pick6',
           1217: 'touchdown', 1218: 'fieldgoal' },
  ncaaf: { 2202: 'selfpasstd', 1222: 'thiccsix', 1159: 'deadeye', 1226: 'octopus',
           2105: 'directsnap', 2106: 'reverse', 1210: '2minutedrill',
           1271: 'kickreturn', 1272: 'puntreturn', 1270: 'pick6',
           1120: 'beastmode', 1215: 'gamewinner', 1216: 'walkoff',
           2200: 'lateral', 1074: '2pt',
           1217: 'touchdown', 1218: 'fieldgoal' },
  /* 2020 is Real's own marker for a walk-off in the Finals, and it is not in
     the tag dictionary that /tagsearch returns - the only way to find it was
     from the two plays that carry it. It sits on exactly one play in each
     Finals game and on nothing in a regular-season or earlier-round game, so
     the Finals never has to be worked out from the schedule. */
  nba:   { 2020: 'finalswalkoff' },
  mlb:   { 6053: 'ultimateslam', 6291: 'immaculateinning', 6172: '500club',
           6093: 'missile', 6165: 'insidethepark', 6163: 'popup',
           5911: 'greenlight', 6051: 'grandslam', 6216: 'curves',
           6701: '4kinning' }
};
const pinsFor = sp => TAG_ID_PINS[String(sp || '').toLowerCase()] || {};
// An unlisted sport gets no overrides at all rather than another code's.
const rulesFor = sp => RULES_BY_SPORT[String(sp || '').toLowerCase()] || {};

/* Real files every field goal attempt under its made-FG category, misses
   included, so they are excluded here. COALESCE throughout: subType and label
   are null on an ordinary kick, and a null inside NOT(...) makes the whole
   test null, which silently drops the row. */
const CARD_SQL = `cat IS NOT NULL AND NOT (cat = 205 AND (
  COALESCE(subType,'') = 'BlockedKick'
  OR COALESCE(label,'') LIKE '%miss%'
  OR COALESCE(label,'') LIKE '%no good%'
  OR COALESCE(label,'') LIKE '%blocked%'
  OR COALESCE(label,'') LIKE '%wide%'
  OR COALESCE(label,'') LIKE '%doink%'))`;

/* A completed pass mints a card for the receiver AND the quarterback. Real
   files the receiver as the primary player and the passer as the secondary,
   so a player's plays are their primary rows plus the completions they threw.
   No other play type credits its secondary: the second name on a sack or an
   interception is the victim, who gets nothing. */
const PASS_CREDIT = `(type='PassCompleted'
  OR (type='Touchdown' AND subType='PassCompleted')
  OR (type='TwoPointConversion' AND subType='PassCompleted'))`;
/* A strikeout is filed from the batter's side - the batter is the primary
   name and the pitcher the secondary - but the card belongs to the pitcher
   and to no one else. So the batter's own rows stop short of a strikeout,
   and the pitcher is credited off the secondary name instead. Category 105
   is baseball's alone, so football is untouched by it. */
const STRIKEOUT = `COALESCE(cat, 0) = 105`;
/* Every hockey play has a second man who earns from it - the goalie on a shot,
   the assist on a goal - rather than the handful of play types that credit a
   second name in the other codes. */
/* A shootout goal has no assist, and Real puts the beaten goalie in the slot
   an assist would normally occupy - so crediting the second name there would
   hand the goalie an assist for being scored on. Tag 3184 is the shootout.
   Every other goal leaves the slot empty when nobody assisted. */
const NHL_SHOOTOUT_TAG = 3184;
const HOCKEY_SECOND = `(COALESCE(cat, 0) = 303
  OR (COALESCE(cat, 0) = 301
      AND instr(',' || COALESCE(tags, '') || ',', ',${NHL_SHOOTOUT_TAG},') = 0))`;
// Every card play, once per player who earns a card from it.
const CREDITED = `
  SELECT playerId AS pid, player AS pname, season, gameId, rarity, value, cat,
         type, subType, id, day, tags
    FROM plays WHERE sport=?1 AND season=?2 AND ${CARD_SQL}
     AND NOT ${STRIKEOUT}
  UNION ALL
  SELECT player2Id AS pid, player2 AS pname, season, gameId,
         COALESCE(rarity2, rarity) AS rarity, value, cat,
         type, subType, id, day, tags
    FROM plays WHERE sport=?1 AND season=?2 AND ${CARD_SQL}
     AND player2Id IS NOT NULL AND player2Id <> COALESCE(playerId, -1)
     AND (${PASS_CREDIT} OR ${STRIKEOUT} OR ${HOCKEY_SECOND})
  UNION ALL
  /* Hockey's second assist. No other sport files a third earner. */
  SELECT player3Id AS pid, player3 AS pname, season, gameId,
         COALESCE(rarity3, rarity) AS rarity, value, cat,
         type, subType, id, day, tags
    FROM plays WHERE sport=?1 AND season=?2 AND ${CARD_SQL}
     AND player3Id IS NOT NULL AND player3Id <> COALESCE(playerId, -1)
     AND player3Id <> COALESCE(player2Id, -1) AND cat = 301
     AND instr(',' || COALESCE(tags, '') || ',', ',${NHL_SHOOTOUT_TAG},') = 0`;

/* ---- performances ---------------------------------------------------
   A performance is the player's whole game line: its own card, its own
   rating, and its own tags - Hundo, Carrier, Air-Hundo and the rest, which
   describe the game rather than a snap. They come from the player
   seasonfeed, the same call the game log is built from, in a
   `performanceTags` field distinct from the play tags on the same row.
   Held only; nothing reads this yet.
   -------------------------------------------------------------------- */
const PERF_DDL = `CREATE TABLE IF NOT EXISTS performances (
  id INTEGER PRIMARY KEY, sport TEXT NOT NULL, season INTEGER NOT NULL,
  playerId INTEGER, player TEXT, gameId INTEGER, day TEXT, seasonType TEXT,
  teamId INTEGER, oppTeamId INTEGER, team TEXT, opponent TEXT,
  value REAL, rarity INTEGER, tags TEXT, stats TEXT,
  played INTEGER, started INTEGER, seenAt INTEGER NOT NULL)`;
const PERF_CURSOR = 'perf_cursor_v1';
const PERF_PER_TICK = 60;     // players per call; one call covers their season

async function perfReady(db) {
  await db.prepare(PERF_DDL).run();
  for (const ix of [
    'CREATE INDEX IF NOT EXISTS perf_sp ON performances (sport, season, playerId)',
    'CREATE INDEX IF NOT EXISTS perf_game ON performances (sport, season, gameId)',
    'CREATE INDEX IF NOT EXISTS perf_rar ON performances (sport, season, rarity)'
  ]) { try { await db.prepare(ix).run(); } catch (e) {} }
}

const PLAYS_CURSOR = 'plays_cursor_v1';
// Which seasons the tick walks. Add a line here and the cron picks it up; the
// worker itself holds nothing and never needs redeploying.
const PLAYS_SPORTS = [
  // Lowest pri collects first. The whole backlog is worked in this order and
  // nothing below a tier gets a game tick while anything in it is unfinished.
  { sport: 'mlb',   season: 2026, pri: 1 },     // season over, no longer rolling
  { sport: 'mlb',   season: 2025, pri: 2 },
  { sport: 'mlb',   season: 2024, pri: 3 },
  { sport: 'mlb',   season: 2023, pri: 4 },
  { sport: 'mlb',   season: 2022, pri: 5 },
  // Current seasons next - a weekend's games land here and are picked up as
  // soon as the MLB backfill is through.
  { sport: 'nfl',   season: 2026, rolling: true, pri: 6 },
  { sport: 'ncaaf', season: 2026, rolling: true, pri: 6 },
  // Anything still owed from the finished seasons.
  { sport: 'nfl',   season: 2025, pri: 7 },
  { sport: 'nfl',   season: 2024, pri: 7 },
  { sport: 'nfl',   season: 2023, pri: 7 },
  { sport: 'ncaaf', season: 2025, pri: 7 },
  { sport: 'ncaaf', season: 2024, pri: 7 },
  { sport: 'ncaaf', season: 2023, pri: 7 },
  /* Basketball, newest first. The NBA labels a season by the year it ENDS,
     so 2027 is the one being played now and 2026 is last year's, finished.
     Hockey and football label by the year a season STARTS, which is why
     nhl 2026 below is current while nba 2026 is not. */
  { sport: 'nba',   season: 2027, rolling: true, pri: 8 },
  { sport: 'nba',   season: 2026, pri: 9 },
  { sport: 'nba',   season: 2025, pri: 9 },
  { sport: 'nba',   season: 2024, pri: 10 },
  { sport: 'nba',   season: 2023, pri: 11 },
  // The women's game. Three seasons is all Real holds.
  { sport: 'wnba',  season: 2026, pri: 12 },   // season over, no longer rolling
  { sport: 'wnba',  season: 2025, pri: 13 },
  { sport: 'wnba',  season: 2024, pri: 14 },
  /* College basketball - pack data needs it, the other two views already
     have the game log. Same ending-year labelling as the NBA. */
  { sport: 'ncaam', season: 2027, rolling: true, pri: 15 },
  { sport: 'ncaam', season: 2026, pri: 16 },
  { sport: 'ncaam', season: 2025, pri: 17 },
  { sport: 'ncaam', season: 2024, pri: 18 },
  // Hockey last.
  { sport: 'nhl',   season: 2026, rolling: true, pri: 19 },
  { sport: 'nhl',   season: 2025, pri: 20 },
  { sport: 'nhl',   season: 2024, pri: 21 },
  { sport: 'nhl',   season: 2023, pri: 22 }
];
// Performance box scores are collected only once every play queue above has
// lapped, so they never compete with the sweep for a tick.
const PERF_QUEUE = [
  { sport: 'nfl',   season: 2026 },
  { sport: 'nfl',   season: 2025 },
  { sport: 'nfl',   season: 2024 },
  { sport: 'nfl',   season: 2023 },
  { sport: 'ncaaf', season: 2026 },
  { sport: 'ncaaf', season: 2025 },
  { sport: 'ncaaf', season: 2024 },
  { sport: 'ncaaf', season: 2023 },
  { sport: 'mlb',   season: 2026 },
  { sport: 'mlb',   season: 2025 },
  { sport: 'mlb',   season: 2024 },
  { sport: 'mlb',   season: 2023 },
  { sport: 'mlb',   season: 2022 },
  { sport: 'nba',   season: 2026 },
  { sport: 'nba',   season: 2025 },
  { sport: 'nba',   season: 2024 },
  { sport: 'nba',   season: 2023 },
  { sport: 'wnba',  season: 2026 },
  { sport: 'wnba',  season: 2025 },
  { sport: 'wnba',  season: 2024 },
  { sport: 'nhl',   season: 2026 },
  { sport: 'nhl',   season: 2025 },
  { sport: 'nhl',   season: 2024 },
  { sport: 'nhl',   season: 2023 }
];
const perfDoneKey = (sp, se) => `perf_done_${sp}_${se}`;
const sweptKey = (sp, se) => `plays_swept_${sp}_${se}`;
const SCORE_BATCH = 80000;       // plays rescored per call
// A game's feed comes back whole - every snap, around 175 rows for an NFL
// game - so games are taken a few at a time. Players are a thin top-plays
// list and can be walked in bigger strides.
const PLAYS_PER_TICK = 24;        // players per call
const GAMES_PER_TICK = 10;        // games per call, each one a full game
/* A baseball game's feed is around eighty plays where a football game's is
   nearer a hundred and seventy-five, so more of them fit in a tick without
   the call running any longer than a football one already does. */
/* Measured at about a sixth of a second a game with five in the air, so a
   hundred and fifty of them is twenty-five seconds - comfortably inside the
   minute between ticks, and no faster a burst than before, just a longer one. */
/* Measured: a basketball game is 267 rows and the database takes about three
   tenths of a second a game to swallow them - the writing is the wall, not
   the asking, so fetching more at once buys nothing. 150 fills about
   forty-five seconds of the minute between ticks, which is as much as can be
   taken without a call still running when the next one starts. */
const GAMES_PER_TICK_BY_SPORT = { mlb: 150, ncaaf: 90, nfl: 60, nba: 150, wnba: 150, nhl: 150 };

/* ----- historical seasons ---------------------------------------------------
   Real serves game logs with a real per-game rating all the way back to the
   2000 season - Brady's one appearance that November is there - but it only
   publishes a player list from 2021 on, so an older season cannot simply be
   walked. It is crawled instead.

   Each season is seeded with the players already known from the season after
   it, which is most of a roster since few retire in one year. Their season
   feeds give the games they played, and each game's feed names everyone who
   was in it, which picks up the players who had already retired by the season
   we seeded from. Those in turn get their own season feeds, and the thing
   closes on itself in a few passes. Both feeds are ones the collector already
   calls; nothing new is reached for.

   Nothing older than 2000 is asked for: 1999 comes back empty, which is the
   real edge of the data rather than a failure. */
/* Football labels a season by the year it starts, basketball by the year it
   ends, so these ranges do not line up the way they look. NFL 2000 is the
   2000-01 season; NBA 2004 is 2003-04, LeBron's first, which is as far back
   as Real serves a rating. */
const HIST_RANGE = {
  nfl: [2000, 2022],
  nba: [2004, 2022]
};
const HIST_SPORTS = Object.keys(HIST_RANGE);
const HIST_SPORT = 'nfl';                       // the first one, for the seed
const HIST_PLAYERS_PER_TICK = 150;
const HIST_GAMES_PER_TICK = 60;
const histHolds = (sp, se) => {
  const r = HIST_RANGE[String(sp || '').toLowerCase()];
  return !!r && Number(se) >= r[0] && Number(se) <= r[1];
};
const HIST_QUEUE = (() => {
  const out = [];
  for (const sp of HIST_SPORTS) {
    const [lo, hi] = HIST_RANGE[sp];
    for (let y = hi; y >= lo; y--) out.push({ sport: sp, season: y });
  }
  return out;
})();
/* ----- re-reading the box scores -------------------------------------------
   The game log was built around basketball's column names, so every sport
   that files its numbers under different labels - hockey's time on ice,
   football's carries and targets - had them dropped on the way in. The
   stats column holds the sport's own line now, and this walks back through
   what has already been collected to fill it.

   No discovery needed: the players are already in the log. It is simply
   every player-season, asked for again and written back over itself.
   Hockey first, then the pro sports, then the rest. This takes the
   collecting ticks ahead of the historical crawl, which waits. */
const RESTAT_QUEUE = [
  { sport: 'nhl',    seasons: [2026, 2025, 2024, 2023] },
  { sport: 'nfl',    seasons: [2026, 2025, 2024, 2023] },
  { sport: 'nba',    seasons: [2026, 2025, 2024, 2023] },
  { sport: 'mlb',    seasons: [2026, 2025, 2024, 2023, 2022] },
  { sport: 'wnba',   seasons: [2026, 2025, 2024] },
  { sport: 'soccer', seasons: [2026, 2025] },
  { sport: 'ncaaf',  seasons: [2026, 2025, 2024, 2023] },
  { sport: 'ncaam',  seasons: [2026, 2025, 2024] },
  { sport: 'golf',   seasons: [2026, 2025, 2024, 2023, 2022, 2021, 2020,
                               2019, 2018, 2017, 2016, 2015, 2014] }
].flatMap(x => x.seasons.map(se => ({ sport: x.sport, season: se })));
const RESTAT_PER_TICK = 150;
const restatKey = (sp, se) => `restat_${sp}_${se}`;
const restatDoneKey = (sp, se) => `restat_done_${sp}_${se}`;

const histKey = (sp, se) => `hist_${sp}_${se}`;
const histDoneKey = (sp, se) => `hist_done_${sp}_${se}`;
/* How many of those feeds are in the air at once. Five keeps the call well
   inside its minute while asking Real for no more per second than a person
   clicking through games quickly would. */
const FETCH_AT_ONCE = 8;
/* Seasons already swept still need looking at now and then for games that
   have since been played. One tick in thirty is enough to keep a weekend's
   football from going unnoticed, and leaves the rest for the backlog. */
const REFRESH_EVERY = 30;
// Performance box scores: off while there is a sweep to finish.
const PERF_ON = false;
const gamesPerTick = sp => GAMES_PER_TICK_BY_SPORT[String(sp || '').toLowerCase()]
  || GAMES_PER_TICK;

async function playsReady(db) {
  await db.prepare(PLAYS_DDL).run();
  await db.prepare(TAGS_DDL).run();
  try { await db.prepare('ALTER TABLE plays ADD COLUMN rarity INTEGER').run(); } catch (e) {}
  /* Real's display label and its hashtag are not the same word - tag 2202
     reads "Self-pass-touchdown" but hashes to "selfpasstd", and the rules are
     written from the hashtags. Keying off the label silently dropped the
     rule. */
  try { await db.prepare('ALTER TABLE tags ADD COLUMN hash TEXT').run(); } catch (e) {}
  /* Real sorts its own tags into kinds: 'play' for the ones that sit on a
     snap, 'playerboxscore' for the performance tags - Hundo, Air-force,
     Marksman - and team and game ones above those. The marketplace harvest
     cannot tell them apart and had been letting a performance tag's rarity
     land on a play. */
  try { await db.prepare('ALTER TABLE tags ADD COLUMN kind TEXT').run(); } catch (e) {}
  /* Hockey puts up to three earners on one play - a goal carries its scorer
     and both assists - and what the play is worth depends on which of them
     you are asking about: the same row is a goal for the scorer and an assist
     for the man who fed him. So the third name gets a column, and so does the
     rarity of each side. */
  for (const c of ['player3Id INTEGER', 'player3 TEXT',
                   'rarity2 INTEGER', 'rarity3 INTEGER']) {
    try { await db.prepare(`ALTER TABLE plays ADD COLUMN ${c}`).run(); } catch (e) {}
  }
  try { await db.prepare('ALTER TABLE tags ADD COLUMN altRarity TEXT').run(); } catch (e) {}
  for (const ix of [
    'CREATE INDEX IF NOT EXISTS plays_sp ON plays (sport, season, playerId)',
    'CREATE INDEX IF NOT EXISTS plays_game ON plays (gameId)',
    'CREATE INDEX IF NOT EXISTS plays_cat ON plays (sport, season, cat)',
    // The quarterback side of a completed pass is looked up by this.
    'CREATE INDEX IF NOT EXISTS plays_p2 ON plays (sport, season, player2Id)',
    'CREATE INDEX IF NOT EXISTS plays_score ON plays (sport, season, rarity)'
  ]) { try { await db.prepare(ix).run(); } catch (e) {} }
}

const playName = o => o ? [o.firstName, o.lastName].filter(Boolean).join(' ') || null : null;

function playStmt(db) {
  return db.prepare(
    `INSERT INTO plays (id, sport, season, seasonType, gameId, day, label, type, subType,
                        cat, value, playerId, player, player2Id, player2,
                        player3Id, player3, teamId, oppTeamId,
                        period, clock, down, togo, yards, epa, tags, seenAt)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     /* The key is (id, sport) now: a college play and a pro one can carry the
        same id, and naming only the id here matches no constraint at all, so
        every insert fails. The conflict target has to be the whole key. */
     ON CONFLICT(id, sport) DO UPDATE SET value=excluded.value, cat=excluded.cat,
       season=excluded.season, gameId=excluded.gameId, day=excluded.day,
       label=excluded.label, type=excluded.type, subType=excluded.subType,
       playerId=excluded.playerId, player=excluded.player,
       player2Id=excluded.player2Id, player2=excluded.player2,
       player3Id=excluded.player3Id, player3=excluded.player3,
       tags=excluded.tags, seenAt=excluded.seenAt`);
}

function playBind(stmt, r, sport, season) {
  const ai = r.additionalInfo || {};
  const cl = (r.display && r.display.clock) || {};
  return stmt.bind(
    Number(r.id), sport, Number(r.season || season), r.seasonType || null,
    r.gameId == null ? null : Number(r.gameId), r.day || null,
    r.label || r.metricLabel || null, r.type || null, r.subType || null,
    r.collectingCategoryId == null ? null : Number(r.collectingCategoryId),
    // Baseball scores a strikeout negative from the batter's side; the card
    // is worth the size of it, so -7.8 is a 7.8.
    r.value == null ? null
      : (sport === 'mlb' && r.collectingCategoryId != null
          ? Math.abs(Number(r.value)) : Number(r.value)),
    r.primaryPlayerId == null ? null : Number(r.primaryPlayerId), playName(r.primaryPlayer),
    r.secondaryPlayerId == null ? null : Number(r.secondaryPlayerId), playName(r.secondaryPlayer),
    // Hockey's second assist. The fourth name on a goal is the goalie it went
    // past, who earns nothing for it, so it is not kept.
    r.tertiaryPlayerId == null ? null : Number(r.tertiaryPlayerId), playName(r.tertiaryPlayer),
    r.teamId == null ? null : Number(r.teamId),
    r.opponentTeamId == null ? null : Number(r.opponentTeamId),
    r.period == null ? null : Number(r.period),
    cl.time || null,
    ai.down == null ? null : Number(ai.down),
    ai.distanceToGo == null ? null : Number(ai.distanceToGo),
    ai.totalYardsGained == null ? null : Number(ai.totalYardsGained),
    ai.epa == null ? null : Number(ai.epa),
    Array.isArray(r.tags) ? r.tags.join(',') : null,
    Date.now());
}

/* Which kinds of game mint cards. Baseball adds 'allstar', which is what
   Real files the World Baseball Classic under - the international games, and
   the tune-ups a national side plays against a club. Every hit and strikeout
   in those counts, and the filter had been throwing all of them away. The
   MLB All-Star Game itself sits in the same bucket and now counts too. */
const SEASON_TYPES = {
  mlb: ['regularseason', 'postseason', 'allstar']
};
const SEASON_TYPES_DEFAULT = ['regularseason', 'postseason'];
const seasonTypesFor = sp =>
  SEASON_TYPES[String(sp || '').toLowerCase()] || SEASON_TYPES_DEFAULT;
const keepsPlays = (sp, st) => !st || seasonTypesFor(sp).includes(String(st));
// For putting the same list into SQL. The values are ours, not anyone's input.
const seasonTypeSql = sp => seasonTypesFor(sp).map(x => `'${x}'`).join(',');

const RESCAN_DAY = { ncaaf: 0, soccer: 1, nfl: 2, ncaam: 3, nba: 4, nhl: 5, wnba: 6, golf: 6 };
/* The season each sport is actually playing now, which is what the weekly
   rescan should be re-walking. Basketball labels a season by the year it
   ends, so the NBA and college basketball are on 2027 while hockey and
   football - which label by the starting year - are on 2026. Getting this
   wrong means re-walking a season that finished months ago. */
/* MLB is out of here: the 2026 season is over, and it gets one last re-walk
   below instead of a weekly one. */
const RESCAN_SEASON = { ncaaf: 2026, soccer: 2026, nfl: 2026, ncaam: 2027, nba: 2027,
                        nhl: 2026, wnba: 2026, golf: 2026 };
/* One-off re-walks at a set time, each run once. MLB 2026's final sweep is
   10am Eastern on Friday 30 October: the game logs and rax are re-walked,
   and the play sweep is reopened so the last games' plays reach pack data. */
const ONE_OFF_RESCANS = [
  { id: 'mlb2026-final', sport: 'mlb', season: 2026, at: Date.parse('2026-10-30T14:00:00Z'), walk: true },
  // Two hours later, once the re-walk has put any new games in the log: the
  // play sweep is reopened and fills plays for the games it has not seen.
  { id: 'mlb2026-final-plays', sport: 'mlb', season: 2026, at: Date.parse('2026-10-30T16:00:00Z'), plays: true }
];
const ONE_OFF_KEY = 'queue_oneoff_v1';
const RESCAN_KEY = 'queue_rescan_v1';

// Alaska runs eight hours behind UTC, so 7am there is 15:00 UTC.
function alaskaNow() {
  const t = new Date(Date.now() - 8 * 3600 * 1000);
  return { day: t.getUTCDay(), hour: t.getUTCHours(), stamp: t.toISOString().slice(0, 10) };
}

async function weeklyRescan(env) {
  let ran = {};
  try { ran = JSON.parse((await env.RATEBOARD_KV.get(ONE_OFF_KEY)) || '{}') || {}; } catch (e) {}
  for (const job of ONE_OFF_RESCANS) {
    if (Date.now() < job.at || ran[job.id]) continue;
    if (job.walk) await forgetWalk(env, job.sport, job.season);
    if (job.plays) {
      try { await env.RATEBOARD_KV.delete(sweptKey(job.sport, job.season)); } catch (e) {}
    }
    ran[job.id] = new Date().toISOString();
    try { await env.RATEBOARD_KV.put(ONE_OFF_KEY, JSON.stringify(ran)); } catch (e) {}
    return `${job.sport} ${job.season} (${job.id})`;
  }
  const now = alaskaNow();
  if (now.hour < 7) return null;            // morning, not the small hours
  let seen = {};
  try { seen = JSON.parse((await env.RATEBOARD_KV.get(RESCAN_KEY)) || '{}') || {}; } catch (e) {}
  for (const [sp, day] of Object.entries(RESCAN_DAY)) {
    if (day !== now.day) continue;
    if (seen[sp] === now.stamp) continue;   // already done this week
    const se = RESCAN_SEASON[sp];
    if (!se) continue;
    await forgetWalk(env, sp, se);
    seen[sp] = now.stamp;
    try { await env.RATEBOARD_KV.put(RESCAN_KEY, JSON.stringify(seen)); } catch (e) {}
    return `${sp} ${se}`;
  }
  return null;
}

async function handleGet({ request, env }) {
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

  // Walk the marketplace a slice at a time, keeping the place in KV so the
  // next tick carries on. Same shape as the game log collector.
  // Collect plays. Two sources, same table, deduped on the play id: each
  // player's top plays for the season, and the tail of each game.
  if (url.searchParams.get('plays') === 'collect') {
    const db = env.RATEBOARD_DB;
    if (!db) return json({ error: 'no database binding' }, 503);
    const from = url.searchParams.get('from') === 'games' ? 'games' : 'players';
    await playsReady(db);
    const key = `${PLAYS_CURSOR}:${from}:${sport}:${season}`;
    let after = 0;
    try { after = Number(await env.RATEBOARD_KV.get(key)) || 0; } catch (e) {}
    // reset=1 sends the walk back to the start, for when the feed behind it
    // changes and everything collected before is worth re-reading.
    if (url.searchParams.get('reset') === '1') {
      after = 0;
      try { await env.RATEBOARD_KV.put(key, '0'); } catch (e) {}
    }
    // Jump the walk to a point, for picking up only the newest games.
    const afterArg = url.searchParams.get('after');
    if (afterArg != null && /^\d+$/.test(afterArg)) {
      after = Number(afterArg);
      try { await env.RATEBOARD_KV.put(key, String(after)); } catch (e) {}
    }

    // Both lists come from the game log, which already knows every player and
    // every game of a season.
    const q = from === 'games'
      ? `SELECT DISTINCT gameId AS n FROM gamelog WHERE sport=? AND season=? AND gameId > ?
           ORDER BY gameId LIMIT ?`
      : `SELECT DISTINCT playerId AS n FROM gamelog WHERE sport=? AND season=? AND playerId > ?
           ORDER BY playerId LIMIT ?`;
    let ids = [];
    try {
      const r = await db.prepare(q).bind(sport, Number(season), after,
                     from === 'games' ? gamesPerTick(sport) : PLAYS_PER_TICK).all();
      ids = (r.results || []).map(x => Number(x.n)).filter(Boolean);
    } catch (e) { return json({ error: 'could not read the game log', detail: String((e && e.message) || e) }, 503); }

    if (!ids.length) {
      try { await env.RATEBOARD_KV.put(key, '0'); } catch (e) {}
      /* The walk only ever goes forward, so a game that reached the log after
         the cursor passed its id was never collected - and a finished season
         is never walked again, so it would stay missing for good. Before
         calling a season done, look for those and take them. */
      let left = 0;
      if (from === 'games') {
        try {
          const r = await db.prepare(
            `SELECT COUNT(*) AS n FROM (
               SELECT DISTINCT g.gameId AS id FROM gamelog g
                WHERE g.sport=?1 AND g.season=?2
                  AND g.seasonType IN (${seasonTypeSql(sport)})
                  AND NOT EXISTS (SELECT 1 FROM plays p
                                   WHERE p.sport=?1 AND p.season=?2 AND p.gameId=g.gameId)
                LIMIT 500)`).bind(sport, Number(season)).first();
          left = Number((r && r.n) || 0);
        } catch (e) {}
      }
      /* Take the games the cursor walked past, once, and then call the season
         done either way. Some games can never be filled - an exhibition whose
         plays Real files under a season type this sport does not collect -
         and trying again means lapping, resetting the cursor and re-walking
         the whole season to arrive back at the same gap. That is not slow
         collecting, it is no collecting at all, with everything queued behind
         it waiting. Whatever is still missing afterwards is reported by
         ?plays=gaps and can be filled on demand. */
      if (left) {
        const u = new URL(url);
        u.search = `?plays=gaps&sport=${sport}&season=${season}&fill=1&n=40`;
        try { await handleGet({ request: new Request(u.toString(), request), env }); } catch (e) {}
      }
      // A completed season needs one pass, not endless ones.
      // Mark it lapped whether or not it is a rolling season: a rolling one
      // still needs revisiting for new games, just far less often than a
      // season being filled for the first time.
      try { await env.RATEBOARD_KV.put(sweptKey(sport, season), '1'); } catch (e) {}
      return json({ sport, season, from, lap: true, done: 0, stored: 0, gapsLeft: left });
    }

    const stmt = playStmt(db);
    let stored = 0, asked = 0;
    /* Fetched a few at a time rather than one after another. A game's feed is
       most of the wait - about four tenths of a second of it - and nothing in
       one game depends on another, so they are asked for together and the
       rows written as each group comes back. */
    const urlFor = id => from === 'games'
      ? `https://web.realapp.com/games/${id}/sport/${sport}/feed?version=2&view=all&viewFrame=default`
      : `https://web.realapp.com/players/${id}/sport/${sport}/plays/top?limit=50&viewFrame=season`;
    const groups = [];
    for (let i = 0; i < ids.length; i += FETCH_AT_ONCE) {
      groups.push(ids.slice(i, i + FETCH_AT_ONCE));
    }
    for (const group of groups) {
      const got = await Promise.all(group.map(id =>
        rsGet(urlFor(id), auth).then(d => d, () => null)));
      const batch = [];
      for (const d of got) {
        if (!d) continue;
        asked++;
        const rows = Array.isArray(d && d.plays) ? d.plays : rowsOf(d);
        for (const r of rows) {
          if (!r || !r.id || !Number.isFinite(Number(r.id))) continue;
          if (!keepsPlays(sport, r.seasonType)) continue;
          batch.push(playBind(stmt, r, sport, season));
        }
      }
      /* Chunked, and the count is what actually landed. An unchunked batch
         meant a single row D1 would not take threw the whole game away, and
         the empty catch then reported it as stored. */
      for (let i = 0; i < batch.length; i += 250) {
        const part = batch.slice(i, i + 250);
        try { await db.batch(part); stored += part.length; } catch (e) {}
      }
      await sleep(15);
    }
    after = ids[ids.length - 1];
    try { await env.RATEBOARD_KV.put(key, String(after)); } catch (e) {}
    let held = 0;
    try {
      const h = await db.prepare('SELECT COUNT(*) AS n FROM plays WHERE sport=? AND season=?')
        .bind(sport, Number(season)).first();
      held = Number((h && h.n) || 0);
    } catch (e) {}
    return json({ sport, season, from, asked, stored, held, nextAfter: after, lap: false });
  }

  // The tag dictionary. Plays carry tag ids but nothing that says what a tag
  // is or what rarity it carries - cards do, in traits[], so a handful of
  // marketplace cards fills the table in.
  /* Read Real's own tag dictionary and write every id and name into the tag
     table. The marketplace harvest only ever meets a tag that someone has
     listed, which is why the top-end ones stayed nameless for so long; this
     asks for the whole list instead. Rarities already learnt are left alone -
     this fills in names, not numbers. */
  if (url.searchParams.get('plays') === 'tagseed' || url.searchParams.get('tags') === 'seed') {
    const db = env.RATEBOARD_DB;
    if (!db) return json({ error: 'no database binding' }, 503);
    await playsReady(db);
    let tags = [];
    try {
      const d = await rsGet(`https://web.realapp.com/tagsearch/${sport}?type=tags`, auth);
      tags = Array.isArray(d && d.tags) ? d.tags : rowsOf(d);
    } catch (e) {
      return json({ error: 'tagsearch failed', detail: String((e && e.message) || e) }, 502);
    }
    const stmt = db.prepare(
      `INSERT INTO tags (id, sport, label, hash, kind, rarity, seenAt) VALUES (?,?,?,?,?,NULL,?)
       ON CONFLICT(id, sport) DO UPDATE SET label=excluded.label,
         hash=excluded.hash, kind=excluded.kind, seenAt=excluded.seenAt`);
    const batch = [];
    const kinds = {};
    for (const t of tags) {
      if (!t || t.id == null) continue;
      kinds[t.type || 'unknown'] = (kinds[t.type || 'unknown'] || 0) + 1;
      batch.push(stmt.bind(Number(t.id), sport, t.label || t.name || null,
                           t.hashTag || null, t.type || null, Date.now()));
    }
    for (let i = 0; i < batch.length; i += 200) {
      try { await db.batch(batch.slice(i, i + 200)); } catch (e) {}
    }
    return json({ sport, named: batch.length, kinds });
  }

  if (url.searchParams.get('plays') === 'tags') {
    const db = env.RATEBOARD_DB;
    if (!db) return json({ error: 'no database binding' }, 503);
    await playsReady(db);
    // The top-end tags only sit on top-end cards, so the harvest can be
    // pointed straight at them instead of waiting for one to drift past.
    const rarityFilter = String(url.searchParams.get('rarity') || 'all')
      .replace(/[^a-z0-9]/gi, '').slice(0, 20) || 'all';
    const baseSweep = () => rarityFilter === 'all';
    const stmt = db.prepare(baseSweep()
      // The base is the tag's floor: a play's context only ever raises it, so
      // the lowest reading ever seen is the one that is not context-inflated.
      ? `INSERT INTO tags (id, sport, label, rarity, seenAt) VALUES (?,?,?,?,?)
         ON CONFLICT(id, sport) DO UPDATE SET label=excluded.label,
           rarity=MIN(COALESCE(tags.rarity, 99), COALESCE(excluded.rarity, 99)),
           altRarity = CASE WHEN tags.rarity = excluded.rarity THEN tags.altRarity
             ELSE TRIM(COALESCE(tags.altRarity, '') || ',' || CAST(excluded.rarity AS TEXT), ',') END,
           seenAt=excluded.seenAt`
      // Targeted sweeps exist to learn a rare tag's id and name. Their rarity
      // reading is that card's context, not the tag's base, so it is not kept.
      : `INSERT INTO tags (id, sport, label, rarity, seenAt) VALUES (?,?,?,NULL,?)
         ON CONFLICT(id, sport) DO UPDATE SET label=excluded.label,
           seenAt=excluded.seenAt`);
    if (url.searchParams.get('clear') === '1') {
      try { await db.prepare('UPDATE tags SET rarity=NULL WHERE sport=?').bind(sport).run(); }
      catch (e) {}
      return json({ sport, clearedTagRarities: true });
    }
    let cursor = new Date().toISOString(), found = 0, pages = 0;
    for (let i = 0; i < 12; i++) {
      const u = `https://web.realapp.com/cardmarketplacelistings`
        + `?beforeEndsAt=${encodeURIComponent(cursor)}&cohort=all&listingType=card`
        + `&offset=0&prestige=all&rarity=${encodeURIComponent(rarityFilter)}`
        + `&season=${season}&sport=${sport}`;
      let rows;
      try { rows = rowsOf(await rsGet(u, auth)); } catch (e) { break; }
      pages++;
      if (!rows.length) break;
      const batch = [], seen = new Set();
      for (const r of rows) {
        for (const t of ((r.card && r.card.traits) || [])) {
          if (!t || t.id == null || seen.has(t.id)) continue;
          seen.add(t.id);
          batch.push(baseSweep()
            ? stmt.bind(Number(t.id), sport, t.label || null,
                        t.rarity == null ? null : Number(t.rarity), Date.now())
            : stmt.bind(Number(t.id), sport, t.label || null, Date.now()));
        }
      }
      if (batch.length) { try { await db.batch(batch); found += batch.length; } catch (e) {} }
      const last = rows[rows.length - 1];
      if (!last || !last.endsAt || last.endsAt === cursor) break;
      cursor = last.endsAt;
      await sleep(40);
    }
    let held = 0, byRarity = {};
    try {
      const h = await db.prepare('SELECT rarity, COUNT(*) AS n FROM tags WHERE sport=? GROUP BY rarity')
        .bind(sport).all();
      for (const row of (h.results || [])) { byRarity[row.rarity] = Number(row.n); held += Number(row.n); }
    } catch (e) {}
    const haveK = new Set();
    try {
      const t2 = await db.prepare('SELECT label FROM tags WHERE sport=?').bind(sport).all();
      for (const r of (t2.results || [])) haveK.add(tagKey(r.label));
    } catch (e) {}
    return json({ sport, season, rarity: rarityFilter, pages, written: found,
      tagsHeld: held, byRarity,
      missingRuleTags: Object.keys(rulesFor(sport)).filter(k => !haveK.has(k)) });
  }

  // Find a game id from the log by day, to check one game by hand.
  /* Find a play by day and name and spell out its tags, naming any whose id
     the tag table does not know. This is how a tag that never shows up in a
     listing gets identified: from one play that carries it. */
  if (url.searchParams.get('plays') === 'findplay') {
    const db = env.RATEBOARD_DB;
    if (!db) return json({ error: 'no database binding' }, 503);
    await playsReady(db);
    const day = String(url.searchParams.get('day') || '').slice(0, 10);
    const gid = String(url.searchParams.get('gameId') || '').replace(/[^0-9]/g, '');
    const q = String(url.searchParams.get('q') || '').slice(0, 60);
    // Back seasons were collected before the day column was filled, so a game
    // id has to work as well as a date.
    if (!gid && !/^\d{4}-\d{2}-\d{2}$/.test(day))
      return json({ error: 'need a gameId, or a day as YYYY-MM-DD' }, 400);
    const known = new Map();
    try {
      const t = await db.prepare('SELECT id, label, rarity FROM tags WHERE sport=?').bind(sport).all();
      for (const r of (t.results || [])) known.set(Number(r.id), { label: r.label, rarity: r.rarity });
    } catch (e) {}
    let rows = [];
    try {
      const r = await db.prepare(
        `SELECT id, day, clock, period, label, type, subType, cat, value, rarity,
                player, player2, tags
           FROM plays WHERE sport=?1 AND tags IS NOT NULL
            AND (?5 = '' OR gameId = CAST(?5 AS INTEGER))
            AND (?5 <> '' OR day = ?2)
            AND (?3 = '' OR COALESCE(player,'') LIKE ?4 OR COALESCE(player2,'') LIKE ?4)
          ORDER BY id LIMIT 300`).bind(sport, day, q, `%${q}%`, gid).all();
      rows = r.results || [];
    } catch (e) { return json({ error: 'could not read plays', detail: String((e && e.message) || e) }, 503); }
    const unknownIds = new Set();
    const out = rows.map(r => {
      const tags = String(r.tags || '').split(',').filter(Boolean).map(x => {
        const id = Number(x), k = known.get(id);
        if (!k) unknownIds.add(id);
        return { id, label: k ? k.label : null, rarity: k ? k.rarity : null };
      });
      return { id: r.id, period: r.period, clock: r.clock, label: r.label,
               type: r.type, subType: r.subType, cat: r.cat, value: r.value,
               scored: r.rarity, player: r.player, player2: r.player2, tags };
    });
    return json({ sport, season, day, gameId: gid || null, q, plays: out, unknownTagIds: [...unknownIds] });
  }

  if (url.searchParams.get('plays') === 'findgame') {
    const db = env.RATEBOARD_DB;
    if (!db) return json({ error: 'no database binding' }, 503);
    const day = String(url.searchParams.get('day') || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return json({ error: 'day must be YYYY-MM-DD' }, 400);
    try {
      const r = await db.prepare(
        `SELECT DISTINCT gameId, day, team, opponent, seasonType FROM gamelog
          WHERE sport=? AND season=? AND day=? ORDER BY gameId`)
        .bind(sport, Number(season), day).all();
      return json({ day, games: r.results || [] });
    } catch (e) { return json({ error: 'could not read the game log' }, 503); }
  }

  // Collect named games directly, regardless of whether the game log has
  // caught up to them. The sweep walks the log; this does not.
  if (url.searchParams.get('plays') === 'game') {
    const db = env.RATEBOARD_DB;
    if (!db) return json({ error: 'no database binding' }, 503);
    await playsReady(db);
    const ids = String(url.searchParams.get('gameId') || '')
      .split(',').map(x => x.trim()).filter(x => /^\d+$/.test(x)).slice(0, 12);
    if (!ids.length) return json({ error: 'gameId required' }, 400);
    // Clearing first means a game collected from the old, thinner endpoint is
    // replaced rather than merged with its own stale rows.
    if (url.searchParams.get('fresh') === '1') {
      for (const g of ids) {
        try { await db.prepare('DELETE FROM plays WHERE sport=? AND gameId=?')
          .bind(sport, Number(g)).run(); } catch (e) {}
      }
    }
    const stmt = playStmt(db);
    const out = [];
    for (const id of ids) {
      let d;
      try {
        d = await rsGet(`https://web.realapp.com/games/${id}/sport/${sport}`
          + `/feed?version=2&view=all&viewFrame=default`, auth);
      } catch (e) { out.push({ gameId: id, error: 'could not fetch' }); continue; }
      const rows = Array.isArray(d && d.plays) ? d.plays : rowsOf(d);
      const batch = [];
      for (const r of rows) {
        if (!r || !r.id || !Number.isFinite(Number(r.id))) continue;
        if (!keepsPlays(sport, r.seasonType)) continue;
        batch.push(playBind(stmt, r, sport, season));
      }
      let wrote = 0;
      for (let i = 0; i < batch.length; i += 100) {
        const part = batch.slice(i, i + 100);
        try { await db.batch(part); wrote += part.length; } catch (e) {}
      }
      out.push({ gameId: id, returned: rows.length, stored: wrote });
      await sleep(40);
    }
    return json({ sport, season, games: out });
  }

  // Only the seasons that actually hold plays, so the tab can offer those
  // and nothing else.
  /* The whole tag dictionary, with what each tag is worth on each kind of
     play. A tag's rarity is not one number: the harvested base is what the
     marketplace showed, and the rules override it per family. Both are
     reported so a wrong-looking card can be traced to whichever one set it. */
  if (url.searchParams.get('plays') === 'tagboard') {
    const db = env.RATEBOARD_DB;
    if (!db) return json({ error: 'no database binding' }, 503);
    await playsReady(db);
    const FAMS = ['rush', 'pass', 'td', 'fg', 'def'];
    try {
      const r = await db.prepare(
        `SELECT id, sport, label, rarity, altRarity FROM tags ORDER BY sport, label`).all();
      const rows = (r.results || []).map(t => {
        const key = tagKey(t.label);
        const rule = rulesFor(t.sport)[key] || null;
        const base = t.rarity == null ? null : Number(t.rarity);
        const out = {
          id: t.id, sport: t.sport, label: t.label, key,
          base, ruled: !!rule,
          // Every reading ever seen for this tag, which is how a contextual
          // tag gives itself away.
          seen: t.altRarity ? [...new Set(String(t.altRarity).split(',')
            .map(x => Number(x)).filter(Boolean))].sort() : []
        };
        let top = base || 0;
        for (const f of FAMS) {
          const v = rule ? (rule[f] != null ? rule[f] : rule['*']) : null;
          out[f] = v != null ? v : base;
          if (out[f] != null) top = Math.max(top, out[f]);
        }
        out.top = top || null;
        return out;
      });
      const bySport = {};
      for (const x of rows) bySport[x.sport] = (bySport[x.sport] || 0) + 1;
      // Rules naming a tag whose id has never been seen cannot fire at all.
      const have = new Set(rows.map(x => x.key));
      return json({ rows, bySport, families: FAMS,
        unresolvedRules: [...new Set(Object.keys(RULES_NFL)
          .concat(Object.keys(RULES_NCAAF), Object.keys(RULES_MLB)))]
          .filter(k => !have.has(k)) });
    } catch (e) {
      return json({ error: 'could not read the tags', detail: String((e && e.message) || e) }, 503);
    }
  }

  /* Walk players out of the game log and keep every box score they have for
     the season. One request per player covers their whole season, so this is
     far cheaper per row than the play sweep. */
  if (url.searchParams.get('perf') === 'collect') {
    const db = env.RATEBOARD_DB;
    if (!db) return json({ error: 'no database binding' }, 503);
    await perfReady(db);
    const key = `${PERF_CURSOR}:${sport}:${season}`;
    let after = 0;
    try { after = Number(await env.RATEBOARD_KV.get(key)) || 0; } catch (e) {}
    if (url.searchParams.get('reset') === '1') {
      after = 0;
      try { await env.RATEBOARD_KV.put(key, '0'); } catch (e) {}
    }
    let ids = [];
    try {
      const r = await db.prepare(
        `SELECT DISTINCT playerId AS n FROM gamelog WHERE sport=? AND season=? AND playerId > ?
           ORDER BY playerId LIMIT ?`).bind(sport, Number(season), after, PERF_PER_TICK).all();
      ids = (r.results || []).map(x => Number(x.n)).filter(Boolean);
    } catch (e) { return json({ error: 'could not read the game log' }, 503); }
    if (!ids.length) {
      try { await env.RATEBOARD_KV.put(key, '0'); } catch (e) {}
      // Lapped: every player in the game log has been asked for this season.
      // The flag retires it from the cron so the next season gets the ticks.
      try { await env.RATEBOARD_KV.put(perfDoneKey(sport, season), '1'); } catch (e) {}
      return json({ sport, season, lap: true, stored: 0 });
    }
    const stmt = db.prepare(
      `INSERT INTO performances (id, sport, season, playerId, player, gameId, day,
         seasonType, teamId, oppTeamId, team, opponent, value, rarity, tags, stats,
         played, started, seenAt)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET value=excluded.value, tags=excluded.tags,
         stats=excluded.stats, day=excluded.day, seenAt=excluded.seenAt`);
    let stored = 0, asked = 0, withTags = 0;
    for (const id of ids) {
      let d;
      try {
        d = await rsGet(`https://web.realapp.com/players/${id}/sport/${sport}`
          + `/seasonfeed?limit=80&season=${season}&view=recent&viewFrame=default`, auth);
      } catch (e) { continue; }
      asked++;
      const batch = [];
      for (const r of ((d && d.playerBoxScores) || [])) {
        if (!r || r.id == null) continue;
        if (!keepsPlays(sport, r.seasonType)) continue;
        const tg = [].concat(r.performanceTags || [], r.performanceTagsManual || [])
          .map(x => (x && x.id != null) ? Number(x.id) : Number(x))
          .filter(n => Number.isFinite(n));
        if (tg.length) withTags++;
        batch.push(stmt.bind(
          Number(r.id), sport, Number(r.season || season),
          r.playerId == null ? null : Number(r.playerId), playName(r.player),
          r.gameId == null ? null : Number(r.gameId), r.day || null, r.seasonType || null,
          r.teamId == null ? null : Number(r.teamId),
          r.opponentTeamId == null ? null : Number(r.opponentTeamId),
          (r.team && r.team.key) || null, (r.awayTeam && r.awayTeam.key) || null,
          r.value == null ? null : Math.abs(Number(r.value)),
          null,
          tg.length ? tg.join(',') : null,
          r.topStats ? JSON.stringify(r.topStats).slice(0, 900) : null,
          r.played ? 1 : 0, r.started ? 1 : 0, Date.now()));
      }
      for (let i = 0; i < batch.length; i += 200) {
        try { await db.batch(batch.slice(i, i + 200)); stored += batch.slice(i, i + 200).length; }
        catch (e) {}
      }
      await sleep(30);
    }
    after = ids[ids.length - 1];
    try { await env.RATEBOARD_KV.put(key, String(after)); } catch (e) {}
    let held = 0;
    try {
      const h = await db.prepare('SELECT COUNT(*) AS n FROM performances WHERE sport=? AND season=?')
        .bind(sport, Number(season)).first();
      held = Number((h && h.n) || 0);
    } catch (e) {}
    return json({ sport, season, asked, stored, rowsWithTags: withTags, held,
                  nextAfter: after, lap: false });
  }

  // What is held, so the fill can be watched without a page for it.
  if (url.searchParams.get('perf') === 'seasons') {
    const db = env.RATEBOARD_DB;
    if (!db) return json({ error: 'no database binding' }, 503);
    await perfReady(db);
    try {
      const r = await db.prepare(
        `SELECT sport, season, COUNT(*) AS rows_, COUNT(DISTINCT playerId) AS players,
                COUNT(DISTINCT gameId) AS games,
                SUM(CASE WHEN tags IS NOT NULL THEN 1 ELSE 0 END) AS withTags
           FROM performances GROUP BY sport, season ORDER BY sport, season DESC`).all();
      return json({ seasons: r.results || [] });
    } catch (e) { return json({ error: 'could not read performances' }, 503); }
  }

  /* What the cron is actually doing, for the admin bar on the board. Two
     grouped reads rather than one per season, so a glance at it costs the
     database about as much as loading one season of the table. */
  /* Games the log knows about that have no plays. The walk is a one-way
     cursor, so a game that lands in the log after the cursor has gone past
     its id is never picked up until the whole season is walked again - and a
     finished season never is. This finds them, and fill=1 collects them. */
  /* ---- the play table's key -------------------------------------------
     plays was keyed on the play id alone, but Real reuses id ranges across
     sports: a college play can carry the same id as a pro one. The insert
     then took the ON CONFLICT path and quietly rewrote the other sport's row
     instead of adding this one, and reported it as stored. This rebuilds the
     table keyed on (id, sport).

     It is done in steps, and nothing is thrown away: the rows are copied into
     a new table, the counts are checked season by season, and only then is
     the old table renamed aside - renamed, not dropped, so it is still there
     if anything looks wrong afterwards.
       ?plays=migrate&step=init    build the new table and its indexes
       ?plays=migrate&step=copy    copy a slice; repeat until done
       ?plays=migrate&step=verify  compare both tables, season by season
       ?plays=migrate&step=swap    rename old aside, new into place
       ?plays=migrate&step=status  where it is up to
     -------------------------------------------------------------------- */
  if (url.searchParams.get('plays') === 'migrate') {
    const db = env.RATEBOARD_DB;
    if (!db) return json({ error: 'no database binding' }, 503);
    const step = String(url.searchParams.get('step') || 'status');
    const COLS = `id, sport, season, seasonType, gameId, day, label, type, subType,
                  cat, value, playerId, player, player2Id, player2, teamId, oppTeamId,
                  period, clock, down, togo, yards, epa, tags, seenAt`;
    const CURSOR = 'plays_migrate_v2';
    const V2_DDL = `CREATE TABLE IF NOT EXISTS plays_v2 (
      id INTEGER NOT NULL, sport TEXT NOT NULL, season INTEGER NOT NULL,
      seasonType TEXT, gameId INTEGER, day TEXT,
      label TEXT, type TEXT, subType TEXT, cat INTEGER, value REAL,
      playerId INTEGER, player TEXT, player2Id INTEGER, player2 TEXT,
      teamId INTEGER, oppTeamId INTEGER,
      period INTEGER, clock TEXT, down INTEGER, togo INTEGER, yards INTEGER,
      epa REAL, tags TEXT, rarity INTEGER, seenAt INTEGER NOT NULL,
      PRIMARY KEY (id, sport))`;

    if (step === 'init') {
      try { await db.prepare(V2_DDL).run(); } catch (e) {
        return json({ error: 'could not create the new table', detail: String((e && e.message) || e) }, 503);
      }
      for (const ix of [
        'CREATE INDEX IF NOT EXISTS p2_sp ON plays_v2 (sport, season, playerId)',
        'CREATE INDEX IF NOT EXISTS p2_game ON plays_v2 (sport, season, gameId)',
        'CREATE INDEX IF NOT EXISTS p2_cat ON plays_v2 (sport, season, cat)',
        'CREATE INDEX IF NOT EXISTS p2_p2 ON plays_v2 (sport, season, player2Id)',
        'CREATE INDEX IF NOT EXISTS p2_score ON plays_v2 (sport, season, rarity)'
      ]) { try { await db.prepare(ix).run(); } catch (e) {} }
      try { await env.RATEBOARD_KV.put(CURSOR, '0'); } catch (e) {}
      return json({ step, ready: true });
    }

    if (step === 'copy') {
      let after = 0;
      try { after = Number(await env.RATEBOARD_KV.get(CURSOR)) || 0; } catch (e) {}
      const n = Math.max(1000, Math.min(60000,
        parseInt(url.searchParams.get('n') || '40000', 10) || 40000));
      // The slice is chosen by id and copied inside the database - no row
      // travels through here, so a big slice costs little.
      let top = null;
      try {
        const r = await db.prepare(
          `SELECT MAX(id) AS hi FROM (SELECT id FROM plays WHERE id > ? ORDER BY id LIMIT ?)`)
          .bind(after, n).first();
        top = r && r.hi == null ? null : Number(r.hi);
      } catch (e) {
        return json({ error: 'could not read the next slice', detail: String((e && e.message) || e) }, 503);
      }
      if (top == null) return json({ step, done: true, after });
      try {
        await db.prepare(
          `INSERT OR IGNORE INTO plays_v2 (${COLS}, rarity)
             SELECT ${COLS}, rarity FROM plays WHERE id > ? AND id <= ?`)
          .bind(after, top).run();
      } catch (e) {
        return json({ error: 'copy failed', after, top, detail: String((e && e.message) || e) }, 503);
      }
      try { await env.RATEBOARD_KV.put(CURSOR, String(top)); } catch (e) {}
      let held = 0;
      try {
        const h = await db.prepare('SELECT COUNT(*) AS n FROM plays_v2').first();
        held = Number((h && h.n) || 0);
      } catch (e) {}
      return json({ step, from: after, to: top, heldInNew: held, done: false });
    }

    if (step === 'verify' || step === 'status') {
      const out = { step };
      try {
        const a = await db.prepare(
          'SELECT sport, season, COUNT(*) AS n FROM plays GROUP BY sport, season').all();
        out.old = a.results || [];
      } catch (e) { out.old = 'unreadable'; }
      try {
        const b = await db.prepare(
          'SELECT sport, season, COUNT(*) AS n FROM plays_v2 GROUP BY sport, season').all();
        out.new = b.results || [];
      } catch (e) { out.new = 'no new table yet'; }
      try { out.cursor = await env.RATEBOARD_KV.get(CURSOR); } catch (e) {}
      if (Array.isArray(out.old) && Array.isArray(out.new)) {
        const m = new Map(out.new.map(x => [`${x.sport}|${x.season}`, Number(x.n)]));
        out.shortfall = out.old.map(x => ({ sport: x.sport, season: x.season,
          old: Number(x.n), new: m.get(`${x.sport}|${x.season}`) || 0,
          missing: Number(x.n) - (m.get(`${x.sport}|${x.season}`) || 0) }))
          .filter(x => x.missing !== 0);
        out.safeToSwap = out.shortfall.length === 0
          && out.new.reduce((t, x) => t + Number(x.n), 0) > 0;
      }
      return json(out);
    }

    if (step === 'swap') {
      // Refuse unless every season is accounted for. The old table is kept.
      let oldRows = [], newRows = [];
      try {
        oldRows = ((await db.prepare(
          'SELECT sport, season, COUNT(*) AS n FROM plays GROUP BY sport, season').all()).results) || [];
        newRows = ((await db.prepare(
          'SELECT sport, season, COUNT(*) AS n FROM plays_v2 GROUP BY sport, season').all()).results) || [];
      } catch (e) { return json({ error: 'could not compare the tables' }, 503); }
      const m = new Map(newRows.map(x => [`${x.sport}|${x.season}`, Number(x.n)]));
      const short = oldRows.filter(x => (m.get(`${x.sport}|${x.season}`) || 0) < Number(x.n));
      if (short.length) {
        return json({ error: 'not every row has been copied yet, so nothing was changed',
                      shortfall: short }, 409);
      }
      try {
        await db.prepare('ALTER TABLE plays RENAME TO plays_pre_v2').run();
        await db.prepare('ALTER TABLE plays_v2 RENAME TO plays').run();
      } catch (e) {
        return json({ error: 'rename failed', detail: String((e && e.message) || e) }, 503);
      }
      return json({ step, swapped: true,
                    note: 'the old table is kept as plays_pre_v2' });
    }
    return json({ error: 'step must be init, copy, verify, status or swap' }, 400);
  }

  if (url.searchParams.get('plays') === 'gaps') {
    const db = env.RATEBOARD_DB;
    if (!db) return json({ error: 'no database binding' }, 503);
    await playsReady(db);
    let miss = [];
    try {
      const r = await db.prepare(
        `SELECT DISTINCT g.gameId AS id FROM gamelog g
          WHERE g.sport=?1 AND g.season=?2
            AND g.seasonType IN (${seasonTypeSql(sport)})
            AND NOT EXISTS (SELECT 1 FROM plays p
                             WHERE p.sport=?1 AND p.season=?2 AND p.gameId=g.gameId)
          ORDER BY g.gameId LIMIT 400`).bind(sport, Number(season)).all();
      miss = (r.results || []).map(x => Number(x.id)).filter(Boolean);
    } catch (e) {
      return json({ error: 'could not look for gaps', detail: String((e && e.message) || e) }, 503);
    }
    if (url.searchParams.get('fill') !== '1') {
      return json({ sport, season, missing: miss.length, gameIds: miss.slice(0, 60) });
    }
    const take = miss.slice(0, Math.max(1, Math.min(40,
      parseInt(url.searchParams.get('n') || '20', 10) || 20)));
    const stmt = playStmt(db);
    let stored = 0, asked = 0;
    for (const id of take) {
      let d;
      try {
        d = await rsGet(`https://web.realapp.com/games/${id}/sport/${sport}`
          + `/feed?version=2&view=all&viewFrame=default`, auth);
      } catch (e) { continue; }
      asked++;
      const rows = Array.isArray(d && d.plays) ? d.plays : rowsOf(d);
      const batch = [];
      for (const r of rows) {
        if (!r || !r.id || !Number.isFinite(Number(r.id))) continue;
        if (!keepsPlays(sport, r.seasonType)) continue;
        batch.push(playBind(stmt, r, sport, season));
      }
      /* Chunked, and the count is what actually landed. An unchunked batch
         meant a single row D1 would not take threw the whole game away, and
         the empty catch then reported it as stored. */
      for (let i = 0; i < batch.length; i += 100) {
        const part = batch.slice(i, i + 100);
        try { await db.batch(part); stored += part.length; } catch (e) {}
      }
      await sleep(40);
    }
    return json({ sport, season, stillMissing: miss.length - asked, asked, stored });
  }

  /* ----- Hypothetical earnings -------------------------------------------
     NBA and NHL are changing what a game rating pays. The game log already
     holds every player's rating and the rax it actually earned, so the new
     rules can be run over the same games and the two set side by side.

     The old curves, read off the log rather than assumed (see ?earn=curve):
       NBA  rax = round(rating)          - a 5 paid 5, a 10 paid 10
       NHL  rax = round(rating * 1.2)    - a 5 paid 6, a 10 paid 12
     Both double in the playoffs, and the all-star games pay double too.
     Pre-season and off-season rows pay nothing at all and are left out.

     The new curves are tables on the rounded rating. Above a 10 - which does
     happen, a handful of times a season - the top step carries on at four a
     point rather than falling off a cliff. */
  const NEW_CURVE = {
    nba: [0, 1, 2, 3, 4, 6, 9, 12, 16, 20, 24],
    nhl: [0, 1, 2, 4, 5, 7, 9, 12, 16, 19, 23]
  };
  const EARN_SPORTS = ['nba', 'nhl'];
  // Season types that pay. The last two are in the log but earn nothing.
  const EARN_TYPES = ['regularseason', 'postseason', 'allstar'];
  const curveSql = sp => {
    const c = NEW_CURVE[sp];
    const r = 'CAST(ROUND(rating) AS INTEGER)';
    let out = `CASE WHEN ${r} <= 0 THEN 0 `;
    for (let i = 1; i < c.length; i++) out += `WHEN ${r} = ${i} THEN ${c[i]} `;
    return out + `ELSE ${c[c.length - 1]} + (${r} - 10) * 4 END`;
  };
  const hypoSql = sp =>
    `(CASE WHEN seasonType IN ('postseason','allstar') THEN 2 ELSE 1 END) * (${curveSql(sp)})`;

  /* One pass of the box-score re-read. The players come straight from the
     log, so there is nothing to discover - every player-season is simply
     asked for again and written back with its own stat line attached. */
  /* Per-game averages of a sport's own box line, for a named set of players.
     The stat blob is text, so the averaging happens here rather than in SQL -
     a few hundred rows, which is nothing. This is what turns "what does he
     average" into one call instead of one call per player. */
  if (url.searchParams.get('statavg') === '1') {
    const db = env.RATEBOARD_DB;
    if (!db) return json({ error: 'no database binding' }, 503);
    const sp = String(url.searchParams.get('sport') || 'nfl').toLowerCase();
    const se = Number(url.searchParams.get('season')) || 2026;
    const ids = String(url.searchParams.get('players') || '')
      .split(',').map(x => Number(String(x).trim())).filter(Number.isFinite).slice(0, 300);
    if (!ids.length) return json({ error: 'players needed, comma separated ids' }, 400);
    const types = url.searchParams.get('all') === '1'
      ? seasonTypeSql(sp) : `'regularseason'`;
    const out = {};
    try {
      // Ids are numbers we coerced ourselves; D1 caps bound values at 100.
      for (let i = 0; i < ids.length; i += 200) {
        const list = ids.slice(i, i + 200).join(',');
        const r = await db.prepare(
          `SELECT playerId, player, team, position, stats, rax, rating
             FROM gamelog
            WHERE sport = ?1 AND season = ?2 AND seasonType IN (${types})
              AND playerId IN (${list})`).bind(sp, se).all();
        for (const row of (r.results || [])) {
          const id = Number(row.playerId);
          const o = out[id] || (out[id] = { playerId: id, player: row.player, team: row.team,
                                            position: row.position, games: 0, rax: 0,
                                            rating: 0, sum: {} });
          o.games++;
          o.rax += Number(row.rax) || 0;
          o.rating += Number(row.rating) || 0;
          if (row.team) o.team = row.team;
          if (row.position) o.position = row.position;
          let st = null;
          try { st = row.stats ? JSON.parse(row.stats) : null; } catch (e) {}
          if (!st) continue;
          for (const k in st) {
            const v = st[k];
            // A clock or a made/attempted pair is not something to average.
            const n = typeof v === 'number' ? v
              : (/^\d+(\.\d+)?$/.test(String(v)) ? Number(v) : null);
            if (n == null) continue;
            o.sum[k] = (o.sum[k] || 0) + n;
          }
        }
      }
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 503);
    }
    const rows = Object.values(out).map(o => {
      const avg = {};
      for (const k in o.sum) avg[k] = Math.round((o.sum[k] / o.games) * 1000) / 1000;
      return { playerId: o.playerId, player: o.player, team: o.team, position: o.position,
               games: o.games, raxPerGame: Math.round((o.rax / o.games) * 100) / 100,
               ratingPerGame: Math.round((o.rating / o.games) * 100) / 100,
               total: o.sum, perGame: avg };
    }).sort((a, b) => b.raxPerGame - a.raxPerGame);
    return json({ sport: sp, season: se, asked: ids.length, found: rows.length, rows });
  }

  if (url.searchParams.get('restat') === 'collect') {
    const db = env.RATEBOARD_DB;
    if (!db) return json({ error: 'no database binding' }, 503);
    const sp = String(url.searchParams.get('sport') || '').toLowerCase();
    const se = Number(url.searchParams.get('season'));
    if (!RESTAT_QUEUE.some(x => x.sport === sp && x.season === se)) {
      return json({ error: 'not a season this re-reads' }, 400);
    }
    await migrateGamelog(db);
    const KEY = restatKey(sp, se);
    let st = null;
    try { st = JSON.parse((await env.RATEBOARD_KV.get(KEY)) || 'null'); } catch (e) {}
    if (!st || !Array.isArray(st.players)) st = { players: [], pc: 0 };
    if (url.searchParams.get('again') === '1') {
      st.pc = 0;
      try { await env.RATEBOARD_KV.delete(restatDoneKey(sp, se)); } catch (e) {}
    }

    if (!st.players.length) {
      try {
        const r = await db.prepare(
          `SELECT DISTINCT playerId FROM gamelog WHERE sport = ?1 AND season = ?2`)
          .bind(sp, se).all();
        st.players = (r.results || []).map(x => Number(x.playerId)).filter(Number.isFinite);
      } catch (e) {
        return json({ error: 'could not read the player list', detail: String((e && e.message) || e) }, 503);
      }
      if (!st.players.length) {
        try { await env.RATEBOARD_KV.put(restatDoneKey(sp, se), '1'); } catch (e) {}
        return json({ sport: sp, season: se, finished: true, players: 0,
                      note: 'nothing collected for this season' });
      }
      try { await env.RATEBOARD_KV.put(KEY, JSON.stringify(st)); } catch (e) {}
      return json({ sport: sp, season: se, listed: st.players.length });
    }

    if (st.pc >= st.players.length) {
      try { await env.RATEBOARD_KV.put(restatDoneKey(sp, se), '1'); } catch (e) {}
      let withStats = 0;
      try {
        const r = await db.prepare(
          `SELECT COUNT(*) AS n FROM gamelog
            WHERE sport = ?1 AND season = ?2 AND stats IS NOT NULL`).bind(sp, se).first();
        withStats = Number((r && r.n) || 0);
      } catch (e) {}
      return json({ sport: sp, season: se, finished: true,
                    players: st.players.length, rowsWithStats: withStats });
    }

    const feedUrl = id =>
      `https://web.realapp.com/players/${id}/sport/${sp}/seasonfeed?limit=200&season=${se}&view=recent&viewFrame=default`;
    const slice = st.players.slice(st.pc, st.pc + RESTAT_PER_TICK);
    const place = '(' + GAMELOG_FEED_COLS.map(() => '?').join(',') + ')';
    const keyCols = ['sport', 'season', 'playerId', 'gameId'];
    const sets = GAMELOG_FEED_COLS.filter(c => !keyCols.includes(c))
                                  .map(c => `${c}=excluded.${c}`).join(', ');
    const sql = `INSERT INTO gamelog (${GAMELOG_FEED_COLS.join(',')}) VALUES ${place} `
              + `ON CONFLICT(${keyCols.join(',')}) DO UPDATE SET ${sets}`;
    let asked = 0, wrote = 0, withLine = 0;
    for (let i = 0; i < slice.length; i += FETCH_AT_ONCE) {
      const group = slice.slice(i, i + FETCH_AT_ONCE);
      const got = await Promise.all(group.map(id =>
        rsGet(feedUrl(id), auth).then(d => d, () => null)));
      const rows = [];
      for (const d of got) {
        if (!d) continue;
        asked++;
        for (const b of ((d && d.playerBoxScores) || [])) {
          if (!b || b.gameId == null) continue;
          const row = gamelogRow(sp, se, b);
          if (row.stats) withLine++;
          rows.push(row);
        }
      }
      for (let k = 0; k < rows.length; k += 40) {
        const batch = rows.slice(k, k + 40).map(r =>
          db.prepare(sql).bind(...GAMELOG_FEED_COLS.map(c => r[c] === undefined ? null : r[c])));
        try { await db.batch(batch); wrote += batch.length; } catch (e) {}
      }
      await sleep(15);
    }
    st.pc += slice.length;
    try { await env.RATEBOARD_KV.put(KEY, JSON.stringify(st)); } catch (e) {}
    return json({ sport: sp, season: se, asked, wrote, withLine,
                  done: st.pc, players: st.players.length });
  }

  /* How far the box-score re-read has got. */
  if (url.searchParams.get('restat') === 'progress') {
    const db = env.RATEBOARD_DB;
    if (!db) return json({ error: 'no database binding' }, 503);
    const out = [];
    for (const q of RESTAT_QUEUE) {
      let st = null, fin = null;
      try { st = JSON.parse((await env.RATEBOARD_KV.get(restatKey(q.sport, q.season))) || 'null'); } catch (e) {}
      try { fin = await env.RATEBOARD_KV.get(restatDoneKey(q.sport, q.season)); } catch (e) {}
      out.push({ sport: q.sport, season: q.season, finished: !!fin,
                 players: st ? st.players.length : 0, done: st ? st.pc : 0 });
    }
    let rows = 0, withStats = 0;
    try {
      const r = await db.prepare(
        `SELECT COUNT(*) AS n, SUM(CASE WHEN stats IS NOT NULL THEN 1 ELSE 0 END) AS s
           FROM gamelog WHERE sport = 'nhl'`).first();
      rows = Number((r && r.n) || 0); withStats = Number((r && r.s) || 0);
    } catch (e) {}
    return json({ at: new Date().toISOString(), nhlRows: rows, nhlWithStats: withStats,
                  seasons: out });
  }

  /* One pass of the historical crawl. Players first - their season feeds are
     where the ratings actually come from - and only when every known player
     has been asked does it spend a tick on game feeds, which exist solely to
     turn up players the seed missed. */
  if (url.searchParams.get('hist') === 'collect') {
    const db = env.RATEBOARD_DB;
    if (!db) return json({ error: 'no database binding' }, 503);
    const sp = String(url.searchParams.get('sport') || HIST_SPORT).toLowerCase();
    const se = Number(url.searchParams.get('season'));
    if (!histHolds(sp, se)) {
      return json({ error: 'not a historical season this collects' }, 400);
    }
    await migrateGamelog(db);
    const KEY = histKey(sp, se);
    let st = null;
    try { st = JSON.parse((await env.RATEBOARD_KV.get(KEY)) || 'null'); } catch (e) {}
    /* Walk a finished season again, keeping the players already found and
       sending both passes back to the start. For when the crawl itself was
       at fault rather than the season. */
    if (url.searchParams.get('recrawl') === '1' && st) {
      st.pc = 0; st.gc = 0;
      try { await env.RATEBOARD_KV.delete(histDoneKey(sp, se)); } catch (e) {}
      try { await env.RATEBOARD_KV.put(KEY, JSON.stringify(st)); } catch (e) {}
      return json({ sport: sp, season: se, recrawl: true,
                    players: st.players.length, games: st.games.length });
    }
    if (!st || !Array.isArray(st.players)) st = { players: [], pc: 0, games: [], gc: 0 };
    const save = async () => {
      try { await env.RATEBOARD_KV.put(KEY, JSON.stringify(st)); } catch (e) {}
    };

    /* The seed: everyone the log already knows from the two seasons after
       this one. Two rather than one so a player who missed a whole year with
       an injury is not dropped from the chain. */
    if (!st.players.length) {
      try {
        const r = await db.prepare(
          `SELECT DISTINCT playerId FROM gamelog
            WHERE sport = ?1 AND season IN (?2, ?3, ?4)`)
          .bind(sp, se, se + 1, se + 2).all();
        st.players = (r.results || []).map(x => Number(x.playerId)).filter(Number.isFinite);
      } catch (e) {
        return json({ error: 'could not read the seed', detail: String((e && e.message) || e) }, 503);
      }
      if (!st.players.length) {
        return json({ sport: sp, season: se, seeded: 0,
                      note: 'nothing to seed from - collect the season after this one first' });
      }
      await save();
      return json({ sport: sp, season: se, seeded: st.players.length });
    }

    const feedUrl = id =>
      `https://web.realapp.com/players/${id}/sport/${sp}/seasonfeed?limit=200&season=${se}&view=recent&viewFrame=default`;
    const gameUrl = id =>
      `https://web.realapp.com/games/${id}/sport/${sp}/feed?version=2&view=all&viewFrame=default`;

    const knownGames = new Set(st.games.map(Number));
    const knownPlayers = new Set(st.players.map(Number));

    // ---- players: the pass that actually writes rows
    if (st.pc < st.players.length) {
      const slice = st.players.slice(st.pc, st.pc + HIST_PLAYERS_PER_TICK);
      const place = '(' + GAMELOG_FEED_COLS.map(() => '?').join(',') + ')';
      const keyCols = ['sport', 'season', 'playerId', 'gameId'];
      const sets = GAMELOG_FEED_COLS.filter(c => !keyCols.includes(c))
                                    .map(c => `${c}=excluded.${c}`).join(', ');
      const sql = `INSERT INTO gamelog (${GAMELOG_FEED_COLS.join(',')}) VALUES ${place} `
                + `ON CONFLICT(${keyCols.join(',')}) DO UPDATE SET ${sets}`;
      let asked = 0, wrote = 0, played = 0;
      for (let i = 0; i < slice.length; i += FETCH_AT_ONCE) {
        const group = slice.slice(i, i + FETCH_AT_ONCE);
        const got = await Promise.all(group.map(id =>
          rsGet(feedUrl(id), auth).then(d => d, () => null)));
        const rows = [];
        for (const d of got) {
          if (!d) continue;
          asked++;
          const bs = (d && d.playerBoxScores) || [];
          if (bs.length) played++;
          for (const b of bs) {
            if (!b || b.gameId == null) continue;
            if (!knownGames.has(Number(b.gameId))) {
              knownGames.add(Number(b.gameId));
              st.games.push(Number(b.gameId));
            }
            rows.push(gamelogRow(sp, se, b));
          }
        }
        for (let k = 0; k < rows.length; k += 40) {
          const batch = rows.slice(k, k + 40).map(r =>
            db.prepare(sql).bind(...GAMELOG_FEED_COLS.map(c => r[c] === undefined ? null : r[c])));
          try { await db.batch(batch); wrote += batch.length; } catch (e) {}
        }
        await sleep(15);
      }
      st.pc += slice.length;
      await save();
      return json({ sport: sp, season: se, step: 'players', asked, played, wrote,
                    playersDone: st.pc, players: st.players.length,
                    games: st.games.length });
    }

    // ---- games: only to turn up players the seed never had
    if (st.gc < st.games.length) {
      const slice = st.games.slice(st.gc, st.gc + HIST_GAMES_PER_TICK);
      let found = 0, asked = 0;
      for (let i = 0; i < slice.length; i += FETCH_AT_ONCE) {
        const group = slice.slice(i, i + FETCH_AT_ONCE);
        const got = await Promise.all(group.map(id =>
          rsGet(gameUrl(id), auth).then(d => d, () => null)));
        for (const d of got) {
          if (!d) continue;
          asked++;
          const seen = [];
          const dig = v => {
            if (!v) return;
            if (Array.isArray(v)) { for (const x of v) dig(x); return; }
            if (typeof v !== 'object') return;
            for (const k of ['playerId', 'id']) {
              if (v[k] != null && Number.isFinite(Number(v[k]))) seen.push(Number(v[k]));
            }
            for (const k of ['boxScores', 'players', 'rows', 'items', 'home', 'away']) {
              if (v[k]) dig(v[k]);
            }
          };
          dig(d.matchPlayerBoxScores);
          dig(d.players);
          /* Plays name their people with primaryPlayerId and the ordinals
             after it, not playerId and player2Id - that is the play
             collector's own shape, and reading for it here quietly found
             nobody, which is how 2021 came to be called finished with four
             hundred of its players missing. */
          for (const r of (Array.isArray(d.plays) ? d.plays : [])) {
            if (!r) continue;
            for (const k of ['primaryPlayerId', 'secondaryPlayerId', 'tertiaryPlayerId',
                             'quaternaryPlayerId', 'quinaryPlayerId',
                             'homePlayerId', 'awayPlayerId',
                             'playerId', 'player2Id', 'player3Id', 'player4Id']) {
              if (r[k] != null) seen.push(Number(r[k]));
            }
          }
          for (const id of seen) {
            if (Number.isFinite(id) && !knownPlayers.has(id)) {
              knownPlayers.add(id);
              st.players.push(id);
              found++;
            }
          }
        }
        await sleep(15);
      }
      st.gc += slice.length;
      await save();
      return json({ sport: sp, season: se, step: 'games', asked, newPlayers: found,
                    gamesDone: st.gc, games: st.games.length,
                    players: st.players.length, playersDone: st.pc });
    }

    // Both passes caught up and the game feeds turned up nobody new.
    try { await env.RATEBOARD_KV.put(histDoneKey(sp, se), '1'); } catch (e) {}
    let rows = 0;
    try {
      const r = await db.prepare('SELECT COUNT(*) AS n FROM gamelog WHERE sport=?1 AND season=?2')
        .bind(sp, se).first();
      rows = Number((r && r.n) || 0);
    } catch (e) {}
    return json({ sport: sp, season: se, finished: true,
                  players: st.players.length, games: st.games.length, rows });
  }

  /* ----- the historical board ---------------------------------------------
     These seasons have a real per-game rating and no rax at all, so the
     earnings are worked out rather than read.

     Est rax is today's rate card run over old games: five times the rating
     for the offence and the kickers, seven for the defence and the punters,
     doubled in the playoffs, nothing at all for pre-season.

     Worth knowing what that is and is not. It is NOT what those seasons
     paid - every season from 2021 to 2024 paid a flat five to everyone,
     defenders included, which is measured rather than assumed, and a flat
     five reproduces Real's published 2021 earnings for 903 of 905 players.
     The seven-times defensive rate only arrived for 2025. So this column
     is what these games would be worth under the rules as they stand, not
     a reconstruction of what was actually banked. */
  const HIST_DEF_POS = ['DB','LB','DL','DT','DE','CB','S','EDGE','NT','P','OLB','ILB','MLB','FS','SS'];
  const HIST_PAYS = `seasonType IN ('regularseason','postseason')`;
  const histDouble = `(CASE WHEN seasonType = 'postseason' THEN 2 ELSE 1 END)`;
  /* Football pays a multiple of the rating by position. Basketball pays the
     rating itself, doubled in the playoffs and only then rounded - and
     rounded at .6 rather than .5, so a 3.3 in a playoff game is 6.6 and pays
     7 while a 6.5 pays 6. Adding 0.4 and truncating is exactly that rule;
     the MAX keeps a negative rating from paying out. */
  const histRaxSql = sp => sp === 'nba'
    ? `MAX(0, CAST(rating * ${histDouble} + 0.4 AS INTEGER))`
    : `CAST(ROUND(rating * (CASE WHEN position IN (${HIST_DEF_POS.map(x => `'${x}'`).join(',')})`
      + ` THEN 7 ELSE 5 END) * ${histDouble}) AS INTEGER)`;

  if (url.searchParams.get('hist') === 'board') {
    const db = env.RATEBOARD_DB;
    if (!db) return json({ error: 'no database binding' }, 503);
    const P = k => String(url.searchParams.get(k) || '').trim();
    const sp = HIST_SPORTS.includes(P('sport')) ? P('sport') : HIST_SPORT;
    const want = P('seasons').split(',').map(x => x.trim()).filter(Boolean)
      .map(x => Number(String(x).split(/[:|]/).pop()))
      .filter(y => histHolds(sp, y));
    const term = P('q').toLowerCase();
    const pid = /^\d+$/.test(P('playerId')) ? Number(P('playerId')) : 0;
    const SORTS = ['estRax', 'rating', 'games', 'ratingPerGame',
                   'raxPerGame', 'player', 'season', 'day'];
    const sort = SORTS.includes(P('sort')) ? P('sort') : 'estRax';
    const dir = P('dir') === 'asc' ? 1 : -1;
    const limit = P('format') === 'csv' ? 20000
      : Math.min(500, Math.max(1, parseInt(P('limit') || '100', 10) || 100));
    const offset = P('format') === 'csv' ? 0 : Math.max(0, parseInt(P('offset') || '0', 10) || 0);
    /* Only the seasons that actually hold rows. The crawl is still running,
       so the picker grows as they land rather than showing a row of empties. */
    let have = [];
    try {
      const r = await db.prepare(
        `SELECT season, COUNT(*) AS n FROM gamelog
          WHERE sport = ?1 AND season >= ?2 AND season <= ?3
          GROUP BY season HAVING n > 0 ORDER BY season DESC`)
        .bind(sp, HIST_RANGE[sp][0], HIST_RANGE[sp][1]).all();
      have = (r.results || []).map(x => Number(x.season));
    } catch (e) {}
    const seasons = have.filter(y => !want.length || want.includes(y));

    // ---- game by game
    if (P('view') === 'games') {
      const need = Math.min(2000, offset + limit);
      const out = [];
      for (const y of seasons) {
        const w = ['sport = ?', 'season = ?', HIST_PAYS, 'rating IS NOT NULL'];
        const binds = [sp, y];
        if (pid) { w.push('playerId = ?'); binds.push(pid); }
        else if (term) { w.push('LOWER(player) LIKE ?'); binds.push('%' + term + '%'); }
        const col = sort === 'rating' ? 'rating' : sort === 'day' ? 'day'
          : sort === 'player' ? 'player' : 'estRax';
        try {
          const r = await db.prepare(
            `SELECT playerId, player, team, position, day, seasonType, opponent, result,
                    teamScore, oppScore, rating, (${histRaxSql(sp)}) AS estRax
               FROM gamelog WHERE ${w.join(' AND ')}
              ORDER BY ${col} ${dir < 0 ? 'DESC' : 'ASC'} LIMIT ${need}`).bind(...binds).all();
          for (const x of (r.results || [])) {
            out.push({ playerId: Number(x.playerId), player: x.player || '', team: x.team || '',
                       position: x.position || '', season: y, day: x.day || '',
                       seasonType: x.seasonType || '', opponent: x.opponent || '',
                       result: x.result || '',
                       teamScore: x.teamScore == null ? null : Number(x.teamScore),
                       oppScore: x.oppScore == null ? null : Number(x.oppScore),
                       rating: Math.round(Number(x.rating) * 100) / 100,
                       estRax: Number(x.estRax) || 0 });
          }
        } catch (e) {}
      }
      const txt = sort === 'player' || sort === 'day';
      out.sort((a, b) => {
        const k = sort === 'games' ? 'estRax' : sort;
        const av = a[k], bv = b[k];
        if (txt) return dir * String(av || '').localeCompare(String(bv || ''));
        return dir * ((Number(av) || 0) - (Number(bv) || 0));
      });
      const pageG = out.slice(offset, offset + limit).map((x, i) =>
        Object.assign({ rank: offset + i + 1 }, x));
      return json({ sport: sp, view: 'games', total: out.length, capped: out.length >= need,
                    offset, limit, sort, dir: dir < 0 ? 'desc' : 'asc',
                    sports: HIST_SPORTS, seasons: have, rows: pageG });
    }

    /* ---- by player. Built a season at a time and kept, because the boost
       column needs every player in the season ranked before any one row can
       be worked out. */
    const CACHE = `histboard_${sp}_v2`;
    let cache = null;
    try { cache = JSON.parse((await env.RATEBOARD_KV.get(CACHE)) || 'null'); } catch (e) {}
    if (!cache || !cache.seasons || P('rebuild') === '1') cache = { seasons: {} };
    const FRESH_FOR = 30 * 60 * 1000;
    let built = 0, building = 0;
    for (const y of seasons) {
      const held = cache.seasons[String(y)];
      const fresh = held && Array.isArray(held.rows)
        && (Date.now() - Number(held.at || 0)) < FRESH_FOR;
      if (fresh) continue;
      if (built >= 3) { building++; continue; }
      try {
        const r = await db.prepare(
          `SELECT playerId, MAX(player) AS player, MAX(team) AS team, MAX(position) AS position,
                  COUNT(*) AS games, ROUND(SUM(rating), 2) AS rating,
                  SUM(${histRaxSql(sp)}) AS estRax
             FROM gamelog
            WHERE sport = ?1 AND season = ?2 AND ${HIST_PAYS} AND rating IS NOT NULL
            GROUP BY playerId`).bind(sp, y).all();
        const rows = (r.results || []).map(x => ({
          playerId: Number(x.playerId), player: x.player || '', team: x.team || '',
          position: x.position || '', season: y,
          games: Number(x.games) || 0,
          rating: Number(x.rating) || 0,
          estRax: Number(x.estRax) || 0
        }));
        rows.forEach(row => {
          row.raxPerGame = row.games ? Math.round((row.estRax / row.games) * 100) / 100 : 0;
          row.ratingPerGame = row.games ? Math.round((row.rating / row.games) * 100) / 100 : 0;
        });
        cache.seasons[String(y)] = { at: Date.now(), rows };
        // An empty season costs nothing to work out, so it does not use up
        // one of this call's slots.
        if (rows.length) built++;
      } catch (e) { /* a season that will not read is left out, not fatal */ }
    }
    if (built) { try { await env.RATEBOARD_KV.put(CACHE, JSON.stringify(cache)); } catch (e) {} }

    let view = [];
    for (const y of seasons) {
      const held = cache.seasons[String(y)];
      if (held && Array.isArray(held.rows)) for (const x of held.rows) view.push(x);
    }
    if (term) view = view.filter(x => String(x.player || '').toLowerCase().includes(term));
    const minGames = Math.max(0, parseInt(P('minGames') || '0', 10) || 0);
    if (minGames) view = view.filter(x => x.games >= minGames);
    const txt = sort === 'player';
    view = view.slice().sort((a, b) => {
      const av = a[sort], bv = b[sort];
      if (txt) return dir * String(av || '').localeCompare(String(bv || ''));
      const an = Number(av) || 0, bn = Number(bv) || 0;
      return an === bn ? (Number(b.estRax) - Number(a.estRax)) : dir * (an - bn);
    });
    const total = view.length;
    const page = view.slice(offset, offset + limit).map((x, i) =>
      Object.assign({ rank: offset + i + 1 }, x));
    if (P('format') === 'csv') {
      const cols = ['rank', 'player', 'team', 'position', 'season', 'games', 'rating',
                    'ratingPerGame', 'estRax', 'raxPerGame'];
      const escC = v => v == null ? '' : /[",\n]/.test(String(v))
        ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
      const body = [cols.join(',')]
        .concat(page.map(r => cols.map(c => escC(r[c])).join(','))).join('\n');
      return new Response(body, { headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="nfl-historical.csv"',
        'access-control-allow-origin': '*' } });
    }
    return json({ sport: sp, total, offset, limit, sort, dir: dir < 0 ? 'desc' : 'asc',
                  building, sports: HIST_SPORTS, seasons: have, rows: page });
  }

  /* How far the historical crawl has got, season by season. */
  if (url.searchParams.get('hist') === 'progress') {
    const db = env.RATEBOARD_DB;
    if (!db) return json({ error: 'no database binding' }, 503);
    const out = [];
    for (const q of HIST_QUEUE) {
      let st = null, fin = null;
      try { st = JSON.parse((await env.RATEBOARD_KV.get(histKey(q.sport, q.season))) || 'null'); } catch (e) {}
      try { fin = await env.RATEBOARD_KV.get(histDoneKey(q.sport, q.season)); } catch (e) {}
      let rows = 0;
      try {
        const r = await db.prepare('SELECT COUNT(*) AS n FROM gamelog WHERE sport=?1 AND season=?2')
          .bind(q.sport, q.season).first();
        rows = Number((r && r.n) || 0);
      } catch (e) {}
      out.push({ sport: q.sport, season: q.season, finished: !!fin, rows,
                 players: st ? st.players.length : 0, playersDone: st ? st.pc : 0,
                 games: st ? st.games.length : 0, gamesDone: st ? st.gc : 0 });
    }
    return json({ at: new Date().toISOString(), seasons: out });
  }

  if (url.searchParams.get('earn') === 'shift') {
    const db = env.RATEBOARD_DB;
    if (!db) return json({ error: 'no database binding' }, 503);
    const P = k => String(url.searchParams.get(k) || '').trim();
    const wantSport = EARN_SPORTS.includes(P('sport')) ? P('sport') : '';
    const wantSeason = /^\d{4}$/.test(P('season')) ? Number(P('season')) : 0;
    /* Several seasons at once, the same shape the rest of the game-data
       views take them in: sport:season, comma separated. An empty list
       means every season there is. */
    const wantPairs = P('seasons').split(',').map(x => x.trim()).filter(Boolean)
      .map(x => x.replace(':', '|'))
      .filter(x => EARN_SPORTS.includes(x.split('|')[0]) && /^\d{4}$/.test(x.split('|')[1]));
    const inPick = (sp, se) => (!wantPairs.length || wantPairs.includes(`${sp}|${se}`))
      && (!wantSport || sp === wantSport) && (!wantSeason || Number(se) === wantSeason);
    const minGames = Math.max(0, parseInt(P('minGames') || '0', 10) || 0);
    const term = P('q').toLowerCase();
    const SORTS = ['diff', 'hypo', 'rax', 'raxPerGame', 'hypoPerGame', 'games',
                   'bestRax', 'owners', 'rating', 'ratingPerGame', 'player', 'pct', 'day'];
    const sort = SORTS.includes(P('sort')) ? P('sort') : 'diff';
    const dir = P('dir') === 'asc' ? 1 : -1;
    const limit = P('format') === 'csv' ? 20000
      : Math.min(500, Math.max(1, parseInt(P('limit') || '100', 10) || 100));
    const offset = P('format') === 'csv' ? 0 : Math.max(0, parseInt(P('offset') || '0', 10) || 0);

    /* Every season is read on its own. The key on gamelog starts
       (sport, season), so one season at a time is a range of the index
       rather than a scan of the table, which is what kept the whole-table
       version inside D1's CPU budget. The merged list is a few thousand
       rows, so ranking and paging happen here. */
    const CACHE = 'earnshift_v3';
    const FRESH_FOR = 6 * 60 * 60 * 1000;
    const PER_CALL = 3;   // seasons built per request, see below
    let cache = null;
    try { cache = JSON.parse((await env.RATEBOARD_KV.get(CACHE)) || 'null'); } catch (e) {}
    if (!cache || !cache.seasons || url.searchParams.get('rebuild') === '1') {
      cache = { at: 0, seasons: {} };
    }

    let pairs = [];
    try {
      const r = await db.prepare(
        `SELECT DISTINCT sport, season FROM gamelog
          WHERE sport IN ('nba','nhl') ORDER BY sport, season`).all();
      /* The historical seasons stay out of this. They carry a rating and no
         rax at all, so a shift comparison would be against zero. */
      pairs = (r.results || []).map(x => ({ sport: String(x.sport), season: Number(x.season) }))
        .filter(x => EARN_SPORTS.includes(x.sport) && !histHolds(x.sport, x.season));
    } catch (e) {
      return json({ error: 'could not read the game log', detail: String((e && e.message) || e) }, 503);
    }

    /* ----- game by game ----------------------------------------------------
       The same comparison one row per game rather than one per season. This
       one is not cached: the log holds hundreds of thousands of these and
       the only views anyone asks for are the top of a sort or a single
       player, both of which a LIMIT answers cheaply.

       Each season is still read on its own and the pieces merged here.
       Ordering the whole of NBA and NHL in one statement would mean sorting
       four hundred thousand rows on a computed column, which is the shape
       that has run past D1's CPU budget before; a season at a time is a
       range of the index and sorts fifty thousand at the outside. Taking
       the first (offset + limit) of each season and ranking those together
       gives exactly the same page as sorting the lot would. */
    if (P('view') === 'games') {
      const G_SORTS = { diff: 'diff', hypo: 'hypo', rax: 'rax', rating: 'rating',
                        day: 'day', player: 'player' };
      const sortCol = G_SORTS[sort] || 'diff';
      const dirSql = dir < 0 ? 'DESC' : 'ASC';
      const need = Math.min(2000, offset + limit);
      const pid = /^\d+$/.test(P('playerId')) ? Number(P('playerId')) : 0;
      const out = [];
      for (const pr of pairs) {
        if (!inPick(pr.sport, pr.season)) continue;
        const w = ["sport = ?", "season = ?",
                   "seasonType IN ('regularseason','postseason','allstar')",
                   'rating IS NOT NULL', 'rax IS NOT NULL'];
        const binds = [pr.sport, pr.season];
        if (pid) { w.push('playerId = ?'); binds.push(pid); }
        else if (term) { w.push('LOWER(player) LIKE ?'); binds.push('%' + term + '%'); }
        const hyp = hypoSql(pr.sport);
        try {
          const r = await db.prepare(
            `SELECT playerId, player, team, opponent, day, seasonType, result,
                    teamScore, oppScore, rating, rax,
                    (${hyp}) AS hypo, (${hyp}) - rax AS diff
               FROM gamelog WHERE ${w.join(' AND ')}
              ORDER BY ${sortCol} ${dirSql} LIMIT ${need}`).bind(...binds).all();
          for (const x of (r.results || [])) {
            out.push({
              playerId: Number(x.playerId), player: x.player || '', team: x.team || '',
              sport: pr.sport, season: pr.season,
              day: x.day || '', opponent: x.opponent || '',
              seasonType: x.seasonType || '', result: x.result || '',
              teamScore: x.teamScore == null ? null : Number(x.teamScore),
              oppScore: x.oppScore == null ? null : Number(x.oppScore),
              rating: Math.round(Number(x.rating) * 100) / 100,
              rax: Number(x.rax) || 0,
              hypo: Number(x.hypo) || 0,
              diff: Number(x.diff) || 0
            });
          }
        } catch (e) { /* a season that will not read is left out, not fatal */ }
      }
      const txtG = sortCol === 'player' || sortCol === 'day';
      out.sort((a, b) => {
        const av = a[sortCol], bv = b[sortCol];
        if (txtG) return dir * String(av || '').localeCompare(String(bv || ''));
        const an = Number(av), bn = Number(bv);
        return an === bn ? (Number(b.diff) - Number(a.diff)) : dir * (an - bn);
      });
      const pageG = out.slice(offset, offset + limit).map((x, i) =>
        Object.assign({ rank: offset + i + 1 }, x));
      if (P('format') === 'csv') {
        const colsG = ['rank', 'player', 'team', 'sport', 'season', 'day', 'opponent',
                       'seasonType', 'result', 'rating', 'rax', 'hypo', 'diff'];
        const escG = v => v == null ? '' : /[",\n]/.test(String(v))
          ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
        const body = [colsG.join(',')]
          .concat(pageG.map(r => colsG.map(c => escG(r[c])).join(','))).join('\n');
        return new Response(body, { headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="rax-shift-games.csv"',
          'access-control-allow-origin': '*' } });
      }
      /* out is capped per season, so the count is "at least this many" once
         it fills up rather than a true total. The page says so. */
      return json({ view: 'games', offset, limit, sort, dir: dir < 0 ? 'desc' : 'asc',
                    total: out.length, capped: out.length >= need,
                    curve: NEW_CURVE,
                    seasons: pairs.map(x => `${x.sport}|${x.season}`), rows: pageG });
    }

    /* Built a few seasons per request rather than all of them at once. Eight
       seasons is the better part of four hundred thousand game rows, and
       grouping that many in one request is exactly the shape that has run
       past D1's CPU budget before. Each season is kept on its own and the
       whole set is stale after six hours, so a request only ever rebuilds
       what has actually aged out. */
    const stale = pr => {
      const c = cache.seasons[`${pr.sport}|${pr.season}`];
      return !c || !Array.isArray(c.rows) || (Date.now() - Number(c.at || 0)) > FRESH_FOR;
    };
    const todo = pairs.filter(stale);
    let built = 0;
    {
      for (const pr of todo.slice(0, PER_CALL)) {
        try {
          const r = await db.prepare(
            `SELECT playerId, MAX(player) AS player,
                    /* The team is read off the regular season alone. Taking
                       the highest team string over the whole season handed
                       stars their all-star side - Jokic filed under LEB
                       rather than DEN - because those codes sort last. */
                    MAX(CASE WHEN seasonType = 'regularseason' THEN team END) AS team,
                    COUNT(*) AS games,
                    SUM(rax) AS rax,
                    SUM(${hypoSql(pr.sport)}) AS hypo,
                    MAX(rax) AS bestRax,
                    ROUND(SUM(rating), 1) AS rating,
                    ROUND(AVG(rating), 2) AS ratingPerGame
               FROM gamelog
              WHERE sport = ?1 AND season = ?2
                AND seasonType IN ('regularseason','postseason','allstar')
                AND rating IS NOT NULL AND rax IS NOT NULL
              GROUP BY playerId`).bind(pr.sport, pr.season).all();
          const out = [];
          for (const x of (r.results || [])) {
            const games = Number(x.games) || 0;
            const rax = Number(x.rax) || 0;
            const hypo = Number(x.hypo) || 0;
            out.push({
              playerId: Number(x.playerId), player: x.player || '', team: x.team || '',
              sport: pr.sport, season: pr.season, games, rax, hypo,
              diff: hypo - rax,
              pct: rax > 0 ? Math.round((hypo / rax) * 1000) / 10 : null,
              raxPerGame: games ? Math.round((rax / games) * 100) / 100 : 0,
              hypoPerGame: games ? Math.round((hypo / games) * 100) / 100 : 0,
              bestRax: Number(x.bestRax) || 0,
              rating: Number(x.rating) || 0,
              ratingPerGame: Number(x.ratingPerGame) || 0
            });
          }
          cache.seasons[`${pr.sport}|${pr.season}`] = { at: Date.now(), rows: out };
          built++;
        } catch (e) { /* a season that will not read is left out, not fatal */ }
      }
      if (built) {
        cache.at = Date.now();
        try { await env.RATEBOARD_KV.put(CACHE, JSON.stringify(cache)); } catch (e) {}
      }
    }

    const rows = [];
    for (const pr of pairs) {
      const c = cache.seasons[`${pr.sport}|${pr.season}`];
      if (c && Array.isArray(c.rows)) for (const r of c.rows) rows.push(r);
    }
    const building = Math.max(0, todo.length - built);

    let view = rows.filter(x => inPick(x.sport, x.season));
    if (minGames) view = view.filter(x => x.games >= minGames);
    if (term) view = view.filter(x => String(x.player || '').toLowerCase().includes(term));

    const txt = sort === 'player';
    view = view.slice().sort((a, b) => {
      const av = a[sort], bv = b[sort];
      if (txt) return dir * String(av || '').localeCompare(String(bv || ''));
      const an = av == null ? -Infinity : Number(av);
      const bn = bv == null ? -Infinity : Number(bv);
      return an === bn ? (Number(b.diff) - Number(a.diff)) : dir * (an - bn);
    });
    const total = view.length;
    const page = view.slice(offset, offset + limit).map((x, i) =>
      Object.assign({ rank: offset + i + 1 }, x));

    /* Owners are a daily snapshot in their own table. Reading them for the
       page's players only keeps this to a handful of seeks instead of one
       per row of the whole log. */
    if (page.length) {
      const byKey = new Map();
      for (const x of page) byKey.set(`${x.sport}|${x.season}|${x.playerId}`, x);
      for (const sp of EARN_SPORTS) {
        for (const se of [...new Set(page.filter(x => x.sport === sp).map(x => x.season))]) {
          const ids = page.filter(x => x.sport === sp && x.season === se)
            .map(x => Number(x.playerId)).filter(Number.isFinite);
          if (!ids.length) continue;
          // Ids are inlined and coerced: D1 takes at most 100 bound values.
          for (let i = 0; i < ids.length; i += 400) {
            const list = ids.slice(i, i + 400).join(',');
            try {
              const r = await db.prepare(
                `SELECT playerId, owners FROM owners
                  WHERE sport = ?1 AND season = ?2 AND playerId IN (${list})
                    AND day = (SELECT MAX(d.day) FROM owners d
                                WHERE d.sport = ?1 AND d.season = ?2)`).bind(sp, se).all();
              for (const o of (r.results || [])) {
                const hitRow = byKey.get(`${sp}|${se}|${Number(o.playerId)}`);
                if (hitRow) hitRow.owners = Number(o.owners);
              }
            } catch (e) {}
          }
        }
      }
    }

    if (P('format') === 'csv') {
      const cols = ['rank', 'player', 'sport', 'season', 'games', 'rax', 'hypo', 'diff', 'pct',
                    'raxPerGame', 'hypoPerGame', 'bestRax', 'owners', 'rating', 'ratingPerGame'];
      const esc = v => v == null ? '' : /[",\n]/.test(String(v))
        ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
      const body = [cols.join(',')]
        .concat(page.map(r => cols.map(c => esc(r[c])).join(','))).join('\n');
      return new Response(body, { headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="rax-shift.csv"',
        'access-control-allow-origin': '*' } });
    }
    return json({ total, offset, limit, sort, dir: dir < 0 ? 'desc' : 'asc',
                  curve: NEW_CURVE, building,
                  seasons: pairs.map(p => `${p.sport}|${p.season}`), rows: page });
  }

  /* What a game rating actually pays, read off the game log rather than
     assumed. One row per (rating, seasonType) with the rax values seen, so a
     hypothetical curve can be built on the real one. */
  if (url.searchParams.get('earn') === 'curve') {
    const db = env.RATEBOARD_DB;
    if (!db) return json({ error: 'no database binding' }, 503);
    const sp = String(url.searchParams.get('sport') || 'nba').toLowerCase();
    const P2 = k => String(url.searchParams.get(k) || '').trim();
    /* Which whole-number rating pays what, counted. The curve is read off the
       log rather than assumed, so a hypothetical one can be built beside it. */
    /* The raw stat labels a sport's box score carries. The game log was
       shaped around basketball, so anything a sport files under a different
       name was never stored - this is what says which names to add. */
    if (url.searchParams.get('mode') === 'stats') {
      const pidS = String(url.searchParams.get('playerId') || '').replace(/\D+/g, '');
      const seS = /^\d{4}$/.test(P2('season')) ? P2('season') : '2025';
      if (!pidS) return json({ error: 'playerId needed' }, 400);
      try {
        const d = await rsGet(
          `https://web.realapp.com/players/${pidS}/sport/${sp}/seasonfeed?limit=5&season=${seS}&view=recent&viewFrame=default`,
          auth);
        const bs = (d && d.playerBoxScores) || [];
        const b = bs[0] || null;
        return json({ sport: sp, season: seS, playerId: pidS, games: bs.length,
                      rowKeys: b ? Object.keys(b) : [],
                      statValues: b ? (b.statValues || []) : [],
                      fantasyStats: b ? b.fantasyStats : null,
                      position: b ? b.position : null });
      } catch (e) {
        return json({ error: String((e && e.message) || e) }, 502);
      }
    }

    /* One old game's feed, straight from Real, to see whether a season with
       no earnings leaderboard can still be enumerated from its games. Same
       URL the play collector already uses; nothing new is reachable. */
    if (url.searchParams.get('mode') === 'game') {
      const gid = String(url.searchParams.get('gameId') || '').replace(/\D+/g, '');
      if (!gid) return json({ error: 'gameId needed' }, 400);
      try {
        const d = await rsGet(
          `https://web.realapp.com/games/${gid}/sport/${sp}/feed?version=2&view=all&viewFrame=default`,
          auth);
        const rows = Array.isArray(d && d.plays) ? d.plays : rowsOf(d);
        const ids = new Set();
        for (const r of (rows || [])) {
          for (const k of ['playerId', 'player2Id', 'player3Id', 'player4Id']) {
            if (r && r[k] != null) ids.add(Number(r[k]));
          }
        }
        const mb = d && d.matchPlayerBoxScores;
        return json({ gameId: gid, topKeys: Object.keys(d || {}),
                      rows: (rows || []).length, distinctPlayers: ids.size,
                      someIds: [...ids].slice(0, 12),
                      boxType: Array.isArray(mb) ? 'array' : typeof mb,
                      boxLen: Array.isArray(mb) ? mb.length : (mb ? Object.keys(mb).length : 0),
                      boxKeys: Array.isArray(mb)
                        ? (mb[0] ? Object.keys(mb[0]) : [])
                        : (mb ? Object.keys(mb) : []),
                      playersType: Array.isArray(d && d.players) ? 'array' : typeof (d && d.players),
                      playersLen: Array.isArray(d && d.players) ? d.players.length : 0,
                      playersKeys: (d && Array.isArray(d.players) && d.players[0])
                        ? Object.keys(d.players[0]) : [],
                      firstRow: (rows || [])[0] || null });
      } catch (e) {
        return json({ error: String((e && e.message) || e) }, 502);
      }
    }

    /* The payout multiplier split either side of a date, per player, with
       the position and the owner count beside it - for working out what the
       extra boost some players get is actually keyed on. */
    if (url.searchParams.get('mode') === 'boost') {
      const se = /^\d{4}$/.test(P2('season')) ? Number(P2('season')) : 2025;
      const cut = /^\d{4}-\d{2}-\d{2}$/.test(P2('cut')) ? P2('cut') : '2025-12-16';
      try {
        const r = await db.prepare(
          `SELECT g.playerId AS playerId, MAX(g.player) AS player, MAX(g.position) AS pos,
                  MAX(g.team) AS team,
                  SUM(CASE WHEN g.day <  ?4 THEN 1 ELSE 0 END) AS nPre,
                  SUM(CASE WHEN g.day >= ?4 THEN 1 ELSE 0 END) AS nPost,
                  ROUND(SUM(CASE WHEN g.day <  ?4 THEN g.rax ELSE 0 END) * 1.0
                      / NULLIF(SUM(CASE WHEN g.day <  ?4 THEN g.rating ELSE 0 END), 0), 2) AS mPre,
                  ROUND(SUM(CASE WHEN g.day >= ?4 THEN g.rax ELSE 0 END) * 1.0
                      / NULLIF(SUM(CASE WHEN g.day >= ?4 THEN g.rating ELSE 0 END), 0), 2) AS mPost,
                  (SELECT ow.owners FROM owners ow
                    WHERE ow.sport = ?1 AND ow.season = ?2 AND ow.playerId = g.playerId
                    ORDER BY ow.day DESC LIMIT 1) AS owners
             FROM gamelog g
            WHERE g.sport = ?1 AND g.season = ?2 AND g.seasonType = ?3
              AND g.rating > 0.3 AND g.rax > 0
            GROUP BY g.playerId
           HAVING nPre >= 3 AND nPost >= 2
            ORDER BY mPost DESC`).bind(sp, se, 'regularseason', cut).all();
        return json({ sport: sp, season: se, cut, rows: r.results || [] });
      } catch (e) {
        return json({ error: String((e && e.message) || e) }, 503);
      }
    }

    /* What multiplier each player's season actually came out at. NFL pays a
       multiple of the game rating rather than the rating itself, and the
       multiple is not the same for everyone - this is what shows the tiers. */
    if (url.searchParams.get('mode') === 'mult') {
      const se = /^\d{4}$/.test(P2('season')) ? Number(P2('season')) : 2025;
      const stype = String(url.searchParams.get('seasonType') || 'regularseason');
      try {
        const r = await db.prepare(
          `SELECT playerId, MAX(player) AS player, MAX(position) AS pos, MAX(team) AS team,
                  COUNT(*) AS n, SUM(rax) AS rax, ROUND(SUM(rating), 2) AS rating,
                  ROUND(CAST(SUM(rax) AS REAL) / SUM(rating), 3) AS mult
             FROM gamelog
            WHERE sport = ?1 AND season = ?2 AND seasonType = ?3
              AND rating IS NOT NULL AND rax IS NOT NULL
            GROUP BY playerId
           HAVING SUM(rating) > 8 AND SUM(rax) > 0
            ORDER BY mult DESC`).bind(sp, se, stype).all();
        return json({ sport: sp, season: se, seasonType: stype, rows: r.results || [] });
      } catch (e) {
        return json({ error: String((e && e.message) || e) }, 503);
      }
    }

    if (url.searchParams.get('mode') === 'bucket') {
      const stype = String(url.searchParams.get('seasonType') || 'regularseason');
      const seasonArg = url.searchParams.get('season');
      const binds = [sp, stype];
      let extra = '';
      if (seasonArg && /^\d+$/.test(seasonArg)) { extra = ' AND season = ?'; binds.push(Number(seasonArg)); }
      try {
        const r = await db.prepare(
          `SELECT CAST(ROUND(rating) AS INTEGER) AS r, rax, COUNT(*) AS n
             FROM gamelog
            WHERE sport = ? AND seasonType = ? AND rating IS NOT NULL AND rax IS NOT NULL${extra}
            GROUP BY r, rax HAVING n > 20 ORDER BY r, n DESC`).bind(...binds).all();
        return json({ sport: sp, seasonType: stype, season: seasonArg || 'all', rows: r.results || [] });
      } catch (e) {
        return json({ error: String((e && e.message) || e) }, 503);
      }
    }
    try {
      const r = await db.prepare(
        `SELECT season, seasonType, COUNT(*) AS n,
                SUM(rax) AS raxSum,
                SUM(CAST(ROUND(rating) AS INTEGER)) AS roundSum,
                SUM(CASE WHEN rax = CAST(ROUND(rating) AS INTEGER) THEN 1 ELSE 0 END) AS eqRound,
                SUM(CASE WHEN rax = 2 * CAST(ROUND(rating) AS INTEGER) THEN 1 ELSE 0 END) AS eqDouble,
                SUM(CASE WHEN rax = CAST(rating AS INTEGER) THEN 1 ELSE 0 END) AS eqFloor
           FROM gamelog
          WHERE sport = ? AND rating IS NOT NULL AND rax IS NOT NULL
          GROUP BY season, seasonType
          ORDER BY season, seasonType`).bind(sp).all();
      return json({ sport: sp, rows: r.results || [] });
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 503);
    }
  }

  if (url.searchParams.get('plays') === 'progress') {
    const db = env.RATEBOARD_DB;
    if (!db) return json({ error: 'no database binding' }, 503);
    /* Counting every play in the table in one go stopped fitting inside D1's
       CPU budget once basketball arrived - a million and a half rows, grouped
       and counted distinct. So it is counted one sport at a time, which keeps
       each query to a range of an index, and the answer is kept for a few
       minutes: the bar refreshes every thirty seconds and nothing it shows
       moves faster than that. */
    const CACHE = 'progress_cache_v1', FRESH_MS = 180000;
    const want = String(url.searchParams.get('fresh') || '') === '1';
    if (!want) {
      try {
        const c = JSON.parse((await env.RATEBOARD_KV.get(CACHE)) || 'null');
        if (c && c.at && Date.now() - c.at < FRESH_MS) {
          return json(Object.assign({}, c.body, { cached: true,
            ageSeconds: Math.round((Date.now() - c.at) / 1000) }));
        }
      } catch (e) {}
    }
    await playsReady(db);
    const SPORTS = ['nfl', 'ncaaf', 'mlb', 'nba', 'wnba', 'nhl'];
    const logged = new Map(), got = new Map();
    for (const sp of SPORTS) {
      try {
        const r = await db.prepare(
          `SELECT season, COUNT(DISTINCT gameId) AS games FROM gamelog
            WHERE sport=? AND seasonType IN (${seasonTypeSql(sp)})
            GROUP BY season`).bind(sp).all();
        for (const x of (r.results || [])) logged.set(`${sp}|${x.season}`, Number(x.games) || 0);
      } catch (e) {}
      try {
        const r = await db.prepare(
          `SELECT season, COUNT(DISTINCT gameId) AS games,
                  SUM(CASE WHEN tags IS NULL THEN 0 ELSE 1 END) AS plays,
                  SUM(CASE WHEN tags IS NOT NULL AND rarity IS NOT NULL THEN 1 ELSE 0 END) AS scored,
                  COUNT(*) AS allPlays
             FROM plays WHERE sport=? GROUP BY season`).bind(sp).all();
        for (const x of (r.results || [])) got.set(`${sp}|${x.season}`,
          { games: Number(x.games) || 0, plays: Number(x.plays) || 0,
            scored: Number(x.scored) || 0, allPlays: Number(x.allPlays) || 0 });
      } catch (e) {}
    }
    let tick = 0;
    try { tick = Number((JSON.parse((await env.RATEBOARD_KV.get('plays_tick_v1')) || '{}') || {}).n) || 0; } catch (e) {}
    const queue = [];
    for (const x of PLAYS_SPORTS) {
      const k = `${x.sport}|${x.season}`;
      let lapped = null;
      try { lapped = await env.RATEBOARD_KV.get(sweptKey(x.sport, x.season)); } catch (e) {}
      const g = got.get(k) || { games: 0, plays: 0, scored: 0, allPlays: 0 };
      queue.push({ sport: x.sport, season: x.season, pri: x.pri || 99,
                   rolling: !!x.rolling, lapped: !!lapped,
                   gamesLogged: logged.get(k) || 0, gamesCollected: g.games,
                   plays: g.plays, scored: g.scored, allPlays: g.allPlays });
    }
    const fresh = queue.filter(x => !x.lapped);
    let working = null;
    if (fresh.length) {
      const top = Math.min(...fresh.map(x => x.pri));
      working = fresh.filter(x => x.pri === top).map(x => `${x.sport} ${x.season}`);
    }
    const perf = [];
    try {
      await perfReady(db);
      const r = await db.prepare(
        `SELECT sport, season, COUNT(*) AS rows_, COUNT(DISTINCT playerId) AS players
           FROM performances GROUP BY sport, season`).all();
      for (const x of (r.results || [])) perf.push(x);
    } catch (e) {}
    const perfQueue = [];
    for (const x of PERF_QUEUE) {
      let fin = null;
      try { fin = await env.RATEBOARD_KV.get(perfDoneKey(x.sport, x.season)); } catch (e) {}
      perfQueue.push({ sport: x.sport, season: x.season, done: !!fin });
    }
    const body = { at: new Date().toISOString(), tick, working, queue, perf, perfQueue };
    try { await env.RATEBOARD_KV.put(CACHE, JSON.stringify({ at: Date.now(), body })); } catch (e) {}
    return json(body);
  }



  if (url.searchParams.get('plays') === 'seasons') {
    const db = env.RATEBOARD_DB;
    if (!db) return json({ error: 'no database binding' }, 503);
    await playsReady(db);
    try {
      const r = await db.prepare(
        `SELECT sport, season, COUNT(*) AS plays, COUNT(DISTINCT gameId) AS games,
                COUNT(DISTINCT playerId) AS players
           FROM plays GROUP BY sport, season
          HAVING COUNT(*) > 0 ORDER BY sport, season DESC`).all();
      return json({ seasons: r.results || [] });
    } catch (e) { return json({ error: 'could not list seasons' }, 503); }
  }

  if (url.searchParams.get('plays') === 'orphans') {
    const db = env.RATEBOARD_DB;
    if (!db) return json({ error: 'no database binding' }, 503);
    await playsReady(db);
    try {
      const r = await db.prepare(
        `SELECT p.gameId, COUNT(*) AS plays, MIN(p.seasonType) AS seasonType,
                MIN(p.season) AS playSeason,
                (SELECT MIN(g.day) FROM gamelog g WHERE g.sport=p.sport AND g.gameId=p.gameId) AS day,
                (SELECT MIN(g.season) FROM gamelog g WHERE g.sport=p.sport AND g.gameId=p.gameId) AS logSeason
           FROM plays p
          WHERE p.sport=?1 AND p.season=?2
            AND p.gameId NOT IN (SELECT DISTINCT gameId FROM gamelog
                                  WHERE sport=?1 AND season=?2 AND gameId IS NOT NULL)
          GROUP BY p.gameId ORDER BY p.gameId`).bind(sport, Number(season)).all();
      return json({ sport, season, orphanGames: r.results || [] });
    } catch (e) {
      return json({ error: 'could not look for orphans', detail: String((e && e.message) || e) }, 503);
    }
  }

  // Remove every play of one game. Used when a game turns out to belong to
  // another season, or needs collecting again from scratch.
  if (url.searchParams.get('plays') === 'drop') {
    const db = env.RATEBOARD_DB;
    if (!db) return json({ error: 'no database binding' }, 503);
    const ids = String(url.searchParams.get('gameId') || '')
      .split(',').map(x => x.trim()).filter(x => /^\d+$/.test(x)).slice(0, 50);
    if (!ids.length) return json({ error: 'gameId required' }, 400);
    let removed = 0;
    for (const g of ids) {
      try {
        const r = await db.prepare('DELETE FROM plays WHERE sport=? AND gameId=?')
          .bind(sport, Number(g)).run();
        removed += (r && r.meta && r.meta.changes) || 0;
      } catch (e) {}
    }
    return json({ sport, dropped: ids, rowsRemoved: removed });
  }

  if (url.searchParams.get('plays') === 'diag') {
    const db = env.RATEBOARD_DB;
    if (!db) return json({ error: 'no database binding' }, 503);
    await playsReady(db);
    const out = {};
    try {
      const t = await db.prepare(
        `SELECT id, label, rarity, altRarity FROM tags WHERE sport=? ORDER BY rarity DESC, label`)
        .bind(sport).all();
      out.tags = (t.results || []);
      out.conflicting = out.tags.filter(x => x.altRarity).map(x => x.label);
    } catch (e) {}
    try {
      const c = await db.prepare(
        `SELECT cat, type, subType, COUNT(*) AS n FROM plays WHERE sport=? AND season=?
         GROUP BY cat, type, subType ORDER BY cat, n DESC`).bind(sport, Number(season)).all();
      out.categories = (c.results || []);
    } catch (e) {}
    try {
      const k = await db.prepare(
        `SELECT label, subType, COUNT(*) AS n, ROUND(AVG(value),2) AS avgRating
           FROM plays WHERE sport=? AND season=? AND cat=205
             AND label NOT LIKE '%-yd FG'
          GROUP BY label, subType ORDER BY n DESC LIMIT 40`)
        .bind(sport, Number(season)).all();
      out.fieldGoalLabels = k.results || [];
    } catch (e) {}
    try {
      const u = await db.prepare(
        `SELECT COUNT(*) AS plays, COUNT(DISTINCT gameId) AS games,
                COUNT(DISTINCT playerId) AS players FROM plays WHERE sport=? AND season=?`)
        .bind(sport, Number(season)).first();
      out.held = u || {};
    } catch (e) {}
    return json(out);
  }

  if (url.searchParams.get('plays') === 'player') {
    const db = env.RATEBOARD_DB;
    if (!db) return json({ error: 'no database binding' }, 503);
    await playsReady(db);
    const pid = parseInt(url.searchParams.get('playerId') || '0', 10);
    if (!pid) return json({ error: 'playerId required' }, 400);
    const out = { sport, season, playerId: pid };
    try {
      const head = await db.prepare(
        `WITH credited AS (${CREDITED})
         SELECT MAX(pname) AS player, COUNT(*) AS plays, COUNT(*) AS allPlays,
                COUNT(DISTINCT gameId) AS games,
                ROUND(AVG(value), 2) AS avgRating, ROUND(MAX(value), 1) AS bestRating
           FROM credited WHERE pid = ?3`)
        .bind(sport, Number(season), pid).first();
      Object.assign(out, head || {});
      const cov = await db.prepare(
        `SELECT MAX(team) AS team, COUNT(DISTINCT gameId) AS played,
                COUNT(DISTINCT CASE WHEN gameId IN
                  (SELECT DISTINCT gameId FROM plays WHERE sport=?1 AND season=?2)
                  THEN gameId END) AS swept
           FROM gamelog WHERE sport=?1 AND season=?2 AND playerId=?3
             AND seasonType IN (${seasonTypeSql(sport)})`)
        .bind(sport, Number(season), pid).first();
      if (cov) {
        out.team = cov.team || null;
        out.gamesPlayed = Number(cov.played) || null;
        out.gamesCollected = Number(cov.swept) || null;
      }
      const rar = await db.prepare(
        `WITH credited AS (${CREDITED})
         SELECT COALESCE(rarity,0) AS r, COUNT(*) AS n FROM credited
          WHERE pid = ?3 GROUP BY r ORDER BY r`)
        .bind(sport, Number(season), pid).all();
      out.byRarity = {};
      for (const x of (rar.results || [])) out.byRarity[x.r] = Number(x.n);
      const fam = await db.prepare(
        `WITH credited AS (${CREDITED})
         SELECT cat, type, subType, COUNT(*) AS n,
                ROUND(AVG(value),2) AS avgRating, ROUND(MAX(value),1) AS bestRating
           FROM credited WHERE pid = ?3
          GROUP BY cat, type, subType ORDER BY n DESC`)
        .bind(sport, Number(season), pid).all();
      out.kinds = (fam.results || []).map(x => Object.assign({}, x,
        { family: playFamily(x.cat == null ? null : Number(x.cat), x.type, x.subType) }));
      // The game feed rarely carries a date, but the game log always knows
      // when the game was, so the day comes from there.
      const top = await db.prepare(
        `WITH credited AS (${CREDITED})
         SELECT c.id, COALESCE(c.day, (SELECT g.day FROM gamelog g
             WHERE g.sport=?1 AND g.gameId=c.gameId LIMIT 1)) AS day,
                c.gameId, p.label, c.value, COALESCE(c.rarity,0) AS rarity, c.cat, c.tags
           FROM credited c JOIN plays p ON p.id = c.id
          WHERE c.pid = ?3 ORDER BY c.value DESC LIMIT 250`)
        .bind(sport, Number(season), pid).all();
      out.top = top.results || [];
    } catch (e) {
      return json({ error: 'could not read the player', detail: String((e && e.message) || e) }, 503);
    }
    // Tag names for whatever showed up, so the detail can print them.
    try {
      const ids = new Set();
      for (const r of out.top) for (const b of String(r.tags || '').split(',')) {
        const n = Number(b); if (n) ids.add(n);
      }
      out.tagNames = {};
      if (ids.size) {
        const t = await db.prepare(
          `SELECT id, label FROM tags WHERE sport=? AND id IN (${[...ids].join(',')})`)
          .bind(sport).all();
        for (const x of (t.results || [])) out.tagNames[x.id] = x.label;
      }
    } catch (e) {}
    return json(out);
  }

  // A play's rarity is the highest rarity among its tags, which is how the
  // game decides it. Worked out here rather than at write time, because the
  // tag table is still filling in while plays are being collected.
  if (url.searchParams.get('plays') === 'score') {
    const db = env.RATEBOARD_DB;
    if (!db) return json({ error: 'no database binding' }, 503);
    await playsReady(db);
    let tagRar = new Map(), tagKeyById = new Map();
    const notPlay = new Set();
    try {
      const t = await db.prepare('SELECT id, rarity, label, hash, kind FROM tags WHERE sport=?')
        .bind(sport).all();
      for (const r of (t.results || [])) {
        // A performance tag belongs to a whole game, never to a snap. An
        // unseeded tag has no kind yet and is left alone.
        if (r.kind && r.kind !== 'play') { notPlay.add(Number(r.id)); continue; }
        tagRar.set(Number(r.id), Number(r.rarity) || 0);
        // The hashtag is what the rules are named after; the label is only
        // what the app prints.
        tagKeyById.set(Number(r.id), tagKey(r.hash || r.label));
      }
    } catch (e) {}
    if (!tagRar.size) return json({ error: 'no tags collected yet for this sport' }, 400);
    // Clear every score so the ordinary forward walk redoes the season. Used
    // when the rules or the tag table have changed under it.
    if (url.searchParams.get('reset') === '1') {
      try {
        await db.prepare('UPDATE plays SET rarity=NULL WHERE sport=? AND season=?')
          .bind(sport, Number(season)).run();
      } catch (e) { return json({ error: 'could not clear scores' }, 503); }
      return json({ sport, season, cleared: true });
    }
    let rows = [];
    try {
      const r = await db.prepare(
        `SELECT id, tags, cat, type, subType FROM plays WHERE sport=? AND season=? AND tags IS NOT NULL
         ${url.searchParams.get('all') === '1' ? '' : 'AND rarity IS NULL'}
         ORDER BY id LIMIT ${SCORE_BATCH}`).bind(sport, Number(season)).all();
      rows = r.results || [];
    } catch (e) { return json({ error: 'could not read plays' }, 503); }
    /* The ids are grouped by the rarity they came out at and written a few
       hundred at a time, so eight thousand plays cost about twenty statements
       rather than eight thousand. The sport has to be named: an id alone no
       longer points at one row. */
    const byLevel = new Map();
    let unknown = 0;
    const RULES = rulesFor(sport);
    const PINS = pinsFor(sport);
    const CEIL = baseCeiling(sport);
    const fam = {};
    for (const r of rows) {
      const spl = String(sport || '').toLowerCase();
      const cat = r.cat == null ? null : Number(r.cat);
      const f = playFamily(cat, r.type, r.subType, spl, 1);
      let best = 0, miss = false;
      for (const bit of String(r.tags).split(',')) {
        const id = Number(bit);
        if (!id || notPlay.has(id)) continue;
        // A pinned id has a name even when the tag table has never seen it.
        const key = tagKeyById.get(id) || PINS[id] || null;
        // The harvested number is the floor; a rule for this family wins.
        const rule = key ? RULES[key] : null;
        const ruled = rule ? (rule[f] != null ? rule[f] : rule['*']) : null;
        if (ruled == null && !tagRar.has(id)) { miss = true; continue; }
        const lvl = ruled != null ? ruled : Math.min(tagRar.get(id), CEIL);
        best = Math.max(best, lvl);
      }
      if (miss) unknown++;
      const cap = fumbleCap(cat, r.type, r.subType);
      if (cap != null && best > cap) best = cap;
      fam[f] = (fam[f] || 0) + 1;
      /* The second and third names on the play are worth working out again:
         in hockey the same row is a goal to one man and an assist to another.
         Everywhere else the family is the same for all of them, so this costs
         one comparison and the answer is reused. */
      const slots = { 1: best || 0 };
      for (const slot of [2, 3]) {
        const f2 = playFamily(cat, r.type, r.subType, spl, slot);
        if (f2 === f) { slots[slot] = slots[1]; continue; }
        let b2 = 0;
        for (const bit of String(r.tags).split(',')) {
          const id = Number(bit);
          if (!id || notPlay.has(id)) continue;
          const key = tagKeyById.get(id) || PINS[id] || null;
          const rule = key ? RULES[key] : null;
          const ruled = rule ? (rule[f2] != null ? rule[f2] : rule['*']) : null;
          if (ruled == null && !tagRar.has(id)) continue;
          b2 = Math.max(b2, ruled != null ? ruled : Math.min(tagRar.get(id), CEIL));
        }
        slots[slot] = b2;
      }
      for (const slot of [1, 2, 3]) {
        const col = slot === 1 ? 'rarity' : `rarity${slot}`;
        const k = `${col}|${slots[slot]}`;
        if (!byLevel.has(k)) byLevel.set(k, []);
        byLevel.get(k).push(Number(r.id));
      }
    }
    /* The ids go into the statement as numbers rather than as bound values:
       D1 allows only a hundred bound parameters per statement, and binding
       them silently matched nothing, so the same rows were read and rewritten
       for ever. They come from this database as integers and are coerced
       again here, so nothing but a number can reach the text. */
    const writes = [];
    for (const [k, ids] of byLevel) {
      const [col, lvlText] = String(k).split('|');
      const lvl = Number(lvlText);
      // The column name is one of three literals chosen above, never input.
      const COL = col === 'rarity2' ? 'rarity2' : col === 'rarity3' ? 'rarity3' : 'rarity';
      for (let i = 0; i < ids.length; i += 800) {
        const list = ids.slice(i, i + 800).map(x => Number(x))
          .filter(Number.isFinite).join(',');
        if (!list) continue;
        writes.push(db.prepare(
          `UPDATE plays SET ${COL}=? WHERE sport=? AND id IN (${list})`).bind(lvl, sport));
      }
    }
    for (let i = 0; i < writes.length; i += 10) {
      try { await db.batch(writes.slice(i, i + 10)); } catch (e) {}
    }
    // Which of the named top-end tags we still have no id for: until one
    // turns up in a listing, a play carrying it cannot be recognised.
    const haveKeys = new Set([...tagKeyById.values(), ...Object.values(PINS)]);
    const missingRuleTags = Object.keys(RULES).filter(k => !haveKeys.has(k));
    return json({ sport, season, scored: rows.length, tagsKnown: tagRar.size,
                  playsWithAnUnknownTag: unknown, families: fam, missingRuleTags });
  }

  // One row per player: how many card plays they have and how many are the
  // top tier. Everything else is in the table behind it.
  if (url.searchParams.get('plays') === 'board') {
    const db = env.RATEBOARD_DB;
    if (!db) return json({ error: 'no database binding' }, 503);
    await playsReady(db);
    const q = String(url.searchParams.get('q') || '').slice(0, 60);
    // Odds off a handful of plays say nothing, so the board starts at ten.
    const minPlays = Math.max(0, Math.min(500,
      parseInt(url.searchParams.get('min') || '10', 10) || 0));

    /* One or many seasons. Each is queried on its own and the results are
       concatenated, so a player who appears in three seasons gets three rows
       rather than one blended one - their 2023 odds and their 2026 odds are
       different questions. */
    const pairs = [];
    for (const bit of String(url.searchParams.get('seasons') || '').split(',').slice(0, 12)) {
      const [sp, se] = String(bit).split(':');
      if (sp && /^\d{4}$/.test(String(se || ''))) pairs.push({ sport: sp, season: Number(se) });
    }
    if (!pairs.length) pairs.push({ sport, season: Number(season) });

    const rows = [], errors = [];
    for (const pr of pairs) {
      try {
        const r = await db.prepare(
          `WITH credited AS (${CREDITED})
           SELECT pid AS playerId, MAX(pname) AS player, MAX(season) AS season,
                  COUNT(*) AS plays,
                  SUM(CASE WHEN rarity = 7 THEN 1 ELSE 0 END) AS iconic,
                  SUM(CASE WHEN rarity = 6 THEN 1 ELSE 0 END) AS mystic,
                  SUM(CASE WHEN rarity = 5 THEN 1 ELSE 0 END) AS legendary,
                  SUM(CASE WHEN rarity = 4 THEN 1 ELSE 0 END) AS epic,
                  ROUND(AVG(value), 2) AS avgRating, ROUND(MAX(value), 1) AS bestRating
             FROM credited
            WHERE pname IS NOT NULL AND (?3 = '' OR pname LIKE ?4)
            GROUP BY pid HAVING COUNT(*) >= ?5
            ORDER BY plays DESC LIMIT 4000`)
          .bind(pr.sport, pr.season, q, `%${q}%`, minPlays).all();
        const got = r.results || [];

        // Season earnings and the latest owner count, both from the game log
        // side of the house rather than the play feed.
        const extra = new Map();
        try {
          const e = await db.prepare(
            /* The owner count used to be a correlated subquery, which meant
               one index seek per player - seven thousand of them for a CFB
               season, and the reason loading several seasons at once blew
               through D1's CPU limit. One windowed pass does the same job. */
            `WITH latest AS (
               SELECT playerId, owners FROM (
                 SELECT playerId, owners,
                        ROW_NUMBER() OVER (PARTITION BY playerId ORDER BY day DESC) AS rn
                   FROM owners WHERE sport=?1 AND season=?2)
                WHERE rn = 1)
             SELECT g.playerId AS playerId, SUM(g.rax) AS earnings,
                    MAX(g.team) AS team, l.owners AS owners
               FROM gamelog g LEFT JOIN latest l ON l.playerId = g.playerId
              WHERE g.sport=?1 AND g.season=?2
                AND g.seasonType IN (${seasonTypeSql(pr.sport)})
              GROUP BY g.playerId`).bind(pr.sport, pr.season).all();
          for (const x of (e.results || [])) extra.set(Number(x.playerId), x);
        } catch (err) {}
        for (const x of got) {
          const ex = extra.get(Number(x.playerId));
          x.sport = pr.sport;
          x.season = pr.season;
          x.earnings = ex ? Number(ex.earnings) || 0 : null;
          x.owners = ex && ex.owners != null ? Number(ex.owners) : null;
          x.team = ex ? ex.team : null;
          rows.push(x);
        }
      } catch (e) {
        // One bad season must not take the rest down, but swallowing the
        // reason turns a broken query into an empty table, which is worse.
        errors.push({ sport: pr.sport, season: pr.season,
                      error: String((e && e.message) || e).slice(0, 300) });
      }
    }
    rows.sort((a, b) => b.plays - a.plays);
    return json(Object.assign({ seasons: pairs, q, minPlays, rows },
      errors.length ? { errors } : {}));
  }

  if (url.searchParams.get('plays') === 'player') {
    const db = env.RATEBOARD_DB;
    if (!db) return json({ error: 'no database binding' }, 503);
    await playsReady(db);
    const pid = parseInt(url.searchParams.get('playerId') || '0', 10);
    if (!pid) return json({ error: 'playerId required' }, 400);
    const out = { sport, season, playerId: pid };
    try {
      const head = await db.prepare(
        `WITH credited AS (${CREDITED})
         SELECT MAX(pname) AS player, COUNT(*) AS plays, COUNT(*) AS allPlays,
                COUNT(DISTINCT gameId) AS games,
                ROUND(AVG(value), 2) AS avgRating, ROUND(MAX(value), 1) AS bestRating
           FROM credited WHERE pid = ?3`)
        .bind(sport, Number(season), pid).first();
      Object.assign(out, head || {});
      const cov = await db.prepare(
        `SELECT MAX(team) AS team, COUNT(DISTINCT gameId) AS played,
                COUNT(DISTINCT CASE WHEN gameId IN
                  (SELECT DISTINCT gameId FROM plays WHERE sport=?1 AND season=?2)
                  THEN gameId END) AS swept
           FROM gamelog WHERE sport=?1 AND season=?2 AND playerId=?3
             AND seasonType IN (${seasonTypeSql(sport)})`)
        .bind(sport, Number(season), pid).first();
      if (cov) {
        out.team = cov.team || null;
        out.gamesPlayed = Number(cov.played) || null;
        out.gamesCollected = Number(cov.swept) || null;
      }
      const rar = await db.prepare(
        `WITH credited AS (${CREDITED})
         SELECT COALESCE(rarity,0) AS r, COUNT(*) AS n FROM credited
          WHERE pid = ?3 GROUP BY r ORDER BY r`)
        .bind(sport, Number(season), pid).all();
      out.byRarity = {};
      for (const x of (rar.results || [])) out.byRarity[x.r] = Number(x.n);
      const fam = await db.prepare(
        `WITH credited AS (${CREDITED})
         SELECT cat, type, subType, COUNT(*) AS n,
                ROUND(AVG(value),2) AS avgRating, ROUND(MAX(value),1) AS bestRating
           FROM credited WHERE pid = ?3
          GROUP BY cat, type, subType ORDER BY n DESC`)
        .bind(sport, Number(season), pid).all();
      out.kinds = (fam.results || []).map(x => Object.assign({}, x,
        { family: playFamily(x.cat == null ? null : Number(x.cat), x.type, x.subType) }));
      // The game feed rarely carries a date, but the game log always knows
      // when the game was, so the day comes from there.
      const top = await db.prepare(
        `WITH credited AS (${CREDITED})
         SELECT c.id, COALESCE(c.day, (SELECT g.day FROM gamelog g
             WHERE g.sport=?1 AND g.gameId=c.gameId LIMIT 1)) AS day,
                c.gameId, p.label, c.value, COALESCE(c.rarity,0) AS rarity, c.cat, c.tags
           FROM credited c JOIN plays p ON p.id = c.id
          WHERE c.pid = ?3 ORDER BY c.value DESC LIMIT 250`)
        .bind(sport, Number(season), pid).all();
      out.top = top.results || [];
    } catch (e) {
      return json({ error: 'could not read the player', detail: String((e && e.message) || e) }, 503);
    }
    // Tag names for whatever showed up, so the detail can print them.
    try {
      const ids = new Set();
      for (const r of out.top) for (const b of String(r.tags || '').split(',')) {
        const n = Number(b); if (n) ids.add(n);
      }
      out.tagNames = {};
      if (ids.size) {
        const t = await db.prepare(
          `SELECT id, label FROM tags WHERE sport=? AND id IN (${[...ids].join(',')})`)
          .bind(sport).all();
        for (const x of (t.results || [])) out.tagNames[x.id] = x.label;
      }
    } catch (e) {}
    return json(out);
  }

  // A play's rarity is the highest rarity among its tags, which is how the
  // game decides it. Worked out here rather than at write time, because the
  // tag table is still filling in while plays are being collected.
  if (url.searchParams.get('plays') === 'score') {
    const db = env.RATEBOARD_DB;
    if (!db) return json({ error: 'no database binding' }, 503);
    await playsReady(db);
    let tagRar = new Map(), tagKeyById = new Map();
    const notPlay = new Set();
    try {
      const t = await db.prepare('SELECT id, rarity, label, hash, kind FROM tags WHERE sport=?')
        .bind(sport).all();
      for (const r of (t.results || [])) {
        // A performance tag belongs to a whole game, never to a snap. An
        // unseeded tag has no kind yet and is left alone.
        if (r.kind && r.kind !== 'play') { notPlay.add(Number(r.id)); continue; }
        tagRar.set(Number(r.id), Number(r.rarity) || 0);
        // The hashtag is what the rules are named after; the label is only
        // what the app prints.
        tagKeyById.set(Number(r.id), tagKey(r.hash || r.label));
      }
    } catch (e) {}
    if (!tagRar.size) return json({ error: 'no tags collected yet for this sport' }, 400);
    // Clear every score so the ordinary forward walk redoes the season. Used
    // when the rules or the tag table have changed under it.
    if (url.searchParams.get('reset') === '1') {
      try {
        await db.prepare('UPDATE plays SET rarity=NULL WHERE sport=? AND season=?')
          .bind(sport, Number(season)).run();
      } catch (e) { return json({ error: 'could not clear scores' }, 503); }
      return json({ sport, season, cleared: true });
    }
    let rows = [];
    try {
      const r = await db.prepare(
        `SELECT id, tags, cat, type, subType FROM plays WHERE sport=? AND season=? AND tags IS NOT NULL
         ${url.searchParams.get('all') === '1' ? '' : 'AND rarity IS NULL'}
         ORDER BY id LIMIT ${SCORE_BATCH}`).bind(sport, Number(season)).all();
      rows = r.results || [];
    } catch (e) { return json({ error: 'could not read plays' }, 503); }
    /* The ids are grouped by the rarity they came out at and written a few
       hundred at a time, so eight thousand plays cost about twenty statements
       rather than eight thousand. The sport has to be named: an id alone no
       longer points at one row. */
    const byLevel = new Map();
    let unknown = 0;
    const RULES = rulesFor(sport);
    const PINS = pinsFor(sport);
    const CEIL = baseCeiling(sport);
    const fam = {};
    for (const r of rows) {
      const spl = String(sport || '').toLowerCase();
      const cat = r.cat == null ? null : Number(r.cat);
      const f = playFamily(cat, r.type, r.subType, spl, 1);
      let best = 0, miss = false;
      for (const bit of String(r.tags).split(',')) {
        const id = Number(bit);
        if (!id || notPlay.has(id)) continue;
        // A pinned id has a name even when the tag table has never seen it.
        const key = tagKeyById.get(id) || PINS[id] || null;
        // The harvested number is the floor; a rule for this family wins.
        const rule = key ? RULES[key] : null;
        const ruled = rule ? (rule[f] != null ? rule[f] : rule['*']) : null;
        if (ruled == null && !tagRar.has(id)) { miss = true; continue; }
        const lvl = ruled != null ? ruled : Math.min(tagRar.get(id), CEIL);
        best = Math.max(best, lvl);
      }
      if (miss) unknown++;
      const cap = fumbleCap(cat, r.type, r.subType);
      if (cap != null && best > cap) best = cap;
      fam[f] = (fam[f] || 0) + 1;
      /* The second and third names on the play are worth working out again:
         in hockey the same row is a goal to one man and an assist to another.
         Everywhere else the family is the same for all of them, so this costs
         one comparison and the answer is reused. */
      const slots = { 1: best || 0 };
      for (const slot of [2, 3]) {
        const f2 = playFamily(cat, r.type, r.subType, spl, slot);
        if (f2 === f) { slots[slot] = slots[1]; continue; }
        let b2 = 0;
        for (const bit of String(r.tags).split(',')) {
          const id = Number(bit);
          if (!id || notPlay.has(id)) continue;
          const key = tagKeyById.get(id) || PINS[id] || null;
          const rule = key ? RULES[key] : null;
          const ruled = rule ? (rule[f2] != null ? rule[f2] : rule['*']) : null;
          if (ruled == null && !tagRar.has(id)) continue;
          b2 = Math.max(b2, ruled != null ? ruled : Math.min(tagRar.get(id), CEIL));
        }
        slots[slot] = b2;
      }
      for (const slot of [1, 2, 3]) {
        const col = slot === 1 ? 'rarity' : `rarity${slot}`;
        const k = `${col}|${slots[slot]}`;
        if (!byLevel.has(k)) byLevel.set(k, []);
        byLevel.get(k).push(Number(r.id));
      }
    }
    /* The ids go into the statement as numbers rather than as bound values:
       D1 allows only a hundred bound parameters per statement, and binding
       them silently matched nothing, so the same rows were read and rewritten
       for ever. They come from this database as integers and are coerced
       again here, so nothing but a number can reach the text. */
    const writes = [];
    for (const [k, ids] of byLevel) {
      const [col, lvlText] = String(k).split('|');
      const lvl = Number(lvlText);
      // The column name is one of three literals chosen above, never input.
      const COL = col === 'rarity2' ? 'rarity2' : col === 'rarity3' ? 'rarity3' : 'rarity';
      for (let i = 0; i < ids.length; i += 800) {
        const list = ids.slice(i, i + 800).map(x => Number(x))
          .filter(Number.isFinite).join(',');
        if (!list) continue;
        writes.push(db.prepare(
          `UPDATE plays SET ${COL}=? WHERE sport=? AND id IN (${list})`).bind(lvl, sport));
      }
    }
    for (let i = 0; i < writes.length; i += 10) {
      try { await db.batch(writes.slice(i, i + 10)); } catch (e) {}
    }
    // Which of the named top-end tags we still have no id for: until one
    // turns up in a listing, a play carrying it cannot be recognised.
    const haveKeys = new Set([...tagKeyById.values(), ...Object.values(PINS)]);
    const missingRuleTags = Object.keys(RULES).filter(k => !haveKeys.has(k));
    return json({ sport, season, scored: rows.length, tagsKnown: tagRar.size,
                  playsWithAnUnknownTag: unknown, families: fam, missingRuleTags });
  }

  // One row per player: how many card plays they have and how many are the
  // top tier. Everything else is in the table behind it.
  if (url.searchParams.get('plays') === 'board') {
    const db = env.RATEBOARD_DB;
    if (!db) return json({ error: 'no database binding' }, 503);
    await playsReady(db);
    const q = String(url.searchParams.get('q') || '').slice(0, 60);
    // Odds off a handful of plays say nothing, so the board starts at ten.
    const minPlays = Math.max(0, Math.min(500,
      parseInt(url.searchParams.get('min') || '10', 10) || 0));
    try {
      const rowsQ = await db.prepare(
        `WITH credited AS (${CREDITED})
         SELECT pid AS playerId, MAX(pname) AS player,
                COUNT(*) AS plays,
                SUM(CASE WHEN rarity = 7 THEN 1 ELSE 0 END) AS iconic,
                SUM(CASE WHEN rarity = 6 THEN 1 ELSE 0 END) AS mystic,
                SUM(CASE WHEN rarity = 5 THEN 1 ELSE 0 END) AS legendary,
                SUM(CASE WHEN rarity = 4 THEN 1 ELSE 0 END) AS epic,
                COUNT(DISTINCT gameId) AS gamesSeen,
                ROUND(AVG(value), 2) AS avgRating, ROUND(MAX(value), 1) AS bestRating
           FROM credited
          WHERE pname IS NOT NULL AND (?3 = '' OR pname LIKE ?4)
          GROUP BY pid HAVING COUNT(*) >= ?5
          ORDER BY plays DESC, legendary DESC LIMIT 4000`)
        .bind(sport, Number(season), q, `%${q}%`, minPlays).all();
      const tot = await db.prepare(
        `SELECT COUNT(*) AS all_, SUM(CASE WHEN ${CARD_SQL} THEN 1 ELSE 0 END) AS cards,
                SUM(CASE WHEN rarity IS NULL THEN 1 ELSE 0 END) AS unscored, MAX(seenAt) AS seenAt
           FROM plays WHERE sport=? AND season=?`).bind(sport, Number(season)).first();
      /* How much of each player's season we hold. The player's own game log
         rows are NOT a safe denominator: the log has gaps, so a player can
         look complete only because the log never heard about the games we
         are missing. A team's games are the union over all its players, so
         they are far closer to the real schedule. */
      const rows = rowsQ.results || [];
      /* Coverage is about whether we have swept the games a player appeared
         in, not whether they happened to mint a card in them. A quiet game
         with no collectible play is still a collected game. */
      try {
        const g = await db.prepare(
          `SELECT playerId, MAX(team) AS team,
                  COUNT(DISTINCT gameId) AS played,
                  COUNT(DISTINCT CASE WHEN gameId IN
                    (SELECT DISTINCT gameId FROM plays WHERE sport=?1 AND season=?2)
                    THEN gameId END) AS swept
             FROM gamelog
            WHERE sport=?1 AND season=?2 AND seasonType IN (${seasonTypeSql(sport)})
            GROUP BY playerId`).bind(sport, Number(season)).all();
        const own = new Map();
        for (const r of (g.results || [])) own.set(Number(r.playerId), r);
        for (const r of rows) {
          const o = own.get(Number(r.playerId));
          r.gamesPlayed = o ? Number(o.played) : null;
          r.gamesCollected = o ? Number(o.swept) : null;
          r.team = o ? o.team : null;
        }
      } catch (e) {}
      // Season-wide progress, so the page can say how far along the sweep is.
      /* Two separate gaps, reported separately because they have different
         causes: the game log may be behind the real schedule, and the play
         sweep may be behind the game log. */
      let progress = {};
      try {
        const p1 = await db.prepare(
          `SELECT COUNT(DISTINCT gameId) AS n, MAX(day) AS newest FROM gamelog
            WHERE sport=? AND season=? AND seasonType IN (${seasonTypeSql(sport)})`)
          .bind(sport, Number(season)).first();
        const p2 = await db.prepare(
          `SELECT COUNT(DISTINCT gameId) AS n FROM plays WHERE sport=? AND season=?`)
          .bind(sport, Number(season)).first();
        const p3 = await db.prepare(
          `SELECT MAX(n) AS mx, MIN(n) AS mn, COUNT(*) AS teams, SUM(n) AS total FROM (
             SELECT team, COUNT(DISTINCT gameId) AS n FROM gamelog
              WHERE sport=? AND season=? AND seasonType IN (${seasonTypeSql(sport)})
              GROUP BY team)`).bind(sport, Number(season)).first();
        const mx = Number((p3 || {}).mx) || 0, teams = Number((p3 || {}).teams) || 0;
        // Teams on a bye have played fewer, so the expected total is the sum
        // of what each team has actually played, halved - not max x teams,
        // which reads as a shortfall every bye week.
        const totalTeamGames = Number((p3 || {}).total) || 0;
        progress = {
          logGames: Number((p1 || {}).n) || 0,
          logNewestDay: (p1 || {}).newest || null,
          collectedGames: Number((p2 || {}).n) || 0,
          teams, teamGamesMax: mx, teamGamesMin: Number((p3 || {}).mn) || 0,
          // If the log were complete every team would show the same count, and
          // teams x games / 2 would equal the games held.
          expectedIfComplete: totalTeamGames ? Math.round(totalTeamGames / 2) : 0
        };
      } catch (e) {}
      return json({ sport, season, q, minPlays, rows, progress, totals: tot || {} });
    } catch (e) {
      return json({ error: 'could not read the play board', detail: String((e && e.message) || e) }, 503);
    }
  }

  // Game level reads. The team tab on a game page calls .../stats, and the
  // player endpoint spells its play feed /plays, so those are the two fixed
  // shapes here. gameId is digits, sport is validated above.
  /* A performance is the player's whole game line, a separate card type from
     the plays. The game feed carries an empty box-score array, but the player
     seasonfeed is what the game log already reads, so look there. */
  if (url.searchParams.get('perfProbe') != null) {
    const pid = String(url.searchParams.get('perfProbe') || '').replace(/[^0-9]/g, '');
    if (!pid) return json({ error: 'perfProbe needs a playerId' }, 400);
    try {
      const d = await rsGet(`https://web.realapp.com/players/${pid}/sport/${sport}`
        + `/seasonfeed?limit=5&season=${season}&view=recent&viewFrame=default`, auth);
      const bs = (d && d.playerBoxScores) || [];
      const first = bs[0] || null;
      const tagsOf = r => [].concat(r.tags || [], r.traitIds || [], r.traits || [],
                                    r.crowdTags || []);
      return json({
        playerId: pid, topKeys: Object.keys(d || {}),
        boxScores: bs.length,
        rowKeys: first ? Object.keys(first) : [],
        // performanceTags is the one that matters: `tags` is every play tag
        // from the game concatenated, not the performance card's own.
        sample: bs.slice(0, 4).map(r => ({
          gameId: r.gameId, day: r.day, value: r.value, seasonType: r.seasonType,
          performanceTags: r.performanceTags,
          performanceTagsManual: r.performanceTagsManual,
          playTagCount: (r.tags || []).length,
          topStats: r.topStats, label: r.label
        })),
        perfData: d && d.perfData ? (Array.isArray(d.perfData)
          ? { count: d.perfData.length, first: d.perfData[0] }
          : Object.keys(d.perfData)) : null
      });
    } catch (e) { return json({ error: String((e && e.message) || e).slice(0, 200) }, 502); }
  }

  if (url.searchParams.get('probeGame') != null) {
    const gid = String(url.searchParams.get('probeGame') || '').replace(/[^0-9]/g, '');
    if (!gid) return json({ error: 'bad gameId' }, 400);
    const lim = Math.max(1, Math.min(1000, parseInt(url.searchParams.get('limit') || '25', 10) || 25));
    // limit is ignored by this one, so the cursor has to be found by name.
    // Only the handful the rest of this API already uses are allowed through.
    const PG = ['start', 'offset', 'page', 'before', 'after', 'sequence', 'cursor'];
    const pgName = PG.includes(String(url.searchParams.get('pg') || '')) ? url.searchParams.get('pg') : null;
    const pgVal = String(url.searchParams.get('pgv') || '0').replace(/[^0-9]/g, '') || '0';
    const q = new URLSearchParams({ limit: String(lim) });
    if (pgName) q.set(pgName, pgVal);
    const SUBS_G = { stats: 'stats', plays: `plays?${q.toString()}`, plain: 'plays',
                     feed: 'feed?version=2&view=all&viewFrame=default' };
    const which = String(url.searchParams.get('sub') || 'plays').toLowerCase();
    const tail = SUBS_G[which];
    if (!tail) return json({ error: 'sub must be stats, plays or playstop' }, 400);
    try {
      const d = await rsGet(`https://web.realapp.com/games/${gid}/sport/${sport}/${tail}`, auth);
      // What the feed holds besides plays: the per-game performance entries,
      // which are their own card type with their own tags.
      if (url.searchParams.get('perf') === '1') {
        const bs = (d && d.matchPlayerBoxScores) || [];
        const first = bs[0] || null;
        const tagIds = [...new Set(bs.flatMap(r =>
          [].concat(r.tags || [], r.traitIds || [], r.crowdTags || [])
            .map(x => (x && x.id != null) ? Number(x.id) : Number(x))
            .filter(n => Number.isFinite(n))))];
        return json({
          gameId: gid, boxScores: bs.length,
          keys: first ? Object.keys(first) : [],
          distinctTagIds: tagIds.length, sampleTagIds: tagIds.slice(0, 40),
          sample: bs.slice(0, 3).map(r => ({
            playerId: r.playerId, player: playName(r.player) || r.playerName || null,
            value: r.value, performanceValue: r.performanceValue,
            rating: r.rating, label: r.label, metricLabel: r.metricLabel,
            cat: r.collectingCategoryId, tags: r.tags, traitIds: r.traitIds,
            crowdTags: r.crowdTags, seasonType: r.seasonType
          }))
        });
      }
      const rows = rowsOf(d);
      const arr = Array.isArray(d && d.plays) ? d.plays
                : Array.isArray(d && d.feed) ? d.feed
                : Array.isArray(d && d.items) ? d.items : rows;
      // Which plays mint a card is the question, so report how the category
      // field lines up with play type rather than a sample of rows.
      const withCat = arr.filter(r => r.collectingCategoryId != null);
      const byCat = {};
      for (const r of arr) {
        const k = r.collectingCategoryId == null ? 'none' : String(r.collectingCategoryId);
        (byCat[k] = byCat[k] || []).push(`${r.type}/${r.subType}`);
      }
      return json({ gameId: gid, sub: which, paged: pgName ? `${pgName}=${pgVal}` : 'none',
        firstId: arr[0] ? arr[0].id : null, lastId: arr.length ? arr[arr.length - 1].id : null,
        keys: Object.keys(d || {}), count: arr.length,
        firstRowKeys: arr[0] ? Object.keys(arr[0]) : [],
        withCategory: withCat.length,
        categories: Object.fromEntries(Object.entries(byCat).map(([k, v]) =>
          [k, { n: v.length, kinds: [...new Set(v)].slice(0, 8) }])),
        tagsSeen: [...new Set(arr.flatMap(r => Array.isArray(r.tags) ? r.tags : []))].length,
        sample: arr.slice(0, 4).map(r => ({ label: r.label, value: r.value,
          cat: r.collectingCategoryId, type: r.type, subType: r.subType, tags: r.tags })),
        // Who a play is filed under. Baseball files a strikeout from the
        // batter's side, so this is how to see which name sits in which slot
        // before deciding who the card belongs to.
        who: arr.filter(r => r.collectingCategoryId != null)
          .slice(0, 10).map(r => ({ type: r.type, subType: r.subType,
            cat: r.collectingCategoryId, value: r.value, label: r.label,
            tags: r.tags,
            primary: playName(r.primaryPlayer), primaryId: r.primaryPlayerId,
            secondary: playName(r.secondaryPlayer), secondaryId: r.secondaryPlayerId,
            tertiary: playName(r.tertiaryPlayer), tertiaryId: r.tertiaryPlayerId,
            quaternary: playName(r.quaternaryPlayer), quaternaryId: r.quaternaryPlayerId })) });
    } catch (e) {
      return json({ gameId: gid, sub: which, error: String((e && e.message) || e).slice(0, 160) }, 502);
    }
  }

  // The tag list. Rarity is not on a play - it comes from the tags on it, and
  // this is what the tag picker calls. Fixed shape: sport is validated, type
  // is a short word, and the play id is digits only.
  /* Is there such a thing as a player link? Walk whole payloads and report
     every key that sounds like one and every value that looks like a URL or a
     slug, so the answer is what the API actually carries rather than a guess
     at a URL shape. */
  if (url.searchParams.get('linkhunt') != null) {
    const pid = String(url.searchParams.get('playerId') || '').replace(/[^0-9]/g, '');
    const gid = String(url.searchParams.get('gameId') || '').replace(/[^0-9]/g, '');
    const LINKY = /(url|link|slug|share|deep|permalink|handle|username|web|uri|path|href)/i;
    const hits = {}, urls = new Set(), playerKeys = {};
    function walk(node, path, depth) {
      if (node == null || depth > 7) return;
      if (typeof node === 'string') {
        if (/^https?:\/\//i.test(node)) urls.add(node.slice(0, 160));
        return;
      }
      if (Array.isArray(node)) { node.slice(0, 4).forEach((x, i) => walk(x, `${path}[${i}]`, depth + 1)); return; }
      if (typeof node !== 'object') return;
      for (const k of Object.keys(node)) {
        const v = node[k];
        if (LINKY.test(k) && (typeof v === 'string' || typeof v === 'number')) {
          hits[`${path}.${k}`] = String(v).slice(0, 160);
        }
        walk(v, `${path}.${k}`, depth + 1);
      }
    }
    const out = { sport, asked: [] };
    const tries = [];
    if (pid) {
      tries.push(['player', `https://web.realapp.com/players/${pid}/sport/${sport}`]);
      tries.push(['seasonfeed', `https://web.realapp.com/players/${pid}/sport/${sport}`
        + `/seasonfeed?limit=5&season=${season}&view=recent&viewFrame=default`]);
      tries.push(['playercard', `https://web.realapp.com/players/${pid}/sport/${sport}/card`]);
    }
    if (gid) tries.push(['gamefeed',
      `https://web.realapp.com/games/${gid}/sport/${sport}/feed?version=2&view=all&viewFrame=default`]);
    for (const [name, u] of tries) {
      try {
        const d = await rsGet(u, auth);
        out.asked.push({ name, ok: true, keys: Object.keys(d || {}).slice(0, 30) });
        walk(d, name, 0);
        // The shape of one player object, whole, is the thing worth seeing.
        const pl = (d && (d.player || (Array.isArray(d.players) && d.players[0]))) || null;
        if (pl && !playerKeys[name]) playerKeys[name] = Object.keys(pl);
      } catch (e) {
        out.asked.push({ name, ok: false, why: String((e && e.message) || e).slice(0, 120) });
      }
    }
    // The shape of perfData, which is where the only paths turned up.
    if (url.searchParams.get('dump') === 'perf' && pid) {
      try {
        const d = await rsGet(`https://web.realapp.com/players/${pid}/sport/${sport}`
          + `/seasonfeed?limit=8&season=${season}&view=recent&viewFrame=default`, auth);
        out.perfData = JSON.parse(JSON.stringify(d && d.perfData || null)).slice ? null : (d && d.perfData);
        out.perfDataRaw = JSON.stringify(d && d.perfData || null).slice(0, 4000);
        const bs = (d && d.playerBoxScores) || [];
        out.boxScoreKeys = bs[0] ? Object.keys(bs[0]) : [];
        out.boxScoreSample = bs.slice(0, 3).map(r => ({
          id: r.id, gameId: r.gameId, day: r.day, value: r.value,
          path: r.path, url: r.url, slug: r.slug, shareUrl: r.shareUrl }));
      } catch (e) { out.perfErr = String((e && e.message) || e).slice(0, 160); }
    }
    out.linkishKeys = hits;
    out.playerObjectKeys = playerKeys;
    out.urlsSeen = [...urls].slice(0, 40);
    return json(out);
  }

  if (url.searchParams.get('probeTags') != null) {
    const type = String(url.searchParams.get('type') || 'tags').toLowerCase();
    if (!/^[a-z]{1,16}$/.test(type)) return json({ error: 'bad type' }, 400);
    const playId = String(url.searchParams.get('playId') || '').replace(/[^0-9]/g, '');
    const q = new URLSearchParams({ type });
    if (playId) q.set('playId', playId);
    const term = String(url.searchParams.get('q') || '');
    if (term && /^[a-zA-Z0-9 ]{1,24}$/.test(term)) q.set('search', term);
    try {
      const d = await rsGet(`https://web.realapp.com/tagsearch/${sport}?${q.toString()}`, auth);
      // The reply keys this under tags / categorizedTags rather than the rows
      // shape the rest of the API uses, so take it as it comes.
      const tags = Array.isArray(d && d.tags) ? d.tags : rowsOf(d);
      return json({ type, keys: Object.keys(d || {}), count: tags.length,
                    firstRowKeys: tags[0] ? Object.keys(tags[0]) : [],
                    categories: Array.isArray(d && d.categorizedTags)
                      ? d.categorizedTags.map(c => ({ keys: Object.keys(c || {}),
                          label: c.label || c.name || null,
                          n: Array.isArray(c.tags) ? c.tags.length : null })) : null,
                    tags: tags.slice(0, 150) });
    } catch (e) {
      return json({ error: 'tagsearch failed', detail: String((e && e.message) || e) }, 502);
    }
  }

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
    holders:    'holders?season=SEASON',
    // The play by play, found by watching the Plays tab on a player profile
    // call it. Every play carries its own rating, and its rarity comes from
    // the tags on it rather than from the rating. limit and viewFrame are
    // settable so the ceiling on "top" can be measured.
    playstop:   'plays/top?limit=LIMIT&viewFrame=FRAME'
  };
  const probeSub = url.searchParams.get('probeSub');
  if (probeSub && probePlayer && /^\d+$/.test(probePlayer)) {
    const suffix = SUBS[probeSub.toLowerCase()];
    if (!suffix) return json({ error: 'sub not allowed', allowed: Object.keys(SUBS) }, 400);
    const lim = Math.max(1, Math.min(2000, parseInt(url.searchParams.get('probeLimit') || '10', 10) || 10));
    const frame = /^[a-z]{1,12}$/.test(String(url.searchParams.get('probeFrame') || 'season').toLowerCase())
      ? String(url.searchParams.get('probeFrame') || 'season').toLowerCase() : 'season';
    const u = `https://web.realapp.com/players/${probePlayer}/sport/${sport}/`
      + suffix.replace('SEASON', season).replace('LIMIT', String(lim)).replace('FRAME', frame);
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
  if (['next', 'resume', 'stuck', 'rescan'].includes(url.searchParams.get('queue'))) {
    const db = env.RATEBOARD_DB;
    // Plays ride the same tick as the game log, on their own clock so the two
    // never ask Real for things at the same moment.
    if (url.searchParams.get('queue') === 'next' && db) {
      const PK = 'plays_tick_v1';
      let st = {};
      try { st = JSON.parse((await env.RATEBOARD_KV.get(PK)) || '{}') || {}; } catch (e) {}
      const n = Number(st.n || 0) + 1;
      st.n = n;
      try { await env.RATEBOARD_KV.put(PK, JSON.stringify(st)); } catch (e) {}
      /* One job per tick, never two calls to Real at once. Scoring has to
         keep pace with collection now that whole back seasons are coming in,
         so it runs every fifth tick rather than twice an hour. */
      /* Collecting used to take every other tick and idle on the rest. The
         idle half is now spent collecting too, which is most of the speed-up;
         scoring and the tag sweep keep the ticks they had. */
      /* Rating a season now takes seconds rather than hours, so it is back to
         an occasional tick and collecting gets nearly all of them. */
      /* Scoring was one tick in ten and, worse, picked its season from the
         whole queue on a stride that only ever landed on even positions, so
         half the queue - NBA 2026 among them - could never be scored by this
         step at all and only ever got the rating that collection does inline.
         It now takes one tick in three and works the same season the games
         step is on, so a season is rated as it fills instead of long after. */
      const step = n % 30 === 0 ? 'tags' : n % 3 === 2 ? 'score' : 'games';
      if (step) {
        /* Strict order. Every queue line carries a pri; the lowest pri with
           anything left takes the tick, so the backlog is worked in the order
           it is written rather than all at once. A rolling season that has
           already lapped still gets every twelfth game tick, which is enough
           to pick up a weekend's new games without stalling the backfill. */
        const fresh = [], done = [];
        for (const x of PLAYS_SPORTS) {
          let lapped = null;
          try { lapped = await env.RATEBOARD_KV.get(sweptKey(x.sport, x.season)); } catch (e) {}
          (lapped ? done : fresh).push(x);
        }
        const rolling = done.filter(x => x.rolling);
        let pool = [];
        if (fresh.length && !(n % REFRESH_EVERY === 0 && rolling.length)) {
          const top = Math.min(...fresh.map(x => Number(x.pri) || 99));
          pool = fresh.filter(x => (Number(x.pri) || 99) === top);
        } else if (rolling.length) {
          pool = rolling;
        }
        /* Performances are off. They used to take the spare ticks once every
           season had been swept, but the play sweep is the thing that matters
           now and nothing should be competing with it. Turn PERF_ON back on
           to have them pick up the slack again; what is already collected is
           untouched either way. */
        const perfJob = PERF_ON && !fresh.length && !(n % REFRESH_EVERY === 0 && rolling.length)
          ? await (async () => {
              for (const x of PERF_QUEUE) {
                let fin = null;
                try { fin = await env.RATEBOARD_KV.get(perfDoneKey(x.sport, x.season)); } catch (e) {}
                if (!fin) return x;
              }
              return null;
            })()
          : null;
        /* With every play season swept, the collecting ticks would otherwise
           all go to re-reading the rolling seasons, which only need a look
           now and then. They go to the historical crawl instead, newest
           season first, and the rolling ones keep their every-thirtieth
           tick. */
        const spare = !perfJob && !fresh.length
          && !(n % REFRESH_EVERY === 0 && rolling.length);
        /* The box-score re-read comes first: it is filling in a column that
           every sport's game view depends on, and it is hours rather than
           days. The historical crawl waits for it. */
        const restatJob = spare
          ? await (async () => {
              for (const x of RESTAT_QUEUE) {
                let fin = null;
                try { fin = await env.RATEBOARD_KV.get(restatDoneKey(x.sport, x.season)); } catch (e) {}
                if (!fin) return x;
              }
              return null;
            })()
          : null;
        const histJob = spare && !restatJob
          ? await (async () => {
              for (const x of HIST_QUEUE) {
                let fin = null;
                try { fin = await env.RATEBOARD_KV.get(histDoneKey(x.sport, x.season)); } catch (e) {}
                if (!fin) return x;
              }
              return null;
            })()
          : null;
        if (perfJob || restatJob || histJob) pool = [];
        if (perfJob && step === 'games') {
          const u = new URL(url);
          u.search = `?perf=collect&sport=${perfJob.sport}&season=${perfJob.season}`;
          try { await handleGet({ request: new Request(u.toString(), request), env }); } catch (e) {}
        } else if (restatJob && step === 'games') {
          const u = new URL(url);
          u.search = `?restat=collect&sport=${restatJob.sport}&season=${restatJob.season}`;
          try { await handleGet({ request: new Request(u.toString(), request), env }); } catch (e) {}
        } else if (histJob && step === 'games') {
          const u = new URL(url);
          u.search = `?hist=collect&sport=${histJob.sport}&season=${histJob.season}`;
          try { await handleGet({ request: new Request(u.toString(), request), env }); } catch (e) {}
        } else if (pool.length || step !== 'games') {
          const base = pool.length ? pool : PLAYS_SPORTS;
          /* Scoring now splits its ticks: every other one rates the season
             the games step is filling, so a season is rated as it arrives,
             and the ones in between walk the whole queue a single step at a
             time. The old stride of two over a 24-line queue could only ever
             land on even positions, which is why half the queue - NBA 2026
             among them - was never rated by this step at all. */
          const scoreTick = Math.floor((n - 2) / 3);
          const sp = step === 'tags'
            ? PLAYS_SPORTS[Math.floor(n / 30) % PLAYS_SPORTS.length]
            : step === 'score'
              ? (pool.length && scoreTick % 2 === 0
                  ? pool[n % pool.length]
                  : PLAYS_SPORTS[((scoreTick % PLAYS_SPORTS.length) + PLAYS_SPORTS.length)
                                 % PLAYS_SPORTS.length])
              : base[n % base.length];
          const u = new URL(url);
          // The tag sweep rotates through the rarity tiers: the top-end tags
          // sit only on top-end cards, which are seldom listed, so a plain
          // sweep would almost never see one.
          const tiers = ['all', '7', '6', '5', '4'];
          const tier = tiers[Math.floor(n / 30) % tiers.length];
          u.search = step === 'games'
            ? `?plays=collect&from=games&sport=${sp.sport}&season=${sp.season}`
            : `?plays=${step}&sport=${sp.sport}&season=${sp.season}`
              + (step === 'tags' ? `&rarity=${tier}` : '');
          try { await handleGet({ request: new Request(u.toString(), request), env }); } catch (e) {}
        }
      }
    }
    const CLEAR_KEY = 'queue_clear_v1';
    const today = new Date().toISOString().slice(0, 10);

    // Cancels the current rest. For when a hold was set by something that was
    // not really a season's worth of collecting - the clock then says the
    // account has been working hard when it has been idle. Clearing lastJob
    // too, so the next job doesn't immediately start another rest for being a
    // different sport from whatever set this one.
    if (url.searchParams.get('queue') === 'rescan') {
      let seen = {};
      try { seen = JSON.parse((await env.RATEBOARD_KV.get(RESCAN_KEY)) || '{}') || {}; } catch (e) {}
      const names = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
      const at = alaskaNow();
      return json({
        alaskaNow: `${names[at.day]} ${String(at.hour).padStart(2, '0')}:00`,
        schedule: Object.fromEntries(Object.entries(RESCAN_DAY)
          .map(([sp, d]) => [sp, { day: names[d], season: RESCAN_SEASON[sp], lastRun: seen[sp] || null }]))
      });
    }

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

    // Once a week, on that sport's day, the running season goes back in the
    // queue. This only forgets what has been walked, so the next pass tops the
    // season up with whatever Real has added since.
    const rescanned = await weeklyRescan(env);
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
      /* Sports being rescanned flat out, with no rest going into, between or
         out of their seasons. Empty this set again once the rescan is done. */
      const NO_REST = new Set(['nhl']);
      const prevSp = String(pace.lastJob || '').split(':')[0];
      if (pace.lastJob && pace.lastJob !== key && (NO_REST.has(sp) || NO_REST.has(prevSp))) {
        try { await env.RATEBOARD_KV.put(PACE_KEY, JSON.stringify({ lastJob: key, holdUntil: 0 })); } catch (e) {}
        return json({ sport: sp, season: se, phase });
      }
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
  // Puts a season back in the queue. Real keeps adding players and fixtures to
  // a running season, and the collectors skip anyone already walked, so the
  // only way to pick those up is to forget what was walked. The rows already
  // in the database are kept - the game-log insert updates in place - so this
  // tops a season up rather than rebuilding it.
  if (url.searchParams.get('requeue') === '1') {
    if (!SPORTS.has(sport) || !/^\d{4}$/.test(season)) {
      return json({ error: 'requeue needs a known sport and a four digit season' }, 400);
    }
    const gone = await forgetWalk(env, sport, season);

    let rows = null;
    try {
      const r = await env.RATEBOARD_DB.prepare(
        'SELECT COUNT(*) AS n FROM gamelog WHERE sport = ? AND season = ?')
        .bind(sport, Number(season)).first();
      rows = r ? r.n : null;
    } catch (e) {}
    return json({ requeued: `${sport} ${season}`, forgot: gone, rowsKept: rows,
                  note: 'the queue will rebuild the player list and walk everyone again' });
  }

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

    // Players who miss the cut stop after two rounds, so their score to par is
    // a 36 hole number while everyone else's is a 72 hole one. That makes the
    // best score among the players who missed the only honest read on where
    // the cut fell - you needed to beat it to play the weekend.
    const EVENT_COLS = `
      COUNT(*) AS players,
      SUM(g.rax) AS totalRax,
      ROUND(AVG(g.rax), 2) AS avgRax,
      MAX(g.rax) AS bestRax,
      SUM(CASE WHEN g.position IS NOT NULL AND g.position <> 'CUT' THEN 1 ELSE 0 END) AS madeCut,
      SUM(CASE WHEN g.position = 'CUT' THEN 1 ELSE 0 END) AS missedCut,
      MIN(CASE WHEN g.position = 'CUT' THEN g.plusMinus END) AS cutLine`;

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

      // Every event in every collected season, in one go. The naming and the
      // all-time grouping happen on the page, because the names are a hand
      // written list there rather than anything stored here.
      if (which === 'allevents') {
        const r = await db.prepare(
          `SELECT g.season, g.gameId, MIN(g.day) AS day, ${EVENT_COLS}
             FROM gamelog g
            WHERE g.sport = ? AND g.gameId IS NOT NULL
            GROUP BY g.season, g.gameId ORDER BY day ASC`).bind(sp).all();
        return json({ sport: sp, rows: (r && r.results) || [] });
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
        return await handleGet({ request: new Request(u.toString(), request), env });
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

    // The pass marks each player done and never returns to them, so a season
    // that is still being played goes stale the moment the pass finishes.
    // This clears the done map; the writes are upserts, so a repeat pass is
    // safe and simply picks up whatever games are new.
    if (glArg === 'redo') {
      try { await env.RATEBOARD_KV.delete(DONE_KEY); } catch (e) {}
      return json({ sport, season, reset: true,
        note: 'run gamelog=1 passes to refresh, or gamelog=go for the runner' });
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
        if (SPORTS.has(String(sp).toLowerCase()) && /^\d{4}$/.test(se)
            // A historical season asked for by hand is refused here too, not
            // only hidden from the picker: these views total up rax, and
            // those seasons have none.
            && !histHolds(String(sp).toLowerCase(), Number(se))) {
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

      const PLAYER_SORTS = ['sport','rax','raxPerGame','rating','ratingPerGame','games','player','team',
                            'min','pts','reb','ast','stl','blk','tov','fantasyPts','bestRax',
                            'owners','ownersChange','season','conference'];
      const GAME_SORTS = ['day','sport','player','team','opponent','rax','rating','min','pts','reb','ast',
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

      const PLAYER_COLS = ['playerId','sport','player','team','conference','season','games','rax','raxPerGame',
                           'bestRax','owners','ownersChange','rating','ratingPerGame','min','pts','reb',
                           'ast','stl','blk','tov','fantasyPts'];
      const GAME_COLS = ['day','season','sport','player','position','team','conference','opponent','homeAway','result','teamScore','oppScore',
                         'seasonType','rax','rating','min','pts','reb','ast','stl','blk','tov','pf',
                         'plusMinus','fg','fg3','ft','tsPct','fantasyPts','comments','stats','playerId'];

      // One row per player per season - a player in three seasons is three
      // rows, each with that season's own figures. Owners come from the newest
      // daily snapshot for that same sport and season.
      /* The owner figure used to be a correlated subquery whose own WHERE
         held another correlated aggregate - the latest snapshot day, worked
         out again for every player in the result. With one season selected
         that is merely wasteful; with every season selected it is tens of
         thousands of nested scans in a single statement, which is what has
         been overloading this view.

         The snapshot days are read once, up front, in a single grouped
         query, and pasted in as literals. What is left is one seek per
         player on the (sport, season, playerId, day) index. */
      let latestDay = {}, weekAgoDay = {};
      {
        const dScope = '(' + pairs.map(() => '(sport = ? AND season = ?)').join(' OR ') + ')';
        const dBinds = [];
        for (const [sp, se] of pairs) dBinds.push(sp, se);
        try {
          const a = await db.prepare(
            `SELECT sport, season, MAX(day) AS d FROM owners
              WHERE ${dScope} GROUP BY sport, season`).bind(...dBinds).all();
          for (const r of (a.results || [])) latestDay[`${r.sport}|${r.season}`] = String(r.d || '');
          const b = await db.prepare(
            `SELECT sport, season, MAX(day) AS d FROM owners
              WHERE ${dScope} AND day <= date('now', '-7 day')
              GROUP BY sport, season`).bind(...dBinds).all();
          for (const r of (b.results || [])) weekAgoDay[`${r.sport}|${r.season}`] = String(r.d || '');
        } catch (e) { latestDay = {}; weekAgoDay = {}; }
      }
      // Days are ours, read out of our own table, not anything a caller sent.
      const dayCase = (map) => {
        const arms = pairs
          .filter(([sp, se]) => /^\d{4}-\d{2}-\d{2}$/.test(map[`${sp}|${se}`] || ''))
          .map(([sp, se]) => `WHEN gamelog.sport = '${sp}' AND gamelog.season = ${Number(se)}`
                           + ` THEN '${map[`${sp}|${se}`]}'`);
        return arms.length ? `CASE ${arms.join(' ')} END` : `NULL`;
      };
      const ownerPick = (which) => `
        (SELECT ow.owners FROM owners ow
          WHERE ow.sport = gamelog.sport AND ow.season = gamelog.season
            AND ow.playerId = gamelog.playerId
            AND ow.day = ${dayCase(which === 'week' ? weekAgoDay : latestDay)})`;

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
               ${ownerPick('now')} AS owners,
               ${ownerPick('week')} AS ownersWeekAgo,
               ${ownerPick('now')} - ${ownerPick('week')} AS ownersChange,
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

        /* Several seasons at once are read one season at a time and the
           pieces ranked here. Grouping a million and a half rows in one
           statement - and then doing it a second time just to count them -
           is what fell over when every season was picked. One season is a
           range of the key, and taking the first (offset + limit) of each
           and ranking those together gives the same page as ranking the lot
           would. */
        if (mode === 'players' && pairs.length > 1) {
          const need = Math.min(2000, offset + limit);
          const rest = where.slice(1);          // every filter except the scope
          const restBinds = binds.slice(scopeBinds.length);
          const merged = [];
          let capped = false;
          for (const [sp, se] of pairs) {
            const w1 = ['(sport = ? AND season = ?)'].concat(rest).join(' AND ');
            const inner1 = playerInner.replace(`WHERE ${W}`, `WHERE ${w1}`);
            const sql1 = `SELECT * FROM (${inner1})${OUTER} ORDER BY ${sort} ${dir} LIMIT ${need}`;
            try {
              const r1 = await db.prepare(sql1)
                .bind(sp, se, ...restBinds, minGames, ...outerBinds).all();
              const got = (r1 && r1.results) || [];
              if (got.length >= need) capped = true;
              for (const row of got) merged.push(row);
            } catch (e) { /* a season that will not read is left out, not fatal */ }
          }
          const txt = ['player', 'team', 'sport', 'conference'].includes(sort);
          const sgn = dir === 'ASC' ? 1 : -1;
          merged.sort((a, b) => {
            const av = a[sort], bv = b[sort];
            if (txt) return sgn * String(av == null ? '' : av).localeCompare(String(bv == null ? '' : bv));
            const an = av == null ? -Infinity : Number(av);
            const bn = bv == null ? -Infinity : Number(bv);
            return an === bn ? 0 : sgn * (an - bn);
          });
          return json({ mode, sort, dir: dir.toLowerCase(), limit, offset,
                        pairs: pairs.map(([x, y]) => `${x}:${y}`),
                        total: merged.length, capped,
                        columns: PLAYER_COLS,
                        rows: merged.slice(offset, offset + limit) });
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
        /* The historical seasons are deliberately left off this list. They
           carry a rating but no rax and no owners, so every earnings column
           in the ordinary game-data views would read as a blank for them and
           any multi-season total would quietly go wrong. They have their own
           tab, which knows what it is looking at. */
        const hide = HIST_SPORTS
          .map(sp => `(sport = '${sp}' AND season <= ${HIST_RANGE[sp][1]})`).join(' OR ');
        const r = await db.prepare(
          `SELECT sport, season, COUNT(*) AS rows, COUNT(DISTINCT playerId) AS players
             FROM gamelog
            WHERE NOT (${hide})
            GROUP BY sport, season ORDER BY sport, season DESC`).all();
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
              /* A game missing from the earnings screen earned nothing, so the
                 player's rax is zeroed first and the screen's figures written
                 over it, in one batch. Without this, a re-walk after Real
                 changes its values leaves any game that dropped to nothing
                 holding the old number. */
              const stmts = [db.prepare(
                'UPDATE gamelog SET rax = 0 WHERE sport = ? AND season = ? AND playerId = ?')
                .bind(sport, Number(season), Number(id))];
              for (const e of list) {
                if (!e || !e.day || e.earnings == null) continue;
                if (Array.isArray(e.playerBoxScoreIds) && e.playerBoxScoreIds.length > 1) { skipped++; continue; }
                stmts.push(db.prepare(sql).bind(Number(e.earnings), sport, Number(season), Number(id), e.day));
              }
              for (let i = 0; i < stmts.length; i += 40) {
                const batch = stmts.slice(i, i + 40);
                if (batch.length) await db.batch(batch);
              }
              updates += stmts.length - 1;
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


/* ---- the front door ------------------------------------------------------
   Three kinds of request, sorted before anything touches the database:

   Reads the page makes for members - game logs, pack data, golf, the rax
   shift and historical tabs. Answered from the edge cache when a copy is
   fresh, so a few thousand people opening Pack data at once cost one database
   query per location instead of one each. Misses are rate limited per address.

   The collector's calls. The cron Worker holds no credentials by design, so
   these stay open, but they are capped at a pace a little above the one-a-
   minute it actually runs at - nobody can use them to hammer Real's API.

   Everything else - rescoring, requeueing, wiping, crawling, probes - needs an
   admin session. These used to be open to anyone who knew the address. */
const READS = {
  gamelog: { query: 300, top: 900, seasons: 900 },
  plays:   { board: 900, player: 900, seasons: 900, tagboard: 3600, progress: 120 },
  golf:    { seasons: 1800, tournaments: 1800, allevents: 1800, board: 1800 },
  earn:    { shift: 900 },
  hist:    { board: 1800, progress: 300 },
  restat:  { progress: 300 },
  statavg: { '1': 900 }
};
// Flags that turn a read into a rebuild or a wipe.
const WRITE_FLAGS = ['reset', 'rebuild', 'clear', 'fresh', 'again', 'recrawl', 'fill', 'all'];
// What the cron Worker calls: queue=next, then one of these for the phase it
// was handed.
const COLLECTOR = [['queue', 'next'], ['games', '1'], ['gamelog', '1'], ['gamelog', 'rax'],
                   ['gamelog', 'zerofill'], ['conf', '1'], ['owners', '1'], ['ownertop', '1']];

const RESP_DDL = `CREATE TABLE IF NOT EXISTS resp_cache (
  k TEXT PRIMARY KEY, body TEXT NOT NULL, ts INTEGER NOT NULL, ctype TEXT)`;

function readTtl(url) {
  if (WRITE_FLAGS.some(f => url.searchParams.get(f))) return 0;
  for (const [k, vals] of Object.entries(READS)) {
    const v = url.searchParams.get(k);
    if (v != null && vals[v]) return vals[v];
  }
  return 0;
}

function isCollector(url) {
  return COLLECTOR.some(([k, v]) => url.searchParams.get(k) === v);
}

export async function onRequestGet(ctx) {
  const { request, env } = ctx;
  const url = new URL(request.url);
  const origin = url.origin;
  const ttl = readTtl(url);

  if (ttl > 0) {
    const csv = url.searchParams.get('format') === 'csv';
    // One cache entry per distinct question, whatever order its parameters
    // came in.
    const keyUrl = new URL(origin + '/__cache/rax/v1');
    [...url.searchParams.entries()].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
      .forEach(([k, v]) => keyUrl.searchParams.append(k, v));
    const keyReq = new Request(keyUrl.toString(), { method: 'GET' });
    if (!csv) {
      try {
        const hit = await caches.default.match(keyReq);
        if (hit) {
          const h = new Headers(hit.headers);
          h.set('x-cache', 'HIT');
          return new Response(hit.body, { status: hit.status, headers: h });
        }
      } catch (e) {}
    }
    // Second tier, shared by every location: the last answer kept in D1.
    // Without it each Cloudflare location rebuilds a pack data board on its
    // own first visit, and a crowd arriving at once means dozens of the same
    // 3-10 second query at the same moment. With it, a question is built at
    // most once per TTL worldwide; while one request rebuilds a stale copy,
    // everyone else is handed the previous one instead of waiting.
    const shared = !csv && ttl >= 900 && env.RATEBOARD_DB;
    const k = keyUrl.search;
    let row = null;
    if (shared) {
      try {
        await env.RATEBOARD_DB.prepare(RESP_DDL).run();
        row = await env.RATEBOARD_DB.prepare('SELECT body, ts, ctype FROM resp_cache WHERE k=?').bind(k).first();
      } catch (e) { row = null; }
      if (row) {
        const age = (Date.now() - Number(row.ts)) / 1000;
        let serveOld = age < ttl;
        if (!serveOld) {
          // Claim the rebuild. Whoever moves the timestamp first does it.
          try {
            const c = await env.RATEBOARD_DB.prepare('UPDATE resp_cache SET ts=? WHERE k=? AND ts=?')
              .bind(Date.now(), k, Number(row.ts)).run();
            serveOld = !(c.meta && c.meta.changes);
          } catch (e) { serveOld = true; }
        }
        if (serveOld) {
          const left = Math.max(60, Math.round(ttl - Math.max(0, age)));
          const resp = new Response(row.body, { headers: {
            'content-type': row.ctype || 'application/json', 'x-cache': age < ttl ? 'SHARED' : 'STALE' } });
          try {
            await caches.default.put(keyReq, new Response(row.body, { headers: {
              'content-type': row.ctype || 'application/json', 'cache-control': `max-age=${age < ttl ? left : 60}` } }));
          } catch (e) {}
          return resp;
        }
      }
    }
    if (!(await allow(origin, 'rax-miss:' + clientIp(request), 60, 60))) {
      return new Response(JSON.stringify({ error: 'Too many requests at once - try again in a minute.' }),
        { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '60' } });
    }
    const res = await handleGet(ctx);
    const ctype = res.headers.get('content-type') || '';
    if (!csv && res.status === 200 && ctype.includes('json')) {
      const body = await res.text();
      try {
        await caches.default.put(keyReq, new Response(body, {
          headers: { 'content-type': ctype, 'cache-control': `max-age=${ttl}` }
        }));
      } catch (e) {}
      if (shared && body.length < 1800000) {
        try {
          await env.RATEBOARD_DB.prepare(
            `INSERT INTO resp_cache (k, body, ts, ctype) VALUES (?, ?, ?, ?)
             ON CONFLICT(k) DO UPDATE SET body=excluded.body, ts=excluded.ts, ctype=excluded.ctype`)
            .bind(k, body, Date.now(), ctype).run();
        } catch (e) {}
      }
      return new Response(body, { status: 200, headers: { 'content-type': ctype, 'x-cache': 'MISS' } });
    }
    return res;
  }

  if (isCollector(url)) {
    // The Worker makes two calls a minute; leave room for a retry or two.
    if (!(await allow(origin, 'collector', 6, 60))) {
      return new Response(JSON.stringify({ phase: null, resting: true, minutesLeft: 1, after: 'rate limit' }),
        { status: 429, headers: { 'content-type': 'application/json' } });
    }
    return handleGet(ctx);
  }

  if (!(await isAdminRequest(env, request))) return forbidden();
  return handleGet(ctx);
}
