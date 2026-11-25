// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reactive, nextTick } from "vue";
import { mount, flushPromises } from "@vue/test-utils";
import { newPanel } from "../web/src/model.js";
import { useDeviceRegistration } from "../web/src/useDeviceRegistration.js";

const wrappers = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  vi.useRealTimers();
});

function setup({ connected = true, token = "", result = { p_status: 1, p_error_message: null } } = {}) {
  const panel = reactive({ ...newPanel(1), token, deviceId: "stable-device" });
  const request = vi.fn(async (url) => ({
    ok: true,
    json: async () => url.endsWith("/health") ? { connected } : result,
  }));
  let controller;
  const wrapper = mount({
    setup() {
      controller = useDeviceRegistration(panel, {
        request, storage: () => ({ getItem: () => null, setItem() {} }),
      });
      return () => null;
    },
  });
  wrappers.push(wrapper);
  const writes = () => request.mock.calls.filter(([url]) => url.endsWith("/register"));
  const tick = async () => { await nextTick(); await vi.advanceTimersByTimeAsync(450); await flushPromises(); };
  const fill = () => Object.assign(controller.fields, { loginId: "10", customerId: "20", orgId: "1" });
  return { panel, request, controller, writes, tick, fill, wrapper };
}

describe("automatic device registration", () => {
  it("deactivates on confirmed unsubscribe and reactivates even if the same token returns", async () => {
    const test = setup({ token: "token" });
    test.fill();
    await test.tick();
    test.panel.token = "";
    test.panel.unsubscribeId = "unsubscribe-1";
    await test.tick();
    const calls = test.request.mock.calls.filter(([url]) => url.endsWith("/unsubscribe"));
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0][1].body)).toEqual({ loginId: "10", customerId: "20", orgId: "1", deviceId: "stable-device" });
    expect(test.controller.notice.value).toBe("Device deactivated (status 1).");
    test.panel.unsubscribeId = "";
    test.panel.token = "token";
    await test.tick();
    expect(test.writes()).toHaveLength(2);
  });

  it("does not deactivate just because a token disappears", async () => {
    const test = setup({ token: "token" });
    test.fill();
    await test.tick();
    test.panel.token = "";
    await test.tick();
    expect(test.request.mock.calls.some(([url]) => url.endsWith("/unsubscribe"))).toBe(false);
  });

  it("skips deactivation with empty IDs and retains failed updates for retry", async () => {
    const test = setup();
    await test.tick();
    test.panel.unsubscribeId = "empty-ids";
    await test.tick();
    expect(test.request.mock.calls.some(([url]) => url.endsWith("/unsubscribe"))).toBe(false);
    test.fill();
    await test.tick();
    test.request.mockImplementation(async (url) => ({ ok: true, json: async () => url.endsWith("/health") ? { connected: true } : { p_status: 0, p_error_message: "No matching push notification device found" } }));
    test.panel.unsubscribeId = "failure";
    await test.tick();
    expect(test.controller.status.value).toBe(0);
    expect(test.controller.error.value).toBe("No matching push notification device found");
    expect(test.controller.unsubscribeQueue).toHaveLength(1);
  });

  it("queues offline unsubscribe and applies it after recovery without needing a token", async () => {
    const test = setup({ connected: false });
    test.fill();
    await test.tick();
    test.panel.unsubscribeId = "offline-unsubscribe";
    await test.tick();
    expect(test.request.mock.calls.some(([url]) => url.endsWith("/unsubscribe"))).toBe(false);
    test.request.mockImplementation(async (url) => ({ ok: true, json: async () => url.endsWith("/health") ? { connected: true } : { p_status: 1, p_error_message: null } }));
    await test.controller.checkConnection();
    await test.tick();
    expect(test.request.mock.calls.filter(([url]) => url.endsWith("/unsubscribe"))).toHaveLength(1);
    expect(test.controller.unsubscribeQueue).toHaveLength(0);
  });

  it("requires both IDs and does not register while a field is empty", async () => {
    const test = setup({ token: "token" });
    await test.tick();
    expect(test.writes()).toHaveLength(0);
    Object.assign(test.controller.fields, { loginId: "10", orgId: "1" });
    await test.tick();
    expect(test.writes()).toHaveLength(0);
    test.controller.fields.customerId = "20";
    await test.tick();
    expect(test.writes()).toHaveLength(1);
    test.controller.fields.loginId = " ";
    test.panel.token = "new-token";
    await test.tick();
    expect(test.writes()).toHaveLength(1);
  });

  it("saves received and refreshed tokens with the same device ID and displays success", async () => {
    const test = setup();
    test.fill();
    await test.tick();
    expect(test.writes()).toHaveLength(0);
    test.panel.token = "first-token";
    await test.tick();
    expect(JSON.parse(test.writes()[0][1].body)).toEqual({ loginId: "10", customerId: "20", orgId: "1", deviceId: "stable-device", token: "first-token" });
    expect(test.controller.status.value).toBe(1);
    expect(test.controller.error.value).toBe("");
    test.panel.token = "refreshed-token";
    await test.tick();
    expect(test.writes()).toHaveLength(2);
    expect(JSON.parse(test.writes()[1][1].body).deviceId).toBe("stable-device");
    await test.controller.save();
    expect(test.writes()).toHaveLength(2);
  });

  it("never registers while disconnected and saves after connectivity recovers", async () => {
    const test = setup({ connected: false, token: "token" });
    test.fill();
+    await test.tick();
    expect(test.controller.connection.value).toBe("Disconnected");
    await test.controller.save();
    expect(test.writes()).toHaveLength(0);
    test.request.mockImplementation(async (url) => ({ ok: true, json: async () => url.endsWith("/health") ? { connected: true } : { p_status: 1, p_error_message: null } }));
    await test.controller.checkConnection();
    await test.tick();
    expect(test.writes()).toHaveLength(1);
  });

  it("displays the exact procedure failure message and permits retry", async () => {
    const test = setup({ token: "token", result: { p_status: 0, p_error_message: "No notification type found for organization 1" } });
    test.fill();
    await test.tick();
    expect(test.controller.status.value).toBe(0);
    expect(test.controller.error.value).toBe("No notification type found for organization 1");
    await test.controller.save();
    expect(test.writes()).toHaveLength(2);
  });

  it("serializes changes received during a save and saves the latest token next", async () => {
    const test = setup({ token: "first-token" });
    let complete;
    test.request.mockImplementation(async (url) => {
      if (url.endsWith("/health")) return { ok: true, json: async () => ({ connected: true }) };
      if (!complete) return new Promise((resolve) => { complete = resolve; });
      return { ok: true, json: async () => ({ p_status: 1, p_error_message: null }) };
    });
    test.fill();
    await test.tick();
    expect(test.writes()).toHaveLength(1);
    test.panel.token = "latest-token";
    await test.tick();
    expect(test.writes()).toHaveLength(1);
    complete({ ok: true, json: async () => ({ p_status: 1, p_error_message: null }) });
    await flushPromises();
    await test.tick();
    expect(test.writes()).toHaveLength(2);
    expect(JSON.parse(test.writes()[1][1].body).token).toBe("latest-token");
    expect(test.controller.status.value).toBe(1);
  });

  it("keeps the token when the helper fails and cancels polling on unmount", async () => {
    const test = setup({ token: "token" });
    await test.tick();
    test.request.mockRejectedValue(new Error("helper unavailable"));
    test.fill();
    await test.tick();
    expect(test.panel.token).toBe("token");
    expect(test.controller.status.value).toBe(0);
    expect(test.controller.connection.value).toBe("Disconnected");
    test.wrapper.unmount();
    test.request.mockClear();
    await vi.advanceTimersByTimeAsync(30000);
    expect(test.request).not.toHaveBeenCalled();
  });
});
