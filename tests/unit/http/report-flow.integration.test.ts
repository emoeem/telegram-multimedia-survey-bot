import { describe, expect, it } from "vitest";

import { handleReportRequest } from "../../../src/http/report-api";
import { handleMeApiRequest } from "../../../src/http/me-api";
import { createReportAccessToken, verifyReportAccessToken } from "../../../src/services/report-access-token.service";
import type { Env } from "../../../src/index";
import { createSqliteD1, sqliteD1Available } from "../../helpers/sqlite-d1";
import { fullMigrationSchema } from "../../helpers/full-schema";

/**
 * 参与者打开自己报告的端到端回归（真实 schema + 真实处理器）。
 *
 * 之前的 report-api 测试全部 mock 掉了仓库函数，因此「提交之后能不能真的打开
 * 报告」这条链路没有测试覆盖：schema 里的列名、result profile 的构建、模板解析
 * 都可能有真实 SQLite 才会暴露的问题。这里用 db/migrations 全量迁移建库，插一份
 * 完成的答卷，然后用 createReportAccessToken 铸的 token 请求 /report/:id ——
 * 与生产同一条代码路径（只少了浏览器渲染那一段）。
 */
function makeEnv(db: D1Database): Env {
  return {
    DB: db,
    BOT_TOKEN: "test-token",
    WEBHOOK_SECRET: "integration-secret",
    MEDIA_KV: {
      put: async () => undefined,
      get: async () => null,
    } as unknown as KVNamespace,
  } as unknown as Env;
}

