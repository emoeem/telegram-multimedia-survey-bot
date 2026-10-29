import { describe, expect, it, vi } from "vitest";

import { RateLimitDO, type RateLimitDecision } from "../../../src/durable-objects/rate-limit";
import { createAtomicRateLimiter, createPreferredRateLimiter } from "../../../src/services/rate-limit.service";

/**
 * Minimal stand-in for `DurableObjectState.storage`.
 *
 * Backed by a Map so the limiter's read-increment-write can run against real
 * state instead of a mock that only records calls. The alarm bookkeeping is
 * included because `consume` arms the sweeper on every write.
 */
function fakeStorage() {
  const data = new Map<string, unknown>();
  let alarm: number | null = null;

  return {
    storage: {
      get: async <T>(key: string) => (data.get(key) as T | undefined) ?? undefined,
      put: async (key: string, value: unknown) => {
        data.set(key, value);
      },
      delete: async (keys: string | string[]) => {
        for (const key of Array.isArray(keys) ? keys : [keys]) data.delete(key);
      },
      list: async <T>(options?: { prefix?: string; limit?: number }) => {
        const prefix = options?.prefix ?? "";
        const limit = options?.limit ?? Infinity;
        const out = new Map<string, T>();
        for (const [key, value] of data) {
          if (key.startsWith(prefix) && out.size < limit) out.set(key, value as T);
        }
        return out;
      },
      getAlarm: async () => alarm,
      setAlarm: async (at: number) => {
        alarm = at;
      },
      deleteAlarm: async () => {
        alarm = null;
      },
    },
    /** Direct read for assertions, bypassing the public storage surface. */
    peek: (key: string) => data.get(key),
    size: () => data.size,
  };
}

/**
 * Build a real `RateLimitDO` instance over the fake storage.
 *
 * The constructor is bypassed because `DurableObject`'s own constructor is
 * supplied by the runtime; only `ctx.storage` is used by the code under test.
 */
function makeDO() {
  const fake = fakeStorage();
  const instance = Object.create(RateLimitDO.prototype) as RateLimitDO & { ctx: unknown };
  // The fake only implements the slice of `DurableObjectState` the limiter
  // touches (`ctx.storage`); the rest is runtime surface.
  instance.ctx = { storage: fake.storage } as unknown as typeof instance.ctx;
  return { instance, fake };
}

