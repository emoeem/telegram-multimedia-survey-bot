import { describe, expect, it } from "vitest";
import {
  ADMIN_LOGIN_COOKIE,
  ADMIN_LOGIN_REQUEST_TTL_SECONDS,
  approveAdminLoginRequest,
  cancelAdminLoginRequest,
  consumeAdminLoginRequest,
  createAdminLoginRequest,
  getAdminLoginRequest,
  verifyAdminLoginCookie,
} from "../../../src/services/admin-login.service";

const SECRET = "test-secret";
function store() {
  const values = new Map<string, string>();
  const cache = {
    get: async (key: string) => values.get(key) ?? null,
    put: async (key: string, value: string) => {
      values.set(key, value);
    },
  } as unknown as KVNamespace;
  return { values, cache };
}

describe("admin login request service", () => {
  it("creates a random, signed browser binding with a five-minute KV request", async () => {
    const { cache, values } = store();
    const first = await createAdminLoginRequest(cache, SECRET);
    const second = await createAdminLoginRequest(cache, SECRET);
    expect(first.id).toHaveLength(32);
    expect(first.id).not.toBe(second.id);
    expect(first.cookie).toContain(`${ADMIN_LOGIN_COOKIE}=`);
    const cookieValue = first.cookie.match(new RegExp(`${ADMIN_LOGIN_COOKIE}=([^;]+)`))?.[1] ?? "";
    expect(await verifyAdminLoginCookie(SECRET, cookieValue)).toBe(first.id);
    expect(values.get(`admin-login-request:${first.id}`)).toContain('"pending"');
    expect(ADMIN_LOGIN_REQUEST_TTL_SECONDS).toBe(300);
  });

  it("requires a pending request and records the approving Telegram user", async () => {
    const { cache } = store();
    const { id } = await createAdminLoginRequest(cache, SECRET);
    expect(await approveAdminLoginRequest(cache, id, 42)).toBe(true);
    expect(await getAdminLoginRequest(cache, id)).toMatchObject({ status: "approved", userId: 42 });
    expect(await approveAdminLoginRequest(cache, id, 99)).toBe(false);
  });

  it("supports cancellation and only the approved user can complete", async () => {
    const { cache } = store();
    const cancelled = await createAdminLoginRequest(cache, SECRET);
    expect(await cancelAdminLoginRequest(cache, cancelled.id)).toBe(true);
    expect(await cancelAdminLoginRequest(cache, cancelled.id)).toBe(false);

    const approved = await createAdminLoginRequest(cache, SECRET);
    await approveAdminLoginRequest(cache, approved.id, 42);
    const rows = new Set<string>();
    const db = {
      prepare: () => ({
        bind: (_id: string, _userId: number, _at: string) => ({
          run: async () => ({ meta: { changes: rows.has(approved.id) ? 0 : (rows.add(approved.id), 1) } }),
        }),
      }),
    } as unknown as D1Database;
    expect(await consumeAdminLoginRequest(db, cache, approved.id, 99)).toBe(false);
    expect(await consumeAdminLoginRequest(db, cache, approved.id, 42)).toBe(true);
    expect(await consumeAdminLoginRequest(db, cache, approved.id, 42)).toBe(false);
  });

  it("rejects a tampered or expired cookie", async () => {
    const { cache } = store();
    const { cookie } = await createAdminLoginRequest(cache, SECRET);
    const value = cookie.match(new RegExp(`${ADMIN_LOGIN_COOKIE}=([^;]+)`))?.[1] ?? "";
    expect(await verifyAdminLoginCookie("wrong-secret", value)).toBeNull();
    expect(await verifyAdminLoginCookie(SECRET, "bad.value")).toBeNull();
  });

  it("never asks KV for a TTL below its 60 second minimum", async () => {
    // Cloudflare KV rejects `expirationTtl` under 60 with
    // `KV PUT failed: 400 Invalid expiration_ttl`, which made the Telegram
    // login answer 500 the moment a login was redeemed — silently, because the
    // login page previously only offered the password form.
    const values = new Map<string, string>();
    const ttls: number[] = [];
    const cache = {
      get: async (key: string) => values.get(key) ?? null,
      put: async (key: string, value: string, options?: { expirationTtl?: number }) => {
        values.set(key, value);
        if (typeof options?.expirationTtl === "number") ttls.push(options.expirationTtl);
      },
    } as unknown as KVNamespace;
    const db = {
      prepare: () => ({ bind: () => ({ run: async () => ({ meta: { changes: 1 } }) }) }),
    } as unknown as D1Database;

    const { id } = await createAdminLoginRequest(cache, SECRET);
    await approveAdminLoginRequest(cache, id, 42);
    expect(await consumeAdminLoginRequest(db, cache, id, 42)).toBe(true);

    expect(ttls.length).toBeGreaterThan(0);
    for (const ttl of ttls) expect(ttl).toBeGreaterThanOrEqual(60);
  });
});
