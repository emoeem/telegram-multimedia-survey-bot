/**
 * Lightweight request and query-budget metrics.
 *
 * The D1 free plan meters rows read/written per account per day and the whole
 * product shares one database, so the failure mode we care about most is not
 * latency but "which request read 400,000 rows". Cloudflare's built-in
 * observability only surfaces request counts, so every request now emits one
 * structured line with:
 *
 *   requestId, route (numeric ids collapsed), method, status, durationMs,
 *   d1Queries, d1RowsRead, d1RowsWritten, kvOps, kvHits, kvMisses,
 *   queueSends, queueMessages, botUpdates and duplicateUpdates.
 *
 * Every number in the line is actually populated: an always-zero field is
 * worse than no field, because it makes a real regression look identical to a
 * permanently broken instrument. Telegram API call counts are deliberately
 * not reported — the bot calls a plain global `fetch` from deep inside request
 * handlers, so counting them would need request-scoped plumbing that cannot be
 * done without changing every call site. D1 rows read/written is the number
 * that actually matters for the shared free-tier budget.
 *
 * Counters are collected per request through thin proxies around the D1, KV
 * and Queue bindings. Instruments never throw: a binding that cannot be
 * wrapped is returned untouched, because losing a metric must not fail a
 * request.
 */

export interface QueryMetricsSnapshot {
  d1Queries: number;
  d1RowsRead: number;
  d1RowsWritten: number;
  d1DurationMs: number;
  kvOps: number;
  kvHits: number;
  kvMisses: number;
  queueSends: number;
  queueMessages: number;
  botUpdates: number;
  duplicateUpdates: number;
}

const EMPTY_SNAPSHOT: QueryMetricsSnapshot = {
  d1Queries: 0,
  d1RowsRead: 0,
  d1RowsWritten: 0,
  d1DurationMs: 0,
  kvOps: 0,
  kvHits: 0,
  kvMisses: 0,
  queueSends: 0,
  queueMessages: 0,
  botUpdates: 0,
  duplicateUpdates: 0,
};

/** Mutable per-request counter bag. Nothing here is persisted. */
export class MetricsCollector {
  private counters = { ...EMPTY_SNAPSHOT };

  recordD1Result(result: unknown): void {
    const meta = (result as { meta?: Record<string, unknown> } | null)?.meta;
    this.counters.d1Queries += 1;
    if (!meta) return;
    this.counters.d1RowsRead += numeric(meta.rows_read);
    this.counters.d1RowsWritten += numeric(meta.rows_written);
    this.counters.d1DurationMs += numeric(meta.duration);
  }

  recordKv(op: "get" | "put" | "delete" | "list", hit = false): void {
    this.counters.kvOps += 1;
    if (op === "get") {
      if (hit) this.counters.kvHits += 1;
      else this.counters.kvMisses += 1;
    }
  }

  recordQueueSend(count = 1): void {
    this.counters.queueSends += count;
  }

  recordQueueMessages(count = 1): void {
    this.counters.queueMessages += count;
  }

  recordBotUpdate(count = 1): void {
    this.counters.botUpdates += count;
  }

  /** A Telegram redelivery that was skipped because the update was claimed. */
  recordDuplicateUpdate(count = 1): void {
    this.counters.duplicateUpdates += count;
  }

