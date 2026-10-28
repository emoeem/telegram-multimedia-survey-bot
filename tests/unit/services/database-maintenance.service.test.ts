import { describe, expect, it, vi } from "vitest";

import {
  MAINTENANCE_ROWS_READ_BUDGET,
  ORPHAN_SWEEP_INDEXES,
  runDatabaseMaintenance,
  syncWeakMediaRefs,
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
  const runBinds: unknown[][] = [];
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
            return {
              results: (options.surveySettings ?? []).map((settings_json, index) => ({
                id: index + 1,
                settings_json,
              })),
              meta,
            };
          }
          return { results: [], meta };
        }),
        run: vi.fn(async () => {
          runBinds.push([...bound]);
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
  return { db, statements, deleted, runBinds };
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
  it("uses the injected clock to expire soft-deleted rows at 30 days", async () => {
    const { db, statements, runBinds } = createMaintenanceDb({
      indexes: ORPHAN_SWEEP_INDEXES.map((index) => index.name),
    });
    const now = Date.parse("2026-08-19T00:00:00.000Z");
    await runDatabaseMaintenance(db, now);
    const cutoff = new Date(now - 30 * 86_400_000).toISOString();
    expect(statements.filter((sql) => sql.includes("deleted_at IS NOT NULL") && sql.includes("LIMIT 50"))).toHaveLength(
      5,
    );
    expect(runBinds.filter((binds) => binds.includes(cutoff)).length).toBeGreaterThanOrEqual(5);
  });

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
      expect.arrayContaining([
        "idx_plaza_posts_image_asset",
        "idx_showcase_persons_illustration_asset",
        "idx_showcase_items_cover_asset",
      ]),
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

  // 阶段 D 双读：写入侧切换后 settings 里出现 {"assetId":n} 结构化引用，
  // 孤儿清扫必须同样认得——否则结构化引用的素材会被当孤儿删掉。
  it("keeps media that survey settings reference via structured {assetId} (dual-read)", async () => {
    const { db, deleted, statements } = createMaintenanceDb({
      indexes: ORPHAN_SWEEP_INDEXES.map((index) => index.name),
      candidates: [41],
      surveySettings: ['{"scene":{"image":{"assetId":41}}}'],
    });
    const summary = await runDatabaseMaintenance(db, Date.parse("2026-08-19T00:00:00.000Z"));
    expect(deleted).toEqual([]);
    expect(summary.orphanAssets).toBe(0);
    // 扫描过滤必须覆盖结构化形态，否则纯 {assetId} 问卷根本不会被读到。
    expect(statements.some((sql) => sql.includes("FROM surveys") && sql.includes('"assetId"'))).toBe(true);
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

  // 阶段 D 双读：syncWeakMediaRefs 必须同时登记 URL 字符串引用（既有数据）
  // 与结构化 {"assetId":n} 引用（写入侧切换后）；裸数字与坏 JSON 不产生假引用。
  it("syncWeakMediaRefs registers both URL-string and structured {assetId} references", async () => {
    const { db, runBinds, statements } = createMaintenanceDb({
      surveySettings: [
        '{"scene":{"image":{"assetId":41}},"customFields":[{"url":"/api/survey/media/22"}]}',
        "not-json media/9",
        '{"volume":80,"bgm":{"assetId":22}}',
      ],
    });
    const synced = await syncWeakMediaRefs(db, () => false);
    // 问卷 1：22（URL）+41（结构化）；问卷 2：9（坏 JSON 走正则兜底）；
    // 问卷 3：22——裸数字 80 不收，结构化 22 正常登记。
    expect(synced).toBe(4);
    const inserted = runBinds.filter((binds) => binds.length === 5).map((binds) => [binds[0], binds[2]] as const);
    expect(inserted).toEqual([
      [22, "survey:1:22"],
      [41, "survey:1:41"],
      [9, "survey:2:9"],
      [22, "survey:3:22"],
    ]);
    expect(statements.some((sql) => sql.includes("FROM surveys") && sql.includes('"assetId"'))).toBe(true);
  });
});
