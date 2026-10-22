import { describe, expect, it, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CoinLedgerError,
  earnCoins,
  getCoinAccount,
} from "../../../src/services/coin/ledger.service";
import { performCheckin, getCheckinStatus } from "../../../src/services/coin/checkin.service";
import { unlockSurvey, resolveCoinGate } from "../../../src/services/coin/unlock.service";
import { pullGacha, drawWeighted, listActivePools } from "../../../src/services/coin/gacha.service";
import { createSubmission, reviewSubmission } from "../../../src/services/coin/submission.service";
import { backfillCheckin } from "../../../src/services/coin/checkin.service";
import { moderateSubmission } from "../../../src/services/coin/moderation.service";

/**
 * 金币经济的行为测试：用 Node 内置 SQLite 跑真实的 0078 schema，让账本的
 * 前置守卫、幂等唯一键、CHECK 非负约束都按真实 SQL 语义工作，而不是 mock。
 */

const SCHEMA = [
  readFileSync(join(__dirname, "../../../db/migrations/0078_coin_economy.sql"), "utf-8"),
  readFileSync(join(__dirname, "../../../db/migrations/0079_coin_economy_followups.sql"), "utf-8"),
].join("\n");

interface Stmt {
  sql: string;
  params: unknown[];
  bind: (...bound: unknown[]) => Stmt;
  first: <T>() => Promise<T | null>;
  all: <T>() => Promise<{ results: T[]; meta: Record<string, unknown> }>;
  run: () => Promise<{ success: boolean; meta: { changes: number; last_row_id: number } }>;
}

