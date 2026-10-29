import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import { sqliteD1Available } from "../../helpers/sqlite-d1";

/**
 * 迁移 0092：公开发布的两项「答卷者选择」。
 *
 * 为什么单独测：发布是异步的（提交 → export job → 渲染 → Telegram），发布那一刻
 * 已经问不了答卷者，三项选择只能从答卷行读回来。列没建出来 / 默认值错，
 * 后果是"匿名没生效"——一个 `@username` 永久留在公开频道里。
 */
const MIGRATION_0092 = readFileSync(
  new URL("../../../db/migrations/0092_publish_choice_details.sql", import.meta.url),
  "utf8",
);

const BEFORE_0092 = `
CREATE TABLE survey_responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  survey_id INTEGER NOT NULL,
  participant_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  report_publication_requested INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- 迁移之前就存在的答卷：新列的默认值会落到它们身上。
INSERT INTO survey_responses (id, survey_id, participant_hash, status, created_at, updated_at)
VALUES (7, 1, 'user_1', 'completed', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
`;

const require = createRequire(import.meta.url);

describe.skipIf(!sqliteD1Available)("migration 0092 (publish choice details)", () => {
  it("新增两列，老答卷默认匿名且没有留言", () => {
    const sqlite = require("node:sqlite") as typeof import("node:sqlite");
    const db = new sqlite.DatabaseSync(":memory:");
    db.exec(BEFORE_0092);
    db.exec(MIGRATION_0092);

    const columns = (
      db.prepare("PRAGMA table_info(survey_responses)").all() as Array<{ name: string; notnull: number }>
    ).map((row) => row.name);
    expect(columns).toContain("publish_anonymous");
    expect(columns).toContain("publish_message");

    // 泄漏不可逆：老答卷（当时没有这项选择）必须按匿名读回。
    const legacy = db.prepare("SELECT publish_anonymous, publish_message FROM survey_responses WHERE id = 7").get() as {
      publish_anonymous: number;
      publish_message: string | null;
    };
    expect(legacy.publish_anonymous).toBe(1);
    expect(legacy.publish_message).toBeNull();

    // 新答卷可以明确写"不匿名 + 一句留言"。
    db.prepare(
      "INSERT INTO survey_responses (id, survey_id, participant_hash, status, publish_anonymous, publish_message, created_at, updated_at) VALUES (8, 1, 'user_2', 'completed', 0, '想说的话', 't', 't')",
    ).run();
    const explicit = db
      .prepare("SELECT publish_anonymous, publish_message FROM survey_responses WHERE id = 8")
      .get() as { publish_anonymous: number; publish_message: string | null };
    expect(explicit.publish_anonymous).toBe(0);
    expect(explicit.publish_message).toBe("想说的话");
    db.close();
  });

  it("迁移可重复执行到新库上（migrations 按文件名顺序拼接）", () => {
    // fullMigrationSchema() 会把所有迁移拼起来；这里确认 0092 与既有 SELECT *
    // 的读法兼容——加列不影响任何现有查询（D1 的 ALTER ADD COLUMN 语义）。
    const sqlite = require("node:sqlite") as typeof import("node:sqlite");
    const db = new sqlite.DatabaseSync(":memory:");
    db.exec(BEFORE_0092);
    db.exec(MIGRATION_0092);
    const row = db.prepare("SELECT * FROM survey_responses WHERE id = 7").get() as Record<string, unknown>;
    expect(row["publish_anonymous"]).toBe(1);
    expect("publish_message" in row).toBe(true);
    db.close();
  });
});
