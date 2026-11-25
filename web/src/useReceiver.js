import { ref } from "vue";
import {
  CHANNEL,
  DASHBOARD_ORIGIN,
  TOKEN_KEY,
  TOPIC_PATTERN,
  addMessage,
  fromPayload,
} from "./model.js";
import { createFirebaseReceiver } from "./firebase.js";

export function useReceiver(
  panel,
  {
    sdkFactory = createFirebaseReceiver,
    win = window,
    nav = navigator,
    storage,
    request = fetch,
  } = {},
) {
  const ready = ref(false);
  const busy = ref(false);
  const dashboard = win.opener;
  // Access storage lazily so a blocked browser storage getter becomes a clear
  // status error rather than preventing the Vue component from mounting.
  const store = storage || {
    getItem: (key) => win.localStorage.getItem(key),
    setItem: (key, value) => win.localStorage.setItem(key, value),
    removeItem: (key) => win.localStorage.removeItem(key),
  };
  const cleanups = [];
  const controllers = new Set();
  let sdk;
  let disposed = false;
  const permission = () => win.Notification?.permission ?? "Unsupported";
  const formatError = (error) =>
    `${error.code ? `${error.code}: ` : ""}${error.message || error}`;

  function publish() {
    if (disposed) return;
    panel.permission = permission();
    if (dashboard && !dashboard.closed) {
      const { messages, ...state } = JSON.parse(JSON.stringify(panel));
      state.ready = ready.value;
      state.busy = busy.value;
      dashboard.postMessage(
        {
          channel: CHANNEL,
          type: "snapshot",
          app: panel.number,
          state,
          messages,
        },
        DASHBOARD_ORIGIN,
      );
    }
  }

  async function topicRequest(action, topic) {
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 45_000);
    try {
      const response = await request(`/api/topics/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: panel.token,
          ...(action === "list" ? {} : { topic }),
        }),
        signal: controller.signal,
      });
      let result;
      try {
        result = await response.json();
      } catch {
        throw new Error(
          "Unexpected topic-helper response. Restart the current pnpm server.",
        );
      }
      if (!response.ok)
        throw new Error(
          result.error || `Topic request failed (HTTP ${response.status}).`,
        );
      return result;
    } catch (error) {
      if (error.name === "AbortError")
        throw new Error(
          "Topic request timed out. Refresh topics to confirm membership before retrying.",
        );
      throw error;
    } finally {
      clearTimeout(timer);
      controllers.delete(controller);
    }
  }

  async function loadTopics() {
    try {
      const result = await topicRequest("list");
      if (
        !Array.isArray(result.topics) ||
        result.topics.some((topic) => typeof topic !== "string")
      )
        throw new Error("Invalid topic membership list.");
      panel.topics = result.topics;
      panel.topicsKnown = true;
      panel.topicError = "";
    } catch (error) {
      panel.topicsKnown = false;
      panel.topicError = formatError(error);
    }
  }

  async function topicAction(action, name = "") {
    if (
      !ready.value ||
      busy.value ||
      !panel.token ||
      permission() !== "granted"
    )
      return;
    const topic = name.trim();
    if (action !== "list" && !TOPIC_PATTERN.test(topic)) {
      panel.topicError =
        "Use letters, digits, _, ., ~, %, or - for the topic name. Omit /topics/.";
      publish();
      return;
    }
    busy.value = true;
    panel.topicError = "";
    panel.topicNotice =
      action === "list"
        ? "Checking Firebase memberships…"
        : "Waiting for Firebase confirmation…";
    publish();
    let confirmed = false;
    try {
      if (action !== "list") {
        await topicRequest(action, topic);
        confirmed = true;
        panel.topicNotice = `${action === "subscribe" ? "Subscribed to" : "Unsubscribed from"} ${topic}. Your individual FCM token is unchanged.`;
      }
      await loadTopics();
      if (action === "list")
        panel.topicNotice = panel.topicError
          ? ""
          : "Topic memberships refreshed from Firebase.";
    } catch (error) {
      panel.topicsKnown = false;
      panel.topicNotice = "";
      panel.topicError = formatError(error);
    } finally {
      busy.value = false;
      publish();
    }
    return confirmed;
  }

  async function subscribe() {
    if (!ready.value || busy.value) return;
    busy.value = true;
    panel.error = "";
    try {
      // Still inside the click gesture: never defer the browser prompt to setup.
      const permissionRequest = win.Notification.requestPermission();
      publish();
      const granted = await permissionRequest;
      if (granted !== "granted")
        throw new Error(
          granted === "denied"
            ? "Notifications blocked. Allow them in this receiver’s browser site settings, then click Subscribe."
            : "Permission was not granted. Click Subscribe when ready.",
        );
      const token = await sdk.getToken();
      if (!token)
        throw new Error(
          "Firebase returned no FCM token. Check permission and retry.",
        );
      if (panel.token !== token) {
        panel.topics = [];
        panel.topicsKnown = false;
        panel.topicNotice = "";
      }
      panel.token = token;
      panel.unsubscribeId = "";
      panel.subscription = "Subscribed";
      try {
        store.setItem(TOKEN_KEY, token);
      } catch {
        panel.error =
          "Subscribed, but local storage is unavailable. The token cannot be restored after reload.";
      }
      await loadTopics();
    } catch (error) {
      panel.error = formatError(error);
    } finally {
      busy.value = false;
      publish();
    }
  }

  async function unsubscribe() {
    if (!ready.value || busy.value) return;
    busy.value = true;
    panel.error = "";
    publish();
    try {
      if (!(await sdk.deleteToken()))
        throw new Error(
          "Firebase did not confirm token deletion. Retry Unsubscribe.",
        );
      panel.unsubscribeId = crypto.randomUUID();
      panel.token = "";
      panel.subscription = "Not subscribed";
      panel.topics = [];
      panel.topicsKnown = false;
      panel.topicError = "";
      panel.topicNotice =
        "FCM token deleted. No automatic re-subscription will occur.";
      try {
        store.removeItem(TOKEN_KEY);
      } catch {
        panel.error =
          "Token deleted, but saved local state could not be cleared. No automatic re-subscription will occur.";
      }
    } catch (error) {
      panel.error = formatError(error);
    } finally {
      busy.value = false;
      publish();
    }
  }

  function receive(payload, mode, timestamp) {
    addMessage(panel, fromPayload(payload, mode, timestamp));
    publish();
  }

  async function start() {
    try {
      const key = "fcm-push-lab-device-id";
      panel.deviceId = store.getItem(key) || crypto.randomUUID();
      store.setItem(key, panel.deviceId);
    } catch {
      panel.deviceId = "";
    }
    panel.connection = dashboard ? "Dashboard linked" : "Standalone receiver";
    panel.subscription = "Checking…";
    publish();
    const sync = async (event) => {
      const data = event.data;
      if (
        !dashboard ||
        event.source !== dashboard ||
        event.origin !== DASHBOARD_ORIGIN ||
        data?.channel !== CHANNEL ||
        data.app !== panel.number
      )
        return;
      if (data.type === "sync") {
        publish();
        return;
      }
      if (
        data.type !== "topic-unsubscribe" ||
        typeof data.requestId !== "string" ||
        !data.requestId.length ||
        data.requestId.length > 100 ||
        typeof data.topic !== "string" ||
        !TOPIC_PATTERN.test(data.topic)
      )
        return;
      let ok = false;
      let error = "Receiver is not ready. Refresh topics before retrying.";
      if (
        ready.value &&
        !busy.value &&
        panel.token &&
        permission() === "granted" &&
        panel.topicsKnown &&
        panel.topics.includes(data.topic)
      ) {
        ok = await topicAction("unsubscribe", data.topic);
        error = panel.topicError || "Firebase did not confirm topic removal.";
      }
      publish();
      if (!disposed && !dashboard.closed)
        dashboard.postMessage(
          {
            channel: CHANNEL,
            type: "topic-result",
            app: panel.number,
            requestId: data.requestId,
            ok,
            ...(ok ? {} : { error }),
          },
          DASHBOARD_ORIGIN,
        );
    };
    win.addEventListener("message", sync);
    cleanups.push(() => win.removeEventListener("message", sync));
    try {
      sdk = await sdkFactory();
      if (disposed) return;
      cleanups.push(sdk.onMessage((payload) => receive(payload, "foreground")));
      const background = (event) => {
        if (
          event.source !== sdk.registration.active ||
          event.origin !== win.location.origin ||
          event.data?.type !== "fcm-background"
        )
          return;
        receive(event.data.payload, "background", event.data.timestamp);
      };
      nav.serviceWorker.addEventListener("message", background);
      cleanups.push(() =>
        nav.serviceWorker.removeEventListener("message", background),
      );
      const existing = await sdk.registration.pushManager.getSubscription();
      let saved = "";
      try {
        saved = store.getItem(TOKEN_KEY) || "";
      } catch {
        panel.error =
          "Local storage is unavailable. Click Subscribe explicitly to retrieve a token.";
      }
      panel.token = existing && permission() === "granted" ? saved : "";
      panel.subscription = panel.token
        ? "Subscribed (saved token)"
        : existing
          ? "Existing push; click Subscribe to retrieve token"
          : "Not subscribed";
      if (permission() === "denied")
        panel.error =
          "Notifications blocked. Change this receiver’s browser site settings to subscribe.";
      if (panel.token) {
        busy.value = true;
        publish();
        await loadTopics();
        busy.value = false;
      }
      ready.value = true;
      if (nav.permissions?.query) {
        try {
          const status = await nav.permissions.query({ name: "notifications" });
          const changed = () => {
            if (permission() !== "granted") {
              panel.token = "";
              panel.topics = [];
              panel.topicsKnown = false;
              panel.subscription = "Inactive (permission not granted)";
              panel.error =
                "Notification permission is not granted. Check site settings, then click Subscribe.";
            }
            publish();
          };
          status.addEventListener("change", changed);
          cleanups.push(() => status.removeEventListener("change", changed));
        } catch {
          /* Notification.permission remains the fallback. */
        }
      }
    } catch (error) {
      panel.subscription = "Unavailable";
      panel.error = `Firebase/browser setup failed: ${formatError(error)} Check SDK 13.4.0 CDN access.`;
    }
    publish();
  }

  function dispose() {
    disposed = true;
    for (const controller of controllers) controller.abort();
    cleanups.forEach((cleanup) => cleanup?.());
  }

  return { ready, busy, start, dispose, subscribe, unsubscribe, topicAction };
}
