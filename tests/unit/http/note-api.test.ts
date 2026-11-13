import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveParticipant: vi.fn(),
  checkAtomicRateLimit: vi.fn(),
  hasValidAdminSession: vi.fn(),
}));

vi.mock("../../../src/http/survey/participant", () => ({ resolveParticipant: mocks.resolveParticipant }));
vi.mock("../../../src/services/rate-limit.service", () => ({
  checkAtomicRateLimit: mocks.checkAtomicRateLimit,
  rateLimitResponse: (retryAfterSeconds: number) =>
    Response.json({ code: "rate_limited", message: "操作过于频繁" }, { status: 429 }),
}));
vi.mock("../../../src/http/admin-session", () => ({ hasValidAdminSession: mocks.hasValidAdminSession }));

import { handleNoteApiRequest } from "../../../src/http/note-api";
import type { Env } from "../../../src/index";
import { createSqliteD1, sqliteD1Available } from "../../helpers/sqlite-d1";
import { drawNote, putNote, sendMessage } from "../../../src/services/note-chat.service";

/**
 * 纸条 UGC 安全（0094）· HTTP 层：错误码 → 状态码映射（过滤命中 422）、
 * 拉黑/消息举报端点、管理端消息复核与 writeAudit。DB 用真迁移（0089 + 0094
 * + audit_logs 的最小 DDL），管理端鉴权与限流打桩。
 */
const NOTE_SCHEMA = ["0089_note_chat.sql", "0094_note_chat_safety.sql"]
  .map((file) => readFileSync(new URL(`../../../db/migrations/${file}`, import.meta.url), "utf8"))
  .join("\n");

// drawNote 读余额（getCoinAccount）、writeAudit 写审计，各给最小 DDL
//（note-chat.test.ts 同款做法），免引入整条金币/权限迁移链。
const TEST_ONLY_DDL = `
CREATE TABLE IF NOT EXISTS coin_accounts (
  participant_hash TEXT NOT NULL PRIMARY KEY,
  user_id INTEGER,
  balance INTEGER NOT NULL DEFAULT 0,
  total_earned INTEGER NOT NULL DEFAULT 0,
  total_spent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL
);
-- 纸条配图上传（/api/note/media）写 media_assets；列集合与生产 0017 对齐
--（submit-api.test.ts 同款 DDL，asset_scope CHECK 保留生产白名单）。
CREATE TABLE IF NOT EXISTS media_assets (
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
`;

