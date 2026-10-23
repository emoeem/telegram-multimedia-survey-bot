import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../../../src/index";
import {
  handleWebSubmissionAdmin,
  isWebSubmissionAdminPath,
  WEB_SUBMISSION_PREFIX,
} from "../../../src/http/admin/web-submission";
import { createSqliteD1, sqliteD1Available } from "../../helpers/sqlite-d1";

/**
 * 后台审核网页投稿 —— 并轨后的**本地实现**(数据在本站 D1)。
 *
 * 要钉住的边界从「转发是否安全」换成了「状态机与数据是否正确」:
 *  - 只有管理员能进(试用会话看得见 /admin,但不能审稿);
 *  - 路径白名单仍在(防路径穿越/未知动作);
 *  - approve 是 CAS:并发双击只有一次生效,已发布的不能驳回;
 *  - reject/approve 都会给投稿者线程留言(收件箱的未读数靠它);
 *  - 附件的 inline/attachment 语义(photo 内联,document 强制下载,防 XSS)。
 * 真库跑:这些行为全是 SQL 状态迁移,mock 钉不住。
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

function makeEnv(): Env {
  const db = createSqliteD1(SCHEMA);
  return {
    DB: db,
    BOT_TOKEN: "test-token",
    WEBHOOK_SECRET: "webhook-secret",
  } as unknown as Env;
}

function ctx(isAdmin = true) {
  return {
    isAdmin,
    fail: (status: number, code: string, message: string) => Response.json({ code, message }, { status }),
    json: (body: unknown) => Response.json(body),
  };
}

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`https://site.example${path}`, init);
}

/** 种一条投稿;data 覆盖默认模板的关键字段。 */
async function seedSubmission(
  env: Env,
  overrides: Partial<{ status: string; viewer: string; data: Record<string, unknown> }> = {},
): Promise<number> {
  const data = {
    category: "文字分享",
    body: "正文内容",
    author: "匿名投稿",
    ...(overrides.data ?? {}),
  };
  const result = await env.DB.prepare(
    `INSERT INTO web_submissions (viewer_token, email, nickname, ip, data, status, created_at, updated_at)
       VALUES (?, 'a@b.c', '测试投稿者', '127.0.0.1', ?, ?, strftime('%s','now'), strftime('%s','now'))`,
  )
    .bind(overrides.viewer ?? "abcdef0123456789", JSON.stringify(data), overrides.status ?? "pending")
    .run();
  return Number(result.meta?.last_row_id ?? 0);
}

const describeIf = sqliteD1Available ? describe : describe.skip;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("路径归属", () => {
  it("认得自己的前缀和子路径", () => {
    expect(WEB_SUBMISSION_PREFIX).toBe("/api/admin/web-submissions");
    expect(isWebSubmissionAdminPath("/api/admin/web-submissions")).toBe(true);
    expect(isWebSubmissionAdminPath("/api/admin/web-submissions/list")).toBe(true);
  });

  it("不吞金币投稿(/api/admin/submissions)", () => {
    expect(isWebSubmissionAdminPath("/api/admin/submissions")).toBe(false);
    expect(isWebSubmissionAdminPath("/api/admin/submissions/12")).toBe(false);
  });
});

describeIf("鉴权与白名单", () => {
  it("非管理员 403,不触库", async () => {
    const env = makeEnv();
    const url = new URL("https://site.example/api/admin/web-submissions/list");
    const response = await handleWebSubmissionAdmin(req(url.pathname), url, env, ctx(false));
    expect(response?.status).toBe(403);
  });

  it("未知动作 404;前缀本身(无动作)也 404", async () => {
    const env = makeEnv();
    const bad = new URL("https://site.example/api/admin/web-submissions/drop-tables");
    expect((await handleWebSubmissionAdmin(req(bad.pathname), bad, env, ctx()))?.status).toBe(404);
    const bare = new URL("https://site.example/api/admin/web-submissions");
    expect((await handleWebSubmissionAdmin(req(bare.pathname), bare, env, ctx()))?.status).toBe(404);
  });

  it("URL 规范化把穿越路径消掉后,本模块直接不认(返回 null)", async () => {
    const env = makeEnv();
    const url = new URL("https://site.example/api/admin/web-submissions/../webhook/abc");
    expect(url.pathname).toBe("/api/admin/webhook/abc");
    expect(await handleWebSubmissionAdmin(req(url.pathname), url, env, ctx())).toBeNull();
  });
});