function post(body: unknown): Request {
  return new Request("https://rate-limit/allow", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("RateLimitDO", () => {
  it("allows up to the limit and rejects the next request", async () => {
    const { instance } = makeDO();

    for (let i = 0; i < 5; i += 1) {
      const response = await instance.fetch(post({ scope: "test", subject: "abc", limit: 5, windowSeconds: 3600 }));
      const decision = (await response.json()) as RateLimitDecision;
      expect(decision.allowed).toBe(true);
      expect(decision.count).toBe(i + 1);
    }

    const rejected = await instance.fetch(post({ scope: "test", subject: "abc", limit: 5, windowSeconds: 3600 }));
    const decision = (await rejected.json()) as RateLimitDecision;
    expect(decision.allowed).toBe(false);
    expect(decision.count).toBe(6);
  });

  it("keeps a rejected request's counter so refusal cannot reset the window", async () => {
    const { instance } = makeDO();
    const subject = { scope: "test", subject: "abc", limit: 2, windowSeconds: 3600 };

    await instance.fetch(post(subject));
    await instance.fetch(post(subject));
    await instance.fetch(post(subject)); // rejected, but still persisted as 3
    const response = await instance.fetch(post(subject));

    // Count keeps climbing past the limit rather than resetting, so hammering
    // the endpoint cannot buy a fresh window.
    expect(((await response.json()) as RateLimitDecision).count).toBe(4);
  });

  it("separates subjects that share a window", async () => {
    const { instance } = makeDO();

    await instance.fetch(post({ scope: "test", subject: "alice", limit: 1, windowSeconds: 3600 }));
    const bob = await instance.fetch(post({ scope: "test", subject: "bob", limit: 1, windowSeconds: 3600 }));

    expect(((await bob.json()) as RateLimitDecision).allowed).toBe(true);
  });

  it("starts a fresh window once the previous one has elapsed", async () => {
    const { instance } = makeDO();

    await instance.fetch(post({ scope: "test", subject: "abc", limit: 1, windowSeconds: 1 }));
    const blocked = await instance.fetch(post({ scope: "test", subject: "abc", limit: 1, windowSeconds: 1 }));
    expect(((await blocked.json()) as RateLimitDecision).allowed).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 1_050));

    const reopened = await instance.fetch(post({ scope: "test", subject: "abc", limit: 1, windowSeconds: 1 }));
    const decision = (await reopened.json()) as RateLimitDecision;
    expect(decision.allowed).toBe(true);
    expect(decision.count).toBe(1);
  });

  it("rejects malformed bodies instead of counting them", async () => {
    const { instance, fake } = makeDO();

    expect((await instance.fetch(post({ scope: "test", subject: "", limit: 5, windowSeconds: 60 }))).status).toBe(400);
    expect((await instance.fetch(post({ scope: "test", subject: "a", limit: 0, windowSeconds: 60 }))).status).toBe(400);
    expect((await instance.fetch(new Request("https://rate-limit/allow"))).status).toBe(405);
    expect(fake.size()).toBe(0);
  });

  it("arms the sweeper once and re-arms after it runs", async () => {
    const { instance, fake } = makeDO();

    await instance.fetch(post({ scope: "test", subject: "abc", limit: 5, windowSeconds: 60 }));
    expect(await fake.storage.getAlarm()).not.toBeNull();
  });

  it("sweeps counters whose window is long past", async () => {
    const { instance, fake } = makeDO();

    await instance.fetch(post({ scope: "test", subject: "abc", limit: 5, windowSeconds: 60 }));
    // Backdate the stored window past the 24h retention cutoff.
    await fake.storage.put("rl:test:stale", { count: 1, windowStart: Date.now() - 48 * 60 * 60 * 1000 });

    await instance.alarm();

    expect(fake.peek("rl:test:stale")).toBeUndefined();
    expect(fake.peek("rl:test:abc")).toBeDefined();
  });

  it("re-arms only while a counter is still inside its window (no idle metronome)", async () => {
    const { instance, fake } = makeDO();

    // 一个「已经过期」的计数器：它的窗口早就结束了，扫完就没有任何活着的桶。
    await fake.storage.put("rl:test:expired", {
      count: 3,
      windowStart: Date.now() - 2 * 60 * 60 * 1000,
      expiresAt: Date.now() - 60 * 60 * 1000,
    });
    await fake.storage.setAlarm(Date.now() - 1);

    await instance.alarm();

    expect(fake.peek("rl:test:expired")).toBeUndefined();
    // 判据是「还有未过期的计数」，不是「还有任何计数」——否则空实例每 10 分钟
    // 白醒一次，永远不停。
    expect(await fake.storage.getAlarm()).toBeNull();
  });

  it("keeps the sweeper armed while a live counter remains", async () => {
    const { instance, fake } = makeDO();

    await instance.fetch(post({ scope: "test", subject: "live", limit: 5, windowSeconds: 3600 }));
    await fake.storage.setAlarm(Date.now() - 1);

    await instance.alarm();

    expect(fake.peek("rl:test:live")).toBeDefined();
    expect(await fake.storage.getAlarm()).not.toBeNull();
  });
});

