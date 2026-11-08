import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveParticipant: vi.fn(),
  loadSystemSettings: vi.fn(),
  getPublishedGalleryProfile: vi.fn(),
  loadAchievementOverview: vi.fn(),
  markAchievementsSeen: vi.fn(),
  syncShowcasePersonFromProfile: vi.fn(),
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
