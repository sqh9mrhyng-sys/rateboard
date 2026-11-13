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
const JOBS_PORT = Number(process.env.JOBS_PORT || 8788), HEAVY_PORT = Number(process.env.HEAVY_PORT || 8789);
const PORT = ROLE === 'jobs' ? JOBS_PORT : ROLE === 'heavy' ? HEAVY_PORT : Number(process.env.PORT || 8787);
/* Big database reads (game log, plays, pack data, OTD, projections, boost
   plans) go to a 'heavy' process (2026-11-13): each runs for seconds and holds
   its process, so on the web processes they froze every page behind them. */
const HEAVY_RAX = /[?&](gamelog|plays|tags|tagview|golf|market)=/;
const HEAVY_OPS = new Set(['otdpool', 'games', 'boosttop', 'boostplan', 'boostdays', 'projections', 'tagview', 'packstoday', 'legboosts', 'search', 'passcounts', 'wantcounts']);
const isHeavy = u => { if (u.startsWith('/api/rax')) return HEAVY_RAX.test(u) && !/[?&]market=(me|post|offer)/.test(u);
  if (u.startsWith('/api/swaps')) { const m = /[?&]op=([a-z0-9]+)/.exec(u); return !!(m && HEAVY_OPS.has(m[1])); } return false; };
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
let inflight = 0, heavyWaiting = 0;
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
  // Health of the server itself - no member data (2026-11-13).
  if (req.url === '/__status') {
    let ev = ''; try { ev = fs.readFileSync(path.join(DATA, 'server-events.log'), 'utf8').split('\n').slice(-40).join('\n'); } catch (e) {}
    const os = await import('node:os');
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ role: ROLE, pid: process.pid, up: Math.round(process.uptime()), rssMB: Math.round(process.memoryUsage().rss / 1048576),
      heapMB: Math.round(process.memoryUsage().heapUsed / 1048576), inflight, freeMB: Math.round(os.freemem() / 1048576), totalMB: Math.round(os.totalmem() / 1048576),
      load: os.loadavg().map(x => +x.toFixed(2)), events: ev }, null, 1));
    inflight--; return;
  }
  /* At most 4 big reads waiting per web process (2026-11-13): a pile-up of
     them is what filled the droplet's memory. More get "busy, try again". */
  if (ROLE === 'web' && isHeavy(req.url) && heavyWaiting >= 4) { res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '5' }); res.end('{"error":"Busy - try again in a few seconds."}'); inflight--; return; }
  if (ROLE === 'web' && isHeavy(req.url)) {
    heavyWaiting++; let doneH = false; const endH = () => { if (!doneH) { doneH = true; heavyWaiting--; } };
    res.on('close', endH);
    // Passed through as-is; the heavy process answers with this request's own host.
    const hdr = { ...req.headers, 'x-forwarded-host': req.headers['x-forwarded-host'] || req.headers.host || '' };
    const up = http.request({ host: '127.0.0.1', port: HEAVY_PORT, method: req.method, path: req.url, headers: hdr }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); r.on('end', () => { inflight--; }); });
    up.on('error', () => { try { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":"Busy - try again in a moment."}'); } catch (e) {} inflight--; });
    up.setTimeout(120000, () => up.destroy());
    req.pipe(up); return;
  }
  try {
    const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0];
    const host = req.headers['x-forwarded-host'] || req.headers.host || `127.0.0.1:${PORT}`;
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (v != null) headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
    headers.set('cf-connecting-ip', ip);
    const hasBody = !['GET', 'HEAD'].includes(req.method);
    const request = new Request(`${proto}://${host}${req.url}`, { method: req.method, headers, body: hasBody ? req : undefined, duplex: hasBody ? 'half' : undefined });
    const t0r = Date.now(), m0 = process.memoryUsage().rss;
    const out = await handle(request);
    /* Slow answers are logged by path (and op), never with member details (2026-11-13), to find what loads the server. */
    { const ms = Date.now() - t0r, grew = Math.round((process.memoryUsage().rss - m0) / 1048576); if (ms > 3000 || grew > 200) { const u = new URL(request.url), op = u.searchParams.get('op') || [...u.searchParams.keys()].slice(0, 2).join(',');
      try { fs.appendFileSync(path.join(DATA, 'server-events.log'), `${new Date().toISOString()} ${ROLE} slow ${ms}ms +${grew}MB ${req.method} ${u.pathname}${op ? ' ' + op : ''} ${[...u.searchParams.entries()].filter(([k]) => /^(mode|format|seasons|sport|season|limit|gamelog|plays|market|sort)$/.test(k)).map(([k, v]) => k + '=' + String(v).slice(0, 40)).join('&')}\n`); } catch (e) {} } }
    const h = {}; out.headers.forEach((v, k) => { if (k === 'set-cookie') return; h[k] = v; });
    const cookies = out.headers.getSetCookie ? out.headers.getSetCookie() : [];
    if (cookies.length) h['set-cookie'] = cookies;
    res.writeHead(out.status, h);
    if (out.body && req.method !== 'HEAD') { for await (const chunk of out.body) res.write(chunk); }
    res.end();
    if (ROLE === 'heavy' && process.memoryUsage().rss > 1500 * 1048576 && inflight <= 1) { try { fs.appendFileSync(path.join(DATA, 'server-events.log'), `${new Date().toISOString()} heavy pid ${process.pid}: ${Math.round(process.memoryUsage().rss / 1048576)}MB after a request - restarting itself\n`); } catch (e) {} setTimeout(() => process.exit(0), 50); }
  } catch (e) {
    console.error('request failed', e);
    try { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('Server error'); } catch (x) {}
  } finally { inflight--; }
});
server.listen(PORT, '127.0.0.1', () => console.log(`Rax Academy (${ROLE}) on http://127.0.0.1:${PORT}`));
/* The heavy process restarts itself once it holds over 1.5GB (2026-11-13: it
   grew to 3GB of the droplet's 4GB). It waits for a quiet moment, up to 2GB. */
