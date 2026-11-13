import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getActiveShareByToken: vi.fn(),
  getActiveProfileShareByToken: vi.fn(),
  getResultProfileByResponseId: vi.fn(),
}));

vi.mock("../../../src/services/report-share.service", () => ({ getActiveShareByToken: mocks.getActiveShareByToken }));
vi.mock("../../../src/services/profile-share.service", () => ({
  getActiveProfileShareByToken: mocks.getActiveProfileShareByToken,
}));
vi.mock("../../../src/db/repositories/result-profile.repository", () => ({
  getResultProfileByResponseId: mocks.getResultProfileByResponseId,
}));

import { handleSharePageRequest } from "../../../src/http/share-api";
import type { Env } from "../../../src/index";

/**
 * 分享公开面（/r/:token 结局卡、/u/:token 个人画像）的安全投影。
 *
 * 服务层的 token 撤销/归属语义（revoked_at IS NULL 才算 active）由
 * report-share.service.test.ts / profile-share.service.test.ts 覆盖；这里证明
 * 公开面在 token 失效时的表现（404 而非 200）、白名单投影（r18 teaser、
 * 答案原文不出口）与输出编码（快照文本全部转义后才进 HTML）。
 *
 * DB 沿用仓内惯例：按 SQL 特征路由的假 D1。
 */
