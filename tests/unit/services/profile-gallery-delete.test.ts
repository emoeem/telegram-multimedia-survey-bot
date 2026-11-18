import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { createSqliteD1, sqliteD1Available } from "../../helpers/sqlite-d1";
import {
  deleteProfileGalleryMedia,
  type ProfileGalleryEnvironment,
} from "../../../src/services/profile-gallery.service";

/**
 * deleteProfileGalleryMedia 批量化回归（B8 · 已知待办 4）。
 *
 * 逐行版每行 3 次往返（store.delete + expireMediaAsset + DELETE 映射行），
 * 行数 = 单答卷媒体数。批量化后必须与逐行版结果逐字段一致：每个映射行被
 * 删、其 media_assets 行置 storage_key = NULL + expires_at/updated_at、指向
 * 同一答卷的全部存储对象被删（best-effort）。用同一份数据跑两条路径
 * （批量化服务 vs 测试内联的旧逐行实现）做状态对比。
 */

const MIGRATION_0040 = readFileSync(
  new URL("../../../db/migrations/0040_profile_gallery.sql", import.meta.url),
  "utf8",
);

// media_assets 的最小列（0091 起同形：storage_kind/storage_key/expires_at）。
// survey_responses 只给主键：gallery_published 两列由 0040 的 ALTER 补上；
// survey_questions 只承接 gallery_profile_media 的外键引用。
const MEDIA_DDL = `
CREATE TABLE survey_responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT
);
CREATE TABLE survey_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT
);
CREATE TABLE IF NOT EXISTS media_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_scope TEXT NOT NULL DEFAULT 'response',
  media_type TEXT NOT NULL DEFAULT 'photo',
  storage_kind TEXT NOT NULL DEFAULT 'temporary',
  storage_key TEXT,
  mime_type TEXT,
  file_size INTEGER,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT ''
);
`;

/** 记录删除调用的假 KV（KVMediaStore.delete → kv.delete）。 */
function makeFakeKv() {
  const deleted: string[] = [];
  const kv = {
    delete: vi.fn(async (key: string) => {
      deleted.push(key);
    }),
  };
  return { kv: kv as unknown as KVNamespace, deleted };
}

/** 测试库 schema：最小 survey_responses 先行（0040 会 ALTER 它），再套真迁移。
 * node:sqlite 默认开外键；这里显式关掉，才能种出「映射行指向已缺失资产行」
 * 的历史脏数据（LEFT JOIN 置空口径），与生产可容忍的数据形态对齐。 */
const TEST_SCHEMA = `PRAGMA foreign_keys = OFF;\n${MEDIA_DDL}\n${MIGRATION_0040}`;

