export const CHANNEL = 'fcm-push-lab-v1';
export const DASHBOARD_ORIGIN = 'http://localhost:8080';
export const TOKEN_KEY = 'fcm-push-lab-subscription';
export const TOPIC_PATTERN = /^[a-zA-Z0-9_.~%\-]{1,900}$/;

export function newPanel(number) {
  return { number, url: `http://localhost:${8080 + number}`, connection: 'Not connected', ready: false, busy: false, commandPending: false, permission: 'Unknown', subscription: 'Unknown', token: '', error: '', topics: [], topicsKnown: false, topicError: '', topicNotice: '', messages: [] };
}

export function addMessage(panel, message) {
  if (!message || typeof message.id !== 'string' || !['foreground', 'background'].includes(message.mode)) return;
  if (panel.messages.some((existing) => existing.id === message.id)) return;
  panel.messages = [...panel.messages, message].slice(-100);
}

export function fromPayload(payload, mode, timestamp = new Date().toISOString()) {
  if (!payload || typeof payload !== 'object') return null;
  return { id: payload.messageId || `${mode}:${timestamp}:${JSON.stringify(payload)}`, title: String(payload.notification?.title ?? payload.data?.title ?? 'FCM message'), body: String(payload.notification?.body ?? payload.data?.body ?? '(No body)'), timestamp, mode };
}

export function applySnapshot(panel, event, expectedWindow) {
  const data = event.data;
  if (!expectedWindow || event.source !== expectedWindow || event.origin !== panel.url || data?.channel !== CHANNEL || data.type !== 'snapshot' || data.app !== panel.number) return false;
  const state = data.state;
  if (!state || typeof state !== 'object') return false;
  for (const key of ['permission', 'subscription', 'token', 'error', 'topicError', 'topicNotice']) panel[key] = typeof state[key] === 'string' ? state[key] : '';
  panel.topics = Array.isArray(state.topics) ? state.topics.filter((topic) => typeof topic === 'string') : [];
  panel.topicsKnown = state.topicsKnown === true;
  panel.ready = state.ready === true;
  panel.busy = state.busy === true;
  if (Array.isArray(data.messages)) data.messages.slice(-100).forEach((message) => addMessage(panel, message));
  panel.connection = 'Connected';
  return true;
}
