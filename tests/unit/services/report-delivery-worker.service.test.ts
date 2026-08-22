import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getReportDeliveryByDeliveryId: vi.fn(),
  claimReportDelivery: vi.fn(),
  completeReportDelivery: vi.fn(),
  failReportDelivery: vi.fn(),
  prepareResultProfileForResponse: vi.fn(),
  deserializeResultProfile: vi.fn(),
  renderReportPdf: vi.fn(),
  resolveReportProfileImages: vi.fn(),
  deleteTemporaryMediaForResponse: vi.fn(),
  sendDocument: vi.fn(),
  sendPhoto: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock("../../../src/db/repositories/report-delivery.repository", () => ({
  getReportDeliveryByDeliveryId: mocks.getReportDeliveryByDeliveryId,
  claimReportDelivery: mocks.claimReportDelivery,
  completeReportDelivery: mocks.completeReportDelivery,
  failReportDelivery: mocks.failReportDelivery,
}));

vi.mock("../../../src/services/result-visual.service", () => ({
  prepareResultProfileForResponse: mocks.prepareResultProfileForResponse,
}));

vi.mock("../../../src/services/result-engine.service", () => ({
  deserializeResultProfile: mocks.deserializeResultProfile,
}));

vi.mock("../../../src/services/report/pdf", () => ({
  renderReportPdf: mocks.renderReportPdf,
}));

vi.mock("../../../src/services/report/report-images.service", () => ({
  resolveReportProfileImages: mocks.resolveReportProfileImages,
}));

vi.mock("../../../src/services/media/temporary-media.service", () => ({
  deleteTemporaryMediaForResponse: mocks.deleteTemporaryMediaForResponse,
}));

vi.mock("../../../src/bot/telegram", () => ({
  sendDocument: mocks.sendDocument,
  sendPhoto: mocks.sendPhoto,
  sendMessage: mocks.sendMessage,
}));

import {
  processReportDeliveryMessage,
  type ReportDeliveryWorkerEnvironment,
} from "../../../src/services/report-delivery-worker.service";
import { REPORT_TEMPLATES } from "../../../src/services/report/template";

const deliveryRow = {
  id: 1,
  responseId: 42,
  reportVersion: 1,
  deliveryId: "response_42_v1",
  telegramChatId: null,
  pdfMessageId: null,
  imageMessageIdsJson: null,
  status: "pending",
  attempts: 0,
  lastError: null,
  nextRetryAt: null,
  deliveredAt: null,
  createdAt: "2026-08-22T00:00:00.000Z",
  updatedAt: "2026-08-22T00:00:00.000Z",
};

function makeDb(responseStatus = "completed") {
  const db = {
    prepare: vi.fn((sql: string) => {
      const statement = {
        bind: vi.fn(() => statement),
        first: vi.fn(async (): Promise<unknown> => {
          if (sql.includes("survey_responses") && sql.includes("WHERE id = ?")) {
            return {
              id: 42,
              surveyId: 1,
              userId: 7,
              status: responseStatus,
              startedAt: "2026-08-22T00:00:00.000Z",
              completedAt: "2026-08-22T08:00:00.000Z",
              submittedAt: "2026-08-22T08:00:00.000Z",
              currentQuestionId: null,
              version: 1,
              createdAt: "",
              updatedAt: "",
              participantHash: "user_7",
            };
          }
          if (sql.includes("users")) {
            return {
              id: 7,
              telegramUserId: 123,
              username: "alice",
              firstName: null,
              lastName: null,
              languageCode: null,
              systemRole: "participant",
              botStartedAt: null,
              bannedAt: null,
              bannedBy: null,
              banReason: null,
              createdAt: "",
              updatedAt: "",
            };
          }
          if (sql.includes("surveys")) {
            return { id: 1, title: "问卷标题", report_template_id: "magazine-dark" };
          }
          return null;
        }),
        all: vi.fn(async (): Promise<unknown> => ({ results: [] })),
        run: vi.fn(async () => ({ success: true })),
      };
      return statement;
    }),
  } as unknown as D1Database;
  return db;
}

function makeEnv(overrides: {
  channelId?: string | null;
  cache?: KVNamespace;
} = {}): ReportDeliveryWorkerEnvironment {
  const env: ReportDeliveryWorkerEnvironment = {
    DB: makeDb(),
    BOT_TOKEN: "token",
    MEDIA_KV: {} as KVNamespace,
    REPORT_CHANNEL_ID: "-100123",
    ADMIN_IDS: "1,2",
    BROWSER: {} as never,
  };
  if (overrides.channelId === null) delete env.REPORT_CHANNEL_ID;
  else if (overrides.channelId !== undefined) env.REPORT_CHANNEL_ID = overrides.channelId;
  if (overrides.cache) env.CACHE = overrides.cache;
  return env;
}

