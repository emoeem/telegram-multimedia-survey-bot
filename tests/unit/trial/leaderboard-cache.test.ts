import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveParticipant: vi.fn(),
}));

vi.mock("../../../src/http/survey/participant", () => ({ resolveParticipant: mocks.resolveParticipant }));

import { handleTrialApiRequest, TRIAL_LEADERBOARD_CACHE_VERSION } from "../../../src/http/trial-api";
import type { Env } from "../../../src/index";
import {
  getTaskRunById,
  listGameTypeLeaderboard,
  loadGameTypeLeaderboardStamp,
  loadTaskRunLeaderboardStamp,
  saveTaskRun,
} from "../../../src/db/repositories/task-run.repository";
import { createSqliteD1, sqliteD1Available } from "../../helpers/sqlite-d1";

/**
 * 小游戏排行榜 · KV 戳式缓存 + 玩法聚合榜（0095）。
 *
 * DB 用真迁移（users 0001 + task 表 0045 + game_type 0090 + 索引 0095）跑真
 * SQL：聚合榜依赖 SQLite「聚合查询里唯一 max() 的裸列取自取得最大值那一行」
 * 的文档化行为，mock 测试测不出来。KV 用内存 fake；榜单 SQL 计数靠一层
 * prepare 代理（戳探针含 MAX(updated_at)，聚合榜含 GROUP BY r.user_id，
 * 单包榜含 LEFT JOIN users），据此断言「命中请求零榜单查询、探针每请求发生」。
 */
const SCHEMA = [
  "0001_users_surveys.sql",
  "0045_trial_tasks.sql",
  "0090_game_zone.sql",
  "0095_task_packs_game_type_index.sql",
]
  .map((file) => readFileSync(new URL(`../../../db/migrations/${file}`, import.meta.url), "utf8"))
  .join("\n");

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-02T00:00:00.000Z";
const T2 = "2026-01-03T00:00:00.000Z";

function createFakeKV() {
  const store = new Map<string, string>();
  return {
    kv: {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string) => void store.set(key, value),
    } as unknown as KVNamespace,
    store,
  };
}

function createCountingD1(db: D1Database) {
  const counts = { probe: 0, packBoard: 0, aggregateBoard: 0 };
  const proxied = {
    prepare(sql: string) {
      if (sql.includes("MAX(updated_at)")) counts.probe += 1;
      else if (sql.includes("GROUP BY r.user_id")) counts.aggregateBoard += 1;
      else if (sql.includes("LEFT JOIN users")) counts.packBoard += 1;
      return db.prepare(sql);
    },
    batch: db.batch.bind(db),
    exec: db.exec.bind(db),
  };
  return { db: proxied as unknown as D1Database, counts };
}

const ANONYMOUS = {
  kind: "anonymous",
  dbUserId: null,
  telegramUserId: null,
  participantKey: "key-1",
  participantHash: "anon_hash",
} as const;

const BOUND_7 = {
  kind: "telegram",
  dbUserId: 7,
  telegramUserId: 700,
  participantKey: null,
  participantHash: "user_7",
} as const;

function seedRun(
  db: D1Database,
  o: {
    id: number;
    packId: number;
    userId: number | null;
    hash: string;
    mode?: "normal" | "hell";
    score: number;
    completed?: number;
    status?: "active" | "completed" | "abandoned";
    finishedAt?: string | null;
    updatedAt: string;
    startingFloor?: number;
    maxFloor?: number;
  },
) {
  return db
    .prepare(
      `INSERT INTO task_runs (id, pack_id, user_id, participant_hash, persona, mode, starting_floor, current_floor,
         max_floor, score, completed_tasks, skipped_tasks, status, state_json, started_at, finished_at, updated_at)
       VALUES (?, ?, ?, ?, 'male', ?, ?, ?, ?, ?, ?, 0, ?, '{}', ?, ?, ?)`,
    )
    .bind(
      o.id,
      o.packId,
      o.userId,
      o.hash,
      o.mode ?? "normal",
      o.startingFloor ?? 1,
      o.startingFloor ?? 1,
      o.maxFloor ?? 15,
      o.score,
      o.completed ?? 10,
      o.status ?? "completed",
      T0,
      o.status === "active" ? null : (o.finishedAt ?? o.updatedAt),
      o.updatedAt,
    );
}

