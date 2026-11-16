const CACHE_NAME = "chatypeople-shell-v1";
const APP_SHELL = ["/", "/styles.css", "/app.js", "/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith("chatypeople-shell-") && key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)));
        }
        return response;
      })
      .catch(async () => (await caches.match(request)) || caches.match("/")),
  );
});

self.addEventListener("push", (event) => {
  let message = {};
  try {
    message = event.data ? event.data.json() : {};
  } catch (error) {
    console.error("Could not parse a push notification:", error);
    return;
  }
  const title = message.title || "New ChatyPeople message";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: message.body || "You have a new message.",
      icon: "/icon.svg",
      badge: "/icon.svg",
      tag: `chat-${message.conversationId || "new"}`,
      data: { conversationId: message.conversationId || "lounge" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const conversationId = event.notification.data?.conversationId || "lounge";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (windows) => {
      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        await client.focus();
        client.postMessage({ type: "open-conversation", conversationId });
        return;
      }
      return self.clients.openWindow(`/?conversation=${encodeURIComponent(conversationId)}`);
    }),
  );
});
