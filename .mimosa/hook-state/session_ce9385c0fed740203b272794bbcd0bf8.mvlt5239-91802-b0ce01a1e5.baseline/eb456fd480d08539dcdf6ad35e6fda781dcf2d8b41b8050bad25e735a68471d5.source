import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handleTelegramUpdate: vi.fn(async () => undefined),
  claim: vi.fn(async () => true),
  complete: vi.fn(async () => undefined),
  release: vi.fn(async () => undefined),
  checkDeploymentLicense: vi.fn(async () => ({ allowed: true })),
  sendCustomerHeartbeat: vi.fn(async () => undefined),
  retryPendingReportDeliveries: vi.fn(async () => ({ requeued: 0 })),
  recoverStaleResultVisualJobs: vi.fn(async () => ({ requeued: 0, failed: 0 })),
  recoverStaleImageGeneratorJobs: vi.fn(async () => ({ requeued: 0, failed: 0 })),
  migrateDataUrlCoversToKv: vi.fn(async () => 0),
  sendMessage: vi.fn(async () => Response.json({ ok: true })),
  answerCallbackQuery: vi.fn(async () => Response.json({ ok: true })),
}));

vi.mock("../../src/bot/router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/bot/router")>();
  return { ...actual, handleTelegramUpdate: mocks.handleTelegramUpdate };
});

vi.mock("../../src/services/update-dedup.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/update-dedup.service")>();
  return {
    ...actual,
    createUpdateDedupStore: () => ({
      claim: mocks.claim,
      complete: mocks.complete,
      release: mocks.release,
    }),
  };
});

vi.mock("../../src/services/license-client.service", () => ({
  checkDeploymentLicense: mocks.checkDeploymentLicense,
}));
vi.mock("../../src/services/customer-control.service", () => ({
  sendCustomerHeartbeat: mocks.sendCustomerHeartbeat,
}));
vi.mock("../../src/services/report-delivery.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/report-delivery.service")>()),
  retryPendingReportDeliveries: mocks.retryPendingReportDeliveries,
}));
vi.mock("../../src/services/result-visual-job-recovery.service", () => ({
  recoverStaleResultVisualJobs: mocks.recoverStaleResultVisualJobs,
}));
vi.mock("../../src/services/image-generator-job-recovery.service", () => ({
  recoverStaleImageGeneratorJobs: mocks.recoverStaleImageGeneratorJobs,
}));
vi.mock("../../src/services/cover-storage.service", () => ({
  migrateDataUrlCoversToKv: mocks.migrateDataUrlCoversToKv,
}));

// The result-visual WASM bundle cannot load under vitest; the webhook path
// never touches it.
vi.mock("../../src/services/result-visual-wasm", () => ({ RESULT_VISUAL_WASM: {} }));

vi.mock("../../src/bot/telegram", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/bot/telegram")>();
  return {
    ...actual,
    sendMessage: mocks.sendMessage,
    answerCallbackQuery: mocks.answerCallbackQuery,
    syncDefaultBotCommands: vi.fn(async () => undefined),
    getWebhookInfo: vi.fn(async () => ({
      url: "https://example.test/telegram/webhook",
      allowed_updates: ["message", "callback_query", "channel_post"],
    })),
    setWebhook: vi.fn(async () => undefined),
  };
});

const importedIndex = await import("../../src/index");
const worker = importedIndex.default;
const { escapeMetaAttribute } = importedIndex;

function createKv(): KVNamespace {
  return {
    get: vi.fn(async () => "ok"),
    put: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    list: vi.fn(async () => ({ keys: [], list_complete: true })),
  } as unknown as KVNamespace;
}

function createEnv(cache = createKv()) {
  return {
    DB: { prepare: vi.fn() } as unknown as D1Database,
    CACHE: cache,
    MEDIA_KV: createKv(),
    EXPORT_QUEUE: { send: vi.fn(), sendBatch: vi.fn() } as unknown as Queue,
    BOT_TOKEN: "bot-token",
    WEBHOOK_SECRET: "webhook-secret",
    ADMIN_IDS: "1",
    ENVIRONMENT: "production",
  };
}

