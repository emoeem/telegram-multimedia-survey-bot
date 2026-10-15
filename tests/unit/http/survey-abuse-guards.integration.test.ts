import { describe, expect, it, vi } from "vitest";

import { handleSurveyApiRequest } from "../../../src/http/survey-api";
import { atomicRateLimitWindow } from "../../../src/services/rate-limit.service";
import type { Env } from "../../../src/index";
import { fullMigrationSchema } from "../../helpers/full-schema";
import { createSqliteD1, sqliteD1Available } from "../../helpers/sqlite-d1";

/**
 * 反「恶意填写刷数据/污染」的闸门（真实 schema + 真实处理器）。
 *
 * 背景：匿名答卷者的身份是浏览器本地 key，脚本每请求换一个 key 就能绕过所有按人的
 * 限流（`maxResponsesPerUser`、答案保存限流都形同虚设）。防御重心因此落在脚本不易
 * 伪造的维度：**地址**（开卷日上限）与**设备指纹**（同问卷日上限），以及唯一能把内容
 * 推进公开频道的出口「公开发布到 Telegram」（此前完全没有门槛）。
 */
function makeEnv(db: D1Database, overrides: Partial<Env> = {}): Env {
  return {
    DB: db,
    BOT_TOKEN: "test-token",
    WEBHOOK_SECRET: "abuse-test-secret",
    ADMIN_IDS: "",
    MEDIA_KV: {
      put: async () => undefined,
      get: async () => null,
    } as unknown as KVNamespace,
    CACHE: {
      put: async () => undefined,
      get: async () => null,
    } as unknown as KVNamespace,
    EXPORT_QUEUE: { send: async () => undefined } as unknown as Queue,
    ...overrides,
  } as unknown as Env;
}

/** 直接往 rate_limits 里塞一条"已到上限"的计数：比打满 40 次请求快得多。 */
function seedRateLimit(db: D1Database, bucket: string, identity: string, windowSeconds: number, count: number) {
  const { key, windowStart } = atomicRateLimitWindow(bucket, identity, windowSeconds, Date.now());
  const raw = db as unknown as { prepare: (sql: string) => { run: () => Promise<unknown> } };
  return raw
    .prepare(
      `INSERT INTO rate_limits (key, count, window_start) VALUES ('${key}', ${count}, ${windowStart})
       ON CONFLICT(key) DO UPDATE SET count = ${count}, window_start = ${windowStart}`,
    )
    .run();
}

