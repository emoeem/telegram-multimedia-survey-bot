import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import { sqliteD1Available } from "../../helpers/sqlite-d1";

/**
 * 迁移 0071（热路径索引）：survey_responses 长期没有 user_id 索引，机器人
 * 「我的答卷」、封禁取消答卷和管理端用户目录都在对增长最快的表做全表扫描；
 * 成就评估的每次提交也会按 user_id 数 plaza_posts。这个测试保证索引真的建
 * 出来，并且查询计划确实走它们。
 */
const MIGRATION_0071 = readFileSync(
  new URL("../../../db/migrations/0071_hot_path_indexes.sql", import.meta.url),
  "utf8",
);

const BEFORE_0071 = `
CREATE TABLE survey_responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  participant_hash TEXT NOT NULL,
  status TEXT NOT NULL
);
CREATE TABLE plaza_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'published'
);
CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

const require = createRequire(import.meta.url);
function loadSqlite() {
  return sqliteD1Available ? (require("node:sqlite") as typeof import("node:sqlite")) : null;
}

describe.skipIf(!sqliteD1Available)("migration 0071 (hot-path indexes)", () => {
  it("creates the user/status, plaza and audit indexes and serves the hot queries", () => {
    const sqlite = loadSqlite();
    if (!sqlite) throw new Error("node:sqlite unavailable");
    const db = new sqlite.DatabaseSync(":memory:");
    db.exec(BEFORE_0071);

    db.exec("BEGIN");
    db.exec(MIGRATION_0071);
    db.exec("COMMIT");

    const indexes = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name",
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(indexes).toContain("idx_survey_responses_user_status");
    expect(indexes).toContain("idx_plaza_posts_user_status");
    expect(indexes).toContain("idx_audit_logs_action");

    // 查询计划必须走新索引，否则这次迁移没有解决它要解决的问题。
    const plan = (value: unknown): string => JSON.stringify(value);
    expect(
      plan(
        db
          .prepare("EXPLAIN QUERY PLAN SELECT id FROM survey_responses WHERE user_id = 7 AND status = 'in_progress'")
          .all(),
      ),
    ).toContain("idx_survey_responses_user_status");
    expect(
      plan(db.prepare("EXPLAIN QUERY PLAN SELECT COUNT(*) FROM plaza_posts WHERE user_id = 7 AND status = 'published'").all()),
    ).toContain("idx_plaza_posts_user_status");
    expect(
      plan(db.prepare("EXPLAIN QUERY PLAN SELECT id FROM audit_logs WHERE action = 'survey.publish'").all()),
    ).toContain("idx_audit_logs_action");
    db.close();
  });
});
