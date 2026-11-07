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
`;

describe.skipIf(!sqliteD1Available)("note-api · UGC 安全（0094）", () => {
  function makeEnv(): Env {
    return {
      DB: createSqliteD1(`PRAGMA foreign_keys = ON;\n${NOTE_SCHEMA}\n${TEST_ONLY_DDL}`),
      CACHE: {},
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
});
