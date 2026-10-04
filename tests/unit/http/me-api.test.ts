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
        async run() {
          return { meta: { changes: 0, last_row_id: 0 } };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}

function makeEnv(routes: Array<[RegExp, unknown]>): Env {
  return { DB: makeDb(routes) } as unknown as Env;
}

const TELEGRAM_PARTICIPANT = {
  kind: "telegram",
  participantHash: "tg_700",
  dbUserId: 7,
  telegramUserId: 700,
};

const OVERVIEW_ROUTES: Array<[RegExp, unknown]> = [
  [/FROM survey_responses\s+WHERE participant_hash = \? AND status = 'completed'/, { completed: 3 }],
  [/WHERE participant_hash = \? AND gallery_published = 1/, { id: 55 }],
  [/FROM task_runs WHERE participant_hash = \?/, { runs: 2, completed: 1, bestScore: 300 }],
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
      identity: { telegram: true },
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
    expect(mocks.syncShowcasePersonFromProfile).toHaveBeenCalledWith(env.DB, expect.objectContaining({ responseId: 55 }), {
      ownerUserId: 7,
    });
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
