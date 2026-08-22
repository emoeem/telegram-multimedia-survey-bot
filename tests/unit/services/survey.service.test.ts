import { beforeEach, describe, expect, it, vi } from "vitest";

const repositoryMocks = vi.hoisted(() => ({
  createSurvey: vi.fn(),
  getSurveyById: vi.fn(),
  listSurveysByOwner: vi.fn(),
  updateSurveyStatus: vi.fn(),
  createQuestion: vi.fn(),
  createQuestionOption: vi.fn(),
  listOptionsForQuestions: vi.fn(),
  listQuestionsBySurvey: vi.fn(),
  createSurveyVersionSnapshot: vi.fn(),
}));

vi.mock("../../../src/db/repositories/survey.repository", () => ({
  createSurvey: repositoryMocks.createSurvey,
  getSurveyById: repositoryMocks.getSurveyById,
  listSurveysByOwner: repositoryMocks.listSurveysByOwner,
  updateSurveyStatus: repositoryMocks.updateSurveyStatus,
}));

vi.mock("../../../src/services/survey-version.service", () => ({
  createSurveyVersionSnapshot: repositoryMocks.createSurveyVersionSnapshot,
}));

vi.mock("../../../src/db/repositories/question.repository", () => ({
  createQuestion: repositoryMocks.createQuestion,
  createQuestionOption: repositoryMocks.createQuestionOption,
  listOptionsForQuestions: repositoryMocks.listOptionsForQuestions,
  listQuestionsBySurvey: repositoryMocks.listQuestionsBySurvey,
}));

import {
  assertSurveyCanPublish,
  assertSurveyQuestionsEditable,
  duplicateSurvey,
  publishSurvey,
} from "../../../src/services/survey.service";

describe("survey service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repositoryMocks.getSurveyById.mockResolvedValue({
      id: 1,
      title: "问卷",
    });
    repositoryMocks.listQuestionsBySurvey.mockResolvedValue([
      {
        id: 10,
        type: "single",
        title: "请选择",
        order: 0,
      },
    ]);
  });

  it("rejects publishing a choice question with fewer than two options", async () => {
    repositoryMocks.listOptionsForQuestions.mockResolvedValue([
      { id: 101, questionId: 10, label: "唯一选项" },
    ]);

    await expect(
      assertSurveyCanPublish({} as D1Database, 1),
    ).rejects.toThrow("第 1 题至少需要两个选项");
  });

  it("locks question edits after the first response starts", async () => {
    const statement = {
      bind: vi.fn(),
      first: vi.fn(async () => ({ count: 1 })),
    };
    statement.bind.mockReturnValue(statement);
    const db = {
      prepare: vi.fn(() => statement),
    } as unknown as D1Database;

    await expect(
      assertSurveyQuestionsEditable(db, 1),
    ).rejects.toThrow("题目和附件已锁定");
  });

  it("preserves validation and remaps skip-rule ids when duplicating", async () => {
    repositoryMocks.getSurveyById.mockResolvedValue({
      id: 1,
      title: "问卷",
      description: null,
      anonymous: false,
      allowMultipleResponses: false,
      maxResponsesPerUser: 1,
    });
    repositoryMocks.createSurvey.mockResolvedValue({ id: 99, updatedAt: "T2" });
    repositoryMocks.listQuestionsBySurvey.mockResolvedValue([
      {
        id: 10,
        type: "single",
        title: "选择",
        description: null,
        required: true,
        order: 0,
        settingsJson: null,
        validationJson: JSON.stringify({ min_selections: 1 }),
        conditionJson: JSON.stringify({
          kind: "option_equals",
          rules: [{ optionId: 501, targetQuestionId: 20 }],
        }),
        skipToQuestionId: 20,
        parentQuestionId: null,
      },
      {
        id: 20,
        type: "text",
        title: "目标",
        description: null,
        required: false,
        order: 1,
        settingsJson: null,
        validationJson: null,
        conditionJson: null,
        skipToQuestionId: null,
        parentQuestionId: null,
      },
    ]);
    repositoryMocks.listOptionsForQuestions.mockResolvedValue([
      { id: 501, questionId: 10, label: "跳转", value: "跳转" },
    ]);
    repositoryMocks.createQuestion.mockResolvedValueOnce(110).mockResolvedValueOnce(120);
    repositoryMocks.createQuestionOption.mockResolvedValueOnce(1501);
    const bindCalls: unknown[][] = [];
    const statement = {
      bind: vi.fn((...values: unknown[]) => {
        bindCalls.push(values);
        return statement;
      }),
      run: vi.fn(async () => ({ success: true })),
      all: vi.fn(async () => ({ results: [] })),
    };
    const db = { prepare: vi.fn(() => statement) } as unknown as D1Database;

    await duplicateSurvey(db, 1, 7);

    expect(repositoryMocks.createQuestion).toHaveBeenNthCalledWith(
      1,
      db,
      expect.objectContaining({ validationJson: JSON.stringify({ min_selections: 1 }) }),
    );
    const remappedCondition = bindCalls.find((values) => values[4] === 110)?.[0];
    expect(JSON.parse(String(remappedCondition))).toMatchObject({
      rules: [{ optionId: 1501, targetQuestionId: 120 }],
    });
  });

  it("publishes the survey and writes a versioned snapshot", async () => {
    repositoryMocks.getSurveyById.mockResolvedValue({
      id: 1,
      title: "问卷",
      description: null,
      anonymous: false,
      allowMultipleResponses: false,
      maxResponsesPerUser: 1,
    });
    repositoryMocks.listQuestionsBySurvey.mockResolvedValue([
      {
        id: 10,
        type: "single",
        title: "请选择",
        required: true,
        order: 0,
        validationJson: null,
        settingsJson: null,
      },
    ]);
    repositoryMocks.listOptionsForQuestions.mockResolvedValue([
      { id: 101, questionId: 10, label: "A", value: "A" },
      { id: 102, questionId: 10, label: "B", value: "B" },
    ]);
    repositoryMocks.updateSurveyStatus.mockResolvedValue({
      id: 1,
      version: 2,
      status: "published",
      publishedAt: "2026-08-22T00:00:00.000Z",
    });

    const published = await publishSurvey({} as D1Database, 1, 7);

    expect(published.status).toBe("published");
    expect(repositoryMocks.updateSurveyStatus).toHaveBeenCalledWith({} as D1Database, 1, "published");
    expect(repositoryMocks.createSurveyVersionSnapshot).toHaveBeenCalledWith(
      {} as D1Database,
      1,
      7,
    );
  });
});
