import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import { sqliteD1Available } from "../../helpers/sqlite-d1";

/**
 * 迁移 0100（B8 · K9 任务包重复数据修正）：0049 用裸 INSERT INTO task_packs
 * 且 0045 建表对 name 无唯一约束，迁移重放即整包重复（GET /api/trial/packs
 * 返回两条同名同描述的 K9 包），且 0049 的条目语句按 name 反查会同时给两个
 * 同名包各插一份——保留包内也出现逐字重复的条目对。本测试先复现重放出的
 * 坏状态，再验证 0100 的四步修正：历史改挂、删重复包、包内条目去重、加
 * 名称唯一索引，并验证整个迁移幂等可重放。
 */
const TRIAL_CHAIN = ["0045_trial_tasks.sql", "0047_trial_more_content.sql", "0049_k9_task_pack.sql"]
  .map((file) => readFileSync(new URL(`../../../db/migrations/${file}`, import.meta.url), "utf8"))
  .join("\n");

const MIGRATION_0100 = readFileSync(
  new URL("../../../db/migrations/0100_k9_task_pack_dedup.sql", import.meta.url),
  "utf8",
);

const K9_NAME = "K9 犬训 · 原典 200 题";

const MIGRATION_0049 = readFileSync(new URL("../../../db/migrations/0049_k9_task_pack.sql", import.meta.url), "utf8");

const require = createRequire(import.meta.url);
function loadSqlite() {
  return sqliteD1Available ? (require("node:sqlite") as typeof import("node:sqlite")) : null;
}

describe.skipIf(!sqliteD1Available)("migration 0100 (K9 pack dedup)", () => {
  it("去重保留一条、包内条目去重、游玩历史改挂、加名称唯一索引，且幂等可重放", () => {
    const sqlite = loadSqlite();
    if (!sqlite) throw new Error("node:sqlite unavailable");
    const db = new sqlite.DatabaseSync(":memory:");
    // 最小 users 表：task_runs.user_id 外键引用（测试只种 NULL，不挂用户）。
    db.exec(
      `CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '');`,
    );
    db.exec(`PRAGMA foreign_keys = ON;\n${TRIAL_CHAIN}`);

    // 模拟 0049 重放（部署事故形态）：整包重复 + 保留包内条目翻倍。
    db.exec(MIGRATION_0049);

    // node:sqlite 的 .get/.run 对首参槽位是命名参数重载，仓内惯例把测试
    // 常量内联进 SQL（values 均为本测试自控的整数/固定串，无注入面）。
    const packsBefore = (
      db.prepare(`SELECT id, name FROM task_packs WHERE name = '${K9_NAME}' ORDER BY id`).all() as Array<{
        id: number;
        name: string;
      }>
    ).map((row) => row.id);
    expect(packsBefore).toHaveLength(2);
    const keptId = packsBefore[0];
    const dupId = packsBefore[1];
    // 重放后：保留包条目翻倍（200 原版 + 200 重放副本），重复包整包副本。
    const keptItemsBefore = Number(
      (db.prepare(`SELECT COUNT(*) AS n FROM task_items WHERE pack_id = ${keptId}`).get() as { n: number }).n,
    );
    expect(keptItemsBefore).toBe(400);
    expect(
      Number((db.prepare(`SELECT COUNT(*) AS n FROM task_items WHERE pack_id = ${dupId}`).get() as { n: number }).n),
    ).toBe(200);

    // 游玩历史分布在两个包上：修复后必须全部落在保留包，一条不丢。
    db.prepare(
      `INSERT INTO task_runs (pack_id, participant_hash, persona, mode, state_json, started_at, updated_at)
       VALUES (${keptId}, 'hash_kept', 'any', 'normal', '{}', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO task_runs (pack_id, participant_hash, persona, mode, state_json, started_at, updated_at)
       VALUES (${dupId}, 'hash_dup', 'any', 'normal', '{}', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`,
    ).run();

    db.exec("BEGIN");
    db.exec(MIGRATION_0100);
    db.exec("COMMIT");

    // 1) 无同名同描述条目：K9 只剩一条，且是最早的原版 id。
    const packsAfter = db.prepare(`SELECT id, name FROM task_packs WHERE name = '${K9_NAME}'`).all() as Array<{
      id: number;
    }>;
    expect(packsAfter.map((row) => row.id)).toEqual([keptId]);
    expect(
      (
        db
          .prepare(`SELECT COUNT(*) AS n FROM (SELECT name FROM task_packs GROUP BY name HAVING COUNT(*) > 1)`)
          .get() as { n: number }
      ).n,
    ).toBe(0);
    // 其余种子包不受影响（0045 两条 + 0047 两条 + K9 一条）。
    expect(Number((db.prepare(`SELECT COUNT(*) AS n FROM task_packs`).get() as { n: number }).n)).toBe(5);

    // 2) 游玩历史改挂保留包（hash_dup 的 run 不随包 CASCADE 丢失）。
    const runs = db.prepare(`SELECT participant_hash, pack_id FROM task_runs`).all() as Array<{
      participant_hash: string;
      pack_id: number;
    }>;
    expect(runs).toHaveLength(2);
    expect(runs.every((run) => run.pack_id === keptId)).toBe(true);

    // 3) 保留包条目恢复 200 且无逐字重复（COUNT(*) = COUNT(DISTINCT title)，
    //    K9 条目标题逐条编号，200 个互不相同）。
    const items = Number(
      (db.prepare(`SELECT COUNT(*) AS n FROM task_items WHERE pack_id = ${keptId}`).get() as { n: number }).n,
    );
    const distinctTitles = Number(
      (db.prepare(`SELECT COUNT(DISTINCT title) AS n FROM task_items WHERE pack_id = ${keptId}`).get() as { n: number })
        .n,
    );
    expect(items).toBe(200);
    expect(distinctTitles).toBe(200);

    // 4) 名称唯一索引真实存在并生效：裸 INSERT 同名即报 UNIQUE（种子守卫）。
    const index = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_task_packs_name'`)
      .get();
    expect(index).toBeTruthy();
    expect(() =>
      db
        .prepare(
          `INSERT INTO task_packs (name, created_at, updated_at)
           VALUES ('${K9_NAME}', '2026-11-19T00:00:00.000Z', '2026-11-19T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow(/UNIQUE/);

    // 幂等可重放：整段迁移再执行一遍，结果不变（不删包、不删条目、不报错）。
    db.exec(MIGRATION_0100);
    expect(Number((db.prepare(`SELECT COUNT(*) AS n FROM task_packs`).get() as { n: number }).n)).toBe(5);
    expect(
      Number((db.prepare(`SELECT COUNT(*) AS n FROM task_items WHERE pack_id = ${keptId}`).get() as { n: number }).n),
    ).toBe(200);
    db.close();
  });
});
