import { beforeEach, describe, expect, it, vi } from "vitest";

const repositoryMocks = vi.hoisted(() => ({
  createReportDelivery: vi.fn(),
  getReportDeliveryByDeliveryId: vi.fn(),
  getReportDeliveryByResponseId: vi.fn(),
}));

vi.mock("../../../src/db/repositories/report-delivery.repository", () => ({
  createReportDelivery: repositoryMocks.createReportDelivery,
  getReportDeliveryByDeliveryId: repositoryMocks.getReportDeliveryByDeliveryId,
  getReportDeliveryByResponseId: repositoryMocks.getReportDeliveryByResponseId,
}));

import {
  enqueueReportDelivery,
  isReportDeliveryMessage,
  nextReportRetryAt,
  reportDeliveryId,
} from "../../../src/services/report-delivery.service";

function delivery(status: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    responseId: 10,
    reportVersion: 1,
    deliveryId: "response_10_v1",
    status,
    attempts: 0,
    ...overrides,
  };
}

describe("report delivery service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates and enqueues a delivery with a stable idempotency key", async () => {
    repositoryMocks.getReportDeliveryByResponseId.mockResolvedValue(null);
    repositoryMocks.createReportDelivery.mockResolvedValue(delivery("pending"));
    const queue = { send: vi.fn(async () => {}) } as unknown as Queue;

    const result = await enqueueReportDelivery({} as D1Database, queue, {
      responseId: 10,
    });

    expect(result.queued).toBe(true);
    expect(repositoryMocks.createReportDelivery).toHaveBeenCalledWith(
      {} as D1Database,
      { responseId: 10, reportVersion: 1, deliveryId: "response_10_v1" },
    );
    expect(queue.send).toHaveBeenCalledWith({
      kind: "report_delivery",
      deliveryId: "response_10_v1",
    });
  });

  it("does not re-enqueue an already delivered report", async () => {
    repositoryMocks.getReportDeliveryByResponseId.mockResolvedValue(delivery("delivered"));
    const queue = { send: vi.fn(async () => {}) } as unknown as Queue;

    const result = await enqueueReportDelivery({} as D1Database, queue, {
      responseId: 10,
    });

    expect(result.queued).toBe(false);
    expect(queue.send).not.toHaveBeenCalled();
  });

  it("re-enqueues a failed delivery when forced", async () => {
    repositoryMocks.getReportDeliveryByResponseId.mockResolvedValue(delivery("failed"));
    const queue = { send: vi.fn(async () => {}) } as unknown as Queue;

    const result = await enqueueReportDelivery({} as D1Database, queue, {
      responseId: 10,
      force: true,
    });

    expect(result.queued).toBe(true);
    expect(queue.send).toHaveBeenCalledOnce();
  });

  it("computes exponential backoff and stops after the attempt cap", () => {
    expect(reportDeliveryId(10, 1)).toBe("response_10_v1");
    const now = new Date("2026-08-22T00:00:00.000Z");
    expect(nextReportRetryAt(1, now)).toBe("2026-08-22T00:01:00.000Z");
    expect(nextReportRetryAt(2, now)).toBe("2026-08-22T00:05:00.000Z");
    expect(nextReportRetryAt(5, now)).toBeNull();
  });

  it("validates queue message shape", () => {
    expect(isReportDeliveryMessage({ kind: "report_delivery", deliveryId: "response_1_v1" })).toBe(true);
    expect(isReportDeliveryMessage({ kind: "other" })).toBe(false);
  });
});
