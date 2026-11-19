import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import { sqliteD1Available } from "../../helpers/sqlite-d1";

/**
 * 迁移 0102（0101 软删配套 · 名称唯一索引改局部）：0100 给 task_packs(name)
 * 加的是全量唯一索引，0101 软删后墓碑仍占名——删包后重建同名包在建包 INSERT
 * 上抛 UNIQUE（经管理端兜底成 500）。本测试验证：
 * ① 0102 把 idx_task_packs_name 重建为 WHERE deleted_at IS NULL 的局部唯一索引；
 * ② 活跃行同名仍互斥（0100 防 0049 裸 INSERT 重放的种子守卫保持成立）；
 * ③ 墓碑不占名：包软删后可插入同名活跃行；
 * ④ 迁移幂等可重放（DROP + CREATE IF NOT EXISTS）。
 */
const CHAIN = ["0045_trial_tasks.sql", "0100_k9_task_pack_dedup.sql", "0101_task_pack_soft_delete.sql"]
  .map((file) => readFileSync(new URL(`../../../db/migrations/${file}`, import.meta.url), "utf8"))
  .join("\n");

const MIGRATION_0102 = readFileSync(
  new URL("../../../db/migrations/0102_task_pack_name_reuse.sql", import.meta.url),
  "utf8",
);

const require = createRequire(import.meta.url);
function loadSqlite() {
  return sqliteD1Available ? (require("node:sqlite") as typeof import("node:sqlite")) : null;
}

describe.skipIf(!sqliteD1Available)("migration 0102 (task pack name reuse)", () => {
  it("名称唯一索引改为仅活跃行：活跃同名仍拒绝、墓碑释放名称、幂等可重放", () => {
    const sqlite = loadSqlite();
    if (!sqlite) throw new Error("node:sqlite unavailable");
    const db = new sqlite.DatabaseSync(":memory:");
    // 最小 users 表：task_runs.user_id 外键引用（测试只种 NULL，不挂用户）。
    db.exec(
      `CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '');`,
    );
    db.exec(`PRAGMA foreign_keys = ON;\n${CHAIN}`);
    db.exec("BEGIN");
    db.exec(MIGRATION_0102);
    db.exec("COMMIT");

    // 1) 索引仍是 UNIQUE，但谓词带 WHERE deleted_at IS NULL。
    const index = db
      .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_task_packs_name'`)
      .get() as { name: string; sql: string };
    expect(index?.sql).toContain("UNIQUE INDEX");
    expect(index?.sql).toContain("WHERE deleted_at IS NULL");

    // 2) 活跃行同名互斥：0045 种子包 id=1（楼道挑战）是活跃行，同名 INSERT 报 UNIQUE
    //    （0100:21-22 的防重放种子守卫保持成立）。
    expect(() =>
      db
        .prepare(
          `INSERT INTO task_packs (name, created_at, updated_at)
           VALUES ('示例 · 楼道挑战', '2026-11-20T00:00:00.000Z', '2026-11-20T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow(/UNIQUE/);

    // 3) 墓碑不占名：软删种子包 1 后，同名活跃行可插入（「删后重建同名」恢复可行）。
    db.exec(`UPDATE task_packs SET deleted_at = '2026-11-20T00:00:00.000Z' WHERE id = 1 AND deleted_at IS NULL`);
    db.exec(
      `INSERT INTO task_packs (name, created_at, updated_at)
       VALUES ('示例 · 楼道挑战', '2026-11-20T00:00:00.000Z', '2026-11-20T00:00:00.000Z')`,
    );
    // 两个同名墓碑也允许共存（均不参与唯一性约束）。
    db.exec(
      `INSERT INTO task_packs (name, deleted_at, created_at, updated_at)
       VALUES ('示例 · 楼道挑战', '2026-11-20T01:00:00.000Z', '2026-11-20T00:00:00.000Z', '2026-11-20T00:00:00.000Z')`,
    );

    // 4) 幂等可重放：整段迁移再执行一遍，索引谓词与数据不变。
    db.exec(MIGRATION_0102);
    const again = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_task_packs_name'`)
      .get() as { sql: string };
    expect(again?.sql).toContain("WHERE deleted_at IS NULL");
    const sameName = db.prepare(`SELECT COUNT(*) AS n FROM task_packs WHERE name = '示例 · 楼道挑战'`).get() as {
      n: number;
    };
    expect(Number(sameName.n)).toBe(3); // 1 墓碑（原包） + 1 活跃（重建） + 1 墓碑
    db.close();
  });
});
