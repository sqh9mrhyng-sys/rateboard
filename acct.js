/* Account switcher for any page (Dennis, 2026-11-09): put <span data-acct></span>
   where it should go. Same saved accounts as Home and the board: tap one to
   switch (the page reloads as that account), or add a new one (the board's
   sign-in, with this account kept). */
(function(){
  var TOKEN = 'ratebrd_token_v1', DEVICE = 'ratebrd_device_v1', SESSION = 'ratebrd_session', ACCTS = 'ratebrd_accounts_v1';
  function get(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } }
  function set(k, v){ try{ v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); }catch(e){} }
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function device(){ try{ var d = JSON.parse(get(DEVICE) || 'null'); if(d && d.key) return d; }catch(e){} var s = get(SESSION); return s ? { key: s, name: s } : null; }
  function accts(){ try{ var a = JSON.parse(get(ACCTS) || '[]'); return Array.isArray(a) ? a.filter(function(x){ return x && x.key && x.token; }) : []; }catch(e){ return []; } }
  function keepCurrent(){ var d = device(), t = get(TOKEN); if(!d || !t) return; var a = accts().filter(function(x){ return x.key !== d.key; }); a.unshift({ key: d.key, name: d.name || d.key, token: t }); set(ACCTS, JSON.stringify(a.slice(0, 8))); }

  var css = document.createElement('style');
  css.textContent = '.acctsw{position:relative;display:inline-block}'
    + '.acctsw>button{font:inherit;font-size:13px;font-weight:700;padding:6px 11px;border-radius:999px;border:1px solid var(--line,#2c3549);background:var(--panel2,#232b3d);color:var(--ink,#e9e7e1);cursor:pointer;white-space:nowrap;max-width:46vw;overflow:hidden;text-overflow:ellipsis}'
    + '.acctsw .am{position:absolute;z-index:30;top:calc(100% + 6px);left:50%;transform:translateX(-50%);min-width:210px;background:var(--panel,#1d2433);border:1px solid var(--line,#2c3549);border-radius:12px;padding:6px;box-shadow:0 12px 32px rgba(0,0,0,.45)}'
    + '.acctsw .am button{display:flex;align-items:center;gap:8px;width:100%;text-align:left;background:none;border:0;border-radius:8px;padding:10px 12px;color:var(--ink,#e9e7e1);font:inherit;font-size:14.5px;cursor:pointer}'
    + '.acctsw .am button:hover{background:var(--panel2,#232b3d)}'
    + '.acctsw .am .me{color:var(--accent,#E8A33D);font-weight:800;cursor:default}'
    + '.acctsw .am .t{margin-left:auto;font-size:11px;color:var(--mute,#9aa3b5);font-weight:600}'
    + '.acctsw .am .sep{height:1px;background:var(--line,#2c3549);margin:6px 4px}'
    + '.acctsw .am .add{color:var(--accent,#E8A33D);font-weight:700}';
  document.head.appendChild(css);

  function mount(el){
    var d = device();
    if(!d || !get(TOKEN)){ el.hidden = true; return; }
    el.classList.add('acctsw');
    el.innerHTML = '<button type="button" aria-haspopup="menu" aria-expanded="false">@' + esc(d.name || d.key) + ' &#9662;</button><div class="am" role="menu" hidden></div>';
    var btn = el.firstChild, menu = el.lastChild;
    function draw(){
      var cur = device(), a = accts();
      if(cur && !a.some(function(x){ return x.key === cur.key; })) a.unshift({ key: cur.key, name: cur.name || cur.key });
      menu.innerHTML = a.map(function(x){ return x.key === (cur && cur.key)
          ? '<button class="me" disabled>' + esc(x.name) + '<span class="t">active</span></button>'
          : '<button data-use="' + esc(x.key) + '">' + esc(x.name) + '<span class="t">switch</span></button>'; }).join('')
        + '<div class="sep"></div><button class="add" data-add="1">+ Add new account</button>';
    }
    btn.addEventListener('click', function(e){ e.stopPropagation(); var open = menu.hidden; if(open) draw(); menu.hidden = !open; btn.setAttribute('aria-expanded', String(open)); });
    document.addEventListener('click', function(e){ if(!el.contains(e.target)){ menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); } });
    menu.addEventListener('click', function(e){
      var b = e.target.closest('button'); if(!b || b.disabled) return;
      if(b.dataset.use){ var x = accts().find(function(a){ return a.key === b.dataset.use; }); if(!x) return; keepCurrent();
        set(TOKEN, x.token); set(DEVICE, JSON.stringify({ key: x.key, name: x.name, ts: Date.now() })); set(SESSION, x.key); location.reload(); }
      else if(b.dataset.add){ keepCurrent(); set(TOKEN, null); set(DEVICE, null); set(SESSION, null);
        try{ sessionStorage.setItem('rb_addacct', '1'); }catch(e2){}
        location.href = '/board'; }
    });
  }
  function init(){ document.querySelectorAll('[data-acct]').forEach(mount); }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
