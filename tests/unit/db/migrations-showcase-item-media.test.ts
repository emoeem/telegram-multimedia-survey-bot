import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import { sqliteD1Available } from "../../helpers/sqlite-d1";

/**
 * 迁移 0070（展示区作品的内容文件）同样要按 D1 的语义验证：整个文件一次原子
 * 批处理、外键开启。它只做 ADD COLUMN + CREATE INDEX —— 0068 那次教训之后，
 * 父表重建在这条链路上是禁止动作，这个测试就是防线。
 */
const MIGRATION_0070 = readFileSync(
  new URL("../../../db/migrations/0070_showcase_item_media.sql", import.meta.url),
  "utf8",
);

const BEFORE_0070 = `
CREATE TABLE showcase_persons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE showcase_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL REFERENCES showcase_persons(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  kind TEXT NOT NULL DEFAULT 'other',
  cover_media_id INTEGER,
  cover_url TEXT,
  url TEXT,
  featured INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
INSERT INTO showcase_persons (id, name, created_at, updated_at) VALUES (900, '测试作者', 'x', 'x');
INSERT INTO showcase_items (id, person_id, title, created_at) VALUES (1, 900, '旧作品', 'x');
`;

const require = createRequire(import.meta.url);
function loadSqlite() {
  return sqliteD1Available ? (require("node:sqlite") as typeof import("node:sqlite")) : null;
}

describe.skipIf(!sqliteD1Available)("migration 0070 (showcase item media)", () => {
  it("adds media_asset_id as a plain column and keeps the table's foreign key", () => {
    const sqlite = loadSqlite();
    if (!sqlite) throw new Error("node:sqlite unavailable");
    const db = new sqlite.DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(BEFORE_0070);

    db.exec("BEGIN");
    db.exec(MIGRATION_0070);
    db.exec("COMMIT");

    // 旧行保留，新列默认 NULL。
    expect(db.prepare("SELECT id, title, media_asset_id mediaAssetId FROM showcase_items WHERE id = 1").get()).toEqual({
      id: 1,
      title: "旧作品",
      mediaAssetId: null,
    });
    db.prepare("UPDATE showcase_items SET media_asset_id = 903 WHERE id = 1").run();
    expect((db.prepare("SELECT media_asset_id mediaAssetId FROM showcase_items WHERE id = 1").get() as { mediaAssetId: number }).mediaAssetId).toBe(903);

    // 表没有被重建：到 showcase_persons 的外键与级联仍然生效。
    expect(() =>
      db.prepare("INSERT INTO showcase_items (person_id, title, created_at) VALUES (12345, '孤儿', 'x')").run(),
    ).toThrow(/FOREIGN KEY constraint failed/i);
    db.prepare("DELETE FROM showcase_persons WHERE id = 900").run();
    expect((db.prepare("SELECT COUNT(*) AS count FROM showcase_items").get() as { count: number }).count).toBe(0);

    const indexes = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'showcase_items'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    expect(indexes).toContain("idx_showcase_items_media_asset");
    db.close();
  });
});
