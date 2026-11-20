/* Rax Academy service worker (2026-11-16): push notifications only. It does not cache or touch page loads,
   so the site works exactly as before. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('push', e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (x) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Rax Academy', {
    body: d.body || '', tag: d.tag || undefined, renotify: !!d.tag, icon: '/img/icon-192.png', badge: '/img/icon-192.png', data: { url: d.url || '/notifications' } }));
});
/* Tap -> the page the notification is about (2026-11-17: with the app already open, iOS only brought the open
   window forward and stayed on whatever page it was on). An open window is sent to the page (navigate, or a
   message the page acts on); only with no window open is a new one opened. */
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href;
  // Another site (a Real auction link, 2026-11-19): opened on its own, the app stays where it was.
  if (new URL(url).origin !== self.location.origin) { e.waitUntil(self.clients.openWindow(url)); return; }
  e.waitUntil((async () => {
    /* Also left where the page can read it (2026-11-18: iOS still landed on the wrong page when the app
       was in the background - the message/navigate went to a window that wasn't awake yet). Every page
       checks this when it loads or comes back on screen (theme.js), then clears it. */
    try { const c = await caches.open('rb-nav'); await c.put('/__rbnav', new Response(JSON.stringify({ url, at: Date.now() }))); } catch (x) {}
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const c = list.find(x => x.url === url) || list.find(x => new URL(x.url).origin === self.location.origin);
    if (c) {
      if (c.url !== url) { try { c.postMessage({ rbGo: url }); } catch (x) {} try { if ('navigate' in c) await c.navigate(url); } catch (x) {} }
      try { return await c.focus(); } catch (x) {}
    }
    return self.clients.openWindow(url);
  })());
});