async function seedWorld(db: D1Database): Promise<void> {
  // 0045 自带两个 tower 示例包（id 1/2，无局）；这里再补两包 tower、一包 quiz。
  await db.batch([
    db
      .prepare(
        "INSERT INTO users (id, telegram_user_id, username, first_name, created_at, updated_at) VALUES (7, 700, 'alice', 'Alice', ?, ?)",
      )
      .bind(T0, T0),
    db
      .prepare(
        "INSERT INTO users (id, telegram_user_id, username, first_name, created_at, updated_at) VALUES (8, 800, 'bob', 'Bob', ?, ?)",
      )
      .bind(T0, T0),
    db
      .prepare(
        "INSERT INTO task_packs (id, name, game_type, normal_floors, hell_floors, prep_items, enabled, sort_order, created_at, updated_at) VALUES (11, '包A', 'tower', 10, 12, '[]', 1, 10, ?, ?)",
      )
      .bind(T0, T0),
    db
      .prepare(
        "INSERT INTO task_packs (id, name, game_type, normal_floors, hell_floors, prep_items, enabled, sort_order, created_at, updated_at) VALUES (12, '包B', 'tower', 10, 12, '[]', 1, 11, ?, ?)",
      )
      .bind(T0, T0),
    db
      .prepare(
        "INSERT INTO task_packs (id, name, game_type, normal_floors, hell_floors, prep_items, enabled, sort_order, created_at, updated_at) VALUES (13, '测验包', 'quiz', 10, 12, '[]', 1, 12, ?, ?)",
      )
      .bind(T0, T0),
    // alice：包A normal 100（最优，T1 完成）、包B normal 80、包A normal 60（旧局）、quiz 42
    seedRun(db, {
      id: 101,
      packId: 11,
      userId: 7,
      hash: "user_7",
      score: 100,
      completed: 12,
      finishedAt: T1,
      updatedAt: T1,
    }),
    seedRun(db, { id: 102, packId: 12, userId: 7, hash: "user_7", score: 80, finishedAt: T2, updatedAt: T2 }),
    seedRun(db, { id: 103, packId: 11, userId: 7, hash: "user_7", score: 60, finishedAt: T0, updatedAt: T0 }),
    seedRun(db, { id: 104, packId: 13, userId: 7, hash: "user_7", score: 42, finishedAt: T1, updatedAt: T1 }),
    // bob：包B normal 100（与 alice 同分但完成更晚）、包A hell 999、进行中 hell 9000
    seedRun(db, {
      id: 105,
      packId: 12,
      userId: 8,
      hash: "user_8",
      score: 100,
      completed: 11,
      finishedAt: T2,
      updatedAt: T2,
    }),
    seedRun(db, {
      id: 106,
      packId: 11,
      userId: 8,
      hash: "user_8",
      mode: "hell",
      score: 999,
      completed: 9,
      finishedAt: T2,
      updatedAt: T2,
    }),
    seedRun(db, {
      id: 107,
      packId: 11,
      userId: 8,
      hash: "user_8",
      mode: "hell",
      score: 9000,
      completed: 30,
      status: "active",
      updatedAt: T1,
    }),
    // 匿名局：分数再高也不上榜
    seedRun(db, { id: 108, packId: 11, userId: null, hash: "anon_hash", score: 500, finishedAt: T2, updatedAt: T2 }),
  ]);
}