function seedSurvey(db: D1Database) {
  const raw = db as unknown as { prepare: (sql: string) => { run: () => Promise<unknown> } };
  const run = (sql: string) => raw.prepare(sql).run();
  return Promise.all([
    run(
      `INSERT INTO users (id, telegram_user_id, username, first_name, system_role, created_at, updated_at)
       VALUES (1, 900001, 'owner', '作者', 'participant', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
    ),
    run(
      `INSERT INTO surveys (id, owner_id, title, status, anonymous, allow_multiple_responses,
                            max_responses_per_user, version, created_at, updated_at, published_at)
       VALUES (1, 1, '反刷测试问卷', 'published', 0, 1, 0, 1,
               '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
    ),
    run(
      `INSERT INTO survey_questions (id, survey_id, type, title, required, "order", created_at, updated_at)
       VALUES (11, 1, 'text', '说点什么', 0, 0, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
    ),
  ]);
}

function makeRequest(path: string, init: RequestInit = {}): Request {
  return new Request(`https://worker.test${path}`, init);
}

describe.skipIf(!sqliteD1Available)("survey anti-abuse guards (real schema)", () => {
  it("caps response starts per survey per address per day", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    await seedSurvey(db);
    const env = makeEnv(db);
    const ip = "203.0.113.7";

    // 40/天：先确认正常请求可以通过（模拟第 1 次）。
    const first = await handleSurveyApiRequest(
      makeRequest("/api/survey/1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-participant-key": "abuse-probe-a" },
        body: JSON.stringify({}),
      }),
      env,
      new URL("https://worker.test/api/survey/1/responses"),
    );
    expect(first?.status).toBe(201);

    // 把「同问卷日计数」直接灌到上限：下一次开卷必须 429。
    await seedRateLimit(db, "start_response_survey_daily", `${ip}:1`, 24 * 60 * 60, 40);
    const blocked = await handleSurveyApiRequest(
      makeRequest("/api/survey/1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-participant-key": "abuse-probe-b",
          "cf-connecting-ip": ip,
        },
        body: JSON.stringify({}),
      }),
      env,
      new URL("https://worker.test/api/survey/1/responses"),
    );
    expect(blocked?.status).toBe(429);
  });

  it("caps response starts per address across surveys per day", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    await seedSurvey(db);
    const env = makeEnv(db);
    const ip = "203.0.113.8";
    await seedRateLimit(db, "start_response_ip_daily", ip, 24 * 60 * 60, 100);

    const blocked = await handleSurveyApiRequest(
      makeRequest("/api/survey/1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-participant-key": "abuse-probe-c",
          "cf-connecting-ip": ip,
        },
        body: JSON.stringify({}),
      }),
      env,
      new URL("https://worker.test/api/survey/1/responses"),
    );
    expect(blocked?.status).toBe(429);
  });

  it("rejects a submission that arrives faster than a human can read", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    await seedSurvey(db);
    const env = makeEnv(db);
    const raw = db as unknown as { prepare: (sql: string) => { run: () => Promise<unknown> } };
    const now = new Date().toISOString();
    await raw
      .prepare(
        `INSERT INTO survey_responses (id, survey_id, participant_hash, status, started_at,
                                       current_question_id, version, created_at, updated_at)
         VALUES (42, 1, 'web_abuse-probe-d', 'in_progress', '${now}', 11, 1, '${now}', '${now}')`,
      )
      .run();
    await raw.prepare(`INSERT INTO answers (response_id, question_id, text_value, created_at, updated_at) VALUES (42, 11, '秒交', '2026-10-15T00:00:00.000Z', '2026-10-15T00:00:00.000Z')`).run();

    const submit = (path = "/api/survey/1/responses/42/submit") =>
      handleSurveyApiRequest(
        makeRequest(path, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-participant-key": "abuse-probe-d" },
          body: JSON.stringify({}),
        }),
        env,
        new URL(`https://worker.test${path}`),
      );

    // started_at = 刚刚 → 秒交被拦，且提示可重试。
    const tooFast = await submit();
    expect(tooFast?.status).toBe(400);
    const body = (await tooFast?.json()) as { code?: string };
    expect(body.code).toBe("submitted_too_fast");

    // 把开卷时间往前挪 5 分钟（模拟真人填完）→ 正常提交。
    const earlier = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    await raw.prepare(`UPDATE survey_responses SET started_at = '${earlier}' WHERE id = 42`).run();
    const ok = await submit();
    expect(ok?.status).toBe(200);
  });

  it("caps same-device completions of one survey per day", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    await seedSurvey(db);
    const env = makeEnv(db);
    const raw = db as unknown as { prepare: (sql: string) => { run: () => Promise<unknown> } };
    const started = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const completed = new Date(Date.now() - 60 * 1000).toISOString();
    // 同一指纹今天已完成 5 份（上限）。
    for (let index = 0; index < 5; index += 1) {
      await raw
        .prepare(
          `INSERT INTO survey_responses (id, survey_id, participant_hash, status, started_at, completed_at,
                                         device_fingerprint, current_question_id, version, created_at, updated_at)
           VALUES (${100 + index}, 1, 'web_farm-${index}', 'completed', '${started}', '${completed}',
                   'fp-same-device', 11, 1, '${started}', '${completed}')`,
        )
        .run();
    }
    await raw
      .prepare(
        `INSERT INTO survey_responses (id, survey_id, participant_hash, status, started_at,
                                       device_fingerprint, current_question_id, version, created_at, updated_at)
         VALUES (42, 1, 'web_abuse-probe-e', 'in_progress', '${started}', 'fp-same-device', 11, 1, '${started}', '${started}')`,
      )
      .run();
    await raw.prepare(`INSERT INTO answers (response_id, question_id, text_value, created_at, updated_at) VALUES (42, 11, '第六份', '2026-10-15T00:00:00.000Z', '2026-10-15T00:00:00.000Z')`).run();

    const response = await handleSurveyApiRequest(
      makeRequest("/api/survey/1/responses/42/submit", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-participant-key": "abuse-probe-e",
          "x-device-fingerprint": "fp-same-device",
        },
        body: JSON.stringify({}),
      }),
      env,
      new URL("https://worker.test/api/survey/1/responses/42/submit"),
    );
    expect(response?.status).toBe(429);
    const body = (await response?.json()) as { code?: string };
    expect(body.code).toBe("device_daily_cap");
  });

  it("caps public Telegram publishing per identity and per address", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    await seedSurvey(db);
    const env = makeEnv(db);
    const raw = db as unknown as { prepare: (sql: string) => { run: () => Promise<unknown> } };
    const started = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await raw
      .prepare(
        `INSERT INTO survey_responses (id, survey_id, participant_hash, status, started_at,
                                       current_question_id, version, created_at, updated_at)
         VALUES (42, 1, 'web_abuse-probe-f', 'in_progress', '${started}', 11, 1, '${started}', '${started}')`,
      )
      .run();
    await raw.prepare(`INSERT INTO answers (response_id, question_id, text_value, created_at, updated_at) VALUES (42, 11, '发布', '2026-10-15T00:00:00.000Z', '2026-10-15T00:00:00.000Z')`).run();

    const publish = (key: string) =>
      handleSurveyApiRequest(
        makeRequest("/api/survey/1/responses/42/submit", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-participant-key": key },
          body: JSON.stringify({ publishToTelegram: true }),
        }),
        env,
        new URL("https://worker.test/api/survey/1/responses/42/submit"),
      );

    // 身份闸门：该身份的日计数已达上限 → 429（此时还没有任何发布动作发生）。
    await seedRateLimit(db, "publish_telegram_identity_daily", "web_abuse-probe-f", 24 * 60 * 60, 2);
    const blockedByIdentity = await publish("abuse-probe-f");
    expect(blockedByIdentity?.status).toBe(429);
    expect(((await blockedByIdentity?.json()) as { code?: string }).code).toBe("publish_limit_reached");

    // 换一个身份（自己的答卷）但同一地址：地址闸门兜住。
    const ip = "203.0.113.9";
    await raw
      .prepare(
        `INSERT INTO survey_responses (id, survey_id, participant_hash, status, started_at,
                                       current_question_id, version, created_at, updated_at)
         VALUES (43, 1, 'web_abuse-probe-g', 'in_progress', '${started}', 11, 1, '${started}', '${started}')`,
      )
      .run();
    await raw
      .prepare(
        `INSERT INTO answers (response_id, question_id, text_value, created_at, updated_at)
         VALUES (43, 11, '换号发布', '2026-10-15T00:00:00.000Z', '2026-10-15T00:00:00.000Z')`,
      )
      .run();
    await seedRateLimit(db, "publish_telegram_ip_daily", ip, 24 * 60 * 60, 6);
    const blockedByIp = await handleSurveyApiRequest(
      makeRequest("/api/survey/1/responses/43/submit", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-participant-key": "abuse-probe-g",
          "cf-connecting-ip": ip,
        },
        body: JSON.stringify({ publishToTelegram: true }),
      }),
      env,
      new URL("https://worker.test/api/survey/1/responses/43/submit"),
    );
    expect(blockedByIp?.status).toBe(429);
  });

  it("keeps a normal submission working (no false positives)", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    await seedSurvey(db);
    const env = makeEnv(db);
    const raw = db as unknown as { prepare: (sql: string) => { run: () => Promise<unknown> } };
    const started = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    await raw
      .prepare(
        `INSERT INTO survey_responses (id, survey_id, participant_hash, status, started_at,
                                       current_question_id, version, created_at, updated_at)
         VALUES (42, 1, 'web_normalkey-1234', 'in_progress', '${started}', 11, 1, '${started}', '${started}')`,
      )
      .run();
    await raw.prepare(`INSERT INTO answers (response_id, question_id, text_value, created_at, updated_at) VALUES (42, 11, '正常填写', '2026-10-15T00:00:00.000Z', '2026-10-15T00:00:00.000Z')`).run();

    const response = await handleSurveyApiRequest(
      makeRequest("/api/survey/1/responses/42/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-participant-key": "normalkey-1234" },
        body: JSON.stringify({}),
      }),
      env,
      new URL("https://worker.test/api/survey/1/responses/42/submit"),
    );
    expect(response?.status).toBe(200);
    const body = (await response?.json()) as { completed?: boolean; reportUrl?: string };
    expect(body.completed).toBe(true);
    expect(body.reportUrl).toContain("/report/42?t=");
  });
});
