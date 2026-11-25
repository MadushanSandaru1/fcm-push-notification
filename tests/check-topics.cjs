const assert = require("node:assert/strict");
const { browser, settle } = require("./browser-harness.cjs");

(async () => {
  const receiver = browser();
  await settle();
  assert.equal(receiver.counts().getCalls, 0);
  assert.equal(receiver.counts().mutations, 0);
  assert.match(receiver.node(".topic-summary").textContent, /No topic/);
  await receiver.node(".topic-subscribe").listeners.click();
  assert.deepEqual([...receiver.memberships], ["general_announcements"]);
  assert.match(receiver.node(".topic-summary").textContent, /Confirmed topics: general_announcements/);
  assert.equal(receiver.node(".token").value, "existing-token");
  await receiver.node(".topic-unsubscribe").listeners.click();
  assert.equal(receiver.memberships.size, 0);
  assert.equal(receiver.counts().deleteCalls, 0);
  assert.equal(receiver.node(".token").value, "existing-token");
  console.log("PASS: actual helper calls, confirmed topic states, topic opt-out preserves individual token");

  receiver.node(".topic-name").value = "../invalid";
  const before = receiver.requests.length;
  await receiver.node(".topic-subscribe").listeners.click();
  assert.equal(receiver.requests.length, before);
  receiver.node(".topic-name").value = "general_announcements";
  receiver.setFail(true);
  await receiver.node(".topic-subscribe").listeners.click();
  assert.match(receiver.node(".topic-summary").textContent, /unknown/);
  assert.match(receiver.node(".topic-error").textContent, /unavailable/);
  assert.equal(receiver.node(".topic-notice").textContent, "");
  assert.equal(receiver.node(".token").value, "existing-token");
  receiver.setFail(false);
  await receiver.node(".topic-refresh").listeners.click();
  assert.match(receiver.node(".topic-summary").textContent, /No topic/);
  console.log("PASS: invalid names blocked; failed requests never claim success; refresh recovers");

  receiver.setFailList(true);
  await receiver.node(".topic-subscribe").listeners.click();
  assert.equal(receiver.memberships.has("general_announcements"), true);
  assert.match(receiver.node(".topic-notice").textContent, /Subscribed to general_announcements/);
  assert.match(receiver.node(".topic-summary").textContent, /unknown/);
  assert.match(receiver.node(".topic-error").textContent, /unavailable/);
  receiver.setFailList(false);
  await receiver.node(".topic-refresh").listeners.click();
  assert.match(receiver.node(".topic-summary").textContent, /Confirmed topics/);
  console.log("PASS: successful mutation remains acknowledged if subsequent membership refresh fails");

  await receiver.node(".unsubscribe").listeners.click();
  assert.equal(receiver.counts().deleteCalls, 1);
  assert.equal(receiver.node(".token").value, "");
  assert.equal(receiver.node(".topic-subscribe").disabled, true);
  const optedOut = browser({ savedToken: "" });
  await settle();
  assert.equal(optedOut.requests.length, 0);
  assert.equal(optedOut.counts().getCalls, 0);
  console.log("PASS: full unsubscribe clears topic state; no automatic subscription or topic mutation on load");

  const dashboard = browser({ dashboard: true });
  assert.equal(dashboard.dom["#panels"].children.length, 4);
  dashboard.node(".open").listeners.click();
  const data = { channel: "fcm-push-lab-v1", type: "snapshot", app: 1, state: { permission: "granted", subscription: "Subscribed", token: "t", topics: ["<script>test</script>"], topicsKnown: true }, messages: [] };
  dashboard.listeners.message({ origin: "http://localhost:8082", source: dashboard.child, data });
  assert.equal(dashboard.node(".token").value, "");
  dashboard.listeners.message({ origin: "http://localhost:8081", source: {}, data });
  assert.equal(dashboard.node(".token").value, "");
  dashboard.listeners.message({ origin: "http://localhost:8081", source: dashboard.child, data });
  assert.equal(dashboard.node(".topic-summary").textContent, "Confirmed topics: <script>test</script>");
  assert.equal(dashboard.node(".token", 1).value, "");
  console.log("PASS: topic status safely mirrored only to matching dashboard panel with exact origin/window checks");
})().catch((error) => { console.error(error); process.exitCode = 1; });
