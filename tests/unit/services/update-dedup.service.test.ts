import { describe, expect, it, vi } from "vitest";

import {
  createMemoryUpdateDedupStore,
  createUpdateDedupStore,
  STALE_CLAIM_MS,
} from "../../../src/services/update-dedup.service";

interface DedupRow {
  receivedAt: string;
  status: "processing" | "done";
}

/**
 * Minimal in-memory stand-in for the two SQL shapes the dedup store issues.
 * It mirrors SQLite's ON CONFLICT DO UPDATE ... WHERE semantics closely enough
 * to prove the takeover rules (never a `done` row, only a stale `processing`
 * row) that the concurrency guarantees rest on.
 *
 * `interleave` 模拟 D1 的语句级原子性：所有在途语句先挂起一个宏任务再按到达
 * 顺序逐个原子应用。没有这个错峰的话，单线程测试里的并发 claim 会在第一个
 * 语句同步落库后才发起，根本构造不出「同时到达」的竞争。应用（读冲突检查 +
 * 写入）仍然是一个同步块，等价于 D1 对单条语句的原子执行。
 */
function createFakeDedupDb(options: { statusColumn?: boolean; interleave?: boolean } = {}) {
  const rows = new Map<number, DedupRow>();
  const statusColumn = options.statusColumn ?? true;
  const interleave = options.interleave ?? false;

  const db = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const statement = {
        bind(...args: unknown[]) {
          bound = args;
          return statement;
        },
        async run() {
          if (interleave) {
            // 让同一事件循环里发起的全部并发语句先到达，再逐个原子应用。
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
          if (sql.includes("INSERT INTO telegram_update_dedup")) {
            if (sql.includes("status") && !statusColumn) {
              throw new Error("no such column: status");
            }
            const [updateId, receivedAt, staleCutoff] = bound as [number, string, string?];
            const existing = rows.get(updateId);
            if (!existing) {
              rows.set(updateId, { receivedAt, status: "processing" });
              return { success: true, meta: { changes: 1 } };
            }
            if (staleCutoff !== undefined && existing.status !== "done" && existing.receivedAt <= staleCutoff) {
              rows.set(updateId, { receivedAt, status: "processing" });
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
          if (sql.includes("UPDATE telegram_update_dedup")) {
            const [receivedAt, updateId] = bound as [string, number];
            const existing = rows.get(updateId);
            if (existing && existing.status !== "done") {
              rows.set(updateId, { receivedAt, status: "done" });
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
          if (sql.includes("DELETE FROM telegram_update_dedup")) {
            const [updateId] = bound as [number];
            const existing = rows.get(updateId);
            if (!existing) return { success: true, meta: { changes: 0 } };
            const respectsStatus = sql.includes("status <> 'done'");
            if (!respectsStatus || existing.status !== "done") {
              rows.delete(updateId);
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
          throw new Error(`unexpected SQL: ${sql}`);
        },
      };
      return statement;
    },
  };

  return { db: db as unknown as D1Database, rows };
}

describe("update dedup store", () => {
  it("claims once and skips a concurrent duplicate", async () => {
    const { db } = createFakeDedupDb();
    const store = createUpdateDedupStore(db, () => "2026-09-18T00:00:00.000Z");

    expect(await store.claim(101)).toBe(true);
    expect(await store.claim(101)).toBe(false);
  });

  it("keeps completed updates skipped on a redelivery", async () => {
    const { db } = createFakeDedupDb();
    const store = createUpdateDedupStore(db, () => "2026-09-18T00:00:00.000Z");

    await store.claim(102);
    await store.complete(102);

    expect(await store.claim(102)).toBe(false);
  });

  it("releases a failed claim so a retry can run again", async () => {
    const { db } = createFakeDedupDb();
    const store = createUpdateDedupStore(db, () => "2026-09-18T00:00:00.000Z");

    await store.claim(103);
    await store.release(103);

    expect(await store.claim(103)).toBe(true);
  });

  it("never releases a completed claim", async () => {
    const { db, rows } = createFakeDedupDb();
    const store = createUpdateDedupStore(db, () => "2026-09-18T00:00:00.000Z");

    await store.claim(104);
    await store.complete(104);
    await store.release(104);

    expect(rows.has(104)).toBe(true);
    expect(await store.claim(104)).toBe(false);
  });

  it("takes over a stale processing claim left by a crashed attempt", async () => {
    const { db } = createFakeDedupDb();
    const first = new Date("2026-09-18T00:00:00.000Z").getTime();
    let clock = first;
    const store = createUpdateDedupStore(db, () => new Date(clock).toISOString());

    expect(await store.claim(105)).toBe(true);

    // A redelivery inside the stale window is still treated as concurrent.
    clock = first + STALE_CLAIM_MS / 2;
    expect(await store.claim(105)).toBe(false);

    // After the window the crashed claim may be retried rather than swallowed.
    clock = first + STALE_CLAIM_MS + 1;
    expect(await store.claim(105)).toBe(true);
  });

  it("falls back to the 0052 claim when the status column is missing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { db } = createFakeDedupDb({ statusColumn: false });
    const store = createUpdateDedupStore(db, () => "2026-09-18T00:00:00.000Z");

    expect(await store.claim(106)).toBe(true);
    expect(await store.claim(106)).toBe(false);
    await store.release(106);
    expect(await store.claim(106)).toBe(true);

    warn.mockRestore();
  });

  it("fails open when the table is missing entirely", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const db = {
      prepare: () => ({
        bind() {
          return this;
        },
        async run() {
          throw new Error("no such table: telegram_update_dedup");
        },
      }),
    } as unknown as D1Database;
    const store = createUpdateDedupStore(db, () => "2026-09-18T00:00:00.000Z");

    expect(await store.claim(107)).toBe(true);
    warn.mockRestore();
  });

  it("ignores invalid update ids", async () => {
    const { db } = createFakeDedupDb();
    const store = createUpdateDedupStore(db);

    expect(await store.claim(0)).toBe(true);
    expect(await store.claim(Number.NaN)).toBe(true);
    await expect(store.complete(0)).resolves.toBeUndefined();
    await expect(store.release(0)).resolves.toBeUndefined();
  });
});

describe("update dedup concurrency (fake db 交错)", () => {
  const FIXED_NOW = Date.parse("2026-09-18T00:00:00.000Z");

  // Telegram 的重发窗口（分钟级）远大于这里单次测试的执行时长，所以用真实
  // 时钟时所有并发认领都落在 stale 窗口内，第二个及之后的认领必须被拒绝。
  it("同一 update_id 并发 2/5/10 次认领，恰好一次成功", async () => {
    for (const concurrency of [2, 5, 10]) {
      const { db, rows } = createFakeDedupDb({ interleave: true });
      const store = createUpdateDedupStore(db, () => new Date(FIXED_NOW).toISOString());

      const results = await Promise.all(Array.from({ length: concurrency }, () => store.claim(900)));
      const winners = results.filter(Boolean);

      expect(winners).toHaveLength(1);
      // 唯一的赢家写入一行 processing，received_at 是它自己的时间戳
      expect(rows.get(900)).toEqual({
        receivedAt: new Date(FIXED_NOW).toISOString(),
        status: "processing",
      });
    }
  });

  it("complete 之后的并发重放全部被 done 行拦截，且零写入", async () => {
    const { db, rows } = createFakeDedupDb({ interleave: true });
    const store = createUpdateDedupStore(db, () => new Date(FIXED_NOW).toISOString());

    await store.claim(910);
    await store.complete(910);
    const before = { ...rows.get(910)! };

    const results = await Promise.all(Array.from({ length: 10 }, () => store.claim(910)));

    expect(results.every((claimed) => claimed === false)).toBe(true);
    // done 行原样：received_at 与 status 都没动 —— 重放连一次写都没发生
    expect(rows.get(910)).toEqual(before);
  });

  it("claim 后崩溃 → 窗口内重放不动 → stale 接管 → 恰好一次重放", async () => {
    const { db } = createFakeDedupDb({ interleave: true });
    let clock = FIXED_NOW;
    const store = createUpdateDedupStore(db, () => new Date(clock).toISOString());
    let businessRuns = 0;
    const runBusiness = async () => {
      businessRuns += 1;
    };

    // 第一次投递：认领成功后 Worker 被回收 —— complete/release 都没机会执行，
    // 业务也没有跑到（崩溃点在副作用之前），processing 行悬在表里。
    expect(await store.claim(911)).toBe(true);

    // Telegram 在 stale 窗口内的重发不接管：绝不能和崩溃方并发重放。
    clock = FIXED_NOW + STALE_CLAIM_MS / 2;
    expect(await store.claim(911)).toBe(false);

    // 窗口之外的重发判定原持有者已死，接管 processing 行并重放业务。
    clock = FIXED_NOW + STALE_CLAIM_MS + 1;
    expect(await store.claim(911)).toBe(true);
    await runBusiness();
    await store.complete(911);

    // 重放完成后的后续重发被 done 行拦住，不会再跑业务。
    clock += 60_000;
    expect(await store.claim(911)).toBe(false);

    // 整条时间线上业务恰好执行一次：崩溃方没跑、窗口内重发没跑、
    // 接管方跑了一次、done 之后不再跑。
    expect(businessRuns).toBe(1);
  });
});

describe("memory update dedup store", () => {
  it("mirrors the claim/complete/release lifecycle", async () => {
    const store = createMemoryUpdateDedupStore();

    expect(await store.claim(1)).toBe(true);
    expect(await store.claim(1)).toBe(false);
    await store.complete(1);
    await store.release(1);
    expect(await store.claim(1)).toBe(false);

    expect(await store.claim(2)).toBe(true);
    await store.release(2);
    expect(await store.claim(2)).toBe(true);
  });
});
