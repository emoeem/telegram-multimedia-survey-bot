import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { fullMigrationSchema } from "../../helpers/full-schema";
import { createSqliteD1, sqliteD1Available } from "../../helpers/sqlite-d1";

/**
 * 分批发布：每一批都要能被单独读懂，部分失败必须可续发。
 *
 * 三个曾经真实发生的病症（都在这个文件里钉住）：
 *   1. caption 只挂在第一批（条件写成 `index===0 && offset===0`）——第 11 页起
 *      的消息在频道里没有问卷名、没有填写时间，读者不知道自己在看什么；
 *   2. 第 2 批失败时已发出的 message id 非空 → 不抛错 → 仍然写 published：
 *      频道只有前 10 页，后台显示"已发布"，永远不会补发；
 *   3. 发送与写 published 之间没有抢占：发送成功但写库失败 → 队列重试 → 整份
 *      相册重发一遍。
 */
const mocks = vi.hoisted(() => ({
  renderResponseReport: vi.fn(),
  buildResponseReportBundle: vi.fn(),
  addReportImages: vi.fn(),
  sendPhotoAlbum: vi.fn(),
  sendPhoto: vi.fn(),
  sendDocument: vi.fn(),
}));

vi.mock("@cloudflare/puppeteer", () => ({
  default: {
    limits: vi.fn(async () => ({
      activeSessions: [],
      maxConcurrentSessions: 4,
      allowedBrowserAcquisitions: 1,
      timeUntilNextAllowedBrowserAcquisition: 0,
    })),
    sessions: vi.fn(async () => []),
    history: vi.fn(async () => []),
    connect: vi.fn(async () => ({ close: async () => undefined })),
  },
}));

vi.mock("../../../src/services/response-report.service", () => ({
  renderResponseReport: mocks.renderResponseReport,
}));

vi.mock("../../../src/bot/survey-report", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    buildResponseReportBundle: mocks.buildResponseReportBundle,
    addReportImages: mocks.addReportImages,
  };
});

vi.mock("../../../src/bot/telegram", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    sendPhotoAlbum: mocks.sendPhotoAlbum,
    sendPhoto: mocks.sendPhoto,
    sendDocument: mocks.sendDocument,
  };
});

const {
  PUBLICATION_RESPONSE_SELECT,
  buildPublicationResponseSelect,
  loadPublicationResponseRow,
  parsePublicReportProgress,
  publicationProgressKey,
  publishPublicResponseReport,
} = await import("../../../src/services/public-report.service");

const CHAT_ID = -1002000000001;
const RESPONSE_ID = 9;
const PAGE_COUNT = 24;

function jpegPages(count: number) {
  return Array.from({ length: count }, () => ({ bytes: new Uint8Array([137, 80, 78, 71]) }));
}

let messageIdSeed = 1000;
function telegramOk(): Response {
  messageIdSeed += 1;
  return new Response(JSON.stringify({ ok: true, result: { message_id: messageIdSeed } }), { status: 200 });
}

function albumOk(photos: Array<{ bytes: Uint8Array; caption?: string }>): Response {
  const result = photos.map(() => {
    messageIdSeed += 1;
    return { message_id: messageIdSeed };
  });
  return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
}

function environment(db: D1Database) {
  return {
    DB: db,
    BOT_TOKEN: "test-token",
    BROWSER: {} as never,
    MEDIA_KV: { get: async () => null, put: async () => undefined } as unknown as KVNamespace,
  };
}

