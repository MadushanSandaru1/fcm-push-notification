import { readFile, stat, realpath } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JWT } from 'google-auth-library';
import { ApiError } from './errors.js';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

// One cache and refresh promise is shared by all four receiver origins.
export function createTokenProvider({ env = process.env, root = ROOT, createClient = (options) => new JWT(options) } = {}) {
  let cached;
  let pending;

  async function load(force) {
    const manual = env.FCM_ACCESS_TOKEN?.trim();
    if (manual) {
      if (/\s/.test(manual)) throw new ApiError(503, 'FCM_ACCESS_TOKEN contains invalid whitespace. Clear it to use service-account authentication.');
      return manual;
    }
    const configured = env.FCM_SERVICE_ACCOUNT_FILE?.trim() || env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
    let filename;
    let info;
    try {
      filename = await realpath(resolve(configured || resolve(root, 'fcm-service-account.json')));
      const inside = relative(root, filename);
      if (!inside.startsWith('..') && !isAbsolute(inside) && inside !== 'fcm-service-account.json') {
        throw new ApiError(503, 'Use fcm-service-account.json at the project root, or a key file outside the repository.');
      }
      info = await stat(filename);
      if (info.size > 65536 || !info.isFile()) throw new Error();
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, 'Cannot read service-account JSON. Save fcm-service-account.json at the project root or set FCM_SERVICE_ACCOUNT_FILE.');
    }
    const identity = `${filename}:${info.mtimeMs}:${info.size}`;
    if (cached?.identity !== identity) {
      cached = undefined;
      try {
        const key = JSON.parse((await readFile(filename, 'utf8')).replace(/^\uFEFF/, ''));
        if (key.type !== 'service_account' || !key.client_email || !key.private_key) throw new Error();
        const client = createClient({
          email: key.client_email,
          key: key.private_key,
          keyId: key.private_key_id,
          scopes: [SCOPE],
          eagerRefreshThresholdMillis: 300_000,
          transporterOptions: { timeout: 10_000, retry: false },
        });
        // Do not accept token URLs/universe domains from the key file.
        cached = { identity, client };
      } catch {
        throw new ApiError(503, 'Invalid service-account key. Use the downloaded Google JSON key; never put it in the frontend.');
      }
    }
    try {
      if (force) cached.client.credentials = { ...cached.client.credentials, access_token: undefined, expiry_date: 1 };
      const { token } = await cached.client.getAccessToken();
      if (typeof token !== 'string' || !token || /\s/.test(token)) throw new Error();
      return token;
    } catch {
      cached.client.credentials = { ...cached.client.credentials, access_token: undefined, expiry_date: 1 };
      throw new ApiError(503, 'Service-account token refresh failed. Check network access, system time and whether the key/account is enabled.');
    }
  }

  return async function getToken(force = false) {
    if (pending) {
      const result = await pending;
      if (!force) return result;
    }
    pending = load(force);
    try { return await pending; }
    finally { pending = undefined; }
  };
}

export const getAccessToken = createTokenProvider();
