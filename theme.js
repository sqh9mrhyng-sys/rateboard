/* Look settings (Dennis, 2026-11-16): the colour theme a member picked on Home's UI panel, applied to
   every page before it draws. Saved per account on the server and cached here. */
(function () {
  var T = {
    midnight: { bg: '#0b0e14', panel: '#121722', panel2: '#18202e', line: '#232c3d', accent: '#E8A33D', tile: '#3d6fd6' },
    ocean:    { bg: '#0c1a22', panel: '#12252e', panel2: '#182f3a', line: '#22404c', accent: '#2ec4b6', tile: '#1f9fb0' },
    forest:   { bg: '#0f1a14', panel: '#15241b', panel2: '#1b2e22', line: '#27402f', accent: '#7bd88f', tile: '#3a9d5d' },
    plum:     { bg: '#16111e', panel: '#1f1829', panel2: '#281f35', line: '#3a2c4d', accent: '#c08bff', tile: '#8b5cf6' },
    crimson:  { bg: '#190f11', panel: '#231618', panel2: '#2d1c1f', line: '#45292c', accent: '#ff7a6b', tile: '#d64545' },
    slate:    { bg: '#1b1e23', panel: '#23272e', panel2: '#2b3038', line: '#3a404b', accent: '#e9c46a', tile: '#6b7a90' }
  };
  // Your own colours (2026-11-16): background, boxes and highlight from the colour wheel; the panels
  // and lines are worked out from the background so everything stays readable.
  var hex = function (h) { h = String(h || '').replace('#', ''); return /^[0-9a-f]{6}$/i.test(h) ? h : null; };
  var mix = function (h, w, t) { var a = parseInt(h, 16), b = parseInt(w, 16), o = ''; for (var i = 16; i >= 0; i -= 8) { var x = (a >> i) & 255, y = (b >> i) & 255; o += ('0' + Math.round(x + (y - x) * t).toString(16)).slice(-2); } return '#' + o; };
  window.rbCustomTheme = function (c) { var bg = hex(c && c.bg) || '141925', ac = hex(c && c.accent) || 'E8A33D', tl = hex(c && c.tile) || '3d6fd6';
    return { bg: '#' + bg, panel: mix(bg, 'ffffff', 0.05), panel2: mix(bg, 'ffffff', 0.09), line: mix(bg, 'ffffff', 0.16), accent: '#' + ac, tile: '#' + tl }; };
  window.RB_THEMES = T;
  window.rbApplyTheme = function (name, custom) {
    var t = name === 'custom' ? window.rbCustomTheme(custom) : T[name], r = document.documentElement;
    ['bg', 'panel', 'panel2', 'line', 'accent', 'tile'].forEach(function (k) { if (t) r.style.setProperty('--' + k, t[k]); else r.style.removeProperty('--' + k); });
    r.setAttribute('data-theme', t ? name : 'default');
  };
  var p = {}; try { p = JSON.parse(localStorage.getItem('rb_ui_v1') || '{}') || {}; } catch (e) {}
  if (p.theme) window.rbApplyTheme(p.theme, p.custom);
})();
// A tapped notification asks an open window to go to its page (see sw.js, 2026-11-17). On every page, Home too.
/* Same page, other spot (or the same game again): no reload happens, so the page is told the hash changed. */
function rbGo(u) {
  try { var t = new URL(u, location.href); if (t.origin !== location.origin) return;
    if (/g=\d/.test(t.hash)) { try { localStorage.setItem('rb_alert_seen', String(Date.now())); } catch (x) {} }
    if (t.pathname.replace(/\.html$/, '') === location.pathname.replace(/\.html$/, '') && t.search === location.search) {
      if (t.hash !== location.hash) location.hash = t.hash; else window.dispatchEvent(new HashChangeEvent('hashchange')); }
    else location.href = t.href; } catch (x) {}
}
// Each tap is acted on once (its id), whichever way it arrives first: the message or the note in the cache.
function rbNavOnce(u, id) {
  try { caches.open('rb-nav').then(function (c) { c.delete('/__rbnav'); }); } catch (x) {}
  try { if (id) { if (localStorage.getItem('rb_nav_done') === id) return; localStorage.setItem('rb_nav_done', id); } } catch (x) {}
  rbGo(u);
}
function rbNavCheck() {
  try { if (!window.caches) return; caches.open('rb-nav').then(function (c) { return c.match('/__rbnav').then(function (r) { if (!r) return;
    return r.json().then(function (j) { if (j && j.url && Date.now() - j.at < 120000) rbNavOnce(j.url, j.id); else c.delete('/__rbnav'); }); }); }).catch(function () {}); } catch (x) {}
}
/* Coming back from another app (2026-11-19): the page can wake before the tap is written down, so it looks
   again a few times over the next few seconds. */