if (ROLE === 'heavy') setInterval(() => { const mb = process.memoryUsage().rss / 1048576;
  if (mb > 2000 || (mb > 1500 && inflight === 0)) { try { fs.appendFileSync(path.join(DATA, 'server-events.log'), `${new Date().toISOString()} heavy pid ${process.pid}: ${Math.round(mb)}MB - restarting itself\n`); } catch (e) {} process.exit(0); } }, 15000).unref();
// Every 5 minutes each process notes its memory and load (2026-11-13), so a crash leaves a trail.
let cpu0 = process.cpuUsage(), cpuT = Date.now();
setInterval(async () => { try { const os = await import('node:os'); const c = process.cpuUsage(cpu0), pct = Math.round((c.user + c.system) / 1000 / (Date.now() - cpuT) * 100); cpu0 = process.cpuUsage(); cpuT = Date.now();
  fs.appendFileSync(path.join(DATA, 'server-events.log'), `${new Date().toISOString()} ${ROLE} pid ${process.pid}: cpu ${pct}%, rss ${Math.round(process.memoryUsage().rss / 1048576)}MB, free ${Math.round(os.freemem() / 1048576)}MB, load ${os.loadavg()[0].toFixed(2)}, in flight ${inflight}\n`); } catch (e) {} }, 120000).unref();

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
  // The bot gets up to 45s to finish a DM run; long background jobs are left to pick up next start.
  const lim = ROLE === 'jobs' ? 45000 : 15000;
  while ((cronBusy() || inflight > 0 || (pending.size > 0 && Date.now() - t0 < 10000)) && Date.now() - t0 < lim) await new Promise(r => setTimeout(r, 250));
  server.close(); process.exit(0);
};
// Under the cluster, the main process says when to stop (in order); a stray signal is ignored.
if (process.send) { process.on('message', m => { if (m === 'stop') stop(); }); process.on('SIGTERM', () => {}); process.on('SIGINT', () => {}); }
else { process.on('SIGTERM', stop); process.on('SIGINT', stop); }
