import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUserByTelegramId: vi.fn(),
  getSurveyById: vi.fn(),
  getSurveyStatistics: vi.fn(),
  getSurveyPortfolioStatistics: vi.fn(),
  listSurveyPerformance: vi.fn(),
  listAllSurveys: vi.fn(),
}));

vi.mock("../../../src/db/repositories/user.repository", () => ({
  getUserByTelegramId: mocks.getUserByTelegramId,
}));

vi.mock("../../../src/db/repositories/survey.repository", () => ({
  deleteSurvey: vi.fn(),
  getSurveyById: mocks.getSurveyById,
  listAllSurveys: mocks.listAllSurveys,
  updateSurveyStatus: vi.fn(),
}));

vi.mock("../../../src/services/statistics.service", () => ({
  getSurveyStatistics: mocks.getSurveyStatistics,
  getSurveyPortfolioStatistics: mocks.getSurveyPortfolioStatistics,
  listSurveyPerformance: mocks.listSurveyPerformance,
}));

import {
  handleAdminCallback,
  handleAdminMessage,
} from "../../../src/bot/admin-handler";
import type { BotContext } from "../../../src/bot/types";
import type { SurveySessionNamespace } from "../../../src/services/session.service";
import type { SurveyBuilderNamespace } from "../../../src/services/survey-builder.service";

describe("admin survey list", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows a compact management home instead of every survey action", async () => {
    mocks.getUserByTelegramId.mockResolvedValue({
      id: 1,
      telegramUserId: 99,
      systemRole: "admin",
    });
    mocks.listAllSurveys.mockResolvedValue([
      { id: 16, title: "你好", status: "published" },
      { id: 8, title: "第二份", status: "draft" },
    ]);

    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const ctx: BotContext = {
      botToken: "token",
      db: {} as D1Database,
      session: {} as SurveySessionNamespace,
      builder: {} as SurveyBuilderNamespace,
      adminIds: [99],
      exportQueue: {} as Queue,
    };

    await handleAdminMessage(ctx, {
      message_id: 1,
      chat: { id: 2 },
      from: { id: 99 },
      text: "/admin",
    });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as {
      reply_markup: {
        inline_keyboard: Array<Array<{ text: string }>>;
      };
    };
    const buttonTexts = body.reply_markup.inline_keyboard
      .flat()
      .map((button) => button.text);

    expect(buttonTexts).toContain("📋 全部问卷");
    expect(buttonTexts).toContain("🔑 授权与部署");
    expect(buttonTexts).toContain("👤 体验创作者");
    expect(buttonTexts).not.toContain("发放 365 天");
    expect(buttonTexts).not.toContain("1. 你好（已发布）");
  });

  it("gives administrators response browsing and export actions", async () => {
    mocks.getUserByTelegramId.mockResolvedValue({
      id: 1,
      telegramUserId: 99,
      systemRole: "admin",
    });
    mocks.getSurveyById.mockResolvedValue({
      id: 16,
      title: "他人的问卷",
      status: "published",
    });
    mocks.getSurveyStatistics.mockResolvedValue({
      totalStarted: 8,
      totalCompleted: 2,
      completionRate: 25,
    });
    mocks.listAllSurveys.mockResolvedValue([
      { id: 16, title: "他人的问卷", status: "published" },
    ]);

    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const handled = await handleAdminCallback(
      {
        botToken: "token",
        db: {} as D1Database,
        session: {} as SurveySessionNamespace,
        builder: {} as SurveyBuilderNamespace,
        adminIds: [99],
        exportQueue: {} as Queue,
      },
      {
        id: "callback",
        from: { id: 99 },
        message: { message_id: 1, chat: { id: 2 } },
        data: "admin:survey:16",
      },
    );

    expect(handled).toBe(true);
    const sendMessageCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/sendMessage"),
    );
    const body = JSON.parse(
      String((sendMessageCall?.[1] as RequestInit | undefined)?.body),
    ) as {
      reply_markup: {
        inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
      };
    };
    const buttons = body.reply_markup.inline_keyboard.flat();
    expect(buttons).toContainEqual({
      text: "完成名单与答卷",
      callback_data: "owner:responses:16:0",
    });
    expect(buttons).toContainEqual({
      text: "CSV",
      callback_data: "owner:export:csv:16",
    });
  });

  it("keeps aggregate metrics while simplifying individual survey rows", async () => {
    mocks.getUserByTelegramId.mockResolvedValue({
      id: 1,
      telegramUserId: 99,
      systemRole: "admin",
    });
    mocks.getSurveyPortfolioStatistics.mockResolvedValue({
      totalSurveys: 18,
      publishedSurveys: 12,
      totalStarted: 90,
      totalCompleted: 45,
    });
    mocks.listSurveyPerformance.mockResolvedValue({
      total: 18,
      items: [{
        id: 16,
        title: "报名问卷",
        status: "published",
        ownerName: "管理员",
        totalStarted: 20,
        totalCompleted: 12,
        inProgress: 8,
        completionRate: 60,
        lastCompletedAt: "2026-08-15T15:30:00.000Z",
      }],
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const handled = await handleAdminCallback(
      {
        botToken: "token",
        db: {} as D1Database,
        session: {} as SurveySessionNamespace,
        builder: {} as SurveyBuilderNamespace,
        adminIds: [99],
        exportQueue: {} as Queue,
      },
      {
        id: "callback",
        from: { id: 99 },
        message: { message_id: 1, chat: { id: 2 } },
        data: "admin:overview",
      },
    );

    expect(handled).toBe(true);
    const request = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/sendMessage"),
    );
    const body = JSON.parse(String((request?.[1] as RequestInit).body)) as {
      text: string;
      reply_markup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
    };
    expect(body.text).toContain("✅ 45 份已完成 / 90 次开始");
    expect(body.text).not.toContain("✅ 12 完成");
    expect(body.reply_markup.inline_keyboard.flat()).toContainEqual({
      text: "🟢 报名问卷",
      callback_data: "admin:survey:16",
    });
    expect(body.reply_markup.inline_keyboard.flat()).toContainEqual({
      text: "🔎 搜索问卷",
      callback_data: "admin:survey_search:1",
    });
  });
});