describe.skipIf(!sqliteD1Available)("listGameTypeLeaderboard（聚合榜 · 真 SQLite）", () => {
  it("多包 GROUP BY 每参与者取单局最优并按分排序，明细来自最优行", async () => {
    const db = createSqliteD1(SCHEMA);
    await seedWorld(db);

    const entries = await listGameTypeLeaderboard(db, { gameType: "tower", mode: "normal" });
    // alice（100，包A，T1 先完成）在前；bob（100，包B，T2 后完成）在后；
    // alice 只出现一次（3 局 normal 取最优 100），明细取最优那一行（包A、12 题）。
    expect(entries.map((entry) => [entry.displayName, entry.score])).toEqual([
      ["@alice", 100],
      ["@bob", 100],
    ]);
    expect(entries[0]).toMatchObject({ runId: 101, packId: 11, completedTasks: 12, floors: 14, userId: 7 });
    expect(entries[1]).toMatchObject({ runId: 105, packId: 12, completedTasks: 11, userId: 8 });
  });

  it("mode 不混榜、匿名与进行中局不上榜、玩法不串榜", async () => {
    const db = createSqliteD1(SCHEMA);
    await seedWorld(db);

    const hell = await listGameTypeLeaderboard(db, { gameType: "tower", mode: "hell" });
    // 地狱榜只有 bob 的 999；进行中的 9000 和 normal 榜的分数都不进来。
    expect(hell.map((entry) => [entry.displayName, entry.score])).toEqual([["@bob", 999]]);

    const quiz = await listGameTypeLeaderboard(db, { gameType: "quiz", mode: "normal" });
    // quiz 包里 alice 的 42 分留在 quiz 分榜，不进 tower 榜（上面已验）——
    // 这里反证 tower 榜不含 quiz 成绩。
    expect(quiz.map((entry) => entry.score)).toEqual([42]);
    expect(await listGameTypeLeaderboard(db, { gameType: "tower", mode: "normal" })).not.toContainEqual(
      expect.objectContaining({ score: 42 }),
    );
  });

  it("戳探针：旧局后完成翻 MAX(updated_at)（COUNT 不变）；单包榜与聚合榜各自独立", async () => {
    const db = createSqliteD1(SCHEMA);
    await seedWorld(db);
    const before = await loadGameTypeLeaderboardStamp(db, { gameType: "tower", mode: "normal" });
    const packBefore = await loadTaskRunLeaderboardStamp(db, { packId: 11, mode: "normal" });

    // 旧局（id 103，updated_at=T0）走生产写路径 saveTaskRun——updated_at 必被盖：
    const record = await getTaskRunById(db, 103);
    expect(record).not.toBeNull();
    record!.score = 65;
    await saveTaskRun(db, record!);

    const after = await loadGameTypeLeaderboardStamp(db, { gameType: "tower", mode: "normal" });
    const packAfter = await loadTaskRunLeaderboardStamp(db, { packId: 11, mode: "normal" });
    // COUNT 没变（没有新增完成局），戳仍翻转——翻戳靠的是 MAX(updated_at)。
    // tower/normal 已完成局：101/102/103/105/108 共 5 局（探针不含 user_id 过滤）。
    expect(before.startsWith("5:")).toBe(true);
    expect(after.startsWith("5:")).toBe(true);
    expect(after).not.toBe(before);
    expect(packAfter).not.toBe(packBefore);
  });

  it("迁移 0095：idx_task_packs_game_type 存在且聚合榜包集合子查询走它", async () => {
    const db = createSqliteD1(SCHEMA);
    const indexes =
      (
        await db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_task_packs_game_type'")
          .all<{ name: string }>()
      ).results ?? [];
    expect(indexes.map((row) => row.name)).toContain("idx_task_packs_game_type");
    const plan = await db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT COUNT(*) FROM task_runs WHERE pack_id IN (SELECT id FROM task_packs WHERE game_type = 'tower')",
      )
      .all();
    expect(JSON.stringify(plan.results ?? [])).toContain("idx_task_packs_game_type");
  });
});

