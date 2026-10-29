import { describe, expect, it, vi } from "vitest";

import { handleSurveyApiRequest } from "../../../src/http/survey-api";
import { createSurveyParticipantToken } from "../../../src/services/participant-session.service";
import type { Env } from "../../../src/index";
import { fullMigrationSchema } from "../../helpers/full-schema";
import { createSqliteD1, sqliteD1Available } from "../../helpers/sqlite-d1";

/**
 * 提交时把三项发布选择**真的落库**（迁移 0092），而不是在 handler 里读完就丢。
 *
 * 为什么必须在真实 schema + 真实 handler 上测：发布是异步的（提交 → export job
 * → 浏览器渲染 → Telegram）。提交那一刻不落库，发布那一刻就没有任何地方能知道
 * "这次答不匿名、想说什么"。而这套链路失效时**不会报错**——报告照发，只是带着
 * 用户名进了公开频道，或者用户的留言凭空消失。
 */
function makeEnv(db: D1Database, sent: unknown[] = [], queueFails = false): Env {
  return {
    DB: db,
    BOT_TOKEN: "test-token",
    WEBHOOK_SECRET: "publish-choice-secret",
    ADMIN_IDS: "",
    MEDIA_KV: { put: async () => undefined, get: async () => null } as unknown as KVNamespace,
    CACHE: { put: async () => undefined, get: async () => null } as unknown as KVNamespace,
    // 记录发布任务：公开 = 入队一条 public_report。
    EXPORT_QUEUE: {
      send: async (body: unknown) => {
        // 队列不可用时的形态：send 抛错（配额/绑定失效/网络）。
        if (queueFails) throw new Error("queue unavailable");
        sent.push(body);
      },
    } as unknown as Queue,
  } as unknown as Env;
}

