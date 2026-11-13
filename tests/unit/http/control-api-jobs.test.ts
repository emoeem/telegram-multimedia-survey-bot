import { describe, expect, it } from "vitest";

import { handleControlApiRequest } from "../../../src/http/control-api";
import { fullMigrationSchema } from "../../helpers/full-schema";
import { createSqliteD1, sqliteD1Available } from "../../helpers/sqlite-d1";

/**
 * 任务中心聚合端点（审查第四阶段 E：GET /api/control/jobs）。
 *
 * 用完整迁移 schema 的真实 SQLite（而非手写假 D1）钉住三件跨表的事：
 *   1. 失败/积压口径：积压 = 非终态行（投递含 delivering，导出含 running/sending）；
 *   2. 投递的 retrying（pending + next_retry_at）与 failed 一起进失败明细；
 *   3. 四张表互不相干的 id 按「发生时间」合并排序，limit 全局截断。
 */

const describeIf = sqliteD1Available ? describe : describe.skip;

const ADMIN_AUTH = { isAdmin: true, userId: 1 };

function envFor(db: D1Database) {
  return { DB: db };
}

function getJobs(env: ReturnType<typeof envFor>, limit?: number) {
  const search = limit === undefined ? "" : `?limit=${limit}`;
  return handleControlApiRequest(new Request(`https://example.test/api/control/jobs${search}`), env, ADMIN_AUTH);
}