describeIf("count 与 list", () => {
  it("count 按状态分桶", async () => {
    const env = makeEnv();
    await seedSubmission(env);
    await seedSubmission(env, { status: "published" });
    const url = new URL("https://site.example/api/admin/web-submissions/count");
    const response = await handleWebSubmissionAdmin(req(url.pathname), url, env, ctx());
    const body = (await response!.json()) as { ok: boolean; pending: number; total: number };
    expect(body.ok).toBe(true);
    expect(body.pending).toBe(1);
    expect(body.total).toBe(2);
  });

  it("list 只回摘要(preview 截断),不回整段正文", async () => {
    const env = makeEnv();
    await seedSubmission(env, { data: { body: "长".repeat(400) } });
    const url = new URL("https://site.example/api/admin/web-submissions/list?status=pending");
    const response = await handleWebSubmissionAdmin(req(url.pathname + url.search), url, env, ctx());
    const body = (await response!.json()) as {
      items: Array<{ preview: string; email: string; attachments: unknown[] }>;
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.preview.length).toBeLessThanOrEqual(160);
    expect(body.items[0]!.email).toBe("a@b.c");
  });

  it("detail 摊平附件与状态", async () => {
    const env = makeEnv();
    const id = await seedSubmission(env, {
      data: { photos: [{ kind: "photo", mediaAssetId: 1, name: "a.png" }] },
    });
    const url = new URL(`https://site.example/api/admin/web-submissions/detail?id=${id}`);
    const response = await handleWebSubmissionAdmin(req(url.pathname + url.search), url, env, ctx());
    const body = (await response!.json()) as { submission: { attachments: Array<{ kind: string }>; text: string } };
    expect(body.submission.attachments).toEqual([{ kind: "photo", name: "a.png" }]);
    expect(body.submission.text).toContain("正文内容");
    expect(body.submission.text).toContain("附件 1 个");
  });
});

