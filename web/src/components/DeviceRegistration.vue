<script setup>
import { useDeviceRegistration } from "../useDeviceRegistration.js";

const props = defineProps({ panel: { type: Object, required: true } });
const { fields, connection, connectionError, checking, checkConnection,
  notice, error, saving, save, unsubscribeQueue } = useDeviceRegistration(props.panel);
</script>

<template>
  <section class="device-registration" aria-label="Database registration">
    <div class="log-heading">
      <h3>Database registration</h3>
      <span class="connection" :class="connection === 'Connected' ? 'db-connected' : 'db-disconnected'"
        role="status">DB: {{ connection }}</span>
    </div>
    <div class="registration-fields">
      <label>Login ID
        <input v-model.lazy="fields.loginId" class="login-id" inputmode="numeric" autocomplete="off" placeholder="Login ID" />
      </label>
      <label>Customer ID
        <input v-model.lazy="fields.customerId" class="customer-id" inputmode="numeric" autocomplete="off" placeholder="Customer ID" />
      </label>
      <label>Organization ID
        <input v-model.lazy="fields.orgId" class="org-id" inputmode="numeric" autocomplete="off" placeholder="Organization ID" />
      </label>
    </div>
    <p class="topic-help">Fill all three IDs and leave the field to save automatically when a token is available. Leaving login or customer ID empty skips the database write.</p>
    <div class="actions">
      <button class="secondary" :disabled="checking" @click="checkConnection">Check DB connection</button>
      <button class="secondary" :disabled="saving || connection !== 'Connected' || (!unsubscribeQueue.length && (!fields.loginId.trim() || !fields.customerId.trim() || !fields.orgId.trim() || !panel.token || !panel.deviceId))" @click="save">{{ unsubscribeQueue.length ? 'Retry status update' : 'Save token' }}</button>
    </div>
    <p v-if="connectionError" class="error" role="status">{{ connectionError }}</p>
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
  </section>
</template>
