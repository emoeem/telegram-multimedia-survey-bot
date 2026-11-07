import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../../../src/index";
import { handleSubmitApiRequest, isSubmitApiPath } from "../../../src/http/submit-api";
import { handleWebSubmissionAdmin } from "../../../src/http/admin/web-submission";
import { WEB_SUBMIT_GALLERY_CACHE_VERSION, webSubmitGalleryCacheKey } from "../../../src/http/submit-gallery";
import { upsertMediaRef } from "../../../src/db/repositories/media.repository";
import { createSqliteD1, sqliteD1Available } from "../../helpers/sqlite-d1";

/**
 * 投稿墙（showcase）—— approve 后内容的第一块站内公开面 + 管理端下架。
 *
 * 要钉住的边界（任务验收 ①-⑤）：
 *  ① showcaseEnabled=false 或 showcaseFields 空 → 空集（默认不出网），且
 *     /api/submit/form 的响应带上了开关字段（前端页签据此渲染）；
 *  ② recalled 不出现：status 等值过滤，recalled/deleted 天然排除；
 *  ③ 戳翻转：新稿过审（COUNT/MAX(published_at)）、unpublish（COUNT）、
 *     切换 showcaseEnabled/showcaseFields（system_settings.updated_at）
 *     三者任一都换缓存键，翻键后首请求 miss 并重建缓存；
 *  ④ unpublish：CAS published→recalled 成功、二次调用 already 码、
 *     writeAudit 留痕；
 *  ⑤ 媒体校验（双闸已开的前提下）：scope='response' + media:websubmit:
 *     前缀 + media_refs 归属 published 投稿三重全过才放行，未关联/挂错
 *     状态的资产一律 404；
 *  ⑥ 字节面同闸：showcaseEnabled=false（默认态）或媒体步骤不在
 *     showcaseFields 白名单里，媒体端点一律 404——assetId 全局自增可枚举，
 *     字节不与墙投影同闸，直连 URL 就能绕过「媒体步骤没勾选，资产 id
 *     不出网」的投影层约束。
 * 全部走真 SQLite：行为是 SQL 状态迁移与真实投影，mock 钉不住。
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
CREATE TABLE web_rate_limits (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL);
CREATE TABLE media_refs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  ref_type TEXT NOT NULL,
  ref_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(ref_type, ref_key)
);
CREATE TABLE media_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_scope TEXT NOT NULL DEFAULT 'legacy'
    CHECK (asset_scope IN ('survey', 'response', 'template', 'generated_result', 'template_preview', 'identity_card', 'legacy')),
  media_type TEXT NOT NULL,
  telegram_file_id TEXT, telegram_file_unique_id TEXT, url TEXT,
  storage_kind TEXT, storage_key TEXT, expires_at TEXT,
  mime_type TEXT, file_name TEXT, file_size INTEGER,
  width INTEGER, height INTEGER, duration INTEGER, r2_key TEXT,
  content_hash TEXT, created_at TEXT, updated_at TEXT
);
CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL
);
`;

/** 记录 get/put 键序的 KV mock：戳翻转断言靠它。 */
function makeCacheKv(): KVNamespace & { calls: { gets: string[]; puts: string[] }; store: Map<string, string> } {
  const store = new Map<string, string>();
  const calls = { gets: [] as string[], puts: [] as string[] };
  return {
    calls,
    store,
    get: vi.fn(async (key: string) => {
      calls.gets.push(key);
      return store.get(key) ?? null;
    }),
    put: vi.fn(async (key: string, value: string) => {
      calls.puts.push(key);
      store.set(key, value);
    }),
  } as unknown as KVNamespace & { calls: { gets: string[]; puts: string[] }; store: Map<string, string> };
}

function makeEnv(): Env {
  const db = createSqliteD1(SCHEMA);
  return {
    DB: db,
    BOT_TOKEN: "test-token",
    CACHE: makeCacheKv(),
    MEDIA: {
      get: async (key: string) => (key.startsWith("media:websubmit:") ? { body: new Response("pngbytes").body } : null),
    } as unknown as R2Bucket,
    MEDIA_KV: { get: vi.fn(async () => null), put: vi.fn() } as unknown as KVNamespace,
  } as unknown as Env;
}

