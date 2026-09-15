// GET /api/collection?username=<rs_username>&sport=FC
//
// Pulls ALL of a user's cards from RS, groups by player, and returns
// total owned + per-rarity counts. Uses one shared RS_AUTH_TOKEN env var.
//
// Rate limiting:
//   - Per-IP: max 5 requests/min tracked in RATEBOARD_KV
//   - KV cache: each username cached 10 min — RS only called once per 10 min

const CACHE_TTL_SECONDS = 86400; // 24 hours per chunk
const IP_WINDOW_SECONDS = 60;
const IP_MAX_REQUESTS   = 5;

const SPORT_RS_KEY = { FC: 'soccer' };
const SEASON = '2026';

// rarity numbers → short label for display
const RARITY_LABEL = { 1:'C', 2:'U', 3:'R', 4:'E', 5:'L' };

// ── hashidsEncode (inlined — salt='realwebapp', minLen=16) ───────────────────
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

// ── per-IP rate limit ─────────────────────────────────────────────────────────
async function checkRateLimit(kv, ip) {
  const key = `ratelimit:collection:${ip}`;
  const raw = await kv.get(key);
  const count = raw ? parseInt(raw, 10) : 0;
  if (count >= IP_MAX_REQUESTS) return false;
  await kv.put(key, String(count + 1), { expirationTtl: IP_WINDOW_SECONDS });
  return true;
}

// ── RS API calls ──────────────────────────────────────────────────────────────
async function resolveHashId(username, auth) {
  const url = `https://web.realapp.com/searchusers?query=${encodeURIComponent(username)}`;
  const res = await fetch(url, { headers: rsHeaders(auth) });
  if (!res.ok) throw new Error(`RS search ${res.status}`);
  const data = await res.json();
  const users = data.users || [];
  const match = users.find(u => u.userName?.toLowerCase() === username.toLowerCase());
  return match ? match.id : null;
}

const CHUNK_PAGES = 44; // pages per invocation — keeps total subrequests ≤ 45 (+ 1 for username lookup)

// Fetches one chunk of cards starting at `startOffset`.
// Returns { byPlayer (Map), hasMore, nextOffset }
async function fetchCardChunk(hashId, sport, auth, startOffset) {
  const byPlayer = new Map();
  let offset = startOffset;
  let pagesRead = 0;
  let hasMore = false;

  while (pagesRead < CHUNK_PAGES) {
    const url = `https://web.realapp.com/collectingcards/${sport}/season/${SEASON}/entity/play/user/${hashId}/cards` +
      `?includeRecommendations=true&offset=${offset}&rarity=all&view=rating`;
    const res = await fetch(url, { headers: rsHeaders(auth) });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`RS cards ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    const cards = data.cards || [];
    if (!cards.length) break;

    for (const card of cards) {
      const pid = card.playerId || card.primaryPlayer?.id;
      if (!pid) continue;
      const firstName = card.primaryPlayer?.firstName || '';
      const lastName  = card.primaryPlayer?.lastName  || '';
      const name = (firstName + ' ' + lastName).trim() || card.primaryPlayer?.displayName || String(pid);
      const rarity = card.rarity || 0;
      const value  = card.value  || 0;
      if (!byPlayer.has(pid)) {
        byPlayer.set(pid, { name, playerId: pid, total: 0, totalValue: 0 });
      }
      const p = byPlayer.get(pid);
      p.total++;
      p.totalValue = Math.round((p.totalValue + value) * 10) / 10;
    }

    offset += 20;
    pagesRead++;

    // If we got a full page there may be more — signal the next chunk
    if (cards.length === 20 && pagesRead === CHUNK_PAGES) {
      hasMore = true;
    }
  }

  return { byPlayer, hasMore, nextOffset: offset };
}

// ── main handler ──────────────────────────────────────────────────────────────
// Supports chunked fetching for large collections:
//   ?username=X&sport=FC              → chunk 0 (resolves username → hashId)
//   ?username=X&sport=FC&hashId=Y&start=880 → subsequent chunks (skips username lookup)
// Response includes { players, hasMore, nextStart, hashId } so the frontend
// can loop until hasMore is false, merging player data across chunks.
export async function onRequestGet({ request, env }) {
  const auth = env.RS_AUTH_TOKEN;
  if (!auth) return json({ error: 'RS collection is not configured on this server' }, 500);

  const url      = new URL(request.url);
  const username = (url.searchParams.get('username') || '').trim();
  const sport    = (url.searchParams.get('sport') || 'FC').toUpperCase();
  const start    = Math.max(0, parseInt(url.searchParams.get('start') || '0', 10));
  let   hashId   = (url.searchParams.get('hashId') || '').trim();

  if (!username) return json({ error: 'username is required' }, 400);
  if (username.length > 50) return json({ error: 'username too long' }, 400);
  if (!SPORT_RS_KEY[sport]) return json({ error: `unsupported sport: ${sport}` }, 400);

  const rsSport = SPORT_RS_KEY[sport];

  const cacheKey = `col:${rsSport}:${username.toLowerCase()}:${start}`;

  // 1. KV cache check — serve from cache if within 24h
  if (env.RATEBOARD_KV) {
    const cached = await env.RATEBOARD_KV.get(cacheKey);
    if (cached) {
      return new Response(cached, {
        headers: { 'content-type': 'application/json', 'x-cache': 'HIT' }
      });
    }
  }

  // 2. Per-IP rate limit (only on first chunk)
  if (start === 0 && env.RATEBOARD_KV) {
    const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
    const allowed = await checkRateLimit(env.RATEBOARD_KV, ip);
    if (!allowed) return json({ error: 'Too many requests — try again in a minute' }, 429);
  }

  // 3. Resolve username → hashId (only needed on first chunk)
  if (!hashId) {
    try { hashId = await resolveHashId(username, auth); }
    catch (e) { return json({ error: 'Could not reach RS — try again shortly' }, 502); }
    if (!hashId) return json({ error: `RS user "${username}" not found` }, 404);
  }

  // 4. Fetch one chunk of cards from RS
  let chunk;
  try { chunk = await fetchCardChunk(hashId, rsSport, auth, start); }
  catch (e) { return json({ error: 'Could not load cards — try again shortly', detail: e.message }, 502); }

  const players = [...chunk.byPlayer.values()];
  const result  = JSON.stringify({
    username,
    hashId,
    players,
    hasMore:   chunk.hasMore,
    nextStart: chunk.nextOffset,
    fetchedAt: Date.now(),
  });

  // 5. Cache chunk for 24 hours
  if (env.RATEBOARD_KV) {
    await env.RATEBOARD_KV.put(cacheKey, result, { expirationTtl: CACHE_TTL_SECONDS });
  }

  return new Response(result, {
    headers: { 'content-type': 'application/json', 'x-cache': 'MISS' }
  });
}
