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

/**
 * 人工重试端点（通宵批次 B6：POST /api/control/jobs/:kind/:id/retry）。
 *
 * 复用同一份 seed（图片 #21/#22/#23、渲染 #31/#32/#33、导出 #41/#42/#43
 * 分别是 failed/活跃/completed）。sender 用注入的假 EXPORT_QUEUE 记录重投
 * 消息——createExportJobSender 把带 send 的对象当队列，与生产 Queue 同构。
 */
describeIf("POST /api/control/jobs/:kind/:id/retry", () => {
  function retryEnv(db: D1Database, sends: unknown[]) {
    return { DB: db, EXPORT_QUEUE: { send: async (message: unknown) => void sends.push(message) } };
  }

  function retry(env: ReturnType<typeof envFor>, kind: string, id: number, auth = ADMIN_AUTH) {
    return handleControlApiRequest(
      new Request(`https://example.test/api/control/jobs/${kind}/${id}/retry`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      env,
      auth,
    );
  }

  async function jobStatus(db: D1Database, table: string, id: number) {
    // error_code 只有 render_jobs 有，主 helper 不取它（渲染用例单独查）。
    return db
      .prepare(
        `SELECT status, error_message AS errorMessage, completed_at AS completedAt
                FROM ${table} WHERE id = ?`,
      )
      .bind(id)
      .first<{ status: string; errorMessage: string | null; completedAt: string | null }>();
  }

  it("三类 failed 任务各重试一次：状态回到待处理并重投一条队列消息", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    await seed(db);
    const sends: unknown[] = [];
    const env = retryEnv(db, sends);

    const image = await retry(env, "image_generator", 21);
    expect(image?.status).toBe(200);
    expect(await image?.json()).toMatchObject({ ok: true, status: "queued" });
    expect(await jobStatus(db, "image_generator_jobs", 21)).toMatchObject({
      status: "queued",
      errorMessage: null,
      completedAt: null,
    });

    const render = await retry(env, "render", 31);
    expect(render?.status).toBe(200);
    expect(await render?.json()).toMatchObject({ ok: true, status: "queued" });
    expect(await jobStatus(db, "render_jobs", 31)).toMatchObject({
      status: "queued",
      errorMessage: null,
      completedAt: null,
    });
    // render_jobs 独有的 error_code 也一并清掉。
    expect(
      await db
        .prepare("SELECT error_code AS errorCode FROM render_jobs WHERE id = 31")
        .first<{ errorCode: string | null }>(),
    ).toMatchObject({ errorCode: null });

    const exportRetry = await retry(env, "export", 41);
    expect(exportRetry?.status).toBe(200);
    expect(await exportRetry?.json()).toMatchObject({ ok: true, status: "pending" });
    expect(await jobStatus(db, "export_jobs", 41)).toMatchObject({
      status: "pending",
      errorMessage: null,
      completedAt: null,
    });

    // 三条队列消息与既有消费者消息形状一致（导出的 chatId 从 requested_by
    // 解析到种子里用户 1 的 telegram_user_id=900001）。
    expect(sends).toEqual([
      { kind: "image_generator", jobId: 21 },
      { kind: "result_visual", jobId: 31 },
      { jobId: 41, surveyId: 1, chatId: 900001, format: "zip" },
    ]);
  });

  it("非终态（queued/processing/running/completed）一律 409，不重投", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    await seed(db);
    const sends: unknown[] = [];
    const env = retryEnv(db, sends);
    for (const [kind, id] of [
      ["image_generator", 22], // queued
      ["image_generator", 23], // completed
      ["render", 32], // processing
      ["render", 33], // completed
      ["export", 42], // running
      ["export", 43], // completed
    ] as const) {
      const res = await retry(env, kind, id);
      expect(res?.status, `${kind}#${id}`).toBe(409);
      expect(await res?.json()).toMatchObject({ ok: false, error: "job_not_retryable" });
    }
    expect(sends).toEqual([]);
  });

  it("白名单外 kind 返回 404：delivery 走既有归属校验端点，不在这里开口子", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    await seed(db);
    const sends: unknown[] = [];
    const env = retryEnv(db, sends);
    for (const kind of ["delivery", "bogus", "runner"]) {
      const res = await retry(env, kind, 21);
      expect(res?.status, kind).toBe(404);
      expect(await res?.json()).toMatchObject({ ok: false, error: "unknown_job_kind" });
    }
    expect(sends).toEqual([]);
  });

  it("同一 failed 任务连续两次 retry：第二次 409 且不重投（幂等，不产生重复产物）", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    await seed(db);
    const sends: unknown[] = [];
    const env = retryEnv(db, sends);
    const first = await retry(env, "image_generator", 21);
    expect(first?.status).toBe(200);
    const second = await retry(env, "image_generator", 21);
    expect(second?.status).toBe(409);
    // 只有一条队列消息、行仍是 queued（第一次的结果），状态没有被第二次改动。
    expect(sends).toEqual([{ kind: "image_generator", jobId: 21 }]);
    expect((await jobStatus(db, "image_generator_jobs", 21))?.status).toBe("queued");
  });

  it("任务不存在 404；非管理员一律 403", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    await seed(db);
    const sends: unknown[] = [];
    const env = retryEnv(db, sends);
    const missing = await retry(env, "image_generator", 999);
    expect(missing?.status).toBe(404);
    expect(await missing?.json()).toMatchObject({ ok: false, error: "job_not_found" });

    const forbidden = await retry(env, "image_generator", 21, { isAdmin: false, userId: 2 });
    expect(forbidden?.status).toBe(403);
    expect(await forbidden?.json()).toMatchObject({ ok: false, error: "forbidden" });
    expect(sends).toEqual([]);
  });

  it("导出请求人无法解析时 409，不动任务状态", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    await seed(db);
    // 种子外补一条 requested_by 为空的 failed 导出（不影响上面 GET 用例的计数）。
    await db
      .prepare(
        `INSERT INTO export_jobs (id, survey_id, requested_by, format, status, error_message, created_at, completed_at)
         VALUES (44, 1, NULL, 'csv', 'failed', 'whoops', '2026-10-30T10:00:00.000Z', '2026-10-30T10:00:10.000Z')`,
      )
      .run();
    const sends: unknown[] = [];
    const res = await retry(retryEnv(db, sends), "export", 44);
    expect(res?.status).toBe(409);
    expect(await res?.json()).toMatchObject({ ok: false, error: "export_target_unresolvable" });
    expect((await jobStatus(db, "export_jobs", 44))?.status).toBe("failed");
    expect(sends).toEqual([]);
  });

  it("同档案+模板已有活跃渲染行时，重试撞部分唯一索引转 409，不重投", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    await seed(db);
    // #31 是 (profile 1, template 1, version 1) 的 failed 行；补一条同键的
    // queued 活跃行，重试 #31 的重入队会撞 idx_render_jobs_active（0035）。
    await db
      .prepare(
        `INSERT INTO render_jobs (id, result_profile_id, template_id, template_version, chat_id, requested_by, status,
                                  attempts, created_at, started_at)
         VALUES (34, 1, 1, 1, 203, 1, 'queued', 0, '2026-11-07T08:00:00.000Z', NULL)`,
      )
      .run();
    const sends: unknown[] = [];
    const res = await retry(retryEnv(db, sends), "render", 31);
    expect(res?.status).toBe(409);
    expect(await res?.json()).toMatchObject({ ok: false, error: "render_job_conflict" });
    // 状态回滚为 failed（唯一索引拒绝整个 UPDATE），也没有消息投出去。
    expect((await jobStatus(db, "render_jobs", 31))?.status).toBe("failed");
    expect(sends).toEqual([]);
  });
});
