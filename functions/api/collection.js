// GET /api/collection?username=<rs_username>&sport=FC&start=<before>&hashId=<hashId>
//
// Uses the /collection/.../topentities endpoint which returns players already
// grouped with their total boost value and card counts — far fewer RS requests
// than paginating individual cards.
//
// Rate limiting:
//   - Per-IP: max 5 requests/min
//
// Caching and rate limiting both run on the Cloudflare Cache API, NOT on KV.
// KV has a hard daily write ceiling; caching a chunk per user per quarter hour
// blows straight through it, and once it's gone every KV write throws, which
// took this whole endpoint down with a 1101. The cache API has no write quota.
// Nothing in here is allowed to throw on a cache failure — worst case we skip
// the cache and read live.
//   - KV cache: one quarter-hour slot, so everyone's cards refresh together
//     on the hour and at :15, :30 and :45 rather than 24h after their own pull

const CACHE_BUCKET_MS   = 15 * 60 * 1000;  // :00, :15, :30, :45
const CACHE_TTL_SECONDS = 900;             // one slot; the key changes at the boundary anyway
const IP_WINDOW_SECONDS = 60;
const IP_MAX_REQUESTS   = 20;

const SPORT_RS_KEY = { FC: 'soccer', CFB: 'ncaaf', NFL: 'nfl' };
const SEASON = '2026';
const PAGE_SIZE   = 20;
const CHUNK_PAGES = 15; // 15 pages × 20 players = 300 players per invocation

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

// "3.9k" → 3900, 68.9 → 68.9
function parseBoost(v) {
  if (typeof v === 'number') return Math.round(v * 10) / 10;
  if (typeof v === 'string') {
    const s = v.toLowerCase().trim();
    if (s.endsWith('k')) return Math.round(parseFloat(s) * 1000 * 10) / 10;
    return Math.round(parseFloat(s) * 10) / 10;
  }
  return 0;
}

// ── cache helpers ─────────────────────────────────────────────────────────────
// Cache keys have to be URLs, so they're built under a path that never routes
// anywhere. Every call is wrapped: a cache miss and a cache failure look the
// same to the caller, which is the point.
function cacheKeyReq(origin, parts) {
  return new Request(`${origin}/__cache/${parts.map(encodeURIComponent).join('/')}`, { method: 'GET' });
}

async function cacheGet(req) {
  try {
    const hit = await caches.default.match(req);
    return hit ? await hit.text() : null;
  } catch (e) { return null; }
}

async function cachePut(req, body, ttlSeconds) {
  try {
    await caches.default.put(req, new Response(body, {
      headers: { 'content-type': 'application/json', 'cache-control': `max-age=${ttlSeconds}` }
    }));
  } catch (e) { /* caching is an optimisation, never a requirement */ }
}

