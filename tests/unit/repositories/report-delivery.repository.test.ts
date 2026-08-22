import { describe, expect, it, vi } from "vitest";

import {
  claimReportDelivery,
  completeReportDelivery,
  createReportDelivery,
  failReportDelivery,
} from "../../../src/db/repositories/report-delivery.repository";

const deliveryRow = {
  id: 1,
  response_id: 10,
  report_version: 1,
  delivery_id: "response_10_v1",
  telegram_chat_id: null,
  pdf_message_id: null,
  image_message_ids_json: null,
  status: "pending",
  attempts: 0,
  last_error: null,
  next_retry_at: null,
  delivered_at: null,
  created_at: "2026-08-22T00:00:00.000Z",
  updated_at: "2026-08-22T00:00:00.000Z",
};

function makeDb(overrides: {
  lastRowId?: number;
  changes?: number;
  firstRow?: unknown;
} = {}) {
  const statement = {
    bind: vi.fn((..._args: unknown[]) => statement),
    run: vi.fn(async () => ({
      success: true,
      meta: { last_row_id: overrides.lastRowId ?? 1, changes: overrides.changes ?? 1 },
    })),
    first: vi.fn(async () => overrides.firstRow ?? deliveryRow),
  };
  return { db: { prepare: vi.fn(() => statement) } as unknown as D1Database, statement };
}

describe("report delivery repository", () => {
  it("creates a pending delivery and maps the row", async () => {
    const { db, statement } = makeDb({ firstRow: { ...deliveryRow, id: 9 } });

    const delivery = await createReportDelivery(db, {
      responseId: 10,
      reportVersion: 1,
      deliveryId: "response_10_v1",
    });

    expect(delivery.id).toBe(9);
    expect(delivery.status).toBe("pending");
    expect(statement.bind).toHaveBeenCalledWith(
      10,
      1,
      "response_10_v1",
      expect.any(String),
      expect.any(String),
    );
  });

  it("claims only pending/failed deliveries inside the retry window", async () => {
    const { db, statement } = makeDb({ changes: 1 });
    await expect(claimReportDelivery(db, 1)).resolves.toBe(true);
    expect(statement.run).toHaveBeenCalled();

    const { db: dbNoChange, statement: statementNoChange } = makeDb({ changes: 0 });
    await expect(claimReportDelivery(dbNoChange, 1)).resolves.toBe(false);
    expect(statementNoChange.run).toHaveBeenCalled();
  });

  it("completes a delivery with channel and message ids", async () => {
    const { db, statement } = makeDb();
    await completeReportDelivery(db, 1, {
      telegramChatId: -100123,
      pdfMessageId: 55,
      imageMessageIds: [56, 57],
    });
    const bindings = statement.bind.mock.calls[0] as unknown[];
    expect(bindings[0]).toBe(-100123);
    expect(bindings[1]).toBe(55);
    expect(bindings[2]).toBe("[56,57]");
  });

  it("marks retryable failures pending with a backoff and terminal failures failed", async () => {
    const { db: dbA, statement: statementA } = makeDb();
    await failReportDelivery(dbA, 1, {
      error: "timeout",
      retryable: true,
      nextRetryAt: "2026-08-22T00:01:00.000Z",
    });
    expect(statementA.bind.mock.calls[0]?.[0]).toBe("pending");

    const { db: dbB, statement: statementB } = makeDb();
    await failReportDelivery(dbB, 1, {
      error: "bad",
      retryable: false,
      nextRetryAt: null,
    });
    expect(statementB.bind.mock.calls[0]?.[0]).toBe("failed");
  });
});
