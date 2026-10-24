import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../../../src/index";
import { handleSubmitApiRequest, isSubmitApiPath } from "../../../src/http/submit-api";
import { issueFormToken, verifyFormToken } from "../../../src/services/submit/captcha";
import { mergeWebSubmitForm, submitFormSchema, validateWebSubmitSteps } from "../../../src/services/submit/form-config";
import { createSqliteD1, sqliteD1Available } from "../../helpers/sqlite-d1";

/**
 * 免登录投稿的本地 /api/submit/* —— 从独立 submission-bot Worker 并轨而来。
 *
 * 要钉住的契约(前端 SubmitScreen / SubmitInboxScreen 零改动,全靠这里):
 *  - GET /form 的 schema 形状(inboxUrl 已指向投稿中心页签);
 *  - 验证题:答案参与 HMAC 签名,错答案/过期/太快都 403 且文案可辨;
 *  - POST /submit 五道闸:蜜罐、令牌、字段校验(必填/选项/上限/show_if)、
 *    IP 限流、全天上限;成功后落 web_submissions;
 *  - inbox 按 viewer 隔离;reply/message 是作者本人的投稿才可写。
 * 验证题与配置合并是纯函数,直接单测;HTTP 层走真库。
 */

const SCHEMA = `
CREATE TABLE system_settings (key TEXT PRIMARY KEY, value TEXT, updated_by INTEGER, updated_at TEXT);
CREATE TABLE web_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  viewer_token TEXT, email TEXT, nickname TEXT, ip TEXT,
  template_id TEXT NOT NULL DEFAULT 'default',
  data TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  flags TEXT, content_hash TEXT, publish_chat_id TEXT, publish_message_id INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, published_at INTEGER
);
CREATE TABLE web_submission_threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL, direction TEXT NOT NULL, text TEXT NOT NULL,
  seen_by_author INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE web_submission_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL, telegram_chat_id TEXT, telegram_message_id INTEGER,
  author_name TEXT, text TEXT, kind TEXT NOT NULL DEFAULT 'user', parent_author TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE web_rate_limits (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL);
CREATE TABLE media_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_scope TEXT NOT NULL, media_type TEXT NOT NULL,
  telegram_file_id TEXT, telegram_file_unique_id TEXT, url TEXT,
  storage_kind TEXT, storage_key TEXT, expires_at TEXT,
  mime_type TEXT, file_name TEXT, file_size INTEGER,
  width INTEGER, height INTEGER, duration INTEGER, r2_key TEXT,
  created_at TEXT, updated_at TEXT
);
`;

const SECRET = "webhook-secret";

function makeEnv(): Env {
  const db = createSqliteD1(SCHEMA);
  return {
    DB: db,
    BOT_TOKEN: "test-token",
    WEBHOOK_SECRET: SECRET,
    MEDIA_KV: {
      put: vi.fn(async () => {}),
      get: vi.fn(async () => null),
    } as unknown as KVNamespace,
  } as unknown as Env;
}

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`https://site.example${path}`, init);
}

const describeIf = sqliteD1Available ? describe : describe.skip;

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// 纯函数:验证题令牌
// ---------------------------------------------------------------------------

describe("验证题令牌(无状态 HMAC)", () => {
  it("答案参与签名:答案对 → 过,答案错 → wrong_answer", async () => {
    const issued = await issueFormToken(SECRET, { captcha: true, now: 1000 });
    expect(issued.question).toMatch(/^\d+ [+\×] \d+$/);
    // 拿不到正确答案,但可以证明「签名确实绑定了某个答案」:错答案必拒。
    const verdict = await verifyFormToken(SECRET, issued.token, "99999", { captcha: true, now: 1000 + 60 });
    expect(verdict).toEqual({ ok: false, reason: "wrong_answer" });
  });

  it("captcha=false 时答案不参与签名,任意答案都过", async () => {
    const issued = await issueFormToken(SECRET, { captcha: false, now: 1000 });
    const verdict = await verifyFormToken(SECRET, issued.token, "whatever", { captcha: false, now: 1000 + 60 });
    expect(verdict).toEqual({ ok: true });
  });

  it("过期拒绝;填表太快拒绝", async () => {
    const issued = await issueFormToken(SECRET, { captcha: false, now: 1000 });
    const expired = await verifyFormToken(SECRET, issued.token, "", { captcha: false, now: 1000 + 1801 });
    expect(expired).toEqual({ ok: false, reason: "expired" });
    const tooFast = await verifyFormToken(SECRET, issued.token, "", {
      captcha: false,
      now: 1000 + 1,
      minFillSeconds: 3,
    });
    expect(tooFast).toEqual({ ok: false, reason: "too_fast" });
  });

  it("结构不对的令牌按过期处理,不抛异常", async () => {
    const verdict = await verifyFormToken(SECRET, "garbage", "", { captcha: false });
    expect(verdict).toEqual({ ok: false, reason: "expired" });
  });
});

