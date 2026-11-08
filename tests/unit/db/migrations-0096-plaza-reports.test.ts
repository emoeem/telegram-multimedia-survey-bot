import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import { sqliteD1Available } from "../../helpers/sqlite-d1";
import { fullMigrationSchema } from "../../helpers/full-schema";

/**
 * 迁移 0096 的真实验证 —— 用 D1 的语义跑：整个文件作为**一次原子批处理**，
 * 外键开着（D1 默认 FK ON）。
 *
 * 0096 给树洞补用户侧举报链路。与 0094 纸条举报同构，但去重键**必须是
 * users.id**：广场写路径全部要求 dbUserId，而同一登录用户经 TG initData /
 * 邮箱会话 / 匿名 key 解析出的 participant_hash 各不相同——照抄 0094 的
 * reporter_hash 去重会被同人多身份绕过，report_count 虚高误触发自动隐藏。
 * 这里的 UNIQUE(post_id, reporter_user_id) 用例就是那条防回归锚点（复审 P1-2）。
 */
const MIGRATION_0096 = readFileSync(new URL("../../../db/migrations/0096_plaza_reports.sql", import.meta.url), "utf8");

// 0095 为止的真实形态（列按 0037/0046/0066/0068/0074/0080 的追加顺序拼齐；
// 与本迁移相关的列一个不省，无关列省略不影响结论）。
const BEFORE_0096 = `
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id INTEGER NOT NULL UNIQUE,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  language_code TEXT,
  system_role TEXT NOT NULL DEFAULT 'participant',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
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
  deleted_at TEXT,
  content_rating TEXT NOT NULL DEFAULT 'all'
);
CREATE INDEX idx_plaza_posts_feed ON plaza_posts(status, id DESC);

CREATE TABLE plaza_post_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL REFERENCES plaza_posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'published',
  created_at TEXT NOT NULL,
  anonymous INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_plaza_post_comments_post ON plaza_post_comments(post_id, status, id DESC);

INSERT INTO users (id, telegram_user_id, created_at, updated_at)
  VALUES (1, 111, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
         (2, 222, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
INSERT INTO plaza_posts (id, user_id, content, created_at)
  VALUES (10, 1, '旧帖子', '2026-01-01T00:00:00.000Z');
INSERT INTO plaza_post_comments (id, post_id, user_id, content, created_at)
  VALUES (20, 10, 2, '旧评论', '2026-01-01T00:00:00.000Z');
`;

// 迁移头部声明的回滚块（逐字）：两表反序 DROP + 两列反序 DROP。
const ROLLBACK_0096 = `
DROP TABLE IF EXISTS plaza_comment_reports;
DROP TABLE IF EXISTS plaza_post_reports;
ALTER TABLE plaza_posts DROP COLUMN report_count;
ALTER TABLE plaza_post_comments DROP COLUMN report_count;
`;

const require = createRequire(import.meta.url);
function loadSqlite() {
  // 与 sqlite-d1 助手同样的门禁：老 Node 上跳过而不是失败。
  return sqliteD1Available ? (require("node:sqlite") as typeof import("node:sqlite")) : null;
}

