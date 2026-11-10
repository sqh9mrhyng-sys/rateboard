/* View-as bar (Dennis, 2026-11-10). While an admin is looking at a member's
   account, every page shows a bar at the top: whose account it is, that it's
   look-only, and a button back to their own. The admin's own sign-in waits in
   rb_viewas_back; the look-only token never joins the saved accounts list. */
(function(){
  var TOKEN = 'ratebrd_token_v1', DEVICE = 'ratebrd_device_v1', SESSION = 'ratebrd_session', ACCTS = 'ratebrd_accounts_v1', BACK = 'rb_viewas_back', PFX = 'feedface0b5e';
  function get(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } }
  function set(k, v){ try{ v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); }catch(e){} }
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  // Keep look-only tokens out of the saved accounts, whichever page saved them.
  try{ var a = JSON.parse(get(ACCTS) || '[]'); if(Array.isArray(a)){ var b = a.filter(function(x){ return !(x && String(x.token || '').indexOf(PFX) === 0); }); if(b.length !== a.length) set(ACCTS, JSON.stringify(b)); } }catch(e){}
  var t = get(TOKEN) || '';
  if(t.indexOf(PFX) !== 0) return;
  var d = null; try{ d = JSON.parse(get(DEVICE) || 'null'); }catch(e){}
  var back = null; try{ back = JSON.parse(get(BACK) || 'null'); }catch(e){}
  function goBack(){
    try{ fetch('/api/kv', { method: 'POST', headers: { 'content-type': 'application/json', 'x-rb-token': t }, body: JSON.stringify({ op: 'signout' }) }); }catch(e){}
    if(back && back.token){ set(TOKEN, back.token); set(DEVICE, JSON.stringify({ key: back.key, name: back.name || back.key, ts: Date.now() })); set(SESSION, back.key); }
    else { set(TOKEN, null); set(DEVICE, null); set(SESSION, null); }
    set(BACK, null);
    location.href = '/admin';
  }
  function bar(){
    if(document.getElementById('viewasbar')) return;
    var el = document.createElement('div'); el.id = 'viewasbar';
    el.setAttribute('style', 'position:sticky;top:0;z-index:9999;display:flex;gap:10px;align-items:center;justify-content:center;flex-wrap:wrap;padding:8px 12px;background:#7a1f2b;color:#fff;font:600 14px/1.3 system-ui,-apple-system,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.4)');
    el.innerHTML = '<span>Viewing <b>@' + esc((d && (d.name || d.key)) || 'member') + '</b> - look only, nothing is saved</span><button type="button" style="font:inherit;font-weight:800;padding:5px 12px;border-radius:999px;border:0;background:#fff;color:#7a1f2b;cursor:pointer">Back to ' + esc((back && back.name) || 'my account') + '</button>';
    el.querySelector('button').addEventListener('click', goBack);
    document.body.insertBefore(el, document.body.firstChild);
  }
  if(document.body) bar(); else document.addEventListener('DOMContentLoaded', bar);
})();
