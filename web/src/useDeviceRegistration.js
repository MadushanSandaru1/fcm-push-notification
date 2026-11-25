import { reactive, ref, watch, onMounted, onUnmounted } from "vue";

export function useDeviceRegistration(panel, { request = fetch, storage = () => localStorage } = {}) {
  const fields = reactive({ loginId: "", customerId: "", orgId: "" });
  const connection = ref("Checking…");
  const connectionError = ref("");
  const notice = ref("");
  const error = ref("");
  const saving = ref(false);
  const checking = ref(false);
  const status = ref(null);
  const unsubscribeQueue = reactive([]);
  const key = `fcm-push-lab-db-fields-${panel.number}`;
  const controllers = new Set();
  let disposed = false;
  let interval;
  let debounce;
  let lastSaved = "";
  let pending = false;
  const fingerprint = () => JSON.stringify([fields.loginId, fields.customerId, fields.orgId, panel.deviceId, panel.token]);
  const complete = () => Object.values(fields).every((value) => String(value).trim() !== "");

  async function post(path, data) {
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await request(path, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data), signal: controller.signal,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Database request failed.");
      return result;
    } finally {
      clearTimeout(timer);
      controllers.delete(controller);
    }
  }

  async function checkConnection() {
    if (checking.value || disposed) return;
    checking.value = true;
    try {
      const result = await post("/api/database/health", {});
      if (disposed) return;
      connection.value = result.connected === true ? "Connected" : "Disconnected";
      connectionError.value = result.connected === true ? "" : (result.error || "Configure the database connection on the server.");
    } catch {
      if (!disposed) {
        connection.value = "Disconnected";
        connectionError.value = "Cannot reach the database helper. No tokens will be saved.";
      }
    } finally { checking.value = false; }
  }

  async function save() {
    if (disposed) return;
    if (saving.value) { pending = true; return; }
    status.value = null;
    error.value = "";
    const unsubscribe = unsubscribeQueue[0];
    if (!unsubscribe && !complete()) { notice.value = "Enter both login ID and customer ID, plus organization ID, to save the token."; return; }
    if (connection.value !== "Connected") { notice.value = unsubscribe ? "Database unavailable. Device status update is pending; keep this page open." : "Database unavailable. Token has not been saved."; return; }
    if (!unsubscribe && (!panel.token || !panel.deviceId)) {
      notice.value = panel.token ? "Open the receiver with browser storage enabled to obtain a device ID." : "Waiting for an FCM token.";
      return;
    }
    const current = fingerprint();
    if (!unsubscribe && current === lastSaved) { status.value = 1; notice.value = "Token saved (status 1)."; return; }
    saving.value = true;
    notice.value = unsubscribe ? "Updating device status…" : "Saving token…";
    let succeeded = false;
    try {
      const result = await post(unsubscribe ? "/api/devices/unsubscribe" : "/api/devices/register",
        unsubscribe || { ...fields, deviceId: panel.deviceId, token: panel.token });
      if (disposed) return;
      if (result.connected === false) connection.value = "Disconnected";
      if (result.p_status !== 0 && result.p_status !== 1)
        throw new Error("Invalid database procedure response.");
      succeeded = result.p_status === 1;
      if (succeeded) {
        if (unsubscribe) { unsubscribeQueue.shift(); lastSaved = ""; }
        else lastSaved = current;
      }
      if (!unsubscribe && current !== fingerprint()) return;
      status.value = result.p_status;
      notice.value = unsubscribe
        ? (succeeded ? "Device deactivated (status 1)." : "Device status was not updated (status 0).")
        : (succeeded ? "Token saved (status 1)." : "Token was not saved (status 0).");
      error.value = result.p_status === 0 ? (result.p_error_message || "Device registration failed.") : "";
    } catch (cause) {
      if (!disposed && (unsubscribe || current === fingerprint())) {
        status.value = 0;
        notice.value = unsubscribe ? "Device status was not updated (status 0)." : "Token was not saved (status 0).";
        error.value = cause.name === "AbortError" ? "Save timed out. Check connectivity and retry." : cause.message;
        void checkConnection();
      }
    } finally {
      saving.value = false;
      if (!disposed && (pending || (unsubscribe && succeeded && (unsubscribeQueue.length || panel.token)))) {
        pending = false;
        schedule();
      }
    }
  }

  function schedule() {
    clearTimeout(debounce);
    debounce = setTimeout(() => void save(), 400);
  }

  const stopFields = watch(fingerprint, () => {
    try { storage().setItem(key, JSON.stringify(fields)); } catch { /* Fields still work without persistence. */ }
    status.value = null;
    error.value = "";
    schedule();
  });
  const stopConnection = watch(connection, (value) => {
    if (value === "Connected") schedule();
    else {
      clearTimeout(debounce);
      if (status.value !== 0) notice.value = "Database unavailable. Token has not been saved.";
    }
  });
  // Only a confirmed individual unsubscribe emits this ID. A missing token on
  // startup, denied permission, or topic unsubscribe must not deactivate rows.
  const stopUnsubscribe = watch(() => panel.unsubscribeId, (id) => {
    if (!id) return;
    lastSaved = "";
    if (!complete() || !panel.deviceId) {
      notice.value = "Database status update skipped: login, customer, organization, and device IDs are required.";
      clearTimeout(debounce);
      return;
    }
    unsubscribeQueue.push({ ...fields, deviceId: panel.deviceId });
    schedule();
  });
  onMounted(() => {
    try {
      const saved = JSON.parse(storage().getItem(key) || "{}");
      for (const name of Object.keys(fields))
        if (typeof saved[name] === "string") fields[name] = saved[name];
    } catch { /* Browser storage may be unavailable. */ }
    void checkConnection();
    interval = setInterval(() => void checkConnection(), 15000);
    schedule();
  });
  onUnmounted(() => {
    disposed = true;
    stopFields();
    stopConnection();
    stopUnsubscribe();
    clearInterval(interval);
    clearTimeout(debounce);
    for (const controller of controllers) controller.abort();
  });
  return { fields, connection, connectionError, checking, checkConnection, notice, error, status, saving, save, unsubscribeQueue };
}
