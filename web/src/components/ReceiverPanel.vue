<script setup>
import { computed, ref } from "vue";
import { TOPIC_PATTERN } from "../model.js";
import DeviceRegistration from "./DeviceRegistration.vue";

const props = defineProps({
  panel: { type: Object, required: true },
  receiver: Boolean,
  dashboard: Boolean,
  ready: Boolean,
  busy: Boolean,
});
defineEmits(["open", "subscribe", "unsubscribe", "topic"]);
const topic = ref("general_announcements");
const tokenField = ref();
const notice = ref("");
const subscribed = computed(() => Boolean(props.panel.token));
const topicDisabled = computed(
  () =>
    !props.ready ||
    props.busy ||
    !props.panel.token ||
    props.panel.permission !== "granted",
);
const topicListDisabled = computed(() =>
  props.receiver
    ? topicDisabled.value
    : !props.dashboard ||
      props.panel.connection !== "Connected" ||
      !props.panel.ready ||
      props.panel.busy ||
      props.panel.commandPending ||
      !props.panel.token ||
      props.panel.permission !== "granted" ||
      !props.panel.topicsKnown,
);
const validTopic = computed(() => TOPIC_PATTERN.test(topic.value.trim()));
const topicSubscribed = computed(() =>
  props.panel.topics.includes(topic.value.trim()),
);
const topicStateUnknown = computed(
  () => !props.panel.topicsKnown || !validTopic.value,
);
const selectedTopicStatus = computed(() =>
  !validTopic.value
    ? "Enter a valid topic name."
    : !props.panel.topicsKnown
      ? "Refresh topics to check the selected topic."
      : topicSubscribed.value
        ? "Selected topic: subscribed."
        : "Selected topic: not subscribed.",
);
const topicSummary = computed(() =>
  !props.panel.token
    ? "Subscribe for an FCM token first."
    : props.panel.topicsKnown
      ? props.panel.topics.length
        ? `Subscribed topics (${props.panel.topics.length})`
        : "No topic memberships."
      : "Membership unknown — refresh topics in the receiver.",
);

async function copy() {
  try {
    await navigator.clipboard.writeText(props.panel.token);
    notice.value = "Token copied.";
  } catch {
    tokenField.value?.focus();
    tokenField.value?.select();
    notice.value = "Clipboard unavailable. Copy the selected token manually.";
  }
}

function timestamp(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown time" : date.toLocaleString();
}
</script>

<template>
  <article class="panel" :aria-label="`App ${panel.number}`">
    <div class="panel-heading">
      <h2>App {{ panel.number }}</h2>
      <span class="connection">{{ panel.connection }}</span>
    </div>
    <a
      class="receiver-url"
      :href="panel.url"
      @click="!receiver && ($event.preventDefault(), $emit('open'))"
      >{{ panel.url }}</a
    >
    <dl>
      <div>
        <dt>Browser permission</dt>
        <dd class="permission">{{ panel.permission }}</dd>
      </div>
      <div>
        <dt>FCM subscription</dt>
        <dd class="subscription">{{ panel.subscription }}</dd>
      </div>
    </dl>
    <div class="actions">
      <template v-if="receiver">
        <button
          :disabled="!ready || busy || subscribed"
          @click="$emit('subscribe')"
        >
          Subscribe
        </button>
        <button
          class="secondary"
          :disabled="!ready || busy || !subscribed"
          @click="$emit('unsubscribe')"
        >
          Unsubscribe
        </button>
      </template>
      <button v-else @click="$emit('open')">Open receiver ↗</button>
    </div>
    <label class="token-label"
      >FCM registration token
      <textarea
        ref="tokenField"
        class="token"
        :value="panel.token"
        rows="3"
        readonly
        placeholder="Subscribe in the receiver to get a token"
        spellcheck="false"
      />
    </label>
    <button class="secondary" :disabled="!panel.token" @click="copy">
      Copy token
    </button>
    <p v-if="panel.error" class="error" role="alert">{{ panel.error }}</p>
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>
    <DeviceRegistration :panel="panel" />
    <section aria-label="Topic subscriptions" class="topic-section">
      <div class="log-heading"><h3>Topic subscriptions</h3></div>
      <p class="topic-summary">{{ topicSummary }}</p>
      <ul
        v-if="panel.token && panel.topicsKnown && panel.topics.length"
        class="topic-list"
        aria-label="Subscribed topics"
      >
        <li v-for="subscribedTopic in panel.topics" :key="subscribedTopic">
          <span>{{ subscribedTopic }}</span>
          <button
            v-if="receiver || dashboard"
            class="secondary"
            :disabled="topicListDisabled"
            :aria-label="`Unsubscribe from ${subscribedTopic}`"
            @click="$emit('topic', 'unsubscribe', subscribedTopic)"
          >
            Unsubscribe
          </button>
        </li>
      </ul>
      <template v-if="receiver">
        <label
          >Topic name<input
            v-model="topic"
            class="topic-name"
            :disabled="topicDisabled"
            maxlength="900"
            autocomplete="off"
            spellcheck="false"
        /></label>
        <p class="topic-help" role="status" aria-live="polite">
          {{ selectedTopicStatus }}
        </p>
        <div class="actions">
          <button
            :disabled="topicDisabled || topicStateUnknown || topicSubscribed"
            @click="$emit('topic', 'subscribe', topic)"
          >
            Subscribe to topic
          </button>
          <button
            class="secondary"
            :disabled="topicDisabled || topicStateUnknown || !topicSubscribed"
            @click="$emit('topic', 'unsubscribe', topic)"
          >
            Unsubscribe from topic
          </button>
          <button
            class="secondary"
            :disabled="topicDisabled"
            @click="$emit('topic', 'list')"
          >
            Refresh topics
          </button>
        </div>
        <p class="topic-help">
          Topic actions use the local Node helper. Leaving a topic preserves
          your individual FCM token.
        </p>
      </template>
      <p v-if="panel.topicError" class="error" role="alert">
        {{ panel.topicError }}
      </p>
      <p
        v-if="panel.topicNotice"
        class="notice"
        role="status"
        aria-live="polite"
      >
        {{ panel.topicNotice }}
      </p>
    </section>
    <div class="log-heading">
      <h3>Received messages</h3>
      <span class="count">{{ panel.messages.length }}</span>
    </div>
    <ol class="messages" aria-live="polite">
      <li v-if="!panel.messages.length" class="empty">Waiting for a push…</li>
      <li v-for="message in [...panel.messages].reverse()" :key="message.id">
        <strong class="message-title">{{ message.title }}</strong>
        <p class="message-body">{{ message.body }}</p>
        <div class="message-meta">
          {{ timestamp(message.timestamp) }} · {{ message.mode }}
        </div>
      </li>
    </ol>
  </article>
</template>
