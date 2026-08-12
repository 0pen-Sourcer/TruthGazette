/**
 * Truth Gazette service worker.
 *
 * Deliberately network-first. A cache-first worker is the usual choice for a
 * PWA, but on a tool people trust for verification, serving a stale build from
 * cache is worse than a slightly slower load. The cache exists only so the
 * shell still opens when the device is offline.
 *
 * The API is never cached. A verification result is a point-in-time claim about
 * live sources, and replaying an old one would undercut the whole premise.
 */

const CACHE = 'truth-gazette-v1';

const SHELL = [
  '/',
  '/index.html',
  '/favicon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // Individual failures shouldn't block installation
      .then((cache) => Promise.allSettled(SHELL.map((path) => cache.add(path))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

/**
 * Android share target.
 *
 * When someone shares a forwarded image or a link into Truth Gazette, Android
 * POSTs it to /share. There is no server route for that — this is a static
 * site — so the worker takes the POST itself, parks the payload, and bounces
 * the browser to the page, which picks it up and fills the form.
 *
 * This is the path that matters most for our readers: a forwarded picture has
 * no link to paste, so sharing it directly is the only natural way in.
 */
const SHARE_CACHE = 'truth-gazette-share';

async function receiveShare(request) {
  try {
    const form = await request.formData();
    const cache = await caches.open(SHARE_CACHE);

    const meta = {
      title: (form.get('title') || '').toString(),
      text: (form.get('text') || '').toString(),
      url: (form.get('url') || '').toString(),
      hasImage: false
    };

    const file = form.get('image');
    if (file && typeof file !== 'string' && file.size > 0) {
      meta.hasImage = true;
      meta.imageType = file.type || 'image/png';
      await cache.put('/__shared_image', new Response(file, {
        headers: { 'Content-Type': meta.imageType }
      }));
    } else {
      await cache.delete('/__shared_image');
    }

    await cache.put('/__shared_meta', new Response(JSON.stringify(meta), {
      headers: { 'Content-Type': 'application/json' }
    }));
  } catch (e) {
    // Fall through: the page just opens empty rather than erroring
  }

  // Absolute URL: Response.redirect rejects relative ones.
  return Response.redirect(new URL('/?shared=1', self.location.origin).href, 303);
}

self.addEventListener('fetch', (event) => {
  const request = event.request;

  if (request.method === 'POST') {
    let postUrl;
    try { postUrl = new URL(request.url); } catch (e) { return; }
    if (postUrl.origin === self.location.origin && postUrl.pathname === '/share') {
      event.respondWith(receiveShare(request));
    }
    return;
  }

  if (request.method !== 'GET') return;

  let url;
  try { url = new URL(request.url); } catch (e) { return; }

  // Leave the API and anything cross-origin (fonts, CDN scripts) alone
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(() => caches.match(request).then((hit) => hit || caches.match('/index.html')))
  );
});