  snapshot(): QueryMetricsSnapshot {
    return { ...this.counters };
  }
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Wraps the terminal D1 statement methods so each call contributes its
 * `rows_read`/`rows_written`/`duration` to the collector. `bind` returns a
 * wrapped statement too, so chained bind calls stay instrumented.
 */
function instrumentStatement(
  statement: D1PreparedStatement,
  collector: MetricsCollector,
): D1PreparedStatement {
  const wraps = new Map<PropertyKey, (...args: unknown[]) => Promise<unknown>>();
  wraps.set("all", async (...args: unknown[]) => {
    const result = await (statement.all as (...inner: unknown[]) => Promise<unknown>)(...args);
    collector.recordD1Result(result);
    return result;
  });
  wraps.set("first", async (...args: unknown[]) => {
    const result = await (statement.first as (...inner: unknown[]) => Promise<unknown>)(...args);
    collector.recordD1Result(result);
    return result;
  });
  wraps.set("run", async (...args: unknown[]) => {
    const result = await (statement.run as (...inner: unknown[]) => Promise<unknown>)(...args);
    collector.recordD1Result(result);
    return result;
  });
  wraps.set("raw", async (...args: unknown[]) => {
    const result = await (statement.raw as (...inner: unknown[]) => Promise<unknown>)(...args);
    collector.recordD1Result(result);
    return result;
  });

  return new Proxy(statement, {
    get(target, property) {
      if (property === "bind") {
        return (...args: unknown[]) =>
          instrumentStatement(
            (target.bind as (...inner: unknown[]) => D1PreparedStatement)(...args),
            collector,
          );
      }
      const wrapped = wraps.get(property);
      if (wrapped) return wrapped;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

export function instrumentDatabase(db: D1Database | undefined, collector?: MetricsCollector): D1Database | undefined {
  if (!db || !collector) return db;
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) =>
          instrumentStatement(
            (target.prepare as (sql: string) => D1PreparedStatement)(query),
            collector,
          );
      }
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          try {
            const result = await (target.batch as (list: D1PreparedStatement[]) => Promise<unknown>)(statements);
            if (Array.isArray(result)) for (const entry of result) collector.recordD1Result(entry);
            return result;
          } catch (error) {
            collector.recordD1Result(null);
            throw error;
          }
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

export function instrumentKv(
  kv: KVNamespace | undefined,
  collector?: MetricsCollector,
): KVNamespace | undefined {
  if (!kv || !collector) return kv;
  return new Proxy(kv, {
    get(target, property) {
      if (property === "get") {
        return async (...args: unknown[]) => {
          const value = await (target.get as (...inner: unknown[]) => Promise<unknown>)(...args);
          collector.recordKv("get", value !== null && value !== undefined);
          return value;
        };
      }
      if (property === "put" || property === "delete" || property === "list") {
        const op = property === "put" ? "put" : property === "delete" ? "delete" : "list";
        const method = target[property] as (...args: unknown[]) => Promise<unknown>;
        return async (...args: unknown[]) => {
          const value = await method.apply(target, args);
          collector.recordKv(op);
          return value;
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

export function instrumentQueue(queue: Queue | undefined, collector?: MetricsCollector): Queue | undefined {
  if (!queue || !collector) return queue;
  return new Proxy(queue, {
    get(target, property) {
      if (property === "send" || property === "sendBatch") {
        const method = target[property] as (...args: unknown[]) => Promise<unknown>;
        return async (...args: unknown[]) => {
          const value = await method.apply(target, args);
          const first = args[0];
          const messages = property === "sendBatch" && Array.isArray(first) ? first.length : 1;
          collector.recordQueueSend(1);
          collector.recordQueueMessages(messages);
          return value;
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/**
 * Collapses high-cardinality path segments so route metrics can be grouped:
 * `/api/admin/surveys/123/responses/456` -> `/api/admin/surveys/:id/responses/:id`.
 * UUIDs and long hex tokens are collapsed as `:token`.
 */
export function normalizeRoute(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => {
      if (/^\d+$/.test(segment)) return ":id";
      if (/^[0-9a-f]{16,}$/i.test(segment)) return ":token";
      if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(segment)) return ":token";
      return segment;
    })
    .join("/");
}

export function createRequestId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export interface RequestMetricsEvent extends QueryMetricsSnapshot {
  type: "request_metrics";
  requestId: string;
  route: string;
  method: string;
  status: number;
  durationMs: number;
  ok: boolean;
}

export function buildRequestMetrics(input: {
  requestId: string;
  route: string;
  method: string;
  status: number;
  durationMs: number;
  snapshot: QueryMetricsSnapshot;
}): RequestMetricsEvent {
  return {
    type: "request_metrics",
    requestId: input.requestId,
    route: input.route,
    method: input.method,
    status: input.status,
    durationMs: input.durationMs,
    ok: input.status < 400,
    ...input.snapshot,
  };
}

/** Explicit marker used by the audit pipeline to keep secrets out of logs. */
export function redactForLog(value: string): string {
  if (value.length <= 4) return "***";
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

export interface ObservabilityEnvLike {
  DB?: D1Database;
  CACHE?: KVNamespace;
  MEDIA_KV?: KVNamespace;
  EXPORT_QUEUE?: Queue;
}

/**
 * Returns a shallow copy of `env` whose bindings are instrumented. Bindings
 * that are absent or unsupported are passed through unchanged.
 */
export function instrumentEnv<T extends ObservabilityEnvLike>(
  env: T,
  collector: MetricsCollector,
): T {
  const instrumented = {
    ...env,
    DB: instrumentDatabase(env.DB, collector),
    CACHE: instrumentKv(env.CACHE, collector),
    MEDIA_KV: instrumentKv(env.MEDIA_KV, collector),
    EXPORT_QUEUE: instrumentQueue(env.EXPORT_QUEUE, collector),
  } as T;
  return instrumented;
}

export type RequestRunner = (env: never) => Promise<Response>;

/** File extensions served straight from the assets binding. */
const STATIC_ASSET_EXTENSIONS = new Set([
  "html",
  "js",
  "mjs",
  "css",
  "map",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "ico",
  "webp",
  "avif",
  "woff",
  "woff2",
  "ttf",
  "eot",
  "otf",
  "txt",
  "webmanifest",
  "json",
]);

/** True for a path that is served from the static asset binding. */
export function isStaticAssetPath(pathname: string): boolean {
  const ext = pathname.split(".").pop()?.toLowerCase();
  return Boolean(ext && STATIC_ASSET_EXTENSIONS.has(ext));
}

/**
 * Runs one fetch request with instrumented bindings and emits exactly one
 * `request_metrics` line, even if the handler throws.
 */
export async function withRequestMetrics<TEnv extends ObservabilityEnvLike>(
  request: Request,
  env: TEnv,
  run: (env: TEnv, collector: MetricsCollector) => Promise<Response>,
): Promise<Response> {
  const collector = new MetricsCollector();
  const requestId = createRequestId();
  const startedAt = Date.now();
  const url = new URL(request.url);
  const route = normalizeRoute(url.pathname);
  let status = 500;
  try {
    const response = await run(instrumentEnv(env, collector), collector);
    status = response.status;
    return response;
  } catch (error) {
    console.error("Request failed before response", { requestId, route, error });
    throw error;
  } finally {
    if (route === "/telegram/webhook") collector.recordBotUpdate();
    // Successful static asset requests are not interesting for the D1 budget
    // and would otherwise emit one log line per JS/CSS/image byte served.
    const skipLog = status < 400 && isStaticAssetPath(url.pathname);
    if (!skipLog) {
      console.log(
        "request_metrics",
        JSON.stringify(
          buildRequestMetrics({
            requestId,
            route,
            method: request.method,
            status,
            durationMs: Date.now() - startedAt,
            snapshot: collector.snapshot(),
          }),
        ),
      );
    }
  }
}

export interface QueueMetricsEvent {
  type: "queue_metrics";
  queue: string;
  messages: number;
  durationMs: number;
  ok: boolean;
  d1Queries: number;
  d1RowsRead: number;
  d1RowsWritten: number;
  kvOps: number;
  queueSends: number;
  queueMessages: number;
}

/**
 * Runs one queue batch with instrumented bindings and emits a single
 * structured `queue_metrics` line.
 *
 * Export/visual jobs are the other place besides requests that can burn the
 * shared D1 read budget, so the line carries the same counters as a request.
 */
export async function withQueueMetrics<TEnv extends ObservabilityEnvLike>(
  batch: MessageBatch<unknown>,
  env: TEnv,
  run: (env: TEnv) => Promise<void>,
): Promise<void> {
  const collector = new MetricsCollector();
  const startedAt = Date.now();
  let ok = true;
  try {
    await run(instrumentEnv(env, collector));
  } catch (error) {
    ok = false;
    throw error;
  } finally {
    const snapshot = collector.snapshot();
    const event: QueueMetricsEvent = {
      type: "queue_metrics",
      queue: batch.queue,
      messages: batch.messages.length,
      durationMs: Date.now() - startedAt,
      ok,
      d1Queries: snapshot.d1Queries,
      d1RowsRead: snapshot.d1RowsRead,
      d1RowsWritten: snapshot.d1RowsWritten,
      kvOps: snapshot.kvOps,
      queueSends: snapshot.queueSends,
      queueMessages: snapshot.queueMessages,
    };
    console.log("queue_metrics", JSON.stringify(event));
  }
}

/** Reads the numeric metrics that Telegram/queue workers can attach manually. */
export function emptySnapshot(): QueryMetricsSnapshot {
  return { ...EMPTY_SNAPSHOT };
}
