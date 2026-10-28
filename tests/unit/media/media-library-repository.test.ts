import { describe, expect, it, vi } from "vitest";

import {
  findMediaAssetByContentHash,
  findMediaAssetByTelegramUniqueId,
  upsertMediaRef,
} from "../../../src/db/repositories/media.repository";

/** SQL 捕获 + 固定返回值的最小 D1 mock。 */
function mockDb(rowsFor: (sql: string) => unknown = () => null) {
  const calls: Array<{ sql: string; binds: unknown[] }> = [];
  const db = {
    prepare: (sql: string) => {
      const record = { sql, binds: [] as unknown[] };
      calls.push(record);
      const statement = {
        bind: (...binds: unknown[]) => {
          record.binds = binds;
          return statement;
        },
        first: async () => rowsFor(sql),
        all: async () => ({ results: [] }),
        run: async () => ({ success: true, meta: { changes: 1, last_row_id: 5 } }),
      };
      return statement;
    },
  } as unknown as D1Database;
  return { db, calls };
}

const assetRow = {
  id: 3,
  asset_scope: "survey",
  media_type: "photo",
  telegram_file_id: null,
  telegram_file_unique_id: "uniq",
  url: null,
  storage_kind: "temporary",
  storage_key: "media:blob:abc",
  expires_at: null,
  mime_type: "image/png",
  file_name: null,
  file_size: 3,
  width: null,
  height: null,
  duration: null,
  r2_key: null,
  content_hash: "abc",
  created_at: "",
  updated_at: "",
};

describe("0091 素材库仓储", () => {
  it("findMediaAssetByContentHash 按哈希查、优先 survey 范围，并映射 contentHash", async () => {
    const { db, calls } = mockDb(() => assetRow);
    const asset = await findMediaAssetByContentHash(db, "abc");
    expect(calls[0]?.sql).toContain("content_hash = ?");
    expect(calls[0]?.sql).toContain("asset_scope = 'survey'");
    expect(calls[0]?.binds).toEqual(["abc"]);
    expect(asset?.contentHash).toBe("abc");
    expect(asset?.id).toBe(3);
  });

  it("哈希未命中返回 null", async () => {
    const { db } = mockDb(() => null);
    await expect(findMediaAssetByContentHash(db, "none")).resolves.toBeNull();
  });

  it("Telegram 复用按 file_unique_id + 类型查", async () => {
    const { db, calls } = mockDb(() => assetRow);
    const asset = await findMediaAssetByTelegramUniqueId(db, "uniq", "photo");
    expect(calls[0]?.sql).toContain("telegram_file_unique_id = ? AND media_type = ?");
    expect(calls[0]?.binds).toEqual(["uniq", "photo"]);
    expect(asset?.telegramFileUniqueId).toBe("uniq");
  });

  it("upsertMediaRef 传 null 时删除登记行（引用解除）", async () => {
    const { db, calls } = mockDb();
    await upsertMediaRef(db, { refType: "survey_settings", refKey: "survey:1", assetId: null });
    expect(calls[0]?.sql).toContain("DELETE FROM media_refs");
  });

  it("upsertMediaRef 正常写入走 ON CONFLICT 重指向", async () => {
    const { db, calls } = mockDb();
    await upsertMediaRef(db, { refType: "survey_settings", refKey: "survey:1", assetId: 7 });
    expect(calls[0]?.sql).toContain("ON CONFLICT(ref_type, ref_key) DO UPDATE");
    expect(calls[0]?.binds.slice(0, 3)).toEqual([7, "survey_settings", "survey:1"]);
  });
});

describe("回填脚本 SQL", () => {
  it("生成的语句只动 survey_settings 登记、带 EXISTS 守卫且可重跑", async () => {
    // .mjs 脚本没有类型声明（也不该为了测试给它加一份）：直接读文本断言
    // 关键守卫，比导入后调用更贴近运维实际执行的那份 SQL。
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(join(process.cwd(), "scripts", "backfill-media-refs.mjs"), "utf8");
    expect(source).toContain("DELETE FROM media_refs WHERE ref_type = 'survey_settings'");
    expect(source).toContain("INSERT OR IGNORE INTO media_refs");
    expect(source).toContain("EXISTS (");
    expect(source).toContain("settings_json LIKE '%media/%'");
  });
});