describeIf("approve 状态机", () => {
  it("pending → published,并给投稿者线程留言", async () => {
    const env = makeEnv();
    const id = await seedSubmission(env);
    const url = new URL("https://site.example/api/admin/web-submissions/approve");
    const response = await handleWebSubmissionAdmin(
      req(url.pathname, { method: "POST", body: JSON.stringify({ id }) }),
      url,
      env,
      ctx(),
    );
    expect(response?.status).toBe(200);
    const row = await env.DB.prepare("SELECT status, published_at FROM web_submissions WHERE id = ?")
      .bind(id)
      .first<{ status: string; published_at: number }>();
    expect(row?.status).toBe("published");
    expect(Number(row?.published_at)).toBeGreaterThan(0);
    const thread = await env.DB.prepare("SELECT direction, text FROM web_submission_threads WHERE submission_id = ?")
      .bind(id)
      .first<{ direction: string; text: string }>();
    expect(thread?.direction).toBe("to_author");
    expect(thread?.text).toContain("已通过");
  });

  it("已发布的再点通过 → 409 already_published", async () => {
    const env = makeEnv();
    const id = await seedSubmission(env, { status: "published" });
    const url = new URL("https://site.example/api/admin/web-submissions/approve");
    const response = await handleWebSubmissionAdmin(
      req(url.pathname, { method: "POST", body: JSON.stringify({ id }) }),
      url,
      env,
      ctx(),
    );
    expect(response?.status).toBe(409);
    const body = (await response!.json()) as { code: string };
    expect(body.code).toBe("already_published");
  });

  it("rejected 的稿件可以重新通过(failed 语义并入)", async () => {
    const env = makeEnv();
    const id = await seedSubmission(env, { status: "failed" });
    const url = new URL("https://site.example/api/admin/web-submissions/approve");
    const response = await handleWebSubmissionAdmin(
      req(url.pathname, { method: "POST", body: JSON.stringify({ id }) }),
      url,
      env,
      ctx(),
    );
    expect(response?.status).toBe(200);
  });

  it("频道推送失败不回滚状态", async () => {
    const env = makeEnv();
    await env.DB.prepare(
      "INSERT INTO system_settings (key, value, updated_by, updated_at) VALUES ('web_submit_form', ?, NULL, '')",
    )
      .bind(JSON.stringify({ publishChannelId: "-100123" }))
      .run();
    const id = await seedSubmission(env);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>", { status: 500 })),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const url = new URL("https://site.example/api/admin/web-submissions/approve");
    const response = await handleWebSubmissionAdmin(
      req(url.pathname, { method: "POST", body: JSON.stringify({ id }) }),
      url,
      env,
      ctx(),
    );
    expect(response?.status).toBe(200);
    const row = await env.DB.prepare("SELECT status FROM web_submissions WHERE id = ?")
      .bind(id)
      .first<{ status: string }>();
    expect(row?.status).toBe("published");
  });
});

describeIf("reject 状态机", () => {
  it("pending → rejected,理由写进线程", async () => {
    const env = makeEnv();
    const id = await seedSubmission(env);
    const url = new URL("https://site.example/api/admin/web-submissions/reject");
    const response = await handleWebSubmissionAdmin(
      req(url.pathname, { method: "POST", body: JSON.stringify({ id, reason: "内容与主题无关" }) }),
      url,
      env,
      ctx(),
    );
    expect(response?.status).toBe(200);
    const row = await env.DB.prepare("SELECT status FROM web_submissions WHERE id = ?")
      .bind(id)
      .first<{ status: string }>();
    expect(row?.status).toBe("rejected");
    const thread = await env.DB.prepare("SELECT text FROM web_submission_threads WHERE submission_id = ?")
      .bind(id)
      .first<{ text: string }>();
    expect(thread?.text).toContain("内容与主题无关");
  });

  it("已发布的不能直接驳回(409)", async () => {
    const env = makeEnv();
    const id = await seedSubmission(env, { status: "published" });
    const url = new URL("https://site.example/api/admin/web-submissions/reject");
    const response = await handleWebSubmissionAdmin(
      req(url.pathname, { method: "POST", body: JSON.stringify({ id, reason: "x" }) }),
      url,
      env,
      ctx(),
    );
    expect(response?.status).toBe(409);
  });

  it("理由超 300 字 → 422", async () => {
    const env = makeEnv();
    const id = await seedSubmission(env);
    const url = new URL("https://site.example/api/admin/web-submissions/reject");
    const response = await handleWebSubmissionAdmin(
      req(url.pathname, { method: "POST", body: JSON.stringify({ id, reason: "长".repeat(301) }) }),
      url,
      env,
      ctx(),
    );
    expect(response?.status).toBe(422);
  });
});

