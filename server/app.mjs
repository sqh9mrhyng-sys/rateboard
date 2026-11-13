/* Rax Academy on its own server (2026-11-12, moving off Cloudflare Pages).
   Serves the site's pages and runs the same /api functions, with the
   Cloudflare pieces swapped for local ones (shims.mjs). Every minute it does
   what the old cron Worker did. Settings come from the environment
   (/opt/rax/.env, loaded by systemd): RS_AUTH_TOKEN, RS_MARKET_TOKEN,
   RS_SWAP_TOKEN, PORT, DATA_DIR. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { D1, KV, caches, HTMLRewriter } from './shims.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/* Roles (2026-11-12: one process meant a long database job froze every page
   for up to 25 seconds): 'web' processes answer members on PORT; one 'jobs'
   process runs the bot and the collectors on JOBS_PORT, so its heavy work
   never holds up a page. */
const ROLE = process.env.ROLE || 'all';
const PORT = ROLE === 'jobs' ? Number(process.env.JOBS_PORT || 8788) : Number(process.env.PORT || 8787);
const JOBS_PORT = Number(process.env.JOBS_PORT || 8788);
const DATA = process.env.DATA_DIR || '/opt/rax/data';
fs.mkdirSync(DATA, { recursive: true });

globalThis.caches = caches;
globalThis.HTMLRewriter = HTMLRewriter;

const env = {
  RATEBOARD_DB: new D1(path.join(DATA, 'rateboard.db')),
  RATEBOARD_KV: new KV(path.join(DATA, 'kv.db')),
  RS_AUTH_TOKEN: process.env.RS_AUTH_TOKEN,
  RS_MARKET_TOKEN: process.env.RS_MARKET_TOKEN,
  RS_SWAP_TOKEN: process.env.RS_SWAP_TOKEN,
};

const mod = async f => import(pathToFileURL(path.join(ROOT, 'functions', f)).href);
const ROUTES = {};
for (const f of fs.readdirSync(path.join(ROOT, 'functions', 'api'))) if (f.endsWith('.js')) ROUTES['/api/' + f.slice(0, -3)] = await mod('api/' + f);
const HOUR = await mod('h/[code].js');
const MIDDLE = await mod('_middleware.js');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webp': 'image/webp', '.gif': 'image/gif', '.txt': 'text/plain; charset=utf-8', '.sh': 'text/plain; charset=utf-8', '.woff2': 'font/woff2', '.xml': 'application/xml' };
const HIDDEN = /^\/(server|functions|lib|worker|node_modules|examples)(\/|$)|\/\.|package(-lock)?\.json$|\.md$/;

