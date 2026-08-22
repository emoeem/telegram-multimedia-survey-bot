import { beforeEach, describe, expect, it, vi } from "vitest";

const surveyRepositoryMocks = vi.hoisted(() => ({
  createSurvey: vi.fn(),
  deleteSurvey: vi.fn(),
}));

vi.mock("../../../src/db/repositories/survey.repository", () => ({
  createSurvey: surveyRepositoryMocks.createSurvey,
  deleteSurvey: surveyRepositoryMocks.deleteSurvey,
}));

import {
  parseImportedSurvey,
  saveImportedSurvey,
  type ImportedSurvey,
} from "../../../src/services/import.service";

interface StatementMock {
  sql: string;
  bindings: unknown[];
  bind: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
}

function createD1Mock(batchError?: Error): {
  db: D1Database;
  statements: StatementMock[];
  batch: ReturnType<typeof vi.fn>;
} {
  const statements: StatementMock[] = [];
  const prepare = vi.fn((sql: string) => {
    const statement: StatementMock = {
      sql,
      bindings: [],
      bind: vi.fn((...bindings: unknown[]) => {
        statement.bindings = bindings;
        return statement;
      }),
      run: vi.fn(async () => ({ success: true, meta: { last_row_id: 300 } })),
    };
    statements.push(statement);
    return statement;
  });
  const batch = batchError
    ? vi.fn(async () => {
        throw batchError;
      })
    : vi.fn(async () => []);

  return {
    db: { prepare, batch } as unknown as D1Database,
    statements,
    batch,
  };
}

function importedSurvey(): ImportedSurvey {
  return {
    title: "导入问卷",
    questions: [
      {
        type: "single",
        title: "请选择",
        options: [
          {
            label: "选项一",
            value: "选项一",
            media: [
              {
                id: "option-image",
                type: "photo",
                source: "url",
                url: "data:image/png;base64,YQ==",
              },
            ],
          },
          {
            label: "选项二",
            value: "选项二",
            media: [],
          },
        ],
        media: [
          {
            id: "question-image",
            type: "photo",
            source: "url",
            url: "data:image/png;base64,Yg==",
          },
        ],
      },
    ],
  };
}

