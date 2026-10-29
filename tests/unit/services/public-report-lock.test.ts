import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { fullMigrationSchema } from "../../helpers/full-schema";
import { createSqliteD1, sqliteD1Available } from "../../helpers/sqlite-d1";

/**
 * 发布锁的三条纪律（都是真实会发生的竞态，在这里钉住）：
 *   1. 锁被**新鲜**持有时，第二次发布尝试必须拿到 skipped——两个消费者并发发
 *      同一份相册，频道里就是两份；
 *   2. 锁**过期**（持有者已死）必须可被接管，否则一份答卷永久卡在 pending；
 *   3. 断点/终态写入必须带 CAS（WHERE claim_at = 本次凭据）：锁易主后继续写，
 *      会把新持锁者的 nextOffset 覆盖回退、同一批相册发两遍。
 *
 * 同时钉住公开面的身份边界：报告图片页眉（RESPONDENT 字段）在匿名时是「匿名」、
 * 实名时只有姓名/@username——**绝不**出现数字 Telegram ID（它可被精确检索一个人，
 * 用户只同意公开名字）。
 */
const mocks = vi.hoisted(() => ({
  renderResponseReport: vi.fn(),
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

vi.mock("../../../src/bot/telegram", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    sendPhotoAlbum: mocks.sendPhotoAlbum,
    sendPhoto: mocks.sendPhoto,
    sendDocument: mocks.sendDocument,
  };
});

const { PublicationLockLostError, publishPublicResponseReport } =
  await import("../../../src/services/public-report.service");

const CHAT_ID = -1002000000002;
const RESPONSE_ID = 9;
const PAGE_COUNT = 12;

function jpegPages(count: number) {
  return Array.from({ length: count }, () => ({ bytes: new Uint8Array([137, 80, 78, 71]) }));
}

let messageIdSeed = 5000;
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

/**
 * 第 `stealOn` 次断点写入（report_publication_progress 的 UPDATE）执行前，把库里
 * 的锁改写成别人的凭据——模拟「本消费者还在发，锁被 admin 重投/接管者抢走」。
 * 之后本消费者的 CAS 写入（WHERE claim_at = 旧凭据）应命中 0 行。
 */
function dbWithLockTakeover(db: D1Database, responseId: number, stealOn: number) {
  let progressWrites = 0;
  let stolen = false;
  const proxy = {
    prepare(sql: string) {
      if (!stolen && /report_publication_progress=\?/.test(sql)) {
        progressWrites += 1;
        if (progressWrites >= stealOn) {
          stolen = true;
          db.prepare("UPDATE survey_responses SET report_publication_claim_at='2026-01-01T00:00:00.000Z' WHERE id=?")
            .bind(responseId)
            .run();
        }
      }
      return db.prepare(sql);
    },
    batch: (items: D1PreparedStatement[]) => db.batch(items),
    exec: (query: string) => db.exec(query),
  } as unknown as D1Database;
  return { db: proxy, wasStolen: () => stolen };
}

async function seed(db: D1Database, options: { anonymous: boolean; withUser?: boolean; claimAt?: string | null }) {
  await db
    .prepare(
      `INSERT INTO users (id, telegram_user_id, username, first_name, last_name, system_role, created_at, updated_at)
         VALUES (7, 900002, 'publisher', '公', '开', 'participant', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
    )
    .run();
  await db
    .prepare(
      `INSERT INTO surveys (id, owner_id, title, status, anonymous, allow_multiple_responses, max_responses_per_user,
                            version, created_at, updated_at, published_at)
       VALUES (1, 7, '深夜问卷', 'published', 0, 1, 0, 1, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
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
      `INSERT INTO survey_responses (id, survey_id, user_id, participant_hash, status, started_at, completed_at,
                                     report_publication_requested, report_publication_status,
                                     report_publication_claim_at,
                                     publish_anonymous, publish_message, version, created_at, updated_at)
       VALUES (?, 1, ?, 'user_1', 'completed', '2026-10-29T02:00:00.000Z', '2026-10-29T02:07:31.000Z',
               1, 'pending', ?, ?, '想说的话', 1, '2026-10-29T02:00:00.000Z', '2026-10-29T02:07:31.000Z')`,
    )
    .bind(
      RESPONSE_ID,
      options.withUser && !options.anonymous ? 7 : null,
      options.claimAt ?? null,
      options.anonymous ? 1 : 0,
    )
    .run();
}

async function publicationRow(db: D1Database) {
  return db
    .prepare("SELECT report_publication_status, report_publication_claim_at FROM survey_responses WHERE id = ?")
    .bind(RESPONSE_ID)
    .first<{ report_publication_status: string; report_publication_claim_at: string | null }>();
}

/** 页眉（RESPONDENT 字段）拿的是 renderResponseReport 收到的 report 对象。 */
function renderedRespondent(): string | undefined {
  const report = mocks.renderResponseReport.mock.calls[0]?.[1] as { respondent?: string } | undefined;
  return report?.respondent;
}

beforeEach(() => {
  mocks.renderResponseReport.mockReset().mockResolvedValue({ format: "png", pages: jpegPages(PAGE_COUNT) });
  mocks.sendPhotoAlbum.mockReset().mockImplementation(async (_token, _chatId, photos) => albumOk(photos));
  mocks.sendPhoto.mockReset().mockImplementation(async () => albumOk([{ bytes: new Uint8Array([1]) }]));
  mocks.sendDocument.mockReset().mockImplementation(async () => new Response("{}", { status: 200 }));
  messageIdSeed = 5000;
});

describe.skipIf(!sqliteD1Available)("公开发布的锁与身份边界", () => {
  it("匿名答卷：报告页眉是「匿名」，绝无数字 Telegram ID", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    await seed(db, { anonymous: true });

    const outcome = await publishPublicResponseReport(environment(db), RESPONSE_ID);

    expect(outcome.skipped).toBeFalsy();
    expect(renderedRespondent()).toBe("匿名");
    const caption = (mocks.sendPhotoAlbum.mock.calls[0]?.[2] as Array<{ caption?: string }>).find(
      (photo) => (photo.caption ?? "").length > 0,
    )?.caption;
    expect(caption).toContain("填写者：匿名");
    expect(caption).not.toContain("900002");
  });

  it("实名答卷：报告页眉只有姓名，不带 @username 之外的任何身份、更没有数字 ID", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    await seed(db, { anonymous: false, withUser: true });

    const outcome = await publishPublicResponseReport(environment(db), RESPONSE_ID);

    expect(outcome.skipped).toBeFalsy();
    const respondent = renderedRespondent();
    expect(respondent).toBe("公 开");
    expect(respondent).not.toContain("Telegram ID");
    expect(respondent).not.toContain("900002");
  });

  it("锁被新鲜持有时：第二次尝试拿到 skipped，什么都不发", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    await seed(db, { anonymous: true, claimAt: new Date().toISOString() });

    const outcome = await publishPublicResponseReport(environment(db), RESPONSE_ID);

    expect(outcome.skipped).toBe(true);
    expect(mocks.sendPhotoAlbum).not.toHaveBeenCalled();
    const row = await publicationRow(db);
    expect(row?.report_publication_status).toBe("pending");
  });

  it("锁已过期（持有者已死）：可被接管，发布照常完成", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    const stale = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    await seed(db, { anonymous: true, claimAt: stale });

    const outcome = await publishPublicResponseReport(environment(db), RESPONSE_ID);

    expect(outcome.skipped).toBeFalsy();
    expect(outcome.pages).toBe(PAGE_COUNT);
    const row = await publicationRow(db);
    expect(row?.report_publication_status).toBe("published");
    expect(row?.report_publication_claim_at).toBeNull();
  });

  it("锁发送中途易主：CAS 写入抛 PublicationLockLostError，立即停手、不覆盖别人的断点", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    await seed(db, { anonymous: true });
    const { db: guarded, wasStolen } = dbWithLockTakeover(db, RESPONSE_ID, 2);

    let caught: unknown = null;
    try {
      await publishPublicResponseReport(environment(guarded), RESPONSE_ID);
    } catch (error) {
      caught = error;
    }

    expect(wasStolen()).toBe(true);
    expect(caught).toBeInstanceOf(PublicationLockLostError);
    // 第一批已发出（已无法收回），第二批必须没有继续发。
    expect(mocks.sendPhotoAlbum).toHaveBeenCalledTimes(1);
    // 我们没有抢写终态：状态仍是 pending，锁是小偷的凭据——由它写下终态。
    const row = await publicationRow(db);
    expect(row?.report_publication_status).toBe("pending");
    expect(row?.report_publication_claim_at).toBe("2026-01-01T00:00:00.000Z");
    // 断点没有被我们的旧凭据覆盖回退（page 记账仍在）。
    const progress = await db
      .prepare("SELECT report_publication_progress FROM survey_responses WHERE id = ?")
      .bind(RESPONSE_ID)
      .first<{ report_publication_progress: string }>();
    expect(JSON.parse(progress?.report_publication_progress ?? "{}")).toMatchObject({ pages: PAGE_COUNT });
  });

  it("锁定值与迁移 SQL 一致：0093 的列参与全部 CAS 条件", async () => {
    // 防回归锚：谁要是把 CAS 条件从这几条 SQL 里删掉，这条先红。
    const migration = readFileSync("db/migrations/0093_report_publication_progress.sql", "utf8");
    expect(migration).toContain("report_publication_claim_at");
    expect(PublicationLockLostError).toBeDefined();
  });
});