describe.skipIf(!sqliteD1Available)("GET /api/trial/leaderboard（KV 戳式缓存）", () => {
  let db: ReturnType<typeof createCountingD1>;
  let fake: ReturnType<typeof createFakeKV>;
  let env: Env;

  beforeEach(async () => {
    db = createCountingD1(createSqliteD1(SCHEMA));
    await seedWorld(db.db);
    fake = createFakeKV();
    env = { DB: db.db, CACHE: fake.kv, ADMIN_IDS: "" } as unknown as Env;
    mocks.resolveParticipant.mockResolvedValue(ANONYMOUS);
  });

  interface EntryJson {
    runId: number;
    displayName: string;
    score: number;
    floors: number;
    completedTasks: number;
    finishedAt: string;
    mine: boolean;
    packId?: number;
  }

  const get = (query: string) =>
    handleTrialApiRequest(
      new Request(`https://example.test/api/trial/leaderboard?${query}`),
      env,
      new URL(`https://example.test/api/trial/leaderboard?${query}`),
    );

  const getJson = async (query: string): Promise<{ entries: EntryJson[] }> => {
    const response = (await get(query)) as Response;
    return (await response.json()) as { entries: EntryJson[] };
  };

  it("miss 重建 payload 并写 KV；命中请求零榜单查询、仅戳探针", async () => {
    const firstBody = await getJson("gameType=tower&mode=normal");
    expect(firstBody.entries.map((entry) => entry.score)).toEqual([100, 100]);
    expect(db.counts.aggregateBoard).toBe(1);
    expect(db.counts.probe).toBeGreaterThanOrEqual(1);
    expect(fake.store.size).toBe(1);
    const key = [...fake.store.keys()][0]!;
    expect(key.startsWith(`trial-leaderboard:${TRIAL_LEADERBOARD_CACHE_VERSION}:gametype:tower:normal:`)).toBe(true);

    const probeBefore = db.counts.probe;
    const secondBody = await getJson("gameType=tower&mode=normal");
    expect(secondBody).toEqual(firstBody); // 命中：同一份 payload
    expect(db.counts.aggregateBoard).toBe(1); // 零榜单查询（miss 只发生过一次）
    expect(db.counts.probe).toBeGreaterThan(probeBefore); // 探针每请求仍发生
    expect(fake.store.size).toBe(1); // 不重复写
  });

  it("旧局后完成翻戳：下个请求重建 payload 并写新键", async () => {
    await get("gameType=tower&mode=normal");
    expect(fake.store.size).toBe(1);
    const keyBefore = [...fake.store.keys()][0];

    // id 107 是进行中的 hell 9000……它属于 hell 榜；这里完成 normal 的旧局 103。
    const record = await getTaskRunById(db.db, 103);
    record!.score = 65;
    await saveTaskRun(db.db, record!);

    const body = await getJson("gameType=tower&mode=normal");
    expect(db.counts.aggregateBoard).toBe(2); // 戳变了：payload 重建
    expect(fake.store.size).toBe(2); // 新键落 KV（旧键等 TTL 回收）
    const keyAfter = [...fake.store.keys()].find((key) => key !== keyBefore);
    expect(keyAfter).toBeDefined();
    // 重建后的 payload 反映翻戳后的数据（65 分的旧局仍不上榜，榜不变但键已轮换）。
    expect(body.entries.map((entry) => entry.score)).toEqual([100, 100]);
  });

  it("完成一局让新成绩上榜：戳翻转速生效，不读旧缓存", async () => {
    await get("gameType=tower&mode=normal");
    const record = await getTaskRunById(db.db, 107); // bob 的进行中 hell 9000
    record!.status = "completed";
    record!.finishedAt = T2;
    await saveTaskRun(db.db, record!);

    const body = await getJson("gameType=tower&mode=hell");
    expect(body.entries.map((entry) => entry.score)).toEqual([9000]);
    expect(db.counts.aggregateBoard).toBe(2); // hell 首请求本身就是 miss 重建
  });

  it("PROJECTION 版本守卫：旧版本键里的同戳条目永不被读", async () => {
    const stamp = await loadGameTypeLeaderboardStamp(db.db, { gameType: "tower", mode: "normal" });
    const staleKey = `trial-leaderboard:v0:gametype:tower:normal:${stamp}`;
    fake.store.set(staleKey, JSON.stringify([])); // 旧投影形状的空榜

    const body = await getJson("gameType=tower&mode=normal");
    expect(body.entries.length).toBeGreaterThan(0); // 没有把旧版本条目当命中
    expect(db.counts.aggregateBoard).toBe(1); // 走了重建
    expect(fake.store.get(staleKey)).toBe(JSON.stringify([])); // 旧键原样留存（等 TTL）
    expect(
      [...fake.store.keys()].some((key) => key.startsWith(`trial-leaderboard:${TRIAL_LEADERBOARD_CACHE_VERSION}:`)),
    ).toBe(true);
  });

  it("命中时 mine 按请求方身份重算：缓存共享，个人标记不共享", async () => {
    // 第一次（miss）以 alice 身份请求，写下缓存。
    mocks.resolveParticipant.mockResolvedValue(BOUND_7);
    const boundBody = await getJson("gameType=tower&mode=normal");
    expect(boundBody.entries.find((entry) => entry.runId === 101)?.mine).toBe(true);

    // 命中路径换匿名身份：同一份缓存，mine 必须为 false。
    mocks.resolveParticipant.mockResolvedValue(ANONYMOUS);
    const probeBefore = db.counts.probe;
    const anonBody = await getJson("gameType=tower&mode=normal");
    expect(db.counts.probe).toBeGreaterThan(probeBefore);
    expect(db.counts.aggregateBoard).toBe(1); // 确认走的是命中
    expect(anonBody.entries.find((entry) => entry.runId === 101)?.mine).toBe(false);

    // 命中路径再换回 alice：mine 回到 true。
    mocks.resolveParticipant.mockResolvedValue(BOUND_7);
    const boundSecond = await getJson("gameType=tower&mode=normal");
    expect(boundSecond.entries.find((entry) => entry.runId === 101)?.mine).toBe(true);
  });

  it("mode 维度定死：normal 与 hell 各自分榜分键，互不混入", async () => {
    const normalBody = await getJson("gameType=tower&mode=normal");
    const hellBody = await getJson("gameType=tower&mode=hell");
    expect(normalBody.entries.map((entry) => entry.score)).toEqual([100, 100]);
    expect(hellBody.entries.map((entry) => entry.score)).toEqual([999]);
    expect(fake.store.size).toBe(2); // 两张分榜两个键
  });

  it("单包榜同走戳式缓存且出参与旧形状一致（不带 packId）；未知玩法 400", async () => {
    const firstBody = await getJson("packId=11&mode=normal");
    expect(firstBody.entries.map((entry) => entry.score)).toEqual([100]);
    expect(firstBody.entries[0]).toEqual({
      runId: 101,
      displayName: "@alice",
      score: 100,
      floors: 14,
      completedTasks: 12,
      finishedAt: T1,
      mine: false,
    });
    expect("packId" in firstBody.entries[0]!).toBe(false);
    expect(db.counts.packBoard).toBe(1);

    const probeBefore = db.counts.probe;
    const secondBody = await getJson("packId=11&mode=normal");
    expect(secondBody).toEqual(firstBody);
    expect(db.counts.packBoard).toBe(1); // 命中：零榜单查询
    expect(db.counts.probe).toBeGreaterThan(probeBefore);

    const bad = (await get("gameType=nope&mode=normal")) as Response;
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { code: string }).code).toBe("validation_failed");
  });
});