async function seed(db: D1Database) {
  await db
    .prepare(
      `INSERT INTO users (id, telegram_user_id, username, first_name, last_name, system_role, created_at, updated_at)
         VALUES (1, 900001, 'owner', '作者', '本人', 'participant', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
    )
    .run();
  await db
    .prepare(
      `INSERT INTO surveys (id, owner_id, title, status, anonymous, allow_multiple_responses, max_responses_per_user,
                            version, created_at, updated_at, published_at)
       VALUES (1, 1, '深夜问卷', 'published', 0, 1, 0, 1, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
    )
    .run();
  await db
    .prepare(
      `INSERT INTO publication_targets (id, name, target_type, chat_id, thread_id, enabled, is_default, created_at, updated_at)
       VALUES (1, '公开频道', 'telegram_topic', ?, NULL, 1, 1, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
    )
    .bind(String(CHAT_ID))
    .run();
  await db
    .prepare(
      `INSERT INTO survey_responses (id, survey_id, participant_hash, status, started_at, completed_at,
                                     report_publication_requested, report_publication_status,
                                     publish_anonymous, publish_message, version, created_at, updated_at)
       VALUES (?, 1, 'user_1', 'completed', '2026-10-29T02:00:00.000Z', '2026-10-29T02:07:31.000Z',
               1, 'pending', 1, '想说的话', 1, '2026-10-29T02:00:00.000Z', '2026-10-29T02:07:31.000Z')`,
    )
    .bind(RESPONSE_ID)
    .run();
}

function captionsOf(sendAlbum: typeof mocks.sendPhotoAlbum): string[] {
  return sendAlbum.mock.calls.map((call) => {
    const photos = call[2] as Array<{ caption?: string }>;
    return photos.map((photo) => photo.caption ?? "").find((caption) => caption.length > 0) ?? "";
  });
}

/** 迁到 0093 之前的库：没有发布锁/断点两列。 */
function schemaBefore0093(): string {
  const dir = join(process.cwd(), "db", "migrations");
  return readdirSync(dir)
    .filter((file) => file.endsWith(".sql") && file !== "0093_report_publication_progress.sql")
    .sort()
    .map((file) => readFileSync(join(dir, file), "utf8"))
    .join("\n");
}

beforeEach(() => {
  mocks.renderResponseReport.mockReset().mockResolvedValue({ format: "png", pages: jpegPages(PAGE_COUNT) });
  mocks.buildResponseReportBundle.mockReset().mockResolvedValue({ report: {} });
  mocks.addReportImages.mockReset().mockImplementation(async (_ctx: unknown, report: unknown) => report);
  mocks.sendPhotoAlbum.mockReset().mockImplementation(async (_token, _chatId, photos) => albumOk(photos));
  mocks.sendPhoto.mockReset().mockImplementation(async () => telegramOk());
  mocks.sendDocument.mockReset().mockImplementation(async () => telegramOk());
  messageIdSeed = 1000;
});

describe.skipIf(!sqliteD1Available)("公开发布的分批与断点", () => {
  it("每一批都带 caption：首批带问卷名/填写时间/留言，后续批次带问卷名/填写时间/页码", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    await seed(db);

    const outcome = await publishPublicResponseReport(environment(db), RESPONSE_ID);

    expect(outcome.pages).toBe(PAGE_COUNT);
    expect(mocks.sendPhotoAlbum).toHaveBeenCalledTimes(3);
    // 10 / 10 / 4 张一批，与 Telegram sendMediaGroup 的上限一致。
    expect(mocks.sendPhotoAlbum.mock.calls.map((call) => (call[2] as unknown[]).length)).toEqual([10, 10, 4]);

    const captions = captionsOf(mocks.sendPhotoAlbum);
    for (const caption of captions) expect(caption).not.toBe("");

    expect(captions[0]).toContain("问卷：深夜问卷");
    expect(captions[0]).toContain("填写时间：");
    expect(captions[0]).toContain("第 1–10 页，共 24 页");
    expect(captions[0]).toContain("想说的话");

    expect(captions[1]).toContain("问卷：深夜问卷");
    expect(captions[1]).toContain("填写时间：");
    expect(captions[1]).toContain("第 11–20 页，共 24 页");
    // 留言只在首批出现，不在频道里重复三遍。
    expect(captions[1]).not.toContain("想说的话");

    expect(captions[2]).toContain("第 21–24 页，共 24 页");

    const row = await db
      .prepare("SELECT report_publication_status FROM survey_responses WHERE id = ?")
      .bind(RESPONSE_ID)
      .first<{ report_publication_status: string }>();
    expect(row?.report_publication_status).toBe("published");
  });

  it("第二批失败：状态是 failed（不是 published），已发 id 与下一批 offset 都留在库里，重试只发剩下的", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    await seed(db);

    let albumCalls = 0;
    mocks.sendPhotoAlbum.mockImplementation(async (_token, _chatId, photos) => {
      albumCalls += 1;
      if (albumCalls === 2) throw new Error("telegram 500");
      return albumOk(photos);
    });

    await expect(publishPublicResponseReport(environment(db), RESPONSE_ID)).rejects.toThrow("telegram 500");

    const failed = await db
      .prepare("SELECT report_publication_status, report_publication_progress FROM survey_responses WHERE id = ?")
      .bind(RESPONSE_ID)
      .first<{ report_publication_status: string; report_publication_progress: string | null }>();
    expect(failed?.report_publication_status).toBe("failed");

    const progress = parsePublicReportProgress(failed?.report_publication_progress);
    const entry = progress?.targets[publicationProgressKey(CHAT_ID, null)];
    expect(entry).toBeDefined();
    expect(entry?.nextOffset).toBe(10);
    expect(entry?.done).toBe(false);
    expect(entry?.messageIds).toHaveLength(10);
    expect(entry?.error).toContain("telegram 500");

    // 重试：从第 11 页续发，前 10 张不重发。
    mocks.sendPhotoAlbum.mockReset().mockImplementation(async (_token, _chatId, photos) => albumOk(photos));
    await publishPublicResponseReport(environment(db), RESPONSE_ID);

    expect(mocks.sendPhotoAlbum).toHaveBeenCalledTimes(2);
    expect(mocks.sendPhotoAlbum.mock.calls.map((call) => (call[2] as unknown[]).length)).toEqual([10, 4]);

    const published = await db
      .prepare("SELECT report_publication_status, report_publication_progress FROM survey_responses WHERE id = ?")
      .bind(RESPONSE_ID)
      .first<{ report_publication_status: string; report_publication_progress: string | null }>();
    expect(published?.report_publication_status).toBe("published");
    // 断点保留：频道里这份相册的 message id 仍然可查。
    const after = parsePublicReportProgress(published?.report_publication_progress);
    // 每张图在 Telegram 里各是一条 message（24 页 → 24 个 id）。
    expect(after?.targets[publicationProgressKey(CHAT_ID, null)]?.messageIds).toHaveLength(PAGE_COUNT);
  });

  it("已被另一个消费者抢占：本次跳过，一条消息都不发（避免整份重发）", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    await seed(db);
    await db
      .prepare(
        "UPDATE survey_responses SET report_publication_claim_at = ?, report_publication_status = 'pending' WHERE id = ?",
      )
      .bind(new Date().toISOString(), RESPONSE_ID)
      .run();

    const outcome = await publishPublicResponseReport(environment(db), RESPONSE_ID);

    expect(outcome.skipped).toBe(true);
    expect(mocks.sendPhotoAlbum).not.toHaveBeenCalled();
    expect(mocks.renderResponseReport).not.toHaveBeenCalled();

    const row = await db
      .prepare("SELECT report_publication_status FROM survey_responses WHERE id = ?")
      .bind(RESPONSE_ID)
      .first<{ report_publication_status: string }>();
    expect(row?.report_publication_status).toBe("pending");
  });

  it("过期锁可以被接管（上一个消费者已经死了，不能永久卡住发布）", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    await seed(db);
    await db
      .prepare("UPDATE survey_responses SET report_publication_claim_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 20 * 60 * 1000).toISOString(), RESPONSE_ID)
      .run();

    const outcome = await publishPublicResponseReport(environment(db), RESPONSE_ID);

    expect(outcome.skipped).toBeUndefined();
    expect(mocks.sendPhotoAlbum).toHaveBeenCalledTimes(3);
  });
});

describe.skipIf(!sqliteD1Available)("老库（未 apply 0092/0093）也能发布", () => {
  it("缺列时 SELECT 退化成常量，发布照常完成（只是不能断点续发）", async () => {
    const db = createSqliteD1(schemaBefore0093());
    await db
      .prepare(
        `INSERT INTO users (id, telegram_user_id, username, first_name, last_name, system_role, created_at, updated_at)
         VALUES (1, 900001, 'owner', '作者', '本人', 'participant', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO surveys (id, owner_id, title, status, anonymous, allow_multiple_responses, max_responses_per_user,
                              version, created_at, updated_at, published_at)
         VALUES (1, 1, '深夜问卷', 'published', 0, 1, 0, 1, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO publication_targets (id, name, target_type, chat_id, thread_id, enabled, is_default, created_at, updated_at)
         VALUES (1, '公开频道', 'telegram_topic', ?, NULL, 1, 1, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
      )
      .bind(String(CHAT_ID))
      .run();
    await db
      .prepare(
        `INSERT INTO survey_responses (id, survey_id, participant_hash, status, started_at, completed_at,
                                       report_publication_requested, report_publication_status, version, created_at, updated_at)
         VALUES (?, 1, 'user_1', 'completed', '2026-10-29T02:00:00.000Z', '2026-10-29T02:07:31.000Z', 1, 'pending', 1,
                 '2026-10-29T02:00:00.000Z', '2026-10-29T02:07:31.000Z')`,
      )
      .bind(RESPONSE_ID)
      .run();

    const { row, resumable } = await loadPublicationResponseRow(db, RESPONSE_ID);
    expect(resumable).toBe(false);
    // 缺列时必须按匿名读（泄漏不可逆），而不是抛 no such column。
    expect(row?.publish_anonymous).toBe(1);
    expect(row?.publish_message).toBeNull();

    const outcome = await publishPublicResponseReport(environment(db), RESPONSE_ID);
    expect(outcome.pages).toBe(PAGE_COUNT);

    const after = await db
      .prepare("SELECT report_publication_status FROM survey_responses WHERE id = ?")
      .bind(RESPONSE_ID)
      .first<{ report_publication_status: string }>();
    expect(after?.report_publication_status).toBe("published");
  });

  it("SELECT 的两种形态与列集合一致（写死的常量与探测结果同源）", () => {
    expect(PUBLICATION_RESPONSE_SELECT).toContain("r.publish_anonymous");
    expect(PUBLICATION_RESPONSE_SELECT).toContain("r.report_publication_progress");

    const legacy = buildPublicationResponseSelect(new Set(["id"]));
    expect(legacy).toContain("1 AS publish_anonymous");
    expect(legacy).toContain("NULL AS publish_message");
    expect(legacy).toContain("NULL AS report_publication_claim_at");
    expect(legacy).toContain("NULL AS report_publication_progress");
  });
});
