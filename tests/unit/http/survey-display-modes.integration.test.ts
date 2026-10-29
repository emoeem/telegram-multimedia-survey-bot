import { describe, expect, it, vi } from "vitest";

import { handleAdminApi } from "../../../src/http/admin-api";
import { handleSurveyApiRequest } from "../../../src/http/survey-api";
import {
  ADMIN_SESSION_COOKIE,
  createAdminSessionValue,
  resolveSessionSecret,
} from "../../../src/services/admin-session.service";
import type { Env } from "../../../src/index";
import { fullMigrationSchema } from "../../helpers/full-schema";
import { createSqliteD1, sqliteD1Available } from "../../helpers/sqlite-d1";

/**
 * 显示模式（settings_json.display）的真实 SQL 集成测试。
 *
 * 覆盖三条只有真库才验得出的链路：
 *  1. PATCH 同一请求里 theme 与 display 同时改，两者都要留下（共用一次
 *     settings 读写的回归护栏——各自读写的版本会互相覆盖）；
 *  2. 公开定义下发 display；
 *  3. 草稿的设备预览旁路：匿名 404 / 管理员会话 + ?preview=1 → 200 且
 *     `preview: true`，并且**不写共享缓存**（防草稿内容污染已发布缓存）。
 */
function makeEnv(db: D1Database, overrides: Partial<Env> = {}): Env {
  const cacheWrites: string[] = [];
  const env = {
    DB: db,
    BOT_TOKEN: "test-token",
    WEBHOOK_SECRET: "display-test-secret",
    ADMIN_IDS: "4242",
    MEDIA_KV: { put: async () => undefined, get: async () => null } as unknown as KVNamespace,
    CACHE: {
      put: async (key: string) => {
        cacheWrites.push(key);
      },
      get: async () => null,
    } as unknown as KVNamespace,
    EXPORT_QUEUE: { send: async () => undefined } as unknown as Queue,
    ...overrides,
  } as unknown as Env;
  return Object.assign(env, { __cacheWrites: cacheWrites });
}

function cacheWritesOf(env: Env): string[] {
  return (env as unknown as { __cacheWrites: string[] }).__cacheWrites;
}

/** 真实 HMAC 的 web_app initData（管理员身份，ADMIN_IDS 里是 4242）。 */
async function adminHeaders(): Promise<Record<string, string>> {
  const { createHmac } = await import("node:crypto");
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: "AAHdF6IQAAAAAN0XohDhrOrc",
    user: JSON.stringify({ id: 4242, first_name: "Admin" }),
  });
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update("test-token").digest();
  const hash = createHmac("sha256", secret).update(dataCheckString).digest("hex");
  params.set("hash", hash);
  return { "x-telegram-init-data": encodeURIComponent(params.toString()) };
}

/** 公开处理器对未知路径返回 null；测试只走定义端点，null 视为失败。 */
async function requestDefinition(env: Env, path: string, headers: Record<string, string> = {}): Promise<Response> {
  const response = await handleSurveyApiRequest(
    new Request(`https://worker.test${path}`, { headers }),
    env,
    new URL(`https://worker.test${path}`),
  );
  if (!response) throw new Error(`处理器未处理 ${path}`);
  return response;
}

/** 与 iframe 同源的浏览器会带上的 admin 会话 cookie。 */
async function adminCookie(env: Env): Promise<string> {
  const value = await createAdminSessionValue(resolveSessionSecret(env), 77, 0);
  return `${ADMIN_SESSION_COOKIE}=${value}`;
}

const describeIf = sqliteD1Available ? describe : describe.skip;

