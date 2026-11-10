// raxacademy.app is the board's address now. Anyone opening the old
// pages.dev address in a browser is sent there, path and query kept.
//
// /api/ is left alone on purpose: the cron Worker calls
// rateboard-cgi.pages.dev/api/rax every minute and is not being redeployed,
// and a redirect on that path would stop collection. Preview deployments
// (<hash>.rateboard-cgi.pages.dev) are a different host and are not touched.
//
// /__move is the other exception. Browsers keep saved data per address, so
// moving to raxacademy.app left every member signed out and their saved
// loadouts and settings behind on the old one. A browser arriving at the new
// address with nothing saved is bounced here once; this page reads what the
// old address holds and hands it back in the URL fragment, which never
// leaves the browser. index.html picks it up and stores it.
const OLD_HOST = 'rateboard-cgi.pages.dev';
const NEW_ORIGIN = 'https://raxacademy.app';

const MOVE_PAGE = `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Moving to raxacademy.app</title>
<p style="font:16px system-ui;padding:24px">Moving you to raxacademy.app…</p>
<script>
(function(){
  var out = {};
  try {
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      out[k] = localStorage.getItem(k);
    }
  } catch (e) {}
  var s = encodeURIComponent(JSON.stringify(out));
  // A huge saved loadout could push the address past what a browser will
  // take. The sign-in is what matters, so keep that if it comes to it.
  if (s.length > 1500000) {
    var keep = {};
    ['ratebrd_device_v1', 'ratebrd_session'].forEach(function(k){
      if (out[k] != null) keep[k] = out[k];
    });
    s = encodeURIComponent(JSON.stringify(keep));
  }
  var to = '/';
  try { to = new URLSearchParams(location.search).get('to') || '/'; } catch (e) {}
  if (to.charAt(0) !== '/' || to.charAt(1) === '/' || to.charAt(1) === '\\\\') to = '/';
  location.replace('${NEW_ORIGIN}' + to + '#rbmove=' + s);
})();
</script>`;

import { countPageView } from './api/sponsor.js';
import { isViewToken } from '../lib/auth.js';

/* Page views (2026-11-08): every page a person opens, counted per page per
   day - link previews, crawlers and prefetches left out. */
const PV_PAGES = { '/': 'home', '/index.html': 'home', '/board': 'board', '/board.html': 'board', '/market': 'market', '/market.html': 'market', '/swaps': 'swaps', '/swaps.html': 'swaps',
  '/hour': 'hour', '/hour.html': 'hour', '/otd': 'otd', '/otd.html': 'otd', '/boosts': 'boosts', '/boosts.html': 'boosts', '/projections': 'projections', '/projections.html': 'projections', '/tags': 'tags', '/tags.html': 'tags', '/packs': 'packs', '/packs.html': 'packs' };
const BOT_UA = /bot|crawl|spider|slurp|preview|facebookexternalhit|embedly|quora|whatsapp|telegram|discord|slack|twitter|headless|lighthouse|curl|wget|python|node-fetch|go-http/i;
function pageOf(request, url) {
  if (request.method !== 'GET') return null;
  const pg = PV_PAGES[url.pathname] || (url.pathname.startsWith('/h/') ? 'hour' : null);
  if (!pg) return null;
  const h = request.headers;
  if (BOT_UA.test(h.get('user-agent') || '')) return null;
  if (/prefetch|prerender/i.test((h.get('sec-purpose') || '') + (h.get('purpose') || ''))) return null;
  if (!(h.get('accept') || '').includes('text/html')) return null;
  return pg;
}

export async function onRequest({ request, next, env, waitUntil }) {
  const url = new URL(request.url);
  /* Home is the front page and the board lives at /board (Dennis, 2026-11-09):
     the old /home address goes to the front page. */
  if (url.pathname === '/home' || url.pathname === '/home.html') return Response.redirect(url.origin + '/' + url.search + url.hash, 301);
  /* View-as sessions are look-only (2026-11-10): no writes of any kind, and
     no scans started. Signing out of one is the only thing it may post. */
  if (url.pathname.startsWith('/api/') && isViewToken(request.headers.get('x-rb-token') || '')) {
    const m = request.method, op = url.searchParams.get('op') || '';
    let ok = m === 'GET' || m === 'HEAD';
    if (ok && ['scan', 'scantick', 'save', 'saveslots', 'pause', 'endall', 'confirm', 'dropwant', 'touch', 'keep', 'report', 'dmsend', 'dmopen', 'connect', 'inboxact'].includes(op)) ok = false;
    if (ok && /^(grant|revoke|reset|pullplayer)$/.test(url.searchParams.get('market') || '')) ok = false;
    if (!ok && m === 'POST' && url.pathname === '/api/kv') { try { const b = await request.clone().json(); if (b && b.op === 'signout') ok = true; } catch (e) {} }
    if (!ok) return new Response(JSON.stringify({ error: "You're viewing this account - look only, nothing is saved." }), { status: 403, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  }
  if (url.hostname !== OLD_HOST) { const pg = pageOf(request, url); if (pg && waitUntil) waitUntil(countPageView(env, pg)); }
  if (url.hostname === OLD_HOST) {
    if (url.pathname === '/__move') {
      return new Response(MOVE_PAGE, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
      });
    }
    if (!url.pathname.startsWith('/api/')) {
      return Response.redirect(NEW_ORIGIN + url.pathname + url.search, 302);
    }
  }
  const res = await next();
  // Every page carries the view-as bar (it shows only while viewing an account).
  if (request.method === 'GET' && (res.headers.get('content-type') || '').includes('text/html') && !url.pathname.startsWith('/api/'))
    return new HTMLRewriter().on('head', { element(el) { el.append('<script src="/viewas.js" defer></script>', { html: true }); } }).transform(res);
  return res;
}