describeIf("reply 与 media", () => {
  it("reply 落线程并限 800 字", async () => {
    const env = makeEnv();
    const id = await seedSubmission(env);
    const url = new URL("https://site.example/api/admin/web-submissions/reply");
    const ok = await handleWebSubmissionAdmin(
      req(url.pathname, { method: "POST", body: JSON.stringify({ id, text: "请补充出处" }) }),
      url,
      env,
      ctx(),
    );
    expect(ok?.status).toBe(200);
    const tooLong = await handleWebSubmissionAdmin(
      req(url.pathname, { method: "POST", body: JSON.stringify({ id, text: "长".repeat(801) }) }),
      url,
      env,
      ctx(),
    );
    expect(tooLong?.status).toBe(422);
  });

  it("photo 内联、document 强制下载(防存储型 XSS)", async () => {
    const env = makeEnv();
    /* 直接往 MEDIA store 放两个字节块,再挂 media_assets。 */
    await env.DB.prepare(
      "INSERT INTO media_assets (asset_scope, media_type, storage_kind, storage_key, mime_type, file_name, file_size, created_at, updated_at) VALUES ('web_submission', 'photo', 'temporary', 'k1', 'image/png', 'p.png', 3, '', '')",
    ).run();
    await env.DB.prepare(
      "INSERT INTO media_assets (asset_scope, media_type, storage_kind, storage_key, mime_type, file_name, file_size, created_at, updated_at) VALUES ('web_submission', 'document', 'temporary', 'k2', 'application/octet-stream', 'x.bin', 3, '', '')",
    ).run();
    const photoAsset = await env.DB.prepare("SELECT id FROM media_assets WHERE storage_key = 'k1'").first<{
      id: number;
    }>();
    const docAsset = await env.DB.prepare("SELECT id FROM media_assets WHERE storage_key = 'k2'").first<{
      id: number;
    }>();
    const id = await seedSubmission(env, {
      data: {
        photos: [
          { kind: "photo", mediaAssetId: photoAsset!.id, name: "p.png" },
          { kind: "document", mediaAssetId: docAsset!.id, name: "x.bin" },
        ],
      },
    });
    /* MEDIA_KV stub:两个 key 都能读。 */
    (env as { MEDIA_KV: KVNamespace }).MEDIA_KV = {
      get: vi.fn(async (key: string) => new Uint8Array([1, 2, 3])),
    } as unknown as KVNamespace;

    const photo = await handleWebSubmissionAdmin(
      req(`/api/admin/web-submissions/media?submission=${id}&index=0`),
      new URL(`https://site.example/api/admin/web-submissions/media?submission=${id}&index=0`),
      env,
      ctx(),
    );
    expect(photo?.status).toBe(200);
    expect(photo!.headers.get("content-type")).toBe("image/png");
    expect(photo!.headers.get("content-disposition")).toBeNull();
    expect(photo!.headers.get("cache-control")).toBe("private, max-age=300");

    const doc = await handleWebSubmissionAdmin(
      req(`/api/admin/web-submissions/media?submission=${id}&index=1`),
      new URL(`https://site.example/api/admin/web-submissions/media?submission=${id}&index=1`),
      env,
      ctx(),
    );
    expect(doc?.status).toBe(200);
    expect(doc!.headers.get("content-disposition")).toContain("attachment");
  });

  it("旧迁移附件(legacy file_id)在未配 SUBMISSION_BOT_LEGACY_TOKEN 时 403", async () => {
    const env = makeEnv();
    const id = await seedSubmission(env, {
      data: { photos: [{ kind: "photo", legacyFileId: "AAA", name: "old.png" }] },
    });
    const url = new URL(`https://site.example/api/admin/web-submissions/media?submission=${id}&index=0`);
    const response = await handleWebSubmissionAdmin(req(url.pathname + url.search), url, env, ctx());
    expect(response?.status).toBe(403);
  });

  it("迁移数据的旧键名 fileId 同样被归一成 legacy 引用(不配 token 时 403,而非 404)", async () => {
    const env = makeEnv();
    const id = await seedSubmission(env, {
      data: { photos: [{ kind: "photo", fileId: "BBB", uniqueId: "u1", name: "old.jpg" }] },
    });
    const url = new URL(`https://site.example/api/admin/web-submissions/media?submission=${id}&index=0`);
    const response = await handleWebSubmissionAdmin(req(url.pathname + url.search), url, env, ctx());
    expect(response?.status).toBe(403);
  });
});
