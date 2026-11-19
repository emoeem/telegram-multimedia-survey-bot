import { beforeEach, describe, expect, it } from "vitest";

import { route } from "../../../src/http/router";
import { handleAdminApi } from "../../../src/http/admin-api";
import type { Env } from "../../../src/index";
import { fullMigrationSchema } from "../../helpers/full-schema";
import { createSqliteD1, sqliteD1Available } from "../../helpers/sqlite-d1";

/**
 * web_apps（0104，P0 批次 M2）的 API 层集成验证，真实 SQLite 全迁移链：
 *
 * 公开只读 GET /api/web-apps（经完整 router 驱动，含挂载与 guard 兜底）：
 * - 只返回启用项且按 sort_order 升序；
 * - 投影字段 name/description/url/iconUrl/category/openMode/allowedDomains；
 * - 非 GET 显式 405（写方法在此不可达，管理端写走 /api/admin/web-apps*）。
 *
 * 管理端 CRUD（/api/admin/web-apps*，dev-auth 模拟管理员身份，先例
 * admin-plaza.test.ts）：非管理员 403；create/update/reorder/delete 落库且
 * audit_logs 出现 web_app.* 记录；非 https URL 与非法 open_mode 被拒（400）。
 */
const DEV_AUTH_SECRET = "test-dev-auth-secret";

function createFakeKV() {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => void store.set(key, value),
  } as unknown as KVNamespace;
}

function makeEnv(db: D1Database): Env {
  return {
    DB: db,
    CACHE: createFakeKV(),
    ADMIN_IDS: "111",
    ENVIRONMENT: "development",
    ADMIN_DEV_AUTH_SECRET: DEV_AUTH_SECRET,
    BOT_TOKEN: "t",
    WEBHOOK_SECRET: "s",
  } as unknown as Env;
}

function publicRequest(path: string, method = "GET"): Request {
  return new Request(`https://bot.test${path}`, { method });
}

