import { afterEach, describe, expect, it, vi } from "vitest";

const { processIdentityCardMessage, retryIdentityCardJob, notifyIdentityCardFailure } = vi.hoisted(() => ({
  processIdentityCardMessage: vi.fn(),
  retryIdentityCardJob: vi.fn(),
  notifyIdentityCardFailure: vi.fn(),
}));

vi.mock("../../../src/services/identity-card-worker.service", () => ({
  isIdentityCardJobMessage: (value: unknown) => (value as { kind?: string }).kind === "identity_card",
  processIdentityCardMessage,
  retryIdentityCardJob,
  notifyIdentityCardFailure,
}));
vi.mock("../../../src/services/result-visual-worker.service", () => ({ processResultVisualMessage: vi.fn() }));

import { handleExportQueue } from "../../../src/services/export-worker.service";

function queueMessage(attempts: number) {
  return {
    id: "identity-job", timestamp: new Date(), body: { kind: "identity_card", jobId: 8 }, attempts,
    ack: vi.fn(), retry: vi.fn(),
  } as unknown as Message<unknown> & { ack: ReturnType<typeof vi.fn>; retry: ReturnType<typeof vi.fn> };
}

function batch(message: Message<unknown>): MessageBatch<unknown> {
  return { messages: [message], queue: "telegram-survey-export", metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } }, retryAll: vi.fn(), ackAll: vi.fn() };
}

describe("identity card queue dispatch", () => {
  afterEach(() => vi.clearAllMocks());

  it("acks after the background identity render succeeds", async () => {
    const message = queueMessage(1);
    await handleExportQueue(batch(message), { DB: {} as D1Database, BOT_TOKEN: "token" });
    expect(processIdentityCardMessage).toHaveBeenCalledWith({ DB: expect.anything(), BOT_TOKEN: "token" }, message.body);
    expect(message.ack).toHaveBeenCalledOnce();
  });

  it("requeues retryable errors", async () => {
    const message = queueMessage(1);
    const db = {} as D1Database;
    processIdentityCardMessage.mockRejectedValueOnce(new Error("renderer failed"));
    await handleExportQueue(batch(message), { DB: db, BOT_TOKEN: "token" });
    expect(retryIdentityCardJob).toHaveBeenCalledWith(db, 8, "renderer failed", false);
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 10 });
    expect(message.ack).not.toHaveBeenCalled();
  });

  it("notifies then acknowledges a terminal error", async () => {
    const message = queueMessage(3);
    const db = {} as D1Database;
    processIdentityCardMessage.mockRejectedValueOnce(new Error("renderer failed"));
    await handleExportQueue(batch(message), { DB: db, BOT_TOKEN: "token" });
    expect(retryIdentityCardJob).toHaveBeenCalledWith(db, 8, "renderer failed", true);
    expect(notifyIdentityCardFailure).toHaveBeenCalledWith({ DB: db, BOT_TOKEN: "token" }, 8);
    expect(message.ack).toHaveBeenCalledOnce();
  });
});