describe("import service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    surveyRepositoryMocks.createSurvey.mockResolvedValue({
      id: 41,
      ownerId: 7,
      title: "导入问卷",
      status: "draft",
    });
  });

  it("prefers option text and keeps question and option media", () => {
    const parsed = parseImportedSurvey(
      JSON.stringify({
        title: "PDF 问卷",
        questions: [
          {
            type: "single",
            title: "请选择",
            media: [
              {
                type: "photo",
                source: "url",
                url: "data:image/png;base64,YQ==",
              },
            ],
            options: [
              {
                label: "A",
                text: "实际选项正文",
                value: "实际选项正文",
                media: [
                  {
                    type: "audio",
                    source: "url",
                    url: "https://example.test/audio.mp3",
                  },
                ],
              },
              {
                label: "B",
                text: "第二个选项",
                value: "第二个选项",
              },
            ],
          },
        ],
      }),
    );

    expect(parsed.questions[0]?.options?.[0]?.label).toBe("实际选项正文");
    expect(parsed.questions[0]?.media?.[0]?.type).toBe("photo");
    expect(parsed.questions[0]?.options?.[0]?.media[0]?.type).toBe("audio");
  });

  it("repairs a choice containing only the Forms other field", () => {
    const parsed = parseImportedSurvey(
      JSON.stringify({
        schema_version: 1,
        survey: {
          title: "PDF 问卷",
          questions: [
            {
              id: "q1",
              type: "single",
              title: "补充信息",
              required: true,
              options: [
                {
                  id: "q1_o1",
                  label: "1",
                  text: "其他",
                  value: "其他",
                  media: [
                    {
                      type: "photo",
                      source: "url",
                      url: "data:image/png;base64,YQ==",
                    },
                  ],
                },
              ],
              media: [],
            },
          ],
        },
      }),
    );

    expect(parsed.questions[0]?.type).toBe("text");
    expect(parsed.questions[0]?.options).toEqual([]);
    expect(parsed.questions[0]?.media?.[0]?.type).toBe("photo");
    expect(parsed.importWarnings).toEqual([
      "第 1 题“补充信息”只有“其他”填写项，已自动转为文本题",
    ]);
  });

  it("splits two short options that PDF extraction joined with a line break", () => {
    const parsed = parseImportedSurvey(
      JSON.stringify({
        title: "换行选项",
        questions: [
          {
            type: "single",
            title: "是否继续",
            options: [{ label: "是\n还没有", value: "是\n还没有" }],
          },
        ],
      }),
    );

    expect(parsed.questions[0]?.type).toBe("single");
    expect(parsed.questions[0]?.options?.map((option) => option.label)).toEqual([
      "是",
      "还没有",
    ]);
    expect(parsed.importWarnings).toEqual([
      "第 1 题“是否继续”检测到两个被换行合并的选项，已自动拆分",
    ]);
  });

  it("converts an ambiguous long singleton option to text and preserves it", () => {
    const longOption = `是
这是被 PDF 识别到的长选项正文，不能按换行拆成多个选项。`;
    const parsed = parseImportedSurvey(
      JSON.stringify({
        title: "长选项",
        questions: [
          {
            type: "single",
            title: "请回答",
            options: [{ label: longOption, value: longOption }],
          },
        ],
      }),
    );

    expect(parsed.questions[0]?.type).toBe("text");
    expect(parsed.questions[0]?.options).toEqual([]);
    expect(parsed.questions[0]?.description).toContain(
      "导入识别到的原选项内容：",
    );
    expect(parsed.questions[0]?.description).toContain(
      "不能按换行拆成多个选项",
    );
    expect(parsed.importWarnings).toEqual([
      "第 1 题“请回答”可识别选项不足两个，已自动转为文本题，请检查题目",
    ]);
  });

  it("converts a choice with no recognized options instead of rejecting the import", () => {
    const parsed = parseImportedSurvey(
      JSON.stringify({
        title: "缺少选项",
        questions: [
          {
            type: "multiple",
            title: "请选择",
            options: [],
          },
        ],
      }),
    );

    expect(parsed.questions[0]?.type).toBe("text");
    expect(parsed.questions[0]?.options).toEqual([]);
    expect(parsed.importWarnings).toEqual([
      "第 1 题“请选择”可识别选项不足两个，已自动转为文本题，请检查题目",
    ]);
  });

  it("saves a large import through a small batch of JSON1 statements", async () => {
    const { db, statements, batch } = createD1Mock();
    let activeResolvers = 0;
    let maxActiveResolvers = 0;
    const resolver = vi.fn(async (media: { id?: string }) => {
      activeResolvers += 1;
      maxActiveResolvers = Math.max(maxActiveResolvers, activeResolvers);
      await new Promise((resolve) => setTimeout(resolve, 1));
      activeResolvers -= 1;
      return {
        type: "photo" as const,
        source: "telegram" as const,
        telegramFileId: `telegram-${media.id}`,
      };
    });

    const surveyId = await saveImportedSurvey(
      db,
      7,
      importedSurvey(),
      resolver,
    );

    expect(surveyId).toBe(41);
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(maxActiveResolvers).toBe(1);
    expect(batch).toHaveBeenCalledOnce();
    expect(statements).toHaveLength(5);
    expect(statements.every((statement) =>
      statement.sql.includes("json_each"),
    )).toBe(true);
    expect(surveyRepositoryMocks.deleteSurvey).not.toHaveBeenCalled();
  });

  it("removes the partial survey when the batch fails", async () => {
    const { db } = createD1Mock(new Error("D1 batch failed"));

    await expect(
      saveImportedSurvey(db, 7, {
        title: "失败导入",
        questions: [
          {
            type: "text",
            title: "问题",
            options: [],
            media: [],
          },
        ],
      }),
    ).rejects.toThrow("D1 batch failed");

    expect(surveyRepositoryMocks.deleteSurvey).toHaveBeenCalledWith(db, 41);
  });

  it("persists URL media and page structure without a resolver", async () => {
    const { db, statements, batch } = createD1Mock();
    const surveyId = await saveImportedSurvey(db, 7, {
      title: "带分页问卷",
      pages: [
        { id: "cover-page", title: "第一页", description: "开始" },
        { id: "main-page", title: "主体" },
      ],
      questions: [
        {
          type: "single",
          title: "请选择",
          pageId: "cover-page",
          options: [
            { label: "A", value: "A", media: [] },
            {
              label: "B",
              value: "B",
              media: [
                {
                  id: "b-media",
                  type: "photo",
                  source: "url",
                  url: "https://example.com/b.png",
                  mimeType: "image/png",
                },
              ],
            },
          ],
          media: [
            {
              id: "q-media",
              type: "photo",
              source: "url",
              url: "https://example.com/q.png",
            },
          ],
        },
      ],
    });

    expect(surveyId).toBe(41);

    const pageInsert = statements.find((statement) =>
      statement.sql.includes("INSERT INTO survey_pages"),
    );
    expect(pageInsert).toBeDefined();
    expect(pageInsert?.bindings.slice(1, 4)).toEqual([
      "第一页",
      "开始",
      0,
    ]);

    const questionInsert = statements.find((statement) =>
      statement.sql.includes("INSERT INTO survey_questions"),
    );
    expect(questionInsert?.sql).toContain("page_id");

    const mediaInsert = statements.find((statement) =>
      statement.sql.includes("INSERT INTO media_assets"),
    );
    expect(mediaInsert?.sql).toContain("url");
    const mediaBindings = JSON.parse(String(mediaInsert?.bindings[2])) as Array<Record<string, unknown>>;
    expect(mediaBindings).toHaveLength(2);
    expect(mediaBindings.map((row) => row.url)).toEqual([
      "https://example.com/q.png",
      "https://example.com/b.png",
    ]);

    const questionMediaInsert = statements.find((statement) =>
      statement.sql.includes("INSERT INTO question_media"),
    );
    expect(questionMediaInsert?.sql).toContain("mediaKey");
    expect(JSON.parse(String(questionMediaInsert?.bindings[1]))).toEqual([
      { questionOrder: 0, mediaKey: "https://example.com/q.png", sortOrder: 0 },
    ]);

    expect(batch).toHaveBeenCalledOnce();
  });
});
