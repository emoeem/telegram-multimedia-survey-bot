import { describe, expect, it, vi } from "vitest";

import { retryPendingReportDeliveries } from "../../../src/services/report-delivery.service";

describe("report delivery retry driver", () => {
  it("re-enqueues pending deliveries whose backoff window elapsed", async () => {
    const statement = {
      bind: vi.fn(() => statement),
      run: vi.fn(async () => ({ success: true })),
      all: vi.fn(async () => ({
        results: [
          { deliveryId: "response_1_v1" },
          { deliveryId: "response_2_v1" },
        ],
      })),
    };
    const db = { prepare: vi.fn(() => statement) } as unknown as D1Database;
    const queue = { send: vi.fn(async () => {}) } as unknown as Queue;

    const summary = await retryPendingReportDeliveries(db, queue, new Date("2026-08-22T00:06:00.000Z"));

    expect(summary).toEqual({ requeued: 2 });
    expect(queue.send).toHaveBeenCalledTimes(2);
    expect(queue.send).toHaveBeenCalledWith({
      kind: "report_delivery",
      deliveryId: "response_1_v1",
    });
  });
});
