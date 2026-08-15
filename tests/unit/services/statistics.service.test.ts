import { describe, expect, it, vi } from "vitest";

import { getOptionStatistics } from "../../../src/services/statistics.service";

function createD1Mock(): D1Database {
  return {
    prepare: vi.fn((sql: string) => {
      const statement = {
        bind: vi.fn(() => statement),
        all: vi.fn(async () => {
          if (sql.includes("FROM survey_questions q")) {
            return {
              results: [
                {
                  question_id: 5,
                  question_title: "选择",
                  question_type: "multiple",
                  option_id: 11,
                  option_label: "A",
                },
                {
                  question_id: 5,
                  question_title: "选择",
                  question_type: "multiple",
                  option_id: 12,
                  option_label: "B",
                },
              ],
            };
          }

          return {
            results: [
              { question_id: 5, json_value: "[11,12]" },
              { question_id: 5, json_value: "[11]" },
              { question_id: 5, json_value: "invalid" },
            ],
          };
        }),
      };
      return statement;
    }),
  } as unknown as D1Database;
}

describe("statistics service", () => {
  it("counts historical JSON option answers from completed responses", async () => {
    const db = createD1Mock();

    const stats = await getOptionStatistics(db, 3);

    expect(stats).toEqual([
      expect.objectContaining({ optionId: 11, count: 2 }),
      expect.objectContaining({ optionId: 12, count: 1 }),
    ]);
    expect(stats[0]?.percentage).toBeCloseTo(66.67, 1);

    const prepare = db.prepare as unknown as ReturnType<typeof vi.fn>;
    const answerQuery = prepare.mock.calls
      .map((call) => String(call[0]))
      .find((sql) => sql.includes("FROM answers a"));
    expect(answerQuery).toContain("r.status = 'completed'");
  });
});