// ── per-IP rate limit ─────────────────────────────────────────────────────────
// Counted per colo rather than globally, which is plenty for stopping one
// person hammering the button, and costs no KV writes.
// Each request appends a timestamp entry; the list is trimmed to the window
// before counting, so the check is correct even under concurrent load.
async function checkRateLimit(origin, ip) {
  const now = Date.now();
  const windowMs = IP_WINDOW_SECONDS * 1000;
  const req = cacheKeyReq(origin, ['rl2', ip]);
  const raw = await cacheGet(req);
  let hits = [];
  try { if (raw) hits = JSON.parse(raw); } catch (e) { hits = []; }
  // Drop entries outside the current window
  hits = hits.filter(t => now - t < windowMs);
  if (hits.length >= IP_MAX_REQUESTS) return false;
  hits.push(now);
  await cachePut(req, JSON.stringify(hits), IP_WINDOW_SECONDS);
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

// Fetches one chunk of the collection (sorted by boost value).
// `startBefore` maps to the ?before= param (0, 20, 40, …).
// Returns { players[], hasMore, nextBefore }
async function fetchCollectionChunk(hashId, sport, auth, startBefore) {
  const players = [];
  let before = startBefore;
  let pagesRead = 0;
  let hasMore = false;

  while (pagesRead < CHUNK_PAGES) {
    const url = `https://web.realapp.com/collection/${sport}/season/${SEASON}/entity/player/user/${hashId}/topentities` +
      `?before=${before}&sort=boostvalue`;
    let res = await fetch(url, { headers: rsHeaders(auth) });
    // RS rate-limits the shared token under heavy sequential fetches.
    // Retry up to 3 times with increasing backoff before giving up.
    if (res.status === 429) {
      for (const wait of [2000, 4000, 6000]) {
        await new Promise(r => setTimeout(r, wait));
        res = await fetch(url, { headers: rsHeaders(auth) });
        if (res.status !== 429) break;
      }
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`RS collection ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    const entities = data.entities || [];
    if (!entities.length) break;

    for (const e of entities) {
      const totalCards  = (e.secondaryValues && e.secondaryValues[1]) || 0;
      const uniqueCards = (e.secondaryValues && e.secondaryValues[0]) || 0;
      players.push({
        name:       e.label || String(e.id),
        playerId:   e.id,
        total:      totalCards,
        unique:     uniqueCards,
        totalValue: parseBoost(e.primaryValue),
      });
    }

    before += PAGE_SIZE;
    pagesRead++;

    if (entities.length === PAGE_SIZE && pagesRead === CHUNK_PAGES) {
      hasMore = true;
    }
  }

  return { players, hasMore, nextBefore: before };
}

// ── main handler ──────────────────────────────────────────────────────────────
// ?username=X&sport=FC              → chunk starting at before=0
// ?username=X&sport=FC&hashId=Y&start=880 → next chunk
export async function onRequestGet({ request, env }) {
  const origin = new URL(request.url).origin;
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

  const rsSport  = SPORT_RS_KEY[sport];
  // The slot number is part of the cache key, so a cached chunk is dead the
  // moment the clock ticks past the next quarter hour — not a rolling window.
  const slot = Math.floor(Date.now() / CACHE_BUCKET_MS);

  // 1. Cache check — serve from cache if it's from this quarter-hour slot
  const cacheReq = cacheKeyReq(origin, ['col', rsSport, username.toLowerCase(), String(start), String(slot)]);
  const cached = await cacheGet(cacheReq);
  if (cached) {
    return new Response(cached, {
      headers: { 'content-type': 'application/json', 'x-cache': 'HIT' }
    });
  }

  // 2. Per-IP rate limit (only on first chunk, and only once we know we're
  //    actually about to go out to RS)
  if (start === 0) {
    const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
    const allowed = await checkRateLimit(origin, ip);
    if (!allowed) return json({ error: 'Too many requests — try again in a minute' }, 429);
  }

  // 3. Resolve username → hashId (only needed on first chunk)
  if (!hashId) {
    try { hashId = await resolveHashId(username, auth); }
    catch (e) { return json({ error: 'Could not reach RS — try again shortly' }, 502); }
    if (!hashId) return json({ error: `RS user "${username}" not found` }, 404);
  }

  // 4. Fetch one chunk from the topentities endpoint
  let chunk;
  try { chunk = await fetchCollectionChunk(hashId, rsSport, auth, start); }
  catch (e) { return json({ error: 'Could not load collection — try again shortly', detail: e.message }, 502); }

  const result = JSON.stringify({
    username,
    hashId,
    players:   chunk.players,
    hasMore:   chunk.hasMore,
    nextStart: chunk.nextBefore,
    fetchedAt: Date.now(),
  });

  // 5. Cache until this quarter-hour slot rolls over
  await cachePut(cacheReq, result, CACHE_TTL_SECONDS);

  return new Response(result, {
    headers: { 'content-type': 'application/json', 'x-cache': 'MISS' }
  });
}