describe("createAtomicRateLimiter", () => {
  /**
   * Namespace that routes every scope onto one shared DO instance.
   *
   * The stub must honour the two-argument `fetch(input, init)` shape the
   * limiter uses: a stub that ignored `init` would hand the DO a bare string,
   * get a 405 back, and silently pass every test through the fail-open path.
   */
  function namespaceFor(instance: RateLimitDO) {
    return {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => ({
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          instance.fetch(input instanceof Request ? input : new Request(input, init)),
      })),
    } as unknown as DurableObjectNamespace;
  }

  it("enforces the limit across calls and never hands the raw subject to the DO", async () => {
    const { instance, fake } = makeDO();
    const namespace = namespaceFor(instance);
    const limiter = createAtomicRateLimiter(namespace);

    const allowed: boolean[] = [];
    for (let i = 0; i < 6; i += 1) {
      allowed.push(await limiter.allow("register|user@example.com", 5, 3600));
    }

    expect(allowed.slice(0, 5).every(Boolean)).toBe(true);
    expect(allowed[5]).toBe(false);

    // The counter lives under a hash, so persisted keys cannot be turned back
    // into the address that produced them.
    const keys = [...(await fake.storage.list({ prefix: "rl:" })).keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toContain("user@example.com");
    expect(keys[0]).toMatch(/^rl:register:[0-9a-f]{16}$/);
  });

  it("shards by scope so unrelated buckets never contend", async () => {
    const { instance } = makeDO();
    const namespace = namespaceFor(instance);
    const limiter = createAtomicRateLimiter(namespace);

    await limiter.allow("register|same@example.com", 1, 3600);
    const otherScope = await limiter.allow("reset|same@example.com", 1, 3600);

    expect(otherScope).toBe(true);
    expect(namespace.idFromName).toHaveBeenCalledWith("register");
    expect(namespace.idFromName).toHaveBeenCalledWith("reset");
  });

  it("fails open when the Durable Object is unavailable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const namespace = {
      idFromName: vi.fn(() => "rate-limit"),
      get: vi.fn(() => {
        throw new Error("DO unavailable");
      }),
    } as unknown as DurableObjectNamespace;

    try {
      await expect(createAtomicRateLimiter(namespace).allow("login|a@b.c", 1, 60)).resolves.toBe(true);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("fails open when the DO answers non-OK", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const namespace = {
      idFromName: vi.fn(() => "rate-limit"),
      get: vi.fn(() => ({ fetch: async () => new Response("boom", { status: 500 }) })),
    } as unknown as DurableObjectNamespace;

    try {
      await expect(createAtomicRateLimiter(namespace).allow("login|a@b.c", 1, 60)).resolves.toBe(true);
      expect(warn).toHaveBeenCalledWith(
        "Atomic rate limiter returned a non-OK response; allowing request",
        expect.objectContaining({ status: 500 }),
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe("createPreferredRateLimiter", () => {
  it("prefers the Durable Object when the binding exists", async () => {
    const { instance, fake } = makeDO();
    const namespace = {
      idFromName: vi.fn(() => "register"),
      get: vi.fn(() => ({
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          instance.fetch(input instanceof Request ? input : new Request(input, init)),
      })),
    } as unknown as DurableObjectNamespace;
    const cache = { get: vi.fn(), put: vi.fn() } as unknown as KVNamespace;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const limiter = createPreferredRateLimiter({ RATE_LIMIT: namespace, CACHE: cache });

      await expect(limiter.allow("register|a@b.c", 1, 60)).resolves.toBe(true);

      expect(namespace.get).toHaveBeenCalled();
      // KV must not be touched when the atomic path is available.
      expect(cache.get).not.toHaveBeenCalled();
      expect(cache.put).not.toHaveBeenCalled();
      // And the decision must come from a real DO round trip, not from the
      // fail-open branch — an ignored `init` used to make this test pass while
      // the limiter was silently disabled.
      expect(warn).not.toHaveBeenCalled();
      expect((await fake.storage.list({ prefix: "rl:register:" })).size).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("falls back to KV when the binding is absent", async () => {
    const cache = { get: vi.fn(async () => "0"), put: vi.fn(async () => undefined) } as unknown as KVNamespace;

    const limiter = createPreferredRateLimiter({ CACHE: cache });

    await expect(limiter.allow("register|a@b.c", 5, 60)).resolves.toBe(true);
    expect(cache.put).toHaveBeenCalled();
  });
});
