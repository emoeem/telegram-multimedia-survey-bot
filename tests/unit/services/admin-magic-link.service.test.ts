import { describe, expect, it, vi } from "vitest";

import {
  ADMIN_MAGIC_LINK_TTL_SECONDS,
  consumeAdminMagicLink,
  createAdminMagicLink,
  isAdminMagicLinkToken,
} from "../../../src/services/admin-magic-link.service";
import { createSqliteD1, sqliteD1Available } from "../../helpers/sqlite-d1";

/** KV 的最小内存替身：记录写入与删除，够验证一次性语义。 */
function createMemoryCache() {
  const store = new Map<string, string>();
  const deleted: string[] = [];
  const cache = {
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async delete(key: string) {
      deleted.push(key);
      store.delete(key);
    },
  };
  return { cache: cache as unknown as KVNamespace, store, deleted };
}

const SCHEMA = `
CREATE TABLE admin_login_consumptions (
  login_request_id TEXT PRIMARY KEY,
  telegram_user_id INTEGER NOT NULL,
  consumed_at TEXT NOT NULL
);
`;

describe("admin magic link", () => {
  it("accepts only well-formed tokens", () => {
    expect(isAdminMagicLinkToken("AbC-123_xyz890abcdefghij")).toBe(true);
    expect(isAdminMagicLinkToken("short")).toBe(false);
    expect(isAdminMagicLinkToken("has space 1234567890")).toBe(false);
    expect(isAdminMagicLinkToken("")).toBe(false);
  });

  it.skipIf(!sqliteD1Available)("redeems exactly once and clears the KV entry", async () => {
    const db = createSqliteD1(SCHEMA);
    const { cache, store, deleted } = createMemoryCache();
    const token = await createAdminMagicLink(cache, 7);
    expect(isAdminMagicLinkToken(token)).toBe(true);
    expect(store.size).toBe(1);

    expect(await consumeAdminMagicLink(db, cache, token)).toBe(7);
    expect(deleted).toHaveLength(1);
    expect(store.size).toBe(0);
    // 第二次：KV 已清，直接失败（永久一次性由 D1 行保证）。
    expect(await consumeAdminMagicLink(db, cache, token)).toBeNull();
  });

  it.skipIf(!sqliteD1Available)("lets only one of two concurrent redemptions win", async () => {
    const db = createSqliteD1(SCHEMA);
    const { cache } = createMemoryCache();
    const token = await createAdminMagicLink(cache, 9);
    const results = await Promise.all([
      consumeAdminMagicLink(db, cache, token),
      consumeAdminMagicLink(db, cache, token),
    ]);
    expect(results.filter((value) => value === 9)).toHaveLength(1);
    expect(results.filter((value) => value === null)).toHaveLength(1);
  });

  it.skipIf(!sqliteD1Available)("rejects unknown and malformed tokens without touching D1", async () => {
    const db = createSqliteD1(SCHEMA);
    const { cache } = createMemoryCache();
    const insert = vi.spyOn(db, "prepare");
    expect(await consumeAdminMagicLink(db, cache, "never-issued-token-1234")).toBeNull();
    expect(await consumeAdminMagicLink(db, cache, "x")).toBeNull();
    expect(insert).not.toHaveBeenCalled();
  });

  it("keeps the link valid for half an hour", () => {
    expect(ADMIN_MAGIC_LINK_TTL_SECONDS).toBe(30 * 60);
  });
});
