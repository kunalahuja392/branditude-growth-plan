// Branditude Growth service worker: network first for our own files, cached copy when offline.
// Never touches Supabase, Google or any other origin, and never caches non-GET requests.
const CACHE = "bgp-v2";
const SHELL = ["/", "/index.html", "/app.html", "/login.html", "/assets/css/app.css", "/assets/icons/icon-192.png", "/manifest.webmanifest"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {})); self.skipWaiting(); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== "GET" || u.origin !== location.origin || u.pathname.startsWith("/download/")) return;
  e.respondWith(fetch(r).then((res) => { if (res.ok && res.type === "basic") { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(r, copy)); } return res; })
    .catch(() => caches.match(r, { ignoreSearch: true }).then((m) => m || (r.mode === "navigate" ? caches.match("/app.html") : Response.error()))));
});
