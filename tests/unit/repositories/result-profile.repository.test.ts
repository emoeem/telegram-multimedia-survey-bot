import { describe, expect, it, vi } from "vitest";

import {
  getSurveyResultRuleSet,
  upsertResultProfile,
} from "../../../src/db/repositories/result-profile.repository";

function createD1Mock(): { db: D1Database; statements: Array<{ sql: string; bindings: unknown[] }> } {
  const statements: Array<{ sql: string; bindings: unknown[] }> = [];
  const db = {
    prepare: vi.fn((sql: string) => {
      const statement = {
        sql,
        bindings: [] as unknown[],
        bind: vi.fn((...bindings: unknown[]) => {
          statement.bindings = bindings;
          return statement;
        }),
        run: vi.fn(async () => ({ success: true })),
        first: vi.fn(async () => {
          if (sql.includes("survey_result_rule_sets")) {
            return { id: 3, survey_id: 7, schema_version: 1, rules_json: "{\"rules\":[]}", created_by: 2, created_at: "now", updated_at: "now" };
          }
          return { id: 9, survey_id: 7, response_id: 8, result_type: "custom", schema_version: 1, title: "A", subtitle: null, fields_json: "{}", stats_json: "[]", tags_json: "[]", images_json: "{}", metadata_json: "{}", created_at: "now", updated_at: "now" };
        }),
      };
      statements.push(statement);
      return statement;
    }),
  } as unknown as D1Database;
  return { db, statements };
}

describe("result profile repository", () => {
  it("maps stored rule sets", async () => {
    const { db } = createD1Mock();
    await expect(getSurveyResultRuleSet(db, 7)).resolves.toMatchObject({ surveyId: 7, schemaVersion: 1 });
  });

  it("upserts one result profile per response", async () => {
    const { db, statements } = createD1Mock();
    const profile = await upsertResultProfile(db, {
      surveyId: 7,
      responseId: 8,
      resultType: "custom",
      schemaVersion: 1,
      title: "A",
      subtitle: null,
      fieldsJson: "{}",
      statsJson: "[]",
      tagsJson: "[]",
      imagesJson: "{}",
      metadataJson: "{}",
    });

    expect(profile.responseId).toBe(8);
    expect(statements.find((statement) => statement.sql.includes("ON CONFLICT(response_id)"))?.bindings.slice(0, 2)).toEqual([7, 8]);
  });
});
