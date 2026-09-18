import { describe, expect, it, vi } from "vitest";

import {
  MetricsCollector,
  buildRequestMetrics,
  instrumentDatabase,
  instrumentKv,
  instrumentQueue,
  normalizeRoute,
  redactForLog,
  withQueueMetrics,
  withRequestMetrics,
} from "../../../src/observability/metrics";

function stubStatement(options: {
  allResult?: unknown;
  runResult?: unknown;
}): D1PreparedStatement {
  const statement = {
    bind: vi.fn(() => statement),
    all: vi.fn(async () => options.allResult ?? { results: [], meta: {} }),
    first: vi.fn(async () => null),
    run: vi.fn(async () => options.runResult ?? { success: true, meta: {} }),
    raw: vi.fn(async () => []),
  };
  return statement as unknown as D1PreparedStatement;
}

describe("query metrics", () => {
  it("counts D1 queries and rows read across bind chains", async () => {
    const collector = new MetricsCollector();
    const statement = stubStatement({
      allResult: { results: [], meta: { rows_read: 120, rows_written: 0, duration: 3 } },
    });
    const db = instrumentDatabase({ prepare: () => statement } as unknown as D1Database, collector);

    await db!.prepare("SELECT 1").bind(1).all();

    expect(collector.snapshot().d1Queries).toBe(1);
    expect(collector.snapshot().d1RowsRead).toBe(120);
    expect(collector.snapshot().d1DurationMs).toBe(3);
  });

  it("records write rows for run statements", async () => {
    const collector = new MetricsCollector();
    const statement = stubStatement({ runResult: { success: true, meta: { rows_written: 2 } } });
    const db = instrumentDatabase({ prepare: () => statement } as unknown as D1Database, collector);

    await db!.prepare("UPDATE t SET x = 1").run();

    expect(collector.snapshot().d1RowsWritten).toBe(2);
  });

  it("counts every statement in a D1 batch", async () => {
    const collector = new MetricsCollector();
    const statements = [
      stubStatement({ allResult: { results: [], meta: { rows_read: 10 } } }),
      stubStatement({ allResult: { results: [], meta: { rows_read: 15 } } }),
    ];
    const db = instrumentDatabase(
      {
        prepare: () => statements[0]!,
        batch: async () => [
          { results: [], meta: { rows_read: 10 } },
          { results: [], meta: { rows_read: 15 } },
        ],
      } as unknown as D1Database,
      collector,
    )!;

    await db.batch(statements);

    expect(collector.snapshot().d1Queries).toBe(2);
    expect(collector.snapshot().d1RowsRead).toBe(25);
  });

  it("tracks KV hits and misses", async () => {
    const collector = new MetricsCollector();
    const kv = {
      get: vi.fn(async (key: string) => (key === "hit" ? "value" : null)),
      put: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      list: vi.fn(async () => ({ keys: [], list_complete: true })),
    } as unknown as KVNamespace;
    const instrumented = instrumentKv(kv, collector)!;

    await instrumented.get("hit");
    await instrumented.get("miss");
    await instrumented.put("k", "v");

    expect(collector.snapshot().kvOps).toBe(3);
    expect(collector.snapshot().kvHits).toBe(1);
    expect(collector.snapshot().kvMisses).toBe(1);
  });

  it("counts individual messages in a queue batch send", async () => {
    const collector = new MetricsCollector();
    const queue = { sendBatch: vi.fn(async () => undefined), send: vi.fn(async () => undefined) } as unknown as Queue;
    const instrumented = instrumentQueue(queue, collector)!;

    await instrumented.sendBatch([{}, {}] as never);

    expect(collector.snapshot().queueSends).toBe(1);
    expect(collector.snapshot().queueMessages).toBe(2);
  });
});

describe("normalizeRoute", () => {
  it("collapses numeric ids and tokens", () => {
    expect(normalizeRoute("/api/admin/surveys/12/responses/340")).toBe(
      "/api/admin/surveys/:id/responses/:id",
    );
    expect(normalizeRoute("/api/report/media/123")).toBe("/api/report/media/:id");
  });
});

