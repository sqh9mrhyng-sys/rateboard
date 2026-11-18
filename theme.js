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
try { if (navigator.serviceWorker) navigator.serviceWorker.addEventListener('message', function (e) { var u = e.data && e.data.rbGo; if (!u) return;
  try { var t = new URL(u, location.href); if (t.origin !== location.origin) return; if (t.href !== location.href) location.href = t.href; } catch (x) {} }); } catch (e) {}
