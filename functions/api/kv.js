// Cloudflare Pages Function backing /api/kv.
// Reads and writes the Rate Board's shared market data to a Cloudflare KV
// namespace bound to this project as RATEBOARD_KV (Settings > Functions >
// KV namespace bindings in the Cloudflare Pages dashboard).
//
// Only a fixed set of keys is allowed, since this endpoint is public and
// unauthenticated — it should never become an arbitrary KV read/write proxy.
const ALLOWED_KEYS = new Set(['ratebrd_market_v1']);
const MAX_VALUE_BYTES = 8_000_000; // 8 MB — room for many thousands of listings

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  if (!key || !ALLOWED_KEYS.has(key)) {
    return json({ error: 'unknown key' }, 400);
  }
  const value = await env.RATEBOARD_KV.get(key);
  return json({ value });
}

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: 'bad json' }, 400);
  }
  const { key, value } = body || {};
  if (!key || !ALLOWED_KEYS.has(key)) {
    return json({ error: 'unknown key' }, 400);
  }
  if (typeof value !== 'string' || value.length > MAX_VALUE_BYTES) {
    return json({ error: 'bad value' }, 400);
  }
  await env.RATEBOARD_KV.put(key, value);
  return json({ ok: true });
}