function telegramResponse(messageId: number): Response {
  return new Response(JSON.stringify({ ok: true, result: { message_id: messageId } }), {
    headers: { "Content-Type": "application/json" },
  });
}

describe("report delivery worker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getReportDeliveryByDeliveryId.mockResolvedValue({ ...deliveryRow });
    mocks.claimReportDelivery.mockResolvedValue(true);
    mocks.prepareResultProfileForResponse.mockResolvedValue({ profile: { id: 9 } });
    mocks.deserializeResultProfile.mockReturnValue({ images: {}, metadata: {} });
    mocks.resolveReportProfileImages.mockResolvedValue({});
    mocks.renderReportPdf.mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]), byteSize: 3 });
    mocks.sendDocument.mockResolvedValue(telegramResponse(55));
    mocks.deleteTemporaryMediaForResponse.mockResolvedValue(0);
  });

  it("skips already delivered reports (idempotency)", async () => {
    mocks.getReportDeliveryByDeliveryId.mockResolvedValue({
      ...deliveryRow,
      status: "delivered",
    });
    await processReportDeliveryMessage(makeEnv(), { kind: "report_delivery", deliveryId: "response_42_v1" });
    expect(mocks.claimReportDelivery).not.toHaveBeenCalled();
  });

  it("archives the PDF, attaches images, completes and cleans temporary media", async () => {
    mocks.resolveReportProfileImages.mockResolvedValue({
      question_1: "data:image/png;base64,AAAA",
    });
    mocks.sendPhoto.mockResolvedValue(telegramResponse(56));
    const env = makeEnv();

    await processReportDeliveryMessage(env, { kind: "report_delivery", deliveryId: "response_42_v1" });

    expect(mocks.sendDocument).toHaveBeenCalledWith(
      "token",
      -100123,
      "report-42.pdf",
      expect.any(Uint8Array),
      "application/pdf",
      expect.stringContaining("#答卷42"),
    );
    expect(mocks.sendPhoto).toHaveBeenCalledOnce();
    expect(mocks.completeReportDelivery).toHaveBeenCalledWith(
      env.DB,
      1,
      { telegramChatId: -100123, pdfMessageId: 55, imageMessageIds: [56] },
    );
    expect(mocks.deleteTemporaryMediaForResponse).toHaveBeenCalled();
    expect(mocks.renderReportPdf).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      {},
      REPORT_TEMPLATES["magazine-dark"],
    );
  });

  it("falls back to the cached channel id from KV when the env is empty", async () => {
    mocks.resolveReportProfileImages.mockResolvedValue({});
    const env = makeEnv({
      channelId: "",
      cache: {
        get: vi.fn(async () => "-1009999999999"),
      } as unknown as KVNamespace,
    });

    await processReportDeliveryMessage(env, { kind: "report_delivery", deliveryId: "response_42_v1" });

    expect(mocks.sendDocument).toHaveBeenCalledWith(
      "token",
      -1009999999999,
      "report-42.pdf",
      expect.any(Uint8Array),
      "application/pdf",
      expect.any(String),
    );
  });

  it("schedules a retry with backoff on retryable failure", async () => {
    mocks.renderReportPdf.mockRejectedValue(new Error("Telegram timeout"));
    const env = makeEnv();

    await processReportDeliveryMessage(env, { kind: "report_delivery", deliveryId: "response_42_v1" });

    expect(mocks.failReportDelivery).toHaveBeenCalledWith(
      env.DB,
      1,
      expect.objectContaining({ retryable: true, nextRetryAt: expect.any(String) }),
    );
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it("marks terminal failures and notifies admins", async () => {
    mocks.getReportDeliveryByDeliveryId.mockResolvedValue({
      ...deliveryRow,
      attempts: 4,
    });
    mocks.renderReportPdf.mockRejectedValue(new Error("REPORT_CHANNEL_ID 未配置或无效"));
    const env = makeEnv();

    await processReportDeliveryMessage(env, { kind: "report_delivery", deliveryId: "response_42_v1" });

    expect(mocks.failReportDelivery).toHaveBeenCalledWith(
      env.DB,
      1,
      expect.objectContaining({ retryable: false, nextRetryAt: null }),
    );
    expect(mocks.sendMessage).toHaveBeenCalledTimes(2);
  });
});
