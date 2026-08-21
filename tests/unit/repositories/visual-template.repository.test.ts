import { describe, expect, it, vi } from "vitest";

import { createVisualTemplateVersion, getVisualTemplateVersion } from "../../../src/db/repositories/visual-template.repository";

function createD1Mock(): { db: D1Database; sql: string[] } {
  const sql: string[] = [];
  const db = {
    prepare: vi.fn((statementSql: string) => {
      sql.push(statementSql);
      const statement = {
        bind: vi.fn(() => statement),
        run: vi.fn(async () => ({ success: true, meta: { last_row_id: 4 } })),
        first: vi.fn(async () => ({
          id: 4,
          template_id: 3,
          version: 2,
          template_schema_version: 1,
          definition_json: "{}",
          variables_json: "[]",
          created_by: 1,
          created_at: "now",
        })),
      };
      return statement;
    }),
    batch: vi.fn(async () => ([{ success: true, meta: { last_row_id: 4 } }])),
  } as unknown as D1Database;
  return { db, sql };
}

describe("visual template repository", () => {
  it("persists immutable versions and advances the current version pointer", async () => {
    const { db, sql } = createD1Mock();
    const version = await createVisualTemplateVersion(db, {
      templateId: 3,
      version: 2,
      templateSchemaVersion: 1,
      definitionJson: "{}",
      variablesJson: "[]",
      createdBy: 1,
    });

    expect(version).toMatchObject({ templateId: 3, version: 2 });
    expect(sql.some((entry) => entry.includes("INSERT INTO visual_template_versions"))).toBe(true);
    expect(sql.some((entry) => entry.includes("current_version"))).toBe(true);
  });

  it("loads a specific template version rather than the mutable template row", async () => {
    const { db } = createD1Mock();
    await expect(getVisualTemplateVersion(db, 3, 2)).resolves.toMatchObject({ templateId: 3, version: 2 });
  });
});
