import { describe, expect, it, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  canonicalizeHash,
  claimParticipantKey,
  HASH_SET_SQL,
  hashSetFor,
  linkHash,
  mergeCoinAccount,
  unlinkHash,
} from "../../../src/services/identity-link.service";
import { getCoinAccount } from "../../../src/services/coin/ledger.service";

/**
 * 身份统一（0082）的行为测试：真实 SQLite 验证映射的幂等/重指向、canonicalize
 * 的直通与回退，以及金币合并的守卫与幂等键（同一 source 只被吸收一次）。
 */

const SCHEMA = [
  readFileSync(join(__dirname, "../../../db/migrations/0078_coin_economy.sql"), "utf-8"),
  readFileSync(join(__dirname, "../../../db/migrations/0079_coin_economy_followups.sql"), "utf-8"),
  `
  CREATE TABLE participant_hash_links (
    source_hash TEXT PRIMARY KEY,
    canonical_hash TEXT NOT NULL,
    method TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE participant_preferences (
    participant_hash TEXT PRIMARY KEY,
    age_verified_at TEXT,
    updated_at TEXT NOT NULL
  );`,
].join("\n");

function createDb(): D1Database & { sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(SCHEMA);
  const wrapper = {
    sqlite,
    prepare(sql: string) {
      const statement = {
        bind: (...bound: unknown[]) => {
          const run = sqlite.prepare(sql);
          const params = bound as never[];
          return {
            first: async <T>() => (run.get(...params) as T | undefined) ?? null,
            all: async <T>() => ({ results: run.all(...params) as unknown as T[], meta: {} }),
            run: async () => {
              const outcome = run.run(...params) as unknown as { changes: number };
              return { success: true, meta: { changes: outcome.changes, last_row_id: 0 } };
            },
          };
        },
        first: async <T>() => (sqlite.prepare(sql).get() as T | undefined) ?? null,
        all: async <T>() => ({ results: sqlite.prepare(sql).all() as unknown as T[], meta: {} }),
        run: async () => ({ success: true, meta: { changes: 0, last_row_id: 0 } }),
      };
      return statement;
    },
    async batch(statements: Array<{ run: () => Promise<unknown> }>) {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) await statement.run();
        results.push({ meta: { changes: 0 } });
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return wrapper as unknown as D1Database & { sqlite: DatabaseSync };
}

let db: D1Database & { sqlite: DatabaseSync };

beforeEach(() => {
  db = createDb();
});

describe("identity link", () => {
  it("user_* hashes bypass the mapping table entirely", async () => {
    const canonical = await canonicalizeHash(db, undefined, "user_7");
    expect(canonical).toBe("user_7");
    const count = db.sqlite.prepare("SELECT COUNT(*) AS n FROM participant_hash_links").get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("links a source hash and canonicalizes through it", async () => {
    await linkHash(db, undefined, { sourceHash: "web_abc", canonicalHash: "user_7", method: "email_claim" });
    expect(await canonicalizeHash(db, undefined, "web_abc")).toBe("user_7");
    const set = await hashSetFor(db, "user_7");
    expect(set.params.sort()).toEqual(["user_7", "web_abc"]);
  });

  it("unlinked hashes resolve to themselves", async () => {
    expect(await canonicalizeHash(db, undefined, "web_nolink")).toBe("web_nolink");
    expect(await hashSetFor(db, "web_nolink").then((set) => set.params)).toEqual(["web_nolink"]);
  });

  it("re-linking repoints the source (email account later bound to a user)", async () => {
    await linkHash(db, undefined, { sourceHash: "email_5", canonicalHash: "email_5", method: "email_claim" }).catch(
      () => undefined,
    );
    await linkHash(db, undefined, { sourceHash: "email_5", canonicalHash: "user_9", method: "email_claim" });
    expect(await canonicalizeHash(db, undefined, "email_5")).toBe("user_9");
  });

  it("refuses user_* as a source and ignores self-mapping", async () => {
    await expect(
      linkHash(db, undefined, { sourceHash: "user_7", canonicalHash: "user_9", method: "admin" }),
    ).rejects.toThrow();
    await linkHash(db, undefined, { sourceHash: "web_x", canonicalHash: "web_x", method: "admin" });
    const count = db.sqlite.prepare("SELECT COUNT(*) AS n FROM participant_hash_links").get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("unlink restores the source view", async () => {
    await linkHash(db, undefined, { sourceHash: "web_abc", canonicalHash: "user_7", method: "tg_deep_link" });
    await unlinkHash(db, undefined, "web_abc");
    expect(await canonicalizeHash(db, undefined, "web_abc")).toBe("web_abc");
  });
});

describe("coin merge", () => {
  it("transfers the source balance into the canonical account as one merge_in transaction", async () => {
    const { earnCoins } = await import("../../../src/services/coin/ledger.service");
    await earnCoins(db, { participantHash: "web_abc", amount: 40, kind: "checkin", idempotencyKey: "seed:1" });

    const result = await mergeCoinAccount(db, { sourceHash: "web_abc", canonicalHash: "user_7", userId: 7 });
    expect(result.transferred).toBe(40);

    const canonical = await getCoinAccount(db, "user_7");
    expect(canonical?.balance).toBe(40);
    const source = await getCoinAccount(db, "web_abc");
    expect(source?.balance).toBe(0);
    const txn = db.sqlite
      .prepare("SELECT amount, kind FROM coin_transactions WHERE idempotency_key = 'merge:web_abc'")
      .get() as { amount: number; kind: string };
    expect(txn.amount).toBe(40);
    expect(txn.kind).toBe("merge_in");
  });

  it("is idempotent per source: re-merging transfers nothing (anti-farming)", async () => {
    const { earnCoins } = await import("../../../src/services/coin/ledger.service");
    await earnCoins(db, { participantHash: "web_abc", amount: 25, kind: "checkin", idempotencyKey: "seed:1" });
    await mergeCoinAccount(db, { sourceHash: "web_abc", canonicalHash: "user_7", userId: 7 });

    // 解绑后 source 又攒了新账，重新绑定也不得吸收（幂等键已存在）。
    await earnCoins(db, { participantHash: "web_abc", amount: 10, kind: "checkin", idempotencyKey: "seed:2" });
    const again = await mergeCoinAccount(db, { sourceHash: "web_abc", canonicalHash: "user_7", userId: 7 });
    expect(again.duplicate).toBe(true);
    expect(again.transferred).toBe(0);

    expect((await getCoinAccount(db, "user_7"))?.balance).toBe(25);
    expect((await getCoinAccount(db, "web_abc"))?.balance).toBe(10);
  });

  it("claims link the mapping and merge coins in one call", async () => {
    const { earnCoins } = await import("../../../src/services/coin/ledger.service");
    await earnCoins(db, { participantHash: "web_key1", amount: 5, kind: "checkin", idempotencyKey: "seed:1" });
    await claimParticipantKey(db, undefined, {
      participantKey: "key1",
      canonicalHash: "user_3",
      userId: 3,
      method: "tg_deep_link",
    });
    expect(await canonicalizeHash(db, undefined, "web_key1")).toBe("user_3");
    expect((await getCoinAccount(db, "user_3"))?.balance).toBe(5);
  });
});

describe("HASH_SET_SQL", () => {
  it("expands to canonical + sources inside a real query", async () => {
    const { earnCoins } = await import("../../../src/services/coin/ledger.service");
    await earnCoins(db, { participantHash: "web_old", amount: 7, kind: "checkin", idempotencyKey: "seed:1" });
    await earnCoins(db, { participantHash: "user_7", amount: 1, kind: "checkin", idempotencyKey: "seed:2" });
    await linkHash(db, undefined, { sourceHash: "web_old", canonicalHash: "user_7", method: "email_claim" });

    const rows = db.sqlite
      .prepare(
        `SELECT participant_hash FROM coin_accounts WHERE participant_hash ${HASH_SET_SQL.replaceAll("?", "?").replace("${HASH_SET_SQL}", "IN (SELECT source_hash FROM participant_hash_links WHERE canonical_hash = ? UNION SELECT ?)")}`,
      )
      .all("user_7", "user_7") as Array<{ participant_hash: string }>;
    expect(rows.map((row) => row.participant_hash).sort()).toEqual(["user_7", "web_old"]);
  });
});