function rbNavServer() {
  try { if (!('Notification' in window) || Notification.permission !== 'granted') return; var t = localStorage.getItem('ratebrd_token_v1') || ''; if (!t) return;
    fetch('/api/swaps?op=navtap', { headers: { 'x-rb-token': t }, cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) { if (j && j.url) rbNavOnce(j.url, j.nid); }).catch(function () {}); } catch (x) {}
}
function rbNavSoon() { rbNavCheck(); rbNavServer(); [300, 900, 2000, 4000].forEach(function (ms) { setTimeout(rbNavCheck, ms); }); [1200, 3000, 6000].forEach(function (ms) { setTimeout(rbNavServer, ms); }); }
try { if (navigator.serviceWorker) navigator.serviceWorker.addEventListener('message', function (e) { var u = e.data && e.data.rbGo; if (!u) return; rbNavOnce(u, e.data.id); }); } catch (e) {}
/* Backup for alerts (2026-11-18): if the app comes back on screen within 3 minutes of a Predictions alert that
   hasn't been opened yet, open it. Only for members who get alerts (Predictions sets rb_pred_alerts). */
/* 2026-11-23 (zachery via Dennis: "when a new big EV comes up it immediately kicks you off the screen for the
   previous one"): while you're looking at an alert, a newer one never takes over the screen - a bar at the top
   offers it instead, and you open it when you're done. Predictions also checks every 20 seconds while it's open,
   and that check only ever shows the bar. */