describeIf("显示模式：settings_json.display（真实 SQL）", () => {
  async function seed(db: D1Database, options: { status?: string; settings?: string | null } = {}) {
    const now = "2026-10-29T00:00:00Z";
    await db
      .prepare(
        "INSERT INTO users (id, telegram_user_id, first_name, system_role, created_at, updated_at) VALUES (77, 4242, 'Admin', 'admin', ?, ?)",
      )
      .bind(now, now)
      .run();
    await db
      .prepare(
        `INSERT INTO surveys (id, owner_id, title, status, anonymous, allow_multiple_responses,
           max_responses_per_user, version, settings_json, created_at, updated_at)
         VALUES (1, 77, '显示模式测试', ?, 0, 0, 1, 1, ?, ?, ?)`,
      )
      .bind(options.status ?? "draft", options.settings ?? null, now, now)
      .run();
    await db
      .prepare(
        `INSERT INTO survey_questions (id, survey_id, type, title, required, "order", created_at, updated_at)
         VALUES (10, 1, 'single_choice', '第一题', 1, 1, ?, ?)`,
      )
      .bind(now, now)
      .run();
    await db
      .prepare(
        "INSERT INTO question_options (id, question_id, label, value, \"order\", created_at, updated_at) VALUES (100, 10, 'A', 'a', 0, ?, ?)",
      )
      .bind(now, now)
      .run();
  }

  async function readSettings(db: D1Database): Promise<Record<string, unknown>> {
    const row = await db
      .prepare("SELECT settings_json FROM surveys WHERE id = 1")
      .first<{ settings_json: string | null }>();
    return JSON.parse(row?.settings_json ?? "{}") as Record<string, unknown>;
  }

  it("PATCH 同一请求改 theme 与 display：两者都留下（共用一次 settings 读写）", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    await seed(db);
    const env = makeEnv(db);
    const response = await handleAdminApi(
      new Request("https://worker.test/api/admin/surveys/1", {
        method: "PATCH",
        headers: { ...(await adminHeaders()), "content-type": "application/json" },
        body: JSON.stringify({ theme: { preset: "dark" }, display: "immersive" }),
      }),
      env,
    );
    expect(response.status).toBe(200);
    const settings = await readSettings(db);
    expect(settings.display).toBe("immersive");
    expect(settings.theme).toMatchObject({ preset: "dark" });
  });

  it("display=auto 删键（回落默认），脏值 400", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    await seed(db, { settings: JSON.stringify({ display: "landscape" }) });
    const env = makeEnv(db);

    const bad = await handleAdminApi(
      new Request("https://worker.test/api/admin/surveys/1", {
        method: "PATCH",
        headers: { ...(await adminHeaders()), "content-type": "application/json" },
        body: JSON.stringify({ display: "fullscreen" }),
      }),
      env,
    );
    expect(bad.status).toBe(400);

    const reset = await handleAdminApi(
      new Request("https://worker.test/api/admin/surveys/1", {
        method: "PATCH",
        headers: { ...(await adminHeaders()), "content-type": "application/json" },
        body: JSON.stringify({ display: "auto" }),
      }),
      env,
    );
    expect(reset.status).toBe(200);
    expect(await readSettings(db)).toEqual({});
  });

  it("公开定义下发 display；缺省为 auto", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    await seed(db, { status: "published", settings: JSON.stringify({ display: "landscape" }) });
    const env = makeEnv(db);
    const response = await requestDefinition(env, "/api/survey/1");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { display?: string; preview?: boolean };
    expect(body.display).toBe("landscape");
    expect(body.preview).toBeUndefined();
  });

  it("草稿：匿名 404；管理员会话 + ?preview=1 → 200 且不写共享缓存", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    await seed(db, { settings: JSON.stringify({ display: "immersive" }) });
    const env = makeEnv(db);

    const anonymous = await requestDefinition(env, "/api/survey/1?preview=1");
    expect(anonymous.status).toBe(404);

    // 只有 preview 参数、没有管理员会话时同样是 404（旁路不是公开开关）。
    const cookie = await adminCookie(env);
    const admin = await requestDefinition(env, "/api/survey/1?preview=1", { cookie });
    expect(admin.status).toBe(200);
    const body = (await admin.json()) as { preview?: boolean; display?: string; questions?: unknown[] };
    expect(body.preview).toBe(true);
    expect(body.display).toBe("immersive");
    expect(Array.isArray(body.questions)).toBe(true);
    // 草稿内容不得进入共享缓存。
    expect(cacheWritesOf(env)).toEqual([]);
  });

  it("已发布问卷的普通访问仍走缓存（skipCache 只作用于预览）", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    await seed(db, { status: "published" });
    const env = makeEnv(db);
    const response = await requestDefinition(env, "/api/survey/1");
    expect(response.status).toBe(200);
    expect(cacheWritesOf(env).length).toBeGreaterThan(0);
  });
});

// 说明：`vi` 导入保留给未来需要 mock 的用例；当前全部走真实 SQL，不 mock 处理器。
void vi;
