import { describe, expect, it } from "vitest";

import { drawTaskItems } from "../../../src/services/game-draw.service";
import { fullMigrationSchema } from "../../helpers/full-schema";
import { createSqliteD1, sqliteD1Available } from "../../helpers/sqlite-d1";
import {
  countTaskItems,
  createTaskPack,
  deleteTaskPack,
  getTaskPackById,
  listTaskPacks,
  updateTaskPack,
} from "../../../src/db/repositories/task-pack.repository";
import { listGameTypeLeaderboard } from "../../../src/db/repositories/task-run.repository";

/**
 * task_packs 软删（0101 墓碑）的仓库层验证。0045 的 task_items/task_runs 外键
 * 均 ON DELETE CASCADE 且 D1 强制外键，硬删父包会清空对局历史；本套用真实
 * SQLite（全迁移链 schema）枚举 getTaskPackById 的四处调用方决策：
 * ① updateTaskPack 对墓碑包返回更新后记录（不 404）；
 * ② drawTaskItems（金币抽卡）命中墓碑包仍抽题；
 * ③ createTaskPack 回读用默认值（新包无墓碑）；
 * ④ 玩家路径默认排除墓碑（getTaskPackById 默认返回 null）。
 * 以及 listTaskPacks 的默认排除 / history 映射 includeDeleted 两态，
 * 与「重复删除返回 false」「软删后 task_runs/task_items 行数不变」。
 */
const T0 = "2026-01-01T00:00:00.000Z";

