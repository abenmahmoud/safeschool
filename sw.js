// ═══════════════════════════════════════════════════════════════
// SafeSchool V8.1 Extra Pro — Service Worker
// Offline-first, Push Notifications, Background Sync, Smart Cache
// ═══════════════════════════════════════════════════════════════

const CACHE_VERSION = 'ss-v8-extra-pro-1';
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const DYNAMIC_CACHE = `${CACHE_VERSION}-dynamic`;
const API_CACHE = `${CACHE_VERSION}-api`;

// Critical resources — cached on install for offline-first
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/pricing.html',
  '/dashboard-v3.js',
  '/offline.html'
];

// ── INSTALL ──
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(STATIC_CACHE).then(cache => cache.addAll(STATIC_ASSETS))
  );
});

// ── ACTIVATE — clean old caches ──
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== STATIC_CACHE && k !== DYNAMIC_CACHE && k !== API_CACHE)
            .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── FETCH — Network-first for API, Cache-first for static ──
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Skip non-GET and cross-origin
  if (event.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  // API requests — network-first with cache fallback
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(API_CACHE).then(cache => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // HTML / navigation requests — network-first (always show latest version)
  const isNavigation = event.request.mode === 'navigate' ||
    event.request.headers.get('accept')?.includes('text/html');

  if (isNavigation) {
    event.respondWith(
      fetch(event.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(STATIC_CACHE).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => caches.match(event.request).then(cached => cached || caches.match('/offline.html')))
    );
    return;
  }

  // Other static assets — cache-first with background revalidation
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) {
        fetch(event.request).then(fresh => {
          if (fresh.ok) {
            caches.open(STATIC_CACHE).then(cache => cache.put(event.request, fresh));
          }
        }).catch(() => {});
        return cached;
      }
      return fetch(event.request).then(response => {
        if (response.ok && !url.pathname.startsWith('/superadmin')) {
          const clone = response.clone();
          caches.open(DYNAMIC_CACHE).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {});
    })
  );
});

// ── PUSH NOTIFICATIONS ──
self.addEventListener('push', event => {
  let data = { title: 'SafeSchool', body: 'Nouvelle notification', icon: '/icons/icon-192.svg' };

  if (event.data) {
    try {
      data = { ...data, ...event.data.json() };
    } catch {
      data.body = event.data.text();
    }
  }

  const options = {
    body: data.body,
    icon: data.icon || '/icons/icon-192.svg',
    badge: '/icons/badge-72.svg',
    vibrate: [100, 50, 100, 50, 200],
    tag: data.tag || 'ss-notification',
    renotify: true,
    requireInteraction: data.urgent || false,
    data: { url: data.url || '/', type: data.type || 'general' },
    actions: []
  };

  // Context-aware actions
  if (data.type === 'new-report') {
    options.actions = [
      { action: 'view', title: 'Voir le signalement' },
      { action: 'dismiss', title: 'Plus tard' }
    ];
    options.requireInteraction = true;
  } else if (data.type === 'status-update') {
    options.actions = [
      { action: 'view', title: 'Voir la mise à jour' }
    ];
  } else if (data.type === 'urgent') {
    options.actions = [
      { action: 'view', title: 'URGENT — Voir' },
      { action: 'call', title: 'Appeler 3018' }
    ];
    options.requireInteraction = true;
    options.vibrate = [200, 100, 200, 100, 200, 100, 400];
  }

  event.waitUntil(self.registration.showNotification(data.title, options));
});

// ── NOTIFICATION CLICK ──
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const data = event.notification.data || {};

  if (event.action === 'call') {
    event.waitUntil(clients.openWindow('tel:3018'));
    return;
  }

  const targetUrl = data.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin)) {
          client.focus();
          client.postMessage({ type: 'NAVIGATE', url: targetUrl, notifType: data.type });
          return;
        }
      }
      return clients.openWindow(targetUrl);
    })
  );
});

// ── BACKGROUND SYNC — queue reports when offline ──
self.addEventListener('sync', event => {
  if (event.tag === 'sync-reports') {
    event.waitUntil(syncQueuedReports());
  }
});

async function syncQueuedReports() {
  try {
    const cache = await caches.open(DYNAMIC_CACHE);
    const requests = await cache.keys();
    const pendingReports = requests.filter(r => r.url.includes('/api/') && r.method === 'POST');

    for (const req of pendingReports) {
      try {
        await fetch(req);
        await cache.delete(req);
      } catch { /* will retry next sync */ }
    }
  } catch (e) {
    console.error('Background sync failed:', e);
  }
}

// ── PERIODIC BACKGROUND SYNC — check for updates ──
self.addEventListener('periodicsync', event => {
  if (event.tag === 'check-updates') {
    event.waitUntil(checkForUpdates());
  }
});

async function checkForUpdates() {
  try {
    const response = await fetch('/api/notify/digest');
    if (response.ok) {
      const data = await response.json();
      if (data.hasNew) {
        self.registration.showNotification('SafeSchool — Mise à jour', {
          body: data.message || 'Nouvelles informations disponibles',
          icon: '/icons/icon-192.png',
          badge: '/icons/badge-72.png',
          tag: 'periodic-update'
        });
      }
    }
  } catch { /* silent fail */ }
}

// ── MESSAGE HANDLER — for app communication ──
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data?.type === 'CACHE_URLS') {
    caches.open(DYNAMIC_CACHE).then(cache => {
      cache.addAll(event.data.urls || []);
    });
  }
});
