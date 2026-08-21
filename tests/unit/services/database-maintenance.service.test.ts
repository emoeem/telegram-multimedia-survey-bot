import { describe, expect, it, vi } from "vitest";

import { runDatabaseMaintenance } from "../../../src/services/database-maintenance.service";

describe("database maintenance", () => {
  it("only issues bounded retention deletes for temporary and orphan data", async () => {
    const statements: string[] = [];
    const db = {
      prepare: vi.fn((sql: string) => {
        statements.push(sql);
        const statement = { bind: vi.fn(() => statement), run: vi.fn(async () => ({ meta: { changes: 1 } })) };
        return statement;
      }),
    } as unknown as D1Database;
    const summary = await runDatabaseMaintenance(db, Date.parse("2026-08-19T00:00:00.000Z"));
    expect(summary).toMatchObject({ expiredResponses: 1, expiredSurveyDrafts: 1, expiredTemplateDrafts: 1, expiredGeneratorDrafts: 1, orphanAssets: 1, expiredAuditLogs: 1 });
    expect(statements.some((sql) => sql.includes("status IN ('in_progress', 'cancelled', 'abandoned')"))).toBe(true);
    expect(statements.some((sql) => sql.includes("status = 'completed'") && sql.includes("survey_responses"))).toBe(false);
    expect(statements.some((sql) => sql.includes("visual_template_assets"))).toBe(true);
    expect(statements.some((sql) => sql.includes("mediaAssetId"))).toBe(true);
  });
});
