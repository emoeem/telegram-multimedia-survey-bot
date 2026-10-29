import { beforeEach, describe, expect, it, vi } from "vitest";

import { fullMigrationSchema } from "../../helpers/full-schema";
import { createSqliteD1, sqliteD1Available } from "../../helpers/sqlite-d1";
import { handleAdminReportsWrite } from "../../../src/http/admin/reports";
import type { WriteContext } from "../../../src/http/admin/helpers";
import type { Env } from "../../../src/index";

/**
 * 手动重投公开报告。
 *
 * 为什么这必须存在：发布是"入队即忘"的异步链路，入队失败只把
 * report_publication_status 写成 failed。没有这个入口时 failed 是一条死状态——
 * 答卷者勾了发布、频道里没有消息、后台也不显示（生产库里就有 32 条无人知）。
 *
 * 这里钉住四件事：归属校验、已发布不重发（幂等）、状态回 pending、入队失败回滚。
 */
const sent: unknown[] = [];
let queueFails = false;

function makeEnv(db: D1Database): Env {
  return {
    DB: db,
    BOT_TOKEN: "test-token",
    WEBHOOK_SECRET: "secret",
    ADMIN_IDS: "",
    EXPORT_QUEUE: {
      send: async (body: unknown) => {
        if (queueFails) throw new Error("queue unavailable");
        sent.push(body);
      },
    } as unknown as Queue,
  } as unknown as Env;
}

function context(actorId: number, isAdmin = false): WriteContext {
  return {
    user: { id: actorId } as WriteContext["user"],
    isAdmin,
    requestId: "test",
    fail: (status, code, message) => Response.json({ code, message }, { status }),
    json: (body) => Response.json(body),
  };
}

async function seed(db: D1Database, ownerId = 1, status = "failed", requested = 1) {
  await db
    .prepare(
      `INSERT INTO users (id, telegram_user_id, username, first_name, last_name, system_role, created_at, updated_at)
       VALUES (1, 900001, 'owner', '作者', '本人', 'participant', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
    )
    .run();
  await db
    .prepare(
      `INSERT INTO users (id, telegram_user_id, username, first_name, last_name, system_role, created_at, updated_at)
       VALUES (2, 900002, 'other', '别', '人', 'participant', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
    )
    .run();
  await db
    .prepare(
      `INSERT INTO surveys (id, owner_id, title, status, anonymous, allow_multiple_responses, max_responses_per_user,
                            version, created_at, updated_at, published_at)
       VALUES (1, ?, '夜行电车', 'published', 0, 1, 0, 1, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
    )
    .bind(ownerId)
    .run();
  await db
    .prepare(
      `INSERT INTO survey_responses (id, survey_id, participant_hash, status, started_at, completed_at,
                                     report_publication_requested, report_publication_status, version, created_at, updated_at)
       VALUES (7, 1, 'user_1', 'completed', '2026-10-29T02:00:00.000Z', '2026-10-29T02:07:31.000Z', ?, ?, 1,
               '2026-10-29T02:00:00.000Z', '2026-10-29T02:07:31.000Z')`,
    )
    .bind(requested, status)
    .run();
}

function request(): { req: Request; url: URL } {
  const url = new URL("https://worker.test/api/admin/surveys/1/responses/7/report-publication/retry");
  return { req: new Request(url, { method: "POST" }), url };
}

async function statusOf(db: D1Database) {
  const row = await db
    .prepare("SELECT report_publication_status status FROM survey_responses WHERE id = 7")
    .first<{ status: string }>();
  return row?.status;
}

beforeEach(() => {
  sent.length = 0;
  queueFails = false;
});

describe.skipIf(!sqliteD1Available)("公开报告手动重投", () => {
  it("failed → 重新入队，状态回到 pending，并写审计", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    await seed(db);
    const { req, url } = request();

    const response = await handleAdminReportsWrite(req, url, makeEnv(db), context(1), {});
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ ok: true, status: "pending" });
    expect(sent).toEqual([{ kind: "public_report", responseId: 7 }]);
    expect(await statusOf(db)).toBe("pending");

    const audit = await db
      .prepare("SELECT action FROM audit_logs WHERE action = ?")
      .bind("report.publication.retry")
      .first<{ action: string }>();
    expect(audit?.action).toBe("report.publication.retry");
  });

  it("别人的答卷不能重投（403），且不发任何消息", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    await seed(db);
    const { req, url } = request();

    const response = await handleAdminReportsWrite(req, url, makeEnv(db), context(2), {});
    expect(response?.status).toBe(403);
    expect(sent).toHaveLength(0);
    expect(await statusOf(db)).toBe("failed");
  });

  it("管理员可以重投别人的答卷", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    await seed(db);
    const { req, url } = request();

    const response = await handleAdminReportsWrite(req, url, makeEnv(db), context(2, true), {});
    expect(response?.status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it("已发布的答卷不重复发（幂等：否则频道里会出现第二份相册）", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    await seed(db, 1, "published");
    const { req, url } = request();

    const response = await handleAdminReportsWrite(req, url, makeEnv(db), context(1), {});
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ ok: true, status: "published", alreadyPublished: true });
    expect(sent).toHaveLength(0);
  });

  it("没勾公开发布的答卷拒绝重投（不能拿这个入口把内容推进频道）", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    await seed(db, 1, "private", 0);
    const { req, url } = request();

    const response = await handleAdminReportsWrite(req, url, makeEnv(db), context(1), {});
    expect(response?.status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it("入队失败：状态退回 failed，接口返回 503", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    await seed(db);
    queueFails = true;
    const { req, url } = request();

    const response = await handleAdminReportsWrite(req, url, makeEnv(db), context(1), {});
    expect(response?.status).toBe(503);
    expect(await statusOf(db)).toBe("failed");
  });
});
