// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { nextTick, reactive } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import { useReceiver } from "../web/src/useReceiver.js";
import {
  newPanel,
  CHANNEL,
  applySnapshot,
  addMessage,
  fromPayload,
  TOKEN_KEY,
} from "../web/src/model.js";
import ReceiverPanel from "../web/src/components/ReceiverPanel.vue";
import { createDashboardBridge } from "../web/src/dashboard.js";

function receiver({
  saved = "old-token",
  permission = "granted",
  storageBlocked = false,
} = {}) {
  const panel = reactive(newPanel(1));
  const values = new Map(saved ? [[TOKEN_KEY, saved]] : []);
  const storage = {
    getItem: (key) => values.get(key),
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const win = new EventTarget();
  win.location = { origin: "http://localhost:6061" };
  win.opener = { closed: false, postMessage: vi.fn() };
  if (storageBlocked)
    Object.defineProperty(win, "localStorage", {
      get() {
        throw new Error("Storage denied");
      },
    });
  win.Notification = {
    permission,
    requestPermission: vi.fn(async () => permission),
  };
  const nav = { serviceWorker: new EventTarget() };
  let foreground;
  const sdk = {
    registration: {
      active: {},
      pushManager: { getSubscription: async () => (saved ? {} : null) },
    },
    getToken: vi.fn(async () => "new-token"),
    deleteToken: vi.fn(async () => true),
    onMessage: (listener) => {
      foreground = listener;
      return vi.fn();
    },
  };
  let failing = false;
  const topics = new Set();
  const request = vi.fn(async (url, options) => {
    const body = JSON.parse(options.body);
    if (failing)
      return {
        ok: false,
        json: async () => ({ error: "Firebase is unavailable" }),
      };
    if (url.endsWith("/subscribe")) topics.add(body.topic);
    if (url.endsWith("/unsubscribe")) topics.delete(body.topic);
    return {
      ok: true,
      json: async () => (url.endsWith("/list") ? { topics: [...topics] } : {}),
    };
  });
  const controller = useReceiver(panel, {
    win,
    nav,
    ...(storageBlocked ? {} : { storage }),
    request,
    sdkFactory: async () => sdk,
  });
  return {
    panel,
    controller,
    sdk,
    values,
    topics,
    request,
    win,
    nav,
    foreground: (data) => foreground(data),
    fail: (value) => {
      failing = value;
    },
  };
}

describe("receiver subscriptions and lifecycle", () => {
  it("rejects spoofed, malformed and busy dashboard unsubscribe commands", async () => {
    const test = receiver();
    await test.controller.start();
    await test.controller.topicAction("subscribe", "news");
    test.request.mockClear();
    const data = {
      channel: CHANNEL,
      app: 1,
      type: "topic-unsubscribe",
      requestId: "command-1",
      topic: "news",
    };
    const send = (payload = data, overrides = {}) =>
      test.win.dispatchEvent(
        new MessageEvent("message", {
          origin: "http://localhost:6060",
          source: test.win.opener,
          data: payload,
          ...overrides,
        }),
      );
    send(data, { origin: "http://localhost:6062" });
    send(data, { source: {} });
    for (const change of [
      { channel: "other" },
      { app: 2 },
      { topic: "../invalid" },
      { requestId: "" },
      { type: "subscribe" },
    ])
      send({ ...data, ...change });
    await flushPromises();
    expect(test.request).not.toHaveBeenCalled();
    test.controller.busy.value = true;
    send();
    await flushPromises();
    expect(test.request).not.toHaveBeenCalled();
    expect(test.win.opener.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "topic-result",
        requestId: "command-1",
        ok: false,
      }),
      "http://localhost:6060",
    );
    test.controller.busy.value = false;
    send();
    await flushPromises();
    expect(test.panel.topics).toEqual([]);
    expect(test.win.opener.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "topic-result",
        requestId: "command-1",
        ok: true,
      }),
      "http://localhost:6060",
    );
    test.controller.dispose();
  });

  it("restores without requesting a token or rejoining topics", async () => {
    const test = receiver();
    await test.controller.start();
    expect(test.panel.token).toBe("old-token");
    expect(test.sdk.getToken).not.toHaveBeenCalled();
    expect(test.panel.deviceId).toBeTruthy();
    expect(test.values.get("fcm-push-lab-device-id")).toBe(test.panel.deviceId);
    expect(
      test.request.mock.calls.every(([url]) => url.endsWith("/list")),
    ).toBe(true);
    test.controller.dispose();
  });

  it("requests permission on explicit subscribe, deletes token and never auto opts in on reload", async () => {
    const test = receiver({ saved: "" });
    await test.controller.start();
    expect(test.request).not.toHaveBeenCalled();
    await test.controller.subscribe();
    expect(test.win.Notification.requestPermission).toHaveBeenCalledOnce();
    expect(test.panel.token).toBe("new-token");
    await test.controller.unsubscribe();
    expect(test.sdk.deleteToken).toHaveBeenCalledOnce();
    expect(test.panel.token).toBe("");
    expect(test.panel.unsubscribeId).toBeTruthy();
    expect(test.values.has(TOKEN_KEY)).toBe(false);
    expect(test.panel.permission).toBe("granted");
    test.controller.dispose();
    const reloaded = receiver({ saved: "" });
    await reloaded.controller.start();
    expect(reloaded.sdk.getToken).not.toHaveBeenCalled();
    expect(reloaded.panel.subscription).toBe("Not subscribed");
    reloaded.controller.dispose();
  });

  it("leaves topics without deleting the individual token and recovers from errors", async () => {
    const test = receiver();
    await test.controller.start();
    await test.controller.topicAction("subscribe", "general_announcements");
    expect(test.panel.topics).toEqual(["general_announcements"]);
    await test.controller.topicAction("unsubscribe", "general_announcements");
    expect(test.panel.topics).toEqual([]);
    expect(test.panel.token).toBe("old-token");
    expect(test.sdk.deleteToken).not.toHaveBeenCalled();
    expect(test.panel.unsubscribeId).toBe("");
    const count = test.request.mock.calls.length;
    await test.controller.topicAction("subscribe", "../bad");
    expect(test.request).toHaveBeenCalledTimes(count);
    test.fail(true);
    await test.controller.topicAction("subscribe", "test");
    expect(test.panel.topicsKnown).toBe(false);
    expect(test.panel.topicError).toContain("unavailable");
    expect(test.panel.topicNotice).toBe("");
    test.fail(false);
    await test.controller.topicAction("list");
    expect(test.panel.topicsKnown).toBe(true);
    test.controller.dispose();
  });

  it("does not register a token when permission is blocked", async () => {
    const test = receiver({ saved: "", permission: "denied" });
    await test.controller.start();
    await test.controller.subscribe();
    expect(test.sdk.getToken).not.toHaveBeenCalled();
    expect(test.panel.error).toContain("blocked");
    test.controller.dispose();
  });

  it("keeps the Vue receiver usable when the browser denies local storage access", async () => {
    const test = receiver({ storageBlocked: true });
    await test.controller.start();
    expect(test.controller.ready.value).toBe(true);
    expect(test.panel.error).toContain("Local storage is unavailable");
    expect(test.sdk.getToken).not.toHaveBeenCalled();
    await test.controller.subscribe();
    expect(test.panel.token).toBe("new-token");
    expect(test.panel.error).toContain("local storage is unavailable");
    test.controller.dispose();
  });

  it("accepts background payloads only from the exact registered worker and origin", async () => {
    const test = receiver();
    await test.controller.start();
    const data = {
      type: "fcm-background",
      payload: {
        messageId: "background-1",
        data: { title: "Background", body: "Hello" },
      },
    };
    test.nav.serviceWorker.dispatchEvent(
      new MessageEvent("message", {
        origin: "http://localhost:6061",
        source: {},
        data,
      }),
    );
    expect(test.panel.messages).toHaveLength(0);
    test.nav.serviceWorker.dispatchEvent(
      new MessageEvent("message", {
        origin: "http://localhost:6062",
        source: test.sdk.registration.active,
        data,
      }),
    );
    expect(test.panel.messages).toHaveLength(0);
    test.nav.serviceWorker.dispatchEvent(
      new MessageEvent("message", {
        origin: "http://localhost:6061",
        source: test.sdk.registration.active,
        data,
      }),
    );
    test.foreground({
      messageId: "foreground-1",
      notification: { title: "Foreground", body: "Hello" },
    });
    expect(test.panel.messages.map((message) => message.mode)).toEqual([
      "background",
      "foreground",
    ]);
    test.controller.dispose();
  });

  it("validates the dashboard origin and opener reference in both directions", async () => {
    const test = receiver();
    await test.controller.start();
    const data = { channel: CHANNEL, type: "sync", app: 1 };
    const before = test.win.opener.postMessage.mock.calls.length;
    test.win.dispatchEvent(
      new MessageEvent("message", {
        origin: "http://localhost:6060",
        source: {},
        data,
      }),
    );
    expect(test.win.opener.postMessage).toHaveBeenCalledTimes(before);
    test.win.dispatchEvent(
      new MessageEvent("message", {
        origin: "http://localhost:6060",
        source: test.win.opener,
        data,
      }),
    );
    expect(test.win.opener.postMessage).toHaveBeenCalledTimes(before + 1);
    const panel = newPanel(1);
    const source = {};
    const snapshot = {
      channel: CHANNEL,
      type: "snapshot",
      app: 1,
      state: test.panel,
      messages: [],
    };
    expect(
      applySnapshot(
        panel,
        { origin: "http://localhost:6062", source, data: snapshot },
        source,
      ),
    ).toBe(false);
    expect(
      applySnapshot(
        panel,
        { origin: panel.url, source: {}, data: snapshot },
        source,
      ),
    ).toBe(false);
    expect(
      applySnapshot(
        panel,
        { origin: panel.url, source, data: snapshot },
        source,
      ),
    ).toBe(true);
    expect(panel.token).toBe("old-token");
    test.controller.dispose();
  });
});

