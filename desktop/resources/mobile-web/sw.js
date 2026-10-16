// Remote Claude service worker: app shell cache, push notifications, and Allow/Deny from the notification.
const SHELL = 'rcc-shell-v1';
const AUTH = 'rcc-auth';

self.addEventListener('install', (e) => { self.skipWaiting(); e.waitUntil(caches.open(SHELL).then((c) => c.addAll(['/', '/manifest.webmanifest', '/icon-192.png']).catch(() => {}))); });
self.addEventListener('activate', (e) => { e.waitUntil(Promise.all([self.clients.claim(), caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('rcc-shell-') && k !== SHELL).map((k) => caches.delete(k))))])); });

// the page hands us its device token so notification buttons can answer without opening the app
self.addEventListener('message', (e) => {
  const d = e.data || {};
  if (d.type === 'token') e.waitUntil(caches.open(AUTH).then((c) => (d.token ? c.put('/token', new Response(d.token)) : c.delete('/token'))));
});
async function token() { const r = await (await caches.open(AUTH)).match('/token'); return r ? r.text() : null; }

self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/') || u.pathname === '/vnc') return;
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(SHELL).then((c) => c.put('/', copy)); return r; }).catch(() => caches.match('/')));
    return;
  }
  if (u.pathname.startsWith('/assets/')) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => { const copy = r.clone(); caches.open(SHELL).then((c) => c.put(e.request, copy)); return r; })));
  }
});

self.addEventListener('push', (e) => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch { m = { title: 'Remote Claude', body: e.data && e.data.text() }; }
  e.waitUntil((async () => {
    if (m.kind === 'close') {
      for (const n of await self.registration.getNotifications({ tag: m.tag })) n.close();
      return;
    }
    // a finished task does not need a banner when the app is open on that very conversation
    if (m.kind === 'done') {
      const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (cs.some((c) => c.visibilityState === 'visible' && c.focused && new URL(c.url).hash.includes(`s=${m.sid}`))) return;
    }
    const opts = {
      body: m.body || '',
      tag: m.tag,
      renotify: m.kind === 'perm',
      requireInteraction: m.kind === 'perm',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: m,
    };
    if (m.kind === 'perm') opts.actions = [{ action: 'deny', title: '拒绝' }, { action: 'allow', title: '允许' }];
    await self.registration.showNotification(m.title || 'Remote Claude', opts);
  })());
});

self.addEventListener('notificationclick', (e) => {
  const m = e.notification.data || {};
  e.notification.close();
  e.waitUntil((async () => {
    if (m.kind === 'perm' && (e.action === 'allow' || e.action === 'deny')) {
      const t = await token();
      if (t) {
        const r = await fetch('/api/answer', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` }, body: JSON.stringify({ sid: m.sid, req: m.req, decision: e.action }) }).catch(() => null);
        if (r && r.ok) return;
      }
    }
    const target = m.sid ? `/#s=${m.sid}` : '/';
    const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of cs) { if ('focus' in c) { await c.focus(); c.postMessage({ type: 'open', sid: m.sid }); return; } }
    await self.clients.openWindow(target);
  })());
});
