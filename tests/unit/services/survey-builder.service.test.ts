import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SurveyBuilderState } from "../../../src/durable-objects/survey-builder";

const repositoryMocks = vi.hoisted(() => ({
  createSurvey: vi.fn(),
  getLatestDraftSurveyByOwner: vi.fn(),
  getSurveyById: vi.fn(),
  updateDraftSurvey: vi.fn(),
  createQuestion: vi.fn(),
  createQuestionOption: vi.fn(),
  listOptionsForQuestions: vi.fn(),
  listQuestionsBySurvey: vi.fn(),
  createOptionMedia: vi.fn(),
  createQuestionMedia: vi.fn(),
  getOptionMediaByOptionId: vi.fn(),
  getQuestionMediaByQuestionId: vi.fn(),
}));

vi.mock("../../../src/db/repositories/survey.repository", () => ({
  createSurvey: repositoryMocks.createSurvey,
  getLatestDraftSurveyByOwner: repositoryMocks.getLatestDraftSurveyByOwner,
  getSurveyById: repositoryMocks.getSurveyById,
  updateDraftSurvey: repositoryMocks.updateDraftSurvey,
}));

vi.mock("../../../src/db/repositories/question.repository", () => ({
  createQuestion: repositoryMocks.createQuestion,
  createQuestionOption: repositoryMocks.createQuestionOption,
  listOptionsForQuestions: repositoryMocks.listOptionsForQuestions,
  listQuestionsBySurvey: repositoryMocks.listQuestionsBySurvey,
}));

vi.mock("../../../src/db/repositories/media.repository", () => ({
  createOptionMedia: repositoryMocks.createOptionMedia,
  createQuestionMedia: repositoryMocks.createQuestionMedia,
  getOptionMediaByOptionId: repositoryMocks.getOptionMediaByOptionId,
  getQuestionMediaByQuestionId: repositoryMocks.getQuestionMediaByQuestionId,
}));

import {
  finishOptions,
  saveDraftSurvey,
} from "../../../src/services/survey-builder.service";
import type { SurveyBuilderNamespace } from "../../../src/services/survey-builder.service";

function createBuilderState(
  overrides: Partial<SurveyBuilderState> = {},
): SurveyBuilderState {
  return {
    userId: 99,
    step: "question_type",
    activeDraft: true,
    surveyTitle: "媒体问卷",
    surveyDescription: "描述",
    currentQuestionType: null,
    currentQuestionTitle: "",
    currentQuestionRequired: true,
    currentOptions: [],
    currentMatrixColumns: [],
    currentMediaAssetId: null,
    targetOptionId: null,
    targetQuestionId: null,
    targetSurveyId: null,
    draftSurveyId: null,
    suspendedStep: null,
    questions: [
      {
        type: "multiple",
        title: "请选择",
        required: true,
        mediaAssetId: 501,
        options: [
          { label: "选项 A", mediaAssetId: 601 },
          { label: "选项 B", mediaAssetId: null },
        ],
      },
    ],
    updatedAt: "2026-08-14T00:00:00.000Z",
    ...overrides,
  };
}

function createDbMock(): D1Database {
  const statement = {
    bind: vi.fn(),
    run: vi.fn(async () => ({ success: true })),
  };
  statement.bind.mockReturnValue(statement);

  return {
    prepare: vi.fn(() => statement),
  } as unknown as D1Database;
}

describe("survey builder service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repositoryMocks.createSurvey.mockResolvedValue({
      id: 12,
      ownerId: 7,
      status: "draft",
    });
    repositoryMocks.createQuestion.mockResolvedValue(21);
    repositoryMocks.createQuestionOption
      .mockResolvedValueOnce(31)
      .mockResolvedValueOnce(32);
  });

  it("persists question media and option media with the draft", async () => {
    const surveyId = await saveDraftSurvey(
      createDbMock(),
      createBuilderState(),
      7,
    );

    expect(surveyId).toBe(12);
    expect(repositoryMocks.createQuestionMedia).toHaveBeenCalledWith(
      expect.anything(),
      { questionId: 21, mediaAssetId: 501 },
    );
    expect(repositoryMocks.createOptionMedia).toHaveBeenCalledWith(
      expect.anything(),
      { questionOptionId: 31, mediaAssetId: 601 },
    );
    expect(repositoryMocks.createQuestionOption).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      {
        questionId: 21,
        label: "选项 B",
        value: "选项 B",
        order: 1,
      },
    );
  });

  it("updates an existing draft instead of creating a duplicate", async () => {
    repositoryMocks.getSurveyById.mockResolvedValue({
      id: 12,
      ownerId: 7,
      status: "draft",
    });
    const db = createDbMock();

    const surveyId = await saveDraftSurvey(
      db,
      createBuilderState({ draftSurveyId: 12 }),
      7,
    );

    expect(surveyId).toBe(12);
    expect(repositoryMocks.createSurvey).not.toHaveBeenCalled();
    expect(repositoryMocks.updateDraftSurvey).toHaveBeenCalledWith(
      db,
      {
        id: 12,
        ownerId: 7,
        title: "媒体问卷",
        description: "描述",
      },
    );
    expect(db.prepare).toHaveBeenCalledWith(
      "DELETE FROM survey_questions WHERE survey_id = ?",
    );
  });

  it("turns a builder 400 into a useful validation error", async () => {
    const namespace = {
      idFromName: vi.fn(() => ({ id: "builder-id" })),
      get: vi.fn(() => ({
        fetch: vi.fn(async () =>
          Response.json(
            { error: "choice_options_incomplete" },
            { status: 400 },
          ),
        ),
      })),
    } as unknown as SurveyBuilderNamespace;

    await expect(finishOptions(namespace, 99)).rejects.toThrow(
      "单选题或多选题至少需要两个选项",
    );
  });
});
