import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSurveyById: vi.fn(),
  listQuestionsBySurvey: vi.fn(),
  exportUnifiedSurveyJson: vi.fn(),
}));

vi.mock("../../../src/db/repositories/survey.repository", () => ({
  getSurveyById: mocks.getSurveyById,
}));

vi.mock("../../../src/db/repositories/question.repository", () => ({
  listQuestionsBySurvey: mocks.listQuestionsBySurvey,
}));

vi.mock("../../../src/services/survey-json.service", () => ({
  exportUnifiedSurveyJson: mocks.exportUnifiedSurveyJson,
}));

import {
  createSurveyVersionSnapshot,
  diffSurveyVersions,
  getLatestSurveyVersionSnapshot,
  getResponseSurveySnapshot,
  getResponseSurveyVersion,
  getSurveyVersionSnapshot,
  listSurveyVersions,
} from "../../../src/services/survey-version.service";

function statementMock(firstRow: unknown) {
  const statement = {
    bind: vi.fn(() => statement),
    run: vi.fn(async () => ({ success: true })),
    first: vi.fn(async () => firstRow),
    all: vi.fn(async () => ({ results: [] })),
  };
  return statement;
}

describe("survey version service", () => {
  it("writes a versioned snapshot on publish", async () => {
    mocks.getSurveyById.mockResolvedValue({ id: 1, version: 3 });
    mocks.listQuestionsBySurvey.mockResolvedValue([
      { id: 10, type: "single", title: "请选择" },
      { id: 20, type: "text", title: "补充" },
    ]);
    mocks.exportUnifiedSurveyJson.mockResolvedValue({
      schema_version: 1,
      survey: { title: "问卷", questions: [] },
    });
    const statement = statementMock(null);
    const db = { prepare: vi.fn(() => statement) } as unknown as D1Database;

    const version = await createSurveyVersionSnapshot(db, 1, 7);

    expect(version).toBe(3);
    expect(statement.bind).toHaveBeenCalledWith(
      1,
      3,
      JSON.stringify({
        schema: { schema_version: 1, survey: { title: "问卷", questions: [] } },
        questionOrderIds: [10, 20],
      }),
      7,
      expect.any(String),
    );
  });

  it("reads a snapshot by survey and version", async () => {
    const snapshot = { schema_version: 1, survey: { title: "旧版", questions: [] } };
    const statement = statementMock({ snapshot_json: JSON.stringify(snapshot) });
    const db = { prepare: vi.fn(() => statement) } as unknown as D1Database;

    await expect(getSurveyVersionSnapshot(db, 1, 2)).resolves.toEqual(snapshot);
    expect(statement.bind).toHaveBeenCalledWith(1, 2);
  });

  it("reads the latest snapshot", async () => {
    const statement = statementMock({ snapshot_json: JSON.stringify({ title: "最新" }) });
    const db = { prepare: vi.fn(() => statement) } as unknown as D1Database;

    await expect(getLatestSurveyVersionSnapshot(db, 1)).resolves.toEqual({ title: "最新" });
  });

  it("returns the version a response was submitted against", async () => {
    const statement = statementMock({ version: 5 });
    const db = { prepare: vi.fn(() => statement) } as unknown as D1Database;

    await expect(getResponseSurveyVersion(db, 42)).resolves.toBe(5);
    expect(statement.bind).toHaveBeenCalledWith(42);
  });

  it("resolves the snapshot a response was submitted against", async () => {
    const statement = statementMock({
      snapshot_json: JSON.stringify({
        schema: { schema_version: 1, survey: { title: "旧版", questions: [] } },
        questionOrderIds: [10, 20],
      }),
    });
    const db = { prepare: vi.fn(() => statement) } as unknown as D1Database;

    await expect(getResponseSurveySnapshot(db, 42)).resolves.toEqual({
      schema: { schema_version: 1, survey: { title: "旧版", questions: [] } },
      questionOrderIds: [10, 20],
    });
  });

  it("lists version summaries", async () => {
    const statement = statementMock(null);
    statement.all = vi.fn(async () => ({
      results: [
        {
          version: 2,
          createdBy: 7,
          createdAt: "2026-08-22T00:00:00.000Z",
          snapshotJson: JSON.stringify({
            schema: {
              schema_version: 1,
              survey: { title: "新版", questions: [{ id: "q1" }, { id: "q2" }] },
            },
            questionOrderIds: [10, 20],
          }),
        },
      ],
    }));
    const db = { prepare: vi.fn(() => statement) } as unknown as D1Database;
    const versions = await listSurveyVersions(db, 1);
    expect(versions).toEqual([
      { version: 2, createdAt: "2026-08-22T00:00:00.000Z", createdBy: 7, title: "新版", questionCount: 2 },
    ]);
  });

  it("diffs two version snapshots", () => {
    const from = {
      schema_version: 1,
      survey: {
        title: "v1",
        pages: [],
        questions: [
          { id: "q1", title: "保持不变", type: "text", options: [] },
          { id: "q2", title: "被删除", type: "single", options: [{ id: "a" }] },
        ],
      },
    } as unknown as Parameters<typeof diffSurveyVersions>[0];
    const to = {
      schema_version: 1,
      survey: {
        title: "v2",
        pages: [],
        questions: [
          { id: "q1", title: "标题改了", type: "text", options: [] },
          { id: "q3", title: "新增题", type: "single", options: [{ id: "a" }, { id: "b" }] },
        ],
      },
    } as unknown as Parameters<typeof diffSurveyVersions>[1];
    const diff = diffSurveyVersions(from, to);
    expect(diff.added).toEqual(["新增题"]);
    expect(diff.removed).toEqual(["被删除"]);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]).toMatchObject({ id: "q1", from: "保持不变", to: "标题改了" });
  });
});
