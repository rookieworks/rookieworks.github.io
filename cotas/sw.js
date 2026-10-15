// Service worker: la app funciona sin conexión (obras, sótanos…).
const VERSION = 'cotas-v1';
const ASSETS = [
  './', 'index.html', 'app.css', 'manifest.webmanifest',
  'js/main.js', 'js/geom.js', 'js/model.js', 'js/solver.js', 'js/plan2d.js', 'js/export.js', 'js/scan-core.js', 'js/ar.js', 'js/view3d.js',
  'vendor/three/three.module.min.js', 'vendor/three/addons/controls/OrbitControls.js',
  'vendor/three/addons/exporters/GLTFExporter.js', 'vendor/three/addons/exporters/OBJExporter.js', 'vendor/three/addons/utils/TextureUtils.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('cotas-') && k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// Red primero (para recibir actualizaciones), caché si no hay conexión.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('index.html')))
  );
});
