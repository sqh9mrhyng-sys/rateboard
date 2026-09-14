// Cloudflare Pages Function backing /api/players.
//
// Live player/team search for the buy-offer autocomplete. There is no free
// public "EA Sports FC roster" API, so FC is approximated with ESPN's public
// (unofficial) soccer data across a broad set of major leagues; CFB and NFL
// use ESPN's real FBS/NFL rosters, which are accurate.
//
// Because the full player pool is large (CFB alone is 100+ teams), the index
// is built in small background chunks across requests rather than all at
// once, to stay well under a Worker's per-invocation subrequest limit. Each
// sport's progress and player list live in KV so later requests reuse it.

const STALE_MS = 24 * 60 * 60 * 1000; // rebuild once a day
const CHUNK_SIZE = 12; // team-roster fetches per invocation
const MAX_RESULTS = 15;
const MAX_VALUE_BYTES = 4000000; // generous; real usage is well under this

const FC_LEAGUES = [
  'eng.1', 'esp.1', 'ger.1', 'ita.1', 'fra.1',
  'ned.1', 'por.1', 'eng.2', 'usa.1', 'sco.1', 'bra.1', 'tur.1'
  ];

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function stateKey(sport) { return 'players_' + sport.toLowerCase() + '_state_v1'; }

async function readState(env, sport) {
  const raw = await env.RATEBOARD_KV.get(stateKey(sport));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

async function writeState(env, sport, state) {
  const body = JSON.stringify(state);
  if (body.length > MAX_VALUE_BYTES) return;
  await env.RATEBOARD_KV.put(stateKey(sport), body);
}

async function fetchJSON(url) {
  const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (compatible; RateBoard/1.0)' } });
  if (!r.ok) throw new Error('fetch failed ' + r.status + ' ' + url);
  return r.json();
}

async function listTeams(sport) {
  if (sport === 'NFL') {
    const data = await fetchJSON('https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams?limit=50');
    return data.sports[0].leagues[0].teams.map(t => ({ id: t.team.id, abbr: t.team.abbreviation, kind: 'nfl' }));
  }
  if (sport === 'CFB') {
    const data = await fetchJSON('https://site.api.espn.com/apis/v2/sports/football/college-football/standings?group=80');
    const out = [];
    for (const conf of (data.children || [])) {
      for (const e of ((conf.standings && conf.standings.entries) || [])) {
        out.push({ id: e.team.id, abbr: e.team.abbreviation, kind: 'cfb' });
      }
    }
    return out;
  }
  if (sport === 'FC') {
    const out = [];
    for (const league of FC_LEAGUES) {
      try {
        const data = await fetchJSON(`https://site.api.espn.com/apis/site/v2/sports/soccer/${league}/teams?limit=50`);
        for (const t of data.sports[0].leagues[0].teams) {
          out.push({ id: t.team.id, abbr: t.team.abbreviation, kind: 'soccer:' + league });
        }
      } catch (e) { }
    }
    return out;
  }
  return [];
}

async function fetchRoster(team) {
  let url;
  if (team.kind === 'nfl') url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${team.id}/roster`;
  else if (team.kind === 'cfb') url = `https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams/${team.id}/roster`;
  else url = `https://site.api.espn.com/apis/site/v2/sports/soccer/${team.kind.split(':')[1]}/teams/${team.id}/roster`;

const data = await fetchJSON(url);
  const names = [];
  if (Array.isArray(data.athletes)) {
    for (const a of data.athletes) {
      if (Array.isArray(a.items)) { for (const it of a.items) if (it.fullName) names.push(it.fullName); }
      else if (a.fullName) { names.push(a.fullName); }
    }
  }
  return names.map(n => [n, team.abbr]);
}

async function buildChunk(env, sport) {
  let state = await readState(env, sport);
  if (!state || !Array.isArray(state.teams)) {
    const teams = await listTeams(sport);
    state = { teams, doneIds: [], players: [], updated: null, startedAt: Date.now() };
  }
  const remaining = state.teams.filter(t => !state.doneIds.includes(t.id));
  const batch = remaining.slice(0, CHUNK_SIZE);
  if (batch.length) {
    const results = await Promise.allSettled(batch.map(fetchRoster));
    for (let i = 0; i < batch.length; i++) {
      state.doneIds.push(batch[i].id);
      if (results[i].status === 'fulfilled') state.players.push(...results[i].value);
    }
  }
  if (state.doneIds.length >= state.teams.length) {
    state.updated = Date.now();
  }
  await writeState(env, sport, state);
  return state;
}

export async function onRequestGet({ request, env, waitUntil }) {
  const url = new URL(request.url);
  const sport = (url.searchParams.get('sport') || '').toUpperCase();
  const q = (url.searchParams.get('q') || '').trim().toLowerCase();
  if (!['CFB', 'NFL', 'FC'].includes(sport)) return json({ error: 'bad sport' }, 400);

let state = await readState(env, sport);
  const complete = !!(state && state.updated);
  const staleByTime = complete && (Date.now() - state.updated > STALE_MS);
  let lastError = null;

if (!state) {
  try { state = await buildChunk(env, sport); }
  catch (e) { lastError = String((e && e.message) || e); }
} else if (!complete || staleByTime) {
  const task = buildChunk(env, sport).catch(() => {});
  if (waitUntil) waitUntil(task); else await task;
}

const players = (state && state.players) || [];
  const matches = [];
  if (q.length >= 2) {
    const seen = new Set();
    for (const [name, team] of players) {
      if (!name.toLowerCase().includes(q)) continue;
      const key = name + '|' + team;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({ name, team });
      if (matches.length >= MAX_RESULTS) break;
    }
  }

return json({
  players: matches,
  building: !(state && state.updated),
  coverage: state ? `${state.doneIds.length}/${state.teams.length}` : '0/0',
  lastError
});
}
