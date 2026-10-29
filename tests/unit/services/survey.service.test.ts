import { beforeEach, describe, expect, it, vi } from "vitest";

const repositoryMocks = vi.hoisted(() => ({
  createSurvey: vi.fn(),
  getSurveyById: vi.fn(),
  listSurveysByOwner: vi.fn(),
  updateSurveyStatus: vi.fn(),
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
    repositoryMocks.listOptionsForQuestions.mockResolvedValue([{ id: 101, questionId: 10, label: "唯一选项" }]);

    await expect(assertSurveyCanPublish({} as D1Database, 1)).rejects.toThrow("第 1 题至少需要两个选项");
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

    await expect(assertSurveyQuestionsEditable(db, 1)).rejects.toThrow("题目和附件已锁定");
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

    // 复制的写入走批量 INSERT（batchChunked）：fake db 按语句顺序分配 last_row_id，
    // 并把分配结果挂回语句对象，供断言还原「新题目/新选项 id」。
    interface FakeStatement {
      sql: string;
      bindCalls: unknown[][];
      assignedId?: number;
    }
    const batchCalls: FakeStatement[][] = [];
    let nextRowId = 110;
    const db = {
      prepare: (sql: string) => {
        const statement = {
          sql,
          bindCalls: [] as unknown[][],
          assignedId: undefined as number | undefined,
          bind: (...values: unknown[]) => {
            statement.bindCalls.push(values);
            return statement;
          },
          run: async () => ({ success: true, meta: { changes: 1, last_row_id: 0 } }),
          all: async () => ({ results: [] }),
        };
        return statement;
      },
      batch: async (stmts: FakeStatement[]) => {
        batchCalls.push(stmts);
        return stmts.map((st) => {
          st.assignedId = nextRowId++;
          return { results: [], meta: { changes: 1, last_row_id: st.assignedId } };
        });
      },
    } as unknown as D1Database;

    await duplicateSurvey(db, 1, 7);

    const allBatched = batchCalls.flat();
    const questionInserts = allBatched.filter((st) => st.sql.includes("INSERT INTO survey_questions"));
    expect(questionInserts).toHaveLength(2);
    // validationJson 原样进新题（title 在 bind 的第 3 位）。
    const choice = questionInserts.find((st) => st.bindCalls[0]?.[2] === "选择");
    expect(choice?.bindCalls[0]).toContain(JSON.stringify({ min_selections: 1 }));

    const optionInserts = allBatched.filter((st) => st.sql.includes("INSERT INTO question_options"));
    expect(optionInserts).toHaveLength(1);
    // 选项挂在新「选择」题下；新题目 id 由批量插入的结果链回。
    expect(optionInserts[0]?.bindCalls[0]?.[0]).toBe(choice?.assignedId);
    expect(optionInserts[0]?.bindCalls[0]?.[1]).toBe("跳转");

    const referenceUpdates = allBatched.filter((st) => st.sql.includes("UPDATE survey_questions"));
    expect(referenceUpdates).toHaveLength(1);
    const target = questionInserts.find((st) => st.bindCalls[0]?.[2] === "目标");
    const updateBinds = referenceUpdates[0]!.bindCalls[0]!;
    expect(updateBinds[4]).toBe(choice?.assignedId);
    expect(JSON.parse(String(updateBinds[0]))).toMatchObject({
      rules: [{ optionId: optionInserts[0]!.assignedId, targetQuestionId: target?.assignedId }],
    });
    expect(updateBinds[1]).toBe(target?.assignedId);
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
    expect(repositoryMocks.createSurveyVersionSnapshot).toHaveBeenCalledWith({} as D1Database, 1, 7);
  });
});