/** FK 在迁移 0018 末尾被打开，按依赖顺序插父行，再种四张任务表的各状态行。 */
async function seed(db: D1Database) {
  const run = (sql: string, ...args: unknown[]) =>
    db
      .prepare(sql)
      .bind(...args)
      .run();
  await run(
    `INSERT INTO users (id, telegram_user_id, username, first_name, last_name, system_role, created_at, updated_at)
     VALUES (1, 900001, 'admin', '管', '理', 'admin', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
  );
  await run(
    `INSERT INTO surveys (id, owner_id, title, status, anonymous, allow_multiple_responses, max_responses_per_user,
                          version, created_at, updated_at, published_at)
     VALUES (1, 1, '夜行电车', 'published', 0, 1, 0, 1,
             '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
  );
  // report_deliveries.response_id 是 UNIQUE（一次投递一行，重投复用该行），
  // 所以三种状态各挂一份答卷。
  const responseIds = [7, 8, 9];
  for (const responseId of responseIds) {
    await run(
      `INSERT INTO survey_responses (id, survey_id, participant_hash, status, started_at, completed_at,
                                     report_publication_requested, report_publication_status, version, created_at, updated_at)
       VALUES (?, 1, ?, 'completed', '2026-10-29T02:00:00.000Z', '2026-10-29T02:07:31.000Z', 0, 'private', 1,
               '2026-10-29T02:00:00.000Z', '2026-10-29T02:07:31.000Z')`,
      responseId,
      `user_${responseId}`,
    );
  }
  await run(
    `INSERT INTO visual_templates (id, name, type, created_at, updated_at)
     VALUES (1, '默认模板', 'card', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
  );
  await run(
    `INSERT INTO image_generators (id, owner_id, name, template_id, created_at, updated_at)
     VALUES (1, 1, '心情生成器', 1, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
  );
  await run(
    `INSERT INTO result_profiles (id, survey_id, response_id, fields_json, stats_json, tags_json, images_json,
                                  metadata_json, created_at, updated_at)
     VALUES (1, 1, 7, '[]', '{}', '[]', '[]', '{}',
             '2026-10-29T02:08:00.000Z', '2026-10-29T02:08:00.000Z')`,
  );

  // 投递：failed（终态）+ retrying（pending 且 next_retry_at 非空）+ delivered。
  await run(
    `INSERT INTO report_deliveries (id, response_id, report_version, delivery_id, status, attempts, last_error,
                                    next_retry_at, created_at, updated_at)
     VALUES (11, 7, 1, 'd-11', 'failed', 3, 'Telegram 429: too many requests', NULL,
             '2026-10-29T02:10:00.000Z', '2026-11-03T09:00:00.000Z')`,
  );
  await run(
    `INSERT INTO report_deliveries (id, response_id, report_version, delivery_id, status, attempts, last_error,
                                    next_retry_at, created_at, updated_at)
     VALUES (12, 8, 1, 'd-12', 'pending', 1, 'Telegram timeout', '2026-11-05T10:00:00.000Z',
             '2026-10-29T02:12:00.000Z', '2026-11-05T09:30:00.000Z')`,
  );
  await run(
    `INSERT INTO report_deliveries (id, response_id, report_version, delivery_id, status, attempts,
                                    created_at, updated_at)
     VALUES (13, 9, 1, 'd-13', 'delivered', 1, '2026-10-29T02:14:00.000Z', '2026-10-29T02:15:00.000Z')`,
  );

  // 图片生成：failed + queued（积压）+ completed。
  await run(
    `INSERT INTO image_generator_jobs (id, generator_id, template_id, template_version, input_json, chat_id, user_id,
                                       status, attempts, error_message, created_at, completed_at)
     VALUES (21, 1, 1, 1, '{}', 100, 1, 'failed', 3, 'WASM render OOM',
             '2026-11-02T08:00:00.000Z', '2026-11-02T08:01:00.000Z')`,
  );
  await run(
    `INSERT INTO image_generator_jobs (id, generator_id, template_id, template_version, input_json, chat_id, user_id,
                                       status, attempts, created_at)
     VALUES (22, 1, 1, 1, '{}', 101, 1, 'queued', 0, '2026-11-06T08:00:00.000Z')`,
  );
  await run(
    `INSERT INTO image_generator_jobs (id, generator_id, template_id, template_version, input_json, chat_id, user_id,
                                       status, attempts, created_at, completed_at)
     VALUES (23, 1, 1, 1, '{}', 102, 1, 'completed', 1, '2026-11-02T09:00:00.000Z', '2026-11-02T09:00:30.000Z')`,
  );

  // 结果渲染：failed + processing（积压）+ completed。活跃行走唯一索引
  // idx_render_jobs_active，用不同 template_version 避免互相顶掉。
  await run(
    `INSERT INTO render_jobs (id, result_profile_id, template_id, template_version, chat_id, requested_by, status,
                              attempts, error_code, error_message, created_at, started_at, completed_at)
     VALUES (31, 1, 1, 1, 200, 1, 'failed', 3, 'render_failed', 'font download failed',
             '2026-11-01T08:00:00.000Z', '2026-11-01T08:00:10.000Z', '2026-11-01T08:01:00.000Z')`,
  );
  await run(
    `INSERT INTO render_jobs (id, result_profile_id, template_id, template_version, chat_id, requested_by, status,
                              attempts, created_at, started_at)
     VALUES (32, 1, 1, 2, 201, 1, 'processing', 1, '2026-11-06T08:00:00.000Z', '2026-11-06T08:00:05.000Z')`,
  );
  await run(
    `INSERT INTO render_jobs (id, result_profile_id, template_id, template_version, chat_id, requested_by, status,
                              attempts, created_at, started_at, completed_at)
     VALUES (33, 1, 1, 3, 202, 1, 'completed', 1, '2026-11-01T09:00:00.000Z', '2026-11-01T09:00:01.000Z',
             '2026-11-01T09:00:20.000Z')`,
  );

  // 导出：failed + running（积压）+ completed。
  await run(
    `INSERT INTO export_jobs (id, survey_id, requested_by, format, status, error_message, created_at, completed_at)
     VALUES (41, 1, 1, 'zip', 'failed', 'R2 put failed', '2026-10-30T08:00:00.000Z', '2026-10-30T08:00:10.000Z')`,
  );
  await run(
    `INSERT INTO export_jobs (id, survey_id, requested_by, format, status, created_at)
     VALUES (42, 1, 1, 'csv', 'running', '2026-11-06T09:00:00.000Z')`,
  );
  await run(
    `INSERT INTO export_jobs (id, survey_id, requested_by, format, status, created_at, completed_at)
     VALUES (43, 1, 1, 'csv', 'completed', '2026-10-30T09:00:00.000Z', '2026-10-30T09:00:05.000Z')`,
  );
}

describeIf("GET /api/control/jobs", () => {
  it("返回四类任务的状态分布与积压口径（积压 = 非终态）", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    await seed(db);
    const res = await getJobs(envFor(db));
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as {
      ok: boolean;
      counts: Record<string, Array<{ status: string; count: number }>>;
      backlog: Record<string, number>;
    };
    expect(body.ok).toBe(true);
    const countOf = (key: string, status: string) => body.counts[key]?.find((row) => row.status === status)?.count ?? 0;
    // 投递含 delivering；导出含 running/sending；图片与渲染含 queued/processing。
    expect(body.backlog.deliveries).toBe(1);
    expect(body.backlog.imageGeneratorJobs).toBe(1);
    expect(body.backlog.renderJobs).toBe(1);
    expect(body.backlog.exportJobs).toBe(1);
    expect(countOf("deliveries", "failed")).toBe(1);
    expect(countOf("deliveries", "delivered")).toBe(1);
    expect(countOf("imageGeneratorJobs", "failed")).toBe(1);
    expect(countOf("renderJobs", "processing")).toBe(1);
    expect(countOf("exportJobs", "running")).toBe(1);
  });

  it("投递的 retrying（pending + next_retry_at）与 failed 一起进失败明细，并带上下文", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    await seed(db);
    const res = await getJobs(envFor(db));
    const body = (await res?.json()) as {
      recentFailures: Array<{
        kind: string;
        id: number;
        status: string;
        error: string | null;
        surveyTitle: string | null;
        responseId: number | null;
        generatorId: number | null;
        resultProfileId: number | null;
        surveyId: number | null;
        format: string | null;
      }>;
    };
    const deliveryFailed = body.recentFailures.find((row) => row.kind === "delivery" && row.id === 11);
    const deliveryRetrying = body.recentFailures.find((row) => row.kind === "delivery" && row.id === 12);
    expect(deliveryFailed).toMatchObject({ status: "failed", surveyTitle: "夜行电车", responseId: 7 });
    expect(deliveryRetrying).toMatchObject({ status: "pending", error: "Telegram timeout" });
    // 已送达的行不属于失败明细。
    expect(body.recentFailures.some((row) => row.id === 13)).toBe(false);
    // 其它三类各自的定位字段。
    expect(body.recentFailures.find((row) => row.kind === "image_generator")).toMatchObject({
      id: 21,
      generatorId: 1,
      chatId: 100,
    });
    expect(body.recentFailures.find((row) => row.kind === "render")).toMatchObject({
      id: 31,
      resultProfileId: 1,
      error: "font download failed",
    });
    expect(body.recentFailures.find((row) => row.kind === "export")).toMatchObject({
      id: 41,
      surveyId: 1,
      format: "zip",
    });
  });

  it("四张表的失败按发生时间合并排序，limit 全局截断", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    await seed(db);
    const res = await getJobs(envFor(db), 2);
    const body = (await res?.json()) as { recentFailures: Array<{ kind: string; id: number; happenedAt: string }> };
    // 失败行的发生时间：投递#12=11-05（retrying，updated_at）、投递#11=11-03、
    // 图片#21=11-02、渲染#31=11-01、导出#41=10-30。全局最近两条是投递#12 与
    // #11，而不是每表各一条。
    expect(body.recentFailures.map((row) => row.id)).toEqual([12, 11]);
  });

  it("非管理员一律 403，拿不到任何任务数据", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    await seed(db);
    const res = await handleControlApiRequest(new Request("https://example.test/api/control/jobs"), envFor(db), {
      isAdmin: false,
      userId: 2,
    });
    expect(res?.status).toBe(403);
  });

  it("limit 越界时收敛到 20/50，不抛错", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    await seed(db);
    for (const limit of ["0", "-5", "1000"]) {
      const res = await getJobs(envFor(db), Number(limit));
      expect(res?.status).toBe(200);
      const body = (await res?.json()) as { recentFailures: unknown[] };
      // 种子里共 5 条失败行（含 1 条 retrying 投递），clamp 之后仍应全部返回且有序。
      expect(body.recentFailures).toHaveLength(5);
    }
  });
});
