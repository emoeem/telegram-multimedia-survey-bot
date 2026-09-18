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
 */
function createFakeDedupDb(options: { statusColumn?: boolean } = {}) {
  const rows = new Map<number, DedupRow>();
  const statusColumn = options.statusColumn ?? true;

  const db = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const statement = {
        bind(...args: unknown[]) {
          bound = args;
          return statement;
        },
        async run() {
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
