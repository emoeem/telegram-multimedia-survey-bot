import { describe, expect, it } from "vitest";

import {
  createPlazaPost,
  detachPlazaPostImage,
  getPlazaPostImageAssetId,
  isPublishedPlazaImage,
  listPlazaPosts,
  listPlazaTopics,
  setPlazaPostStatus,
  softDeletePlazaPost,
  restorePlazaPost,
} from "../../../src/db/repositories/plaza-post.repository";
import { createSqliteD1, sqliteD1Available } from "../../helpers/sqlite-d1";

/**
 * 树洞图片帖 / #话题#（迁移 0068）的仓库层验证。
 *
 * 公开流的两条新查询（按话题筛选、话题榜）都跑真实 SQL：类型检查和 mock
 * 都看不出 GROUP BY / 绑定参数顺序的错。
 */
const SCHEMA = `
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  telegram_user_id INTEGER,
  username TEXT,
  first_name TEXT
);
CREATE TABLE plaza_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  anonymous INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'published',
  created_at TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'text',
  payload_json TEXT,
  image_asset_id INTEGER,
  topic TEXT,
  deleted_at TEXT
);
CREATE TABLE plaza_post_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'published',
  created_at TEXT NOT NULL,
  anonymous INTEGER NOT NULL DEFAULT 1
);
INSERT INTO users (id, telegram_user_id, username, first_name) VALUES (7, 700, 'asha', '阿沙');
`;

describe.skipIf(!sqliteD1Available)("plaza post repository (real SQLite)", () => {
  it("round-trips image and topic through create and list", async () => {
    const db = createSqliteD1(SCHEMA);
    await createPlazaPost(db, { userId: 7, content: "带图的心里话", anonymous: true, imageAssetId: 42, topic: "夜话" });
    await createPlazaPost(db, { userId: 7, content: "只有文字", anonymous: false });

    const { items } = await listPlazaPosts(db, { limit: 10, offset: 0, view: "published" });
    expect(items).toHaveLength(2);
    const withImage = items.find((item) => item.imageAssetId !== null);
    expect(withImage).toMatchObject({ imageAssetId: 42, topic: "夜话", content: "带图的心里话" });
    const plain = items.find((item) => item.imageAssetId === null);
    expect(plain).toMatchObject({ topic: null, anonymous: false });
  });

  it("filters the public feed by topic and counts the topic board", async () => {
    const db = createSqliteD1(SCHEMA);
    await createPlazaPost(db, { userId: 7, content: "第一条", anonymous: true, topic: "夜话" });
    await createPlazaPost(db, { userId: 7, content: "第二条", anonymous: true, topic: "夜话" });
    await createPlazaPost(db, { userId: 7, content: "第三条", anonymous: true, topic: "树洞" });
    await createPlazaPost(db, { userId: 7, content: "没有话题", anonymous: true });

    const filtered = await listPlazaPosts(db, { limit: 10, offset: 0, view: "published", topic: "夜话" });
    expect(filtered.total).toBe(2);
    expect(filtered.items.every((item) => item.topic === "夜话")).toBe(true);

    const topics = await listPlazaTopics(db);
    expect(topics).toEqual([
      { topic: "夜话", count: 2 },
      { topic: "树洞", count: 1 },
    ]);

    // 下架的内容不出现在话题榜，也不出现在筛选流里。
    const firstPostId = filtered.items[0]?.id;
    expect(firstPostId).toBeDefined();
    await setPlazaPostStatus(db, firstPostId as number, "removed");
    expect((await listPlazaTopics(db)).find((entry) => entry.topic === "夜话")?.count).toBe(1);
    expect((await listPlazaPosts(db, { limit: 10, offset: 0, view: "published", topic: "夜话" })).total).toBe(1);
  });

  it("soft-deletes a post from every public view and restores it", async () => {
    const db = createSqliteD1(SCHEMA);
    const post = await createPlazaPost(db, { userId: 7, content: "可恢复树洞", anonymous: true, topic: "回收站" });
    expect(await softDeletePlazaPost(db, post.id, "2026-10-01T00:00:00.000Z")).toBe(true);
    expect((await listPlazaPosts(db, { limit: 10, offset: 0, view: "published" })).total).toBe(0);
    expect((await listPlazaTopics(db)).find((item) => item.topic === "回收站")).toBeUndefined();
    expect(await restorePlazaPost(db, post.id)).toBe(true);
    expect((await listPlazaPosts(db, { limit: 10, offset: 0, view: "published" })).total).toBe(1);
  });

  it("only serves an image while one of its posts is published", async () => {
    const db = createSqliteD1(SCHEMA);
    const post = await createPlazaPost(db, { userId: 7, content: "图片帖", anonymous: true, imageAssetId: 99 });
    expect(await isPublishedPlazaImage(db, 99)).toBe(true);
    expect(await isPublishedPlazaImage(db, 100)).toBe(false);

    await setPlazaPostStatus(db, post.id, "removed");
    expect(await isPublishedPlazaImage(db, 99)).toBe(false);

    // 管理端下架时会摘掉引用并删除字节，这里验证摘引用这一半。
    await detachPlazaPostImage(db, post.id);
    expect(await getPlazaPostImageAssetId(db, post.id)).toBeNull();
  });
});
