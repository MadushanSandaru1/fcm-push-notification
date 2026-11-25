import { ApiError } from './errors.js';
import { getAccessToken } from './auth.js';

export const PROJECT_ID = 'fcm-push-notification-f55e4';
export const TOPIC_PATTERN = /^[a-zA-Z0-9_.~%\-]{1,900}$/;

export function createTopicService({ getToken = getAccessToken, request = fetch, env = process.env } = {}) {
  return async function topicRequest(action, data, retried = false) {
    if (!data || Array.isArray(data) || typeof data !== 'object' || Object.keys(data).some((key) => !['token', 'topic'].includes(key))) {
      throw new ApiError(400, 'Send only token and topic fields. OAuth credentials belong on the server.');
    }
    if (!['list', 'subscribe', 'unsubscribe'].includes(action)) throw new ApiError(404, 'Unknown topic action.');
    if (typeof data.token !== 'string' || !data.token.length || data.token.length > 4096 || /\s/.test(data.token)) throw new ApiError(400, 'A valid FCM registration token is required.');
    if (action !== 'list' && (typeof data.topic !== 'string' || !TOPIC_PATTERN.test(data.topic))) throw new ApiError(400, 'Invalid topic name. Use letters, digits, _, ., ~, %, or -. Omit /topics/.');
    const token = await getToken(retried);
    let url = `https://fcm.googleapis.com/v1/projects/${PROJECT_ID}/registrations/${encodeURIComponent(data.token)}/topicSubscriptions`;
    let method = 'GET';
    if (action === 'subscribe') { method = 'POST'; url += `?topic_name=${encodeURIComponent(data.topic)}`; }
    if (action === 'unsubscribe') { method = 'DELETE'; url += `/${encodeURIComponent(data.topic)}`; }
    let response;
    try {
      response = await request(url, {
        method, redirect: 'error', signal: AbortSignal.timeout(20_000),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(method === 'GET' ? {} : { body: '{}' }),
      });
    } catch {
      throw new ApiError(502, 'Cannot reach Firebase. Membership is unknown; refresh before retrying.');
    }
    if (response.status === 401 && !retried && !env.FCM_ACCESS_TOKEN?.trim()) return topicRequest(action, data, true);
    if (!(action === 'subscribe' && response.status === 409) && !response.ok) {
      const errors = {
        400: 'Firebase rejected the token/topic. Check the current receiver token.',
        401: 'Firebase rejected authentication. Clear a stale FCM_ACCESS_TOKEN or check the service-account key.',
        403: 'Firebase denied topic access. Grant Firebase Cloud Messaging API Admin (roles/firebasecloudmessaging.admin) to this service account in the target project.',
        404: 'Firebase registration or membership was not found. Refresh topics or obtain a current token.',
        429: 'Firebase rate limit reached. Wait before retrying.',
      };
      throw new ApiError(502, errors[response.status] || `Firebase topic request failed (HTTP ${response.status}).`);
    }
    if (action !== 'list') return { topic: data.topic, subscribed: action === 'subscribe' };
    try {
      const result = await response.json();
      if (!result || Array.isArray(result) || typeof result !== 'object') throw new Error();
      const rows = result.topicSubscriptions ?? result.topic_subscriptions ?? [];
      if (!Array.isArray(rows)) throw new Error();
      const topics = rows.map((row) => row?.topicName ?? row?.topic_name);
      if (topics.some((name) => typeof name !== 'string')) throw new Error();
      return { topics: [...new Set(topics)].sort() };
    } catch {
      throw new ApiError(502, 'Unexpected Firebase membership list. Refresh to verify.');
    }
  };
}

export const topicRequest = createTopicService();