describe.skipIf(!sqliteD1Available)("deleteProfileGalleryMedia · 批量化回归（B8）", () => {
  interface MediaRow {
    id: number;
    storage_key: string | null;
    expires_at: string | null;
    updated_at: string | null;
  }

  async function seedResponse(db: D1Database, responseId: number): Promise<void> {
    // 三个映射行：两个带存储对象的资产 + 一个资产行已缺失（LEFT JOIN 置空，
    // expireMediaAsset 对不存在行 UPDATE 0 行——旧实现容忍，新实现同口径）。
    for (const key of [`media:gallery:${responseId}:1`, `media:gallery:${responseId}:2`]) {
      await db
        .prepare(
          `INSERT INTO media_assets (storage_kind, storage_key, expires_at, created_at, updated_at)
           VALUES ('gallery', ?, NULL, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`,
        )
        .bind(key)
        .run();
    }
    const assetRows = await db.prepare(`SELECT id FROM media_assets ORDER BY id DESC LIMIT 2`).all<{ id: number }>();
    const newest = assetRows.results ?? [];
    await db.batch([
      db
        .prepare(
          `INSERT INTO gallery_profile_media (response_id, media_asset_id, question_id, sort_order, created_at)
           VALUES (?, ?, 1, 0, '2026-11-01T00:00:00.000Z')`,
        )
        .bind(responseId, newest[0]?.id ?? 0),
      db
        .prepare(
          `INSERT INTO gallery_profile_media (response_id, media_asset_id, question_id, sort_order, created_at)
           VALUES (?, ?, 2, 1, '2026-11-01T00:00:00.000Z')`,
        )
        .bind(responseId, newest[1]?.id ?? 0),
      // 资产行缺失的映射行（FK 关闭时才可造，测 LEFT JOIN 空值口径）。
      db
        .prepare(
          `INSERT INTO gallery_profile_media (response_id, media_asset_id, question_id, sort_order, created_at)
           VALUES (?, 9999, 3, 2, '2026-11-01T00:00:00.000Z')`,
        )
        .bind(responseId),
    ]);
  }

  async function snapshot(db: D1Database, responseId: number): Promise<{ assets: MediaRow[]; mappings: number[] }> {
    const assets = await db
      .prepare(
        `SELECT a.id, a.storage_key, a.expires_at, a.updated_at
           FROM media_assets a
          WHERE a.id IN (SELECT media_asset_id FROM gallery_profile_media WHERE response_id = ?)
             OR a.storage_key LIKE 'media:gallery:%'
          ORDER BY a.id`,
      )
      .bind(responseId)
      .all<MediaRow>();
    const mappings = await db
      .prepare(`SELECT id FROM gallery_profile_media WHERE response_id = ? ORDER BY id`)
      .bind(responseId)
      .all<{ id: number }>();
    return {
      assets: assets.results ?? [],
      mappings: (mappings.results ?? []).map((row) => row.id),
    };
  }

  /** 旧逐行实现（与改写前的 service 代码逐字对齐），用于状态对比。 */
  async function legacyDelete(
    db: D1Database,
    kv: { delete: (key: string) => Promise<void> },
    responseId: number,
  ): Promise<void> {
    const rows = await db
      .prepare(
        `SELECT gpm.id mappingId, gpm.media_asset_id mediaAssetId, m.storage_key storageKey
         FROM gallery_profile_media gpm
         LEFT JOIN media_assets m ON m.id = gpm.media_asset_id
         WHERE gpm.response_id = ?`,
      )
      .bind(responseId)
      .all<{ mappingId: number; mediaAssetId: number; storageKey: string | null }>();
    for (const row of rows.results ?? []) {
      if (row.storageKey) await kv.delete(row.storageKey).catch(() => undefined);
      await db
        .prepare(`UPDATE media_assets SET storage_key = NULL, expires_at = ?, updated_at = ? WHERE id = ?`)
        .bind(new Date().toISOString(), new Date().toISOString(), row.mediaAssetId)
        .run();
      await db.prepare("DELETE FROM gallery_profile_media WHERE id = ?").bind(row.mappingId).run();
    }
  }

  it("批量删除与逐行版结果一致（资产过期 + 映射行删除 + 存储对象删除）", async () => {
    // FK 关闭：允许「映射行指向已缺失资产行」的历史脏数据（LEFT JOIN 口径）。
    const dbA = createSqliteD1(TEST_SCHEMA);
    const dbB = createSqliteD1(TEST_SCHEMA);
    const kvA = makeFakeKv();
    const kvB = makeFakeKv();
    await seedResponse(dbA, 11);
    await seedResponse(dbB, 11);

    const beforeA = await snapshot(dbA, 11);
    const beforeB = await snapshot(dbB, 11);
    // 两库同种子数据：资产行数一致、每个映射行都有对应的存储键可被删。
    expect(beforeA.mappings).toHaveLength(3);
    expect(beforeB.mappings).toEqual(beforeA.mappings);
    expect(beforeA.assets.filter((row) => row.storage_key)).toHaveLength(2);

    await deleteProfileGalleryMedia({ DB: dbA, MEDIA_KV: kvA.kv }, 11);
    await legacyDelete(
      dbB,
      {
        delete: (key) => kvB.kv.delete(key),
      },
      11,
    );

    const afterA = await snapshot(dbA, 11);
    const afterB = await snapshot(dbB, 11);
    // 映射行：全部删除（含资产缺失的那一行）。
    expect(afterA.mappings).toEqual([]);
    // 资产行：结果状态一致（storage_key 置 NULL）；expires_at/updated_at 是
    // 执行时刻（两路径各自 now），只比对「非空且被刷新」的口径。
    expect(afterA.assets.map((row) => row.id)).toEqual(afterB.assets.map((row) => row.id));
    for (const row of afterA.assets) {
      expect(row.storage_key).toBeNull();
      expect(row.expires_at).not.toBeNull();
      expect(row.updated_at).not.toBeNull();
    }
    // 存储对象：两个带键的资产都被删，与逐行版同一集合。
    expect(kvA.deleted).toEqual(kvB.deleted);
    expect(kvA.deleted).toHaveLength(2);
  });

  it("无映射行时零写入零删除（幂等，可安全重复调用）", async () => {
    const db = createSqliteD1(TEST_SCHEMA);
    const kv = makeFakeKv();
    await deleteProfileGalleryMedia({ DB: db, MEDIA_KV: kv.kv }, 42);
    expect(kv.deleted).toEqual([]);
    const rows = await db.prepare(`SELECT COUNT(*) AS n FROM gallery_profile_media`).first<{ n: number }>();
    expect(Number(rows?.n ?? 0)).toBe(0);
    // 重复调用（删除后再删一次）不抛错、无副作用。
    await deleteProfileGalleryMedia({ DB: db, MEDIA_KV: kv.kv }, 42);
    expect(kv.deleted).toEqual([]);
  });
});
