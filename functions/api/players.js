// Cloudflare Pages Function backing /api/players.
//
// Player/team search for the buy-offer autocomplete.
//
// IMPORTANT: this data is NOT fetched live by this function. ESPN's public
// roster API (the only free source with real CFB/NFL/FC data) returns 403
// to requests from Cloudflare's network, and also does not allow this site
// to call it directly from the browser (no CORS). So instead of fetching on
// every request, the roster list for each sport is imported ahead of time
// (see the POST handler below) and simply read back here. GET only ever
// reads KV — it never calls out to ESPN or anything else.
//
// There is also no free public "EA Sports FC roster" API, so FC is
// approximated with ESPN's soccer data across a broad set of major leagues.

const MAX_RESULTS = 15;
const MAX_VALUE_BYTES = 4000000; // generous; real usage is a few hundred KB
const MAX_PLAYERS = 60000; // sanity cap on an import

function json(obj, status = 200, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', ...(extraHeaders || {}) }
  });
}

function stateKey(sport) { return 'players_' + sport.toLowerCase() + '_state_v1'; }

async function readState(env, sport) {
  const raw = await env.RATEBOARD_KV.get(stateKey(sport));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const sport = (url.searchParams.get('sport') || '').toUpperCase();
  const q = (url.searchParams.get('q') || '').trim().toLowerCase();
  if (!['CFB', 'NFL', 'FC'].includes(sport)) return json({ error: 'bad sport' }, 400);

const state = await readState(env, sport);
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
  building: !state,
  total: players.length,
  updated: state ? state.updated : null
});
}

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type'
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); }
  catch (e) { return json({ error: 'bad json' }, 400); }

const sport = String(body && body.sport || '').toUpperCase();
  if (!['CFB', 'NFL', 'FC'].includes(sport)) return json({ error: 'bad sport' }, 400, CORS_HEADERS);

const players = body && body.players;
  if (!Array.isArray(players) || players.length === 0 || players.length > MAX_PLAYERS) {
    return json({ error: 'bad players list' }, 400, CORS_HEADERS);
  }
  for (const p of players) {
    if (!Array.isArray(p) || p.length !== 2 || typeof p[0] !== 'string' || typeof p[1] !== 'string') {
      return json({ error: 'bad player entry' }, 400, CORS_HEADERS);
    }
  }

const state = { players, updated: Date.now(), count: players.length };
  const encoded = JSON.stringify(state);
  if (encoded.length > MAX_VALUE_BYTES) return json({ error: 'list too large' }, 413, CORS_HEADERS);

await env.RATEBOARD_KV.put(stateKey(sport), encoded);
  return json({ ok: true, sport, count: players.length }, 200, CORS_HEADERS);
}
