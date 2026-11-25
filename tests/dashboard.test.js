// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createDashboardBridge } from '../web/src/dashboard.js';
import { CHANNEL, newPanel } from '../web/src/model.js';

function dashboard() {
  const panel = newPanel(1);
  const tab = { closed: false, postMessage: vi.fn(), focus: vi.fn() };
  const win = { open: vi.fn(() => tab) };
  const bridge = createDashboardBridge({ panels: [panel], win, makeId: () => 'request-1', timeoutMs: 100 });
  bridge.open(panel);
  const event = (data, overrides = {}) => ({ origin: panel.url, source: tab, data: { channel: CHANNEL, app: 1, ...data }, ...overrides });
  bridge.receive(event({ type: 'snapshot', state: { ready: true, busy: false, token: 'token', permission: 'granted', topicsKnown: true, topics: ['news'] }, messages: [] }));
  return { panel, tab, bridge, event };
}

afterEach(() => vi.useRealTimers());

it('sends a targeted command without focusing the receiver and requires a matching trusted reply', () => {
  const { panel, tab, bridge, event } = dashboard();
  expect(bridge.unsubscribe(panel, 'news')).toBe(true);
  expect(panel.commandPending).toBe(true);
  expect(tab.postMessage).toHaveBeenLastCalledWith({ channel: CHANNEL, type: 'topic-unsubscribe', app: 1, requestId: 'request-1', topic: 'news' }, panel.url);
  expect(tab.focus).not.toHaveBeenCalled();
  expect(bridge.unsubscribe(panel, 'news')).toBe(false);
  const reply = { type: 'topic-result', requestId: 'request-1', ok: true };
  for (const spoof of [event(reply, { origin: 'http://localhost:8082' }), event(reply, { source: {} }), event({ ...reply, requestId: 'other' }), event({ ...reply, app: 2 })]) {
    expect(bridge.receive(spoof)).toBe(false);
    expect(panel.commandPending).toBe(true);
  }
  expect(bridge.receive(event(reply))).toBe(true);
  expect(panel.commandPending).toBe(false);
  bridge.dispose();
});

it('requires a ready connected receiver and confirmed membership', () => {
  const { panel, tab, bridge } = dashboard();
  for (const change of [{ busy: true }, { ready: false }, { topicsKnown: false }, { connection: 'Waiting for receiver' }]) {
    const original = { ...panel };
    Object.assign(panel, change);
    expect(bridge.unsubscribe(panel, 'news')).toBe(false);
    Object.assign(panel, original);
  }
  expect(bridge.unsubscribe(panel, 'other')).toBe(false);
  expect(tab.postMessage).not.toHaveBeenCalled();
  bridge.dispose();
});

it('releases pending controls and reports uncertain membership on timeout or receiver closure', () => {
  vi.useFakeTimers();
  const first = dashboard();
  first.bridge.unsubscribe(first.panel, 'news');
  vi.advanceTimersByTime(100);
  expect(first.panel.commandPending).toBe(false);
  expect(first.panel.topicsKnown).toBe(false);
  expect(first.panel.topicError).toContain('No unsubscribe confirmation');
  first.bridge.dispose();
  const second = dashboard();
  second.bridge.unsubscribe(second.panel, 'news');
  second.tab.closed = true;
  second.bridge.sync();
  expect(second.panel.commandPending).toBe(false);
  expect(second.panel.connection).toBe('Receiver closed');
  expect(second.panel.topicsKnown).toBe(false);
  second.bridge.dispose();
});
