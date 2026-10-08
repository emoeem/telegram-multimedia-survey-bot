import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handleTelegramUpdate: vi.fn(async () => undefined),
  claim: vi.fn(async () => true),
  complete: vi.fn(async () => undefined),
  release: vi.fn(async () => undefined),
  checkDeploymentLicense: vi.fn(async () => ({ allowed: true })),
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

const worker = (await import("../../src/index")).default;

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
    expect(mocks.complete).toHaveBeenCalledWith(5001);
    expect(mocks.release).not.toHaveBeenCalled();
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

  it("releases the claim when handling fails so Telegram can retry", async () => {
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
});
