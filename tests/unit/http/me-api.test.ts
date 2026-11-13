import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveParticipant: vi.fn(),
  loadSystemSettings: vi.fn(),
  getPublishedGalleryProfile: vi.fn(),
  loadAchievementOverview: vi.fn(),
  markAchievementsSeen: vi.fn(),
  syncShowcasePersonFromProfile: vi.fn(),
  upsertReportShare: vi.fn(),
  revokeReportShare: vi.fn(),
}));

vi.mock("../../../src/http/survey/participant", () => ({ resolveParticipant: mocks.resolveParticipant }));
vi.mock("../../../src/services/system-settings.service", () => ({ loadSystemSettings: mocks.loadSystemSettings }));
vi.mock("../../../src/services/profile-gallery.service", () => ({
  getPublishedGalleryProfile: mocks.getPublishedGalleryProfile,
}));
vi.mock("../../../src/services/achievement.service", () => ({
  loadAchievementOverview: mocks.loadAchievementOverview,
  markAchievementsSeen: mocks.markAchievementsSeen,
}));
vi.mock("../../../src/services/showcase-profile.service", () => ({
  syncShowcasePersonFromProfile: mocks.syncShowcasePersonFromProfile,
}));
vi.mock("../../../src/services/report-share.service", () => ({
  upsertReportShare: mocks.upsertReportShare,
  revokeReportShare: mocks.revokeReportShare,
}));

import { handleMeApiRequest } from "../../../src/http/me-api";
import type { Env } from "../../../src/index";

/**
 * 「我的」聚合接口：四条统计查询 + 展示页软连接。
 *
 * DB 用一个按 SQL 前缀路由的假 D1：接口本身只关心结果形状，真实 SQL 已由
 * 各自的仓库测试覆盖。
 */