describe("withRequestMetrics", () => {
  it("emits one structured line with status, duration and query budget", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const statement = stubStatement({ allResult: { results: [], meta: { rows_read: 7 } } });
    const env = { DB: { prepare: () => statement } as unknown as D1Database };

    const response = await withRequestMetrics(
      new Request("https://example.test/api/admin/surveys/5", { method: "GET" }),
      env,
      async (instrumented) => {
        await instrumented.DB!.prepare("SELECT 1").all();
        return Response.json({ ok: true });
      },
    );

    expect(response.status).toBe(200);
    const [label, payload] = log.mock.calls[0] as [string, string];
    expect(label).toBe("request_metrics");
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    expect(parsed.route).toBe("/api/admin/surveys/:id");
    expect(parsed.status).toBe(200);
    expect(parsed.d1RowsRead).toBe(7);
    expect(typeof parsed.requestId).toBe("string");
    log.mockRestore();
  });

  it("still logs metrics when the handler throws", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      withRequestMetrics(
        new Request("https://example.test/api/surveys"),
        {},
        async () => {
          throw new Error("boom");
        },
      ),
    ).rejects.toThrow("boom");

    const metricCall = log.mock.calls.find(([label]) => label === "request_metrics");
    expect(metricCall).toBeTruthy();
    expect(JSON.parse(metricCall![1] as string).status).toBe(500);
    log.mockRestore();
    error.mockRestore();
  });

  it("records duplicate webhook updates and keeps them out of the log body", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await withRequestMetrics(
      new Request("https://example.test/telegram/webhook", { method: "POST" }),
      {},
      async (_env, metrics) => {
        metrics.recordDuplicateUpdate();
        return Response.json({ ok: true, duplicate: true });
      },
    );

    const parsed = JSON.parse((log.mock.calls[0] as [string, string])[1]) as Record<string, unknown>;
    expect(parsed.botUpdates).toBe(1);
    expect(parsed.duplicateUpdates).toBe(1);
    log.mockRestore();
  });

  it("skips the log line for successful static asset requests", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const response = await withRequestMetrics(
      new Request("https://example.test/assets/main-abc123.js"),
      {},
      async () => new Response("ok"),
    );

    expect(response.status).toBe(200);
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("never copies the request body into the metrics line", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const secretAnswer = "my-secret-survey-answer";

    await withRequestMetrics(
      new Request("https://example.test/api/survey/responses", {
        method: "POST",
        body: JSON.stringify({ answer: secretAnswer, password: "hunter2" }),
      }),
      {},
      async () => Response.json({ ok: true }),
    );

    const payload = (log.mock.calls[0] as [string, string])[1];
    expect(payload).not.toContain(secretAnswer);
    expect(payload).not.toContain("hunter2");
    log.mockRestore();
  });

  it("still logs failed static asset requests", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await withRequestMetrics(
      new Request("https://example.test/assets/missing-abc123.js"),
      {},
      async () => new Response("nope", { status: 404 }),
    );

    const parsed = JSON.parse((log.mock.calls[0] as [string, string])[1]) as Record<string, unknown>;
    expect(parsed.status).toBe(404);
    log.mockRestore();
  });
});

describe("withQueueMetrics", () => {
  it("emits queue name and message count", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const batch = {
      queue: "telegram-survey-export",
      messages: [{ body: {} }, { body: {} }],
    } as unknown as MessageBatch<unknown>;

    await withQueueMetrics(batch, {}, async () => undefined);

    const payload = JSON.parse((log.mock.calls[0] as [string, string])[1]);
    expect(payload.queue).toBe("telegram-survey-export");
    expect(payload.messages).toBe(2);
    expect(payload.ok).toBe(true);
    expect(payload.d1Queries).toBe(0);
    log.mockRestore();
  });

  it("counts D1 reads performed while processing a queue batch", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const batch = {
      queue: "telegram-survey-export",
      messages: [{ body: {} }],
    } as unknown as MessageBatch<unknown>;
    const statement = stubStatement({ allResult: { results: [], meta: { rows_read: 42 } } });
    const env = { DB: { prepare: () => statement } as unknown as D1Database };

    await withQueueMetrics(batch, env, async (instrumented) => {
      await instrumented.DB!.prepare("SELECT 1").all();
    });

    const payload = JSON.parse((log.mock.calls[0] as [string, string])[1]);
    expect(payload.d1Queries).toBe(1);
    expect(payload.d1RowsRead).toBe(42);
    log.mockRestore();
  });
});

describe("buildRequestMetrics", () => {
  it("keeps the payload free of request bodies or credentials", () => {
    const event = buildRequestMetrics({
      requestId: "r1",
      route: "/api/admin/login",
      method: "POST",
      status: 401,
      durationMs: 5,
      snapshot: new MetricsCollector().snapshot(),
    });

    expect(event.ok).toBe(false);
    expect(JSON.stringify(event)).not.toMatch(/token|password|secret/i);
  });
});

describe("redactForLog", () => {
  it("never returns a full secret", () => {
    expect(redactForLog("abcdefgh")).toBe("ab***gh");
    expect(redactForLog("abc")).toBe("***");
  });
});
