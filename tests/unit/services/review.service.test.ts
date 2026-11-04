import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const telegramMocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
}));

vi.mock("../../../src/bot/telegram", () => ({
  sendMessage: telegramMocks.sendMessage,
}));

import { approveWebSubmission, rejectWebSubmission } from "../../../src/services/submit/review.service";
import { loadWebSubmitFormSetting } from "../../../src/services/submit/form-config";
import { createSqliteD1, sqliteD1Available } from "../../helpers/sqlite-d1";

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
`;

const describeIf = sqliteD1Available ? describe : describe.skip;

async function makeDb(): Promise<D1Database> {
  const db = createSqliteD1(SCHEMA);
  await db
    .prepare(
      "INSERT INTO web_submissions (id, nickname, data, status, created_at, updated_at) VALUES (1, '小明', '{}', 'pending', 1000, 1000)",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO web_submissions (id, nickname, data, status, created_at, updated_at) VALUES (2, '小红', '{}', 'pending', 1000, 1000)",
    )
    .run();
  return db;
}

const ENV = { BOT_TOKEN: "test-token", DB: null as unknown as D1Database };

beforeEach(() => {
  telegramMocks.sendMessage.mockReset();
  telegramMocks.sendMessage.mockResolvedValue(new Response(JSON.stringify({ result: { message_id: 77 } })));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describeIf("投稿审核共享服务", () => {
  it("通过：翻状态、给作者留言、按配置推送频道并回填链接", async () => {
    const db = await makeDb();
    const config = await loadWebSubmitFormSetting(db);
    // 不原地改配置：loadWebSubmitFormSetting 无设置行时返回共享默认对象，
    // 原地改会泄漏进其他用例。
    const outcome = await approveWebSubmission({ ...ENV, DB: db }, db, { ...config, publishChannelId: "-100123" }, 1);
    // 链接沿用原有格式：剥掉 -100 前缀得到 t.me/c/<id> 形态。
    expect(outcome).toEqual({ ok: true, link: "https://t.me/c/123/77" });

    const row = await db.prepare("SELECT status FROM web_submissions WHERE id = 1").first<{ status: string }>();
    expect(row?.status).toBe("published");
    const thread = await db
      .prepare("SELECT text FROM web_submission_threads WHERE submission_id = 1 ORDER BY id DESC LIMIT 1")
      .first<{ text: string }>();
    expect(thread?.text).toContain("已通过审核");
    expect(telegramMocks.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("配置话题时卡片带 message_thread_id 与 HTML 解析模式发出", async () => {
    const db = await makeDb();
    const config = await loadWebSubmitFormSetting(db);
    const outcome = await approveWebSubmission(
      { ...ENV, DB: db },
      db,
      { ...config, publishChannelId: "-1004497177255", publishThreadId: "6016" },
      1,
    );
    expect(outcome.ok).toBe(true);
    const call = telegramMocks.sendMessage.mock.calls[0] as unknown[];
    expect(call[1]).toBe(-1004497177255);
    expect(call[4]).toBe(6016); // messageThreadId
    expect(call[5]).toBe("HTML");
  });

  it("未配置 publishChannelId：通过成功但不推送、链接为空", async () => {
    const db = await makeDb();
    const config = await loadWebSubmitFormSetting(db);
    const outcome = await approveWebSubmission({ ...ENV, DB: db }, db, config, 1);
    expect(outcome).toEqual({ ok: true, link: null });
    expect(telegramMocks.sendMessage).not.toHaveBeenCalled();
  });

  it("频道推送失败不回滚通过状态", async () => {
    const db = await makeDb();
    telegramMocks.sendMessage.mockRejectedValue(new Error("telegram down"));
    const config = await loadWebSubmitFormSetting(db);
    const outcome = await approveWebSubmission({ ...ENV, DB: db }, db, { ...config, publishChannelId: "-100123" }, 1);
    expect(outcome.ok).toBe(true);
    const row = await db.prepare("SELECT status FROM web_submissions WHERE id = 1").first<{ status: string }>();
    expect(row?.status).toBe("published");
  });

  it("并发保护：已发布后再通过返回 already_published", async () => {
    const db = await makeDb();
    const config = await loadWebSubmitFormSetting(db);
    await approveWebSubmission({ ...ENV, DB: db }, db, config, 1);
    const again = await approveWebSubmission({ ...ENV, DB: db }, db, config, 1);
    expect(again).toEqual({ ok: false, code: "already_published" });
  });

  it("驳回：带理由转告作者；再驳返回 already_rejected", async () => {
    const db = await makeDb();
    const outcome = await rejectWebSubmission(db, 2, "重复投稿");
    expect(outcome.ok).toBe(true);
    const row = await db.prepare("SELECT status FROM web_submissions WHERE id = 2").first<{ status: string }>();
    expect(row?.status).toBe("rejected");
    const thread = await db
      .prepare("SELECT text FROM web_submission_threads WHERE submission_id = 2 ORDER BY id DESC LIMIT 1")
      .first<{ text: string }>();
    expect(thread?.text).toContain("重复投稿");

    const again = await rejectWebSubmission(db, 2, "再来一次");
    expect(again).toEqual({ ok: false, code: "already_rejected" });
  });

  it("不存在的投稿返回 not_found", async () => {
    const db = await makeDb();
    const config = await loadWebSubmitFormSetting(db);
    expect(await approveWebSubmission({ ...ENV, DB: db }, db, config, 999)).toEqual({ ok: false, code: "not_found" });
    expect(await rejectWebSubmission(db, 999, "")).toEqual({ ok: false, code: "not_found" });
  });
});
