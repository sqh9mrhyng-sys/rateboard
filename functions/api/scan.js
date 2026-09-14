// Cloudflare Pages Function backing /api/scan.
//
// Proxies the seller "read my screenshots" request to Anthropic's API.
// The browser sends only the message content blocks (images + the prompt
// text); this function attaches the real API key server-side, so the key
// never has to live in public client code. Configure the key as a secret
// environment variable named ANTHROPIC_API_KEY on this Pages project
// (Settings > Environment variables), for both Production and Preview.
const MODEL = 'claude-sonnet-4-6';
// Big enough for a long roster: ~25 tokens per player row, so this comfortably
// covers a few hundred players read off one batch of screenshots.
const MAX_TOKENS = 8000;
const MAX_BLOCKS = 16; // up to 14 screenshots + a couple of text blocks

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function isValidBlock(block) {
  if (!block || typeof block !== 'object') return false;
  if (block.type === 'text') {
    return typeof block.text === 'string' && block.text.length <= 20000;
  }
  if (block.type === 'image') {
    const src = block.source;
    return !!src && src.type === 'base64'
      && typeof src.media_type === 'string' && src.media_type.startsWith('image/')
      && typeof src.data === 'string' && src.data.length <= 8_000_000; // base64, generous per-image cap
  }
  return false;
}

export async function onRequestPost({ request, env }) {
  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: 'scanning is not configured on this server yet' }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: 'bad json' }, 400);
  }

  const content = body && body.content;
  if (!Array.isArray(content) || content.length === 0 || content.length > MAX_BLOCKS) {
    return json({ error: 'bad content' }, 400);
  }
  if (!content.every(isValidBlock)) {
    return json({ error: 'bad content block' }, 400);
  }

  let upstream;
  try {
    upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, messages: [{ role: 'user', content }] })
    });
  } catch (e) {
    return json({ error: 'could not reach the scanning service' }, 502);
  }

  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: { 'content-type': 'application/json' }
  });
}
