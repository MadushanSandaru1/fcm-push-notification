import pg from "pg";
import { ApiError } from "./errors.js";

export function createDeviceService({ env = process.env, pool: suppliedPool } = {}) {
  let pool = suppliedPool;
  function database() {
    if (!pool) {
      if (!env.DATABASE_URL && !(env.PGHOST && env.PGDATABASE && env.PGUSER))
        throw new Error("Database is not configured.");
      pool = new pg.Pool({
        ...(env.DATABASE_URL ? { connectionString: env.DATABASE_URL } : {
          host: env.PGHOST, database: env.PGDATABASE, user: env.PGUSER,
          password: env.PGPASSWORD, port: Number(env.PGPORT || 5432),
        }),
        max: 4,
        connectionTimeoutMillis: 5000,
        statement_timeout: 10000,
        query_timeout: 12000,
      });
      // Idle connection failures are reflected by the next health check.
      pool.on("error", () => {});
    }
    return pool;
  }

  return {
    async health() {
      try {
        await database().query("SELECT 1");
        return { connected: true, error: null };
      } catch {
        return { connected: false, error: "Database unavailable. Check server database configuration and connectivity." };
      }
    },
    async unsubscribe(data) {
      return this.register(data, { unsubscribe: true });
    },
    async register(data, { unsubscribe = false } = {}) {
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw new ApiError(400, "Invalid device registration.");
      // Empty IDs skip the entire write; never send NULL IDs to the procedure.
      if ([data.loginId, data.customerId].some((id) => id == null || String(id).trim() === ""))
        return { p_status: 0, p_error_message: "Enter both login ID and customer ID. Nothing was saved.", skipped: true };
      const ids = [data.loginId, data.customerId, data.orgId].map((id) => {
        const value = String(id ?? "").trim();
        const number = Number(value);
        if (!/^-?\d+$/.test(value) || !Number.isInteger(number) || number < -2147483648 || number > 2147483647)
          throw new ApiError(400, "Login, customer, and organization IDs must be PostgreSQL integers.");
        return number;
      });
      if (typeof data.deviceId !== "string" || !data.deviceId.trim() || data.deviceId.length > 200 ||
          (!unsubscribe && (typeof data.token !== "string" || !data.token.trim() || data.token.length > 12000)))
        throw new ApiError(400, "A device ID (up to 200 characters) and token are required.");

      let client;
      try {
        client = await database().connect();
        // Check the actual connection before attempting the procedure.
        await client.query("SELECT 1");
      } catch {
        client?.release(true);
        return { connected: false, p_status: 0, p_error_message: "Database unavailable. Nothing was saved." };
      }
      try {
        const result = await client.query(
          unsubscribe
            ? "CALL fin_user.prc_u37_unsubscribe($1::integer, $2::integer, $3::varchar, NULL, NULL)"
            : "CALL fin_user.prc_u37_insert($1::integer, $2::integer, $3::integer, $4::varchar, $5::text, NULL, NULL)",
          unsubscribe ? [ids[0], ids[2], data.deviceId] : [...ids, data.deviceId, data.token],
        );
        const row = result.rows[0];
        if (row?.p_status !== 0 && row?.p_status !== 1)
          throw new Error("Unexpected procedure result.");
        return { connected: true, p_status: row.p_status, p_error_message: row.p_status === 1 ? null : (row.p_error_message || "Device registration failed.") };
      } catch {
        return { p_status: 0, p_error_message: "Device registration failed. Check the procedure, permissions, and database connection." };
      } finally {
        client.release();
      }
    },
    async close() { await pool?.end(); },
  };
}
