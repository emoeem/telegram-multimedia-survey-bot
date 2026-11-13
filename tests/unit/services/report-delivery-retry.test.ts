import { describe, expect, it, vi } from "vitest";

import { retryPendingReportDeliveries } from "../../../src/services/report-delivery.service";

interface StubOptions {
  /** 按 UPDATE 的 SET 目标与 WHERE 里的 status 返回 changes 数。 */
  changes?: { expiredPending?: number; staleTerminal?: number; staleReclaim?: number };
  deliveryIds?: string[];
}

function stubDb(options: StubOptions = {}): D1Database {
  const statements = {
    expiredPending: {
      bind: vi.fn(() => statements.expiredPending),
      run: vi.fn(async () => ({ success: true, meta: { changes: options.changes?.expiredPending ?? 0 } })),
      all: vi.fn(async () => ({ results: [] })),
    },
    staleTerminal: {
      bind: vi.fn(() => statements.staleTerminal),
      run: vi.fn(async () => ({ success: true, meta: { changes: options.changes?.staleTerminal ?? 0 } })),
      all: vi.fn(async () => ({ results: [] })),
    },
    staleReclaim: {
      bind: vi.fn(() => statements.staleReclaim),
      run: vi.fn(async () => ({ success: true, meta: { changes: options.changes?.staleReclaim ?? 0 } })),
      all: vi.fn(async () => ({ results: [] })),
    },
    requeueQuery: {
      bind: vi.fn(() => statements.requeueQuery),
      run: vi.fn(async () => ({ success: true })),
      all: vi.fn(async () => ({ results: options.deliveryIds?.map((deliveryId) => ({ deliveryId })) ?? [] })),
    },
  };
  return {
    prepare: vi.fn((sql: string) => {
      if (/SET status = 'failed'[\s\S]*status = 'pending'/.test(sql)) return statements.expiredPending;
      if (/SET status = 'failed'[\s\S]*status = 'delivering'/.test(sql)) return statements.staleTerminal;
      if (/SET status = 'pending'/.test(sql)) return statements.staleReclaim;
      return statements.requeueQuery;
    }),
  } as unknown as D1Database;
}

describe("report delivery retry driver", () => {
  it("re-enqueues pending deliveries whose backoff window elapsed", async () => {
    const queue = { send: vi.fn(async () => {}) } as unknown as Queue;

    const summary = await retryPendingReportDeliveries(
      stubDb({ deliveryIds: ["response_1_v1", "response_2_v1"] }),
      queue,
      new Date("2026-08-22T00:06:00.000Z"),
    );

    expect(summary).toEqual({ requeued: 2, terminalFailed: 0 });
    expect(queue.send).toHaveBeenCalledTimes(2);
    expect(queue.send).toHaveBeenCalledWith({
      kind: "report_delivery",
      deliveryId: "response_1_v1",
    });
  });

  it("counts deliveries burned out to the terminal state", async () => {
    // 两条终态 UPDATE 的 changes：过期 pending 打 failed 2 条 + 死消费者的
    // stale delivering 打 failed 1 条。cron.ts 拿 terminalFailed 发 ERROR 行。
    const queue = { send: vi.fn(async () => {}) } as unknown as Queue;

    const summary = await retryPendingReportDeliveries(
      stubDb({ changes: { expiredPending: 2, staleTerminal: 1, staleReclaim: 0 } }),
      queue,
      new Date("2026-08-22T00:06:00.000Z"),
    );

    expect(summary).toEqual({ requeued: 0, terminalFailed: 3 });
    expect(queue.send).not.toHaveBeenCalled();
  });
});
