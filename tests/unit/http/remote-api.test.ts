import { describe, expect, it, vi } from "vitest";

import { handleRemoteApiRequest } from "../../../src/http/remote-api";
import { signRemoteAccessToken } from "../../../src/services/remote-access-token.service";

const SECRET = "remote-access-secret-for-tests";
const INSTALLATION = "install-5628d80b64e094664e388e36";
const CENTER = "https://telegram-multimedia-survey-bot.pd2335346.workers.dev";
const BASE = "https://survey-customer-f4a560c5.pd2335346.workers.dev";

/** Minimal D1 stub: `first` returns the queued row, `all` an empty set. */
function makeDb(first: unknown = null) {
  const statement = {
    bind: vi.fn(() => statement),
    first: vi.fn(async () => first),
    all: vi.fn(async () => ({ results: [], success: true, meta: {} })),
    run: vi.fn(async () => ({ success: true, meta: {} })),
  };
  return { prepare: vi.fn(() => statement) } as unknown as D1Database;
}

function env(db: D1Database = makeDb()) {
  return {
    DB: db,
    INSTALLATION_ID: INSTALLATION,
    REMOTE_ACCESS_SECRET: SECRET,
    LICENSE_SERVER_URL: CENTER,
  };
}

function request(path: string, init: RequestInit = {}) {
  return new Request(`${BASE}${path}`, init);
}

async function bearer(ttlSeconds = 300) {
  const { token } = await signRemoteAccessToken(SECRET, { installationId: INSTALLATION, ttlSeconds });
  return `Bearer ${token}`;
}

describe("remote read-only API", () => {
  it("ignores paths outside /api/remote/", async () => {
    await expect(handleRemoteApiRequest(request("/api/admin/surveys"), env())).resolves.toBeNull();
    await expect(handleRemoteApiRequest(request("/api/remotely/other"), env())).resolves.toBeNull();
  });

  it("rejects a request with no token", async () => {
    const response = await handleRemoteApiRequest(request("/api/remote/summary"), env());
    expect(response?.status).toBe(401);
  });

  it("rejects a token signed with the wrong secret", async () => {
    const { token } = await signRemoteAccessToken("a-different-secret", { installationId: INSTALLATION });
    const response = await handleRemoteApiRequest(
      request("/api/remote/summary", { headers: { Authorization: `Bearer ${token}` } }),
      env(),
    );
    expect(response?.status).toBe(401);
  });

  it("rejects an expired token", async () => {
    const token = await bearer(30);
    // Freeze time past the 30s TTL.
    const spy = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    try {
      const response = await handleRemoteApiRequest(
        request("/api/remote/summary", { headers: { Authorization: `Bearer ${token}` } }),
        env(),
      );
      expect(response?.status).toBe(401);
    } finally {
      spy.mockRestore();
    }
  });

  it("fails closed when the instance has no shared secret configured", async () => {
    // `exactOptionalPropertyTypes` forbids assigning undefined, so drop the key.
    const { REMOTE_ACCESS_SECRET: _unused, ...withoutSecret } = env();
    const response = await handleRemoteApiRequest(
      request("/api/remote/summary", { headers: { Authorization: await bearer() } }),
      withoutSecret,
    );
    expect(response?.status).toBe(401);
  });

  it("refuses anything but GET", async () => {
    const response = await handleRemoteApiRequest(
      request("/api/remote/summary", { method: "POST", headers: { Authorization: await bearer() } }),
      env(),
    );
    expect(response?.status).toBe(405);
  });

  it("answers the CORS preflight without requiring a token", async () => {
    const response = await handleRemoteApiRequest(
      request("/api/remote/summary", { method: "OPTIONS", headers: { Origin: CENTER } }),
      env(),
    );
    expect(response?.status).toBe(204);
    expect(response?.headers.get("Access-Control-Allow-Origin")).toBe(CENTER);
  });

  it("never reflects an origin other than the authorization center", async () => {
    const response = await handleRemoteApiRequest(
      request("/api/remote/summary", {
        method: "OPTIONS",
        headers: { Origin: "https://evil.example.com" },
      }),
      env(),
    );
    expect(response?.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("serves data for a valid token and marks it no-store", async () => {
    const db = makeDb({ surveys: 3, responses: 9, completed: 7, users: 4 });
    const response = await handleRemoteApiRequest(
      request("/api/remote/summary", { headers: { Authorization: await bearer(), Origin: CENTER } }),
      env(db),
    );

    expect(response?.status).toBe(200);
    expect(response?.headers.get("Cache-Control")).toBe("no-store");
    expect(response?.headers.get("Access-Control-Allow-Origin")).toBe(CENTER);
    await expect(response?.json()).resolves.toEqual({
      ok: true,
      summary: { surveys: 3, responses: 9, completed: 7, users: 4 },
    });
  });
});
