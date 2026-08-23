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
          all: vi.fn(async () => {
            if (sql.includes("FROM question_options")) return { results: [] };
            return { results: [{
              id: 1, response_id: 10, question_id: 1, text_value: "结果名称", number_value: null,
              boolean_value: null, rating_value: null, date_value: null, time_value: null, json_value: null,
              created_at: "now", updated_at: "now",
            }] };
          }),
        };
        return statement;
      }),
    } as unknown as D1Database;

    const prepared = await prepareResultProfileForResponse(db, 10);

    expect(prepared).toMatchObject({ reused: false, profile: { title: "结果名称" } });
  });

  it("maps option ids to labels in the fallback answer list and summary", async () => {
    let profileLookups = 0;
    let insertedMetadata = "{}";
    let insertedTitle: string | null = null;
    const db = {
      prepare: vi.fn((sql: string) => {
        const statement = {
          bind: vi.fn((...args: unknown[]) => {
            if (sql.includes("INSERT INTO result_profiles")) {
              insertedTitle = typeof args[4] === "string" ? args[4] : null;
              insertedMetadata = typeof args[10] === "string" ? args[10] : "{}";
            }
            return statement;
          }),
          run: vi.fn(async () => ({ success: true })),
          first: vi.fn(async () => {
            if (sql.includes("FROM result_profiles")) {
              profileLookups += 1;
              return profileLookups === 1
                ? null
                : { ...existingProfileRow, title: insertedTitle, metadata_json: insertedMetadata };
            }
            if (sql.includes("survey_versions")) return null;
            if (sql.includes("survey_responses")) return {
              id: 10, survey_id: 3, user_id: 4, participant_hash: "hash", status: "completed",
              started_at: "now", completed_at: "now", submitted_at: "now", current_question_id: null,
              version: 1, created_at: "now", updated_at: "now",
            };
            return null;
          }),
          all: vi.fn(async () => {
            if (sql.includes("FROM survey_questions")) {
              return { results: [
                {
                  id: 1, survey_id: 3, type: "single", title: "喜欢的颜色", description: null,
                  required: 1, order: 0, page_id: null, validation_json: null, settings_json: null,
                  parent_question_id: null, condition_json: null, skip_to_question_id: null,
                  created_at: "now", updated_at: "now",
                },
                {
                  id: 2, survey_id: 3, type: "multiple", title: "常用交通方式", description: null,
                  required: 1, order: 1, page_id: null, validation_json: null, settings_json: null,
                  parent_question_id: null, condition_json: null, skip_to_question_id: null,
                  created_at: "now", updated_at: "now",
                },
                {
                  id: 3, survey_id: 3, type: "text", title: "补充说明", description: null,
                  required: 0, order: 2, page_id: null, validation_json: null, settings_json: null,
                  parent_question_id: null, condition_json: null, skip_to_question_id: null,
                  created_at: "now", updated_at: "now",
                },
              ] };
            }
            if (sql.includes("FROM question_options")) {
              return { results: [
                {
                  id: 10, question_id: 1, label: "蓝色", value: "蓝色", order: 0, is_other: 0,
                  created_at: "now", updated_at: "now",
                },
                {
                  id: 11, question_id: 1, label: "绿色", value: "绿色", order: 1, is_other: 0,
                  created_at: "now", updated_at: "now",
                },
                {
                  id: 20, question_id: 2, label: "公交", value: "公交", order: 0, is_other: 0,
                  created_at: "now", updated_at: "now",
                },
                {
                  id: 21, question_id: 2, label: "地铁", value: "地铁", order: 1, is_other: 0,
                  created_at: "now", updated_at: "now",
                },
              ] };
            }
            if (sql.includes("FROM answers")) {
              return { results: [
                {
                  id: 1, response_id: 10, question_id: 1, text_value: null, number_value: null,
                  boolean_value: null, rating_value: null, date_value: null, time_value: null,
                  json_value: JSON.stringify([10]), created_at: "now", updated_at: "now",
                },
                {
                  id: 2, response_id: 10, question_id: 2, text_value: null, number_value: null,
                  boolean_value: null, rating_value: null, date_value: null, time_value: null,
                  json_value: JSON.stringify([20, 21, 999]), created_at: "now", updated_at: "now",
                },
                {
                  id: 3, response_id: 10, question_id: 3, text_value: "就这样", number_value: null,
                  boolean_value: null, rating_value: null, date_value: null, time_value: null,
                  json_value: null, created_at: "now", updated_at: "now",
                },
              ] };
            }
            return { results: [] };
          }),
        };
        return statement;
      }),
    } as unknown as D1Database;

    const prepared = await prepareResultProfileForResponse(db, 10);

    expect(prepared).not.toBeNull();
    expect(prepared!.reused).toBe(false);
    const metadata = JSON.parse(prepared!.profile.metadataJson) as {
      profile: Array<{ label: string; value: string }>;
      summary: string;
    };
    expect(metadata.profile).toEqual([
      { label: "喜欢的颜色", value: "蓝色" },
      { label: "常用交通方式", value: "公交、地铁、999" },
      { label: "补充说明", value: "就这样" },
    ]);
    expect(metadata.summary).toContain("喜欢的颜色：蓝色");
    expect(metadata.summary).toContain("常用交通方式：公交、地铁、999");
    expect(metadata.summary).toContain("补充说明：就这样");
  });
});
