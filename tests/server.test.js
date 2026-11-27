import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createHandler } from "../server/index.js";
import { createTopicService } from "../server/topics.js";

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((close) => close()));
});

async function localServer(role = 6061, options = {}) {
  const server = http.createServer(createHandler({ port: role, ...options }));
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  cleanups.push(() => new Promise((done) => server.close(done)));
  return (path, { method = "GET", body, headers = {} } = {}) =>
    new Promise((done, fail) => {
      const raw =
        body === undefined
          ? undefined
          : typeof body === "string"
            ? body
            : JSON.stringify(body);
      const req = http.request(
        {
          host: "127.0.0.1",
          port: server.address().port,
          path,
          method,
          headers: {
            Host: `localhost:${role}`,
            ...(raw === undefined
              ? {}
              : {
                  "Content-Type": "application/json",
                  "Content-Length": Buffer.byteLength(raw),
                }),
            ...headers,
          },
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () =>
            done({
              status: res.statusCode,
              headers: res.headers,
              text: Buffer.concat(chunks).toString(),
            }),
          );
        },
      );
      req.on("error", fail);
      req.end(raw);
    });
}

describe("same-origin receiver API", () => {
  it("serves database status and registration on the dashboard and receivers with exact-origin protection", async () => {
    for (const role of [6060, 6061]) {
      const deviceService = {
        health: vi.fn(async () => ({ connected: true, error: null })),
        register: vi.fn(async () => ({ p_status: 0, p_error_message: "Procedure rejected registration" })),
        unsubscribe: vi.fn(async () => ({ p_status: 1, p_error_message: null })),
      };
      const request = await localServer(role, { deviceService });
      const headers = { Origin: `http://localhost:${role}` };
      const health = await request("/api/database/health", { method: "POST", body: {}, headers });
      expect(health.status).toBe(200);
      expect(JSON.parse(health.text).connected).toBe(true);
      const body = { loginId: "1", customerId: "2", orgId: "3", token: "token", deviceId: "device" };
      const result = await request("/api/devices/register", { method: "POST", body, headers });
      expect(JSON.parse(result.text)).toEqual({ p_status: 0, p_error_message: "Procedure rejected registration" });
      expect(deviceService.register).toHaveBeenCalledWith(body);
      const inactive = await request("/api/devices/unsubscribe", { method: "POST", body, headers });
      expect(JSON.parse(inactive.text)).toEqual({ p_status: 1, p_error_message: null });
      expect(deviceService.unsubscribe).toHaveBeenCalledWith(body);
      for (const path of ["/api/database/health", "/api/devices/register", "/api/devices/unsubscribe"]) {
        expect((await request(path, { method: "POST", body, headers: { Origin: "http://evil.example" } })).status).toBe(403);
        expect((await request(path, { method: "GET", headers })).status).toBe(405);
      }
      expect(deviceService.register).toHaveBeenCalledTimes(1);
      expect(deviceService.unsubscribe).toHaveBeenCalledTimes(1);
      expect(deviceService.health).toHaveBeenCalledTimes(1);
    }
  });

  it("forwards only exact receiver-origin requests and refuses browser OAuth input", async () => {
    const service = vi.fn(async () => ({ topics: ["general_announcements"] }));
    const request = await localServer(6061, { topicService: service });
    const good = await request("/api/topics/list", {
      method: "POST",
      body: { token: "receiver" },
      headers: { Origin: "http://localhost:6061" },
    });
    expect(good.status).toBe(200);
    expect(JSON.parse(good.text).topics).toEqual(["general_announcements"]);
    expect(good.headers["access-control-allow-origin"]).toBeUndefined();
    for (const headers of [
      {},
      { Origin: "null" },
      { Origin: "http://localhost:6062" },
      { Origin: "http://evil.example" },
      { Origin: "http://localhost:6061", Host: "evil.example:6061" },
    ]) {
      expect(
        (
          await request("/api/topics/list", {
            method: "POST",
            body: { token: "receiver" },
            headers,
          })
        ).status,
      ).toBe(403);
    }
    expect(service).toHaveBeenCalledTimes(1);
  });

  it("denies topic operations on dashboard and has no send/token endpoints", async () => {
    const request = await localServer(6060);
    expect(
      (
        await request("/api/topics/list", {
          method: "POST",
          body: {},
          headers: { Origin: "http://localhost:6060" },
        })
      ).status,
    ).toBe(403);
    for (const path of [
      "/api/push/send",
      "/api/send",
      "/api/token",
      "/api/auth/token",
    ]) {
      expect((await request(path, { method: "POST", body: {} })).status).toBe(
        404,
      );
    }
  });

  it("rejects malformed JSON, large bodies and incorrect content types", async () => {
    const service = vi.fn();
    const request = await localServer(6061, { topicService: service });
    const headers = { Origin: "http://localhost:6061" };
    expect(
      (
        await request("/api/topics/list", {
          method: "POST",
          body: "{",
          headers,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request("/api/topics/list", {
          method: "POST",
          body: "x".repeat(17000),
          headers,
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await request("/api/topics/list", {
          method: "POST",
          body: {},
          headers: { ...headers, "Content-Type": "text/plain" },
        })
      ).status,
    ).toBe(415);
    expect(service).not.toHaveBeenCalled();
  });
});

describe("production static serving", () => {
  it("serves built assets and worker with correct MIME, never credentials or source", async () => {
    const dist = await mkdtemp(resolve(tmpdir(), "fcm-static-"));
    cleanups.push(() => rm(dist, { recursive: true, force: true }));
    await mkdir(resolve(dist, "assets"));
    await writeFile(resolve(dist, "index.html"), "<h1>Test</h1>");
    await writeFile(resolve(dist, "firebase-messaging-sw.js"), "/* worker */");
    await writeFile(resolve(dist, "assets/main.js"), "/* bundle */");
    const request = await localServer(6060, { dist });
    const page = await request("/");
    expect(page.status).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.headers["cache-control"]).toBe("no-store");
    const worker = await request("/firebase-messaging-sw.js", {
      method: "HEAD",
    });
    expect(worker.status).toBe(200);
    expect(worker.headers["content-type"]).toContain("text/javascript");
    expect(worker.text).toBe("");
    expect((await request("/assets/main.js")).status).toBe(200);
    for (const path of [
      "/fcm-service-account.json",
      "/%66cm-service-account.json",
      "/fcm-service-account.json?download=1",
      "/.env",
      "/.git/config",
      "/server/auth.js",
      "/topics.py",
      "/@fs/D:/fcm-service-account.json",
      "/../README.md",
    ]) {
      expect((await request(path)).status, path).toBe(404);
    }
  });
});

describe("Firebase topic adapter", () => {
  const ok = (data = {}) => ({ ok: true, status: 200, json: async () => data });

  it("constructs list/subscribe/unsubscribe requests and keeps auth server-side", async () => {
    const request = vi.fn(async () =>
      ok({
        topicSubscriptions: [
          { topicName: "b" },
          { topicName: "a" },
          { topicName: "a" },
        ],
      }),
    );
    const service = createTopicService({
      request,
      getToken: async () => "oauth-secret",
    });
    expect(await service("list", { token: "registration:/token" })).toEqual({
      topics: ["a", "b"],
    });
    expect(request.mock.calls[0][0]).toContain(
      "registration%3A%2Ftoken/topicSubscriptions",
    );
    expect(request.mock.calls[0][1].headers.Authorization).toBe(
      "Bearer oauth-secret",
    );
    expect(request.mock.calls[0][1].redirect).toBe("error");
    expect(
      await service("subscribe", { token: "receiver", topic: "test" }),
    ).toEqual({ topic: "test", subscribed: true });
    expect(request.mock.lastCall[1].method).toBe("POST");
    expect(request.mock.lastCall[0]).toContain("?topic_name=test");
    await service("unsubscribe", { token: "receiver", topic: "test" });
    expect(request.mock.lastCall[1].method).toBe("DELETE");
    expect(request.mock.lastCall[0]).toMatch(/topicSubscriptions\/test$/);
  });

  it("supports snake_case responses too and rejects malformed provider lists", async () => {
    const request = vi.fn(async () =>
      ok({ topic_subscriptions: [{ topic_name: "test" }] }),
    );
    const service = createTopicService({
      request,
      getToken: async () => "secret",
    });
    expect(await service("list", { token: "t" })).toEqual({ topics: ["test"] });
    request.mockResolvedValue(ok({ topicSubscriptions: ["bad"] }));
    await expect(service("list", { token: "t" })).rejects.toThrow("Unexpected");
  });

  it("treats existing membership as confirmed and never claims unsubscribe on a 404", async () => {
    const request = vi.fn(async () => ({ ok: false, status: 409 }));
    const service = createTopicService({
      request,
      getToken: async () => "secret",
    });
    expect(
      (await service("subscribe", { token: "t", topic: "test" })).subscribed,
    ).toBe(true);
    request.mockResolvedValue({ ok: false, status: 404 });
    await expect(
      service("unsubscribe", { token: "t", topic: "test" }),
    ).rejects.toThrow("not found");
  });

  it("blocks invalid inputs before authentication/network", async () => {
    const getToken = vi.fn();
    const request = vi.fn();
    const service = createTopicService({ getToken, request });
    for (const data of [
      [],
      null,
      { token: "a", oauthToken: "secret" },
      { token: "" },
      { token: "bad token" },
      { token: "a", topic: "../bad" },
    ])
      await expect(service("subscribe", data)).rejects.toBeDefined();
    expect(getToken).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("forces one renewal on 401, never loops or retries manual tokens", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 401 })
      .mockResolvedValue(ok({}));
    const getToken = vi.fn(async () => "secret");
    const service = createTopicService({ request, getToken, env: {} });
    await service("list", { token: "t" });
    expect(getToken.mock.calls.map(([force]) => force)).toEqual([false, true]);
    request.mockReset().mockResolvedValue({ ok: false, status: 401 });
    await expect(service("list", { token: "t" })).rejects.toThrow(
      "authentication",
    );
    expect(request).toHaveBeenCalledTimes(2);
    request.mockClear();
    await expect(
      createTopicService({
        request,
        getToken,
        env: { FCM_ACCESS_TOKEN: "manual" },
      })("list", { token: "t" }),
    ).rejects.toThrow("authentication");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("returns sanitized network/IAM errors without leaking provider details", async () => {
    const request = vi.fn(async () => {
      throw new Error("private-token-url");
    });
    const service = createTopicService({
      request,
      getToken: async () => "secret",
    });
    await expect(service("list", { token: "t" })).rejects.toThrow(
      "Cannot reach",
    );
    request.mockResolvedValue({ ok: false, status: 403 });
    await expect(service("list", { token: "t" })).rejects.toThrow(
      "roles/firebasecloudmessaging.admin",
    );
  });
});
