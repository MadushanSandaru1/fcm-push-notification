import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { JWT } from "google-auth-library";
import { createTokenProvider, SCOPE } from "../server/auth.js";

const cleanup = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
});
async function keyFile(key = {}) {
  const root = await mkdtemp(resolve(tmpdir(), "fcm-auth-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const path = resolve(root, "fcm-service-account.json");
  await writeFile(
    path,
    JSON.stringify({
      type: "service_account",
      client_email: "test@example.invalid",
      private_key: "FAKE-TEST-KEY",
      ...key,
    }),
  );
  return { root, path };
}

describe("service-account authentication", () => {
  it("honors the manual override without reading keys or creating a client", async () => {
    const createClient = vi.fn();
    expect(
      await createTokenProvider({
        env: { FCM_ACCESS_TOKEN: "manual" },
        createClient,
      })(),
    ).toBe("manual");
    expect(createClient).not.toHaveBeenCalled();
    await expect(
      createTokenProvider({ env: { FCM_ACCESS_TOKEN: "bad token" } })(),
    ).rejects.toThrow("whitespace");
  });

  it("detects the root file, scopes the client and shares concurrent refreshes", async () => {
    const { root } = await keyFile();
    const getAccessToken = vi.fn(async () => {
      await new Promise((done) => setTimeout(done, 10));
      return { token: "server-token" };
    });
    const createClient = vi.fn(() => ({ credentials: {}, getAccessToken }));
    const getToken = createTokenProvider({ root, env: {}, createClient });
    expect(
      await Promise.all([getToken(), getToken(), getToken(), getToken()]),
    ).toEqual(Array(4).fill("server-token"));
    expect(getAccessToken).toHaveBeenCalledTimes(1);
    expect(createClient.mock.calls[0][0].scopes).toEqual([SCOPE]);
    expect(createClient.mock.calls[0][0].eagerRefreshThresholdMillis).toBe(
      300000,
    );
    expect(createClient.mock.calls[0][0].transporterOptions.timeout).toBe(
      10000,
    );
  });

  it("reloads rotated keys and does not fall back on invalid configuration", async () => {
    const { root, path } = await keyFile();
    const createClient = vi.fn(() => ({
      credentials: {},
      getAccessToken: async () => ({ token: "token" }),
    }));
    const getToken = createTokenProvider({ root, env: {}, createClient });
    await getToken();
    await writeFile(
      path,
      JSON.stringify({
        type: "service_account",
        client_email: "rotated@example.invalid",
        private_key: "NEW-FAKE-KEY",
      }),
    );
    await getToken();
    expect(createClient).toHaveBeenCalledTimes(2);
    await expect(
      createTokenProvider({
        root,
        env: { FCM_SERVICE_ACCOUNT_FILE: resolve(root, "missing.json") },
      })(),
    ).rejects.toThrow("Cannot read");
    await writeFile(path, "not-json PRIVATE-SECRET");
    await expect(getToken()).rejects.toThrow("Invalid service-account key");
  });

  it("sanitizes refresh failures and validates returned tokens", async () => {
    const { root } = await keyFile();
    const client = {
      credentials: {},
      getAccessToken: vi.fn(async () => {
        throw new Error("PRIVATE-KEY secret-email");
      }),
    };
    const getToken = createTokenProvider({
      root,
      env: {},
      createClient: () => client,
    });
    await expect(getToken()).rejects.toThrow("token refresh failed");
    expect(client.credentials.expiry_date).toBe(1);
    client.getAccessToken.mockResolvedValue({ token: "bad token" });
    await expect(getToken()).rejects.toThrow("token refresh failed");
  });

  it("uses real RSA signing and Google library cache/near-expiry/forced refresh without external traffic", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const { root } = await keyFile({
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
      token_uri: "https://untrusted.invalid",
    });
    let client;
    let exchanges = 0;
    const getToken = createTokenProvider({
      root,
      env: {},
      createClient(options) {
        client = new JWT(options);
        client.transporter.request = async (request) => {
          expect(String(request.url)).toBe(
            "https://oauth2.googleapis.com/token",
          );
          const fields = new URLSearchParams(request.data);
          expect(fields.get("grant_type")).toBe(
            "urn:ietf:params:oauth:grant-type:jwt-bearer",
          );
          const assertion = fields.get("assertion");
          const [head, body, signature] = assertion.split(".");
          expect(
            verify(
              "RSA-SHA256",
              Buffer.from(`${head}.${body}`),
              publicKey,
              Buffer.from(signature, "base64url"),
            ),
          ).toBe(true);
          const claims = JSON.parse(Buffer.from(body, "base64url").toString());
          expect(claims.scope).toBe(SCOPE);
          expect(claims.iss).toBe("test@example.invalid");
          exchanges++;
          return {
            data: {
              access_token: `fake-token-${exchanges}`,
              expires_in: 3600,
              token_type: "Bearer",
            },
            status: 200,
            headers: {},
            config: request,
          };
        };
        return client;
      },
    });
    expect(await getToken()).toBe("fake-token-1");
    expect(await getToken()).toBe("fake-token-1");
    expect(exchanges).toBe(1);
    client.credentials.expiry_date = Date.now() + 240000;
    expect(await getToken()).toBe("fake-token-2");
    expect(await getToken(true)).toBe("fake-token-3");
    expect(exchanges).toBe(3);
  });
});
