import { describe, expect, it, vi } from "vitest";

const { processResultVisualMessage } = vi.hoisted(() => ({
  processResultVisualMessage: vi.fn(),
}));

vi.mock("../../../src/services/result-visual-worker.service", () => ({
  processResultVisualMessage,
}));

import { handleExportQueue } from "../../../src/services/export-worker.service";

function queueMessage(attempts: number): Message<unknown> & { retry: ReturnType<typeof vi.fn>; ack: ReturnType<typeof vi.fn> } {
  return {
    id: "message-1",
    timestamp: new Date(),
    body: { kind: "result_visual", jobId: 8 },
    attempts,
    retry: vi.fn(),
    ack: vi.fn(),
  } as unknown as Message<unknown> & { retry: ReturnType<typeof vi.fn>; ack: ReturnType<typeof vi.fn> };
}

function batch(message: Message<unknown>): MessageBatch<unknown> {
  return {
    messages: [message],
    queue: "telegram-survey-export",
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    retryAll: vi.fn(),
    ackAll: vi.fn(),
  };
}

describe("result visual queue dispatch", () => {
  it("acknowledges only after the direct Telegram render path succeeds", async () => {
    processResultVisualMessage.mockResolvedValueOnce(undefined);
    const message = queueMessage(1);
    const db = { prepare: vi.fn() } as unknown as D1Database;

    await handleExportQueue(batch(message), { DB: db, BOT_TOKEN: "token" });

    expect(processResultVisualMessage).toHaveBeenCalledWith({ DB: db, BOT_TOKEN: "token" }, message.body);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it("releases the render job and retries temporary PNG or Telegram failures", async () => {
    processResultVisualMessage.mockRejectedValueOnce(new Error("Telegram sendPhoto failed: 500"));
    const message = queueMessage(1);
    const sql: string[] = [];
    const db = {
      prepare: vi.fn((statementSql: string) => {
        sql.push(statementSql);
        const statement = { bind: vi.fn(() => statement), run: vi.fn(async () => ({ success: true })) };
        return statement;
      }),
    } as unknown as D1Database;

    await handleExportQueue(batch(message), { DB: db, BOT_TOKEN: "token" });

    expect(sql.some((statement) => statement.includes("status = 'queued'"))).toBe(true);
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 10 });
    expect(message.ack).not.toHaveBeenCalled();
  });

  it("records a terminal failure after the retry limit", async () => {
    processResultVisualMessage.mockRejectedValueOnce(new Error("renderer failed"));
    const message = queueMessage(3);
    const sql: string[] = [];
    const db = {
      prepare: vi.fn((statementSql: string) => {
        sql.push(statementSql);
        const statement = { bind: vi.fn(() => statement), run: vi.fn(async () => ({ success: true })) };
        return statement;
      }),
    } as unknown as D1Database;

    await handleExportQueue(batch(message), { DB: db, BOT_TOKEN: "token" });

    expect(sql.some((statement) => statement.includes("status = 'failed'"))).toBe(true);
    expect(message.retry).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledOnce();
  });
});
