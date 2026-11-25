import { describe, expect, it, vi } from "vitest";
import { createDeviceService } from "../server/devices.js";

const input = { loginId: "12", customerId: "34", orgId: "56", deviceId: "browser-device", token: "fcm-token" };
function setup(row = { p_status: 1, p_error_message: null }) {
  const client = { query: vi.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValue({ rows: [row] }), release: vi.fn() };
  const pool = { connect: vi.fn(async () => client), query: vi.fn(async () => ({})), end: vi.fn() };
  return { client, pool, service: createDeviceService({ pool }) };
}

describe("PostgreSQL device registration", () => {
  it("calls the unsubscribe procedure without requiring a token", async () => {
    const { service, client } = setup();
    expect(await service.unsubscribe({ ...input, token: undefined })).toMatchObject({ p_status: 1 });
    expect(client.query.mock.calls[1]).toEqual([
      "CALL fin_user.prc_u37_unsubscribe($1::integer, $2::integer, $3::varchar, NULL, NULL)",
      [12, 56, "browser-device"],
    ]);
  });

  it("does not attempt deactivation when connectivity fails or IDs are empty", async () => {
    const { service, client, pool } = setup();
    expect(await service.unsubscribe({ ...input, customerId: "" })).toMatchObject({ skipped: true });
    expect(pool.connect).not.toHaveBeenCalled();
    client.query.mockReset().mockRejectedValue(new Error("offline"));
    expect(await service.unsubscribe(input)).toMatchObject({ p_status: 0, connected: false });
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it("checks connectivity then calls the procedure with bound inputs and reads its OUT values", async () => {
    const { service, client } = setup();
    expect(await service.register(input)).toEqual({ connected: true, p_status: 1, p_error_message: null });
    expect(client.query.mock.calls[0]).toEqual(["SELECT 1"]);
    expect(client.query.mock.calls[1]).toEqual([
      "CALL fin_user.prc_u37_insert($1::integer, $2::integer, $3::integer, $4::varchar, $5::text, NULL, NULL)",
      [12, 34, 56, "browser-device", "fcm-token"],
    ]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it.each([{ loginId: "" }, { customerId: "  " }, { loginId: null }, { customerId: undefined }])("skips all database activity for an empty ID: %j", async (change) => {
    const { service, pool } = setup();
    expect(await service.register({ ...input, ...change })).toMatchObject({ p_status: 0, skipped: true });
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it.each([{ loginId: "1.5" }, { orgId: "" }, { customerId: "2147483648" }, { deviceId: "" }, { token: "" }])("rejects invalid inputs before connecting: %j", async (change) => {
    const { service, pool } = setup();
    await expect(service.register({ ...input, ...change })).rejects.toBeDefined();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("does not CALL after a failed connection check", async () => {
    const { service, client } = setup();
    client.query.mockReset().mockRejectedValue(new Error("connection lost"));
    expect(await service.register(input)).toMatchObject({ connected: false, p_status: 0 });
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledWith(true);
  });

  it("reports a connection failure without trying the procedure", async () => {
    const { service, pool, client } = setup();
    pool.connect.mockRejectedValue(new Error("private password"));
    const result = await service.register(input);
    expect(result).toMatchObject({ connected: false, p_status: 0 });
    expect(JSON.stringify(result)).not.toContain("private password");
    expect(client.query).not.toHaveBeenCalled();
  });

  it("preserves a status 0 procedure error and releases the connection", async () => {
    const { service, client } = setup({ p_status: 0, p_error_message: "No notification type found for organization 56" });
    expect(await service.register(input)).toMatchObject({ p_status: 0, p_error_message: "No notification type found for organization 56" });
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("handles SQL failures and invalid OUT results as failures", async () => {
    const { service, client } = setup({});
    expect(await service.register(input)).toMatchObject({ p_status: 0 });
    client.query.mockRejectedValueOnce(new Error("offline"));
    expect(await service.register(input)).toMatchObject({ p_status: 0, connected: false });
    expect(client.release).toHaveBeenCalledTimes(2);
  });

  it("reports unconfigured or unavailable database health without exposing credentials", async () => {
    expect(await createDeviceService({ env: {} }).health()).toMatchObject({ connected: false });
    const { service, pool } = setup();
    expect(await service.health()).toEqual({ connected: true, error: null });
    pool.query.mockRejectedValue(new Error("private connection string"));
    expect(await service.health()).toMatchObject({ connected: false });
  });
});
