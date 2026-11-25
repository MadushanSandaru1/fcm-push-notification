/* Classic compat worker; no bundler or module worker required. */
importScripts("https://www.gstatic.com/firebasejs/13.4.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/13.4.0/firebase-messaging-compat.js");
importScripts("/firebase-config.js");
firebase.initializeApp(FCM_DEMO.firebaseConfig);
const messaging = firebase.messaging();
messaging.onBackgroundMessage(async (payload) => {
  const message = { type: "fcm-background", payload, timestamp: new Date().toISOString() };
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of windows) {
    if (new URL(client.url).origin === self.location.origin) client.postMessage(message);
  }
  // Firebase already displays notification payloads. Never display a second one.
  if (!payload.notification) {
    await self.registration.showNotification(payload.data?.title || "FCM data message", {
      body: payload.data?.body || "A data message was received."
    });
  }
});
