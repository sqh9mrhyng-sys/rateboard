// Cloudflare Pages Function backing /api/ufc.
//
// Live fighter details from UFC.com — status (Active / Not Fighting / Retired),
// age, record and division — for the fighters on the UFC purchases list.
//
// The details are kept in KV and served from there, so a page load never waits
// on UFC.com. Freshness comes from a slow background trickle: each read may
// refresh a small batch of the stalest fighters (after the response has gone
// out), so the whole list turns over roughly once a day without ever hitting
// UFC.com in a burst. If UFC.com refuses the request, the stored details are
// kept as they are — a failed refresh never blanks a fighter.
//
//   GET  /api/ufc                 -> { fighters: { [name]: {...} }, updated }
//   GET  /api/ufc?probe=<slug>    -> fetch one athlete page now (diagnostics)
//   POST /api/ufc  {fighters}     -> merge details in (used to seed the list)

const KV_KEY = 'ufc_meta_v1';
const STALE_MS = 24 * 60 * 60 * 1000;      // refresh each fighter about daily
const RETRY_MS = 6 * 60 * 60 * 1000;       // after a failed fetch, wait before retrying
const REFRESH_GAP_MS = 10 * 60 * 1000;     // at most one background batch per 10 min
const BATCH = 20;
const EDGE_TTL = 300;                      // readers share one KV read per 5 min per colo

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type'
};

function json(obj, status = 200, extra) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'content-type': 'application/json', ...CORS, ...(extra || {}) }
  });
}

function decode(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&#039;|&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ').trim();
}

// Pulls the handful of fields we show out of a UFC.com athlete page.
function parseAthlete(html) {
  const m = re => { const x = html.match(re); return x ? decode(x[1]) : ''; };
  const name = m(/class="hero-profile__name"[^>]*>([^<]+)</);
  if (!name) return null;
  return {
    ufcName: name,
    status: m(/c-bio__label">\s*Status\s*<\/div>\s*<div class="c-bio__text">\s*([^<]+?)\s*</i),
    age: m(/field--name-age[^>]*>\s*(\d+)\s*</),
    record: m(/hero-profile__division-body"[^>]*>([^<]+)</).replace(/\s*\(W-L-D\)\s*/i, ''),
    division: m(/hero-profile__division-title"[^>]*>([^<]+)</)
  };
}

async function fetchAthlete(slug) {
  const res = await fetch(`https://www.ufc.com/athlete/${encodeURIComponent(slug)}`, {
    headers: {
      'user-agent': 'Mozilla/5.0 (compatible; RateBoard/1.0; +https://rateboard-cgi.pages.dev)',
      'accept': 'text/html'
    },
    cf: { cacheTtl: 3600, cacheEverything: true }
  });
  if (!res.ok) return { ok: false, http: res.status };
  const parsed = parseAthlete(await res.text());
  return parsed ? { ok: true, ...parsed } : { ok: false, http: res.status, why: 'unparseable' };
}

async function readStore(env) {
  const raw = await env.RATEBOARD_KV.get(KV_KEY);
  if (!raw) return { fighters: {}, updated: 0, lastRefresh: 0 };
  try { return JSON.parse(raw); } catch (e) { return { fighters: {}, updated: 0, lastRefresh: 0 }; }
}

// Refreshes the stalest few fighters. Runs after the response has been sent.
async function trickle(env) {
  try {
    const store = await readStore(env);
    const now = Date.now();
    if (now - (store.lastRefresh || 0) < REFRESH_GAP_MS) return;

    const due = Object.entries(store.fighters)
      .filter(([, f]) => f && f.slug)
      .filter(([, f]) => now - (f.ts || 0) > STALE_MS && now - (f.failedAt || 0) > RETRY_MS)
      .sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0))
      .slice(0, BATCH);
    if (!due.length) return;

    // Claim the slot first, so two readers arriving together don't both refresh.
    store.lastRefresh = now;
    await env.RATEBOARD_KV.put(KV_KEY, JSON.stringify(store));

    for (const [name, f] of due) {
      try {
        const r = await fetchAthlete(f.slug);
        if (r.ok) {
          store.fighters[name] = { ...f, ...r, ok: undefined, ts: Date.now(), failedAt: 0 };
          delete store.fighters[name].ok;
        } else {
          store.fighters[name] = { ...f, failedAt: Date.now(), lastHttp: r.http };
        }
      } catch (e) {
        store.fighters[name] = { ...f, failedAt: Date.now() };
      }
    }
    store.updated = Date.now();
    await env.RATEBOARD_KV.put(KV_KEY, JSON.stringify(store));
  } catch (e) { /* background freshness is best-effort; stored data stands */ }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet({ request, env, waitUntil }) {
  const url = new URL(request.url);

  const probe = url.searchParams.get('probe');
  if (probe) {
    try { return json({ slug: probe, ...(await fetchAthlete(probe)) }); }
    catch (e) { return json({ slug: probe, ok: false, why: String((e && e.message) || e) }); }
  }

  const cacheReq = new Request(`${url.origin}/__cache/ufc-meta/v1`, { method: 'GET' });
  try {
    const hit = await caches.default.match(cacheReq);
    if (hit) {
      if (waitUntil) waitUntil(trickle(env));
      return new Response(await hit.text(), { headers: { 'content-type': 'application/json', ...CORS, 'x-cache': 'HIT' } });
    }
  } catch (e) {}

  let store;
  try { store = await readStore(env); }
  catch (e) { return json({ error: 'could not read fighter details', detail: String((e && e.message) || e) }, 503); }

  const out = {};
  for (const [name, f] of Object.entries(store.fighters)) {
    out[name] = { status: f.status || '', age: f.age || '', record: f.record || '',
                  division: f.division || '', ufcName: f.ufcName || '', ts: f.ts || 0 };
  }
  const body = JSON.stringify({ fighters: out, updated: store.updated || 0 });
  try {
    await caches.default.put(cacheReq, new Response(body, {
      headers: { 'content-type': 'application/json', 'cache-control': `max-age=${EDGE_TTL}` }
    }));
  } catch (e) {}
  if (waitUntil) waitUntil(trickle(env));
  return new Response(body, { headers: { 'content-type': 'application/json', ...CORS, 'x-cache': 'MISS' } });
}

// Seeds or corrects details. Only known fields are accepted, and an empty
// incoming value never overwrites a stored one.
export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'bad json' }, 400); }
  const incoming = body && body.fighters;
  if (!incoming || typeof incoming !== 'object') return json({ error: 'no fighters' }, 400);

  const store = await readStore(env);
  let n = 0;
  for (const [rawName, f] of Object.entries(incoming)) {
    const name = String(rawName).slice(0, 80).trim();
    if (!name || !f || typeof f !== 'object') continue;
    const prev = store.fighters[name] || {};
    const pick = k => (f[k] != null && String(f[k]).trim() !== '') ? String(f[k]).slice(0, 80).trim() : (prev[k] || '');
    store.fighters[name] = {
      slug: pick('slug'), ufcName: pick('ufcName'), status: pick('status'),
      age: pick('age'), record: pick('record'), division: pick('division'),
      ts: Number(f.ts) || prev.ts || Date.now(), failedAt: 0
    };
    n++;
  }
  store.updated = Date.now();
  await env.RATEBOARD_KV.put(KV_KEY, JSON.stringify(store));
  try { await caches.default.delete(new Request(`${new URL(request.url).origin}/__cache/ufc-meta/v1`)); } catch (e) {}
  return json({ ok: true, merged: n, total: Object.keys(store.fighters).length });
}
