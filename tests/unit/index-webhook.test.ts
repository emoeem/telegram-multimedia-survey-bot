import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { STALE_CLAIM_MS } from "../../src/services/update-dedup.service";

const mocks = vi.hoisted(() => ({
  handleTelegramUpdate: vi.fn(async () => undefined),
  // 带上 updateId 参数：并发用例里会换成有状态的状态机实现（见 createDedupSim）；
  // complete/release 用 Promise<void> 对齐真实 UpdateDedupStore 的签名。
  claim: vi.fn(async (_updateId: number) => true),
  complete: vi.fn((_updateId: number) => Promise.resolve()),
  release: vi.fn((_updateId: number) => Promise.resolve()),
  checkDeploymentLicense: vi.fn(async () => ({ allowed: true })),
  sendCustomerHeartbeat: vi.fn(async () => undefined),
  retryPendingReportDeliveries: vi.fn(async () => ({ requeued: 0, terminalFailed: 0 })),
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

interface DedupSimRow {
  status: "processing" | "done";
  receivedAt: number;
}

/**
 * Webhook 级去重状态机：与 update-dedup.service.test.ts 的 fake db 同一套
 * claim → complete / release 语义，但用宏任务错峰让并发请求先全部在途，再按
 * 到达顺序原子应用 —— 模拟 D1 的语句级原子性。若真实实现把「查状态 + 写状态」
 * 拆成可交错的步骤，并发重放的「恰好一次」就会在这里被打破。
 */
function createDedupSim() {
  const rows = new Map<number, DedupSimRow>();
  const claim = vi.fn(async (updateId: number) => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const staleCutoff = Date.now() - STALE_CLAIM_MS;
    const existing = rows.get(updateId);
    if (!existing) {
      rows.set(updateId, { status: "processing", receivedAt: Date.now() });
      return true;
    }
    if (existing.status !== "done" && existing.receivedAt <= staleCutoff) {
      existing.status = "processing";
      existing.receivedAt = Date.now();
      return true;
    }
    return false;
  });
  const complete = vi.fn(async (updateId: number) => {
    const existing = rows.get(updateId);
    if (existing && existing.status !== "done") existing.status = "done";
  });
  const release = vi.fn(async (updateId: number) => {
    const existing = rows.get(updateId);
    if (existing && existing.status !== "done") rows.delete(updateId);
  });
  return { claim, complete, release, rows };
}

function wireDedupSim(sim: ReturnType<typeof createDedupSim>): void {
  mocks.claim.mockImplementation(sim.claim);
  mocks.complete.mockImplementation(sim.complete);
  mocks.release.mockImplementation(sim.release);
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
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
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
    // botUpdates 只统计通过 secret 校验的调用（记录点在 router 的校验之后）。
    const metricsLine = logSpy.mock.calls.find(([label]) => label === "request_metrics");
    expect(JSON.parse(metricsLine![1] as string)).toMatchObject({ route: "/telegram/webhook", botUpdates: 1 });
    logSpy.mockRestore();
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

  it("emits a report_delivery_terminal ERROR line when deliveries burn out", async () => {
    const env = createEnv();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.retryPendingReportDeliveries.mockResolvedValueOnce({ requeued: 0, terminalFailed: 2 });

    await worker.scheduled({ cron: "*/30 * * * *" } as ScheduledEvent, env as never);

    // 终态失败单独成行：30 分钟一次的 info 行里捞不到它，告警过滤器只认这条。
    const terminalCall = errorSpy.mock.calls.find(([label]) => label === "report_delivery_terminal");
    expect(terminalCall).toBeTruthy();
    expect(JSON.parse(terminalCall![1] as string)).toMatchObject({ type: "report_delivery_terminal", count: 2 });
    errorSpy.mockRestore();
  });

  it("keeps terminal-free cron runs quiet about report delivery terminations", async () => {
    const env = createEnv();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await worker.scheduled({ cron: "*/30 * * * *" } as ScheduledEvent, env as never);

    // 无终态失败时不输出占位零行：全零字段会让真实回归看起来像坏掉的仪表。
    expect(errorSpy.mock.calls.find(([label]) => label === "report_delivery_terminal")).toBeUndefined();
    errorSpy.mockRestore();
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
          // 域名轮换：非主流域另有 5 注册/小时/域 的限制（fldubai.com 事件后的
          // 新防线），固定域名会让第 6 次 429 而不是走到这里测的 IP 预算。
          body: JSON.stringify({ email: `user-${attempt}@mail${attempt}.example`, password: "short" }),
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
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const response = await worker.fetch(
      webhookRequest(
        { update_id: 5004, message: { message_id: 1, chat: { id: 2 }, from: { id: 3 }, text: "hi" } },
        "nope",
      ),
      env as never,
    );

    expect(response.status).toBe(403);
    expect(mocks.claim).not.toHaveBeenCalled();
    // 伪造流量不算 botUpdates（失真修正）；它由 request_metrics 的 403 行回答。
    const metricsLine = logSpy.mock.calls.find(([label]) => label === "request_metrics");
    expect(JSON.parse(metricsLine![1] as string)).toMatchObject({
      route: "/telegram/webhook",
      status: 403,
      botUpdates: 0,
    });
    logSpy.mockRestore();
  });

  it("secret 校验先于 body 解析：错误 secret 下的畸形 JSON 也只回 403", async () => {
    const env = createEnv();
    // router.ts 的顺序是 secret 检查 → 自愈/license → request.json()。若顺序
    // 颠倒，下面的畸形 body 会先在解析处炸成 400 —— 403 就是顺序的证明。
    const response = await worker.fetch(
      new Request("https://example.test/telegram/webhook", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": "nope", "Content-Type": "application/json" },
        body: "not-json{",
      }),
      env as never,
    );

    expect(response.status).toBe(403);
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.handleTelegramUpdate).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("缺少 secret 头直接 403，解析与业务完全不触碰", async () => {
    const env = createEnv();
    const response = await worker.fetch(
      new Request("https://example.test/telegram/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          update_id: 6200,
          message: { message_id: 1, chat: { id: 2 }, from: { id: 3 }, text: "hi" },
        }),
      }),
      env as never,
    );

    expect(response.status).toBe(403);
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.handleTelegramUpdate).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("未知 update 类型安全降级：照常认领并 complete，不阻断后续更新", async () => {
    // Telegram 会持续送来 router 未实现的 update 种类（my_chat_member、
    // edited_message 等）。parse 只要 update_id 就放行，去重照常
    // claim → handle → complete 并回 200 让 Telegram 停止重发 —— 单条未知
    // update 既不能 500 触发重发风暴，也不能把整条更新流卡死。
    const env = createEnv();
    const response = await worker.fetch(
      webhookRequest({ update_id: 6300, my_chat_member: { chat: { id: 2 }, from: { id: 3 }, date: 1 } }),
      env as never,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.claim).toHaveBeenCalledWith(6300);
    expect(mocks.handleTelegramUpdate).toHaveBeenCalledOnce();
    expect(mocks.complete).toHaveBeenCalledWith(6300);
    expect(mocks.release).not.toHaveBeenCalled();
  });

  describe("并发重放与 done 行拦截（状态机模拟）", () => {
    afterEach(() => {
      // vi.clearAllMocks 不清 implementation：这里的状态机 mock 若不恢复，
      // 会带着旧 map 泄漏进后续用例。
      mocks.claim.mockImplementation(async () => true);
      mocks.complete.mockImplementation(async () => undefined);
      mocks.release.mockImplementation(async () => undefined);
    });

    it("并发 2/5/10 次投递同一 update_id，只有一次业务副作用", async () => {
      for (const concurrency of [2, 5, 10]) {
        const sim = createDedupSim();
        wireDedupSim(sim);
        mocks.handleTelegramUpdate.mockClear();
        mocks.complete.mockClear();
        mocks.release.mockClear();

        const responses = await Promise.all(
          Array.from({ length: concurrency }, () =>
            worker.fetch(
              webhookRequest({
                update_id: 6000 + concurrency,
                message: { message_id: 1, chat: { id: 2 }, from: { id: 3 }, text: "hi" },
              }),
              createEnv() as never,
            ),
          ),
        );

        // 全部 200；恰好一个「已处理」响应，其余都是「重复跳过」
        const bodies = (await Promise.all(responses.map((response) => response.json()))) as {
          duplicate?: boolean;
        }[];
        expect(responses.every((response) => response.status === 200)).toBe(true);
        expect(bodies.filter((body) => body.duplicate === true)).toHaveLength(concurrency - 1);
        expect(bodies.filter((body) => body.duplicate === undefined)).toHaveLength(1);

        // 业务副作用只发生一次，记账也只发生一次，行最终为 done
        expect(mocks.handleTelegramUpdate).toHaveBeenCalledTimes(1);
        expect(mocks.complete).toHaveBeenCalledTimes(1);
        expect(mocks.release).not.toHaveBeenCalled();
        expect(sim.rows.get(6000 + concurrency)?.status).toBe("done");
      }
    });

    it("处理成功后的重复投递零业务副作用（done 行拦截完整生命周期）", async () => {
      const sim = createDedupSim();
      wireDedupSim(sim);
      const env = createEnv();
      const body = {
        update_id: 6100,
        message: { message_id: 1, chat: { id: 2 }, from: { id: 3 }, text: "hi" },
      };

      // 第一次投递：完整走 claim → handle → complete，行置为 done
      const first = await worker.fetch(webhookRequest(body), env as never);
      expect(await first.json()).toEqual({ ok: true });
      expect(mocks.handleTelegramUpdate).toHaveBeenCalledOnce();
      expect(sim.rows.get(6100)?.status).toBe("done");

      // Telegram 在 ack 丢失后的重发：done 行拦截，业务与记账都不再发生
      const second = await worker.fetch(webhookRequest(body), env as never);
      expect(await second.json()).toEqual({ ok: true, duplicate: true });
      expect(mocks.handleTelegramUpdate).toHaveBeenCalledOnce();
      expect(mocks.complete).toHaveBeenCalledTimes(1);
      expect(mocks.release).not.toHaveBeenCalled();
    });
  });
});
