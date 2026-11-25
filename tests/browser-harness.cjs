// Isolated DOM/SDK/network substitutes: no npm, credentials or live Firebase.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

class Element {
  constructor() {
    this.children = [];
    this.listeners = {};
    this.value = "";
    this.classList = { add() {} };
  }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  querySelector(selector) { return this.nodes?.[selector] || null; }
  append(...nodes) { for (const node of nodes) node.parent = this; this.children.push(...nodes); }
  prepend(node) { node.parent = this; this.children.unshift(node); }
  get lastElementChild() { return this.children.at(-1); }
  remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); }
  cloneNode() {
    const root = new Element();
    root.nodes = {};
    for (const selector of ["h2", ".receiver-url", ".copy", ".notice", ".token", ".permission", ".subscription", ".error", ".subscribe", ".unsubscribe", ".open", ".connection", ".messages", ".count", ".topic-summary", ".topic-error", ".topic-notice", ".topic-controls", ".topic-name", ".topic-subscribe", ".topic-unsubscribe", ".topic-refresh"]) {
      root.nodes[selector] = new Element();
    }
    root.nodes[".topic-name"].value = "general_announcements";
    return root;
  }
}

function browser({ dashboard = false, savedToken = "existing-token", permission = "granted" } = {}) {
  const dom = {};
  for (const selector of ["#panels", "#startup", "#hint", "#mode"]) dom[selector] = new Element();
  dom["#panel-template"] = { content: { firstElementChild: new Element() } };
  const listeners = {}, requests = [], storage = new Map();
  if (savedToken) storage.set("fcm-push-lab-subscription", savedToken);
  const memberships = new Set();
  let fail = false, failList = false, mutations = 0, getCalls = 0, deleteCalls = 0;
  const registration = { active: {}, pushManager: { getSubscription: async () => savedToken ? {} : null } };
  const sdk = {
    isSupported: async () => true, getMessaging: () => ({}), onMessage(m, callback) { sdk.foreground = callback; },
    getToken: async () => { getCalls++; return "existing-token"; },
    deleteToken: async () => { deleteCalls++; return true; }
  };
  const child = { closed: false, focus() {}, postMessage() {} };
  const context = {
    console, URL, Date, Set, Promise, JSON, Number, String, AbortController, setTimeout, clearTimeout,
    location: { port: dashboard ? "8080" : "8081", hostname: "localhost", protocol: "http:", origin: dashboard ? "http://localhost:8080" : "http://localhost:8081" },
    document: { querySelector: (selector) => dom[selector], createElement: () => new Element() },
    navigator: { serviceWorker: { register: async () => registration, addEventListener(type, fn) { listeners.worker = fn; } }, clipboard: { writeText: async () => {} } },
    Notification: { permission, requestPermission: async () => permission },
    localStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    FCM_DEMO: { firebaseConfig: {}, vapidKey: "public-key" },
    __sdk: async (url) => url.endsWith("firebase-app.js") ? { initializeApp: () => ({}) } : sdk,
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push({ url, body });
      if (fail || (failList && url.endsWith("list"))) return { ok: false, json: async () => ({ error: "Firebase unavailable; refresh before retrying." }) };
      if (url.endsWith("subscribe") && !url.endsWith("unsubscribe")) { memberships.add(body.topic); mutations++; }
      if (url.endsWith("unsubscribe")) { memberships.delete(body.topic); mutations++; }
      return { ok: true, json: async () => url.endsWith("list") ? { topics: [...memberships] } : { topic: body.topic } };
    },
    setInterval() {}, addEventListener(type, fn) { listeners[type] = fn; }, open: () => child,
    isSecureContext: true, PushManager: {}, opener: { closed: false, postMessage() {} }
  };
  context.window = context;
  // Replace only SDK imports; production app still imports the pinned CDN SDK.
  vm.runInNewContext(fs.readFileSync("app.js", "utf8").replaceAll("import(", "__sdk("), context);
  const node = (selector, index = 0) => dom["#panels"].children[index].nodes[selector];
  return { node, dom, requests, memberships, listeners, child, sdk, registration, setFail(value) { fail = value; }, setFailList(value) { failList = value; }, counts: () => ({ mutations, getCalls, deleteCalls }) };
}


const settle = () => new Promise((resolve) => setImmediate(resolve));
module.exports = { browser, settle };
