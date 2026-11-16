import { describe, expect, it, vi } from "vitest";

import {
  MAINTENANCE_INDEXES,
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
  /** MAX(id) 探针返回的表尾 id（默认一个窗口宽，保证单窗口语义）。 */
  maxRowId?: number;
  /** 按 SQL 关键字覆盖 rows_read——用于只在特定语句上烧预算的用例。 */
  rowsReadByKeyword?: Array<[string, number]>;
  /** system_settings 现有键值（游标/健康快照读取走 .first()）。 */
  settings?: Record<string, string>;
}

// 默认表尾 id 恰好等于一个扫描窗口宽：MAX(id) 探针 + 单窗口语句，扫描必然
// "完成"，既有用例的语义与旧实现一致。
const DEFAULT_MAX_ROW_ID = 20_000;

function createMaintenanceDb(options: FakeDbOptions = {}) {
  const statements: string[] = [];
  const deleted: number[] = [];
  const runBinds: unknown[][] = [];
  const allBinds: unknown[][] = [];
  const presentIndexes = new Set(options.indexes ?? []);
  const rowsReadFor = (sql: string): number => {
    for (const [keyword, rows] of options.rowsReadByKeyword ?? []) {
      if (sql.includes(keyword)) return rows;
    }
    return options.rowsReadPerStatement ?? 0;
  };
  const db = {
    prepare: vi.fn((sql: string) => {
      statements.push(sql);
      let bound: unknown[] = [];
      const statement = {
        bind: vi.fn((...args: unknown[]) => {
          bound = args;
          allBinds.push([...bound]);
          return statement;
        }),
        all: vi.fn(async () => {
          const meta = { changes: 0, rows_read: rowsReadFor(sql) };
          if (sql.includes("sqlite_master")) {
            return { results: [...presentIndexes].map((name) => ({ name })), meta };
          }
          // MAX(id) 探针必须先于表名匹配：`SELECT MAX(id) ... FROM answers`
          // 同时包含两者。
          if (sql.includes("MAX(id)")) {
            return { results: [{ max_id: options.maxRowId ?? DEFAULT_MAX_ROW_ID }], meta };
          }
          if (sql.includes("FROM media_assets m")) {
            return { results: (options.candidates ?? []).map((id) => ({ id })), meta };
          }
          if (sql.includes("FROM answers")) {
            return { results: (options.answerJson ?? []).map((value) => ({ value })), meta };
          }
          if (sql.includes("FROM surveys")) {
            return {
              results: (options.surveySettings ?? []).map((value, index) => ({
                id: index + 1,
                value,
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
          return { meta: { changes: 1, rows_read: rowsReadFor(sql) } };
        }),
        // system_settings 的读取走 .first()（游标/健康快照）。
        first: vi.fn(async () => {
          if (sql.includes("system_settings")) {
            const key = String(bound[0] ?? "");
            return options.settings?.[key] !== undefined ? { value: options.settings[key] } : null;
          }
          return null;
        }),
      };
      return statement;
    }),
  } as unknown as D1Database;
  return { db, statements, deleted, runBinds, allBinds };
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
      MAINTENANCE_INDEXES.length,
    );
    expect(statements.some((sql) => sql.includes("FROM media_assets m"))).toBe(true);
  });

  // If the indexes cannot be created the whole run must stay parked — not just
  // the sweep. An unindexed retention DELETE is exactly the 2026-09-14 /
  // 2026-11-16 failure mode; running any step against a missing index is what
  // burned the account's daily budget. 停车还要写健康快照（心跳捎带给 vendor）
  // 并带上缺失清单供停车 DM 直出原因。
  it("parks the whole run (not just the sweep) when required indexes cannot be created", async () => {
    const { db, statements, runBinds } = createMaintenanceDb({
      indexes: [],
      indexCreationIsNoop: true,
      candidates: [31],
    });
    const summary = await runDatabaseMaintenance(db, Date.parse("2026-08-19T00:00:00.000Z"));
    expect(summary.orphanAssets).toBe(0);
    expect(summary.parked).toBe(true);
    expect(summary.parkedMissingIndexes.length).toBeGreaterThan(0);
    expect(statements.some((sql) => sql.includes("FROM media_assets m"))).toBe(false);
    expect(statements.some((sql) => sql.includes("DELETE FROM survey_responses"))).toBe(false);
    // 停车也要落健康快照：客户实例的心跳才能把 parked 状态带给 vendor。
    expect(runBinds.some((binds) => binds[0] === "maintenance_last_summary")).toBe(true);
    const snapshot = JSON.parse(String(runBinds.find((binds) => binds[0] === "maintenance_last_summary")?.[1])) as {
      parked: boolean;
    };
    expect(snapshot.parked).toBe(true);
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

  // 2026-11-16 发现的数据丢失窗口：预算耗尽后保护扫描返回不完整引用集，旧实现
  // 仍照常删除候选——答案 JSON 里还引用着的素材会被误当孤儿删掉。扫描不完整
  // = 本轮一个都不删，等下一个完整运行。
  it("never deletes candidates when a protective scan is truncated by the read budget", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { db, deleted } = createMaintenanceDb({
        indexes: ORPHAN_SWEEP_INDEXES.map((index) => index.name),
        candidates: [21, 22, 23],
        answerJson: ['{"mediaAssetId":21}'],
        maxRowId: 60_000,
        rowsReadByKeyword: [["FROM answers", MAINTENANCE_ROWS_READ_BUDGET + 1]],
      });
      const summary = await runDatabaseMaintenance(db, Date.parse("2026-08-19T00:00:00.000Z"));
      expect(summary.orphanAssets).toBe(0);
      expect(deleted).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(
        "Orphan sweep skipped: a protective scan was truncated by the read budget",
        expect.objectContaining({ candidates: [21, 22, 23].length }),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  // 大表跨窗口：MAX(id) 超过一个窗口宽时扫描必须逐窗推进并在表尾收口，
  // 命中行在窗口间不重复计数（Set 去重），删除语义与单窗口完全一致。
  it("sweeps across rowid windows on large tables and still deletes only true orphans", async () => {
    const { db, deleted, statements } = createMaintenanceDb({
      indexes: ORPHAN_SWEEP_INDEXES.map((index) => index.name),
      candidates: [23],
      answerJson: ['{"mediaAssetId":21}', '{"mediaAssetId":22}'],
      maxRowId: 45_000,
    });
    const summary = await runDatabaseMaintenance(db, Date.parse("2026-08-19T00:00:00.000Z"));
    expect(summary.orphanAssets).toBe(1);
    expect(deleted).toEqual([23]);
    // 窗口谓词是「每条语句有界」的实现载体，必须真实出现在扫描 SQL 里。
    expect(statements.some((sql) => sql.includes("FROM answers") && sql.includes("id > ? AND id <= ?"))).toBe(true);
  });

  // 断点续扫：候选扫描被预算截断时把窗口起点持久化，下一轮从续扫点继续；
  // 扫描完成（或从未跑扫描）则重置为 0，下一轮从头全覆盖。游标只影响候选
  // 扫描起点，正确性（JSON 保护扫描全量 + 截断不删）不受影响。
  it("persists a resume cursor when the candidate scan is truncated and resumes from it next run", async () => {
    const truncatedRun = createMaintenanceDb({
      indexes: ORPHAN_SWEEP_INDEXES.map((index) => index.name),
      candidates: [23],
      maxRowId: 45_000,
      rowsReadByKeyword: [["FROM media_assets m", MAINTENANCE_ROWS_READ_BUDGET + 1]],
    });
    const summary = await runDatabaseMaintenance(truncatedRun.db, Date.parse("2026-08-19T00:00:00.000Z"));
    expect(summary.truncated).toBe(true);
    const cursorBind = truncatedRun.runBinds.find((binds) => binds[0] === "maintenance_sweep_cursor");
    expect(cursorBind).toBeDefined();
    const cursor = JSON.parse(String(cursorBind?.[1])) as { windowStart: number };
    // 第一条候选语句只扫了 [0, 5000]，续扫点应为 5000。
    expect(cursor.windowStart).toBe(5_000);

    const resumedRun = createMaintenanceDb({
      indexes: ORPHAN_SWEEP_INDEXES.map((index) => index.name),
      candidates: [23],
      maxRowId: 45_000,
      settings: {
        maintenance_sweep_cursor: JSON.stringify({ windowStart: 5_000, savedAt: new Date().toISOString() }),
      },
    });
    await runDatabaseMaintenance(resumedRun.db, Date.parse("2026-08-19T00:00:00.000Z"));
    // 续扫轮的第一条候选语句必须从 [5000, 10000] 开始，而不是从头重扫。
    const resumedFirstCandidate = resumedRun.allBinds.find((binds) => binds[0] === 5_000 && binds[1] === 10_000);
    expect(resumedFirstCandidate).toBeDefined();
  });

  // 扫描完成（未截断）时游标必须重置为 0：孤儿可能出现在任何位置，完成的
  // 轮次下一轮要回到全覆盖。
  it("resets the sweep cursor to zero when the candidate scan completes", async () => {
    const { db, runBinds } = createMaintenanceDb({
      indexes: ORPHAN_SWEEP_INDEXES.map((index) => index.name),
      candidates: [23],
      maxRowId: 45_000,
      settings: {
        maintenance_sweep_cursor: JSON.stringify({ windowStart: 5_000, savedAt: new Date().toISOString() }),
      },
    });
    const summary = await runDatabaseMaintenance(db, Date.parse("2026-08-19T00:00:00.000Z"));
    expect(summary.parked).toBe(false);
    const cursorBind = runBinds.find((binds) => binds[0] === "maintenance_sweep_cursor");
    expect(cursorBind?.[1]).toBe("0");
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