describe.skipIf(!sqliteD1Available)("task pack repository (soft delete 0101)", () => {
  async function seedPack(db: D1Database, name: string, itemCount = 2) {
    // createTaskPack 的返回值即 :230 的回读（决策③：新包不可能有墓碑，走默认值）。
    return createTaskPack(db, {
      name,
      items: Array.from({ length: itemCount }, (_, index) => ({
        title: `任务${index + 1}`,
        description: `描述${index + 1}`,
        score: 3,
      })),
    });
  }

  async function seedRun(
    db: D1Database,
    packId: number,
    o: { hash: string; userId?: number | null; status?: "active" | "completed" },
  ) {
    await db
      .prepare(
        `INSERT INTO task_runs (pack_id, user_id, participant_hash, persona, mode, score, status, state_json, started_at, finished_at, updated_at)
         VALUES (?, ?, ?, 'any', 'normal', 42, ?, '{}', ?, ?, ?)`,
      )
      .bind(packId, o.userId ?? null, o.hash, o.status ?? "active", T0, o.status === "completed" ? T0 : null, T0)
      .run();
  }

  async function countRows(db: D1Database, table: "task_items" | "task_runs", packId: number): Promise<number> {
    const row = (await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE pack_id = ?`).bind(packId).first()) as {
      n: number;
    } | null;
    return Number(row?.n ?? 0);
  }

  it("决策④：玩家路径默认排除墓碑——getTaskPackById 默认 null，listTaskPacks 默认列表（玩家与管理端共用查询）不含已删包", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    const pack = await seedPack(db, "软删包·甲", 2);
    // 决策③的正面证据：createTaskPack 回读成功（带 items）。
    expect(pack.items?.length).toBe(2);

    expect(await deleteTaskPack(db, pack.id)).toBe(true);

    // 默认两态（/api/trial/packs 的 enabledOnly、admin 默认列表的 withItems）都不含墓碑。
    const playerPacks = await listTaskPacks(db, { enabledOnly: true });
    expect(playerPacks.some((item) => item.id === pack.id)).toBe(false);
    const adminDefault = await listTaskPacks(db, { withItems: true });
    expect(adminDefault.some((item) => item.id === pack.id)).toBe(false);

    // 玩家路径语义：默认读返回 null；includeDeleted 读回墓碑（仓库层编辑/恢复语义）。
    expect(await getTaskPackById(db, pack.id)).toBeNull();
    const tombstone = await getTaskPackById(db, pack.id, { includeDeleted: true });
    expect(tombstone?.name).toBe("软删包·甲");
    expect(tombstone?.items?.length).toBe(2);
  });

  it("history 包名映射（includeDeleted: true）保留真实包名，不退化 #id", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    const pack = await seedPack(db, "软删包·乙", 1);
    await seedRun(db, pack.id, { hash: "web_history" });
    await deleteTaskPack(db, pack.id);
    // trial-api.ts /api/trial/history 的映射查询：显式带墓碑包。
    const packs = await listTaskPacks(db, { includeDeleted: true });
    const name = packs.find((item) => item.id === pack.id)?.name;
    expect(name).toBe("软删包·乙");
  });

  it("deleteTaskPack：软删后 task_runs/task_items 行数不变、countTaskItems 仍统计、重复删除返回 false", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    const pack = await seedPack(db, "回收站包", 2);
    await seedRun(db, pack.id, { hash: "web_r1" });
    await seedRun(db, pack.id, { hash: "web_r2" });

    expect(await deleteTaskPack(db, pack.id)).toBe(true);
    // 第二次删除（墓碑已存在）→ changes=0 → false，与「删不存在返回 false」语义一致。
    expect(await deleteTaskPack(db, pack.id)).toBe(false);

    expect(await countRows(db, "task_items", pack.id)).toBe(2);
    expect(await countRows(db, "task_runs", pack.id)).toBe(2);
    // countTaskItems 刻意不过滤墓碑：仅统计题数供审计/恢复。
    expect(await countTaskItems(db, pack.id)).toBe(2);
    expect(await countTaskItems(db, pack.id, true)).toBe(2);
  });

  it("决策①：墓碑包 updateTaskPack 返回更新后记录（不 404）；不存在的包仍 null", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    const pack = await seedPack(db, "待改名包", 1);
    await deleteTaskPack(db, pack.id);

    const updated = await updateTaskPack(db, pack.id, { name: "改名后的墓碑包" });
    expect(updated).not.toBeNull();
    expect(updated?.name).toBe("改名后的墓碑包");
    expect((await getTaskPackById(db, pack.id, { includeDeleted: true }))?.name).toBe("改名后的墓碑包");
    // 默认读仍是 null：编辑不改变玩家可见性。
    expect(await getTaskPackById(db, pack.id)).toBeNull();

    expect(await updateTaskPack(db, 999_999, { name: "不存在" })).toBeNull();
  });

  it("0106 adult 列：缺省 0（全年龄）、可显式 true；updateTaskPack 只在显式携带时翻转", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    // 缺省 = 非 adult（列默认 0：页级门移除后存量包不再被挡，管理员显式勾选才升 18+）。
    const defaulted = await seedPack(db, "缺省包", 1);
    expect(defaulted.adult).toBe(false);

    const adult = await createTaskPack(db, {
      name: "18+ 包",
      adult: true,
      items: [{ title: "任务1", description: "描述1", score: 3 }],
    });
    expect(adult.adult).toBe(true);

    // PATCH 局部语义：不携带 adult 的更新保持原值（列表页启停等部分更新不误重置）。
    const untouched = await updateTaskPack(db, adult.id, { name: "18+ 包·改名" });
    expect(untouched?.adult).toBe(true);

    // 显式携带才翻转。
    const flipped = await updateTaskPack(db, adult.id, { adult: false });
    expect(flipped?.adult).toBe(false);
    const reverted = await updateTaskPack(db, adult.id, { adult: true });
    expect(reverted?.adult).toBe(true);
  });

  it("决策②：drawTaskItems 命中墓碑包仍抽题（金币抽卡行为不变），包不存在仍 null", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    const pack = await seedPack(db, "金币抽卡包", 3);
    await deleteTaskPack(db, pack.id);

    // 真实调用链：drawTaskItems → getTaskPackById(includeDeleted) → 加权抽取。
    const drawn = await drawTaskItems(db, pack.id, { count: 2, random: () => 0 });
    expect(drawn).toHaveLength(2);
    expect(drawn?.every((item) => item.score > 0)).toBe(true);

    expect(await drawTaskItems(db, 4_242_424, { count: 1 })).toBeNull();
  });

  it("0102 名称局部唯一索引：删包后可重建同名包；活跃同名仍被唯一索引拒绝", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    const pack = await seedPack(db, "同名复用包", 1);
    await deleteTaskPack(db, pack.id);
    // 墓碑不占名：删后重建同名不再抛 UNIQUE（批次前硬删时代的行为保持不变）。
    const recreated = await seedPack(db, "同名复用包", 1);
    expect(recreated.id).not.toBe(pack.id);
    expect(await getTaskPackById(db, recreated.id)).not.toBeNull();

    // 活跃行之间仍互斥：与 0045 种子活跃包「示例 · 楼道挑战」同名建包 → UNIQUE
    // （0100 防 0049 裸 INSERT 重放的守卫保持成立）。
    await expect(createTaskPack(db, { name: "示例 · 楼道挑战" })).rejects.toThrow(/UNIQUE/);
  });

  it("玩法总榜子查询不过滤墓碑：已删包的完成局仍在 listGameTypeLeaderboard", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    await db
      .prepare(
        `INSERT INTO users (id, telegram_user_id, username, created_at, updated_at) VALUES (7, 700, '榜哥', ?, ?)`,
      )
      .bind(T0, T0)
      .run();
    const pack = await seedPack(db, "总榜包", 1);
    await seedRun(db, pack.id, { hash: "user_7", userId: 7, status: "completed" });
    await deleteTaskPack(db, pack.id);

    // 成绩已经发生，不因包下架消失（task-run.repository.ts:334 子查询保持不过滤）。
    const entries = await listGameTypeLeaderboard(db, { gameType: "tower", mode: "normal" });
    expect(entries.some((entry) => entry.packId === pack.id && entry.userId === 7)).toBe(true);
  });
});
