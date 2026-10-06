import { describe, expect, it } from "vitest";

import {
  getDefaultPublicationTarget,
  listEnabledPublicationTargets,
  upsertPublicationTargetForChat,
} from "../../../src/db/repositories/publication-target.repository";
import { createSqliteD1, sqliteD1Available } from "../../helpers/sqlite-d1";

/**
 * /set_publish_target 的落库语义（迁移 0061）：追加而不是替换，且同一个群/话题
 * 重复执行只更新那一行。公开报告是 fan-out（一份相册发到所有启用目标），重复行
 * 会让同一个群收到两份，所以这里用真实 SQL 验去重。
 */
const SCHEMA = `
CREATE TABLE publication_targets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  target_type TEXT NOT NULL DEFAULT 'telegram_topic',
  chat_id TEXT NOT NULL,
  thread_id INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_publication_targets_default ON publication_targets(enabled, is_default, id);
`;

const describeIf = sqliteD1Available ? describe : describe.skip;

describeIf("publication-target repository", () => {
  it("重复在同一个群执行只更新那一行（thread_id 为 NULL 时也去重）", async () => {
    const db = createSqliteD1(SCHEMA);

    const first = await upsertPublicationTargetForChat(db, { name: "群 A", chatId: "-1001", threadId: null });
    const second = await upsertPublicationTargetForChat(db, { name: "群 A 改名", chatId: "-1001", threadId: null });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.target?.id).toBe(first.target?.id);
    expect(second.target?.name).toBe("群 A 改名");
    expect(second.activeCount).toBe(1);
    expect(await listEnabledPublicationTargets(db)).toHaveLength(1);
  });

  it("同一个群的不同话题是各自独立的目标", async () => {
    const db = createSqliteD1(SCHEMA);

    await upsertPublicationTargetForChat(db, { name: "群 A", chatId: "-1001", threadId: 11 });
    await upsertPublicationTargetForChat(db, { name: "群 A", chatId: "-1001", threadId: 22 });
    const again = await upsertPublicationTargetForChat(db, { name: "群 A", chatId: "-1001", threadId: 22 });

    expect(again.created).toBe(false);
    expect(again.activeCount).toBe(2);
  });

  it("追加新群不会挤掉旧群（旧目标保持启用）", async () => {
    const db = createSqliteD1(SCHEMA);

    await upsertPublicationTargetForChat(db, { name: "群 A", chatId: "-1001", threadId: null });
    const second = await upsertPublicationTargetForChat(db, { name: "群 B", chatId: "-1002", threadId: 6016 });

    const enabled = await listEnabledPublicationTargets(db);
    expect(enabled.map((target) => target.chatId)).toEqual(["-1001", "-1002"]);
    expect(second.activeCount).toBe(2);
    // 默认目标只用于「没有启用目标」时的回落，和 fan-out 是否覆盖无关。
    expect((await getDefaultPublicationTarget(db))?.chatId).toBe("-1001");
  });

  it("重新在旧的群里执行会把它重新启用", async () => {
    const db = createSqliteD1(SCHEMA);

    const first = await upsertPublicationTargetForChat(db, { name: "群 A", chatId: "-1001", threadId: null });
    await db.prepare("UPDATE publication_targets SET enabled=0 WHERE id=?").bind(first.target!.id).run();
    expect(await listEnabledPublicationTargets(db)).toHaveLength(0);

    const again = await upsertPublicationTargetForChat(db, { name: "群 A", chatId: "-1001", threadId: null });
    expect(again.created).toBe(false);
    expect(again.target?.enabled).toBe(true);
    expect(await listEnabledPublicationTargets(db)).toHaveLength(1);
  });

  it("停用的目标不出现在 fan-out 列表里", async () => {
    const db = createSqliteD1(SCHEMA);

    const first = await upsertPublicationTargetForChat(db, { name: "群 A", chatId: "-1001", threadId: null });
    await upsertPublicationTargetForChat(db, { name: "群 B", chatId: "-1002", threadId: null });
    await db.prepare("UPDATE publication_targets SET enabled=0 WHERE id=?").bind(first.target!.id).run();

    expect((await listEnabledPublicationTargets(db)).map((target) => target.chatId)).toEqual(["-1002"]);
  });
});