function fileFor(p) {
  if (HIDDEN.test(p)) return null;
  const tries = p.endsWith('/') ? [p + 'index.html'] : [p, p + '.html', p + '/index.html'];
  for (const t of tries) {
    const f = path.join(ROOT, path.normalize(decodeURIComponent(t)));
    if (!f.startsWith(ROOT)) return null;
    try { if (fs.statSync(f).isFile()) return f; } catch (e) {}
  }
  return null;
}
function serveStatic(req) {
  const u = new URL(req.url);
  if (u.pathname.endsWith('.html')) {   // Cloudflare Pages drops .html from addresses
    const to = u.pathname === '/index.html' ? '/' : u.pathname.slice(0, -5);
    return new Response(null, { status: 308, headers: { location: to + u.search } });
  }
  const f = fileFor(u.pathname) || fileFor('/index.html');   // no 404 page: Pages serves the front page
  const ext = path.extname(f).toLowerCase();
  const body = fs.readFileSync(f);
  return new Response(req.method === 'HEAD' ? null : body, { status: 200, headers: {
    'content-type': TYPES[ext] || 'application/octet-stream',
    'cache-control': ext === '.html' ? 'no-cache' : /^\/(img|data)\//.test(u.pathname) ? 'public, max-age=3600' : 'public, max-age=300' } });
}

async function route(ctx) {
  const u = new URL(ctx.request.url), m = ctx.request.method.toUpperCase();
  let h = null, params = {};
  if (ROUTES[u.pathname]) h = ROUTES[u.pathname];
  else if (/^\/h\/[^/]+$/.test(u.pathname)) { h = HOUR; params = { code: decodeURIComponent(u.pathname.slice(3)) }; }
  if (!h) return serveStatic(ctx.request);
  const fn = h['onRequest' + m[0] + m.slice(1).toLowerCase()] || h.onRequest;
  if (!fn) return new Response('Method not allowed', { status: 405 });
  return fn({ ...ctx, params });
}

/* Polite restarts (2026-11-12): updates can land any minute. On a restart the
   server stops taking new requests, lets every request and background job in
   flight finish (a DM tick included), then exits - nothing is cut off midway. */
let inflight = 0;
const pending = new Set();
async function handle(request) {
  const waits = [];
  const waitUntil = p => { const q = Promise.resolve(p).catch(e => console.error('waitUntil:', e && e.message)).finally(() => pending.delete(q)); pending.add(q); waits.push(q); };
  const ctx = { request, env, waitUntil, data: {}, passThroughOnException() {} };
  ctx.next = async () => route(ctx);
  let res;
  try { res = MIDDLE.onRequest ? await MIDDLE.onRequest(ctx) : await route(ctx); }
  catch (e) { console.error(request.method, request.url, e); res = new Response(JSON.stringify({ error: 'Server error: ' + (e && e.message) }), { status: 500, headers: { 'content-type': 'application/json' } }); }
  return res;
}

const server = http.createServer(async (req, res) => {
  inflight++;
  try {
    const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0];
    const host = req.headers['x-forwarded-host'] || req.headers.host || `127.0.0.1:${PORT}`;
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (v != null) headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
    headers.set('cf-connecting-ip', ip);
    const hasBody = !['GET', 'HEAD'].includes(req.method);
    const request = new Request(`${proto}://${host}${req.url}`, { method: req.method, headers, body: hasBody ? req : undefined, duplex: hasBody ? 'half' : undefined });
    const out = await handle(request);
    const h = {}; out.headers.forEach((v, k) => { if (k === 'set-cookie') return; h[k] = v; });
    const cookies = out.headers.getSetCookie ? out.headers.getSetCookie() : [];
    if (cookies.length) h['set-cookie'] = cookies;
    res.writeHead(out.status, h);
    if (out.body && req.method !== 'HEAD') { for await (const chunk of out.body) res.write(chunk); }
    res.end();
  } catch (e) {
    console.error('request failed', e);
    try { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('Server error'); } catch (x) {}
  } finally { inflight--; }
});
server.listen(PORT, '127.0.0.1', () => console.log(`Rax Academy (${ROLE}) on http://127.0.0.1:${PORT}`));

/* The old cron Worker, every minute: it pokes the collectors on /api/rax
   (which also starts the swap DM and scan ticks). Its address is pointed here. */
const OLD = 'https://rateboard-cgi.pages.dev';
const realFetch = globalThis.fetch;
globalThis.fetch = (u, init) => {
  if (typeof u === 'string' && u.startsWith(OLD)) u = `http://127.0.0.1:${ROLE === 'all' ? PORT : JOBS_PORT}` + u.slice(OLD.length);
  return realFetch(u, init);
};
let stopping = false, cronBusy = () => false;
if (process.env.NO_CRON !== '1' && ROLE !== 'web') {
  const cron = (await import(pathToFileURL(path.join(ROOT, 'worker', 'rateboard-cron.js')).href)).default;
  let busy = false;
  const tick = async () => { if (busy || stopping) return; busy = true;
    try { await cron.scheduled({ scheduledTime: Date.now(), cron: '* * * * *' }, env, { waitUntil() {} }); } catch (e) { console.error('cron', e && e.message); }
    busy = false; };
  setTimeout(() => { tick(); setInterval(tick, 60000); }, (60 - new Date().getSeconds()) * 1000);
  cronBusy = () => busy;
}
const stop = async () => {
  if (stopping) return; stopping = true;
  console.log('stopping: letting work in flight finish');
  // Our own server keeps answering the bot's self-calls until the work is done; only then closes.
  const t0 = Date.now();
  while ((cronBusy() || inflight > 0 || pending.size > 0) && Date.now() - t0 < 85000) await new Promise(r => setTimeout(r, 250));
  server.close(); process.exit(0);
};
process.on('SIGTERM', stop); process.on('SIGINT', stop);