describe("Vue panel rendering", () => {
  const button = (wrapper, name) =>
    wrapper.findAll("button").find((item) => item.text() === name);

  it("unsubscribes from a dashboard row through the matching receiver without affecting other subscriptions", async () => {
    const test = receiver();
    await test.controller.start();
    await test.controller.topicAction("subscribe", "general_announcements");
    await test.controller.topicAction("subscribe", "order_updates");
    const panel = reactive(newPanel(1));
    const other = reactive(newPanel(2));
    const dashboardWindow = test.win.opener;
    dashboardWindow.open = vi.fn(() => test.win);
    test.win.postMessage = vi.fn((data) =>
      test.win.dispatchEvent(
        new MessageEvent("message", {
          origin: "http://localhost:6060",
          source: dashboardWindow,
          data,
        }),
      ),
    );
    const bridge = createDashboardBridge({
      panels: [panel, other],
      win: dashboardWindow,
      makeId: () => "test-command",
    });
    dashboardWindow.postMessage.mockImplementation((data) =>
      bridge.receive({ origin: test.panel.url, source: test.win, data }),
    );
    bridge.open(panel);
    bridge.sync();
    const wrapper = mount(ReceiverPanel, {
      props: {
        panel,
        dashboard: true,
        onTopic: (action, topic) => bridge.unsubscribe(panel, topic),
      },
    });
    const row = wrapper.find(
      'button[aria-label="Unsubscribe from general_announcements"]',
    );
    expect(row.element.disabled).toBe(false);
    await row.trigger("click");
    await flushPromises();
    expect(panel.commandPending).toBe(false);
    expect(panel.topics).toEqual(["order_updates"]);
    expect(test.panel.topics).toEqual(["order_updates"]);
    expect(panel.token).toBe("old-token");
    expect(test.sdk.deleteToken).not.toHaveBeenCalled();
    expect(other).toEqual(newPanel(2));
    test.fail(true);
    await wrapper
      .find('button[aria-label="Unsubscribe from order_updates"]')
      .trigger("click");
    await flushPromises();
    expect(panel.topicError).toContain("unavailable");
    expect(panel.commandPending).toBe(false);
    expect(test.topics.has("order_updates")).toBe(true);
    wrapper.unmount();
    bridge.dispose();
    test.controller.dispose();
  });

  it("disables dashboard row actions while disconnected, busy or awaiting confirmation", async () => {
    const panel = reactive({
      ...newPanel(1),
      token: "token",
      permission: "granted",
      ready: true,
      connection: "Connected",
      topicsKnown: true,
      topics: ["news"],
    });
    const wrapper = mount(ReceiverPanel, { props: { panel, dashboard: true } });
    const row = () => wrapper.find(".topic-list button");
    expect(row().element.disabled).toBe(false);
    for (const change of [
      { busy: true },
      { commandPending: true },
      { connection: "Receiver closed" },
      { ready: false },
    ]) {
      const original = { ...panel };
      Object.assign(panel, change);
      await nextTick();
      expect(row().element.disabled).toBe(true);
      Object.assign(panel, original);
      await nextTick();
    }
    wrapper.unmount();
  });

  it("lists confirmed topics with an unsubscribe action targeting that row, independent of the input", async () => {
    const panel = reactive({
      ...newPanel(1),
      token: "token",
      permission: "granted",
      topicsKnown: true,
      topics: ["general_announcements", "order_updates"],
    });
    const wrapper = mount(ReceiverPanel, {
      props: { panel, receiver: true, ready: true },
    });
    expect(wrapper.findAll(".topic-list li")).toHaveLength(2);
    await wrapper.find("input.topic-name").setValue("different_topic");
    await wrapper
      .find('button[aria-label="Unsubscribe from order_updates"]')
      .trigger("click");
    expect(wrapper.emitted("topic")).toEqual([
      ["unsubscribe", "order_updates"],
    ]);
    await wrapper.setProps({ busy: true });
    expect(
      wrapper
        .findAll(".topic-list button")
        .every((item) => item.element.disabled),
    ).toBe(true);
    await wrapper.setProps({ busy: false });
    panel.topicsKnown = false;
    await nextTick();
    expect(wrapper.find(".topic-list").exists()).toBe(false);
    wrapper.unmount();
    const dashboard = mount(ReceiverPanel, {
      props: { panel: { ...panel, topicsKnown: true } },
    });
    expect(dashboard.findAll(".topic-list li")).toHaveLength(2);
    expect(dashboard.find(".topic-list button").exists()).toBe(false);
    dashboard.unmount();
  });

  it("removes a topic row after confirmed unsubscribe while preserving other topics and the FCM token", async () => {
    const test = receiver();
    await test.controller.start();
    await test.controller.topicAction("subscribe", "general_announcements");
    await test.controller.topicAction("subscribe", "order_updates");
    const wrapper = mount(ReceiverPanel, {
      props: {
        panel: test.panel,
        receiver: true,
        ready: true,
        onTopic: (action, topic) => test.controller.topicAction(action, topic),
      },
    });
    await wrapper
      .find('button[aria-label="Unsubscribe from general_announcements"]')
      .trigger("click");
    await flushPromises();
    expect(wrapper.findAll(".topic-list li")).toHaveLength(1);
    expect(wrapper.find(".topic-list").text()).toContain("order_updates");
    expect(wrapper.find(".topic-list").text()).not.toContain(
      "general_announcements",
    );
    expect(test.panel.token).toBe("old-token");
    expect(test.sdk.deleteToken).not.toHaveBeenCalled();
    test.fail(true);
    await wrapper
      .find('button[aria-label="Unsubscribe from order_updates"]')
      .trigger("click");
    await flushPromises();
    expect(test.topics.has("order_updates")).toBe(true);
    expect(test.panel.topicError).toContain("unavailable");
    expect(wrapper.find(".topic-list").exists()).toBe(false);
    expect(test.panel.token).toBe("old-token");
    wrapper.unmount();
    test.controller.dispose();
  });

  it("enables only the appropriate individual action and locks both while loading", async () => {
    const panel = reactive(newPanel(1));
    const wrapper = mount(ReceiverPanel, {
      props: { panel, receiver: true, ready: true },
    });
    expect(button(wrapper, "Subscribe").element.disabled).toBe(false);
    expect(button(wrapper, "Unsubscribe").element.disabled).toBe(true);
    panel.token = "subscribed-token";
    panel.subscription = "Subscribed (saved token)";
    await nextTick();
    expect(button(wrapper, "Subscribe").element.disabled).toBe(true);
    expect(button(wrapper, "Unsubscribe").element.disabled).toBe(false);
    await wrapper.setProps({ busy: true });
    expect(button(wrapper, "Subscribe").element.disabled).toBe(true);
    expect(button(wrapper, "Unsubscribe").element.disabled).toBe(true);
    panel.token = "";
    panel.subscription = "Not subscribed";
    await wrapper.setProps({ busy: false });
    expect(button(wrapper, "Subscribe").element.disabled).toBe(false);
    expect(button(wrapper, "Unsubscribe").element.disabled).toBe(true);
    await wrapper.setProps({ ready: false });
    expect(button(wrapper, "Subscribe").element.disabled).toBe(true);
    expect(button(wrapper, "Unsubscribe").element.disabled).toBe(true);
    wrapper.unmount();
  });

  it("updates topic actions for the selected name and confirmed membership", async () => {
    const panel = reactive({
      ...newPanel(1),
      token: "token",
      permission: "granted",
      topicsKnown: true,
    });
    const wrapper = mount(ReceiverPanel, {
      props: { panel, receiver: true, ready: true },
    });
    expect(button(wrapper, "Subscribe to topic").element.disabled).toBe(false);
    expect(button(wrapper, "Unsubscribe from topic").element.disabled).toBe(
      true,
    );
    panel.topics = ["general_announcements"];
    await nextTick();
    expect(button(wrapper, "Subscribe to topic").element.disabled).toBe(true);
    expect(button(wrapper, "Unsubscribe from topic").element.disabled).toBe(
      false,
    );
    await wrapper.find("input.topic-name").setValue(" other_topic ");
    expect(button(wrapper, "Subscribe to topic").element.disabled).toBe(false);
    expect(button(wrapper, "Unsubscribe from topic").element.disabled).toBe(
      true,
    );
    panel.topics.push("other_topic");
    await nextTick();
    expect(button(wrapper, "Subscribe to topic").element.disabled).toBe(true);
    expect(button(wrapper, "Unsubscribe from topic").element.disabled).toBe(
      false,
    );
    panel.topics = [];
    await nextTick();
    expect(button(wrapper, "Subscribe to topic").element.disabled).toBe(false);
    expect(button(wrapper, "Unsubscribe from topic").element.disabled).toBe(
      true,
    );
    wrapper.unmount();
  });

  it("requires a known valid topic state, permits refresh, and disables actions during requests", async () => {
    const panel = reactive({
      ...newPanel(1),
      token: "token",
      permission: "granted",
    });
    const wrapper = mount(ReceiverPanel, {
      props: { panel, receiver: true, ready: true },
    });
    expect(button(wrapper, "Subscribe to topic").element.disabled).toBe(true);
    expect(button(wrapper, "Unsubscribe from topic").element.disabled).toBe(
      true,
    );
    expect(button(wrapper, "Refresh topics").element.disabled).toBe(false);
    expect(wrapper.text()).toContain(
      "Refresh topics to check the selected topic.",
    );
    panel.topicsKnown = true;
    await wrapper.find("input.topic-name").setValue("../invalid");
    expect(button(wrapper, "Subscribe to topic").element.disabled).toBe(true);
    expect(button(wrapper, "Unsubscribe from topic").element.disabled).toBe(
      true,
    );
    await wrapper.find("input.topic-name").setValue("general_announcements");
    await wrapper.setProps({ busy: true });
    for (const name of [
      "Subscribe to topic",
      "Unsubscribe from topic",
      "Refresh topics",
    ])
      expect(button(wrapper, name).element.disabled).toBe(true);
    expect(wrapper.find("input.topic-name").element.disabled).toBe(true);
    await wrapper.setProps({ busy: false });
    panel.token = "";
    await nextTick();
    for (const name of [
      "Subscribe to topic",
      "Unsubscribe from topic",
      "Refresh topics",
    ])
      expect(button(wrapper, name).element.disabled).toBe(true);
    wrapper.unmount();
  });

  it("renders unsafe incoming text literally, deduplicates and limits log history", () => {
    const panel = newPanel(1);
    const message = fromPayload(
      {
        messageId: "one",
        notification: {
          title: "<script>bad()</script>",
          body: "<img onerror=bad()>",
        },
      },
      "foreground",
    );
    addMessage(panel, message);
    addMessage(panel, message);
    const wrapper = mount(ReceiverPanel, { props: { panel } });
    expect(wrapper.text()).toContain("<script>bad()</script>");
    expect(wrapper.find("script").exists()).toBe(false);
    expect(wrapper.find("img").exists()).toBe(false);
    expect(panel.messages).toHaveLength(1);
    for (let i = 0; i < 120; i++)
      addMessage(panel, { ...message, id: String(i) });
    expect(panel.messages).toHaveLength(100);
    wrapper.unmount();
  });

  it("shows topic controls only in receivers and disables them without a token", () => {
    const panel = newPanel(1);
    const dashboard = mount(ReceiverPanel, { props: { panel } });
    expect(
      dashboard.findAll("button").map((button) => button.text()),
    ).toContain("Open receiver ↗");
    expect(dashboard.find("input.topic-name").exists()).toBe(false);
    dashboard.unmount();
    const receiver = mount(ReceiverPanel, {
      props: { panel, receiver: true, ready: true },
    });
    expect(receiver.find("input.topic-name").element.disabled).toBe(true);
    receiver.unmount();
  });
});
