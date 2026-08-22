import { beforeEach, describe, expect, it, vi } from "vitest";

const repositoryMocks = vi.hoisted(() => ({
  getSurveyById: vi.fn(),
  listQuestionsBySurvey: vi.fn(),
  listOptionsForQuestions: vi.fn(),
  getMediaAssetById: vi.fn(),
}));

vi.mock("../../../src/db/repositories/survey.repository", () => ({
  getSurveyById: repositoryMocks.getSurveyById,
}));

vi.mock("../../../src/db/repositories/question.repository", () => ({
  listQuestionsBySurvey: repositoryMocks.listQuestionsBySurvey,
  listOptionsForQuestions: repositoryMocks.listOptionsForQuestions,
}));

vi.mock("../../../src/db/repositories/media.repository", () => ({
  getMediaAssetById: repositoryMocks.getMediaAssetById,
}));

import { exportUnifiedSurveyJson } from "../../../src/services/survey-json.service";

describe("survey JSON export", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repositoryMocks.getSurveyById.mockResolvedValue({
      id: 1,
      title: "导出问卷",
      description: "描述",
      coverMediaId: 7,
      anonymous: false,
      allowMultipleResponses: false,
      maxResponsesPerUser: 1,
    });
    repositoryMocks.listQuestionsBySurvey.mockResolvedValue([
      {
        id: 10,
        surveyId: 1,
        type: "single",
        title: "请选择",
        description: null,
        required: true,
        order: 0,
        pageId: 100,
        validationJson: JSON.stringify({ min_selections: 1 }),
        settingsJson: null,
        parentQuestionId: null,
        conditionJson: null,
        skipToQuestionId: null,
        createdAt: "",
        updatedAt: "",
      },
    ]);
    repositoryMocks.listOptionsForQuestions.mockResolvedValue([
      {
        id: 501,
        questionId: 10,
        label: "选项A",
        value: "A",
        order: 0,
        isOther: false,
        createdAt: "",
        updatedAt: "",
      },
    ]);
    repositoryMocks.getMediaAssetById.mockResolvedValue({
      id: 7,
      scope: "survey",
      mediaType: "photo",
      telegramFileId: "tg-file",
      telegramFileUniqueId: "tg-unique",
      url: null,
      mimeType: "image/jpeg",
      fileName: "cover.jpg",
      fileSize: 1234,
      width: 800,
      height: 600,
      duration: null,
      r2Key: null,
      createdAt: "",
      updatedAt: "",
    });
  });

  it("exports pages, question media, option media, cover, and validation", async () => {
    const statement = {
      bind: vi.fn(() => statement),
    };
    const db = {
      prepare: vi.fn(() => statement),
      batch: vi.fn(async () => [
        {
          results: [
            {
              questionId: 10,
              mediaAssetId: 20,
              mediaType: "photo",
              telegramFileId: null,
              telegramFileUniqueId: null,
              url: "https://example.com/q.png",
              r2Key: null,
              mimeType: "image/png",
              fileName: "q.png",
              fileSize: 100,
              width: 320,
              height: 240,
              duration: null,
            },
          ],
        },
        {
          results: [
            {
              optionId: 501,
              mediaAssetId: 21,
              mediaType: "photo",
              telegramFileId: null,
              telegramFileUniqueId: null,
              url: "https://example.com/o.png",
              r2Key: null,
              mimeType: "image/png",
              fileName: "o.png",
              fileSize: 80,
              width: 100,
              height: 100,
              duration: null,
            },
          ],
        },
        {
          results: [
            { id: 100, title: "第一页", description: "开始", order: 0 },
          ],
        },
      ]),
    } as unknown as D1Database;

    const exported = await exportUnifiedSurveyJson(db, 1);

    expect(exported?.survey.pages).toEqual([
      { id: "p1", order: 1, title: "第一页", description: "开始" },
    ]);
    expect(exported?.survey.cover?.source).toBe("telegram");
    expect(exported?.survey.cover?.telegram_file_id).toBe("tg-file");

    const question = exported?.survey.questions[0];
    expect(question?.page_id).toBe("p1");
    expect(question?.validation).toEqual({ min_selections: 1 });
    expect(question?.media).toHaveLength(1);
    expect(question?.media?.[0]?.url).toBe("https://example.com/q.png");
    expect(question?.media?.[0]?.source).toBe("url");
    expect(question?.options?.[0]?.media).toHaveLength(1);
    expect(question?.options?.[0]?.media?.[0]?.url).toBe("https://example.com/o.png");
  });
});
