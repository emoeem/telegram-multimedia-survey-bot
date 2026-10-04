import { describe, expect, it, vi } from "vitest";

import {
  MAINTENANCE_ROWS_READ_BUDGET,
  ORPHAN_SWEEP_INDEXES,
  runDatabaseMaintenance,
} from "../../../src/services/database-maintenance.service";

interface FakeDbOptions {
  indexes?: string[];
  /** Simulates a database where CREATE INDEX does not take effect. */
  indexCreationIsNoop?: boolean;
  candidates?: number[];
  answerJson?: string[];
  surveySettings?: string[];
  rowsReadPerStatement?: number;
}

function createMaintenanceDb(options: FakeDbOptions = {}) {
  const statements: string[] = [];
  const deleted: number[] = [];
  const presentIndexes = new Set(options.indexes ?? []);
  const db = {
    prepare: vi.fn((sql: string) => {
      statements.push(sql);
      let bound: unknown[] = [];
      const statement = {
        bind: vi.fn((...args: unknown[]) => {
          bound = args;
          return statement;
        }),
        all: vi.fn(async () => {
          const meta = { changes: 0, rows_read: options.rowsReadPerStatement ?? 0 };
          if (sql.includes("sqlite_master")) {
            return { results: [...presentIndexes].map((name) => ({ name })), meta };
          }
          if (sql.includes("FROM media_assets m")) {
            return { results: (options.candidates ?? []).map((id) => ({ id })), meta };
          }
          if (sql.includes("FROM answers")) {
            return { results: (options.answerJson ?? []).map((json_value) => ({ json_value })), meta };
          }
          if (sql.includes("FROM surveys")) {
            return { results: (options.surveySettings ?? []).map((settings_json) => ({ settings_json })), meta };
          }
          return { results: [], meta };
        }),
        run: vi.fn(async () => {
          if (sql.startsWith("DELETE FROM media_assets WHERE id = ?")) {
            deleted.push(Number(bound[0]));
          }
          const created = /^CREATE INDEX IF NOT EXISTS (\w+)/.exec(sql);
          const createdName = created?.[1];
          if (createdName && !options.indexCreationIsNoop) {
            presentIndexes.add(createdName);
          }
          return { meta: { changes: 1, rows_read: options.rowsReadPerStatement ?? 0 } };
        }),
      };
      return statement;
    }),
  } as unknown as D1Database;
  return { db, statements, deleted };
}

