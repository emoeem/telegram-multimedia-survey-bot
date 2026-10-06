import { describe, expect, it } from "vitest";

import { resolvePublicReportTargets } from "../../../src/services/public-report.service";
import type { PublicReportEnvironment } from "../../../src/services/public-report.service";
import { createSqliteD1, sqliteD1Available } from "../../helpers/sqlite-d1";

/**
 * 公开报告的接收方解析：本机所有启用目标优先（fan-out），没有才回落到答卷提交时
 * 的目标快照（customer 角色的机器不维护本地列表）、再回落到默认目标。
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
`;

const describeIf = sqliteD1Available ? describe : describe.skip;

const response = (
  overrides: Partial<{
    publication_target_id: number | null;
    publication_target_chat_id: string | null;
    publication_target_thread_id: number | null;
  }> = {},
) => ({
  id: 1,
  survey_id: 2,
  status: "completed",
  report_publication_status: "pending",
  publication_target_id: null,
  publication_target_chat_id: null,
  publication_target_thread_id: null,
  ...overrides,
});

function env(db: D1Database): PublicReportEnvironment {
  return { DB: db, BOT_TOKEN: "token" } as PublicReportEnvironment;
}

async function seed(
  db: D1Database,
  rows: Array<{ name: string; chatId: string; threadId: number | null; enabled?: boolean; isDefault?: boolean }>,
) {
  for (const row of rows) {
    await db
      .prepare(
        "INSERT INTO publication_targets(name,target_type,chat_id,thread_id,enabled,is_default,created_at,updated_at) VALUES(?,'telegram_topic',?,?,?,?,?,?)",
      )
      .bind(row.name, row.chatId, row.threadId, row.enabled === false ? 0 : 1, row.isDefault ? 1 : 0, "t", "t")
      .run();
  }
}

describeIf("resolvePublicReportTargets", () => {
  it("把所有启用目标都当作接收方（不再只认默认那一个）", async () => {
    const db = createSqliteD1(SCHEMA);
    await seed(db, [
      { name: "归档频道", chatId: "-1004489719605", threadId: null, isDefault: false },
      { name: "天地一家大爱盟", chatId: "-1004497177255", threadId: 6016, isDefault: true },
    ]);

    const targets = await resolvePublicReportTargets(env(db), response({ publication_target_chat_id: "-1009999" }));

    expect(targets.map((target) => target.chatId)).toEqual(["-1004497177255", "-1004489719605"]);
    expect(targets[0]!.threadId).toBe(6016);
  });

  it("停用的目标不接收", async () => {
    const db = createSqliteD1(SCHEMA);
    await seed(db, [
      { name: "群 A", chatId: "-1001", threadId: null },
      { name: "群 B", chatId: "-1002", threadId: null, enabled: false },
    ]);

    expect((await resolvePublicReportTargets(env(db), response())).map((target) => target.chatId)).toEqual(["-1001"]);
  });

  it("本地没有启用目标时回落到答卷快照（customer 角色的机器）", async () => {
    const db = createSqliteD1(SCHEMA);

    const targets = await resolvePublicReportTargets(
      env(db),
      response({
        publication_target_id: 7,
        publication_target_chat_id: "-1004497177255",
        publication_target_thread_id: 6016,
      }),
    );

    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ chatId: "-1004497177255", threadId: 6016 });
  });

  it("既没有目标也快照时回落到默认目标，全无配置则返回空列表", async () => {
    const db = createSqliteD1(SCHEMA);
    expect(await resolvePublicReportTargets(env(db), response())).toEqual([]);

    await seed(db, [{ name: "群 A", chatId: "-1001", threadId: null, isDefault: true }]);
    expect((await resolvePublicReportTargets(env(db), response())).map((target) => target.chatId)).toEqual(["-1001"]);
  });
});
