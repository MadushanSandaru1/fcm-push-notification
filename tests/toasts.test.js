// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { reactive, nextTick } from "vue";
import { mount } from "@vue/test-utils";
import PushToasts from "../web/src/components/PushToasts.vue";
import ReceiverPanel from "../web/src/components/ReceiverPanel.vue";
import { addMessage, newPanel } from "../web/src/model.js";

afterEach(() => vi.useRealTimers());

const message = (id, body = "Hello") => ({
  id, title: `Push ${id}`, body, mode: "foreground", timestamp: new Date().toISOString(),
});

it("stacks messages across panels and expires each toast five seconds after arrival while retaining history", async () => {
  vi.useFakeTimers();
  const panels = reactive([newPanel(1), newPanel(2)]);
  const wrapper = mount(PushToasts, { props: { panels } });
  addMessage(panels[0], message("one"));
  await nextTick();
  expect(wrapper.findAll(".push-toast")).toHaveLength(1);
  vi.advanceTimersByTime(3000);
  addMessage(panels[1], { ...message("one"), mode: "background" });
  await nextTick();
  expect(wrapper.findAll(".push-toast")).toHaveLength(2);
  expect(wrapper.text()).toContain("App 2 · background");
  vi.advanceTimersByTime(1999);
  await nextTick();
  expect(wrapper.findAll(".push-toast")).toHaveLength(2);
  vi.advanceTimersByTime(1);
  await nextTick();
  expect(wrapper.findAll(".push-toast")).toHaveLength(1);
  expect(wrapper.text()).toContain("App 2");
  vi.advanceTimersByTime(3000);
  await nextTick();
  expect(wrapper.findAll(".push-toast")).toHaveLength(0);
  expect(panels.map((panel) => panel.messages.length)).toEqual([1, 1]);
  wrapper.unmount();
});

it("closes only the selected toast, avoids replaying existing messages and clears timers on unmount", async () => {
  vi.useFakeTimers();
  const panels = reactive([newPanel(1)]);
  addMessage(panels[0], message("existing"));
  const wrapper = mount(PushToasts, { props: { panels } });
  expect(wrapper.findAll(".push-toast")).toHaveLength(0);
  addMessage(panels[0], message("one"));
  addMessage(panels[0], message("two"));
  await nextTick();
  await wrapper.find('button[aria-label="Close notification: Push one"]').trigger("click");
  expect(wrapper.findAll(".push-toast")).toHaveLength(1);
  expect(wrapper.text()).toContain("Push two");
  panels[0].messages = [...panels[0].messages];
  await nextTick();
  expect(wrapper.findAll(".push-toast")).toHaveLength(1);
  expect(panels[0].messages).toHaveLength(3);
  expect(vi.getTimerCount()).toBe(1);
  wrapper.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("preserves actual and escaped body line breaks in toasts and history, and renders HTML as text", async () => {
  const panel = reactive(newPanel(1));
  const toasts = mount(PushToasts, { props: { panels: [panel] } });
  const history = mount(ReceiverPanel, { props: { panel } });
  addMessage(panel, message("lines", "First\nSecond\\nThird\\r\\n<img onerror=bad()>"));
  await nextTick();
  for (const wrapper of [toasts, history]) {
    expect(wrapper.find(".message-body").element.textContent).toBe("First\nSecond\nThird\n<img onerror=bad()>");
    expect(wrapper.find("img").exists()).toBe(false);
  }
  toasts.unmount();
  history.unmount();
});
