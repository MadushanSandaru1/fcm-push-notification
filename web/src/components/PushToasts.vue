<script setup>
import { onUnmounted, ref, watch } from "vue";
import { messageBody } from "../model.js";

const props = defineProps({ panels: { type: Array, required: true } });
const toasts = ref([]);
const timers = new Map();
const keyFor = (panel, message) => JSON.stringify([panel.number, message.id]);
const seen = new Set(props.panels.flatMap((panel) =>
  panel.messages.map((message) => keyFor(panel, message)),
));

function close(key) {
  clearTimeout(timers.get(key));
  timers.delete(key);
  toasts.value = toasts.value.filter((toast) => toast.key !== key);
}

watch(
  () => props.panels.flatMap((panel) => panel.messages.map((message) => ({
    key: keyFor(panel, message), app: panel.number, message,
  }))),
  (messages) => {
    for (const toast of messages) {
      if (seen.has(toast.key)) continue;
      seen.add(toast.key);
      toasts.value.push(toast);
      timers.set(toast.key, setTimeout(() => close(toast.key), 5000));
    }
  },
);

onUnmounted(() => {
  for (const timer of timers.values()) clearTimeout(timer);
});
</script>

<template>
  <section class="toast-stack" aria-label="Push notifications" aria-live="polite" aria-relevant="additions">
    <article v-for="toast in toasts" :key="toast.key" class="push-toast">
      <div class="toast-heading">
        <span class="message-meta">App {{ toast.app }} · {{ toast.message.mode }}</span>
        <button class="toast-close secondary" :aria-label="`Close notification: ${toast.message.title}`" @click="close(toast.key)">×</button>
      </div>
      <strong class="message-title">{{ toast.message.title }}</strong>
      <p class="message-body">{{ messageBody(toast.message.body) }}</p>
    </article>
  </section>
</template>