function rbOnAlert() { return /\/predictions/.test(location.pathname) && /[#&]g=\d/.test(location.hash); }
function rbAlertBar(j) {
  try { var old = document.getElementById('rbalert'); if (old) old.remove();
    var d = document.createElement('div'); d.id = 'rbalert';
    d.style.cssText = 'position:fixed;left:10px;right:10px;top:calc(8px + env(safe-area-inset-top));z-index:10001;display:flex;gap:8px;align-items:center;padding:10px 12px;border-radius:12px;background:var(--panel,#161c28);color:var(--ink,#e8ecf3);border:1px solid var(--accent,#E8A33D);font:600 14px system-ui,-apple-system,sans-serif;box-shadow:0 10px 28px rgba(0,0,0,.55)';
    var bs = 'border-radius:9px;padding:8px 12px;font:800 14px system-ui,-apple-system,sans-serif;border:1px solid var(--accent,#E8A33D)';
    d.innerHTML = '<span style="flex:1;min-width:0"><small style="display:block;font-size:11px;font-weight:800;color:var(--accent,#E8A33D);text-transform:uppercase;letter-spacing:.04em">New alert</small><span data-t style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span></span><button type="button" data-a="view" style="' + bs + ';background:var(--accent,#E8A33D);color:#141925">View</button><button type="button" data-a="x" aria-label="Dismiss" style="' + bs + ';background:none;color:var(--ink,#e8ecf3);border-color:var(--line,#2a3346)">&times;</button>';
    d.querySelector('[data-t]').textContent = j.title || 'A new value alert';
    d.addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b) return; d.remove(); if (b.dataset.a === 'view') rbGo(j.url); });
    document.body.appendChild(d); } catch (x) {}
}
function rbAlertCheck(barOnly) {
  try { if (localStorage.getItem('rb_pred_alerts') !== '1') return; var t = localStorage.getItem('ratebrd_token_v1') || '';
    fetch('/api/swaps?op=lastalert', { headers: t ? { 'x-rb-token': t } : {}, cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j || !j.url || !j.at || Date.now() - j.at > 180000) return;
      var seen = Number(localStorage.getItem('rb_alert_seen')) || 0; if (j.at <= seen) return;
      localStorage.setItem('rb_alert_seen', String(j.at));
      var cur = (location.hash.match(/[#&]g=(\d+)/) || [])[1], nu = (String(j.url).match(/[#&]g=(\d+)/) || [])[1];
      if (cur && nu && cur === nu && /\/predictions/.test(location.pathname)) return;   // already looking at that game
      if (barOnly || rbOnAlert()) rbAlertBar(j); else rbGo(j.url); }).catch(function () {}); } catch (x) {}
}
setInterval(function () { if (document.visibilityState === 'visible' && /\/predictions/.test(location.pathname)) rbAlertCheck(true); }, 20000);
rbNavSoon(); rbAlertCheck();
document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') { rbNavSoon(); rbAlertCheck(); } });
window.addEventListener('focus', rbNavSoon);
/* Keep the notification helper current, so tap handling updates reach phones without a reinstall. */
try { if (navigator.serviceWorker) navigator.serviceWorker.getRegistration().then(function (r) { if (r) r.update(); }).catch(function () {}); } catch (x) {}
window.addEventListener('pageshow', rbNavSoon);

/* Real links from the home-screen app (2026-11-19: a boost opened a blank in-app browser). In the app, a link
   opened in a new window lands in iOS's in-app viewer, which can't hand off to Real's app. A plain tap on the
   link (same window) is what lets iOS open it in Real's app instead. */
(function () {
  try {
    var app = (window.navigator && window.navigator.standalone) || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
    if (!app) return;
    var real = function (h) { return /^https:\/\/(www\.)?(realapp\.com|realsports\.io)\//i.test(h || ''); };
    document.addEventListener('click', function (e) {
      var a = e.target && e.target.closest && e.target.closest('a[href]'); if (!a || !real(a.href)) return;
      if (a.target) a.removeAttribute('target');
    }, true);
    var wo = window.open;
    window.open = function (u) { if (real(String(u || ''))) { location.href = u; return null; } return wo.apply(window, arguments); };
  } catch (x) {}
})();
/* Where you were (Dennis, 2026-11-23: a notification's page gets "back to *where they were*"): the last page you
   had open, saved as you leave it or open it. An alert page itself (#g=) is never saved. */
(function () {
  function mark() { try { if (/[#&]g=/.test(location.hash)) return; var p = location.pathname.replace(/\.html$/, '') || '/';
    localStorage.setItem('rb_prev_page', JSON.stringify({ p: p + location.search + location.hash, t: document.title || '', at: Date.now() })); } catch (e) {} }
  window.rbPrevPage = function () { try { var x = JSON.parse(localStorage.getItem('rb_prev_page') || 'null'); if (!x || !x.p) return null;
    var path = String(x.p).split('?')[0], base = path.split('#')[0], L = window.RB_NAV_PAGES || [], hit = null;
    for (var i = 0; i < L.length; i++) if (L[i][0] === path) hit = L[i][1]; if (!hit) for (var j = 0; j < L.length; j++) if (L[j][0] === base) hit = L[j][1];
    return { href: x.p, name: hit || String(x.t || '').split(/ [-–·|] /)[0] || 'previous page', same: base === location.pathname.replace(/\.html$/, '') }; } catch (e) { return null; } };
  if (document.readyState === 'complete') mark(); else addEventListener('load', mark);
  addEventListener('pagehide', mark); document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') mark(); });
  addEventListener('hashchange', function () { if (!/[#&]g=/.test(location.hash)) mark(); });
})();

/* Grey/blank screens in the home-screen app (Dennis, 2026-11-23). The app has no back button, so a page with no
   menu was a dead end you could only leave by force-closing. Any page without the menu gets a small Home button
   in the app. A page brought back from iOS's back cache is also made visible again and, if it's been away over
   10 minutes, reloaded so it isn't stale or half-drawn. */
(function () {
  var app = false; try { app = window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches; } catch (e) {}
  var left = 0;
  addEventListener('pagehide', function () { left = Date.now(); });
  addEventListener('pageshow', function (e) {
    try { document.documentElement.style.visibility = ''; } catch (x) {}
    if (e.persisted && left && Date.now() - left > 600000) location.reload();
  });
  if (!app || window.top !== window) return;
  function home() {
    if ((location.pathname.replace(/\.html$/, '').replace(/\/$/, '') || '/') === '/') return;
    if (document.querySelector('.rbnav-top') || document.getElementById('rbhome')) return;
    var a = document.createElement('a'); a.id = 'rbhome'; a.href = '/'; a.textContent = '⌂ Home';
    a.style.cssText = 'position:fixed;left:12px;bottom:calc(12px + env(safe-area-inset-bottom));z-index:9999;padding:9px 14px;border-radius:999px;background:var(--panel2,#1d2433);color:var(--ink,#e8ecf3);border:1px solid var(--line,#2a3346);font:700 14px system-ui,-apple-system,sans-serif;text-decoration:none;box-shadow:0 6px 18px rgba(0,0,0,.4)';
    document.body.appendChild(a);
  }
  function later() { setTimeout(home, 1500); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', later); else later();
})();

/* Stuck page changes in the home-screen app (Dennis, 2026-11-23: tapped Board from the menu on Admin and the
   screen froze). iOS keeps showing the old page until the new one arrives, and the app has no reload button,
   so a slow or dropped load looked like a freeze. If a tapped page hasn't opened after 7 seconds, a bar offers
   Try again or Stay here. */
(function () {
  var app = false; try { app = window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches; } catch (e) {}
  if (!app || window.top !== window) return;
  var timer = null, bar = null;
  function clear() { clearTimeout(timer); timer = null; if (bar) { bar.remove(); bar = null; } }
  function show(href, name) {
    if (bar) bar.remove();
    bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;left:12px;right:12px;bottom:calc(14px + env(safe-area-inset-bottom));z-index:10000;display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:12px 14px;border-radius:12px;background:var(--panel,#161c28);color:var(--ink,#e8ecf3);border:1px solid var(--accent,#E8A33D);font:600 14px system-ui,-apple-system,sans-serif;box-shadow:0 10px 28px rgba(0,0,0,.5)';
    var bs = 'border:1px solid var(--line,#2a3346);background:var(--panel2,#1d2433);color:var(--ink,#e8ecf3);border-radius:9px;padding:8px 12px;font:700 14px system-ui,-apple-system,sans-serif';
    bar.innerHTML = '<span style="flex:1 1 160px"></span><button type="button" data-a="retry" style="' + bs + ';border-color:var(--accent,#E8A33D)">Try again</button><button type="button" data-a="stay" style="' + bs + '">Stay here</button>';
    bar.firstChild.textContent = (name ? name : 'That page') + ' is taking a while to open.';
    bar.addEventListener('click', function (e) {
      var a = e.target.closest('button'); if (!a) return;
      if (a.dataset.a === 'retry') { clear(); try { window.stop(); } catch (x) {} go(href, name); }
      else { clear(); try { window.stop(); } catch (x) {} }
    });
    document.body.appendChild(bar);
  }
  function go(href, name) { clearTimeout(timer); timer = setTimeout(function () { show(href, name); }, 7000); location.href = href; }
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey) return;
    var a = e.target.closest && e.target.closest('a[href]'); if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
    var u; try { u = new URL(a.getAttribute('href'), location.href); } catch (x) { return; }
    if (u.origin !== location.origin) return;
    if (u.pathname === location.pathname && u.search === location.search) return;   // same page (hash links)
    var name = (a.textContent || '').trim().slice(0, 40);
    clearTimeout(timer); timer = setTimeout(function () { show(u.href, name); }, 7000);
  });
  addEventListener('pagehide', clear);
  addEventListener('pageshow', clear);
})();