function adminRequest(path: string, options: { method?: string; userId?: string; body?: unknown } = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.userId !== undefined) {
    headers["x-telegram-user-id"] = options.userId;
    headers["x-dev-auth-secret"] = DEV_AUTH_SECRET;
  }
  return new Request(`https://bot.test${path}`, {
    method: options.method ?? "GET",
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

interface WebAppRow {
  id: number;
  name: string;
  description: string | null;
  url: string;
  iconUrl: string | null;
  category: string | null;
  openMode: string;
  allowedDomains: string[];
}

async function seedUser(db: D1Database, telegramUserId: number, systemRole: string): Promise<void> {
  await db
    .prepare(
      "INSERT INTO users (telegram_user_id, username, first_name, system_role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(
      telegramUserId,
      `u${telegramUserId}`,
      "测试",
      systemRole,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    )
    .run();
}

async function auditActions(db: D1Database): Promise<string[]> {
  const { results } = await db.prepare("SELECT action FROM audit_logs ORDER BY id ASC").all();
  return (results ?? []).map((row) => String((row as Record<string, unknown>).action));
}

describe.skipIf(!sqliteD1Available)("web-apps API (0104, public read + admin CRUD)", () => {
  let db: D1Database;
  let env: Env;

  beforeEach(async () => {
    db = createSqliteD1(fullMigrationSchema());
    env = makeEnv(db);
    await seedUser(db, 111, "admin");
    await seedUser(db, 7, "participant");
  });

  it("公开 GET /api/web-apps：启用项有序返回，禁用项不出现；POST 被显式 405", async () => {
    const created = await handleAdminApi(
      adminRequest("/api/admin/web-apps", {
        method: "POST",
        userId: "111",
        body: { name: "乙", url: "https://b.example.com" },
      }),
      env,
    );
    expect(created.status).toBe(200);
    await handleAdminApi(
      adminRequest("/api/admin/web-apps", {
        method: "POST",
        userId: "111",
        body: { name: "甲", url: "https://a.example.com", enabled: false },
      }),
      env,
    );

    const response = (await route(publicRequest("/api/web-apps"), env)) as Response;
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: WebAppRow[] };
    // 只有启用项；append 语义下新建顺序即 sort_order 顺序。
    expect(body.items.map((app) => app.name)).toEqual(["乙"]);
    const item = body.items[0]!;
    // normalizeHttpsUrl 经 URL.toString() 规范化：根路径补尾斜杠是标准行为。
    expect(item.url).toBe("https://b.example.com/");
    expect(item.openMode).toBe("browser");
    expect(item.allowedDomains).toEqual([]);
    expect(item.category).toBeNull();
    expect(item.iconUrl).toBeNull();
    // 投影不含管理端字段（enabled/sortOrder/时间戳不出公开面）。
    expect(Object.keys(item).sort()).toEqual(
      ["allowedDomains", "category", "description", "iconUrl", "id", "name", "openMode", "url"].sort(),
    );

    // 写方法不可达：挂载点显式 405，不落回 SPA 兜底。
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const blocked = (await route(publicRequest("/api/web-apps", method), env)) as Response;
      expect(blocked.status).toBe(405);
    }
  });

  it("管理端 CRUD：非管理员 403；create/update/reorder/delete 落库且 web_app.* 审计齐全", async () => {
    // 非管理员：读、写全部 403。
    for (const [method, path, body] of [
      ["GET", "/api/admin/web-apps", undefined],
      ["POST", "/api/admin/web-apps", { name: "x", url: "https://x.example.com" }],
      ["POST", "/api/admin/web-apps/reorder", { ids: [1] }],
      ["DELETE", "/api/admin/web-apps/1", undefined],
    ] as const) {
      const denied = (await handleAdminApi(adminRequest(path, { method, userId: "7", body }), env)) as Response;
      expect(denied.status).toBe(403);
    }
    expect(await auditActions(db)).toEqual([]);

    // 创建：落库 + web_app.create 审计。
    const createResponse = (await handleAdminApi(
      adminRequest("/api/admin/web-apps", {
        method: "POST",
        userId: "111",
        body: {
          name: "资源站",
          url: "https://b.example.com/path",
          description: "简介",
          iconUrl: "https://cdn.example.com/i.png",
          category: "资源",
          openMode: "miniapp",
          allowedDomains: ["b.example.com"],
        },
      }),
      env,
    )) as Response;
    expect(createResponse.status).toBe(200);
    const created = (await createResponse.json()) as WebAppRow & { id: number };
    expect(created.id).toBeGreaterThan(0);
    expect(created.openMode).toBe("miniapp");
    expect(created.allowedDomains).toEqual(["b.example.com"]);

    // 更新：before/after 落审计；部分字段不传不覆盖。
    const updateResponse = (await handleAdminApi(
      adminRequest(`/api/admin/web-apps/${created.id}`, { userId: "111", method: "PATCH", body: { name: "新名" } }),
      env,
    )) as Response;
    expect(updateResponse.status).toBe(200);
    const updated = (await updateResponse.json()) as WebAppRow;
    expect(updated.name).toBe("新名");
    expect(updated.url).toBe("https://b.example.com/path");
    expect(updated.openMode).toBe("miniapp");

    // 排序：两个应用后按给定顺序重排。
    const other = (await (
      await handleAdminApi(
        adminRequest("/api/admin/web-apps", {
          method: "POST",
          userId: "111",
          body: { name: "工具站", url: "https://a.example.com" },
        }),
        env,
      )
    ).json()) as { id: number };
    const reorderResponse = (await handleAdminApi(
      adminRequest("/api/admin/web-apps/reorder", {
        method: "POST",
        userId: "111",
        body: { ids: [other.id, created.id] },
      }),
      env,
    )) as Response;
    expect(reorderResponse.status).toBe(200);
    const listResponse = (await handleAdminApi(
      adminRequest("/api/admin/web-apps", { userId: "111" }),
      env,
    )) as Response;
    const list = (await listResponse.json()) as { items: Array<{ id: number; sortOrder: number }> };
    expect(list.items.map((app) => app.id)).toEqual([other.id, created.id]);
    expect(list.items.map((app) => app.sortOrder)).toEqual([1, 2]);

    // 删除：硬删 + web_app.delete 审计；删除后列表不再出现。
    const deleteResponse = (await handleAdminApi(
      adminRequest(`/api/admin/web-apps/${created.id}`, { userId: "111", method: "DELETE" }),
      env,
    )) as Response;
    expect(deleteResponse.status).toBe(200);
    const finalList = (await (
      await handleAdminApi(adminRequest("/api/admin/web-apps", { userId: "111" }), env)
    ).json()) as {
      items: Array<{ id: number }>;
    };
    expect(finalList.items.some((app) => app.id === created.id)).toBe(false);

    expect(await auditActions(db)).toEqual([
      "web_app.create",
      "web_app.update",
      "web_app.create",
      "web_app.reorder",
      "web_app.delete",
    ]);
    // update 审计携带 before/after（可追溯改了什么）。
    const updateAudit = (await db
      .prepare("SELECT before_json, after_json FROM audit_logs WHERE action = 'web_app.update' ORDER BY id ASC LIMIT 1")
      .first<{ before_json: string; after_json: string }>())!;
    expect(JSON.parse(updateAudit.before_json).name).toBe("资源站");
    expect(JSON.parse(updateAudit.after_json).name).toBe("新名");
  });

  it("校验：非 https URL、非法 open_mode、坏 allowedDomains、未知排序 id 全部 400", async () => {
    const rejections: Array<[string, unknown]> = [
      ["http://insecure.example.com", "链接"],
      ["ftp://insecure.example.com", "链接"],
      ["不是 URL", "链接"],
      // openMode 非法
      ["https://ok.example.com", "打开方式"],
    ];
    for (const [index, [urlValue, keyword]] of rejections.entries()) {
      const body =
        index === rejections.length - 1
          ? { name: "x", url: urlValue, openMode: "popup" }
          : { name: "x", url: urlValue };
      const response = (await handleAdminApi(
        adminRequest("/api/admin/web-apps", { method: "POST", userId: "111", body }),
        env,
      )) as Response;
      expect(response.status).toBe(400);
      const payload = (await response.json()) as { code: string; message: string };
      expect(payload.code).toBe("validation_failed");
      expect(payload.message).toContain(keyword);
    }

    // allowedDomains 非字符串数组。
    const badDomains = (await handleAdminApi(
      adminRequest("/api/admin/web-apps", {
        method: "POST",
        userId: "111",
        body: { name: "x", url: "https://ok.example.com", allowedDomains: "a.com" },
      }),
      env,
    )) as Response;
    expect(badDomains.status).toBe(400);

    // 创建成功后，非 https 的 iconUrl 也被拒。
    const okApp = (await (
      await handleAdminApi(
        adminRequest("/api/admin/web-apps", {
          method: "POST",
          userId: "111",
          body: { name: "ok", url: "https://ok.example.com" },
        }),
        env,
      )
    ).json()) as { id: number };
    const badIcon = (await handleAdminApi(
      adminRequest(`/api/admin/web-apps/${okApp.id}`, {
        userId: "111",
        method: "PATCH",
        body: { iconUrl: "http://cdn.example.com/i.png" },
      }),
      env,
    )) as Response;
    expect(badIcon.status).toBe(400);

    // reorder 里的未知 id / 重复 id 被拒，不产生审计。
    const badReorder = (await handleAdminApi(
      adminRequest("/api/admin/web-apps/reorder", { method: "POST", userId: "111", body: { ids: [okApp.id, 99999] } }),
      env,
    )) as Response;
    expect(badReorder.status).toBe(400);
    expect(await auditActions(db)).toEqual(["web_app.create"]);
  });

  it("管理端列表含停用项；404 兜底：不存在 id 的更新与删除", async () => {
    const disabled = (await (
      await handleAdminApi(
        adminRequest("/api/admin/web-apps", {
          method: "POST",
          userId: "111",
          body: { name: "停用站", url: "https://d.example.com", enabled: false },
        }),
        env,
      )
    ).json()) as { id: number; enabled: boolean };

    const list = (await (await handleAdminApi(adminRequest("/api/admin/web-apps", { userId: "111" }), env)).json()) as {
      items: Array<{ id: number; enabled: boolean }>;
    };
    expect(list.items.map((app) => app.id)).toEqual([disabled.id]);
    expect(list.items[0]!.enabled).toBe(false);

    const missingUpdate = (await handleAdminApi(
      adminRequest("/api/admin/web-apps/99999", { userId: "111", method: "PATCH", body: { name: "x" } }),
      env,
    )) as Response;
    expect(missingUpdate.status).toBe(404);
    const missingDelete = (await handleAdminApi(
      adminRequest("/api/admin/web-apps/99999", { userId: "111", method: "DELETE" }),
      env,
    )) as Response;
    expect(missingDelete.status).toBe(404);
  });
});
