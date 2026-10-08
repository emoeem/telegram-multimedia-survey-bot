import { describe, expect, it, vi } from "vitest";

import { createKVRateLimiter, createMemoryRateLimiter } from "../../../src/services/rate-limit.service";

function kv() {
  return {
    get: vi.fn(async () => null as string | null),
    put: vi.fn(async () => undefined),
  } as unknown as KVNamespace;
}

describe("public API rate limiter", () => {
  it("resets the in-memory window after expiry", async () => {
    vi.useFakeTimers();
    try {
      const limiter = createMemoryRateLimiter();
      await expect(limiter.allow("login|user@example.com", 2, 60)).resolves.toBe(true);
      await expect(limiter.allow("login|user@example.com", 2, 60)).resolves.toBe(true);
      await expect(limiter.allow("login|user@example.com", 2, 60)).resolves.toBe(false);

      vi.advanceTimersByTime(60_000);

      await expect(limiter.allow("login|user@example.com", 2, 60)).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails open when KV is unavailable", async () => {
    const cache = {
      get: vi.fn(async () => {
        throw new Error("KV unavailable");
      }),
      put: vi.fn(),
    } as unknown as KVNamespace;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await expect(createKVRateLimiter(cache).allow("login|user@example.com", 5, 3600)).resolves.toBe(true);
      expect(warn).toHaveBeenCalledWith(
        "Public API rate limiter unavailable; allowing request",
        expect.any(Error),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps scopes independent and hashes the subject in the KV key", async () => {
    const cache = kv();
    const limiter = createKVRateLimiter(cache);

    await expect(limiter.allow("register|user@example.com", 2, 3600)).resolves.toBe(true);
    await expect(limiter.allow("login|user@example.com", 2, 3600)).resolves.toBe(true);

    const keys = (cache.put as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[0]));
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^ratelimit:v1:register:[0-9a-f]{16}$/);
    expect(keys[1]).toMatch(/^ratelimit:v1:login:[0-9a-f]{16}$/);
    expect(keys[0]).not.toContain("user@example.com");
    expect(keys[1]).not.toContain("user@example.com");
    expect(cache.put).toHaveBeenNthCalledWith(1, keys[0], "1", { expirationTtl: 3600 });
  });

  it("does not increment after the limit is reached", async () => {
    const cache = {
      get: vi.fn(async () => "2"),
      put: vi.fn(),
    } as unknown as KVNamespace;

    await expect(createKVRateLimiter(cache).allow("answers|203.0.113.9", 2, 60)).resolves.toBe(false);
    expect(cache.put).not.toHaveBeenCalled();
  });
});