describe.skipIf(!sqliteD1Available)("migration 0096 (plaza reports)", () => {
  it("在 0095 之上增量应用：两列默认 0，两张举报表就位，旧行可读可写", () => {
    const sqlite = loadSqlite();
    if (!sqlite) throw new Error("node:sqlite unavailable");
    const db = new sqlite.DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(BEFORE_0096);

    db.exec("BEGIN");
    db.exec(MIGRATION_0096);
    db.exec("COMMIT");

    // 旧行的新列落默认值：report_count = 0（NOT NULL）。
    expect(db.prepare("SELECT report_count FROM plaza_posts WHERE id = 10").get()).toEqual({ report_count: 0 });
    expect(db.prepare("SELECT report_count FROM plaza_post_comments WHERE id = 20").get()).toEqual({
      report_count: 0,
    });

    // 举报明细可写（FK 都能对上）。
    db.prepare(
      "INSERT INTO plaza_post_reports (post_id, reporter_user_id, reason, created_at) VALUES (10, 2, '垃圾内容', 't')",
    ).run();
    db.prepare(
      "INSERT INTO plaza_comment_reports (comment_id, reporter_user_id, reason, created_at) VALUES (20, 1, '人身攻击', 't')",
    ).run();
    expect((db.prepare("SELECT COUNT(*) AS n FROM plaza_post_reports").get() as { n: number }).n).toBe(1);
    db.close();
  });

  it("UNIQUE(目标, reporter_user_id) 去重生效——同登录用户重复举报被拒（复审 P1-2 锚点）", () => {
    const sqlite = loadSqlite();
    if (!sqlite) throw new Error("node:sqlite unavailable");
    const db = new sqlite.DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(BEFORE_0096);
    db.exec(MIGRATION_0096);

    db.prepare(
      "INSERT INTO plaza_post_reports (post_id, reporter_user_id, reason, created_at) VALUES (10, 2, '第一次', 't')",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO plaza_post_reports (post_id, reporter_user_id, reason, created_at) VALUES (10, 2, '第二次', 't')",
        )
        .run(),
    ).toThrow(/UNIQUE constraint failed/i);

    db.prepare(
      "INSERT INTO plaza_comment_reports (comment_id, reporter_user_id, reason, created_at) VALUES (20, 1, '第一次', 't')",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO plaza_comment_reports (comment_id, reporter_user_id, reason, created_at) VALUES (20, 1, '第二次', 't')",
        )
        .run(),
    ).toThrow(/UNIQUE constraint failed/i);

    // 举报者必须是真实登录用户：FK 指向 users(id)，挂不上匿名/伪造 id。
    expect(() =>
      db
        .prepare(
          "INSERT INTO plaza_post_reports (post_id, reporter_user_id, reason, created_at) VALUES (10, 999, '不存在的用户', 't')",
        )
        .run(),
    ).toThrow(/FOREIGN KEY constraint failed/i);
    db.close();
  });

  it("头部回滚块逐字可执行：反序 DROP 两表 + DROP 两列不报错，业务数据无损", () => {
    const sqlite = loadSqlite();
    if (!sqlite) throw new Error("node:sqlite unavailable");
    const db = new sqlite.DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(BEFORE_0096);
    db.exec(MIGRATION_0096);
    db.prepare(
      "INSERT INTO plaza_post_reports (post_id, reporter_user_id, reason, created_at) VALUES (10, 2, '垃圾内容', 't')",
    ).run();

    // 硬约束的运行时证明：report_count 未被索引/触发器/视图引用时，
    // ALTER TABLE ... DROP COLUMN 才合法——回滚块能原样跑通即约束未破。
    db.exec(ROLLBACK_0096);

    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'plaza_%reports'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    expect(tables).toEqual([]);
    expect(
      (db.prepare("PRAGMA table_info(plaza_posts)").all() as Array<{ name: string }>).map((row) => row.name),
    ).not.toContain("report_count");
    expect(
      (db.prepare("PRAGMA table_info(plaza_post_comments)").all() as Array<{ name: string }>).map((row) => row.name),
    ).not.toContain("report_count");
    // 帖子/评论本体无损。
    expect((db.prepare("SELECT content FROM plaza_posts WHERE id = 10").get() as { content: string }).content).toBe(
      "旧帖子",
    );
    db.close();
  });

  it("全链迁移拼接（0000→0096）在空库上一次跑通", () => {
    const sqlite = loadSqlite();
    if (!sqlite) throw new Error("node:sqlite unavailable");
    const db = new sqlite.DatabaseSync(":memory:");
    // fullMigrationSchema 按文件名顺序拼接全部迁移：0096 的 ALTER 不得与
    // 任何先前迁移冲突（重复列名/引用缺失都会在这里炸）。
    db.exec(fullMigrationSchema());
    expect(
      (db.prepare("PRAGMA table_info(plaza_posts)").all() as Array<{ name: string }>).map((row) => row.name),
    ).toContain("report_count");
    expect(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    ).toEqual(expect.arrayContaining(["plaza_post_reports", "plaza_comment_reports"]));
    db.close();
  });
});