async function seedSurvey(db: D1Database) {
  const raw = db as unknown as { prepare: (sql: string) => { run: () => Promise<unknown> } };
  const run = (sql: string) => raw.prepare(sql).run();
  await Promise.all([
    run(
      `INSERT INTO users (id, telegram_user_id, username, first_name, last_name, system_role, created_at, updated_at)
       VALUES (1, 900001, 'owner', '作者', '本人', 'participant', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
    ),
    run(
      `INSERT INTO users (id, telegram_user_id, username, first_name, last_name, system_role, created_at, updated_at)
       VALUES (2, 900002, 'filler', '填写', '者', 'participant', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
    ),
    // 问卷本身**不**匿名：匿名是答卷者的选择，两者必须分开。
    run(
      `INSERT INTO surveys (id, owner_id, title, status, anonymous, allow_multiple_responses,
                            max_responses_per_user, version, created_at, updated_at, published_at)
       VALUES (1, 1, '发布选择测试问卷', 'published', 0, 1, 0, 1,
               '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
    ),
    run(
      `INSERT INTO survey_questions (id, survey_id, type, title, required, "order", created_at, updated_at)
       VALUES (11, 1, 'text', '说点什么', 0, 0, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
    ),
    // 公开报告要有投递目标，否则发布会被判为"未配置"（那是另一条路径，见下）。
    run(
      `INSERT INTO publication_targets (id, name, target_type, chat_id, thread_id, enabled, is_default, created_at, updated_at)
       VALUES (1, '公开频道', 'telegram_topic', '-1002000000001', NULL, 1, 1, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
    ),
  ]);
}

/** 一份已经填了 10 分钟、只等提交的答卷（绕开"提交过快"闸门）。 */
async function seedInProgressResponse(db: D1Database, responseId: number) {
  const raw = db as unknown as { prepare: (sql: string) => { run: () => Promise<unknown> } };
  const started = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  await raw
    .prepare(
      `INSERT INTO survey_responses (id, survey_id, user_id, participant_hash, status, started_at,
                                     current_question_id, version, created_at, updated_at)
       VALUES (${responseId}, 1, 2, 'user_2', 'in_progress', '${started}', 11, 1, '${started}', '${started}')`,
    )
    .run();
  await raw
    .prepare(
      `INSERT INTO answers (response_id, question_id, text_value, created_at, updated_at)
       VALUES (${responseId}, 11, '答完了', '2026-10-15T00:00:00.000Z', '2026-10-15T00:00:00.000Z')`,
    )
    .run();
}

async function submit(
  db: D1Database,
  responseId: number,
  body: Record<string, unknown>,
  sent: unknown[] = [],
  queueFails = false,
) {
  const env = makeEnv(db, sent, queueFails);
  const path = `/api/survey/1/responses/${responseId}/submit`;
  return handleSurveyApiRequest(
    new Request(`https://worker.test${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-participant-token": await createSurveyParticipantToken("publish-choice-secret", 900002),
      },
      body: JSON.stringify(body),
    }),
    env,
    new URL(`https://worker.test${path}`),
  );
}

async function readChoice(db: D1Database, responseId: number) {
  const row = await db
    .prepare(
      "SELECT report_publication_requested requested, publish_anonymous anonymous, publish_message message FROM survey_responses WHERE id = ?",
    )
    .bind(responseId)
    .first<{ requested: number; anonymous: number; message: string | null }>();
  return row;
}

describe.skipIf(!sqliteD1Available)("公开选择落库（真实 schema）", () => {
  it("公开 + 匿名 + 留言：三项都写进答卷行，并入队发布任务", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    await seedSurvey(db);
    await seedInProgressResponse(db, 42);
    const sent: unknown[] = [];

    const response = await submit(
      db,
      42,
      { publishToTelegram: true, publishAnonymous: true, publishMessage: "  想说的第一句\n第二句  " },
      sent,
    );
    expect(response?.status).toBe(200);

    const row = await readChoice(db, 42);
    expect(row?.requested).toBe(1);
    expect(row?.anonymous).toBe(1);
    // 首尾空白在服务端裁掉，换行保留（多段配文）。
    expect(row?.message).toBe("想说的第一句\n第二句");
    // 发布任务只带 responseId：发布那一刻从这条记录读三项选择。
    // （同一个队列也会收到私有存档 report_delivery，所以按 kind 取。）
    expect(sent.filter((item) => (item as { kind?: string }).kind === "public_report")).toEqual([
      { kind: "public_report", responseId: 42 },
    ]);
  });

  it("公开 + 不匿名 + 无留言：匿名标记必须是真的 0（否则等于偷偷匿名）", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    await seedSurvey(db);
    await seedInProgressResponse(db, 43);

    const response = await submit(db, 43, { publishToTelegram: true, publishAnonymous: false });
    expect(response?.status).toBe(200);

    const row = await readChoice(db, 43);
    expect(row?.requested).toBe(1);
    expect(row?.anonymous).toBe(0);
    expect(row?.message).toBeNull();
  });

  it("仅自己可见：不发布，但选择照样落库（后台能看到他想说什么）", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    await seedSurvey(db);
    await seedInProgressResponse(db, 44);
    const sent: unknown[] = [];

    const response = await submit(
      db,
      44,
      { publishToTelegram: false, publishAnonymous: true, publishMessage: "只是自己的备注" },
      sent,
    );
    expect(response?.status).toBe(200);

    const row = await readChoice(db, 44);
    expect(row?.requested).toBe(0);
    expect(row?.anonymous).toBe(1);
    expect(row?.message).toBe("只是自己的备注");
    // 没有公开 → 没有发布任务（只有那条私有存档任务）。
    expect(sent.map((item) => (item as { kind?: string }).kind)).not.toContain("public_report");
  });

  it("老前端/脚本不带这两个字段时按匿名处理（缺省必须收紧）", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    await seedSurvey(db);
    await seedInProgressResponse(db, 45);

    const response = await submit(db, 45, { publishToTelegram: true });
    expect(response?.status).toBe(200);

    const row = await readChoice(db, 45);
    expect(row?.requested).toBe(1);
    expect(row?.anonymous).toBe(1);
    expect(row?.message).toBeNull();
  });

  it("留言超长在服务端再截断一次（前端限长不是信任边界）", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    await seedSurvey(db);
    await seedInProgressResponse(db, 46);

    const response = await submit(db, 46, { publishToTelegram: true, publishMessage: "话".repeat(5000) });
    expect(response?.status).toBe(200);

    const row = await readChoice(db, 46);
    expect(Array.from(row?.message ?? "")).toHaveLength(200);
  });

  it("非布尔/非字符串的脏输入不会把匿名打开", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    await seedSurvey(db);
    await seedInProgressResponse(db, 47);

    const response = await submit(db, 47, {
      publishToTelegram: true,
      publishAnonymous: "no",
      publishMessage: { nested: "object" },
    });
    expect(response?.status).toBe(200);

    const row = await readChoice(db, 47);
    // 字符串 "no" 不是 boolean → 走默认（匿名）；对象不是字符串 → 无留言。
    expect(row?.anonymous).toBe(1);
    expect(row?.message).toBeNull();
  });

  it("选择写失败不影响提交成功（发布降级为匿名+无留言，答卷必须保住）", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    await seedSurvey(db);
    await seedInProgressResponse(db, 48);
    // 让 publish_* 的 UPDATE 失败：模拟迁移尚未 apply 的老库。
    const broken = {
      prepare(sql: string) {
        if (/UPDATE survey_responses SET publish_anonymous/.test(sql)) {
          throw new Error("no such column: publish_anonymous");
        }
        return db.prepare(sql);
      },
      batch: (statements: D1PreparedStatement[]) => db.batch(statements),
      exec: (query: string) => db.exec(query),
    } as unknown as D1Database;

    const response = await submit(broken, 48, { publishToTelegram: true, publishMessage: "还是在" });
    expect(response?.status).toBe(200);
    const payload = (await response?.json()) as { completed?: boolean; warning?: string };
    expect(payload.completed).toBe(true);
    // 静默失败曾经是这条链路的常态：选择没写进去，界面还说"一切正常"。
    // 现在响应里必须带一条 warning，前端据此提示。
    expect(payload.warning).toContain("发布选项没能保存");
  });

  it("发布入队失败：答卷仍然成功，但状态是 failed 且响应里带 warning", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    await seedSurvey(db);
    await seedInProgressResponse(db, 49);

    const response = await submit(db, 49, { publishToTelegram: true, publishAnonymous: true }, [], true);
    expect(response?.status).toBe(200);
    const payload = (await response?.json()) as { ok?: boolean; completed?: boolean; warning?: string };
    // 答卷已经落库，提交本身不是失败——但"勾了发布、频道里没有消息、界面零提示"
    // 必须终止在这里。
    expect(payload.completed).toBe(true);
    expect(payload.warning).toContain("公开发布未成功");

    const row = await db
      .prepare("SELECT report_publication_status status FROM survey_responses WHERE id = ?")
      .bind(49)
      .first<{ status: string }>();
    expect(row?.status).toBe("failed");
  });
});
