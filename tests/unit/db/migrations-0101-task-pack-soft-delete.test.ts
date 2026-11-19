import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import { sqliteD1Available } from "../../helpers/sqlite-d1";

/**
 * 迁移 0101（B3 · task_packs 软删/墓碑）：0045_trial_tasks.sql:20/:38 的
 * task_items/task_runs 外键均 ON DELETE CASCADE 且 D1 强制外键（0034 迁移
 * 注释为证），硬删父包会级联清空对局历史。本测试在本地 SQLite 复现环境验证：
 * ① 0101 在迁移链之上可跑通，task_packs 出现 deleted_at 列；
 * ② 墓碑局部索引（WHERE deleted_at IS NULL）真实存在；
 * ③ 硬删（旧行为）确实级联清空 task_items/task_runs——迁移动机成立；
 * ④ 软删（新行为，UPDATE 打墓碑）后 task_items/task_runs 行数不变。
 */
const TRIAL_CHAIN = ["0045_trial_tasks.sql"].map((file) =>
  readFileSync(new URL(`../../../db/migrations/${file}`, import.meta.url), "utf8"),
);

const MIGRATION_0101 = readFileSync(
  new URL("../../../db/migrations/0101_task_pack_soft_delete.sql", import.meta.url),
  "utf8",
);

const require = createRequire(import.meta.url);
function loadSqlite() {
  return sqliteD1Available ? (require("node:sqlite") as typeof import("node:sqlite")) : null;
}

describe.skipIf(!sqliteD1Available)("migration 0101 (task pack soft delete)", () => {
  it("跑通并出现 deleted_at 列与墓碑局部索引；软删保留 task_items/task_runs，硬删才会级联", () => {
    const sqlite = loadSqlite();
    if (!sqlite) throw new Error("node:sqlite unavailable");
    const db = new sqlite.DatabaseSync(":memory:");
    // 最小 users 表：task_runs.user_id 外键引用（测试只种 NULL，不挂用户）。
    db.exec(
      `CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '');`,
    );
    db.exec(`PRAGMA foreign_keys = ON;\n${TRIAL_CHAIN.join("\n")}`);
    db.exec(MIGRATION_0101);

    // 1) task_packs 出现 deleted_at 列（TEXT，可空）。
    const columns = db.prepare(`PRAGMA table_info(task_packs)`).all() as Array<{
      name: string;
      type: string;
      notnull: number;
    }>;
    const deletedAt = columns.find((column) => column.name === "deleted_at");
    expect(deletedAt).toBeTruthy();
    expect(deletedAt?.type).toBe("TEXT");
    expect(deletedAt?.notnull).toBe(0);

    // 2) 墓碑局部索引真实存在，且谓词是 WHERE deleted_at IS NULL（只索引活跃行）。
    const index = db
      .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_task_packs_active_list'`)
      .get() as {
      name: string;
      sql: string;
    };
    expect(index?.sql).toContain("WHERE deleted_at IS NULL");

    // 3) 动机复现：硬删父包在 ON DELETE CASCADE + foreign_keys=ON 下级联清空
    //    task_items/task_runs（这就是 0101 要止血的行为）。
    //    0045 种子包 id=1（楼道挑战）；给它种 1 条对局。
    db.exec(
      `INSERT INTO task_runs (pack_id, participant_hash, persona, mode, state_json, started_at, updated_at)
       VALUES (1, 'hash_victim', 'any', 'normal', '{}', '2026-11-19T00:00:00.000Z', '2026-11-19T00:00:00.000Z')`,
    );
    const itemsBefore = Number(
      (db.prepare(`SELECT COUNT(*) AS n FROM task_items WHERE pack_id = 1`).get() as { n: number }).n,
    );
    expect(itemsBefore).toBeGreaterThan(0);
    db.exec("BEGIN");
    db.exec("DELETE FROM task_packs WHERE id = 1");
    db.exec("COMMIT");
    expect(
      Number((db.prepare(`SELECT COUNT(*) AS n FROM task_items WHERE pack_id = 1`).get() as { n: number }).n),
    ).toBe(0);
    expect(Number((db.prepare(`SELECT COUNT(*) AS n FROM task_runs WHERE pack_id = 1`).get() as { n: number }).n)).toBe(
      0,
    );

    // 4) 新行为：软删只打墓碑，子行原样保留。重建 0045 链再验证（同一连接
    //    里包 1 已被硬删，用种子包 id=2 走软删 UPDATE——与仓库层同一条 SQL）。
    db.exec(
      `INSERT INTO task_runs (pack_id, participant_hash, persona, mode, state_json, started_at, updated_at)
       VALUES (2, 'hash_soft', 'any', 'normal', '{}', '2026-11-19T00:00:00.000Z', '2026-11-19T00:00:00.000Z')`,
    );
    const itemsPack2 = Number(
      (db.prepare(`SELECT COUNT(*) AS n FROM task_items WHERE pack_id = 2`).get() as { n: number }).n,
    );
    expect(itemsPack2).toBeGreaterThan(0);
    db.exec("BEGIN");
    db.prepare(
      `UPDATE task_packs SET deleted_at = '2026-11-20T00:00:00.000Z' WHERE id = 2 AND deleted_at IS NULL`,
    ).run();
    db.exec("COMMIT");
    // 软删不丢任何子行：task_items/task_runs 与删除前一致。
    expect(
      Number((db.prepare(`SELECT COUNT(*) AS n FROM task_items WHERE pack_id = 2`).get() as { n: number }).n),
    ).toBe(itemsPack2);
    expect(Number((db.prepare(`SELECT COUNT(*) AS n FROM task_runs WHERE pack_id = 2`).get() as { n: number }).n)).toBe(
      1,
    );
    // 幂等护栏：WHERE deleted_at IS NULL 使重复删除不再变更（changes=0）。
    const second = db
      .prepare(`UPDATE task_packs SET deleted_at = '2026-11-20T00:00:00.000Z' WHERE id = 2 AND deleted_at IS NULL`)
      .run();
    expect(Number(second.changes)).toBe(0);
    db.close();
  });
});
