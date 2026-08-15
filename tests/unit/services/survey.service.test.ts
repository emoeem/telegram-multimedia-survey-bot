import { beforeEach, describe, expect, it, vi } from "vitest";

const repositoryMocks = vi.hoisted(() => ({
  createSurvey: vi.fn(),
  getSurveyById: vi.fn(),
  listSurveysByOwner: vi.fn(),
  createQuestion: vi.fn(),
  createQuestionOption: vi.fn(),
  listOptionsForQuestions: vi.fn(),
  listQuestionsBySurvey: vi.fn(),
}));

vi.mock("../../../src/db/repositories/survey.repository", () => ({
  createSurvey: repositoryMocks.createSurvey,
  getSurveyById: repositoryMocks.getSurveyById,
  listSurveysByOwner: repositoryMocks.listSurveysByOwner,
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
});