function webhookRequest(body: unknown, secret = "webhook-secret"): Request {
  return new Request("https://example.test/telegram/webhook", {
    method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": secret, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("telegram webhook idempotency wiring", () => {
  it("escapes ampersands before quotes in meta attributes", () => {
    expect(escapeMetaAttribute('A &copy; "quote"')).toBe("A &amp;copy; &quot;quote&quot;");
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claim.mockResolvedValue(true);
    mocks.handleTelegramUpdate.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("claims, handles and completes a message update once", async () => {
    const env = createEnv();
    const response = await worker.fetch(
      webhookRequest({ update_id: 5001, message: { message_id: 1, chat: { id: 2 }, from: { id: 3 }, text: "hi" } }),
      env as never,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.claim).toHaveBeenCalledWith(5001);
    expect(mocks.handleTelegramUpdate).toHaveBeenCalledOnce();
    expect((mocks.handleTelegramUpdate.mock.calls[0] as unknown[])[1]).toMatchObject({ licenseServerUrl: null });
    expect(mocks.complete).toHaveBeenCalledWith(5001);
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it("pins bot links to PUBLIC_ORIGIN instead of the hostname the webhook arrived on", async () => {
    // The webhook deliberately keeps arriving on workers.dev (delivery must not
    // depend on a custom domain's DNS), so links built from request.url would
    // hand users the SNI-blocked hostname. PUBLIC_ORIGIN is what fixes that.
    const env = { ...createEnv(), PUBLIC_ORIGIN: "https://emoe.eu.cc/" };
    await worker.fetch(
      webhookRequest({ update_id: 5010, message: { message_id: 1, chat: { id: 2 }, from: { id: 3 }, text: "hi" } }),
      env as never,
    );

    const context = (mocks.handleTelegramUpdate.mock.calls[0] as unknown[])[1] as { origin?: string };
    expect(context.origin).toBe("https://emoe.eu.cc");
  });

  it("falls back to the request origin when PUBLIC_ORIGIN is unset", async () => {
    // Single-hostname deployments and `wrangler dev` must be unaffected.
    const env = createEnv();
    await worker.fetch(
      webhookRequest({ update_id: 5011, message: { message_id: 1, chat: { id: 2 }, from: { id: 3 }, text: "hi" } }),
      env as never,
    );

    const context = (mocks.handleTelegramUpdate.mock.calls[0] as unknown[])[1] as { origin?: string };
    expect(context.origin).toBe("https://example.test");
  });

  it("skips a duplicate delivery without re-running side effects", async () => {
    mocks.claim.mockResolvedValue(false);
    const env = createEnv();

    const response = await worker.fetch(
      webhookRequest({ update_id: 5002, callback_query: { id: "cb", from: { id: 3 }, data: "x" } }),
      env as never,
    );

    expect(await response.json()).toEqual({ ok: true, duplicate: true });
    expect(mocks.handleTelegramUpdate).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("releases the claim when handling fails for cron recovery", async () => {
    mocks.handleTelegramUpdate.mockRejectedValue(new Error("boom"));
    const env = createEnv();

    const response = await worker.fetch(
      webhookRequest({ update_id: 5003, message: { message_id: 1, chat: { id: 2 }, from: { id: 3 }, text: "hi" } }),
      env as never,
    );

    expect(response.status).toBe(200);
    expect(mocks.release).toHaveBeenCalledWith(5003);
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("runs the 30-minute recovery jobs independently when one rejects", async () => {
    const env = createEnv();
    mocks.recoverStaleResultVisualJobs.mockRejectedValueOnce(new Error("result visual failed"));

    await worker.scheduled({ cron: "*/30 * * * *" } as ScheduledEvent, env as never);

    expect(mocks.retryPendingReportDeliveries).toHaveBeenCalledOnce();
    expect(mocks.recoverStaleResultVisualJobs).toHaveBeenCalledOnce();
    expect(mocks.recoverStaleImageGeneratorJobs).toHaveBeenCalledOnce();
    expect(mocks.migrateDataUrlCoversToKv).toHaveBeenCalledOnce();
  });

  it("rate-limits email registration after five attempts for the same email", async () => {
    const counts = new Map<string, number>();
    const cache = {
      get: vi.fn(async (key: string) => String(counts.get(key) ?? 0)),
      put: vi.fn(async (key: string, value: string) => {
        counts.set(key, Number(value));
      }),
      delete: vi.fn(async () => undefined),
      list: vi.fn(async () => ({ keys: [], list_complete: true })),
    } as unknown as KVNamespace;
    const env = createEnv(cache);

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await worker.fetch(
        new Request("https://example.test/api/auth/email/register", {
          method: "POST",
          headers: { "Content-Type": "application/json", "cf-connecting-ip": "203.0.113.9" },
          body: JSON.stringify({ email: "user@example.com", password: "short" }),
        }),
        env as never,
      );
      expect(response.status).toBe(400);
    }

    const blocked = await worker.fetch(
      new Request("https://example.test/api/auth/email/register", {
        method: "POST",
        headers: { "Content-Type": "application/json", "cf-connecting-ip": "203.0.113.9" },
        body: JSON.stringify({ email: "user@example.com", password: "short" }),
      }),
      env as never,
    );
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({
      ok: false,
      code: "rate_limited",
      message: "请求过于频繁，请稍后再试",
    });
  });

  it("shares one email-auth IP budget across actions", async () => {
    const counts = new Map<string, number>();
    const cache = {
      get: vi.fn(async (key: string) => String(counts.get(key) ?? 0)),
      put: vi.fn(async (key: string, value: string) => {
        counts.set(key, Number(value));
      }),
      delete: vi.fn(async () => undefined),
      list: vi.fn(async () => ({ keys: [], list_complete: true })),
    } as unknown as KVNamespace;
    const env = createEnv(cache);

    for (let attempt = 1; attempt <= 20; attempt += 1) {
      const response = await worker.fetch(
        new Request("https://example.test/api/auth/email/register", {
          method: "POST",
          headers: { "Content-Type": "application/json", "cf-connecting-ip": "198.51.100.7" },
          body: JSON.stringify({ email: `user-${attempt}@example.com`, password: "short" }),
        }),
        env as never,
      );
      expect(response.status).toBe(400);
    }

    const blocked = await worker.fetch(
      new Request("https://example.test/api/auth/email/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", "cf-connecting-ip": "198.51.100.7" },
        body: JSON.stringify({ email: "another@example.com", password: "short" }),
      }),
      env as never,
    );
    expect(blocked.status).toBe(429);
  });

  it("reports a diagnostic 503 (not a generic 500) when the code store is unavailable", async () => {
    // KV 每日写额度打满 / 边缘抖动时，issueEmailCode 的 put 会抛错。此前异常
    // 冒泡到全局兜底，用户只看到「服务暂时不可用，请稍后重试」——实际卡在发码，
    // 换 Telegram 免注册即可用。这条断言锁住「错误必须指向那条出路」。
    const cache = {
      get: vi.fn(async () => null),
      put: vi.fn(async (key: string) => {
        if (key.startsWith("email-code:")) throw new Error("KV PUT failed: 429 exceeded daily write limit");
      }),
      delete: vi.fn(async () => undefined),
      list: vi.fn(async () => ({ keys: [], list_complete: true })),
    } as unknown as KVNamespace;
    const env = {
      ...createEnv(cache),
      DB: {
        prepare: vi.fn(() => ({
          bind: vi.fn(() => ({
            first: vi.fn(async () => null),
            run: vi.fn(async () => ({ success: true })),
            all: vi.fn(async () => ({ results: [] })),
          })),
        })),
      } as unknown as D1Database,
    };

    const response = await worker.fetch(
      new Request("https://example.test/api/auth/email/request-code", {
        method: "POST",
        headers: { "Content-Type": "application/json", "cf-connecting-ip": "192.0.2.55" },
        body: JSON.stringify({ email: "probe@example.com" }),
      }),
      env as never,
    );

    expect(response.status).toBe(503);
    const body = (await response.json()) as { code?: string; message?: string };
    expect(body.code).toBe("email_code_store_unavailable");
    expect(body.message).toContain("Telegram");
  });

  it("rejects a webhook with the wrong secret", async () => {
    const env = createEnv();
    const response = await worker.fetch(
      webhookRequest(
        { update_id: 5004, message: { message_id: 1, chat: { id: 2 }, from: { id: 3 }, text: "hi" } },
        "nope",
      ),
      env as never,
    );

    expect(response.status).toBe(403);
    expect(mocks.claim).not.toHaveBeenCalled();
  });
});
