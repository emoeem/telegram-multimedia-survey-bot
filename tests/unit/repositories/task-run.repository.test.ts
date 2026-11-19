import { describe, expect, it } from "vitest";

import { createTaskPack } from "../../../src/db/repositories/task-pack.repository";
import {
  createTaskRun,
  getActiveTaskRunByParticipant,
  getTaskRunById,
  saveTaskRun,
  type TaskRunConfigSnapshot,
  type TaskRunInput,
} from "../../../src/db/repositories/task-run.repository";
import { fullMigrationSchema } from "../../helpers/full-schema";
import { createSqliteD1, sqliteD1Available } from "../../helpers/sqlite-d1";

/**
 * task_runs 开局配置快照（0103 config_json）的仓库层验证：
 * - createTaskRun 传入 configSnapshot 时写入 config_json，mapRow 读回一致；
 * - 不传（爬塔路径）落 NULL，读取侧为 undefined——存量行为兼容；
 * - saveTaskRun 把快照原样回写（读改写循环不丢快照）；
 * - 存量行 / 损坏 / 异形 config_json 一律解析为 undefined，不抛错。
 * 用真实 SQLite（全迁移链 schema），列存在性由 0103 迁移本身保证。
 */
const T0 = "2026-01-01T00:00:00.000Z";

const SNAPSHOT: TaskRunConfigSnapshot = {
  gameType: "guess",
  settings: { rangeMin: 1, rangeMax: 100, attempts: 7, score: 20 },
};

function baseInput(packId: number, overrides: Partial<TaskRunInput> = {}): TaskRunInput {
  return {
    packId,
    userId: null,
    participantHash: "hash_snapshot",
    persona: "male",
    mode: "normal",
    startingFloor: 1,
    maxFloor: 7,
    state: {
      phase: "playing",
      coins: 0,
      inventory: { skipTickets: 0, boosters: 0, shields: 0 },
      boosted: false,
      usedTaskIds: [],
      maxScore: 1,
      currentTaskId: null,
      coinRerolls: 0,
    },
    ...overrides,
  };
}

async function rawConfigJson(db: D1Database, runId: number): Promise<unknown> {
  const row = (await db.prepare("SELECT config_json FROM task_runs WHERE id = ?").bind(runId).first()) as {
    config_json: unknown;
  } | null;
  return row?.config_json;
}

describe.skipIf(!sqliteD1Available)("task run repository (config snapshot 0103)", () => {
  it("createTaskRun 写入 config_json 快照，mapRow 读回一致", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    const pack = await createTaskPack(db, { name: "快照包", items: [] });

    const created = await createTaskRun(db, baseInput(pack.id, { configSnapshot: SNAPSHOT }));

    // 列里是同形 JSON；记录上原样读回。
    expect(JSON.parse(String(await rawConfigJson(db, created.id)))).toEqual(SNAPSHOT);
    expect(created.configSnapshot).toEqual(SNAPSHOT);
    expect((await getTaskRunById(db, created.id))?.configSnapshot).toEqual(SNAPSHOT);
    expect((await getActiveTaskRunByParticipant(db, "hash_snapshot"))?.configSnapshot).toEqual(SNAPSHOT);
  });

  it("未传 configSnapshot（爬塔路径）落 NULL，读取侧 undefined", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    const pack = await createTaskPack(db, { name: "爬塔包", items: [] });

    const created = await createTaskRun(db, baseInput(pack.id));

    expect(await rawConfigJson(db, created.id)).toBeNull();
    expect(created.configSnapshot).toBeUndefined();
    expect((await getTaskRunById(db, created.id))?.configSnapshot).toBeUndefined();
  });

  it("saveTaskRun 原样回写快照：读改写循环不丢、不变形", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    const pack = await createTaskPack(db, { name: "回写包", items: [] });
    const created = await createTaskRun(db, baseInput(pack.id, { configSnapshot: SNAPSHOT }));

    const record = (await getTaskRunById(db, created.id))!;
    await saveTaskRun(db, { ...record, score: 18, status: "completed", finishedAt: T0 });

    const saved = (await getTaskRunById(db, created.id))!;
    expect(saved.status).toBe("completed");
    expect(saved.score).toBe(18);
    expect(saved.configSnapshot).toEqual(SNAPSHOT);
    expect(JSON.parse(String(await rawConfigJson(db, created.id)))).toEqual(SNAPSHOT);
  });

  it("存量行与异形 config_json 都解析为 undefined：NULL、坏 JSON、非对象、缺 settings", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    const pack = await createTaskPack(db, { name: "存量包", items: [] });

    const seeds: Array<{ label: string; configJson: string | null }> = [
      { label: "存量 NULL", configJson: null },
      { label: "坏 JSON", configJson: "not-json{{" },
      { label: "非对象", configJson: '"just-a-string"' },
      { label: "缺 settings", configJson: '{"gameType":"guess"}' },
      { label: "缺 gameType", configJson: '{"settings":{}}' },
      { label: "settings 非对象", configJson: '{"gameType":"guess","settings":[1,2]}' },
    ];
    for (const seed of seeds) {
      const result = await db
        .prepare(
          `INSERT INTO task_runs (pack_id, user_id, participant_hash, persona, mode, starting_floor, current_floor, max_floor,
             score, completed_tasks, skipped_tasks, status, state_json, config_json, started_at, finished_at, updated_at)
           VALUES (?, NULL, ?, 'any', 'normal', 1, 1, 7, 0, 0, 0, 'active', '{}', ?, ?, NULL, ?)`,
        )
        .bind(pack.id, `hash_${seed.label}`, seed.configJson, T0, T0)
        .run();
      const id = result.meta?.last_row_id;
      const record = (await getTaskRunById(db, Number(id)))!;
      expect(record.configSnapshot, seed.label).toBeUndefined();
    }
  });
});