describe("database maintenance", () => {
  it("only issues bounded retention deletes for temporary and orphan data", async () => {
    const { db, statements } = createMaintenanceDb({
      indexes: ORPHAN_SWEEP_INDEXES.map((index) => index.name),
      candidates: [11],
    });
    const summary = await runDatabaseMaintenance(db, Date.parse("2026-08-19T00:00:00.000Z"));
    expect(summary).toMatchObject({
      expiredResponses: 1,
      expiredSurveyDrafts: 1,
      expiredTemplateDrafts: 1,
      expiredGeneratorDrafts: 1,
      orphanAssets: 1,
      expiredAuditLogs: 1,
    });
    expect(statements.some((sql) => sql.includes("status IN ('in_progress', 'cancelled', 'abandoned')"))).toBe(true);
    expect(statements.some((sql) => sql.includes("status = 'completed'") && sql.includes("survey_responses"))).toBe(
      false,
    );
    expect(statements.some((sql) => sql.includes("visual_template_assets"))).toBe(true);
    // The orphan sweep must stay bounded and must not build a LIKE pattern per
    // media row: that pattern was what exhausted the daily D1 rows-read quota.
    expect(statements.some((sql) => sql.includes("FROM media_assets m") && sql.includes("LIMIT ?"))).toBe(true);
    expect(statements.some((sql) => sql.includes("LIKE '%\"mediaAssetId\":'"))).toBe(false);
  });

  // 树洞配图与展示区图片只被 plaza_posts / showcase_* 引用。反连接里漏掉它们，
  // 7 天前的图就会被当成孤儿、连同 KV 字节一起删掉，帖子与展示页直接变破图。
  it("protects plaza and showcase media from the orphan sweep", async () => {
    const { db, statements } = createMaintenanceDb({
      indexes: ORPHAN_SWEEP_INDEXES.map((index) => index.name),
      candidates: [51],
    });
    await runDatabaseMaintenance(db, Date.parse("2026-08-19T00:00:00.000Z"));
    const candidateQuery = statements.find((sql) => sql.includes("FROM media_assets m") && sql.includes("LIMIT ?"));
    expect(candidateQuery).toContain("plaza_posts p WHERE p.image_asset_id = m.id");
    expect(candidateQuery).toContain("showcase_persons");
    expect(candidateQuery).toContain("showcase_items");
    // 这三个索引同时兼作「相关列是否存在」的探针：列缺失时建索引失败，扫描会自我停用。
    expect(ORPHAN_SWEEP_INDEXES.map((index) => index.name)).toEqual(
      expect.arrayContaining(["idx_plaza_posts_image_asset", "idx_showcase_persons_illustration_asset", "idx_showcase_items_cover_asset"]),
    );
  });

  it("keeps media that answers or survey settings still reference", async () => {
    const { db, deleted } = createMaintenanceDb({
      indexes: ORPHAN_SWEEP_INDEXES.map((index) => index.name),
      candidates: [21, 22, 23],
      answerJson: ['{"mediaAssetId":21}', '{"text":"hi"}'],
      surveySettings: ['{"customFields":[{"url":"/api/survey/media/22"}]}'],
    });
    const summary = await runDatabaseMaintenance(db, Date.parse("2026-08-19T00:00:00.000Z"));
    expect(deleted).toEqual([23]);
    expect(summary.orphanAssets).toBe(1);
  });

  // Migration 0051 carries the same indexes, but a deploy can land first. The
  // job creates what is missing instead of depending on run order.
  it("creates the missing read-path indexes before sweeping", async () => {
    const { db, statements } = createMaintenanceDb({ indexes: [], candidates: [31] });
    const summary = await runDatabaseMaintenance(db, Date.parse("2026-08-19T00:00:00.000Z"));
    expect(summary.orphanAssets).toBe(1);
    expect(statements.filter((sql) => sql.startsWith("CREATE INDEX IF NOT EXISTS"))).toHaveLength(
      ORPHAN_SWEEP_INDEXES.length,
    );
    expect(statements.some((sql) => sql.includes("FROM media_assets m"))).toBe(true);
  });

  // If the indexes cannot be created the sweep must stay parked: running it
  // against unindexed columns is what exhausted the daily D1 budget.
  it("skips the orphan sweep when the read-path indexes cannot be created", async () => {
    const { db, statements } = createMaintenanceDb({ indexes: [], indexCreationIsNoop: true, candidates: [31] });
    const summary = await runDatabaseMaintenance(db, Date.parse("2026-08-19T00:00:00.000Z"));
    expect(summary.orphanAssets).toBe(0);
    expect(statements.some((sql) => sql.includes("FROM media_assets m"))).toBe(false);
  });

  // The 2026-09-14 outage happened because one run could spend the account's
  // whole 5M rows/day budget. A runaway query now has to stop at the run-level
  // ceiling instead of taking the bot and the surveys down with it.
  it("stops before the expensive steps once the read budget is spent", async () => {
    const { db, statements } = createMaintenanceDb({
      indexes: ORPHAN_SWEEP_INDEXES.map((index) => index.name),
      candidates: [41],
      rowsReadPerStatement: MAINTENANCE_ROWS_READ_BUDGET,
    });
    const summary = await runDatabaseMaintenance(db, Date.parse("2026-08-19T00:00:00.000Z"));
    expect(summary.truncated).toBe(true);
    expect(summary.rowsRead).toBeGreaterThan(MAINTENANCE_ROWS_READ_BUDGET);
    expect(statements.some((sql) => sql.includes("FROM media_assets m"))).toBe(false);
  });
});