function makeDb(routes: Array<[RegExp, unknown]>): D1Database {
  return {
    prepare(sql: string) {
      const statement = {
        bind() {
          return statement;
        },
        async first() {
          const matched = routes.find(([pattern]) => pattern.test(sql));
          return matched ? matched[1] : null;
        },
        async all() {
          // 0082 的并集查询（participant_hash_links / IN 列表）走 all。
          const matched = routes.find(([pattern]) => pattern.test(sql));
          return { results: matched && Array.isArray(matched[1]) ? matched[1] : [] };
        },
        async run() {
          return { meta: { changes: 0, last_row_id: 0 } };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}

function makeEnv(routes: Array<[RegExp, unknown]>, cache?: ReturnType<typeof makeCache>): Env {
  return { DB: makeDb(routes), CACHE: cache } as unknown as Env;
}

/** KV（CACHE binding）打桩：unread-count 的 60s 边缘缓存读写走这里。 */
function makeCache() {
  const store = new Map<string, string>();
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
}

const TELEGRAM_PARTICIPANT = {
  kind: "telegram",
  participantHash: "tg_700",
  dbUserId: 7,
  telegramUserId: 700,
};

const OVERVIEW_ROUTES: Array<[RegExp, unknown]> = [
  // 0082：hashesFor 的映射查询（无映射 → 空 source 集合，并集=当前 hash 本身）。
  [/FROM participant_hash_links/, { results: [] }],
  // 顺序敏感：completed 与 gallery 两条都来自 survey_responses，用各自的特征
  // 片段区分（IN 并集的是 overview 聚合；= ? 的是 showcase 草稿的旧式归属查询）。
  [/FROM survey_responses\s+WHERE participant_hash IN[^]*?status = 'completed'/, { completed: 3 }],
  [/WHERE participant_hash IN[^]*?gallery_published = 1/, { id: 55 }],
  [/WHERE participant_hash = \? AND gallery_published = 1/, { id: 55 }],
  [/FROM task_runs WHERE participant_hash IN/, { runs: 2, completed: 1, bestScore: 300 }],
  [/FROM showcase_persons WHERE response_id = \?/, { id: 9, published: 0 }],
];

describe("me overview API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveParticipant.mockResolvedValue(TELEGRAM_PARTICIPANT);
    mocks.loadSystemSettings.mockResolvedValue({ profileGallerySurveyId: 12 });
    mocks.upsertReportShare.mockResolvedValue({
      id: 3,
      token: "tok_ok",
      responseId: 55,
      participantHash: "tg_700",
      surveyId: 12,
      resultType: null,
      resultTitle: null,
      surveyTitle: "性格测试",
      contentRating: "all",
      viewCount: 0,
      revokedAt: null,
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
    });
    mocks.revokeReportShare.mockResolvedValue(true);
    mocks.getPublishedGalleryProfile.mockResolvedValue({
      responseId: 55,
      surveyId: 12,
      owner: { telegramUserId: 700, username: "asha", firstName: "阿沙", lastName: null },
      showUsername: true,
      publishedAt: "2026-10-01T00:00:00.000Z",
      createdAt: "2026-10-01T00:00:00.000Z",
      images: [],
      fields: [{ questionId: 1, title: "你的昵称", value: "夜航" }],
    });
    mocks.loadAchievementOverview.mockResolvedValue({ unlocked: 2, total: 13, unseen: 1, items: [] });
    mocks.markAchievementsSeen.mockResolvedValue(1);
    mocks.syncShowcasePersonFromProfile.mockResolvedValue({ personId: 9, created: true, published: false });
  });

  it("aggregates identity, surveys, profile, trial, badges and the showcase link", async () => {
    const env = makeEnv(OVERVIEW_ROUTES);
    const response = await handleMeApiRequest(
      new Request("https://example.test/api/me/overview"),
      env,
      new URL("https://example.test/api/me/overview"),
    );
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({
      identity: { telegram: true, email: false, emailMasked: null },
      completedSurveys: 3,
      profileSurveyId: 12,
      myProfile: { responseId: 55, heading: "夜航", publishedAt: "2026-10-01T00:00:00.000Z" },
      trial: { runs: 2, completed: 1, bestScore: 300 },
      achievements: { unlocked: 2, total: 13, unseen: 1, items: [] },
      showcase: { personId: 9, published: false },
    });
  });

  it("marks badges as seen for the current participant", async () => {
    const env = makeEnv([]);
    const response = await handleMeApiRequest(
      new Request("https://example.test/api/me/achievements/seen", { method: "POST" }),
      env,
      new URL("https://example.test/api/me/achievements/seen"),
    );
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({ ok: true, marked: 1 });
    expect(mocks.markAchievementsSeen).toHaveBeenCalledWith(env.DB, "tg_700");
  });

  /* ---- T2 · 未读角标端点（单条 COUNT + 60s KV 边缘缓存） ---- */

  const UNREAD_ROUTE: Array<[RegExp, unknown]> = [
    [/FROM notifications WHERE participant_hash = \? AND read_at IS NULL/, { n: 5 }],
  ];

  it("unread-count 返回单条 COUNT 并预热 60s KV 缓存（键含 hash）", async () => {
    const cache = makeCache();
    const env = makeEnv(UNREAD_ROUTE, cache);
    const response = await handleMeApiRequest(
      new Request("https://example.test/api/me/notifications/unread-count"),
      env,
      new URL("https://example.test/api/me/notifications/unread-count"),
    );
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({ unread: 5 });
    expect(cache.put).toHaveBeenCalledWith("notif:unread:v1:tg_700", "5", { expirationTtl: 60 });
  });

  it("unread-count 缓存命中短路：不再打 DB，put 也不再发生", async () => {
    const cache = makeCache();
    cache.store.set("notif:unread:v1:tg_700", "2"); // 旧于 DB 的 5，命中即回
    const env = makeEnv(UNREAD_ROUTE, cache);
    const response = await handleMeApiRequest(
      new Request("https://example.test/api/me/notifications/unread-count"),
      env,
      new URL("https://example.test/api/me/notifications/unread-count"),
    );
    await expect(response?.json()).resolves.toEqual({ unread: 2 });
    expect(cache.put).not.toHaveBeenCalled();
    expect(cache.get).toHaveBeenCalledWith("notif:unread:v1:tg_700");
  });

  it("seen 清未读后失效 unread-count 缓存，角标重拉不会拿到旧值", async () => {
    const cache = makeCache();
    cache.store.set("notif:unread:v1:tg_700", "5");
    const env = makeEnv([], cache);
    const response = await handleMeApiRequest(
      new Request("https://example.test/api/me/notifications/seen", { method: "POST" }),
      env,
      new URL("https://example.test/api/me/notifications/seen"),
    );
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({ ok: true, marked: 0 });
    expect(cache.delete).toHaveBeenCalledWith("notif:unread:v1:tg_700");
    expect(cache.store.has("notif:unread:v1:tg_700")).toBe(false);
  });

  it("creates the showcase draft from the published profile", async () => {
    const env = makeEnv(OVERVIEW_ROUTES);
    const response = await handleMeApiRequest(
      new Request("https://example.test/api/me/showcase", { method: "POST" }),
      env,
      new URL("https://example.test/api/me/showcase"),
    );
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({
      showcase: { personId: 9, created: true, published: false, url: "/showcase?p=9" },
    });
    expect(mocks.syncShowcasePersonFromProfile).toHaveBeenCalledWith(
      env.DB,
      expect.objectContaining({ responseId: 55 }),
      {
        ownerUserId: 7,
      },
    );
  });

  it("refuses to build a showcase page without a published profile", async () => {
    const env = makeEnv([]);
    const response = await handleMeApiRequest(
      new Request("https://example.test/api/me/showcase", { method: "POST" }),
      env,
      new URL("https://example.test/api/me/showcase"),
    );
    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toMatchObject({ code: "profile_required" });
    expect(mocks.syncShowcasePersonFromProfile).not.toHaveBeenCalled();
  });
});

/* ---- 报告找回与结局卡分享（审计 1B · IDOR 面） ----
 *
 * /api/me/reports* 的归属判定全部基于服务端解析出的 participantHash。这里证明
 * 三件事：他人 response_id 换进路径拿不到任何数据（404 且不建分享）、归属查询
 * 绑定的是服务端 hash 而非客户端可控值、报告 token 有 30 天有效期。token 的
 * 过期/篡改/跨 response 拒绝细节由 report-access-token.service.test.ts 覆盖。
 */

/** 与 makeDb 相同的路由风格，但记录 bind 参数：IDOR 测试要直接看到归属查询
 * 绑定了什么。fake D1 的既有约定（按 SQL 特征路由）保持不变。 */
function makeDbWithBinds(routes: Array<[RegExp, unknown]>): {
  db: D1Database;
  binds: Array<{ sql: string; args: unknown[] }>;
} {
  const binds: Array<{ sql: string; args: unknown[] }> = [];
  const db: D1Database = {
    prepare(sql: string) {
      const statement = {
        bind(...args: unknown[]) {
          binds.push({ sql, args });
          return statement;
        },
        async first() {
          const matched = routes.find(([pattern]) => pattern.test(sql));
          return matched ? matched[1] : null;
        },
        async all() {
          const matched = routes.find(([pattern]) => pattern.test(sql));
          return { results: matched && Array.isArray(matched[1]) ? matched[1] : [] };
        },
        async run() {
          return { meta: { changes: 1, last_row_id: 0 } };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
  return { db, binds };
}

/** surveys 表的最小行：me-api 的分享卡路径只读 title/contentRating。
 * 字段名与 admin-api.test.ts 的 surveyRow() 同一张表。 */
function surveyRowLite(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 12,
    owner_id: 7,
    title: "性格测试",
    status: "published",
    deleted_at: null,
    content_rating: "all",
    ...overrides,
  };
}

describe("me reports · 归属与结局卡分享", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveParticipant.mockResolvedValue(TELEGRAM_PARTICIPANT);
    mocks.upsertReportShare.mockResolvedValue({
      id: 3,
      token: "tok_ok",
      responseId: 55,
      participantHash: "tg_700",
      surveyId: 12,
      resultType: null,
      resultTitle: null,
      surveyTitle: "性格测试",
      contentRating: "all",
      viewCount: 0,
      revokedAt: null,
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
    });
    mocks.revokeReportShare.mockResolvedValue(true);
  });

  it("GET /api/me/reports 只列本人答卷，每条现铸 30 天期 HMAC token", async () => {
    const { db } = makeDbWithBinds([
      // 0082 hash 并集：无映射 → 只有当前 hash 本身。
      [/FROM participant_hash_links/, null],
      [
        /FROM survey_responses r\s+JOIN surveys/,
        [{ responseId: 55, surveyId: 12, completedAt: "2026-11-01T00:00:00.000Z", title: "性格测试" }],
      ],
    ]);
    const env = { DB: db, WEBHOOK_SECRET: "whsec-test" } as unknown as Env;
    const response = await handleMeApiRequest(
      new Request("https://example.test/api/me/reports"),
      env,
      new URL("https://example.test/api/me/reports"),
    );
    expect(response?.status).toBe(200);
    const body = (await response?.json()) as {
      reports: Array<{ responseId: number; reportUrl: string; pdfUrl: string }>;
    };
    expect(body.reports).toHaveLength(1);
    // token 形如 {expiresAt}.{hmac}：签名 64 位十六进制，30 天后过期。
    const t = decodeURIComponent(body.reports[0]!.reportUrl.split("t=")[1]!);
    const [expiresAt, signature] = t.split(".");
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
    const now = Math.floor(Date.now() / 1000);
    expect(Number(expiresAt)).toBeGreaterThan(now);
    expect(Number(expiresAt)).toBeLessThanOrEqual(now + 30 * 24 * 3600 + 5);
    // pdfUrl 复用同一 token：同一答卷同一有效期，不给重复铸造的机会。
    expect(body.reports[0]!.pdfUrl.split("t=")[1]).toBe(body.reports[0]!.reportUrl.split("t=")[1]);
  });

  it("POST /api/me/reports/88/share 他人答卷 → 404，归属查询绑定服务端 hash，不建分享", async () => {
    const { db, binds } = makeDbWithBinds([
      [/FROM participant_hash_links/, null],
      // 88 号答卷属于别人：归属查询（id + participant_hash 双条件）查不到行。
      [/FROM survey_responses\s+WHERE id = \? AND participant_hash IN/, null],
    ]);
    const env = { DB: db, WEBHOOK_SECRET: "whsec-test" } as unknown as Env;
    const response = await handleMeApiRequest(
      new Request("https://example.test/api/me/reports/88/share", { method: "POST" }),
      env,
      new URL("https://example.test/api/me/reports/88/share"),
    );
    expect(response?.status).toBe(404);
    await expect(response?.json()).resolves.toMatchObject({ code: "report_not_found" });
    expect(mocks.upsertReportShare).not.toHaveBeenCalled();
    // 归属判定绑定服务端解析出的身份：response_id 来自路径（88），
    // participant_hash 来自 resolveParticipant（tg_700），二者都不经请求体注入。
    const owned = binds.find((entry) => /WHERE id = \? AND participant_hash IN/.test(entry.sql));
    expect(owned?.args).toEqual([88, "tg_700"]);
  });

  it("POST /api/me/reports/55/share 本人答卷 → 200 创建结局卡，快照取创建时刻", async () => {
    const { db } = makeDbWithBinds([
      [/FROM participant_hash_links/, null],
      [/FROM survey_responses\s+WHERE id = \? AND participant_hash IN/, { id: 55, surveyId: 12 }],
      [/FROM surveys WHERE id = \? AND deleted_at IS NULL/, surveyRowLite()],
      [/FROM result_profiles WHERE response_id = \?/, null],
    ]);
    const env = { DB: db, WEBHOOK_SECRET: "whsec-test" } as unknown as Env;
    const response = await handleMeApiRequest(
      new Request("https://example.test/api/me/reports/55/share", { method: "POST" }),
      env,
      new URL("https://example.test/api/me/reports/55/share"),
    );
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({
      share: { url: "/r/tok_ok", ogUrl: "/r/tok_ok/og.png", createdAt: "2026-11-01T00:00:00.000Z", viewCount: 0 },
    });
    expect(mocks.upsertReportShare).toHaveBeenCalledWith(
      env.DB,
      expect.objectContaining({
        responseId: 55,
        surveyId: 12,
        participantHash: "tg_700",
        surveyTitle: "性格测试",
        contentRating: "all",
      }),
    );
  });

  it("POST share 的分级快照取问卷当前值：r18 问卷的结局卡带 r18 标记", async () => {
    const { db } = makeDbWithBinds([
      [/FROM participant_hash_links/, null],
      [/FROM survey_responses\s+WHERE id = \? AND participant_hash IN/, { id: 55, surveyId: 12 }],
      [/FROM surveys WHERE id = \? AND deleted_at IS NULL/, surveyRowLite({ content_rating: "r18" })],
      [/FROM result_profiles WHERE response_id = \?/, null],
    ]);
    const env = { DB: db, WEBHOOK_SECRET: "whsec-test" } as unknown as Env;
    const response = await handleMeApiRequest(
      new Request("https://example.test/api/me/reports/55/share", { method: "POST" }),
      env,
      new URL("https://example.test/api/me/reports/55/share"),
    );
    expect(response?.status).toBe(200);
    // r18 快照在创建时刻定格：之后即使问卷改回全龄，公开面也按 r18 处理
    // （share-api 的 teaser 投影测试见 share-api.test.ts）。
    expect(mocks.upsertReportShare).toHaveBeenCalledWith(env.DB, expect.objectContaining({ contentRating: "r18" }));
  });

  it("DELETE /api/me/reports/:id/share 撤销只针对本人 hash 下的分享", async () => {
    const { db } = makeDbWithBinds([]);
    const env = { DB: db, WEBHOOK_SECRET: "whsec-test" } as unknown as Env;
    const response = await handleMeApiRequest(
      new Request("https://example.test/api/me/reports/88/share", { method: "DELETE" }),
      env,
      new URL("https://example.test/api/me/reports/88/share"),
    );
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({ ok: true, revoked: true });
    // 服务层的归属条件（response_id + participant_hash 双条件、revoked_at IS NULL）
    // 由 report-share.service.test.ts 覆盖；这里证明 handler 传的是服务端身份。
    expect(mocks.revokeReportShare).toHaveBeenCalledWith(env.DB, 88, "tg_700");
  });
});
