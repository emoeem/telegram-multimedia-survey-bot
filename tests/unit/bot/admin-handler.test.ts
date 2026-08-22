import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUserByTelegramId: vi.fn(),
  getUserById: vi.fn(),
  listBotUsers: vi.fn(),
  setUserBan: vi.fn(),
  cancelActiveResponsesForUser: vi.fn(),
  getSurveyById: vi.fn(),
  getSurveyStatistics: vi.fn(),
  getSurveyPortfolioStatistics: vi.fn(),
  listSurveyPerformance: vi.fn(),
  handleImageGeneratorAdminMessage: vi.fn(),
  handleImageGeneratorCallback: vi.fn(),
  handleResultVisualAdminMessage: vi.fn(),
  handleResultVisualAdminCallback: vi.fn(),
  listAllSurveys: vi.fn(),
  getIdentityCardAccessSetting: vi.fn(),
  setIdentityCardAccessCode: vi.fn(),
  clearIdentityCardAccessCode: vi.fn(),
}));

vi.mock("../../../src/db/repositories/user.repository", () => ({
  getUserByTelegramId: mocks.getUserByTelegramId,
  getUserById: mocks.getUserById,
  listBotUsers: mocks.listBotUsers,
  setUserBan: mocks.setUserBan,
  cancelActiveResponsesForUser: mocks.cancelActiveResponsesForUser,
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

vi.mock("../../../src/bot/image-generator-handler", () => ({
  handleImageGeneratorAdminMessage: mocks.handleImageGeneratorAdminMessage,
  handleImageGeneratorCallback: mocks.handleImageGeneratorCallback,
}));

vi.mock("../../../src/bot/result-visual-admin-handler", () => ({
  handleResultVisualAdminMessage: mocks.handleResultVisualAdminMessage,
  handleResultVisualAdminCallback: mocks.handleResultVisualAdminCallback,
}));

vi.mock("../../../src/db/repositories/feature-access.repository", () => ({
  getIdentityCardAccessSetting: mocks.getIdentityCardAccessSetting,
  setIdentityCardAccessCode: mocks.setIdentityCardAccessCode,
  clearIdentityCardAccessCode: mocks.clearIdentityCardAccessCode,
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
      origin: "https://example.com",
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

    expect(buttonTexts).toEqual(["🌐 网页管理后台", "📋 问卷快捷操作"]);
    expect(buttonTexts).not.toContain("🎨 视觉模板");
    expect(buttonTexts).not.toContain("👥 Bot 用户");
    expect(buttonTexts).not.toContain("🔑 授权与部署");
    expect(buttonTexts).not.toContain("👤 体验创作者");
    expect(buttonTexts).not.toContain("🔐 图片生成密码");
    expect(buttonTexts).not.toContain("1. 你好（已发布）");

    const buttons = body.reply_markup.inline_keyboard.flat() as Array<{
      text: string;
      web_app?: { url: string };
    }>;
    expect(buttons[0]?.web_app?.url).toBe("https://example.com/admin");
  });

  it("lets an administrator configure the password that unlocks image generation", async () => {
    mocks.getUserByTelegramId.mockResolvedValue({ id: 1, telegramUserId: 99, systemRole: "admin" });
    mocks.getIdentityCardAccessSetting.mockResolvedValue(null);
    const cache = { get: vi.fn(), put: vi.fn(), delete: vi.fn() } as unknown as KVNamespace;
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const ctx: BotContext = { botToken: "token", db: {} as D1Database, cache, session: {} as SurveySessionNamespace, builder: {} as SurveyBuilderNamespace, adminIds: [99], exportQueue: {} as Queue };

    await handleAdminCallback(ctx, {
      id: "set", from: { id: 99 }, message: { message_id: 1, chat: { id: 2 } }, data: "admin:identity_password_set",
    });
    expect(cache.put).toHaveBeenCalledWith("admin-identity-card-password:99", "1", { expirationTtl: 15 * 60 });

    (cache.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce("1");
    await handleAdminMessage(ctx, {
      message_id: 2, chat: { id: 2 }, from: { id: 99 }, text: "safe-password",
    });
    expect(mocks.setIdentityCardAccessCode).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/^sha256:/));
  });

  it("lists only users who started the bot with compact paginated details", async () => {
    mocks.getUserByTelegramId.mockResolvedValue({ id: 1, telegramUserId: 99, systemRole: "admin" });
    mocks.listBotUsers.mockResolvedValue({
      total: 1,
      users: [{ telegramUserId: 123, firstName: "Alice", lastName: null, username: "alice", systemRole: "participant", botStartedAt: "2026-08-19T10:00:00.000Z", updatedAt: "2026-08-19T10:01:00.000Z" }],
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(handleAdminCallback({ botToken: "token", db: {} as D1Database, session: {} as SurveySessionNamespace, builder: {} as SurveyBuilderNamespace, adminIds: [99], exportQueue: {} as Queue }, {
      id: "callback", from: { id: 99 }, message: { message_id: 1, chat: { id: 2 } }, data: "admin:users:0",
    })).resolves.toBe(true);
    const editCall = fetchMock.mock.calls.find(([url]) => String(url).includes("editMessageText"));
    const body = JSON.parse(String((editCall?.[1] as RequestInit).body)) as { text: string };
    expect(body.text).toContain("已启动机器人：1 人");
    expect(body.text).toContain("ID：123 · @alice");
  });

  it("allows banning a non-admin user and cancels active responses", async () => {
    mocks.getUserByTelegramId.mockResolvedValue({ id: 1, telegramUserId: 99, systemRole: "admin" });
    mocks.getUserById.mockResolvedValue({ id: 7, telegramUserId: 123, firstName: "Alice", username: "alice", systemRole: "participant", bannedAt: null, botStartedAt: "2026-08-19T10:00:00.000Z", updatedAt: "2026-08-19T10:01:00.000Z" });
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const handled = await handleAdminCallback({ botToken: "token", db: {} as D1Database, session: {} as SurveySessionNamespace, builder: {} as SurveyBuilderNamespace, adminIds: [99], exportQueue: {} as Queue }, {
      id: "callback", from: { id: 99 }, message: { message_id: 1, chat: { id: 2 } }, data: "admin:user_ban:7",
    });
    expect(handled).toBe(true);
    expect(mocks.setUserBan).toHaveBeenCalledWith(expect.anything(), 7, { banned: true, bannedBy: 1, reason: "管理员操作" });
    expect(mocks.cancelActiveResponsesForUser).toHaveBeenCalledWith(expect.anything(), 7);
  });

  it("routes an admin background photo to the visual template editor before survey input", async () => {
    mocks.getUserByTelegramId.mockResolvedValue({
      id: 1,
      telegramUserId: 99,
      systemRole: "admin",
    });
    mocks.handleResultVisualAdminMessage.mockResolvedValue(true);
    const ctx: BotContext = {
      botToken: "token",
      db: {} as D1Database,
      cache: { get: vi.fn(), put: vi.fn(), delete: vi.fn() } as unknown as KVNamespace,
      session: {} as SurveySessionNamespace,
      builder: {} as SurveyBuilderNamespace,
      adminIds: [99],
      exportQueue: {} as Queue,
    };

    await expect(handleAdminMessage(ctx, {
      message_id: 2,
      chat: { id: 3 },
      from: { id: 99 },
      photo: [{ file_id: "background-file", file_unique_id: "background-unique", width: 1080, height: 1920 }],
    })).resolves.toBe(true);

    expect(mocks.handleImageGeneratorAdminMessage).toHaveBeenCalledOnce();
    expect(mocks.handleResultVisualAdminMessage).toHaveBeenCalledOnce();
  });

  it("limits administrator survey details to web, status, and export shortcuts", async () => {
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
        origin: "https://example.com",
      },
      {
        id: "callback",
        from: { id: 99 },
        message: { message_id: 1, chat: { id: 2 } },
        data: "admin:survey:16",
      },
    );

    expect(handled).toBe(true);
    const editMessageCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/editMessageText"),
    );
    const body = JSON.parse(
      String((editMessageCall?.[1] as RequestInit | undefined)?.body),
    ) as {
      reply_markup: {
        inline_keyboard: Array<Array<{ text: string; callback_data?: string; web_app?: { url: string } }>>;
      };
    };
    const buttons = body.reply_markup.inline_keyboard.flat();
    expect(buttons).toContainEqual({
      text: "🌐 在网页后台打开",
      web_app: { url: "https://example.com/admin/surveys/16" },
    });
    expect(buttons).toContainEqual({
      text: "⏹ 关闭问卷",
      callback_data: "admin:close:16",
    });
    expect(buttons).toContainEqual({
      text: "📦 导出数据",
      callback_data: "owner:reports:16",
    });
    expect(buttons.map((button) => button.text)).not.toContain("完成名单与答卷");
    expect(buttons.map((button) => button.text)).not.toContain("🎨 结果卡");
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
      String(url).includes("/editMessageText"),
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
    expect(body).toMatchObject({ chat_id: 2, message_id: 1 });
    expect(body.reply_markup.inline_keyboard.flat()).toContainEqual({
      text: "🔎 搜索问卷",
      callback_data: "admin:survey_search:1",
    });
  });

  it("edits the same message for admin directory pagination", async () => {
    mocks.getUserByTelegramId.mockResolvedValue({ id: 1, telegramUserId: 99, systemRole: "admin" });
    mocks.listSurveyPerformance.mockResolvedValue({
      total: 17,
      items: [{ id: 16, title: "第十七份", status: "published", ownerName: "管理员" }],
    });
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("{}", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await handleAdminCallback(
      { botToken: "token", db: {} as D1Database, session: {} as SurveySessionNamespace, builder: {} as SurveyBuilderNamespace, adminIds: [99], exportQueue: {} as Queue },
      { id: "callback", from: { id: 99 }, message: { message_id: 500, chat: { id: 2 } }, data: "admin:survey_list:1:0" },
    );

    const edit = fetchMock.mock.calls.find(([url]) => String(url).includes("/editMessageText"));
    expect(edit).toBeDefined();
    expect(JSON.parse(String(edit?.[1]?.body))).toMatchObject({ chat_id: 2, message_id: 500 });
  });

  it("uses the same message for delete confirmation", async () => {
    mocks.getUserByTelegramId.mockResolvedValue({ id: 1, telegramUserId: 99, systemRole: "admin" });
    mocks.getSurveyById.mockResolvedValue({ id: 16, title: "待删除", status: "draft" });
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("{}", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await handleAdminCallback(
      { botToken: "token", db: {} as D1Database, session: {} as SurveySessionNamespace, builder: {} as SurveyBuilderNamespace, adminIds: [99], exportQueue: {} as Queue },
      { id: "callback", from: { id: 99 }, message: { message_id: 500, chat: { id: 2 } }, data: "admin:delete_ask:16" },
    );

    const edit = fetchMock.mock.calls.find(([url]) => String(url).includes("/editMessageText"));
    expect(edit).toBeDefined();
    expect(JSON.parse(String(edit?.[1]?.body))).toMatchObject({ chat_id: 2, message_id: 500 });
  });
});
