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
const MAX_VALUE_BYTES = 4_000_000; // generous; real usage is a few hundred KB
const MAX_PLAYERS = 60_000;        // sanity cap on an import

// Letters that don't decompose into "plain letter + accent mark" on their own.
const ODD_LETTERS = {
  'Æ': 'AE', 'æ': 'ae', 'Œ': 'OE', 'œ': 'oe', 'ß': 'ss', 'Ø': 'O', 'ø': 'o',
  'Ł': 'L', 'ł': 'l', 'Đ': 'D', 'đ': 'd', 'Ð': 'D', 'ð': 'd', 'Þ': 'Th', 'þ': 'th',
  'İ': 'I', 'ı': 'i', 'Ħ': 'H', 'ħ': 'h', 'Ŋ': 'N', 'ŋ': 'n', 'Ŧ': 'T', 'ŧ': 't',
  'Ŀ': 'L', 'ŀ': 'l'
};

// Names go out in plain English letters, so a phone keyboard can actually type
// them: searching "mbappe" has to find Mbappé, and the dropdown shows "Mbappe".
function asciiName(s) {
  return String(s)
    .replace(/[ÆæŒœßØøŁłĐđÐðÞþİıĦħŊŋŦŧĿŀ]/g, c => ODD_LETTERS[c] || c)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 .'\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

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
  if (!['CFB', 'NFL', 'FC', 'UFC'].includes(sport)) return json({ error: 'bad sport' }, 400);

  const state = await readState(env, sport);
  const players = (state && state.players) || [];

  // ?team=SEA returns that whole roster instead of doing a name search.
  // The board uses this to know which players are off limits.
  const team = (url.searchParams.get('team') || '').trim().toUpperCase();
  if (team) {
    const seen = new Set();
    const roster = [];
    for (const [rawName, t] of players) {
      if (asciiName(t).toUpperCase() !== team) continue;
      const name = asciiName(rawName);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      roster.push(name);
    }
    return json({ team, players: roster, count: roster.length, updated: state ? state.updated : null });
  }

  const matches = [];
  if (q.length >= 2) {
    // Both sides are flattened to plain letters before comparing, so "mbappe",
    // "Mbappé" and "MBAPPE" all find the same player.
    const needle = asciiName(q).toLowerCase();
    const seen = new Set();
    for (const [rawName, team] of players) {
      const name = asciiName(rawName);
      if (!name.toLowerCase().includes(needle)) continue;
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

// This import is run from a browser tab sitting on ESPN's own origin (that's
// the only way to actually reach ESPN's data at all — see the note at the
// top of this file), so the POST below is cross-origin from this site's
// point of view. CORS has to be opened up for it to land.
export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

// Imports a full player/team list for one sport, replacing whatever was
// there before. This endpoint has no auth beyond being a hard-to-guess-into
// write of a specific shape — same trust model as the rest of this board.
export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); }
  catch (e) { return json({ error: 'bad json' }, 400); }

  const sport = String(body && body.sport || '').toUpperCase();
  if (!['CFB', 'NFL', 'FC', 'UFC'].includes(sport)) return json({ error: 'bad sport' }, 400, CORS_HEADERS);

  const players = body && body.players;
  if (!Array.isArray(players) || players.length === 0 || players.length > MAX_PLAYERS) {
    return json({ error: 'bad players list' }, 400, CORS_HEADERS);
  }
  for (const p of players) {
    if (!Array.isArray(p) || p.length !== 2 || typeof p[0] !== 'string' || typeof p[1] !== 'string') {
      return json({ error: 'bad player entry' }, 400, CORS_HEADERS);
    }
  }

  // Store names already flattened, so a future import doesn't reintroduce accents.
  const cleaned = players
    .map(([name, team]) => [asciiName(name), asciiName(team)])
    .filter(([name]) => name);

  const state = { players: cleaned, updated: Date.now(), count: cleaned.length };
  const encoded = JSON.stringify(state);
  if (encoded.length > MAX_VALUE_BYTES) return json({ error: 'list too large' }, 413, CORS_HEADERS);

  await env.RATEBOARD_KV.put(stateKey(sport), encoded);
  return json({ ok: true, sport, count: players.length }, 200, CORS_HEADERS);
}
