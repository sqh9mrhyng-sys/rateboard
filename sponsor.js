/* Sponsor banner (2026-11-08). Each page loads this with data-page="<name>";
   it asks /api/sponsor whether a sponsor is live there and, if so, puts one
   "Sponsored" banner at the top of the page. Nothing shows when it's off. */
(function () {
  var me = document.currentScript, page = (me && me.getAttribute('data-page')) || 'other';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function place(el) {
    var slot = document.querySelector('[data-sponsor-slot]');
    if (slot) { slot.appendChild(el); return; }
    var wrap = document.querySelector('.wrap'), head = wrap && wrap.querySelector('header');
    if (head && head.parentNode) head.parentNode.insertBefore(el, head.nextSibling);
    else if (wrap) wrap.insertBefore(el, wrap.firstChild);
    else document.body.insertBefore(el, document.body.firstChild);
  }
  function show(j) {
    if (!j || !j.on) return;
    var st = document.createElement('style');
    st.textContent = '.rb-sp{display:flex;align-items:center;gap:12px;margin:10px 0 14px;padding:10px 12px;border:1px solid rgba(232,166,74,.45);border-radius:12px;background:rgba(232,166,74,.08);color:inherit;text-decoration:none}'
      + '.rb-sp img{width:44px;height:44px;border-radius:9px;object-fit:cover;flex:0 0 auto}'
      + '.rb-sp .rb-t{flex:1 1 auto;min-width:0;font-size:14px;line-height:1.35}'
      + '.rb-sp .rb-t b{display:block;font-size:15px}'
      + '.rb-sp .rb-l{font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;opacity:.6}'
      + '.rb-sp .rb-c{flex:0 0 auto;padding:8px 12px;border-radius:9px;background:#e8a64a;color:#1a1206;font-weight:700;font-size:13.5px;white-space:nowrap}';
    document.head.appendChild(st);
    var a = document.createElement('a');
    a.className = 'rb-sp'; a.href = j.href; a.target = '_blank'; a.rel = 'noopener sponsored';
    a.innerHTML = (j.img ? '<img src="' + esc(j.img) + '" alt="">' : '')
      + '<span class="rb-t"><span class="rb-l">Sponsored</span><b>' + esc(j.name) + '</b>' + (j.text ? esc(j.text) : '') + '</span>'
      + '<span class="rb-c">' + esc(j.cta || 'Learn more') + '</span>';
    place(a);
  }
  function go() { try { fetch('/api/sponsor?p=' + encodeURIComponent(page)).then(function (r) { return r.json(); }).then(show).catch(function () {}); } catch (e) {} }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go();
})();
