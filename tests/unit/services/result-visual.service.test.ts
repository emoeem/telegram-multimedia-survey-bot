import { describe, expect, it, vi } from "vitest";

import { prepareResultProfileForResponse } from "../../../src/services/result-visual.service";

const existingProfileRow = {
  id: 20,
  survey_id: 3,
  response_id: 10,
  result_type: "custom",
  schema_version: 1,
  title: "已计算结果",
  subtitle: null,
  fields_json: "{}",
  stats_json: "[]",
  tags_json: "[]",
  images_json: "{}",
  metadata_json: "{}",
  created_at: "now",
  updated_at: "now",
};

describe("result visual orchestration", () => {
  it("reuses an immutable persisted ResultProfile unless recalculation is explicitly requested", async () => {
    const db = {
      prepare: vi.fn(() => {
        const statement = { bind: vi.fn(() => statement), first: vi.fn(async () => existingProfileRow) };
        return statement;
      }),
    } as unknown as D1Database;

    await expect(prepareResultProfileForResponse(db, 10)).resolves.toMatchObject({
      reused: true,
      profile: { id: 20, title: "已计算结果" },
    });
    expect(db.prepare).toHaveBeenCalledTimes(1);
  });

  it("creates a profile from completed answers and declared rules, not in the renderer", async () => {
    let profileLookups = 0;
    const db = {
      prepare: vi.fn((sql: string) => {
        const statement = {
          bind: vi.fn(() => statement),
          run: vi.fn(async () => ({ success: true })),
          first: vi.fn(async () => {
            if (sql.includes("FROM result_profiles")) {
              profileLookups += 1;
              return profileLookups === 1 ? null : { ...existingProfileRow, title: "结果名称" };
            }
            if (sql.includes("survey_responses")) return {
              id: 10, survey_id: 3, user_id: 4, participant_hash: "hash", status: "completed",
              started_at: "now", completed_at: "now", submitted_at: "now", current_question_id: null,
              version: 1, created_at: "now", updated_at: "now",
            };
            if (sql.includes("survey_result_rule_sets")) return {
              id: 1, survey_id: 3, schema_version: 1,
              rules_json: JSON.stringify({ schemaVersion: 1, rules: [{ set: { title: { $from: "answers.1.value" } } }] }),
              created_by: 4, created_at: "now", updated_at: "now",
            };
            return null;
          }),
          all: vi.fn(async () => ({ results: [{
            id: 1, response_id: 10, question_id: 1, text_value: "结果名称", number_value: null,
            boolean_value: null, rating_value: null, date_value: null, time_value: null, json_value: null,
            created_at: "now", updated_at: "now",
          }] })),
        };
        return statement;
      }),
    } as unknown as D1Database;

    const prepared = await prepareResultProfileForResponse(db, 10);

    expect(prepared).toMatchObject({ reused: false, profile: { title: "结果名称" } });
  });
});
