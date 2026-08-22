import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSurveyById: vi.fn(),
  getMediaAssetById: vi.fn(),
  prepareResultProfileForResponse: vi.fn(),
  deserializeResultProfile: vi.fn(),
}));

vi.mock("../../../src/db/repositories/survey.repository", () => ({
  getSurveyById: mocks.getSurveyById,
}));

vi.mock("../../../src/db/repositories/media.repository", () => ({
  getMediaAssetById: mocks.getMediaAssetById,
}));

vi.mock("../../../src/services/result-visual.service", () => ({
  prepareResultProfileForResponse: mocks.prepareResultProfileForResponse,
}));

vi.mock("../../../src/services/result-engine.service", () => ({
  deserializeResultProfile: mocks.deserializeResultProfile,
}));

import { handleReportRequest } from "../../../src/http/report-api";
import { createReportAccessToken } from "../../../src/services/report-access-token.service";
import type { Env } from "../../../src/index";

const snapshot = {
  resultType: "survey_result",
  title: "分析报告",
  subtitle: "副标题",
  fields: {},
  stats: [],
  tags: [],
  images: {},
  metadata: {},
  schemaVersion: 1,
};

function makeDb(overrides: Record<string, unknown> = {}) {
  const db = {
    prepare: vi.fn((sql: string) => {
      const statement = {
        bind: vi.fn(() => statement),
        first: vi.fn(async (): Promise<unknown> => null),
        all: vi.fn(async (): Promise<unknown> => ({ results: [] })),
      };
      if (sql.includes("FROM survey_responses")) {
        statement.first.mockResolvedValue(
          overrides.responseRow ?? {
            id: 42,
            surveyId: 1,
            status: "completed",
            completedAt: "2026-08-22T08:00:00.000Z",
          },
        );
      } else if (sql.includes("answer_media am")) {
        statement.first.mockResolvedValue(
          overrides.owned === undefined ? { found: 1 } : overrides.owned,
        );
      } else if (sql.includes("question_media qm")) {
        statement.first.mockResolvedValue(
          overrides.linked === undefined ? { found: 1 } : overrides.linked,
        );
      }
      return statement;
    }),
  } as unknown as D1Database;
  return db;
}

function makeEnv(db: D1Database): Env {
  return {
    DB: db,
    BOT_TOKEN: "token",
    WEBHOOK_SECRET: "secret",
    MEDIA_KV: {
      put: vi.fn(async () => {}),
      get: vi.fn(async () => new Uint8Array([1, 2, 3]).buffer as ArrayBuffer),
    } as unknown as KVNamespace,
  } as unknown as Env;
}

describe("report API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSurveyById.mockResolvedValue({ id: 1, title: "问卷标题" });
    mocks.prepareResultProfileForResponse.mockResolvedValue({
      profile: { id: 9 },
      reused: false,
    });
    mocks.deserializeResultProfile.mockReturnValue(snapshot);
  });

  it("serves a responsive report page with a valid token", async () => {
    const db = makeDb();
    const token = await createReportAccessToken("secret", 42);
    const response = await handleReportRequest(
      new Request(`https://worker.test/report/42?t=${token}`),
      makeEnv(db),
      new URL(`https://worker.test/report/42?t=${token}`),
    );

    expect(response?.status).toBe(200);
    const html = await response?.text();
    expect(html).toContain("分析报告");
    expect(html).toContain("问卷标题");
    expect(response?.headers.get("Content-Type")).toContain("text/html");
  });

  it("uses the survey's bound report template", async () => {
    mocks.getSurveyById.mockResolvedValue({
      id: 1,
      title: "问卷标题",
      reportTemplateId: "magazine-dark",
    });
    const db = makeDb();
    const token = await createReportAccessToken("secret", 42);
    const response = await handleReportRequest(
      new Request(`https://worker.test/report/42?t=${token}`),
      makeEnv(db),
      new URL(`https://worker.test/report/42?t=${token}`),
    );
    const html = await response?.text();
    expect(html).toContain("report-cover");
    expect(html).toContain("--report-bg:#282a36");
  });

  it("rejects pages without a valid token", async () => {
    const response = await handleReportRequest(
      new Request("https://worker.test/report/42?t=bad"),
      makeEnv(makeDb()),
      new URL("https://worker.test/report/42?t=bad"),
    );
    expect(response?.status).toBe(403);
  });

  it("serves response media owned by the report response", async () => {
    const db = makeDb();
    mocks.getMediaAssetById.mockResolvedValue({
      id: 77,
      scope: "response",
      mediaType: "photo",
      telegramFileId: null,
      telegramFileUniqueId: null,
      url: null,
      storageKind: "temporary",
      storageKey: "media:temp:42:key",
      expiresAt: null,
      mimeType: "image/png",
      fileName: "photo.png",
      fileSize: 3,
      width: null,
      height: null,
      duration: null,
      r2Key: null,
      createdAt: "",
      updatedAt: "",
    });
    const token = await createReportAccessToken("secret", 42);
    const response = await handleReportRequest(
      new Request(`https://worker.test/api/report/media/77?t=${token}&rid=42`),
      makeEnv(db),
      new URL(`https://worker.test/api/report/media/77?t=${token}&rid=42`),
    );

    expect(response?.status).toBe(200);
  });

  it("forbids media not owned by the response", async () => {
    const db = makeDb({ owned: null });
    mocks.getMediaAssetById.mockResolvedValue({
      id: 77,
      scope: "response",
      mediaType: "photo",
      telegramFileId: null,
      telegramFileUniqueId: null,
      url: null,
      storageKind: "temporary",
      storageKey: "media:temp:42:key",
      expiresAt: null,
      mimeType: "image/png",
      fileName: null,
      fileSize: 3,
      width: null,
      height: null,
      duration: null,
      r2Key: null,
      createdAt: "",
      updatedAt: "",
    });
    const token = await createReportAccessToken("secret", 42);
    const response = await handleReportRequest(
      new Request(`https://worker.test/api/report/media/77?t=${token}&rid=42`),
      makeEnv(db),
      new URL(`https://worker.test/api/report/media/77?t=${token}&rid=42`),
    );
    expect(response?.status).toBe(403);
  });
});
