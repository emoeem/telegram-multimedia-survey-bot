import { describe, expect, it } from "vitest";

import { fullMigrationSchema } from "../../helpers/full-schema";
import { createSqliteD1, sqliteD1Available } from "../../helpers/sqlite-d1";
import { runDatabaseMaintenance } from "../../../src/services/database-maintenance.service";

/**
 * export_jobs 卡死 sending 的超时回收（0097，真 SQLite）。
 *
 * 批一引入 sending 阶段值后，维护扫描只清理 completed/failed——消费者渲染完、
 * 占住发送位后死亡且队列重投丢失的 sending 行永远不会被回收。这里钉住回收的
 * 三条语义：未超时不动、超时未记账置 failed、超时已记账（r2_key 存了
 * tg:chatId:messageId = 文件已送达）补 completed 而不是 failed。
 */
const describeIf = sqliteD1Available ? describe : describe.skip;

const NOW = Date.parse("2026-11-13T12:00:00.000Z");

function iso(msAgo: number): string {
  return new Date(NOW - msAgo).toISOString();
}

/** sending 健康窗口 30 分钟；边界样本取 1 分钟前（健康）与 2 小时前（卡死）。 */
const HEALTHY_AGO = 60_000;
const STUCK_AGO = 2 * 60 * 60_000;

describeIf("database maintenance · export_jobs sending 回收", () => {
  async function seedJobs(
    rows: Array<{ id: number; status: string; r2Key: string | null; sendingAt: string | null; createdAt: string }>,
  ): Promise<D1Database> {
    const db = createSqliteD1(fullMigrationSchema());
    await db
      .prepare("INSERT INTO users (id, telegram_user_id, created_at, updated_at) VALUES (1, 1, ?, ?)")
      .bind(iso(3_600_000), iso(3_600_000))
      .run();
    await db
      .prepare("INSERT INTO surveys (id, owner_id, title, created_at, updated_at) VALUES (7, 1, '导出回收种子', ?, ?)")
      .bind(iso(3_600_000), iso(3_600_000))
      .run();
    for (const row of rows) {
      await db
        .prepare(
          "INSERT INTO export_jobs (id, survey_id, requested_by, format, status, r2_key, created_at, completed_at, sending_at) VALUES (?, 7, 1, 'csv', ?, ?, ?, NULL, ?)",
        )
        .bind(row.id, row.status, row.r2Key, row.createdAt, row.sendingAt)
        .run();
    }
    return db;
  }

  async function fetchJob(db: D1Database, id: number) {
    return db
      .prepare("SELECT status, error_message, completed_at FROM export_jobs WHERE id = ?")
      .bind(id)
      .first<{ status: string; error_message: string | null; completed_at: string | null }>();
  }

  it("未超时的 sending 行保持原样", async () => {
    const db = await seedJobs([
      { id: 1, status: "sending", r2Key: null, sendingAt: iso(HEALTHY_AGO), createdAt: iso(HEALTHY_AGO) },
      { id: 2, status: "sending", r2Key: "tg:99:777", sendingAt: iso(HEALTHY_AGO), createdAt: iso(HEALTHY_AGO) },
    ]);

    const summary = await runDatabaseMaintenance(db, NOW);

    expect(summary.reclaimedSendingExportJobs).toBe(0);
    const first = await fetchJob(db, 1);
    expect(first?.status).toBe("sending");
    expect(first?.completed_at).toBeNull();
    const second = await fetchJob(db, 2);
    expect(second?.status).toBe("sending");
  });

  it("超时未记账（r2_key 空）置 failed，超时已记账（文件已送达）补 completed", async () => {
    const db = await seedJobs([
      { id: 1, status: "sending", r2Key: null, sendingAt: iso(STUCK_AGO), createdAt: iso(STUCK_AGO) },
      { id: 2, status: "sending", r2Key: "tg:99:777", sendingAt: iso(STUCK_AGO), createdAt: iso(STUCK_AGO) },
      // 迁移前的遗留行没有 sending_at：按 created_at 回退计时（口径与
      // result-visual 恢复服务对 started_at 空值一致）。
      { id: 3, status: "sending", r2Key: null, sendingAt: null, createdAt: iso(STUCK_AGO) },
      // 非 sending 终态行不受回收步骤影响。
      { id: 4, status: "pending", r2Key: null, sendingAt: null, createdAt: iso(STUCK_AGO) },
    ]);

    const summary = await runDatabaseMaintenance(db, NOW);

    expect(summary.reclaimedSendingExportJobs).toBe(3);
    const failed = await fetchJob(db, 1);
    expect(failed?.status).toBe("failed");
    expect(failed?.error_message).toBe("导出投递超时");
    expect(failed?.completed_at).not.toBeNull();
    const recorded = await fetchJob(db, 2);
    expect(recorded?.status).toBe("completed");
    expect(recorded?.error_message).toBeNull();
    expect(recorded?.completed_at).not.toBeNull();
    // 遗留行（sending_at 为 NULL）按 created_at 回退，同样被回收。
    const legacy = await fetchJob(db, 3);
    expect(legacy?.status).toBe("failed");
    const pending = await fetchJob(db, 4);
    expect(pending?.status).toBe("pending");
  });

  it("回收产出的终态行保留在 retention 窗口内，不会被同一轮扫描删除", async () => {
    const db = await seedJobs([
      { id: 1, status: "sending", r2Key: null, sendingAt: iso(STUCK_AGO), createdAt: iso(STUCK_AGO) },
    ]);

    await runDatabaseMaintenance(db, NOW);

    // 回收把 completed_at 设为本轮 now，远在 30 天 retention 线之内。
    const kept = await fetchJob(db, 1);
    expect(kept?.status).toBe("failed");
    expect(kept?.completed_at).not.toBeNull();
    const total = await db.prepare("SELECT COUNT(*) AS n FROM export_jobs").first<{ n: number }>();
    expect(Number(total?.n ?? 0)).toBe(1);
  });
});
