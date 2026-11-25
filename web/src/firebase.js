export async function createFirebaseReceiver() {
  if (!window.isSecureContext || !('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('Unsupported browser: secure notifications, Push API and service workers are required. Try desktop Chrome or Edge on localhost.');
  const appUrl = 'https://www.gstatic.com/firebasejs/13.4.0/firebase-app.js';
  const messagingUrl = 'https://www.gstatic.com/firebasejs/13.4.0/firebase-messaging.js';
  const [appSDK, sdk] = await Promise.all([import(/* @vite-ignore */ appUrl), import(/* @vite-ignore */ messagingUrl)]);
  if (!await sdk.isSupported()) throw new Error('Firebase Messaging is unsupported in this browser/profile. Check IndexedDB and cookie settings.');
  const config = globalThis.FCM_DEMO;
  const messaging = sdk.getMessaging(appSDK.getApps()[0] || appSDK.initializeApp(config.firebaseConfig));
  const registration = await navigator.serviceWorker.register('/firebase-messaging-sw.js', { scope: '/' });
  if (!registration.active) {
    await new Promise((done, fail) => {
      const worker = registration.installing || registration.waiting;
      if (!worker) return fail(new Error('Service worker did not install.'));
      const timer = setTimeout(() => fail(new Error('Service worker activation timed out. Reload and retry.')), 20_000);
      const check = () => {
        if (!['activated', 'redundant'].includes(worker.state)) return;
        clearTimeout(timer);
        worker.removeEventListener('statechange', check);
        worker.state === 'activated' ? done() : fail(new Error('Service worker installation failed. Check SDK CDN access.'));
      };
      worker.addEventListener('statechange', check);
      check();
    });
  }
  return {
    registration,
    getToken: () => sdk.getToken(messaging, { vapidKey: config.vapidKey, serviceWorkerRegistration: registration }),
    deleteToken: () => sdk.deleteToken(messaging),
    onMessage: (listener) => sdk.onMessage(messaging, listener),
  };
}