describe.skipIf(!sqliteD1Available)("participant report access (real schema)", () => {
  function seed(db: D1Database): void {
    // 一份完成的答卷：两道题（单选 + 文本），答案各一条。
    const sql = `
      INSERT INTO users (id, telegram_user_id, username, first_name, last_name, language_code, system_role, created_at, updated_at)
        VALUES (1, 900001, 'tester', '测试', NULL, 'zh', 'participant',
                '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
      INSERT INTO surveys (id, owner_id, title, description, status, anonymous, allow_multiple_responses,
                           max_responses_per_user, version, created_at, updated_at, published_at)
        VALUES (1, 1, '集成测试问卷', NULL, 'published', 0, 0, 1, 3,
                '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
      INSERT INTO survey_questions (id, survey_id, type, title, required, "order", created_at, updated_at)
        VALUES (11, 1, 'single', '你选哪个', 1, 0, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'),
               (12, 1, 'text', '说点什么', 0, 1, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
      INSERT INTO question_options (id, question_id, label, value, "order", created_at, updated_at)
        VALUES (101, 11, '选项甲', '选项甲', 0, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'),
               (102, 11, '选项乙', '选项乙', 1, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
      INSERT INTO survey_responses (id, survey_id, user_id, participant_hash, status, started_at, completed_at,
                                    submitted_at, current_question_id, version, created_at, updated_at)
        VALUES (42, 1, NULL, 'web_integration-probe', 'completed', '2026-10-01T00:00:00.000Z',
                '2026-10-01T00:05:00.000Z', '2026-10-01T00:05:00.000Z', 12, 3,
                '2026-10-01T00:00:00.000Z', '2026-10-01T00:05:00.000Z');
      INSERT INTO answers (response_id, question_id, json_value, created_at, updated_at)
        VALUES (42, 11, '[101]', '2026-10-01T00:02:00.000Z', '2026-10-01T00:02:00.000Z');
      INSERT INTO answers (response_id, question_id, text_value, created_at, updated_at)
        VALUES (42, 12, '这是测试回答', '2026-10-01T00:03:00.000Z', '2026-10-01T00:03:00.000Z');
    `;
    // node:sqlite 没有 exec 之外的多语句接口；helper 暴露的是 D1 接口，这里用
    // 一条 bootstrap 语句走同一连接不方便，改为逐条执行。
    const statements = sql
      .split(";")
      .map((chunk) => chunk.trim())
      .filter(Boolean);
    const raw = (db as unknown as { prepare: (sql: string) => { run: () => Promise<unknown> } }).prepare;
    for (const chunk of statements) raw.call(db, chunk).run();
  }

  it("opens a completed response's report with the token returned at submit time", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    seed(db);
    const env = makeEnv(db);
    const token = await createReportAccessToken(env.WEBHOOK_SECRET, 42);
    expect(await verifyReportAccessToken(env.WEBHOOK_SECRET, 42, token)).toBe(true);

    const url = new URL(`https://worker.test/report/42?t=${token}`);
    const response = await handleReportRequest(new Request(url), env, url);

    expect(response?.status).toBe(200);
    const html = await response?.text();
    expect(response?.headers.get("Content-Type")).toContain("text/html");
    expect(html).toContain("集成测试问卷");
    expect(html).toContain("这是测试回答");
  });

  it("still rejects a wrong token against the real response row", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    seed(db);
    const url = new URL("https://worker.test/report/42?t=1700000000.deadbeef");
    const response = await handleReportRequest(new Request(url), makeEnv(db), url);
    expect(response?.status).toBe(403);
  });

  it("reports a missing response instead of leaking one", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    seed(db);
    const env = makeEnv(db);
    const token = await createReportAccessToken(env.WEBHOOK_SECRET, 999);
    const url = new URL(`https://worker.test/report/999?t=${token}`);
    const response = await handleReportRequest(new Request(url), env, url);
    expect(response?.status).toBe(404);
  });

  it("lists completed reports for the caller's own participant key only", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    seed(db);
    const env = makeEnv(db);

    const mine = await handleMeApiRequest(
      new Request("https://worker.test/api/me/reports", {
        headers: { "x-participant-key": "integration-probe" },
      }),
      env,
      new URL("https://worker.test/api/me/reports"),
    );
    expect(mine?.status).toBe(200);
    const body = (await mine?.json()) as {
      reports: Array<{ responseId: number; surveyId: number; title: string; reportUrl: string; pdfUrl: string }>;
    };
    expect(body.reports).toHaveLength(1);
    expect(body.reports[0]?.responseId).toBe(42);
    expect(body.reports[0]?.title).toBe("集成测试问卷");

    // 返回的 token 必须能直接打开报告（用户点进去就是能看）。
    const reportUrl = new URL(body.reports[0]!.reportUrl, "https://worker.test");
    const report = await handleReportRequest(new Request(reportUrl), env, reportUrl);
    expect(report?.status).toBe(200);
    expect(await report?.text()).toContain("集成测试问卷");

    // 别人的 key 看不到这条答卷。
    const other = await handleMeApiRequest(
      new Request("https://worker.test/api/me/reports", {
        headers: { "x-participant-key": "someone-else-key" },
      }),
      env,
      new URL("https://worker.test/api/me/reports"),
    );
    const otherBody = (await other?.json()) as { reports: unknown[] };
    expect(otherBody.reports).toHaveLength(0);

    // 没有身份标识直接 401，不泄露任何东西。
    const anonymous = await handleMeApiRequest(
      new Request("https://worker.test/api/me/reports"),
      env,
      new URL("https://worker.test/api/me/reports"),
    );
    expect(anonymous?.status).toBe(401);
  });

  it("serves the report PDF from the archive cache without launching a browser", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    seed(db);
    const env = makeEnv(db);
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF
    env.MEDIA_KV = {
      put: async () => undefined,
      get: async () => pdfBytes.buffer as ArrayBuffer,
    } as unknown as KVNamespace;
    const token = await createReportAccessToken(env.WEBHOOK_SECRET, 42);

    const url = new URL(`https://worker.test/report/42.pdf?t=${token}`);
    const response = await handleReportRequest(new Request(url), env, url);

    expect(response?.status).toBe(200);
    expect(response?.headers.get("Content-Type")).toBe("application/pdf");
    expect(response?.headers.get("Content-Disposition")).toContain('attachment; filename="report-42.pdf"');
    expect(new Uint8Array(await response!.arrayBuffer())).toEqual(pdfBytes);
  });

  it("falls back to the HTML report when no PDF is cached and no browser is bound", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    seed(db);
    const env = makeEnv(db); // MEDIA_KV.get → null；无 BROWSER 绑定
    const token = await createReportAccessToken(env.WEBHOOK_SECRET, 42);

    const url = new URL(`https://worker.test/report/42.pdf?t=${token}`);
    const response = await handleReportRequest(new Request(url), env, url);

    expect(response?.status).toBe(302);
    const location = new URL(response!.headers.get("Location") ?? "");
    expect(location.pathname).toBe("/report/42");
    expect(location.searchParams.get("t")).toBe(token);
  });

  it("injects the download action into the web report only", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    seed(db);
    const env = makeEnv(db);
    const token = await createReportAccessToken(env.WEBHOOK_SECRET, 42);

    const url = new URL(`https://worker.test/report/42?t=${token}`);
    const response = await handleReportRequest(new Request(url), env, url);
    const html = (await response?.text()) ?? "";
    expect(html).toContain(`/report/42.pdf?t=${encodeURIComponent(token)}`);
    expect(html).toContain("下载 PDF");
    // 打印样式里隐藏：PDF/归档等非交互场景不会带上这个控件。
    expect(html).toContain("@media print{.report-download{display:none !important}}");
  });

  it("caps report PDF downloads per identity per day", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    seed(db);
    const env = makeEnv(db);
    env.MEDIA_KV = {
      put: async () => undefined,
      get: async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer as ArrayBuffer,
    } as unknown as KVNamespace;
    const token = await createReportAccessToken(env.WEBHOOK_SECRET, 42);
    const url = new URL(`https://worker.test/report/42.pdf?t=${token}`);
    const download = () =>
      handleReportRequest(new Request(url, { headers: { "x-participant-key": "integration-probe" } }), env, url);

    // 每日 3 次：前三次放行（哪怕命中缓存也算数）。
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const response = await download();
      expect(response?.status, `attempt ${attempt}`).toBe(200);
    }
    const blocked = await download();
    expect(blocked?.status).toBe(429);
    expect(blocked?.headers.get("Content-Type")).toContain("text/html");
    expect(blocked?.headers.get("Retry-After")).toBeTruthy();
    const html = (await blocked?.text()) ?? "";
    expect(html).toContain("今日的 PDF 下载次数已用完");
    // 页面同时给出「在线查看」的去处，用户不会卡死。
    expect(html).toContain(`/report/42?t=`);
    // 被拒绝时绝不返回 PDF 字节。
    expect(html).not.toContain("%PDF");

    // 另一个身份不受影响（各自计数、不互相连坐）。
    const otherUrl = new URL(`https://worker.test/report/42.pdf?t=${token}`);
    const other = await handleReportRequest(
      new Request(otherUrl, { headers: { "x-participant-key": "another-participant" } }),
      env,
      otherUrl,
    );
    expect(other?.status).toBe(200);
  });

  it("caps report PDF downloads per IP as a backstop against rotated keys", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    seed(db);
    const env = makeEnv(db);
    env.MEDIA_KV = {
      put: async () => undefined,
      get: async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer as ArrayBuffer,
    } as unknown as KVNamespace;
    const token = await createReportAccessToken(env.WEBHOOK_SECRET, 42);
    const url = new URL(`https://worker.test/report/42.pdf?t=${token}`);

    // Cloudflare 的真实请求一定带 cf-connecting-ip：没有它就没有"按地址"这一维
    // （见 client-identity.service 的 rateLimitIpSubject，避免所有人共用一个桶）。
    const withAddress = (key: string) =>
      new Request(url, { headers: { "x-participant-key": key, "cf-connecting-ip": "203.0.113.7" } });

    // 12 次以内（每 3 次换一个 key 轮换凭据）放行，第 13 次被 IP 闸门拦下。
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      const response = await handleReportRequest(withAddress(`rotating-key-${Math.ceil(attempt / 3)}`), env, url);
      expect(response?.status, `attempt ${attempt}`).toBe(200);
    }
    const blocked = await handleReportRequest(withAddress("rotating-key-99"), env, url);
    expect(blocked?.status).toBe(429);
  });

  it("没有地址时按地址的闸门被跳过，而不是把所有访客并进同一个桶", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    seed(db);
    const env = makeEnv(db);
    env.MEDIA_KV = {
      put: async () => undefined,
      get: async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer as ArrayBuffer,
    } as unknown as KVNamespace;
    const token = await createReportAccessToken(env.WEBHOOK_SECRET, 42);
    const url = new URL(`https://worker.test/report/42.pdf?t=${token}`);

    // 40 次、每次换一个身份、不带任何地址头：按身份限额（20）照样生效，
    // 但"按地址"的那一维不该因为 key 全是 "unknown" 就把后来者一起判死。
    let blocked = 0;
    for (let attempt = 1; attempt <= 40; attempt += 1) {
      const response = await handleReportRequest(
        new Request(url, { headers: { "x-participant-key": `no-address-${attempt}` } }),
        env,
        url,
      );
      if (response?.status === 429) blocked += 1;
    }
    // 每个身份各 1 次，都不该被同一个"地址桶"连坐。
    expect(blocked).toBe(0);
  });
});
