import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import vm from "node:vm";
import { ROOT } from "../server/auth.js";

describe("Firebase worker and Postman artifacts", () => {
  it("forwards background messages, showing a notification only for data-only payloads", async () => {
    let receive;
    const notifications = [];
    const messages = [];
    vm.runInNewContext(
      await readFile(
        resolve(ROOT, "web/public/firebase-messaging-sw.js"),
        "utf8",
      ),
      {
        URL,
        Date,
        importScripts() {},
        FCM_DEMO: { firebaseConfig: {} },
        firebase: {
          initializeApp() {},
          messaging: () => ({
            onBackgroundMessage(fn) {
              receive = fn;
            },
          }),
        },
        self: {
          location: { origin: "http://localhost:6061" },
          registration: {
            showNotification: async (title, data) =>
              notifications.push({ title, ...data }),
          },
          clients: {
            matchAll: async () => [
              {
                url: "http://localhost:6061/",
                postMessage: (message) => messages.push(message),
              },
              {
                url: "http://localhost:6062/",
                postMessage() {
                  throw new Error("Wrong origin");
                },
              },
            ],
          },
        },
      },
    );
    await receive({ notification: { title: "Notification", body: "Body" } });
    expect(notifications).toHaveLength(0);
    expect(messages).toHaveLength(1);
    await receive({ data: { title: "Data", body: "Body" } });
    expect(notifications).toHaveLength(1);
    expect(notifications[0].title).toBe("Data");
    expect(messages).toHaveLength(2);
  });

  it("keeps every send directly on Firebase with empty credential placeholders", async () => {
    const collection = JSON.parse(
      await readFile(
        resolve(ROOT, "postman/FCM-Push-Lab.postman_collection.json"),
        "utf8",
      ),
    );
    const environment = JSON.parse(
      await readFile(
        resolve(ROOT, "postman/FCM-Push-Lab.postman_environment.json"),
        "utf8",
      ),
    );
    expect(collection.item).toHaveLength(4);
    const cases = new Set();
    for (const item of collection.item) {
      const request = item.request;
      expect(request.url).toBe(
        "https://fcm.googleapis.com/v1/projects/fcm-push-notification-f55e4/messages:send",
      );
      expect(request.auth.type).toBe("bearer");
      const body = JSON.parse(request.body.raw);
      cases.add(
        `${"token" in body.message ? "token" : "topic"}:${body.validate_only}`,
      );
    }
    expect(cases.size).toBe(4);
    expect(
      environment.values.find((item) => item.key === "google_access_token")
        .value,
    ).toBe("");
    expect(
      environment.values.find((item) => item.key === "receiver_token").value,
    ).toBe("");
  });

  it("preserves the required gstatic SDK and root-scoped classic worker in built output", async () => {
    const worker = await readFile(
      resolve(ROOT, "web/public/firebase-messaging-sw.js"),
      "utf8",
    );
    expect(worker).toContain(
      "https://www.gstatic.com/firebasejs/13.4.0/firebase-app-compat.js",
    );
    expect(worker).toContain(
      "https://www.gstatic.com/firebasejs/13.4.0/firebase-messaging-compat.js",
    );
    const adapter = await readFile(
      resolve(ROOT, "web/src/firebase.js"),
      "utf8",
    );
    expect(adapter).toContain(
      "https://www.gstatic.com/firebasejs/13.4.0/firebase-messaging.js",
    );
    expect(adapter).toMatch(
      /register\(\s*["']\/firebase-messaging-sw\.js["'],\s*\{\s*scope:\s*["']\/["']\s*\},?\s*\)/,
    );
  });
});
