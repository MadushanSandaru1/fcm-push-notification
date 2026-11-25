import { CHANNEL, TOPIC_PATTERN, applySnapshot } from './model.js';

export function createDashboardBridge({ panels, win = window, makeId = () => crypto.randomUUID(), timeoutMs = 120_000 }) {
  const windows = new Map();
  const lastSeen = new Map();
  const pending = new Map();

  function clearPending(panel) {
    clearTimeout(pending.get(panel.number)?.timer);
    pending.delete(panel.number);
    panel.commandPending = false;
  }

  function open(panel) {
    let tab = windows.get(panel.number);
    if (!tab || tab.closed) {
      clearPending(panel);
      tab = win.open(panel.url, '_blank');
    } else tab.focus();
    if (tab) windows.set(panel.number, tab);
    panel.error = tab ? '' : 'Popup blocked. Allow popups and click Open receiver again.';
    panel.connection = tab ? 'Connecting…' : 'Not connected';
  }

  function receive(event) {
    const panel = panels.find((item) => event.source === windows.get(item.number) && event.origin === item.url);
    const data = event.data;
    if (!panel || data?.channel !== CHANNEL || data.app !== panel.number) return false;
    if (data.type === 'snapshot') {
      if (!applySnapshot(panel, event, windows.get(panel.number))) return false;
      lastSeen.set(panel.number, Date.now());
      return true;
    }
    if (data.type !== 'topic-result' || !pending.has(panel.number) || data.requestId !== pending.get(panel.number).id || typeof data.ok !== 'boolean') return false;
    clearPending(panel);
    if (!data.ok) panel.topicError = typeof data.error === 'string' ? data.error : 'Topic unsubscribe failed. Refresh topics in the receiver.';
    return true;
  }

  function unsubscribe(panel, topic) {
    if (pending.has(panel.number)) return false;
    const tab = windows.get(panel.number);
    if (!tab || tab.closed || panel.connection !== 'Connected' || !panel.ready || panel.busy || !panel.token || panel.permission !== 'granted') {
      panel.topicError = 'Keep the matching receiver open and connected before unsubscribing.';
      if (tab?.closed) panel.connection = 'Receiver closed';
      return false;
    }
    if (!panel.topicsKnown || typeof topic !== 'string' || !TOPIC_PATTERN.test(topic) || !panel.topics.includes(topic)) {
      panel.topicError = 'Refresh topics in the receiver to confirm this membership.';
      return false;
    }
    const id = makeId();
    panel.commandPending = true;
    panel.topicError = '';
    panel.topicNotice = `Unsubscribing from ${topic}…`;
    const timer = setTimeout(() => {
      clearPending(panel);
      panel.topicsKnown = false;
      panel.topicNotice = '';
      panel.topicError = 'No unsubscribe confirmation received. Reopen the receiver and refresh topics before retrying.';
    }, timeoutMs);
    pending.set(panel.number, { id, timer });
    try {
      tab.postMessage({ channel: CHANNEL, type: 'topic-unsubscribe', app: panel.number, requestId: id, topic }, panel.url);
      return true;
    } catch {
      clearPending(panel);
      panel.topicNotice = '';
      panel.topicError = 'Cannot contact the receiver. Reopen it and refresh topics.';
      return false;
    }
  }

  function sync() {
    for (const panel of panels) {
      const tab = windows.get(panel.number);
      if (!tab) continue;
      if (tab.closed) {
        panel.connection = 'Receiver closed';
        if (pending.has(panel.number)) {
          clearPending(panel);
          panel.topicsKnown = false;
          panel.topicNotice = '';
          panel.topicError = 'Receiver closed before confirmation. Reopen it and refresh topics.';
        }
        continue;
      }
      if (lastSeen.has(panel.number) && Date.now() - lastSeen.get(panel.number) > 15_000) panel.connection = 'Waiting for receiver';
      tab.postMessage({ channel: CHANNEL, type: 'sync', app: panel.number }, panel.url);
    }
  }

  return { open, receive, unsubscribe, sync, dispose: () => panels.forEach(clearPending) };
}