function req(path: string): Request {
  return new Request(`https://site.example${path}`);
}

/** 直接写设置行：updated_at 用显式时间戳，翻戳断言不依赖真实时钟精度。 */
async function writeSettings(
  env: Env,
  value: Record<string, unknown>,
  updatedAt = "2026-01-01T00:00:00.000Z",
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO system_settings (key, value, updated_by, updated_at) VALUES ('web_submit_form', ?, NULL, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind(JSON.stringify(value), updatedAt)
    .run();
}

async function seedSubmission(
  env: Env,
  options: {
    status?: string;
    data?: Record<string, unknown>;
    publishedAt?: number | null;
    nickname?: string;
  } = {},
): Promise<number> {
  const data = {
    category: "文字分享",
    title: { plain: "一个标题", html: "<b>一个标题</b>" },
    body: "正文内容",
    author: "匿名投稿",
    contact: "私人联系方式",
    __nickname: "小明",
    ...(options.data ?? {}),
  };
  const result = await env.DB.prepare(
    `INSERT INTO web_submissions (viewer_token, email, nickname, ip, data, status, created_at, updated_at, published_at)
       VALUES ('viewer0000000001', 'a@b.c', ?, '127.0.0.1', ?, ?, 1000, 1000, ?)`,
  )
    .bind(options.nickname ?? "小明", JSON.stringify(data), options.status ?? "pending", options.publishedAt ?? null)
    .run();
  return Number(result.meta?.last_row_id ?? 0);
}

async function galleryItems(env: Env): Promise<Record<string, unknown>[]> {
  const response = await handleSubmitApiRequest(
    req("/api/submit/gallery"),
    env,
    new URL("https://site.example/api/submit/gallery"),
  );
  expect(response?.status).toBe(200);
  const body = (await response!.json()) as { ok: boolean; items: Record<string, unknown>[] };
  expect(body.ok).toBe(true);
  return body.items;
}

/** 走完整路由取媒体字节（⑤ 资产校验与 ⑥ 字节面同闸共用）。 */
async function fetchMedia(env: Env, assetId: number): Promise<Response> {
  const url = new URL(`https://site.example/api/submit/gallery/media/${assetId}`);
  return (await handleSubmitApiRequest(req(url.pathname), env, url))!;
}

function adminCtx() {
  return {
    isAdmin: true,
    actorUserId: 42 as number | null,
    fail: (status: number, code: string, message: string) => Response.json({ code, message }, { status }),
    json: (body: unknown) => Response.json(body),
  };
}

async function unpublish(env: Env, id: number): Promise<Response> {
  const url = new URL("https://site.example/api/admin/web-submissions/unpublish");
  return (await handleWebSubmissionAdmin(
    new Request(url, { method: "POST", body: JSON.stringify({ id }) }),
    url,
    env,
    adminCtx(),
  ))!;
}

const describeIf = sqliteD1Available ? describe : describe.skip;

afterEach(() => {
  vi.restoreAllMocks();
});

describeIf("路径归属", () => {
  it("/api/submit/gallery 归 submit API 管，且不影响 /api/submissions", () => {
    expect(isSubmitApiPath("/api/submit/gallery")).toBe(true);
    expect(isSubmitApiPath("/api/submit/gallery/media/3")).toBe(true);
    expect(isSubmitApiPath("/api/submissions")).toBe(false);
  });

  it("缓存键函数：PROJECTION_VERSION 在键里（滚动期防旧投影）", () => {
    expect(webSubmitGalleryCacheKey("s:3:100")).toBe(`web-submit-gallery:${WEB_SUBMIT_GALLERY_CACHE_VERSION}:s:3:100`);
  });
});

describeIf("① 隐私双闸：默认不出网", () => {
  it("没有设置行（默认配置）：published 行存在也返回空集", async () => {
    const env = makeEnv();
    await seedSubmission(env, { status: "published", publishedAt: 2000 });
    expect(await galleryItems(env)).toEqual([]);
    // 关闭态在读配置后直接返回：不探针、不写缓存。
    const cache = env.CACHE as unknown as { calls: { gets: string[]; puts: string[] } };
    expect(cache.calls.gets).toEqual([]);
    expect(cache.calls.puts).toEqual([]);
  });

  it("showcaseFields 为空（总开关开着）：仍然空集", async () => {
    const env = makeEnv();
    await writeSettings(env, { enabled: true, showcaseEnabled: true, showcaseFields: [] });
    await seedSubmission(env, { status: "published", publishedAt: 2000 });
    expect(await galleryItems(env)).toEqual([]);
  });

  it("GET /api/submit/form 响应并入 showcaseEnabled/showcaseFields（默认 false）", async () => {
    const env = makeEnv();
    const url = new URL("https://site.example/api/submit/form");
    const response = (await handleSubmitApiRequest(req("/api/submit/form"), env, url))!;
    const body = (await response.json()) as { ok: boolean; form: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.form.showcaseEnabled).toBe(false);
    expect(body.form.showcaseFields).toEqual([]);

    await writeSettings(env, { enabled: true, showcaseEnabled: true, showcaseFields: ["title", "body"] });
    const after = (await handleSubmitApiRequest(req("/api/submit/form"), env, url))!;
    const afterBody = (await after.json()) as { form: Record<string, unknown> };
    expect(afterBody.form.showcaseEnabled).toBe(true);
    expect(afterBody.form.showcaseFields).toEqual(["title", "body"]);
  });
});

describeIf("published 投影：白名单字段 + 署名规则", () => {
  it("只投影白名单命中的字段；__ 内部键与非白名单字段带不出网", async () => {
    const env = makeEnv();
    await writeSettings(env, { enabled: true, showcaseEnabled: true, showcaseFields: ["title", "contact"] });
    const id = await seedSubmission(env, {
      status: "published",
      publishedAt: 2000,
      data: {
        title: { plain: "墙上的标题", html: "<b>墙上的标题</b>" },
        body: "不该出现的正文",
        contact: "可展示的联系方式",
        author: "匿名投稿",
        __nickname: "不该出现的昵称",
        __email: "secret@example.com",
      },
    });
    const items = await galleryItems(env);
    expect(items).toHaveLength(1);
    const item = items[0] as Record<string, unknown>;
    expect(item.id).toBe(id);
    expect(item.createdAt).toBe(1000);
    expect(item.fields).toEqual({ title: "墙上的标题", contact: "可展示的联系方式" });
    // JSON 序列化后的整个条目里不得出现内部键。
    expect(JSON.stringify(items)).not.toContain("不该出现的昵称");
    expect(JSON.stringify(items)).not.toContain("secret@example.com");
    expect(JSON.stringify(items)).not.toContain("不该出现的正文");
  });

  it("昵称按署名方式投影：匿名 null、显示昵称带昵称、自定义署名带署名文本", async () => {
    const env = makeEnv();
    await writeSettings(env, { enabled: true, showcaseEnabled: true, showcaseFields: ["body"] });
    const anonymous = await seedSubmission(env, {
      status: "published",
      publishedAt: 3000,
      data: { body: "一", author: "匿名投稿", __nickname: "填了昵称的匿名者" },
    });
    const byNickname = await seedSubmission(env, {
      status: "published",
      publishedAt: 2000,
      data: { body: "二", author: "显示我的昵称", __nickname: "小明" },
      nickname: "小明",
    });
    const bySignature = await seedSubmission(env, {
      status: "published",
      publishedAt: 1000,
      data: { body: "三", author: "自定义署名", signature: "笔名阿花", __nickname: "小明" },
      nickname: "小明",
    });
    const items = await galleryItems(env);
    const byId = new Map(items.map((item) => [item.id, item.nickname]));
    expect(byId.get(anonymous)).toBeNull();
    expect(byId.get(byNickname)).toBe("小明");
    expect(byId.get(bySignature)).toBe("笔名阿花");
  });

  it("showcaseFields 里残留的旧 step id 被合并层剔除，不投影", async () => {
    const env = makeEnv();
    await writeSettings(env, {
      enabled: true,
      showcaseEnabled: true,
      showcaseFields: ["title", "ghost_step_not_in_form"],
    });
    await seedSubmission(env, { status: "published", publishedAt: 2000 });
    const items = await galleryItems(env);
    expect(items).toHaveLength(1);
    expect((items[0] as Record<string, unknown>).fields).toEqual({ title: "一个标题" });
  });

  it("附件资产 id 跟媒体步骤的白名单走：勾选才出、未勾选不出", async () => {
    const env = makeEnv();
    const mediaStepId = "photos";
    await writeSettings(env, { enabled: true, showcaseEnabled: true, showcaseFields: ["title"] });
    await seedSubmission(env, {
      status: "published",
      publishedAt: 2000,
      data: { title: "带图投稿", [mediaStepId]: [{ kind: "photo", mediaAssetId: 7 }] },
    });
    // 未勾选媒体步骤：资产 id 不出网。
    let items = await galleryItems(env);
    expect((items[0] as Record<string, unknown>).mediaAssetIds).toEqual([]);

    await writeSettings(
      env,
      { enabled: true, showcaseEnabled: true, showcaseFields: ["title", mediaStepId] },
      "2026-01-01T00:00:01.000Z",
    );
    items = await galleryItems(env);
    expect((items[0] as Record<string, unknown>).mediaAssetIds).toEqual([7]);
  });
});

describeIf("② recalled 不出现", () => {
  it("recalled / pending / rejected 都不上墙，published 保留", async () => {
    const env = makeEnv();
    await writeSettings(env, { enabled: true, showcaseEnabled: true, showcaseFields: ["title"] });
    const published = await seedSubmission(env, { status: "published", publishedAt: 3000 });
    await seedSubmission(env, { status: "recalled", publishedAt: 2000 });
    await seedSubmission(env, { status: "pending" });
    await seedSubmission(env, { status: "rejected" });
    const items = await galleryItems(env);
    expect(items.map((item) => item.id)).toEqual([published]);
  });
});

describeIf("③ 戳翻转：任何一类变化都换键，翻键后首请求重建缓存", () => {
  it("命中时不重建；过审新增 → 翻键重建；unpublish → 翻键重建", async () => {
    const env = makeEnv();
    await writeSettings(env, { enabled: true, showcaseEnabled: true, showcaseFields: ["title"] });
    await seedSubmission(env, { status: "published", publishedAt: 1000 });
    const cache = env.CACHE as unknown as { calls: { gets: string[]; puts: string[] } };

    await galleryItems(env); // 首请求 miss + 重建
    expect(cache.calls.puts).toHaveLength(1);
    const firstKey = cache.calls.puts[0]!;

    await galleryItems(env); // 命中：不再 put
    expect(cache.calls.puts).toHaveLength(1);

    await seedSubmission(env, { status: "published", publishedAt: 2000 }); // 新稿过审
    const items = await galleryItems(env); // COUNT/MAX 变 → 键翻转 → 重建
    expect(cache.calls.puts).toHaveLength(2);
    const secondKey = cache.calls.puts[1]!;
    expect(secondKey).not.toBe(firstKey);
    expect(items).toHaveLength(2);

    await unpublish(env, 2); // 下架：COUNT 减一
    const afterUnpublish = await galleryItems(env);
    expect(cache.calls.puts).toHaveLength(3);
    // 下架最新一条会把 (count, maxPublishedAt) 翻回第一扇窗的值（1,1000）——
    // 单调戳 MAX(updated_at) 保证键仍不复用，旧 payload 不会命中。
    expect(cache.calls.puts[2]).not.toBe(firstKey);
    expect(cache.calls.puts[2]).not.toBe(secondKey);
    expect(afterUnpublish.map((item) => item.id)).toEqual([1]);
  });

  it("切换 showcaseEnabled/showcaseFields（system_settings.updated_at 变）→ 翻键重建", async () => {
    const env = makeEnv();
    await writeSettings(env, { enabled: true, showcaseEnabled: true, showcaseFields: ["title"] });
    await seedSubmission(env, { status: "published", publishedAt: 1000 });
    const cache = env.CACHE as unknown as { calls: { gets: string[]; puts: string[] } };
    await galleryItems(env);
    expect(cache.calls.puts).toHaveLength(1);
    const firstKey = cache.calls.puts[0]!;

    // 白名单增删 → 设置行 updated_at 变 → 键翻转，首请求重建。
    await writeSettings(
      env,
      { enabled: true, showcaseEnabled: true, showcaseFields: ["title", "body"] },
      "2026-01-02T00:00:00.000Z",
    );
    const items = await galleryItems(env);
    expect(cache.calls.puts).toHaveLength(2);
    expect(cache.calls.puts[1]).not.toBe(firstKey);
    expect((items[0] as Record<string, unknown>).fields).toHaveProperty("body");

    // 关掉总开关：空集（关闭期不经缓存，直接返回）。
    await writeSettings(
      env,
      { enabled: true, showcaseEnabled: false, showcaseFields: ["title", "body"] },
      "2026-01-03T00:00:00.000Z",
    );
    expect(await galleryItems(env)).toEqual([]);
  });
});

describeIf("④ unpublish：CAS published→recalled + writeAudit", () => {
  it("published → recalled 成功；二次调用 already；非 published 拒绝；404；非管理员 403", async () => {
    const env = makeEnv();
    const publishedId = await seedSubmission(env, { status: "published", publishedAt: 1000 });
    const pendingId = await seedSubmission(env, { status: "pending" });

    const first = await unpublish(env, publishedId);
    expect(first.status).toBe(200);
    const row = await env.DB.prepare("SELECT status FROM web_submissions WHERE id = ?")
      .bind(publishedId)
      .first<{ status: string }>();
    expect(row?.status).toBe("recalled");
    // published_at 保留作历史（setStatus 非 published 分支只动 updated_at）。
    const stamped = await env.DB.prepare("SELECT published_at FROM web_submissions WHERE id = ?")
      .bind(publishedId)
      .first<{ published_at: number | null }>();
    expect(stamped?.published_at).toBe(1000);

    const again = await unpublish(env, publishedId);
    expect(again.status).toBe(409);
    expect(((await again.json()) as { code: string }).code).toBe("already_recalled");

    const notPublished = await unpublish(env, pendingId);
    expect(notPublished.status).toBe(409);
    expect(((await notPublished.json()) as { code: string }).code).toBe("not_published");

    const missing = await unpublish(env, 999);
    expect(missing.status).toBe(404);

    const url = new URL("https://site.example/api/admin/web-submissions/unpublish");
    const forbidden = (await handleWebSubmissionAdmin(
      new Request(url, { method: "POST", body: JSON.stringify({ id: publishedId }) }),
      url,
      env,
      { ...adminCtx(), isAdmin: false },
    ))!;
    expect(forbidden.status).toBe(403);
  });

  it("writeAudit 留痕：action/entity/操作者/前后状态", async () => {
    const env = makeEnv();
    const id = await seedSubmission(env, { status: "published", publishedAt: 1000 });
    await unpublish(env, id);
    const log = await env.DB.prepare(
      "SELECT actor_user_id, action, entity_type, entity_id, before_json, after_json FROM audit_logs WHERE entity_id = ?",
    )
      .bind(String(id))
      .first<Record<string, string | null>>();
    expect(log?.action).toBe("web_submission.unpublish");
    expect(log?.entity_type).toBe("web_submission");
    expect(log?.actor_user_id).toBe(42);
    expect(JSON.parse(log?.before_json ?? "{}")).toEqual({ status: "published" });
    expect(JSON.parse(log?.after_json ?? "{}")).toEqual({ status: "recalled" });
  });

  it("下架后投稿墙不再包含该条（戳翻转后重建的缓存里没有它）", async () => {
    const env = makeEnv();
    await writeSettings(env, { enabled: true, showcaseEnabled: true, showcaseFields: ["title"] });
    const id = await seedSubmission(env, { status: "published", publishedAt: 1000 });
    await galleryItems(env);
    await unpublish(env, id);
    const items = await galleryItems(env);
    expect(items).toEqual([]);
  });
});

describeIf("⑤ 媒体校验：scope + 前缀 + published 归属三重闸", () => {
  /** 本组钉资产侧三重校验，前置把 showcase 双闸打开（媒体端点与墙投影
   * 同闸；闸本身的边界在 ⑥ 组钉）。photos = 默认模板的媒体步骤 id。 */
  async function openShowcase(env: Env, updatedAt = "2026-01-01T00:00:00.000Z"): Promise<void> {
    await writeSettings(env, { enabled: true, showcaseEnabled: true, showcaseFields: ["title", "photos"] }, updatedAt);
  }

  async function seedAsset(
    env: Env,
    overrides: { scope?: string; storageKey?: string; storageKind?: string } = {},
  ): Promise<number> {
    const result = await env.DB.prepare(
      `INSERT INTO media_assets (asset_scope, media_type, storage_kind, storage_key, mime_type, file_name, created_at, updated_at)
         VALUES (?, 'photo', ?, ?, 'image/png', 'pic.png', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    )
      .bind(
        overrides.scope ?? "response",
        overrides.storageKind ?? "r2",
        overrides.storageKey ?? "media:websubmit:asset-1",
      )
      .run();
    return Number(result.meta?.last_row_id ?? 0);
  }

  it("published 归属的 websubmit 资产放行并回字节", async () => {
    const env = makeEnv();
    await openShowcase(env);
    const submissionId = await seedSubmission(env, { status: "published", publishedAt: 1000 });
    const assetId = await seedAsset(env);
    await upsertMediaRef(env.DB, {
      refType: "web_submission",
      refKey: `websubmit:${submissionId}:${assetId}`,
      assetId,
    });

    const response = await fetchMedia(env, assetId);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("pngbytes");
  });

  it("未关联 media_refs 的资产拒绝；挂未发布投稿的资产拒绝", async () => {
    const env = makeEnv();
    await openShowcase(env);
    const publishedId = await seedSubmission(env, { status: "published", publishedAt: 1000 });
    const pendingId = await seedSubmission(env, { status: "pending" });

    const orphan = await seedAsset(env);
    expect((await fetchMedia(env, orphan)).status).toBe(404);

    const pendingLinked = await seedAsset(env, { storageKey: "media:websubmit:asset-2" });
    await upsertMediaRef(env.DB, {
      refType: "web_submission",
      refKey: `websubmit:${pendingId}:${pendingLinked}`,
      assetId: pendingLinked,
    });
    expect((await fetchMedia(env, pendingLinked)).status).toBe(404);

    // 对照：同一资产改成挂 published 投稿后放行（排除「前缀/scope 误伤」假阳性）。
    await upsertMediaRef(env.DB, {
      refType: "web_submission",
      refKey: `websubmit:${publishedId}:${pendingLinked}`,
      assetId: pendingLinked,
    });
    expect((await fetchMedia(env, pendingLinked)).status).toBe(200);
  });

  it("scope 不是 response、或 storage_key 不是 media:websubmit: 前缀的资产拒绝", async () => {
    const env = makeEnv();
    await openShowcase(env);
    const submissionId = await seedSubmission(env, { status: "published", publishedAt: 1000 });

    const wrongScope = await seedAsset(env, { scope: "survey" });
    await upsertMediaRef(env.DB, {
      refType: "web_submission",
      refKey: `websubmit:${submissionId}:${wrongScope}`,
      assetId: wrongScope,
    });
    expect((await fetchMedia(env, wrongScope)).status).toBe(404);

    const wrongPrefix = await seedAsset(env, { storageKey: "media:plaza:other" });
    await upsertMediaRef(env.DB, {
      refType: "web_submission",
      refKey: `websubmit:${submissionId}:${wrongPrefix}`,
      assetId: wrongPrefix,
    });
    expect((await fetchMedia(env, wrongPrefix)).status).toBe(404);
  });

  it("不存在的资产 404；非 GET 405；enabled=false 不影响墙与媒体（通道关闭≠公开面下线）", async () => {
    const env = makeEnv();
    await openShowcase(env);
    expect((await fetchMedia(env, 9999)).status).toBe(404);

    const mediaUrl = new URL("https://site.example/api/submit/gallery/media/1");
    const postResponse = (await handleSubmitApiRequest(new Request(mediaUrl, { method: "POST" }), env, mediaUrl))!;
    expect(postResponse.status).toBe(405);

    await writeSettings(env, { enabled: false, showcaseEnabled: true, showcaseFields: ["title"] });
    await seedSubmission(env, { status: "published", publishedAt: 1000 });
    expect((await galleryItems(env)).length).toBe(1);
  });
});

describeIf("⑥ 字节面同闸：showcase 双闸不过 → 媒体一律 404（assetId 可枚举，直连也得出不了网）", () => {
  async function seedPublishedAttachment(env: Env): Promise<{ submissionId: number; assetId: number }> {
    const submissionId = await seedSubmission(env, { status: "published", publishedAt: 1000 });
    const result = await env.DB.prepare(
      `INSERT INTO media_assets (asset_scope, media_type, storage_kind, storage_key, mime_type, file_name, created_at, updated_at)
         VALUES ('response', 'photo', 'r2', 'media:websubmit:gate-1', 'image/png', 'pic.png', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run();
    const assetId = Number(result.meta?.last_row_id ?? 0);
    await upsertMediaRef(env.DB, {
      refType: "web_submission",
      refKey: `websubmit:${submissionId}:${assetId}`,
      assetId,
    });
    return { submissionId, assetId };
  }

  it("showcaseEnabled=false（默认态无设置行 / 显式关闭）：published 归属的附件也 404；开闸后同一资产 200", async () => {
    const env = makeEnv();
    const { assetId } = await seedPublishedAttachment(env);

    // 默认态：没有设置行 = showcaseEnabled false → 字节不出网。
    expect((await fetchMedia(env, assetId)).status).toBe(404);

    // 显式关闭：同样 404。
    await writeSettings(env, { enabled: true, showcaseEnabled: false, showcaseFields: ["title", "photos"] });
    expect((await fetchMedia(env, assetId)).status).toBe(404);

    // 对照：同一资产、同一归属，总开关打开后放行——404 是闸拦的，不是
    // 「资产/归属没插对」的假阳性。
    await writeSettings(
      env,
      { enabled: true, showcaseEnabled: true, showcaseFields: ["title", "photos"] },
      "2026-01-01T00:00:01.000Z",
    );
    const response = await fetchMedia(env, assetId);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("pngbytes");
  });

  it("媒体步骤不在 showcaseFields 白名单：字节同样 404（与墙上不投影 mediaAssetIds 同闸）；勾上后 200", async () => {
    const env = makeEnv();
    const { assetId } = await seedPublishedAttachment(env);

    await writeSettings(env, { enabled: true, showcaseEnabled: true, showcaseFields: ["title"] });
    expect((await fetchMedia(env, assetId)).status).toBe(404);

    // 白名单勾上媒体步骤（settings 戳变）→ 同一资产放行。
    await writeSettings(
      env,
      { enabled: true, showcaseEnabled: true, showcaseFields: ["title", "photos"] },
      "2026-01-01T00:00:02.000Z",
    );
    expect((await fetchMedia(env, assetId)).status).toBe(200);
  });
});

/**
 * 管理端与公开 SPA 的结构钉子（worker 的 vitest 环境没有 DOM，React 组件
 * 用 grep 源码钉结构——与 tests/unit/admin/submission-tab.test.ts 同一手法）：
 * 下架能力与公开能力必须成对存在，一旦有人删掉按钮或页签，这里先红。
 */
describe("结构：管理端下架按钮与公开页签成对", () => {
  const adminPage = readFileSync(join(process.cwd(), "admin", "src", "routes", "WebSubmissionsPage.tsx"), "utf8");
  const hub = readFileSync(join(process.cwd(), "admin", "src", "survey", "SubmissionHub.tsx"), "utf8");
  const backend = readFileSync(join(process.cwd(), "src", "http", "admin", "web-submission.ts"), "utf8");

  it("published 行有「撤回下架」按钮，调 /unpublish", () => {
    expect(adminPage).toContain("撤回下架");
    expect(adminPage).toContain('"/api/admin/web-submissions/unpublish"');
  });

  it("后端白名单里有 /unpublish，且写审计", () => {
    expect(backend).toContain('"/unpublish"');
    expect(backend).toContain('action: "web_submission.unpublish"');
  });

  it("投稿中心只在开关开启时渲染投稿墙页签（页签 + 内容层双闸）", () => {
    expect(hub).toContain("visibleTabs(showcaseEnabled)");
    expect(hub).toMatch(/tab === "gallery" && showcaseEnabled \?/);
  });
});
