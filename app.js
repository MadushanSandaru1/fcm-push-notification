(() => {
  "use strict";
  const dashboardOrigin = "http://localhost:8080";
  const appNumber = Number(location.port) - 8080;
  const isReceiver = location.protocol === "http:" && location.hostname === "localhost" && appNumber >= 1 && appNumber <= 4;
  const isDashboard = location.origin === dashboardOrigin;
  const localFile = location.protocol === "file:";
  const channel = "fcm-push-lab-v1";
  const panels = document.querySelector("#panels");
  const text = (node, value) => { node.textContent = String(value ?? ""); };

  function makePanel(number) {
    const root = document.querySelector("#panel-template").content.firstElementChild.cloneNode(true);
    const find = (selector) => root.querySelector(selector);
    const url = `http://localhost:${8080 + number}`;
    text(find("h2"), `App ${number}`);
    text(find(".receiver-url"), url);
    find(".receiver-url").href = url;
    // Use the tracked button to establish the window-reference bridge.
    find(".receiver-url").addEventListener("click", (event) => {
      if (!isReceiver) { event.preventDefault(); find(".open").click(); }
    });
    const panel = { root, find, number, url, token: "", messages: [], seen: new Set(), window: null };
    find(".copy").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(panel.token);
        text(find(".notice"), "Token copied.");
      } catch {
        find(".token").focus();
        find(".token").select();
        text(find(".notice"), "Clipboard unavailable. Copy the selected token manually.");
      }
    });
    panels.append(root);
    return panel;
  }

  function renderState(panel, state) {
    text(panel.find(".permission"), state.permission);
    text(panel.find(".subscription"), state.subscription);
    text(panel.find(".error"), state.error);
    panel.token = typeof state.token === "string" ? state.token : "";
    panel.find(".token").value = panel.token;
    panel.find(".copy").disabled = !panel.token;
    const topics = Array.isArray(state.topics) ? state.topics.filter((topic) => typeof topic === "string") : [];
    text(panel.find(".topic-summary"), !panel.token ? "Subscribe for an FCM token first." : state.topicsKnown ? topics.length ? `Confirmed topics: ${topics.join(", ")}` : "No topic memberships." : "Membership unknown — refresh topics in the receiver.");
    text(panel.find(".topic-error"), state.topicError);
    text(panel.find(".topic-notice"), state.topicNotice);
  }

  function addMessage(panel, message) {
    if (!message || typeof message !== "object" || !["foreground", "background"].includes(message.mode)) return;
    if (typeof message.id !== "string" || panel.seen.has(message.id)) return;
    panel.seen.add(message.id);
    panel.messages.push(message);
    if (panel.messages.length > 100) panel.seen.delete(panel.messages.shift().id);
    const list = panel.find(".messages");
    list.querySelector(".empty")?.remove();
    const row = document.createElement("li");
    const title = document.createElement("strong");
    title.className = "message-title";
    text(title, message.title);
    const body = document.createElement("p");
    body.className = "message-body";
    text(body, message.body);
    const meta = document.createElement("div");
    meta.className = "message-meta";
    const timestamp = new Date(message.timestamp);
    text(meta, `${Number.isNaN(timestamp.getTime()) ? "Unknown time" : timestamp.toLocaleString()} · ${message.mode}`);
    row.append(title, body, meta);
    list.prepend(row);
    while (list.children.length > 100) list.lastElementChild.remove();
    text(panel.find(".count"), panel.messages.length);
  }

  if (!isReceiver) {
    document.querySelector("#startup").hidden = isDashboard;
    if (!localFile && !isDashboard) text(document.querySelector("#hint"), "Use http://localhost:8080 for the dashboard and localhost ports 8081–8084 for receivers.");
    const views = [1, 2, 3, 4].map(makePanel);
    for (const panel of views) {
      panel.find(".open").disabled = !isDashboard;
      panel.find(".open").addEventListener("click", () => {
        if (!panel.window || panel.window.closed) panel.window = window.open(panel.url, "_blank");
        else panel.window.focus();
        text(panel.find(".error"), panel.window ? "" : "Popup blocked. Allow popups and click Open receiver again.");
        text(panel.find(".connection"), panel.window ? "Connecting…" : "Not connected");
      });
    }
    window.addEventListener("message", (event) => {
      const panel = views.find((view) => event.origin === view.url && event.source === view.window);
      if (!panel || !event.data || event.data.channel !== channel || event.data.app !== panel.number || event.data.type !== "snapshot") return;
      panel.lastSeen = Date.now();
      text(panel.find(".connection"), "Connected");
      if (event.data.state && typeof event.data.state === "object") renderState(panel, event.data.state);
      if (Array.isArray(event.data.messages)) event.data.messages.slice(-100).forEach((message) => addMessage(panel, message));
    });
    setInterval(() => {
      for (const panel of views) {
        if (!panel.window) continue;
        if (panel.window.closed) {
          text(panel.find(".connection"), "Receiver closed");
          continue;
        }
        if (panel.lastSeen && Date.now() - panel.lastSeen > 15000) text(panel.find(".connection"), "Waiting for receiver");
        panel.window.postMessage({ channel, type: "sync", app: panel.number }, panel.url);
      }
    }, 2000);
    return;
  }

  panels.classList.add("receiver");
  text(document.querySelector("#mode"), `/ App ${appNumber}`);
  text(document.querySelector("#hint"), "Click Subscribe here to allow notifications and obtain an FCM token. Keep this tab open to mirror foreground and background messages.");
  const panel = makePanel(appNumber);
  panel.find(".open").hidden = true;
  panel.find(".subscribe").hidden = false;
  panel.find(".unsubscribe").hidden = false;
  panel.find(".topic-controls").hidden = false;
  const state = { permission: "Notification" in window ? Notification.permission : "Unsupported", subscription: "Checking…", token: "", error: "", topics: [], topicsKnown: false, topicError: "", topicNotice: "" };
  let ready = false;
  let busy = false;
  let sdk;
  let messaging;
  let registration;
  const storageKey = "fcm-push-lab-subscription";
  const dashboard = window.opener;

  function publish() {
    state.permission = "Notification" in window ? Notification.permission : "Unsupported";
    renderState(panel, state);
    panel.find(".subscribe").disabled = !ready || busy;
    panel.find(".unsubscribe").disabled = !ready || busy || state.subscription === "Not subscribed";
    for (const selector of [".topic-subscribe", ".topic-unsubscribe", ".topic-refresh", ".topic-name"]) {
      panel.find(selector).disabled = !ready || busy || !state.token || state.permission !== "granted";
    }
    if (dashboard && !dashboard.closed) dashboard.postMessage({ channel, type: "snapshot", app: appNumber, state: { ...state }, messages: panel.messages }, dashboardOrigin);
  }
  text(panel.find(".connection"), dashboard ? "Dashboard linked" : "Standalone receiver");
  window.addEventListener("message", (event) => {
    if (event.origin !== dashboardOrigin || event.source !== dashboard || !event.data || event.data.channel !== channel || event.data.type !== "sync" || event.data.app !== appNumber) return;
    publish();
  });

  function receive(payload, mode, timestamp = new Date().toISOString()) {
    if (!payload || typeof payload !== "object") return;
    const message = {
      id: payload.messageId || `${mode}:${timestamp}:${JSON.stringify(payload)}`,
      title: payload.notification?.title ?? payload.data?.title ?? "FCM message",
      body: payload.notification?.body ?? payload.data?.body ?? "(No body)",
      timestamp, mode
    };
    addMessage(panel, message);
    publish();
  }

  function failure(error) {
    state.error = `${error.code ? `${error.code}: ` : ""}${error.message || error}`;
    publish();
  }

  async function topicRequest(action, topic = "") {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);
    try {
      const response = await fetch(`/api/topics/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: state.token, ...(action === "list" ? {} : { topic }) }),
        signal: controller.signal
      });
      let result;
      try { result = await response.json(); }
      catch { throw new Error("Topic helper returned an unexpected response. Restart using the updated serve.py."); }
      if (!response.ok) throw new Error(result.error || `Topic request failed (HTTP ${response.status}).`);
      return result;
    } catch (error) {
      if (error.name === "AbortError") throw new Error("Topic request timed out. Membership is unknown; refresh topics before retrying.");
      throw error;
    } finally { clearTimeout(timeout); }
  }

  async function loadTopics() {
    try {
      const result = await topicRequest("list");
      if (!Array.isArray(result.topics) || result.topics.some((topic) => typeof topic !== "string")) throw new Error("Invalid membership list from the topic helper.");
      state.topics = result.topics;
      state.topicsKnown = true;
      state.topicError = "";
    } catch (error) {
      state.topicsKnown = false;
      state.topicError = error.message || String(error);
    }
  }

  async function topicAction(action) {
    if (!ready || busy || !state.token || Notification.permission !== "granted") return;
    const topic = panel.find(".topic-name").value.trim();
    if (action !== "list" && !/^[a-zA-Z0-9_.~%\-]{1,900}$/.test(topic)) {
      state.topicError = "Enter a topic name using letters, digits, _, ., ~, %, or -. Omit /topics/.";
      publish();
      return;
    }
    busy = true;
    state.topicError = "";
    state.topicNotice = action === "list" ? "Checking Firebase memberships…" : "Waiting for Firebase confirmation…";
    publish();
    try {
      if (action !== "list") {
        await topicRequest(action, topic);
        state.topicNotice = `${action === "subscribe" ? "Subscribed to" : "Unsubscribed from"} ${topic}. Your individual FCM token is unchanged.`;
      }
      await loadTopics();
      if (action === "list") state.topicNotice = state.topicError ? "" : "Topic memberships refreshed from Firebase.";
    } catch (error) {
      state.topicsKnown = false;
      state.topicNotice = "";
      state.topicError = error.message || String(error);
    } finally { busy = false; publish(); }
  }

  panel.find(".topic-subscribe").addEventListener("click", () => topicAction("subscribe"));
  panel.find(".topic-unsubscribe").addEventListener("click", () => topicAction("unsubscribe"));
  panel.find(".topic-refresh").addEventListener("click", () => topicAction("list"));

  panel.find(".subscribe").addEventListener("click", async () => {
    busy = true;
    state.error = "";
    // Request immediately within the user gesture, before any SDK/network wait.
    try {
      const permissionRequest = Notification.requestPermission();
      publish();
      const permission = await permissionRequest;
      if (permission !== "granted") throw new Error(permission === "denied" ? "Notifications blocked. Allow notifications in this receiver's browser site settings, then click Subscribe." : "Permission was not granted. Click Subscribe when ready to allow notifications.");
      const token = await sdk.getToken(messaging, { vapidKey: FCM_DEMO.vapidKey, serviceWorkerRegistration: registration });
      if (!token) throw new Error("Firebase returned no FCM token. Check browser permission and try again.");
      if (state.token !== token) {
        state.topics = [];
        state.topicsKnown = false;
        state.topicNotice = "";
      }
      state.token = token;
      state.subscription = "Subscribed";
      try { localStorage.setItem(storageKey, token); }
      catch { state.error = "Subscribed, but local storage is unavailable. This token cannot be restored after reload."; }
      await loadTopics();
    } catch (error) { failure(error); }
    finally { busy = false; publish(); }
  });

  panel.find(".unsubscribe").addEventListener("click", async () => {
    busy = true;
    state.error = "";
    publish();
    try {
      const deleted = await sdk.deleteToken(messaging);
      if (!deleted) throw new Error("Firebase did not confirm token deletion. Retry Unsubscribe.");
      state.token = "";
      state.subscription = "Not subscribed";
      state.topics = [];
      state.topicsKnown = false;
      state.topicError = "";
      state.topicNotice = "FCM token deleted. No automatic topic or individual re-subscription will occur.";
      try { localStorage.removeItem(storageKey); }
      catch { state.error = "Token deleted, but saved local state could not be cleared. No automatic re-subscription will occur."; }
    } catch (error) { failure(error); }
    finally { busy = false; publish(); }
  });

  publish();
  (async () => {
    try {
      if (!window.isSecureContext || !("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) throw new Error("Unsupported browser: secure-context notifications, Push API and service workers are required. Try desktop Chrome or Edge on localhost.");
      const [appSDK, messagingSDK] = await Promise.all([
        import("https://www.gstatic.com/firebasejs/13.4.0/firebase-app.js"),
        import("https://www.gstatic.com/firebasejs/13.4.0/firebase-messaging.js")
      ]);
      sdk = messagingSDK;
      if (!await sdk.isSupported()) throw new Error("Firebase Messaging is not supported in this browser or profile (IndexedDB/cookies may be disabled).");
      messaging = sdk.getMessaging(appSDK.initializeApp(FCM_DEMO.firebaseConfig));
      sdk.onMessage(messaging, (payload) => receive(payload, "foreground"));
      registration = await navigator.serviceWorker.register("/firebase-messaging-sw.js", { scope: "/" });
      // First installation must activate before getToken uses the registration.
      if (!registration.active) {
        await new Promise((resolve, reject) => {
          const worker = registration.installing || registration.waiting;
          if (!worker) return reject(new Error("Service worker did not install."));
          const timer = setTimeout(() => reject(new Error("Service worker activation timed out. Reload and retry.")), 20000);
          const check = () => {
            if (worker.state === "activated" || worker.state === "redundant") {
              clearTimeout(timer);
              worker.state === "activated" ? resolve() : reject(new Error("Service worker installation failed. Check gstatic SDK access."));
            }
          };
          worker.addEventListener("statechange", check);
          check();
        });
      }
      navigator.serviceWorker.addEventListener("message", (event) => {
        if (event.source !== registration.active || event.origin !== location.origin || event.data?.type !== "fcm-background") return;
        receive(event.data.payload, "background", event.data.timestamp);
      });
      // Never call getToken on load: restoring a view must not undo opt-out.
      const existing = await registration.pushManager.getSubscription();
      let saved = "";
      try { saved = localStorage.getItem(storageKey) || ""; }
      catch { state.error = "Local storage unavailable; click Subscribe to retrieve the token explicitly."; }
      state.token = existing && Notification.permission === "granted" ? saved : "";
      state.subscription = state.token ? "Subscribed (saved token)" : existing ? "Existing push; click Subscribe to retrieve token" : "Not subscribed";
      if (Notification.permission === "denied") state.error = "Notifications blocked. Allow them in this receiver's browser site settings to subscribe.";
      ready = true;
      if (state.token) {
        busy = true;
        publish();
        await loadTopics(); // Read-only: never recreate memberships on reload.
        busy = false;
      }
      if (navigator.permissions?.query) {
        try {
          const permission = await navigator.permissions.query({ name: "notifications" });
          permission.onchange = () => {
            if (Notification.permission !== "granted") {
              state.token = "";
              state.topics = [];
              state.topicsKnown = false;
              state.subscription = "Inactive (permission not granted)";
              state.error = "Notification permission is not granted. Change site settings, then click Subscribe.";
            }
            publish();
          };
        } catch { /* Notification.permission remains the fallback. */ }
      }
      publish();
    } catch (error) {
      state.subscription = "Unavailable";
      failure(new Error(`Firebase/browser setup failed: ${error.message || error}. Check SDK 13.4.0 CDN access and browser support.`));
    }
  })();
})();
