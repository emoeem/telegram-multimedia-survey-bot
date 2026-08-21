import { afterEach, describe, expect, it, vi } from "vitest";

const { processImageGeneratorMessage, retryImageGeneratorJob } = vi.hoisted(() => ({
  processImageGeneratorMessage: vi.fn(),
  retryImageGeneratorJob: vi.fn(),
}));

vi.mock("../../../src/services/image-generator-worker.service", () => ({
  isImageGeneratorJobMessage: (value: unknown) => (value as { kind?: string }).kind === "image_generator",
  processImageGeneratorMessage,
  retryImageGeneratorJob,
}));
vi.mock("../../../src/services/result-visual-worker.service", () => ({
  processResultVisualMessage: vi.fn(),
}));

import { handleExportQueue } from "../../../src/services/export-worker.service";

function message(attempts: number) {
  return {
    id: "image-generator-job",
    timestamp: new Date(),
    body: { kind: "image_generator", jobId: 8 },
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  } as unknown as Message<unknown> & { ack: ReturnType<typeof vi.fn>; retry: ReturnType<typeof vi.fn> };
}

describe("image generator queue dispatch", () => {
  afterEach(() => vi.clearAllMocks());

  it("acknowledges only after direct Telegram image delivery succeeds", async () => {
    const item = message(1);
    processImageGeneratorMessage.mockResolvedValueOnce(undefined);
    await handleExportQueue({ messages: [item], queue: "telegram-survey-export", metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } }, retryAll: vi.fn(), ackAll: vi.fn() }, { DB: {} as D1Database, BOT_TOKEN: "token" });
    expect(processImageGeneratorMessage).toHaveBeenCalledWith({ DB: expect.anything(), BOT_TOKEN: "token" }, item.body);
    expect(item.ack).toHaveBeenCalledOnce();
    expect(item.retry).not.toHaveBeenCalled();
  });

  it("records failure then retries a temporary renderer or Telegram error", async () => {
    const item = message(1);
    processImageGeneratorMessage.mockRejectedValueOnce(new Error("Telegram sendPhoto failed"));
    const db = {} as D1Database;
    await handleExportQueue({ messages: [item], queue: "telegram-survey-export", metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } }, retryAll: vi.fn(), ackAll: vi.fn() }, { DB: db, BOT_TOKEN: "token" });
    expect(retryImageGeneratorJob).toHaveBeenCalledWith(db, 8, "Telegram sendPhoto failed", false);
    expect(item.retry).toHaveBeenCalledWith({ delaySeconds: 10 });
    expect(item.ack).not.toHaveBeenCalled();
  });
});
