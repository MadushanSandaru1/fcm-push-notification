const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { browser, settle } = require("./browser-harness.cjs");

(async () => {
  const receiver = browser();
  await settle();
  const payload = { messageId: "individual-one", notification: { title: "<script>unsafe()</script>", body: "<img onerror=unsafe()>" } };
  receiver.sdk.foreground(payload);
  const list = receiver.node(".messages");
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0].children[0].textContent, payload.notification.title);
  assert.equal(list.children[0].children[1].textContent, payload.notification.body);
  assert.match(list.children[0].children[2].textContent, /foreground/);
  receiver.sdk.foreground(payload);
  assert.equal(list.children.length, 1);
  const workerMessage = { type: "fcm-background", payload: { messageId: "topic-one", notification: { title: "Topic", body: "Background" } }, timestamp: new Date().toISOString() };
  receiver.listeners.worker({ source: {}, origin: "http://localhost:8081", data: workerMessage });
  receiver.listeners.worker({ source: receiver.registration.active, origin: "http://localhost:8082", data: workerMessage });
  assert.equal(list.children.length, 1);
  receiver.listeners.worker({ source: receiver.registration.active, origin: "http://localhost:8081", data: workerMessage });
  assert.equal(list.children.length, 2);
  assert.match(list.children[0].children[2].textContent, /background/);
  for (let index = 0; index < 110; index++) receiver.sdk.foreground({ messageId: `message-${index}`, data: { title: "Data", body: "Body" } });
  assert.equal(list.children.length, 100);
  assert.equal(receiver.node(".count").textContent, "100");
  console.log("PASS: foreground/background logging, safe text, source validation, deduplication and bounded history");

  const blocked = browser({ savedToken: "", permission: "denied" });
  await settle();
  await blocked.node(".subscribe").listeners.click();
  assert.equal(blocked.counts().getCalls, 0);
  assert.match(blocked.node(".error").textContent, /blocked/);
  console.log("PASS: blocked browser permission prevents token registration");

  let background;
  const shown = [], forwarded = [];
  vm.runInNewContext(fs.readFileSync("firebase-messaging-sw.js", "utf8"), {
    URL, Date, importScripts() {}, FCM_DEMO: { firebaseConfig: {} },
    firebase: { initializeApp() {}, messaging: () => ({ onBackgroundMessage(fn) { background = fn; } }) },
    self: {
      location: { origin: "http://localhost:8081" },
      clients: { matchAll: async () => [
        { url: "http://localhost:8081/", postMessage(message) { forwarded.push(message); } },
        { url: "http://localhost:8082/", postMessage() { throw new Error("Wrong origin must not receive payload"); } }
      ] },
      registration: { showNotification: async (title, options) => shown.push({ title, ...options }) }
    }
  });
  await background(payload);
  assert.equal(shown.length, 0);
  assert.equal(forwarded.length, 1);
  await background({ data: { title: "Data notification", body: "Hello" } });
  assert.equal(shown.length, 1);
  assert.equal(shown[0].title, "Data notification");
  assert.equal(forwarded.length, 2);
  console.log("PASS: worker forwarding, one manual notification for data-only, no duplicate for notification payloads");
})().catch((error) => { console.error(error); process.exitCode = 1; });
