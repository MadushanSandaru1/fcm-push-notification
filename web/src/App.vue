<script setup>
import { computed, onMounted, onUnmounted, reactive } from "vue";
import ReceiverPanel from "./components/ReceiverPanel.vue";
import PushToasts from "./components/PushToasts.vue";
import { DASHBOARD_ORIGIN, newPanel } from "./model.js";
import { createDashboardBridge } from "./dashboard.js";
import { useReceiver } from "./useReceiver.js";

const number = Number(location.port) - 6060;
const isReceiver =
  location.hostname === "localhost" &&
  location.protocol === "http:" &&
  number >= 1 &&
  number <= 4;
const isDashboard = location.origin === DASHBOARD_ORIGIN;
const panels = reactive((isReceiver ? [number] : [1, 2, 3, 4]).map(newPanel));
const receiver = isReceiver ? useReceiver(panels[0]) : null;
const ready = computed(() => receiver?.ready.value ?? false);
const busy = computed(() => receiver?.busy.value ?? false);
const bridge = !isReceiver ? createDashboardBridge({ panels }) : null;
let timer;

function open(panel) {
  if (!isDashboard) {
    panel.error = "Start pnpm dev and open http://localhost:6060.";
    return;
  }
  bridge.open(panel);
}

function snapshot(event) {
  bridge?.receive(event);
}

function topicAction(panel, action, topic) {
  if (receiver) return receiver.topicAction(action, topic);
  if (isDashboard && action === "unsubscribe")
    return bridge.unsubscribe(panel, topic);
}

onMounted(() => {
  if (receiver) {
    receiver.start();
    return;
  }
  window.addEventListener("message", snapshot);
  timer = setInterval(() => bridge.sync(), 2000);
});

onUnmounted(() => {
  receiver?.dispose();
  bridge?.dispose();
  clearInterval(timer);
  window.removeEventListener("message", snapshot);
});
</script>

<template>
  <PushToasts :panels="panels" />
  <header>
    <span class="eyebrow">FIREBASE CLOUD MESSAGING</span>
    <h1>
      Push Lab
      <span>/ {{ isReceiver ? `App ${number}` : "four receivers" }}</span>
    </h1>
    <p>Separate origins. Independent tokens. One place to watch delivery.</p>
  </header>
  <main>
    <aside v-if="!isReceiver && !isDashboard">
      Start <code>pnpm dev</code> and open
      <a :href="DASHBOARD_ORIGIN">the live dashboard</a>.
    </aside>
    <p id="hint">
      {{
        isReceiver
          ? "Click Subscribe here to obtain an FCM token. Keep this tab open to mirror foreground and background messages."
          : "Open receivers and subscribe there. Send directly to Firebase from Postman; keep receivers open for live updates."
      }}
    </p>
    <section
      class="grid"
      :class="{ receiver: isReceiver }"
      aria-label="Push receivers"
    >
      <ReceiverPanel
        v-for="panel in panels"
        :key="panel.number"
        :panel="panel"
        :receiver="isReceiver"
        :dashboard="isDashboard"
        :ready="ready"
        :busy="busy"
        @open="open(panel)"
        @subscribe="receiver?.subscribe()"
        @unsubscribe="receiver?.unsubscribe()"
        @topic="(action, topic) => topicAction(panel, action, topic)"
      />
    </section>
  </main>
  <footer>
    Vue 3 · Firebase SDK 13.4.0 · Postman sends directly to Firebase · No
    sending credentials in the browser
  </footer>
</template>