function makeDb(routes: Array<[RegExp, unknown]>, log?: string[]): D1Database {
  return {
    prepare(sql: string) {
      log?.push(sql);
      const statement = {
        bind() {
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
}

function makeEnv(routes: Array<[RegExp, unknown]>, overrides: Partial<Env> = {}): Env {
  return { DB: makeDb(routes), ...overrides } as unknown as Env;
}

/** result_profiles 的序列化行（mapResultProfile 输出的 ResultProfile 形状）。 */
function profileSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: 9,
    surveyId: 12,
    responseId: 55,
    resultType: "guardian",
    schemaVersion: 1,
    title: "守夜人",
    subtitle: "你看守了整夜的真相",
    fieldsJson: "{}",
    statsJson: "[]",
    tagsJson: JSON.stringify(["沉稳", "可靠"]),
    // images_json 是对象结构（按 slot 索引），不是数组：写错形状会被
    // deserializeResultProfile 拒绝并整体退回分享行快照。
    imagesJson: "{}",
    metadataJson: JSON.stringify({ agreement: { score: 4, total: 5 } }),
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...overrides,
  };
}

function shareRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 3,
    token: "tok_abcd",
    responseId: 55,
    participantHash: "tg_700",
    surveyId: 12,
    resultType: "guardian",
    resultTitle: "守夜人",
    surveyTitle: "性格测试",
    contentRating: "all",
    viewCount: 0,
    revokedAt: null,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("share 公开面 · token 生命周期与白名单投影", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getResultProfileByResponseId.mockResolvedValue(profileSnapshot());
  });

  it("撤销/未知 token → 404 且 no-store：失效链接对爬虫与预览立即表现为 404", async () => {
    mocks.getActiveShareByToken.mockResolvedValue(null);
    const env = makeEnv([]);
    const response = await handleSharePageRequest(
      new Request("https://example.test/r/gone"),
      env,
      new URL("https://example.test/r/gone"),
    );
    expect(response?.status).toBe(404);
    expect(response?.headers.get("Cache-Control")).toBe("no-store");
    const html = await response?.text();
    expect(html).toContain("不存在或已被作者撤销");
    // 投影失败时不落任何答卷数据。
    expect(html).not.toContain("守夜人");
    expect(mocks.getActiveShareByToken).toHaveBeenCalledWith(env.DB, "gone");
  });

  it("画像撤销同理：/u/:token 不存在 → 404", async () => {
    mocks.getActiveProfileShareByToken.mockResolvedValue(null);
    const env = makeEnv([]);
    const response = await handleSharePageRequest(
      new Request("https://example.test/u/gone"),
      env,
      new URL("https://example.test/u/gone"),
    );
    expect(response?.status).toBe(404);
    expect(await response?.text()).toContain("不存在或已撤销");
  });

  it("有效 token → 200 结局卡：只投影快照字段，浏览量 +1", async () => {
    mocks.getActiveShareByToken.mockResolvedValue(shareRow());
    const sqlLog: string[] = [];
    const env = {
      DB: makeDb(
        [
          [/SELECT completed_at FROM survey_responses/, { completed_at: "2026-11-01T00:00:00.000Z" }],
          [/UPDATE report_shares SET view_count/, null],
        ],
        sqlLog,
      ),
    } as unknown as Env;
    const response = await handleSharePageRequest(
      new Request("https://example.test/r/tok_abcd"),
      env,
      new URL("https://example.test/r/tok_abcd"),
    );
    expect(response?.status).toBe(200);
    const html = await response?.text();
    // 白名单投影：结局名 / 副标题 / tags / 默契得分可以出现。
    expect(html).toContain("守夜人");
    expect(html).toContain("你看守了整夜的真相");
    expect(html).toContain("沉稳");
    expect(html).toContain("默契 4/5");
    // CTA 指回问卷公开页。
    expect(html).toContain('href="/s/12"');
    // 浏览量计数发生了（UPDATE report_shares 的轻量 D1 写）。
    expect(sqlLog.some((sql) => /UPDATE report_shares SET view_count/.test(sql))).toBe(true);
  });

  it("快照文本中的 HTML 被转义：结局名/副标题不能注入 <script> 或事件属性", async () => {
    mocks.getActiveShareByToken.mockResolvedValue(shareRow({ surveyTitle: "《<svg onload=alert(2)>》" }));
    mocks.getResultProfileByResponseId.mockResolvedValue(
      profileSnapshot({
        title: "<img src=x onerror=alert(1)>",
        subtitle: "<script>alert(3)</script>",
        tagsJson: JSON.stringify(["<b>粗体</b>"]),
      }),
    );
    const env = makeEnv([
      [/SELECT completed_at FROM survey_responses/, { completed_at: null }],
      [/UPDATE report_shares SET view_count/, null],
    ]);
    const response = await handleSharePageRequest(
      new Request("https://example.test/r/tok_abcd"),
      env,
      new URL("https://example.test/r/tok_abcd"),
    );
    const html = await response?.text();
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<svg onload");
    // 转义后的实体仍在页面上（内容没有丢失，只是不再被当成标记执行）。
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;script&gt;alert(3)&lt;/script&gt;");
    expect(html).toContain("&lt;b&gt;粗体&lt;/b&gt;");
  });

  it("r18 快照 → teaser 形态：结局名/副标题/tags/默契全部不出口", async () => {
    mocks.getActiveShareByToken.mockResolvedValue(shareRow({ contentRating: "r18" }));
    const env = makeEnv([
      [/SELECT completed_at FROM survey_responses/, { completed_at: "2026-11-01T00:00:00.000Z" }],
      [/UPDATE report_shares SET view_count/, null],
    ]);
    const response = await handleSharePageRequest(
      new Request("https://example.test/r/tok_abcd"),
      env,
      new URL("https://example.test/r/tok_abcd"),
    );
    expect(response?.status).toBe(200);
    const html = await response?.text();
    // teaser 文案与 18+ 徽章出现。
    expect(html).toContain("达成隐藏结局");
    expect(html).toContain("18+");
    // r18 语义下任何可能暗示内容的数据都不出口。
    expect(html).not.toContain("守夜人");
    expect(html).not.toContain("你看守了整夜的真相");
    expect(html).not.toContain("沉稳");
    expect(html).not.toContain("默契");
  });

  it("og.png 无 BROWSER 绑定 → 404 og_unavailable，退化到纯文字预览", async () => {
    mocks.getActiveShareByToken.mockResolvedValue(shareRow());
    const env = makeEnv([]); // 无 CACHE、无 BROWSER
    const response = await handleSharePageRequest(
      new Request("https://example.test/r/tok_abcd/og.png"),
      env,
      new URL("https://example.test/r/tok_abcd/og.png"),
    );
    expect(response?.status).toBe(404);
    await expect(response?.json()).resolves.toMatchObject({ code: "og_unavailable" });
  });

  it("画像页只投影统计数字，displayName 的 HTML 被转义", async () => {
    mocks.getActiveProfileShareByToken.mockResolvedValue({
      id: 5,
      token: "u_tok",
      participantHash: "tg_700",
      displayName: "<script>alert(9)</script>",
      snapshot: {
        completedSurveys: 3,
        achievements: 2,
        achievementTitles: [],
        endingsCollected: 4,
        trialBestScore: 300,
        trialRuns: 5,
        since: "2026-01-01T00:00:00.000Z",
      },
      viewCount: 0,
      revokedAt: null,
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
    });
    const env = makeEnv([[/UPDATE profile_shares SET view_count/, null]]);
    const response = await handleSharePageRequest(
      new Request("https://example.test/u/u_tok"),
      env,
      new URL("https://example.test/u/u_tok"),
    );
    expect(response?.status).toBe(200);
    const html = await response?.text();
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;alert(9)&lt;/script&gt;");
    expect(html).toContain("完成问卷");
    // 成就标题列表（achievementTitles）不在画像公开面投影里。
    expect(html).not.toContain("achievementTitles");
  });
});
