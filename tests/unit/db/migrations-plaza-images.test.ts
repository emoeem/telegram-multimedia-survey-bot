import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import { sqliteD1Available } from "../../helpers/sqlite-d1";

/**
 * 迁移 0068 的真实验证 —— 用 D1 的语义跑：整个文件作为**一次原子批处理**，
 * 而且外键是开着的（D1 默认 FK ON，事务内 \`PRAGMA foreign_keys=OFF\` 是 no-op）。
 *
 * 第一版 0068 想重建 media_assets 来放宽 asset_scope 的 CHECK，在生产 D1 上直接
 * 报 FOREIGN KEY constraint failed: SQLITE_CONSTRAINT_TRIGGER [code: 7500]。
 * 这个测试同时锁住两件事：现在的迁移能安全落地，以及「重建父表」那条路是真的
 * 会炸（谁再想这么改，先看这里）。
 */
const MIGRATION_068 = readFileSync(
  new URL("../../../db/migrations/0068_plaza_post_images_and_topics.sql", import.meta.url),
  "utf8",
);

// 0068 之前的形态：media_assets（0018 的 CHECK + 0026/0027 追加的列）、一张
// 带 ON DELETE CASCADE 的子表、以及老版 plaza_posts。
const BEFORE_0068 = `
CREATE TABLE media_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_scope TEXT NOT NULL DEFAULT 'legacy'
    CHECK (asset_scope IN ('survey', 'response', 'template', 'generated_result', 'template_preview', 'identity_card', 'legacy')),
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
ALTER TABLE media_assets ADD COLUMN url TEXT;
ALTER TABLE media_assets ADD COLUMN storage_kind TEXT NOT NULL DEFAULT 'telegram';
ALTER TABLE media_assets ADD COLUMN storage_key TEXT;
ALTER TABLE media_assets ADD COLUMN expires_at TEXT;
CREATE INDEX idx_media_assets_type ON media_assets(media_type);
CREATE INDEX idx_media_assets_scope ON media_assets(asset_scope, id);
CREATE INDEX idx_media_assets_temp_expiry ON media_assets(storage_kind, expires_at);

CREATE TABLE question_media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL,
  media_asset_id INTEGER NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE
);

-- 真实 schema 里有一张 ON DELETE RESTRICT 的子表（visual_template_assets）。
-- 它才是生产上 DROP TABLE media_assets 直接报 7500 的原因：RESTRICT 会拒绝删除，
-- 而不是像 CASCADE 那样安静地把子表数据带走。
CREATE TABLE visual_template_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER NOT NULL REFERENCES media_assets(id) ON DELETE RESTRICT
);

CREATE TABLE plaza_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  anonymous INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'published',
  created_at TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'text',
  payload_json TEXT
);

INSERT INTO media_assets (id, asset_scope, media_type, storage_kind, storage_key, expires_at, url, created_at, updated_at)
  VALUES (5, 'survey', 'photo', 'temporary', 'media:survey:keep-me', NULL, 'https://cdn.example/x.png', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
INSERT INTO question_media (question_id, media_asset_id) VALUES (1, 5);
INSERT INTO visual_template_assets (asset_id) VALUES (5);
INSERT INTO plaza_posts (id, user_id, content, created_at) VALUES (1, 7, '旧帖子', '2026-01-01T00:00:00.000Z');
`;

const require = createRequire(import.meta.url);
function loadSqlite() {
  // 与 sqlite-d1 助手同样的门禁：老 Node 上跳过而不是失败。
  return sqliteD1Available ? (require("node:sqlite") as typeof import("node:sqlite")) : null;
}

describe.skipIf(!sqliteD1Available)("migration 0068 (plaza images and topics)", () => {
  it("adds the plaza columns in one FK-enforced batch without touching media_assets", () => {
    const sqlite = loadSqlite();
    if (!sqlite) throw new Error("node:sqlite unavailable");
    const db = new sqlite.DatabaseSync(":memory:");
    // D1 的连接默认开着外键，且迁移文件是一次批处理。
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(BEFORE_0068);

    db.exec("BEGIN");
    db.exec(MIGRATION_068);
    db.exec("COMMIT");

    // media_assets 原封不动：CHECK 没有被放宽 —— 树洞图因此复用 response scope。
    const mediaSql = String(
      (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'media_assets'").get() as { sql: string }).sql,
    );
    expect(mediaSql).not.toContain("plaza_post");
    const kept = db
      .prepare("SELECT asset_scope scope, storage_kind storageKind, storage_key storageKey, url, expires_at expiresAt FROM media_assets WHERE id = 5")
      .get() as Record<string, unknown>;
    expect(kept).toMatchObject({
      scope: "survey",
      storageKind: "temporary",
      storageKey: "media:survey:keep-me",
      url: "https://cdn.example/x.png",
      expiresAt: null,
    });
    // 子表数据既没被 DROP 的级联吃掉，RESTRICT 引用也还在（重建父表的真实风险）。
    expect((db.prepare("SELECT COUNT(*) AS count FROM question_media").get() as { count: number }).count).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS count FROM visual_template_assets").get() as { count: number }).count).toBe(1);

    // 新列对旧行是 NULL，可写。
    expect(db.prepare("SELECT image_asset_id imageAssetId, topic FROM plaza_posts WHERE id = 1").get()).toEqual({
      imageAssetId: null,
      topic: null,
    });
    db.prepare("UPDATE plaza_posts SET image_asset_id = 5, topic = '夜话' WHERE id = 1").run();
    expect(db.prepare("SELECT image_asset_id imageAssetId, topic FROM plaza_posts WHERE id = 1").get()).toEqual({
      imageAssetId: 5,
      topic: "夜话",
    });

    const indexes = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'plaza_posts'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    expect(indexes).toEqual(expect.arrayContaining(["idx_plaza_posts_topic", "idx_plaza_posts_image_asset"]));
    db.close();
  });

  it("would fail if the migration rebuilt media_assets to widen the scope CHECK", () => {
    const sqlite = loadSqlite();
    if (!sqlite) throw new Error("node:sqlite unavailable");
    const db = new sqlite.DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(BEFORE_0068);

    // 模拟第一版 0068 的写法：建新表 → 拷贝 → DROP → RENAME。
    // DROP TABLE 在外键开启时会先做一次隐式 DELETE，触发子表的 ON DELETE 动作，
    // 于是在 D1 上报 7500。
    db.exec("CREATE TABLE media_assets_scope_v2 (id INTEGER PRIMARY KEY, asset_scope TEXT, media_type TEXT)");
    expect(() => db.exec("DROP TABLE media_assets")).toThrow(/FOREIGN KEY constraint failed/i);
    // 没有 RESTRICT 引用时它会「成功」并静默清空 CASCADE 子表的行 —— 就算不明着报错，
    // 也是数据丢失，所以这条链路整体不可用。
    db.exec("DELETE FROM visual_template_assets");
    db.exec("DROP TABLE media_assets");
    expect((db.prepare("SELECT COUNT(*) AS count FROM question_media").get() as { count: number }).count).toBe(0);
    db.close();
  });
});