// ---------------------------------------------------------------------------
// 纯函数:配置合并与表单 schema
// ---------------------------------------------------------------------------

describe("表单配置合并", () => {
  it("空/损坏 JSON 回默认,不抛", () => {
    expect(mergeWebSubmitForm(null).config.enabled).toBe(true);
    expect(mergeWebSubmitForm("{broken").problems).toHaveLength(1);
  });

  it("合法覆盖生效,非法 steps 整体回默认", () => {
    const merged = mergeWebSubmitForm(JSON.stringify({ captcha: false, maxFiles: 3 }));
    expect(merged.config.captcha).toBe(false);
    expect(merged.config.maxFiles).toBe(3);
    expect(merged.config.steps).toHaveLength(7);

    const bad = mergeWebSubmitForm(JSON.stringify({ steps: [{ id: "x!" }] }));
    expect(bad.problems.length).toBeGreaterThan(0);
    expect(bad.config.steps).toHaveLength(7);
  });

  it("schema 的 inboxUrl 指向投稿中心收件箱页签(并轨后的地址)", () => {
    const schema = submitFormSchema(mergeWebSubmitForm(null).config);
    expect(schema.inboxUrl).toBe("/submissions?tab=inbox");
    expect(schema.steps[0]).toMatchObject({ id: "category", type: "choice" });
  });

  it("steps 校验:choice 必须有选项,show_if 必须指向存在的步骤", () => {
    expect(validateWebSubmitSteps([{ id: "a", type: "choice", prompt: "p" }]).length).toBeGreaterThan(0);
    expect(
      validateWebSubmitSteps([{ id: "a", type: "text", prompt: "p", show_if: { step: "ghost" } }]).length,
    ).toBeGreaterThan(0);
    expect(validateWebSubmitSteps([{ id: "a", type: "text", prompt: "p" }])).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// HTTP 层(真库)
// ---------------------------------------------------------------------------

describeIf("/api/submit HTTP 契约", () => {
  it("路径归属:/api/submit 与子路径归本模块,/api/submissions 不归", () => {
    expect(isSubmitApiPath("/api/submit")).toBe(true);
    expect(isSubmitApiPath("/api/submit/form")).toBe(true);
    expect(isSubmitApiPath("/api/submissions")).toBe(false);
  });

  it("GET /form 返回 schema;GET /captcha 返回带题面的令牌", async () => {
    const env = makeEnv();
    const form = await handleSubmitApiRequest(
      req("/api/submit/form"),
      env,
      new URL("https://site.example/api/submit/form"),
    );
    const formBody = (await form!.json()) as { ok: boolean; form: { steps: unknown[]; captchaUrl: string } };
    expect(formBody.ok).toBe(true);
    expect(formBody.form.steps.length).toBeGreaterThan(0);

    const captcha = await handleSubmitApiRequest(
      req("/api/submit/captcha"),
      env,
      new URL("https://site.example/api/submit/captcha"),
    );
    const captchaBody = (await captcha!.json()) as { token: string; question: string | null };
    expect(captchaBody.token.split(".")).toHaveLength(3);
    expect(captchaBody.question).toMatch(/^\d+/);
  });

  it("POST /submit 全链路:合法表单落库 pending,viewer/email/nickname 入列", async () => {
    const env = makeEnv();
    // 蜜罐留空;令牌按「无验证题答案」签不了(captcha 开着)——直接关掉 captcha
    // 让令牌与答案解耦,这条用例只测字段链路。
    await env.DB.prepare("INSERT INTO system_settings (key, value) VALUES ('web_submit_form', ?)")
      .bind(JSON.stringify({ captcha: false, minFillSeconds: 0 }))
      .run();
    const issued = await issueFormToken(SECRET, { captcha: false, now: Math.floor(Date.now() / 1000) - 10 });

    const form = new FormData();
    form.set("step:category", "文字分享");
    form.set("step:title", "一个标题");
    form.set("step:body", "这是正文");
    form.set("step:author", "匿名投稿");
    form.set("nickname", "小明");
    form.set("email", "x@y.zz");
    form.set("viewer", "abcdef0123456789");
    form.set("token", issued.token);
    const response = await handleSubmitApiRequest(
      req("/api/submit", { method: "POST", body: form }),
      env,
      new URL("https://site.example/api/submit"),
    );
    const body = (await response!.json()) as { ok: boolean; id: number; status: string };
    expect(response!.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.status).toBe("pending");
    const row = await env.DB.prepare("SELECT viewer_token, email, nickname, data FROM web_submissions WHERE id = ?")
      .bind(body.id)
      .first<{ viewer_token: string; email: string; nickname: string; data: string }>();
    expect(row?.viewer_token).toBe("abcdef0123456789");
    expect(row?.email).toBe("x@y.zz");
    expect(JSON.parse(row!.data).body).toBe("这是正文");
  });

  it("蜜罐被填 → 400;字段缺必填 → 422 且错误带字段名", async () => {
    const env = makeEnv();
    await env.DB.prepare("INSERT INTO system_settings (key, value) VALUES ('web_submit_form', ?)")
      .bind(JSON.stringify({ captcha: false, minFillSeconds: 0 }))
      .run();
    const issued = await issueFormToken(SECRET, { captcha: false, now: Math.floor(Date.now() / 1000) - 10 });

    const honeypot = new FormData();
    honeypot.set("website", "http://spam.example");
    honeypot.set("token", issued.token);
    const trapped = await handleSubmitApiRequest(
      req("/api/submit", { method: "POST", body: honeypot }),
      env,
      new URL("https://site.example/api/submit"),
    );
    expect(trapped!.status).toBe(400);

    const missing = new FormData();
    missing.set("step:category", "文字分享");
    missing.set("step:author", "匿名投稿");
    missing.set("token", issued.token);
    const invalid = await handleSubmitApiRequest(
      req("/api/submit", { method: "POST", body: missing }),
      env,
      new URL("https://site.example/api/submit"),
    );
    expect(invalid!.status).toBe(422);
    const errorBody = (await invalid!.json()) as { errors: Record<string, string> };
    expect(errorBody.errors.body).toContain("正文");
  });

  it("验证题开着时,无令牌 → 403", async () => {
    const env = makeEnv();
    const form = new FormData();
    form.set("step:category", "文字分享");
    form.set("step:body", "x");
    form.set("step:author", "匿名投稿");
    const response = await handleSubmitApiRequest(
      req("/api/submit", { method: "POST", body: form }),
      env,
      new URL("https://site.example/api/submit"),
    );
    expect(response!.status).toBe(403);
  });

  it("inbox 按 viewer 隔离:别人的投稿不可见,自己的带线程与未读数", async () => {
    const env = makeEnv();
    const mine = await env.DB.prepare(
      "INSERT INTO web_submissions (viewer_token, data, status, created_at, updated_at) VALUES (?, ?, 'pending', 100, 100)",
    )
      .bind("aaaabbbbccccdddd", JSON.stringify({ body: "我的投稿" }))
      .run();
    const mineId = Number(mine.meta?.last_row_id ?? 0);
    await env.DB.prepare(
      "INSERT INTO web_submissions (viewer_token, data, status, created_at, updated_at) VALUES (?, ?, 'pending', 100, 100)",
    )
      .bind("eeeeffffgggghhhh", JSON.stringify({ body: "别人的投稿" }))
      .run();
    await env.DB.prepare(
      "INSERT INTO web_submission_threads (submission_id, direction, text, seen_by_author, created_at) VALUES (?, 'to_author', '请改一改', 0, 110)",
    )
      .bind(mineId)
      .run();

    const response = await handleSubmitApiRequest(
      req("/api/submit/inbox?t=aaaabbbbccccdddd"),
      env,
      new URL("https://site.example/api/submit/inbox?t=aaaabbbbccccdddd"),
    );
    const body = (await response!.json()) as {
      items: Array<{ id: number; title: string; unreadThread: number; thread: Array<{ text: string }> }>;
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.id).toBe(mineId);
    expect(body.items[0]!.unreadThread).toBe(1);
    expect(body.items[0]!.thread[0]!.text).toBe("请改一改");
    // 读过后未读清零
    const again = await handleSubmitApiRequest(
      req("/api/submit/inbox?t=aaaabbbbccccdddd"),
      env,
      new URL("https://site.example/api/submit/inbox?t=aaaabbbbccccdddd"),
    );
    const againBody = (await again!.json()) as { items: Array<{ unreadThread: number }> };
    expect(againBody.items[0]!.unreadThread).toBe(0);
  });

  it("message 只能写进自己的投稿;匿名留言入库", async () => {
    const env = makeEnv();
    const inserted = await env.DB.prepare(
      "INSERT INTO web_submissions (viewer_token, data, status, created_at, updated_at) VALUES (?, '{}', 'pending', 100, 100)",
    )
      .bind("aaaabbbbccccdddd")
      .run();
    const id = Number(inserted.meta?.last_row_id ?? 0);

    const ok = await handleSubmitApiRequest(
      req("/api/submit/message", {
        method: "POST",
        body: JSON.stringify({ viewer: "aaaabbbbccccdddd", submissionId: id, text: "想问下进度" }),
      }),
      env,
      new URL("https://site.example/api/submit/message"),
    );
    expect(ok!.status).toBe(200);

    const foreign = await handleSubmitApiRequest(
      req("/api/submit/message", {
        method: "POST",
        body: JSON.stringify({ viewer: "0000111122223333", submissionId: id, text: "冒充" }),
      }),
      env,
      new URL("https://site.example/api/submit/message"),
    );
    expect(foreign!.status).toBe(404);
    const row = await env.DB.prepare("SELECT direction, text FROM web_submission_threads WHERE submission_id = ?")
      .bind(id)
      .first<{ direction: string; text: string }>();
    expect(row?.direction).toBe("to_admin");
    expect(row?.text).toBe("想问下进度");
  });
});
