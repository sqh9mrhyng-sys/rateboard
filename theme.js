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
function rbNavCheck() {
  try { if (!window.caches) return; caches.open('rb-nav').then(function (c) { return c.match('/__rbnav').then(function (r) { if (!r) return;
    return r.json().then(function (j) { c.delete('/__rbnav'); if (j && j.url && Date.now() - j.at < 120000) rbGo(j.url); }); }); }).catch(function () {}); } catch (x) {}
}
try { if (navigator.serviceWorker) navigator.serviceWorker.addEventListener('message', function (e) { var u = e.data && e.data.rbGo; if (!u) return;
  try { caches.open('rb-nav').then(function (c) { c.delete('/__rbnav'); }); } catch (x) {} rbGo(u); }); } catch (e) {}
/* Backup for alerts (2026-11-18): if the app comes back on screen within 3 minutes of a Predictions alert that
   hasn't been opened yet, open it. Only for members who get alerts (Predictions sets rb_pred_alerts). */
function rbAlertCheck() {
  try { if (localStorage.getItem('rb_pred_alerts') !== '1') return; var t = localStorage.getItem('ratebrd_token_v1') || '';
    fetch('/api/swaps?op=lastalert', { headers: t ? { 'x-rb-token': t } : {} }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j || !j.url || !j.at || Date.now() - j.at > 180000) return;
      var seen = Number(localStorage.getItem('rb_alert_seen')) || 0; if (j.at <= seen) return;
      localStorage.setItem('rb_alert_seen', String(j.at)); rbGo(j.url); }).catch(function () {}); } catch (x) {}
}
rbNavCheck(); rbAlertCheck();
document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') { rbNavCheck(); rbAlertCheck(); } });
/* Keep the notification helper current, so tap handling updates reach phones without a reinstall. */
try { if (navigator.serviceWorker) navigator.serviceWorker.getRegistration().then(function (r) { if (r) r.update(); }).catch(function () {}); } catch (x) {}
window.addEventListener('pageshow', rbNavCheck);

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
