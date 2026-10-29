import { describe, expect, it } from "vitest";

import {
  PUBLICATION_RESPONSE_SELECT,
  isResponsePublishAnonymous,
  loadPublicReportRespondentLabel,
  type PublicReportEnvironment,
} from "../../../src/services/public-report.service";
import { fullMigrationSchema } from "../../helpers/full-schema";
import { createSqliteD1, sqliteD1Available } from "../../helpers/sqlite-d1";

/**
 * 匿名模式的身份剥离发生在**数据层**，不在前端。
 *
 * 发布链路里身份只有两个注入点：
 *   1. `getResponseDetail(db, responseId, anonymous)` —— anonymous 时不查 users 行，
 *      `respondent` 直接是 null，报告图片上的「填写者」就没有身份可画；
 *   2. `loadPublicReportRespondentLabel(env, responseId, anonymous)` —— caption 的
 *      「填写者」一栏，anonymous 时**立刻返回且不执行任何查询**。
 *
 * 这里钉住第 2 条：不是"查出来再遮盖"，而是匿名时根本没有发出那条 JOIN users 的
 * SQL。这样后面任何下游（caption、日志、异常上报）都不可能拿到名字。
 */
function environment(db: D1Database): PublicReportEnvironment {
  return { DB: db, BOT_TOKEN: "token" } as PublicReportEnvironment;
}

/** 记录所有执行过的 SQL：用来证明"匿名时没查过 users"。 */
function recordingDb(db: D1Database): { db: D1Database; statements: string[] } {
  const statements: string[] = [];
  const proxy = {
    prepare(sql: string) {
      statements.push(sql);
      return db.prepare(sql);
    },
    batch: (items: D1PreparedStatement[]) => db.batch(items),
    exec: (query: string) => db.exec(query),
  } as unknown as D1Database;
  return { db: proxy, statements };
}

async function seed(db: D1Database) {
  await db
    .prepare(
      `INSERT INTO users (id, telegram_user_id, username, first_name, last_name, system_role, created_at, updated_at)
       VALUES (5, 8804863918, 'zhangsan', '张', '三', 'participant', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
    )
    .run();
  await db
    .prepare(
      `INSERT INTO surveys (id, owner_id, title, status, anonymous, allow_multiple_responses, max_responses_per_user,
                            version, created_at, updated_at, published_at)
       VALUES (1, 5, '深夜问卷', 'published', 0, 1, 0, 1, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
    )
    .run();
  await db
    .prepare(
      `INSERT INTO survey_responses (id, survey_id, user_id, participant_hash, status, started_at, completed_at,
                                     report_publication_status, publish_anonymous, publish_message, version,
                                     created_at, updated_at)
       VALUES (9, 1, 5, 'user_5', 'completed', '2026-10-29T02:00:00.000Z', '2026-10-29T02:07:31.000Z',
               'pending', 1, '想说的话', 1, '2026-10-29T02:00:00.000Z', '2026-10-29T02:07:31.000Z')`,
    )
    .run();
}

describe.skipIf(!sqliteD1Available)("公开发布的身份剥离（数据层）", () => {
  it("匿名：返回 null，且没有发出任何查询（身份根本没进内存）", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    await seed(db);
    const recording = recordingDb(db);

    const label = await loadPublicReportRespondentLabel(environment(recording.db), 9, true);

    expect(label).toBeNull();
    expect(recording.statements).toEqual([]);
  });

  it("非匿名：只给姓名 / @用户名，绝不把数字 Telegram ID 写进公开频道", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    await seed(db);

    const label = await loadPublicReportRespondentLabel(environment(db), 9, false);

    expect(label).toBe("张 三");
    // 数字 user id 是可被用于精确检索一个人的内部标识；答卷者同意公开的只有
    // 名字和用户名。
    expect(label).not.toContain("8804863918");
    expect(label).not.toContain("Telegram ID");
  });

  it("非匿名但没填姓名时退回 @用户名；两样都没有就不显示填写者", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    await seed(db);
    await db.prepare("UPDATE users SET first_name = NULL, last_name = NULL WHERE id = 5").run();
    expect(await loadPublicReportRespondentLabel(environment(db), 9, false)).toBe("@zhangsan");

    await db.prepare("UPDATE users SET username = NULL WHERE id = 5").run();
    expect(await loadPublicReportRespondentLabel(environment(db), 9, false)).toBeNull();
  });

  it("非匿名但没有 users 行（网页投稿者）：不给假身份", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    await seed(db);
    await db.prepare("UPDATE survey_responses SET user_id = NULL WHERE id = 9").run();

    expect(await loadPublicReportRespondentLabel(environment(db), 9, false)).toBeNull();
  });

  it("publish_anonymous 的读法：0 才是不匿名，缺列/缺失一律按匿名", () => {
    expect(isResponsePublishAnonymous({ publish_anonymous: 1 })).toBe(true);
    expect(isResponsePublishAnonymous({ publish_anonymous: 0 })).toBe(false);
    expect(isResponsePublishAnonymous({ publish_anonymous: null })).toBe(true);
    // 迁移未 apply 的老库：列不在结果里 → 必须偏安全。
    expect(isResponsePublishAnonymous({})).toBe(true);
  });

  it("发布时那条 SELECT 在真实 schema 上能跑，并带回三项选择与 caption 需要的元数据", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    await seed(db);

    const row = await db.prepare(PUBLICATION_RESPONSE_SELECT).bind(9).first<Record<string, unknown>>();

    expect(row).not.toBeNull();
    expect(row!["survey_title"]).toBe("深夜问卷");
    expect(row!["publish_anonymous"]).toBe(1);
    expect(row!["publish_message"]).toBe("想说的话");
    expect(row!["started_at"]).toBe("2026-10-29T02:00:00.000Z");
    expect(row!["completed_at"]).toBe("2026-10-29T02:07:31.000Z");
  });
});