/** D1 接口的 SQLite 实现：batch = 显式事务，逐语句收集 meta.changes。 */
function createSqliteD1(): D1Database & { sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(SCHEMA);
  // 测试所需的既有表（078 的外键引用 + 服务查询用到的）。
  sqlite.exec(`
    CREATE TABLE surveys (
      id INTEGER PRIMARY KEY, owner_id INTEGER, title TEXT, description TEXT, status TEXT,
      access_code TEXT, settings_json TEXT, cover_media_id INTEGER,
      published_at TEXT, closed_at TEXT, archived_at TEXT, deleted_at TEXT,
      anonymous INTEGER DEFAULT 0, updated_at TEXT
    ,
      content_rating TEXT NOT NULL DEFAULT 'all'
    );
    CREATE TABLE survey_responses (
      id INTEGER PRIMARY KEY AUTOINCREMENT, survey_id INTEGER, user_id INTEGER,
      participant_hash TEXT, status TEXT, created_at TEXT
    );
    CREATE TABLE survey_questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, survey_id INTEGER, type TEXT, title TEXT,
      required INTEGER DEFAULT 1, "order" INTEGER, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE survey_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '', sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT, updated_at TEXT
    );
    ALTER TABLE surveys ADD COLUMN category_id INTEGER;
    CREATE TABLE participant_links (participant_key TEXT PRIMARY KEY, user_id INTEGER, linked_at TEXT);
    CREATE TABLE participant_hash_links (
      source_hash TEXT PRIMARY KEY,
      canonical_hash TEXT NOT NULL,
      method TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    -- 0080 的分级列（本测试只拼 0078/0079，其它 ALTER 的表在这里不存在）。
    ALTER TABLE gacha_pools ADD COLUMN content_rating TEXT NOT NULL DEFAULT 'all';
    CREATE TABLE plaza_posts (id INTEGER PRIMARY KEY AUTOINCREMENT, participant_hash TEXT,
      user_id INTEGER, content TEXT, anonymous INTEGER DEFAULT 1, status TEXT DEFAULT 'published',
      created_at TEXT, deleted_at TEXT);
    CREATE TABLE media_assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      media_type TEXT NOT NULL,
      telegram_file_id TEXT,
      telegram_file_unique_id TEXT,
      mime_type TEXT,
      file_name TEXT,
      file_size INTEGER,
      width INTEGER,
      height INTEGER,
      duration INTEGER,
      r2_key TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    ALTER TABLE media_assets ADD COLUMN asset_scope TEXT NOT NULL DEFAULT 'survey';
    ALTER TABLE media_assets ADD COLUMN storage_kind TEXT;
    ALTER TABLE media_assets ADD COLUMN storage_key TEXT;
    ALTER TABLE media_assets ADD COLUMN url TEXT;
    ALTER TABLE media_assets ADD COLUMN expires_at TEXT;
    ALTER TABLE media_assets ADD COLUMN alt_text TEXT;
  `);

  const runStatement = (sql: string, params: unknown[]) => {
    const statement = sqlite.prepare(sql);
    const info = statement.run(...(params as never[]));
    return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
  };

  const makeStmt = (sql: string, initialParams: unknown[] = []): Stmt => {
    const bound = makeStmtBound(sql, initialParams);
    return {
      ...bound,
      first: async <T>() => (sqlite.prepare(sql).get(...(bound.params as never[])) as T | undefined) ?? null,
      all: async <T>() => ({
        results: sqlite.prepare(sql).all(...(bound.params as never[])) as unknown as T[],
        meta: {},
      }),
      run: async () => runStatement(sql, bound.params),
    };
  };

  const makeStmtBound = (sql: string, params: unknown[]): Stmt => ({
    sql,
    params,
    bind: (...bound: unknown[]) => makeStmtBound(sql, bound),
    first: async <T>() => (sqlite.prepare(sql).get(...(params as never[])) as T | undefined) ?? null,
    all: async <T>() => ({ results: sqlite.prepare(sql).all(...(params as never[])) as unknown as T[], meta: {} }),
    run: async () => runStatement(sql, params),
  });

  const db = {
    sqlite,
    prepare: (sql: string) => makeStmt(sql),
    batch: async (statements: Array<{ sql: string; params: unknown[] }>) => {
      sqlite.exec("BEGIN");
      const results: Array<{ meta: { changes: number; last_row_id: number } }> = [];
      try {
        for (const statement of statements) {
          const outcome = runStatement(statement.sql, statement.params);
          results.push({ meta: outcome.meta });
        }
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return db as unknown as D1Database & { sqlite: DatabaseSync };
}

function sqliteOf(db: D1Database): DatabaseSync {
  return (db as unknown as { sqlite: DatabaseSync }).sqlite;
}

function seedSurvey(db: D1Database, id: number): void {
  sqliteOf(db)
    .prepare(`INSERT INTO surveys (id, owner_id, title, status) VALUES (?, ?, '测试问卷', 'published')`)
    .run(id, 999);
}

function seedPool(db: D1Database, opts?: { pityAt?: number }): number {
  const sqlite = (db as unknown as { sqlite: DatabaseSync }).sqlite;
  sqlite
    .prepare(
      `INSERT INTO gacha_pools (slug, name, cost_single, cost_multi, status, pity_at, version, created_at, updated_at)
       VALUES ('test-pool', '测试池', 10, 90, 'active', ?, 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    )
    .run(opts?.pityAt ?? null);
  return Number(sqlite.prepare(`SELECT id FROM gacha_pools WHERE slug='test-pool'`).get()?.id ?? 0);
}

function seedPoolItem(db: D1Database, poolId: number, rarity: string, weight: number, stock: number | null = null): number {
  const sqlite = (db as unknown as { sqlite: DatabaseSync }).sqlite;
  sqlite
    .prepare(
      `INSERT INTO gacha_pool_items (pool_id, owner_participant_hash, title, content_type, rarity, weight, stock, remaining, active, created_at)
       VALUES (?, 'owner-hash', ?, 'text', ?, ?, ?, ?, 1, '2026-01-01T00:00:00Z')`,
    )
    .run(poolId, `内容-${rarity}-${Math.random()}`, rarity, weight, stock, stock);
  return Number(sqlite.prepare(`SELECT last_insert_rowid() AS id`).get()?.id ?? 0);
}

const PARTICIPANT = { participantHash: "web_tester", dbUserId: 7 };

/** 内存 KV：media 存储只用 put/delete/get。 */
function fakeKv(): KVNamespace {
  const store = new Map<string, Uint8Array>();
  return {
    put: async (key: string, value: unknown) => {
      store.set(key, value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBufferLike));
      return undefined;
    },
    get: async (key: string) => store.get(key) ?? null,
    delete: async (key: string) => {
      store.delete(key);
      return undefined;
    },
  } as unknown as KVNamespace;
}

let db: D1Database & { sqlite: DatabaseSync };

beforeEach(() => {
  db = createSqliteD1();
});

describe("金币账本", () => {
  it("入账增加余额并记录 balance_after", async () => {
    const result = await earnCoins(db, {
      participantHash: PARTICIPANT.participantHash,
      userId: PARTICIPANT.dbUserId,
      amount: 50,
      kind: "checkin",
      idempotencyKey: "t:earn1",
    });
    expect(result.duplicate).toBe(false);
    const account = await getCoinAccount(db, PARTICIPANT.participantHash);
    expect(account?.balance).toBe(50);
    expect(account?.totalEarned).toBe(50);
    const txn = await db
      .prepare(`SELECT amount, balance_after FROM coin_transactions WHERE idempotency_key='t:earn1'`)
      .first<{ amount: number; balance_after: number }>();
    expect(txn?.amount).toBe(50);
    expect(txn?.balance_after).toBe(50);
  });

  it("重复幂等键不重复发币", async () => {
    await earnCoins(db, {
      participantHash: PARTICIPANT.participantHash,
      amount: 30,
      kind: "challenge",
      idempotencyKey: "t:same",
    });
    const again = await earnCoins(db, {
      participantHash: PARTICIPANT.participantHash,
      amount: 30,
      kind: "challenge",
      idempotencyKey: "t:same",
    });
    expect(again.duplicate).toBe(true);
    const account = await getCoinAccount(db, PARTICIPANT.participantHash);
    expect(account?.balance).toBe(30);
  });

  it("CHECK 约束与前置守卫保证余额不为负", async () => {
    seedSurvey(db, 1);
    const sqlite = (db as unknown as { sqlite: DatabaseSync }).sqlite;
    sqlite
      .prepare(
        `INSERT INTO survey_coin_access (survey_id, enabled, base_price, auto_price, fixed_price, updated_at)
         VALUES (1, 1, 0, 0, 25, '2026-01-01T00:00:00Z')`,
      )
      .run();
    await earnCoins(db, { participantHash: PARTICIPANT.participantHash, amount: 10, kind: "checkin", idempotencyKey: "t:e" });
    // 余额不足：业务侧收到 402 语义的 CoinLedgerError，而不是写坏账本。
    await expect(
      unlockSurvey(db, { id: 1, ownerId: 999 }, PARTICIPANT, "unlocks-1"),
    ).rejects.toMatchObject({ code: "insufficient_funds" });
    const txn = await db
      .prepare(`SELECT COUNT(*) AS n FROM coin_transactions WHERE kind='survey_unlock'`)
      .first<{ n: number }>();
    expect(Number(txn?.n ?? 0)).toBe(0);
  });
});

describe("每日签到", () => {
  it("签到、重复签到幂等、阶梯金额", async () => {
    const first = await performCheckin(db, PARTICIPANT.participantHash, PARTICIPANT.dbUserId);
    expect(first.duplicate).toBe(false);
    expect(first.amount).toBe(5);
    const again = await performCheckin(db, PARTICIPANT.participantHash, PARTICIPANT.dbUserId);
    expect(again.duplicate).toBe(true);
    expect(again.amount).toBe(5);
    const status = await getCheckinStatus(db, PARTICIPANT.participantHash);
    expect(status.checkedInToday).toBe(true);
    expect(status.streak).toBe(1);
  });

  it("连续签到提升阶梯档位", async () => {
    const sqlite = (db as unknown as { sqlite: DatabaseSync }).sqlite;
    // 预置昨天与前天的签到：今天签到应落在 streak=3 档（amount 8）。
    // 日期必须与服务端同一日键（coinDayKey = UTC+偏移），否则午夜后 8 小时内
    // UTC 日期与服务日键错位，这条测试会在本地 00:00-08:00 间随机挂。
    const { coinDayKey, loadCoinConfig } = await import("../../../src/services/coin/config.service");
    const cfg = await loadCoinConfig(db);
    const today = Date.now();
    for (const delta of [2, 1]) {
      const day = coinDayKey(today - delta * 86_400_000, cfg.timezoneOffsetMinutes);
      sqlite
        .prepare(`INSERT INTO coin_checkins (participant_hash, day, streak, amount, created_at) VALUES (?, ?, ?, 5, '2026-01-01T00:00:00Z')`)
        .run(PARTICIPANT.participantHash, day, delta);
    }
    const result = await performCheckin(db, PARTICIPANT.participantHash, PARTICIPANT.dbUserId);
    expect(result.streak).toBe(3);
    expect(result.amount).toBe(8);
  });
});

describe("问卷解锁", () => {
  it("免费问卷（无配置）无需解锁", async () => {
    seedSurvey(db, 1);
    const result = await unlockSurvey(db, { id: 1, ownerId: 999 }, PARTICIPANT, "unlocks-free-1");
    expect(result.pricePaid).toBe(0);
    const gate = await resolveCoinGate(db, { id: 1, ownerId: 999 }, PARTICIPANT, []);
    expect(gate.enabled).toBe(false);
  });

  it("扣款解锁、重复购买幂等、余额不足不落解锁行", async () => {
    seedSurvey(db, 1);
    const sqlite = (db as unknown as { sqlite: DatabaseSync }).sqlite;
    sqlite
      .prepare(
        `INSERT INTO survey_coin_access (survey_id, enabled, base_price, auto_price, fixed_price, updated_at)
         VALUES (1, 1, 0, 0, 25, '2026-01-01T00:00:00Z')`,
      )
      .run();
    await earnCoins(db, { participantHash: PARTICIPANT.participantHash, amount: 100, kind: "checkin", idempotencyKey: "t:seed" });

    const first = await unlockSurvey(db, { id: 1, ownerId: 999 }, PARTICIPANT, "attempt-a");
    expect(first.duplicate).toBe(false);
    expect(first.pricePaid).toBe(25);
    expect(first.balance).toBe(75);

    // 不同幂等键的重复购买：已解锁，不再扣款。
    const second = await unlockSurvey(db, { id: 1, ownerId: 999 }, PARTICIPANT, "attempt-b");
    expect(second.duplicate).toBe(true);
    expect(second.pricePaid).toBe(25); // 返回既有解锁的实付价，不再扣款
    expect((await getCoinAccount(db, PARTICIPANT.participantHash))?.balance).toBe(75);

    // 同一幂等键重试（网络重放）：幂等返回，不重复扣款。
    const retry = await unlockSurvey(db, { id: 1, ownerId: 999 }, PARTICIPANT, "attempt-a");
    expect(retry.duplicate).toBe(true);
    expect((await getCoinAccount(db, PARTICIPANT.participantHash))?.balance).toBe(75);

    // 他人解锁：作者免费，普通用户要付。
    const gate = await resolveCoinGate(db, { id: 1, ownerId: 999 }, PARTICIPANT, []);
    expect(gate).toMatchObject({ enabled: true, unlocked: true, price: 25 });
    const other = { participantHash: "web_other", dbUserId: null };
    const otherGate = await resolveCoinGate(db, { id: 1, ownerId: 999 }, other, []);
    expect(otherGate.unlocked).toBe(false);
    const ownerGate = await resolveCoinGate(db, { id: 1, ownerId: 999 }, { participantHash: "web_owner", dbUserId: 999 }, []);
    expect(ownerGate.unlocked).toBe(true);

    // 余额不足：解锁行不存在（失败不产生业务状态）。
    const poor = { participantHash: "web_poor", dbUserId: null };
    await expect(unlockSurvey(db, { id: 1, ownerId: 999 }, poor, "attempt-c")).rejects.toMatchObject({
      code: "insufficient_funds",
    });
    const unlockRows = await db.prepare(`SELECT COUNT(*) AS n FROM survey_unlocks`).first<{ n: number }>();
    expect(Number(unlockRows?.n ?? 0)).toBe(1);
  });
});

describe("抽卡", () => {
  it("加权抽取是纯函数且尊重权重", () => {
    const items = [
      { id: 1, submissionId: null, title: "N", description: "", contentType: "text", rarity: "N" as const, weight: 0, stock: null, previewMediaId: null },
      { id: 2, submissionId: null, title: "SSR", description: "", contentType: "text", rarity: "SSR" as const, weight: 10, stock: null, previewMediaId: null },
    ];
    expect(drawWeighted(items, () => 0.5)?.id).toBe(2);
    expect(drawWeighted(items, () => 0.999)?.id).toBe(2);
    expect(drawWeighted(items, () => 0.1)?.id).toBe(2); // weight 0 不会被抽中
  });

  it("抽取扣款、记录版本与幂等重放", async () => {
    const poolId = seedPool(db);
    seedPoolItem(db, poolId, "N", 1);
    await earnCoins(db, { participantHash: PARTICIPANT.participantHash, amount: 100, kind: "checkin", idempotencyKey: "t:seed" });

    const result = await pullGacha(
      { DB: db } as never,
      { id: poolId, slug: "test-pool", name: "测试池", description: "", costSingle: 10, costMulti: null, status: "active", startAt: null, endAt: null, pityAt: null, defaultAccess: "permanent", version: 1, contentRating: "all" as const },
      PARTICIPANT,
      1,
      "pull-key-1",
    );
    expect(result.ok).toBe(true);
    expect(result.balance).toBe(90);
    const pullRow = await db
      .prepare(`SELECT pool_version, participant_hash FROM gacha_pulls WHERE idempotency_key='pull:pull-key-1#0'`)
      .first<{ pool_version: number; participant_hash: string }>();
    expect(pullRow?.pool_version).toBe(1);

    // 同幂等键重放：返回同一批结果，不重复扣款。
    const replay = await pullGacha(
      { DB: db } as never,
      { id: poolId, slug: "test-pool", name: "测试池", description: "", costSingle: 10, costMulti: null, status: "active", startAt: null, endAt: null, pityAt: null, defaultAccess: "permanent", version: 1, contentRating: "all" as const },
      PARTICIPANT,
      1,
      "pull-key-1",
    );
    expect(replay.duplicate).toBe(true);
    expect(replay.results.length).toBe(1);
    expect((await getCoinAccount(db, PARTICIPANT.participantHash))?.balance).toBe(90);
  });

  it("余额不足时不抽取", async () => {
    const poolId = seedPool(db);
    seedPoolItem(db, poolId, "N", 1);
    const result = await pullGacha(
      { DB: db } as never,
      { id: poolId, slug: "test-pool", name: "测试池", description: "", costSingle: 10, costMulti: null, status: "active", startAt: null, endAt: null, pityAt: null, defaultAccess: "permanent", version: 1, contentRating: "all" as const },
      PARTICIPANT,
      1,
      "pull-poor",
    );
    expect(result.insufficient).toBe(true);
    const pulls = await db.prepare(`SELECT COUNT(*) AS n FROM gacha_pulls`).first<{ n: number }>();
    expect(Number(pulls?.n ?? 0)).toBe(0);
  });

  it("保底：达到 pity 必出高稀有", async () => {
    const poolId = seedPool(db, { pityAt: 1 });
    seedPoolItem(db, poolId, "N", 1_000_000);
    seedPoolItem(db, poolId, "SSR", 1);
    await earnCoins(db, { participantHash: PARTICIPANT.participantHash, amount: 100, kind: "checkin", idempotencyKey: "t:seed" });
    const result = await pullGacha(
      { DB: db } as never,
      { id: poolId, slug: "test-pool", name: "测试池", description: "", costSingle: 10, costMulti: null, status: "active", startAt: null, endAt: null, pityAt: 1, defaultAccess: "permanent", version: 1, contentRating: "all" as const },
      PARTICIPANT,
      1,
      "pull-pity",
    );
    expect(result.results[0]?.rarity).toBe("SSR");
    expect(result.results[0]?.pity).toBe(true);
  });

  it("库存耗尽触发补偿退款，不超发", async () => {
    const poolId = seedPool(db);
    const only = seedPoolItem(db, poolId, "N", 1, 1); // 库存 1
    await earnCoins(db, { participantHash: PARTICIPANT.participantHash, amount: 100, kind: "checkin", idempotencyKey: "t:seed" });
    const result = await pullGacha(
      { DB: db } as never,
      { id: poolId, slug: "test-pool", name: "测试池", description: "", costSingle: 10, costMulti: 90, status: "active", startAt: null, endAt: null, pityAt: null, defaultAccess: "permanent", version: 1, contentRating: "all" as const },
      PARTICIPANT,
      2, // 十连价的 2 连：只有 1 个库存
      "pull-stock",
    );
    expect(result.ok).toBe(true);
    // 只发出 1 份库存，差额已退：100 - 90(2连价) + 45(1次差额) = 55。
    expect(result.balance).toBe(55);
    const remaining = await db.prepare(`SELECT remaining FROM gacha_pool_items WHERE id=?`).bind(only).first<{ remaining: number }>();
    expect(Number(remaining?.remaining ?? 1)).toBe(0);
    const refund = await db
      .prepare(`SELECT amount FROM coin_transactions WHERE idempotency_key='pull:pull-stock:refund'`)
      .first<{ amount: number }>();
    expect(Number(refund?.amount ?? 0)).toBe(45);
  });

  it("奖池列表只含 active 且在期的池", async () => {
    seedPool(db);
    const pools = await listActivePools(db);
    expect(pools).toHaveLength(1);
  });
});


describe("补签（默认关闭，管理员开启后可用）", () => {
  async function enableBackfill(db: D1Database, cost = 10, maxDays = 7): Promise<void> {
    sqliteOf(db)
      .prepare(
        `INSERT INTO coin_config (key, value, updated_by, updated_at) VALUES ('checkin', ?, 'test', '2026-01-01')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(JSON.stringify({ backfill: { enabled: true, cost, maxBackfillDays: maxDays } }));
    const written = sqliteOf(db).prepare(`SELECT value FROM coin_config WHERE key='checkin'`).get() as
      | { value: string }
      | undefined;
    expect(written?.value).toContain("backfill");
  }

  function dayOffset(days: number): string {
    return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  }

  it("关闭时补签被拒绝", async () => {
    await expect(
      backfillCheckin(db, PARTICIPANT.participantHash, PARTICIPANT.dbUserId, dayOffset(1)),
    ).rejects.toMatchObject({ name: "CoinLedgerError" });
  });

  it("开启后扣款补签、重复补签不重复扣款", async () => {
    await enableBackfill(db);
    await earnCoins(db, { participantHash: PARTICIPANT.participantHash, amount: 50, kind: "checkin", idempotencyKey: "t:bf" });
    const day = dayOffset(2);
    const first = await backfillCheckin(db, PARTICIPANT.participantHash, PARTICIPANT.dbUserId, day);
    expect(first.duplicate).toBe(false);
    expect(first.cost).toBe(10);
    expect(first.balance).toBe(40);
    const second = await backfillCheckin(db, PARTICIPANT.participantHash, PARTICIPANT.dbUserId, day);
    expect(second.duplicate).toBe(true);
    expect((await getCoinAccount(db, PARTICIPANT.participantHash))?.balance).toBe(40);
  });

  it("拒绝补未来/超窗口/余额不足，且不产生签到行", async () => {
    await enableBackfill(db);
    await expect(
      backfillCheckin(db, PARTICIPANT.participantHash, PARTICIPANT.dbUserId, new Date().toISOString().slice(0, 10)),
    ).rejects.toThrow();
    await expect(
      backfillCheckin(db, PARTICIPANT.participantHash, PARTICIPANT.dbUserId, dayOffset(30)),
    ).rejects.toThrow();
    // 余额 0：不扣款也不落签到行。
    await expect(
      backfillCheckin(db, PARTICIPANT.participantHash, PARTICIPANT.dbUserId, dayOffset(1)),
    ).rejects.toMatchObject({ code: "insufficient_funds" });
    const rows = await db.prepare(`SELECT COUNT(*) AS n FROM coin_checkins`).first<{ n: number }>();
    expect(Number(rows?.n ?? 0)).toBe(0);
  });
});

describe("内容安全审核适配器", () => {
  it("默认关闭：不调用外部服务，结论为人工审核", async () => {
    const verdict = await moderateSubmission({ DB: db }, { type: "text", title: "t", text: "hello" });
    expect(verdict).toEqual({ consulted: false, action: "review", score: null, reason: null });
  });

  it("启用但未配置密钥时仍转人工（绝不因缺配置放行）", async () => {
    sqliteOf(db)
      .prepare(
        `INSERT OR REPLACE INTO coin_config (key, value, updated_by, updated_at)
         VALUES ('moderation', ?, 'test', '2026-01-01')`,
      )
      .run(JSON.stringify({ enabled: true, endpoint: "https://moderation.example.com/check" }));
    const verdict = await moderateSubmission({ DB: db }, { type: "text", title: "t", text: "hello" });
    expect(verdict.consulted).toBe(false);
    expect(verdict.action).toBe("review");
  });

  it("服务不可达时降级人工（不抛错、不放行）", async () => {
    sqliteOf(db)
      .prepare(
        `INSERT OR REPLACE INTO coin_config (key, value, updated_by, updated_at)
         VALUES ('moderation', ?, 'test', '2026-01-01')`,
      )
      .run(JSON.stringify({ enabled: true, endpoint: "https://moderation.example.com/check", timeoutMs: 300 }));
    const verdict = await moderateSubmission(
      { DB: db, MODERATION_API_KEY: "test-key" },
      { type: "text", title: "t", text: "hello" },
    );
    expect(verdict.consulted).toBe(false);
    expect(verdict.action).toBe("review");
  });

  it("拒绝判定会拦截投稿（content_rejected）", async () => {
    sqliteOf(db)
      .prepare(
        `INSERT OR REPLACE INTO coin_config (key, value, updated_by, updated_at)
         VALUES ('moderation', ?, 'test', '2026-01-01')`,
      )
      .run(JSON.stringify({ enabled: true, endpoint: "https://moderation.example.com/check" }));
    const originalFetch = globalThis.fetch;
    // 外部服务返回"拒绝"：投稿必须被拦截，且绝不落库。
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ action: "reject", score: 0.95, reason: "违规示例" }), { status: 200 })) as typeof fetch;
    try {
      await expect(
        createSubmission(
          { DB: db as D1Database, MEDIA_KV: {} as KVNamespace, MODERATION_API_KEY: "test-key" },
          { ...PARTICIPANT, kind: "email" },
          { type: "text", title: "可疑内容", contentText: "xxx", authorization: { confirmOwn: true } },
        ),
      ).rejects.toMatchObject({ code: "content_rejected" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("投稿媒体（缩略图与音频时长）", () => {
  it("图片投稿保存缩略图引用，音频投稿保存时长", async () => {
    const env = { DB: db as D1Database, MEDIA_KV: fakeKv() };
    // 合法 PNG 字节（1x1），签名校验通过。
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
      0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
      0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
      0x42, 0x60, 0x82,
    ]);
    const created = await createSubmission(env, { ...PARTICIPANT, kind: "email" }, {
      type: "image",
      title: "图片投稿",
      file: new File([png], "photo.png", { type: "image/png" }),
      thumbFile: new File([png], "thumb.png", { type: "image/png" }),
      authorization: { confirmOwn: true },
    });
    expect(created.status).toBe("pending");
    const row = await db
      .prepare(`SELECT media_asset_id, thumb_media_asset_id FROM submissions WHERE id = ?`)
      .bind(created.id)
      .first<{ media_asset_id: number; thumb_media_asset_id: number }>();
    expect(row?.media_asset_id).not.toBeNull();
    expect(row?.thumb_media_asset_id).not.toBeNull();
    expect(row?.thumb_media_asset_id).not.toBe(row?.media_asset_id);

    const audio = await createSubmission(env, { ...PARTICIPANT, kind: "email" }, {
      type: "audio",
      title: "音频投稿",
      file: new File([new Uint8Array([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00])], "clip.mp3", { type: "audio/mpeg" }),
      durationSeconds: 42,
      authorization: { confirmOwn: true },
    });
    const audioRow = await db
      .prepare(`SELECT media_duration_seconds FROM submissions WHERE id = ?`)
      .bind(audio.id)
      .first<{ media_duration_seconds: number }>();
    expect(Number(audioRow?.media_duration_seconds)).toBe(42);
  });
});


describe("问卷列表的访问方式展示", () => {
  /** 列表端点用到的环境（KV 只被 bot username 缓存用到，列表本体不缓存）。 */
  function listEnv(): { DB: D1Database; CACHE: KVNamespace; BOT_TOKEN: string } {
    return { DB: db as D1Database, CACHE: fakeKv(), BOT_TOKEN: "test" };
  }

  function seedPublishedSurvey(id: number, title: string): void {
    sqliteOf(db)
      .prepare(
        `INSERT INTO surveys (id, owner_id, title, status, published_at, updated_at, anonymous)
         VALUES (?, 3, ?, 'published', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 0)`,
      )
      .run(id, title);
  }

  it("免费问卷不带金币字段（列表行为与改造前一致）", async () => {
    seedPublishedSurvey(301, "免费问卷");
    const { loadPublishedSurveyList } = await import("../../../src/http/survey/catalog");
    const items = await loadPublishedSurveyList(listEnv() as never, "");
    const item = items.find((entry) => entry.id === 301);
    expect(item).toBeDefined();
    expect(item!.coinUnlock).toBeUndefined();
    expect(item!.accessCodeRequired).toBe(false);
  });

  it("启用金币解锁的问卷带价格，密码问卷仍单独标记", async () => {
    seedPublishedSurvey(302, "金币问卷");
    seedPublishedSurvey(303, "密码问卷");
    const sqlite = sqliteOf(db);
    sqlite
      .prepare(
        `INSERT INTO survey_coin_access (survey_id, enabled, base_price, auto_price, fixed_price, updated_at)
         VALUES (302, 1, 0, 0, 42, '2026-01-01T00:00:00Z')`,
      )
      .run();
    sqlite.prepare(`UPDATE surveys SET access_code = 'hashed' WHERE id = 303`).run();
    // 未启用的配置行不得影响列表。
    sqlite
      .prepare(
        `INSERT INTO survey_coin_access (survey_id, enabled, base_price, auto_price, fixed_price, updated_at)
         VALUES (303, 0, 0, 1, NULL, '2026-01-01T00:00:00Z')`,
      )
      .run();

    const { loadPublishedSurveyList } = await import("../../../src/http/survey/catalog");
    const items = await loadPublishedSurveyList(listEnv() as never, "");
    const coin = items.find((entry) => entry.id === 302);
    const password = items.find((entry) => entry.id === 303);
    expect(coin!.coinUnlock).toEqual({ price: 42 });
    expect(password!.coinUnlock).toBeUndefined();
    expect(password!.accessCodeRequired).toBe(true);
  });

  it("自动定价按热度计算，且受平台上下限约束", async () => {
    seedPublishedSurvey(304, "热度问卷");
    const sqlite = sqliteOf(db);
    sqlite
      .prepare(
        `INSERT INTO survey_coin_access (survey_id, enabled, base_price, auto_price, fixed_price, updated_at)
         VALUES (304, 1, 50, 1, NULL, '2026-01-01T00:00:00Z')`,
      )
      .run();
    // 近 30 天 3 份完成答卷 → 50 × (1 + 0.5·ln4) ≈ 119（日期必须落在窗口内）
    const recent = new Date(Date.now() - 2 * 86_400_000).toISOString();
    for (let index = 0; index < 3; index += 1) {
      sqlite
        .prepare(
          `INSERT INTO survey_responses (survey_id, participant_hash, status, created_at)
           VALUES (304, ?, 'completed', ?)`,
        )
        .run(`web_hot_${index}`, recent);
    }
    // 过期的完成记录不应计入（不落 created_at 过滤窗口）。
    sqlite
      .prepare(
        `INSERT INTO survey_responses (survey_id, participant_hash, status, created_at)
         VALUES (304, 'web_old', 'completed', '2000-01-01T00:00:00Z')`,
      )
      .run();

    const { loadPublishedSurveyList } = await import("../../../src/http/survey/catalog");
    const items = await loadPublishedSurveyList(listEnv() as never, "");
    const hot = items.find((entry) => entry.id === 304);
    expect(hot!.coinUnlock!.price).toBeGreaterThan(50);
    expect(hot!.coinUnlock!.price).toBeLessThanOrEqual(500);
  });
});

describe("投稿", () => {
  const mkEnv = () => ({ DB: db as D1Database, MEDIA_KV: {} as KVNamespace });

  it("文本投稿进入待审、重复内容被去重", async () => {
    const first = await createSubmission(mkEnv(), { ...PARTICIPANT, kind: "email" }, {
      type: "text",
      title: "一篇小故事",
      contentText: "很久很久以前。",
      authorization: { confirmOwn: true, publishToPool: true },
    });
    expect(first.status).toBe("pending");
    await expect(
      createSubmission(mkEnv(), { ...PARTICIPANT, kind: "email" }, {
        type: "text",
        title: "换个标题",
        contentText: "很久很久以前。",
        authorization: { confirmOwn: true },
      }),
    ).rejects.toMatchObject({ code: "duplicate_content" });
  });

  it("匿名身份不可投稿、缺少授权确认被拒绝", async () => {
    await expect(
      createSubmission(mkEnv(), { participantHash: "web_anon", dbUserId: null, kind: "anonymous" }, {
        type: "text",
        title: "x",
        contentText: "hello",
        authorization: { confirmOwn: true },
      }),
    ).rejects.toMatchObject({ code: "identity_required" });
    await expect(
      createSubmission(mkEnv(), { ...PARTICIPANT, kind: "email" }, {
        type: "text",
        title: "x",
        contentText: "hello",
        authorization: {},
      }),
    ).rejects.toMatchObject({ code: "authorization_required" });
  });

  it("审核通过发放幂等奖励，重复审核不重复发放", async () => {
    await createSubmission(mkEnv(), { ...PARTICIPANT, kind: "email" }, {
      type: "text",
      title: "一篇小故事",
      contentText: "内容。",
      authorization: { confirmOwn: true },
    });
    const row = await db.prepare(`SELECT id FROM submissions`).first<{ id: number }>();
    const submissionId = Number(row?.id);
    const first = await reviewSubmission(db, submissionId, "approved", "admin:1", { qualityTier: 2 });
    expect(first.reward).toBe(30); // 20 × 1.5
    const again = await reviewSubmission(db, submissionId, "approved", "admin:1", { qualityTier: 2 });
    expect(again.reward).toBeNull();
    const balance = await getCoinAccount(db, PARTICIPANT.participantHash);
    expect(balance?.balance).toBe(30);
  });
});
