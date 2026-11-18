import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import { sqliteD1Available } from "../../helpers/sqlite-d1";

/**
 * 迁移 0099（B8 · 会话列表 UNION 改写配套索引）：listThreads 的跨表 OR
 * 「(t.drawer_hash=? OR n.owner_hash=?)」无法走索引（multi-index OR 只适用
 * 同表谓词，D1_EXPLAIN_AUDIT_2026-11-14.md Q10 实测 SCAN 全表），服务层已
 * 改写 UNION 两臂，本测试保证两臂各自需要的索引真的建出来、查询计划确实
 * 走它们——否则改写只是把全表扫描换了个形状。
 */
const MIGRATION_0099 = readFileSync(
  new URL("../../../db/migrations/0099_note_chat_thread_indexes.sql", import.meta.url),
  "utf8",
);

// 只含 0089 里与本查询相关的三张表（列与真实迁移一致，缩小测试面）。
const NOTE_TABLES = `
CREATE TABLE notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_hash TEXT NOT NULL,
  gender TEXT NOT NULL,
  age_band TEXT NOT NULL,
  region TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  image_asset_id INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  report_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_notes_owner_active ON notes(owner_hash) WHERE status = 'active';
CREATE INDEX idx_notes_pool ON notes(status, expires_at, id);
CREATE TABLE note_threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  drawer_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  last_message_at TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(note_id, drawer_hash)
);
CREATE INDEX idx_threads_drawer ON note_threads(drawer_hash, last_message_at);
CREATE TABLE note_thread_reads (
  thread_id INTEGER NOT NULL REFERENCES note_threads(id) ON DELETE CASCADE,
  participant_hash TEXT NOT NULL,
  last_read_message_id INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  UNIQUE(thread_id, participant_hash)
);
`;

const require = createRequire(import.meta.url);
function loadSqlite() {
  return sqliteD1Available ? (require("node:sqlite") as typeof import("node:sqlite")) : null;
}

// listThreads 的 UNION 两臂（与 note-chat.service.ts 内联 SQL 同形态）。
const LIST_THREADS_UNION = `
SELECT t.id AS id, t.note_id AS noteId, n.owner_hash AS ownerHash,
       COALESCE(t.last_message_at, t.created_at) AS sortAt
  FROM note_threads t
  JOIN notes n ON n.id = t.note_id
  LEFT JOIN note_thread_reads r ON r.thread_id = t.id AND r.participant_hash = 'hash_x'
 WHERE t.drawer_hash = 'hash_x' AND t.status = 'active'
UNION
SELECT t.id AS id, t.note_id AS noteId, n.owner_hash AS ownerHash,
       COALESCE(t.last_message_at, t.created_at) AS sortAt
  FROM notes n
  JOIN note_threads t ON t.note_id = n.id
  LEFT JOIN note_thread_reads r ON r.thread_id = t.id AND r.participant_hash = 'hash_x'
 WHERE n.owner_hash = 'hash_x' AND t.status = 'active'
 ORDER BY sortAt DESC
 LIMIT 100
`;

describe.skipIf(!sqliteD1Available)("migration 0099 (note-chat thread indexes)", () => {
  it("creates the drawer/status and notes owner indexes and serves the UNION rewrite", () => {
    const sqlite = loadSqlite();
    if (!sqlite) throw new Error("node:sqlite unavailable");
    const db = new sqlite.DatabaseSync(":memory:");
    db.exec(NOTE_TABLES);

    // 改写前：跨表 OR 的计划是 SCAN t（全表扫描）——先把病根钉在基线上。
    const legacyPlan = JSON.stringify(
      db
        .prepare(
          `EXPLAIN QUERY PLAN
      SELECT t.id FROM note_threads t JOIN notes n ON n.id = t.note_id
       WHERE (t.drawer_hash = 'hash_x' OR n.owner_hash = 'hash_x') AND t.status = 'active'`,
        )
        .all(),
    );
    expect(legacyPlan).toContain("SCAN t");
    expect(legacyPlan).not.toContain("SEARCH t");

    db.exec("BEGIN");
    db.exec(MIGRATION_0099);
    db.exec("COMMIT");

    const indexes = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name")
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(indexes).toContain("idx_threads_drawer_status");
    expect(indexes).toContain("idx_notes_owner_hash");

    // 改写后：两臂都必须 SEARCH 承接，且不再有 note_threads / notes 的 SCAN。
    // （node:sqlite 与 D1 的 planner 对主人臂是否标 COVERING 有差异，这里只
    // 锁「SEARCH + 新索引名」与「无 SCAN」这两个结构事实。）
    const plan = JSON.stringify(db.prepare(`EXPLAIN QUERY PLAN ${LIST_THREADS_UNION}`).all());
    expect(plan).toContain("SEARCH t USING INDEX idx_threads_drawer_status (drawer_hash=? AND status=?)");
    expect(plan).toContain("SEARCH n USING");
    expect(plan).toContain("idx_notes_owner_hash");
    expect(plan).toContain("SEARCH t USING INDEX sqlite_autoindex_note_threads_1 (note_id=?)");
    expect(plan).not.toContain("SCAN t");
    expect(plan).not.toContain("SCAN n");
    db.close();
  });
});
