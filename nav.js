/* Page menu (Dennis, 2026-11-17): the dropdown at the top of every page, in place of the old Home links.
   Shows the pages this account can open, in the same order as the Home boxes, minus any the member
   hid under "Show in menu" on Home's UI panel. Drawn into each <span data-nav></span>. */
(function () {
  var PAGES = [
    ['/', 'Home'],
    ['/board', 'Board'],
    ['/board#otd', 'OTD'],
    ['/board#gamedata', 'Game data', 'admin'],
    ['/packs', 'Pack data'],
    ['/swaps', 'Swaps'],
    ['/boosts', 'Boosts/Buys'],
    ['/projections', 'Projections'],
    ['/bulk', 'Bulk ratings'],
    ['/predictions', 'Predictions', 'pred'],
    ['/fantasy', 'Fantasy optimizer', 'admin'],
    ['/market', 'CBB market', 'admin'],
    ['/graphics', 'Graphics', 'admin'],
    ['/tags', 'Tag finder'],
    ['/notifications', 'Notifications'],
    ['/admin', 'Admin', 'admin']
  ];
  // Default menu order (Dennis, 2026-11-17); a member's own order from the UI panel replaces it.
  var NAV_DEFAULT = ['/swaps', '/boosts', '/predictions', '/fantasy', '/market', '/graphics', '/board#otd', '/board', '/bulk', '/packs', '/projections', '/tags', '/notifications', '/board#gamedata', '/admin'];
  window.RB_NAV_PAGES = PAGES;
  var ls = { get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };
  var ss = { get: function (k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }, set: function (k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} } };
  var esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  // Access is cached per account (2026-11-17): switching or viewing as someone else re-checks it, so
  // their menu never shows pages only you can open.
  var tok = ls.get('ratebrd_token_v1') || '';
  var tkey = (function (x) { var h = 5381; for (var i = 0; i < x.length; i++) h = ((h << 5) + h + x.charCodeAt(i)) | 0; return String(h); })(tok);
  var ACC = {}, fresh = false; try { var c = JSON.parse(ss.get('rb_nav_acc_v1') || 'null'); if (c && c.t === tkey && Date.now() - c.at < 10 * 60e3) { ACC = c.acc || {}; fresh = true; } } catch (e) {}
  var ui = function () { try { return JSON.parse(ls.get('rb_ui_v1') || '{}') || {}; } catch (e) { return {}; } };
  var canOpen = function (p) { return !p[2] || (p[2] === 'pred' ? !!ACC.pred : !!ACC.admin); };

  function list() {
    var u = ui(), hid = u.navHidden || [], o = (u.navOrder && u.navOrder.length) ? u.navOrder : NAV_DEFAULT;
    var rest = PAGES.slice(1).filter(function (p) { return canOpen(p) && hid.indexOf(p[0]) < 0; });
    var pos = function (h, i) { var k = o.indexOf(h); return k < 0 ? 1e3 + i : k; };
    rest = rest.map(function (p, i) { return [p, pos(p[0], i)]; }).sort(function (a, b) { return a[1] - b[1]; }).map(function (x) { return x[0]; });
    return [PAGES[0]].concat(rest);
  }
  function here(h) { var p = location.pathname.replace(/\.html$/, '').replace(/\/$/, '') || '/', hh = location.hash;
    if (h.indexOf('#') > 0) return p + hh === h; if (h === '/board' && /^#(otd|gamedata)/.test(hh) && p === '/board') return false; return p === h; }

  var css = document.createElement('style');
  css.textContent = '.rbnav{position:relative;display:inline-flex}.rbnav-b{display:inline-flex;align-items:center;gap:7px;background:var(--panel2,#1d2433);color:var(--ink,#e8ecf3);border:1px solid var(--line,#2a3346);border-radius:10px;padding:7px 11px;font:700 14px system-ui,-apple-system,sans-serif;cursor:pointer;white-space:nowrap}'
    + '.rbnav-b:hover{border-color:var(--accent,#E8A33D)}.rbnav-b i{display:inline-block;width:14px;height:10px;background:linear-gradient(currentColor 0 0) top/100% 2px no-repeat,linear-gradient(currentColor 0 0) center/100% 2px no-repeat,linear-gradient(currentColor 0 0) bottom/100% 2px no-repeat}'
    + '.rbnav-m{position:fixed;z-index:9999;min-width:210px;max-width:calc(100vw - 24px);max-height:calc(100vh - 80px);overflow:auto;background:var(--panel,#161c28);border:1px solid var(--line,#2a3346);border-radius:12px;padding:6px;box-shadow:0 12px 32px rgba(0,0,0,.5)}'
    + '.rbnav-m a{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:8px;color:var(--ink,#e8ecf3);text-decoration:none;font:600 15px system-ui,-apple-system,sans-serif}'
    + '.rbnav-m a:hover{background:var(--panel2,#1d2433)}.rbnav-m a .d{width:7px;height:7px;border-radius:50%;background:var(--line,#2a3346);flex:none}'
    + '.rbnav-top{display:flex;justify-content:center;padding:10px 12px 0;position:relative;z-index:50}'
    + '.rbnav-top{gap:8px;flex-wrap:wrap;align-items:center}.rbscan b{font-size:15px;line-height:1}.rbscan.on b{display:inline-block;animation:rbspin 1s linear infinite}.rbscan:disabled{opacity:.8;cursor:default}@keyframes rbspin{to{transform:rotate(360deg)}}'
    + '.rbscan-m{flex-basis:100%;text-align:center;font:600 13px system-ui,-apple-system,sans-serif;color:var(--mute,#9aa3b5);min-height:0;padding:0 8px}.rbscan-m:empty{display:none}'
    + '.rbnav-m a.cur{color:var(--accent,#E8A33D);font-weight:800}.rbnav-m a.cur .d{background:var(--accent,#E8A33D)}.rbnav-m .s{height:1px;background:var(--line,#2a3346);margin:6px 4px}.rbnav-m a.cz{font-size:13px;color:var(--mute,#9aa3b5)}';
  document.head.appendChild(css);

  var open = null;
  function close() { if (open) { open.m.remove(); open.b.setAttribute('aria-expanded', 'false'); open = null; } }
  function show(b) {
    close();
    var m = document.createElement('div'); m.className = 'rbnav-m'; m.setAttribute('role', 'menu');
    m.innerHTML = list().map(function (p) { var c = here(p[0]); return '<a role="menuitem" href="' + esc(p[0]) + '"' + (c ? ' class="cur" aria-current="page"' : '') + '><span class="d"></span>' + esc(p[1]) + '</a>' + (p[0] === '/' ? '<div class="s"></div>' : ''); }).join('')
      + '<div class="s"></div><a role="menuitem" class="cz" href="/?ui=1">Customize this menu</a>';
    document.body.appendChild(m);
    var r = b.getBoundingClientRect(), w = m.offsetWidth;
    m.style.top = Math.round(r.bottom + 6) + 'px';
    m.style.left = Math.round(Math.max(12, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 12))) + 'px';
    m.addEventListener('click', function (e) { var a = e.target.closest('a'); if (a && a.getAttribute('href').indexOf('#') > 0 && location.pathname.replace(/\.html$/, '') === a.getAttribute('href').split('#')[0]) setTimeout(close, 0); });
    b.setAttribute('aria-expanded', 'true'); open = { m: m, b: b };
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('.rbnav-b:not(.rbscan)');
    if (b) { e.preventDefault(); if (open && open.b === b) close(); else show(b); return; }
    if (open && !open.m.contains(e.target)) close();
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
  addEventListener('resize', close); addEventListener('scroll', function (e) { if (open && !open.m.contains(e.target)) close(); }, true);

  // One centred bar at the very top of every page (not inside the OTD frame on the board).
  /* Scan button beside the menu (Dennis, 2026-11-17) on Boosts, Pack data, Board (OTD), Projections and Bulk:
     the site's one scan of your passes. Swaps keeps its own. When it finishes the page refreshes what it shows
     (window.rbAfterScan) or reloads. */
  var SCAN_PAGES = { '/boosts': 'boosts', '/packs': 'packs', '/board': 'board', '/projections': 'projections', '/bulk': 'bulk' };
  var path0 = location.pathname.replace(/\.html$/, '').replace(/\/$/, '') || '/';
  var scanPage = SCAN_PAGES[path0] || null;
  function draw() {
    if (window.top !== window || document.querySelector('.rbnav-top')) return;
    var d = document.createElement('div'); d.className = 'rbnav-top';
    d.innerHTML = '<span class="rbnav"><button type="button" class="rbnav-b" aria-haspopup="menu" aria-expanded="false"><i></i>Menu &#9662;</button></span>'
      + (scanPage && tok ? '<button type="button" class="rbnav-b rbscan" id="rbscan"><b>&#10227;</b>Scan</button>' : '')
      + (scanPage && tok ? '<div class="rbscan-m" id="rbscanmsg" role="status" aria-live="polite"></div>' : '');
    document.body.insertBefore(d, document.body.firstChild);
    var b = document.getElementById('rbscan'); if (b) b.addEventListener('click', function () { runScan(); });
    if (scanPage && tok) setTimeout(function () { fetch('/api/swaps?op=scanstatus&page=' + scanPage, { headers: { 'x-rb-token': tok } }).then(function (r) { return r.json(); })
      .then(function (st) { if (st && (st.state === 'queued' || st.state === 'running')) runScan(); }).catch(function () {}); }, 400);
  }
  var scanning = false;
  function say(t) { var m = document.getElementById('rbscanmsg'); if (m) m.textContent = t || ''; }
  function api(u) { return fetch(u, { headers: { 'x-rb-token': tok } }).then(function (r) { return r.json().catch(function () { return { error: 'Could not reach the site.' }; }); }, function () { return { error: 'Could not reach the site.' }; }); }
  var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  async function runScan() {
    if (scanning) return; scanning = true;
    var b = document.getElementById('rbscan'); if (b) { b.disabled = true; b.classList.add('on'); }
    say('Scanning your passes - usually about 25 seconds.');
    var part = 0, j = null, waits = 0, canDm = null;
    try {
      for (var i = 0; i < 60; i++) {
        j = await api('/api/swaps?op=scan&part=' + part + '&page=' + scanPage);
        if (j && j.dm != null) canDm = j.dm;
        if (j && j.queued) { say("You're #" + j.position + ' in the scan line - about ' + j.wait + '. ' + (canDm ? "You can leave - we'll DM you on Real when it's done." : 'You can leave - it keeps running.')); await wait(4000); i--; if (++waits > 900) { j = { error: 'The scan line is very long right now - try again later.' }; break; } continue; }
        if (j && j.busy) { await wait(3000); i--; if (++waits > 900) { j = { error: 'Try again in a minute.' }; break; } continue; }
        if (!j || j.error || j.done) break;
        say('Scanning your passes - usually about 25 seconds.'); part = j.next;
      }
      if (!j) j = { error: 'Could not reach the site.' };
      if (!j.error && !j.done) j = { error: 'The scan took too long - try again.' };
    } catch (e) { j = { error: 'Could not reach the site.' }; }
    scanning = false; if (b) { b.disabled = false; b.classList.remove('on'); }
    if (j.error) { say(j.error); return; }
    if (j.cached) { say(j.note || 'Using your last scan.'); return; }
    say(((j.passes || []).length) + ' passes read just now.' + (j.note ? ' ' + j.note : ''));
    try { window.dispatchEvent(new CustomEvent('rb-scanned', { detail: j })); } catch (e) {}
    if (typeof window.rbAfterScan === 'function') { try { await window.rbAfterScan(j); } catch (e) {} }
    else setTimeout(function () { location.reload(); }, 1200);
  }
  window.rbScan = runScan;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', draw); else draw();
  window.rbNavDraw = draw;

  // Access (for Predictions / Admin) and the latest menu settings, once every 10 minutes per tab.
  if (tok && !fresh) {
    fetch('/api/rax?market=me', { headers: { 'x-rb-token': tok } }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j || !j.signedIn) return; ACC = { admin: !!j.admin, pred: !!j.pred }; ss.set('rb_nav_acc_v1', JSON.stringify({ at: Date.now(), t: tkey, acc: ACC }));
    }).catch(function () {});
    fetch('/api/kv', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-rb-token': tok }, body: JSON.stringify({ op: 'uiPrefs' }) }).then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.prefs) { var u = ui(); u.navHidden = j.prefs.navHidden || []; u.navOrder = j.prefs.navOrder || []; u.hideReps = j.prefs.hideReps || []; ls.set('rb_ui_v1', JSON.stringify(u)); }
    }).catch(function () {});
  }
})();