describe.skipIf(!sqliteD1Available)("note-api · UGC 安全（0094）", () => {
  function makeEnv(): Env {
    return {
      DB: createSqliteD1(`PRAGMA foreign_keys = ON;\n${NOTE_SCHEMA}\n${TEST_ONLY_DDL}`),
      CACHE: {},
      // 纸条配图走 KVMediaStore（MEDIA 未配置时回落 KV）；stub 掉 kv.put 即可。
      MEDIA_KV: { put: vi.fn(async () => {}), get: vi.fn(async () => null) } as unknown as KVNamespace,
    } as unknown as Env;
  }

  function jsonRequest(path: string, method: string, body?: unknown): Request {
    return new Request(`https://example.test${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async function putNoteOk(db: D1Database, ownerHash: string, content: string): Promise<void> {
    await putNote(db, ownerHash, { gender: "x", ageBand: "25-30", region: "", content }, null);
  }

  /** 建一条「hash_b 抽中 hash_a」的会话，返回 threadId 与首条消息 id。 */
  async function makeThreadWithMessage(db: D1Database): Promise<{ threadId: number; messageId: number }> {
    await putNoteOk(db, "hash_a", "A 的纸条");
    await putNoteOk(db, "hash_b", "B 的纸条");
    const draw = await drawNote(db, "hash_b", null, "note:test-1");
    const threadId = draw && "threadId" in draw ? draw.threadId : 0;
    const message = await sendMessage(db, threadId, "hash_b", "擦边内容", null);
    return { threadId, messageId: message.id };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveParticipant.mockResolvedValue({ kind: "telegram", participantHash: "hash_b", dbUserId: null });
    mocks.checkAtomicRateLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
    mocks.hasValidAdminSession.mockResolvedValue(true);
  });

  it("POST /api/note/media MIME 规范化:声明 image/jpg(别名)的 JPEG 入库为检测 MIME image/jpeg", async () => {
    // 与答卷媒体上传（media.ts）/树洞配图同一规则：放行后入库与存储统一用
    // 检测出的规范 MIME，声明值可能是 image/jpg 这类浏览器别名。
    const env = makeEnv();
    // JPEG 魔数（SOI + JFIF APP0 头）：verifyUploadContent 按 SOI 识别为 jpeg。
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
    const form = new FormData();
    form.append("file", new File([jpeg], "photo.jpg", { type: "image/jpg" }));
    const response = await handleNoteApiRequest(
      new Request("https://example.test/api/note/media", { method: "POST", body: form }),
      env,
      new URL("https://example.test/api/note/media"),
    );
    expect(response.status).toBe(200);
    const asset = await env.DB.prepare(
      "SELECT mime_type, storage_key FROM media_assets ORDER BY id DESC LIMIT 1",
    ).first<{
      mime_type: string;
      storage_key: string | null;
    }>();
    expect(asset?.mime_type).toBe("image/jpeg");
    expect(asset?.storage_key).toMatch(/^media:note:/);
  });

  it("放纸条命中过滤 → 422 note_filter_rejected，notes 零新行", async () => {
    const env = makeEnv();
    const response = await handleNoteApiRequest(
      jsonRequest("/api/note", "POST", { gender: "x", ageBand: "25-30", region: "", content: "兼职刷单日结" }),
      env,
      new URL("https://example.test/api/note"),
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "note_filter_rejected" });
    const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM notes`).first<{ n: number }>();
    expect(Number(row?.n ?? 0)).toBe(0);
  });

  it("发消息命中过滤 → 422，note_messages 零新行", async () => {
    const env = makeEnv();
    const { threadId } = await makeThreadWithMessage(env.DB);
    const response = await handleNoteApiRequest(
      jsonRequest(`/api/note/threads/${threadId}/messages`, "POST", { body: "顺便卖点冰毒" }),
      env,
      new URL(`https://example.test/api/note/threads/${threadId}/messages`),
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "note_filter_rejected" });
    const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM note_messages`).first<{ n: number }>();
    expect(Number(row?.n ?? 0)).toBe(1); // 只有 makeThreadWithMessage 的那一条
  });

  it("拉黑端点：POST 写 note_block，DELETE 解除；限流拒绝时 429", async () => {
    const env = makeEnv();
    const { threadId } = await makeThreadWithMessage(env.DB);
    const url = new URL(`https://example.test/api/note/threads/${threadId}/block`);

    const blocked = await handleNoteApiRequest(jsonRequest(`/api/note/threads/${threadId}/block`, "POST"), env, url);
    expect(blocked.status).toBe(200);
    expect(await blocked.json()).toMatchObject({ ok: true, blocked: true });
    const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM note_block`).first<{ n: number }>();
    expect(Number(row?.n ?? 0)).toBe(1);

    const unblocked = await handleNoteApiRequest(
      jsonRequest(`/api/note/threads/${threadId}/block`, "DELETE"),
      env,
      url,
    );
    expect(await unblocked.json()).toMatchObject({ ok: true, blocked: false });
    const after = await env.DB.prepare(`SELECT COUNT(*) AS n FROM note_block`).first<{ n: number }>();
    expect(Number(after?.n ?? 0)).toBe(0);

    mocks.checkAtomicRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 120 });
    const limited = await handleNoteApiRequest(jsonRequest(`/api/note/threads/${threadId}/block`, "POST"), env, url);
    expect(limited.status).toBe(429);
  });

  it("消息举报端点：同人去重（第二次仍 reportCount=1）", async () => {
    const env = makeEnv();
    const { threadId, messageId } = await makeThreadWithMessage(env.DB);
    const path = `/api/note/threads/${threadId}/messages/${messageId}/report`;
    const first = await handleNoteApiRequest(
      jsonRequest(path, "POST", { reason: "不适" }),
      env,
      new URL(`https://example.test${path}`),
    );
    expect(await first.json()).toMatchObject({ ok: true, reportCount: 1 });
    const repeat = await handleNoteApiRequest(
      jsonRequest(path, "POST", { reason: "再报" }),
      env,
      new URL(`https://example.test${path}`),
    );
    expect(await repeat.json()).toMatchObject({ ok: true, reportCount: 1 });
    const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM note_message_reports`).first<{ n: number }>();
    expect(Number(row?.n ?? 0)).toBe(1);
  });

  it("管理端：?reported=1 聚合被举报消息；消息处置写 writeAudit；未登录 401", async () => {
    const env = makeEnv();
    const { threadId, messageId } = await makeThreadWithMessage(env.DB);
    await env.DB.prepare(
      `INSERT INTO note_message_reports (message_id, thread_id, reporter_hash, reason, created_at)
       VALUES (?, ?, 'hash_a', '不适内容', '2026-11-07T00:00:00.000Z')`,
    )
      .bind(messageId, threadId)
      .run();

    const list = await handleNoteApiRequest(
      jsonRequest("/api/note/admin/messages?reported=1", "GET"),
      env,
      new URL("https://example.test/api/note/admin/messages?reported=1"),
    );
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { messages: Array<{ id: number; reportCount: number; status: string }> };
    expect(listBody.messages).toHaveLength(1);
    expect(listBody.messages[0]).toMatchObject({ id: messageId, reportCount: 1, status: "active" });

    const hide = await handleNoteApiRequest(
      jsonRequest(`/api/note/admin/messages/${messageId}/status`, "POST", { status: "hidden" }),
      env,
      new URL(`https://example.test/api/note/admin/messages/${messageId}/status`),
    );
    expect(hide.status).toBe(200);
    const hiddenRow = await env.DB.prepare(`SELECT status FROM note_messages WHERE id = ?`)
      .bind(messageId)
      .first<{ status: string }>();
    expect(hiddenRow?.status).toBe("hidden");
    const audit = await env.DB.prepare(`SELECT action, entity_type, entity_id, after_json FROM audit_logs`).first<{
      action: string;
      entity_type: string;
      entity_id: string;
      after_json: string;
    }>();
    expect(audit).toMatchObject({
      action: "note_message.status",
      entity_type: "note_message",
      entity_id: String(messageId),
    });

    // 未带管理员会话：401，且没有写任何状态。
    mocks.hasValidAdminSession.mockResolvedValue(false);
    const denied = await handleNoteApiRequest(
      jsonRequest("/api/note/admin/messages?reported=1", "GET"),
      env,
      new URL("https://example.test/api/note/admin/messages?reported=1"),
    );
    expect(denied.status).toBe(401);
  });

  it("管理端拉黑列表：按时间倒序 + total + 每对现存会话数", async () => {
    const env = makeEnv();
    await putNoteOk(env.DB, "hash_a", "A 的纸条");
    await putNoteOk(env.DB, "hash_b", "B 的纸条");
    const draw = await drawNote(env.DB, "hash_b", null, "note:test-1");
    const threadId = draw && "threadId" in draw ? draw.threadId : 0;
    // 两对拉黑：hash_a→hash_b（与现存会话同对）、hash_x→hash_y（无会话）。
    await env.DB.prepare(
      `INSERT INTO note_block (blocker_hash, blocked_hash, created_at) VALUES ('hash_a', 'hash_b', '2026-11-10T00:00:00.000Z')`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO note_block (blocker_hash, blocked_hash, created_at) VALUES ('hash_x', 'hash_y', '2026-11-12T00:00:00.000Z')`,
    ).run();

    const list = await handleNoteApiRequest(
      jsonRequest("/api/note/admin/blocks", "GET"),
      env,
      new URL("https://example.test/api/note/admin/blocks"),
    );
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      ok: boolean;
      total: number;
      blocks: Array<{ blockerHash: string; blockedHash: string; createdAt: string; threadCount: number }>;
    };
    expect(body.ok).toBe(true);
    expect(body.total).toBe(2);
    expect(body.blocks).toHaveLength(2);
    // created_at DESC：后写的 hash_x→hash_y 在前；同对会话数按双向计数。
    expect(body.blocks[0]).toMatchObject({ blockerHash: "hash_x", blockedHash: "hash_y", threadCount: 0 });
    expect(body.blocks[1]).toMatchObject({
      blockerHash: "hash_a",
      blockedHash: "hash_b",
      createdAt: "2026-11-10T00:00:00.000Z",
      threadCount: 1,
    });
  });

  it("管理端解除拉黑：删行 + writeAudit(note_block.remove)；404/400/401 边界", async () => {
    const env = makeEnv();
    await env.DB.prepare(
      `INSERT INTO note_block (blocker_hash, blocked_hash, created_at) VALUES ('hash_a', 'hash_b', '2026-11-10T00:00:00.000Z')`,
    ).run();

    // 解除不存在的对 → 404，且不写审计。
    const missing = await handleNoteApiRequest(
      jsonRequest("/api/note/admin/blocks/unblock", "POST", { blockerHash: "hash_x", blockedHash: "hash_y" }),
      env,
      new URL("https://example.test/api/note/admin/blocks/unblock"),
    );
    expect(missing.status).toBe(404);
    // 缺参数 → 400。
    const bad = await handleNoteApiRequest(
      jsonRequest("/api/note/admin/blocks/unblock", "POST", { blockerHash: "hash_a" }),
      env,
      new URL("https://example.test/api/note/admin/blocks/unblock"),
    );
    expect(bad.status).toBe(400);
    expect(Number((await env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_logs`).first<{ n: number }>())?.n ?? 0)).toBe(
      0,
    );

    // 正常解除：行删除 + 审计含 before（拉黑时间）。
    const ok = await handleNoteApiRequest(
      jsonRequest("/api/note/admin/blocks/unblock", "POST", { blockerHash: "hash_a", blockedHash: "hash_b" }),
      env,
      new URL("https://example.test/api/note/admin/blocks/unblock"),
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true });
    const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM note_block`).first<{ n: number }>();
    expect(Number(row?.n ?? 0)).toBe(0);
    const audit = await env.DB.prepare(`SELECT action, entity_type, entity_id, before_json FROM audit_logs`).first<{
      action: string;
      entity_type: string;
      entity_id: string;
      before_json: string;
    }>();
    expect(audit).toMatchObject({
      action: "note_block.remove",
      entity_type: "note_block",
      entity_id: "hash_a->hash_b",
    });
    expect(JSON.parse(audit?.before_json ?? "{}")).toMatchObject({
      blockerHash: "hash_a",
      blockedHash: "hash_b",
      createdAt: "2026-11-10T00:00:00.000Z",
    });

    // 未带管理员会话：401。
    mocks.hasValidAdminSession.mockResolvedValue(false);
    const denied = await handleNoteApiRequest(
      jsonRequest("/api/note/admin/blocks", "GET"),
      env,
      new URL("https://example.test/api/note/admin/blocks"),
    );
    expect(denied.status).toBe(401);
  });
});
