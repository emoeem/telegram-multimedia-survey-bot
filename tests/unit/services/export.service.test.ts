import { describe, expect, it, vi } from "vitest";

import {
  buildCsv,
  buildExportZip,
  buildXlsx,
  getExportRows,
  type ResponseRow,
} from "../../../src/services/export.service";

describe("export service", () => {
  it("builds CSV from response rows", () => {
    const csv = buildCsv([
      {
        response_id: 1,
        status: "completed",
        started_at: "2026-08-14T00:00:00.000Z",
        completed_at: "2026-08-14T00:01:00.000Z",
        "你的名字？": "Alice",
      },
    ]);

    expect(csv).toContain("response_id");
    expect(csv).toContain('"Alice"');
  });

  it("builds a zip export", () => {
    const csv = "id,name\n1,Alice";
    const zip = buildExportZip(csv, [
      {
        response_id: 1,
        status: "completed",
        started_at: "2026-08-14T00:00:00.000Z",
        completed_at: null,
      } as ResponseRow,
    ]);

    expect(zip.length).toBeGreaterThan(0);
  });

  it("builds an xlsx export", () => {
    const rows: ResponseRow[] = [
      {
        response_id: 1,
        status: "completed",
        started_at: "2026-08-14T00:00:00.000Z",
        completed_at: null,
      },
    ];

    const xlsx = buildXlsx(rows);
    expect(xlsx.byteLength).toBeGreaterThan(0);
  });

  it("maps historical option ids to labels and preserves duplicate question titles", async () => {
    const db = {
      prepare: vi.fn((sql: string) => {
        const statement = {
          bind: vi.fn(() => statement),
          all: vi.fn(async () => {
            if (sql.includes("FROM survey_questions")) {
              return {
                results: [
                  { id: 10, title: "重复题目", type: "multiple" },
                  { id: 20, title: "重复题目", type: "text" },
                ],
              };
            }
            if (sql.includes("FROM question_options")) {
              return {
                results: [
                  { id: 101, label: "选项 A" },
                  { id: 102, label: "选项 B" },
                ],
              };
            }
            if (
              sql.includes(
                "SELECT id AS response_id, status, started_at, completed_at",
              )
            ) {
              return {
                results: [
                  {
                    response_id: 1,
                    status: "completed",
                    started_at: "2026-08-14T00:00:00.000Z",
                    completed_at: "2026-08-14T00:01:00.000Z",
                  },
                ],
              };
            }
            return {
              results: [
                {
                  response_id: 1,
                  question_id: 10,
                  text_value: null,
                  number_value: null,
                  boolean_value: null,
                  rating_value: null,
                  date_value: null,
                  time_value: null,
                  json_value: "[101,102]",
                  selected_options: null,
                },
                {
                  response_id: 1,
                  question_id: 20,
                  text_value: "文本答案",
                  number_value: null,
                  boolean_value: null,
                  rating_value: null,
                  date_value: null,
                  time_value: null,
                  json_value: null,
                  selected_options: null,
                },
              ],
            };
          }),
        };
        return statement;
      }),
    } as unknown as D1Database;

    const result = await getExportRows(db, 3);

    expect(result.rows[0]?.["重复题目 (#10)"]).toBe("选项 A | 选项 B");
    expect(result.rows[0]?.["重复题目 (#20)"]).toBe("文本答案");
  });

  it("loads option labels in D1-safe batches for large surveys", async () => {
    const optionBindBatches: unknown[][] = [];
    const questions = Array.from({ length: 181 }, (_, index) => ({
      id: index + 1,
      title: `题目 ${index + 1}`,
      type: "single",
    }));
    const db = {
      prepare: vi.fn((sql: string) => {
        const statement = {
          bind: vi.fn((...values: unknown[]) => {
            if (sql.includes("FROM question_options")) optionBindBatches.push(values);
            return statement;
          }),
          all: vi.fn(async () => {
            if (sql.includes("FROM survey_questions")) return { results: questions };
            if (sql.includes("FROM question_options")) return { results: [] };
            return { results: [] };
          }),
        };
        return statement;
      }),
    } as unknown as D1Database;

    await getExportRows(db, 3);

    expect(optionBindBatches).toHaveLength(3);
    expect(optionBindBatches.map((batch) => batch.length)).toEqual([90, 90, 1]);
  });

  it("formats matrix answers as row and column labels", async () => {
    const db = {
      prepare: vi.fn((sql: string) => {
        const statement = {
          bind: vi.fn(() => statement),
          all: vi.fn(async () => {
            if (sql.includes("FROM survey_questions")) return { results: [{ id: 10, title: "满意度", type: "matrix", settings_json: '{"columns":["满意","一般"]}' }] };
            if (sql.includes("FROM question_options")) return { results: [{ id: 101, label: "响应速度" }] };
            if (sql.includes("SELECT id AS response_id")) return { results: [{ response_id: 1, status: "completed", started_at: "", completed_at: "" }] };
            return { results: [{ response_id: 1, question_id: 10, text_value: null, number_value: null, boolean_value: null, rating_value: null, date_value: null, time_value: null, json_value: '{"kind":"matrix","selections":{"101":0}}', selected_options: null }] };
          }),
        };
        return statement;
      }),
    } as unknown as D1Database;

    const result = await getExportRows(db, 3);
    expect(result.rows[0]?.["满意度"]).toBe("响应速度：满意");
  });
});
