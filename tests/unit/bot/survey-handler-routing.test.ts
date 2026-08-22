import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUserByTelegramId: vi.fn(),
  getActiveResponseByUser: vi.fn(),
  getResponseById: vi.fn(),
  getSurveyResultVisualSettings: vi.fn(),
  requestConfiguredResultVisual: vi.fn(),
  getBuilderState: vi.fn(),
  handleBuilderMessage: vi.fn(),
  listMySurveys: vi.fn(),
  hasActiveCreatorTrial: vi.fn(),
}));

vi.mock("../../../src/db/repositories/user.repository", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../src/db/repositories/user.repository")
  >()),
  getUserByTelegramId: mocks.getUserByTelegramId,
}));

vi.mock("../../../src/db/repositories/response.repository", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../src/db/repositories/response.repository")
  >()),
  getActiveResponseByUser: mocks.getActiveResponseByUser,
  getResponseById: mocks.getResponseById,
}));

vi.mock("../../../src/db/repositories/survey-result-visual-settings.repository", () => ({
  getSurveyResultVisualSettings: mocks.getSurveyResultVisualSettings,
}));

vi.mock("../../../src/services/result-visual.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/services/result-visual.service")>()),
  requestConfiguredResultVisual: mocks.requestConfiguredResultVisual,
}));

vi.mock("../../../src/services/survey-builder.service", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../src/services/survey-builder.service")
  >()),
  getBuilderState: mocks.getBuilderState,
}));

vi.mock("../../../src/services/survey.service", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../src/services/survey.service")
  >()),
  listMySurveys: mocks.listMySurveys,
}));

vi.mock("../../../src/bot/builder-handler", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/bot/builder-handler")>()),
  handleBuilderMessage: mocks.handleBuilderMessage,
}));

vi.mock("../../../src/db/repositories/creator-trial.repository", () => ({
  hasActiveCreatorTrial: mocks.hasActiveCreatorTrial,
}));

import {
  handleTelegramCallback,
  handleTelegramMessage,
} from "../../../src/bot/survey-handler";
import type { BotContext } from "../../../src/bot/types";
import type { SurveySessionNamespace } from "../../../src/services/session.service";
import type { SurveyBuilderNamespace } from "../../../src/services/survey-builder.service";

describe("survey message routing", () => {
  beforeEach(() => {
    mocks.hasActiveCreatorTrial.mockResolvedValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("routes an option label edit before an active survey answer", async () => {
    mocks.getUserByTelegramId.mockResolvedValue({
      id: 7,
      telegramUserId: 99,
      systemRole: "admin",
    });
    mocks.getBuilderState.mockResolvedValue({
      step: "edit_option_label",
    });
    mocks.getActiveResponseByUser.mockResolvedValue({
      id: 30,
      surveyId: 40,
      currentQuestionId: 50,
      status: "in_progress",
    });
    mocks.handleBuilderMessage.mockResolvedValue(true);

    const prepare = vi.fn(() => {
      throw new Error("answer routing should not query the survey");
    });
    const ctx: BotContext = {
      botToken: "token",
      db: { prepare } as unknown as D1Database,
      session: {} as SurveySessionNamespace,
      builder: {} as SurveyBuilderNamespace,
      adminIds: [99],
      exportQueue: {} as Queue,
    };

    await handleTelegramMessage(ctx, {
      message_id: 1,
      chat: { id: 2 },
      from: { id: 99 },
      text: "新的选项名称",
    });

    expect(mocks.handleBuilderMessage).toHaveBeenCalledOnce();
    expect(prepare).not.toHaveBeenCalled();
  });

  it("still opens the home screen when stale interaction cleanup fails", async () => {
    mocks.getUserByTelegramId.mockResolvedValue({
      id: 7,
      telegramUserId: 88,
      systemRole: "participant",
    });
    mocks.getActiveResponseByUser.mockResolvedValue({
      id: 30,
      surveyId: 40,
      currentQuestionId: null,
      status: "in_progress",
    });
    const cache = {
      delete: vi.fn().mockRejectedValue(new Error("stale state cleanup failed")),
    } as unknown as KVNamespace;
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await handleTelegramMessage(
      {
        botToken: "token",
        db: { prepare: vi.fn(() => ({ bind: vi.fn(() => ({ run: vi.fn() })) })) } as unknown as D1Database,
        cache,
        session: {} as SurveySessionNamespace,
        builder: {} as SurveyBuilderNamespace,
        adminIds: [],
        exportQueue: {} as Queue,
      },
      {
        message_id: 2,
        chat: { id: 3 },
        from: { id: 88 },
        text: "/start",
      },
    );

    const sendCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/sendMessage"));
    expect(sendCall).toBeDefined();
    expect(JSON.parse(String((sendCall?.[1] as RequestInit).body)).text).toContain("欢迎使用问卷机器人");
  });

  it("shows a password management menu without requiring an internal id", async () => {
    mocks.getUserByTelegramId.mockResolvedValue({
      id: 7,
      telegramUserId: 88,
      systemRole: "participant",
    });
    mocks.listMySurveys.mockResolvedValue([
      {
        id: 16,
        ownerId: 7,
        title: "已经设置密码的问卷",
        status: "published",
        accessCode: "hashed",
      },
      {
        id: 8,
        ownerId: 7,
        title: "还没有密码的问卷",
        status: "draft",
        accessCode: null,
      },
    ]);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await handleTelegramMessage(
      {
        botToken: "token",
        db: {} as D1Database,
        session: {} as SurveySessionNamespace,
        builder: {} as SurveyBuilderNamespace,
        adminIds: [],
        exportQueue: {} as Queue,
      },
      {
        message_id: 2,
        chat: { id: 3 },
        from: { id: 88 },
        text: "/passwords",
      },
    );

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as {
      text: string;
      reply_markup: {
        inline_keyboard: Array<
          Array<{ text: string; callback_data: string }>
        >;
      };
    };
    const buttons = body.reply_markup.inline_keyboard.flat();

    expect(body.text).toContain("问卷访问密码");
    expect(buttons).toContainEqual({
      text: "🔐 已保护 · 已经设置密码的问卷",
      callback_data: "owner:access_view:16",
    });
    expect(buttons).toContainEqual({
      text: "🔓 未设置 · 还没有密码的问卷",
      callback_data: "owner:access_view:8",
    });
  });

  it("queues a participant-owned result card and edits the existing completion UI", async () => {
    mocks.getUserByTelegramId.mockResolvedValue({
      id: 7,
      telegramUserId: 88,
      systemRole: "participant",
    });
    mocks.getResponseById.mockResolvedValue({
      id: 31,
      surveyId: 40,
      userId: 7,
      status: "completed",
    });
    mocks.getSurveyResultVisualSettings.mockResolvedValue({
      surveyId: 40,
      enabled: true,
      autoGenerate: false,
      templateId: 5,
      updatedAt: "now",
    });
    mocks.requestConfiguredResultVisual.mockResolvedValue({
      status: "queued",
      job: { id: 9 },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await handleTelegramCallback(
      {
        botToken: "token",
        db: {} as D1Database,
        session: {} as SurveySessionNamespace,
        builder: {} as SurveyBuilderNamespace,
        adminIds: [],
        exportQueue: {} as Queue,
      },
      {
        id: "callback",
        from: { id: 88 },
        message: { message_id: 500, chat: { id: 3 } },
        data: "rv:generate:31",
      },
    );

    expect(mocks.requestConfiguredResultVisual).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ responseId: 31, chatId: 3, requestedBy: 7 }),
    );
    const editCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/editMessageText"));
    expect(editCall).toBeDefined();
    expect(JSON.parse(String((editCall?.[1] as RequestInit).body))).toMatchObject({
      chat_id: 3,
      message_id: 500,
      text: "🎨 正在生成你的结果卡。生成完成后会直接发送 PNG 图片。",
    });
  });

  it("rejects JSON import before an ordinary participant enters the builder", async () => {
    mocks.getUserByTelegramId.mockResolvedValue({
      id: 7,
      telegramUserId: 88,
      systemRole: "participant",
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await handleTelegramMessage(
      {
        botToken: "token",
        db: {} as D1Database,
        session: {} as SurveySessionNamespace,
        builder: {} as SurveyBuilderNamespace,
        adminIds: [],
        exportQueue: {} as Queue,
      },
      {
        message_id: 3,
        chat: { id: 4 },
        from: { id: 88 },
        text: "/import",
      },
    );

    expect(mocks.handleBuilderMessage).not.toHaveBeenCalled();
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as { text: string };
    expect(body.text).toBe("你没有创建或导入问卷的权限。");
  });

  it("does not advertise creator commands to ordinary participants", async () => {
    mocks.getUserByTelegramId.mockResolvedValue({
      id: 7,
      telegramUserId: 88,
      systemRole: "participant",
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await handleTelegramMessage(
      {
        botToken: "token",
        db: {} as D1Database,
        session: {} as SurveySessionNamespace,
        builder: {} as SurveyBuilderNamespace,
        adminIds: [],
        exportQueue: {} as Queue,
      },
      {
        message_id: 4,
        chat: { id: 5 },
        from: { id: 88 },
        text: "/help",
      },
    );

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as { text: string };
    expect(body.text).toContain("浏览问卷");
    expect(body.text).not.toContain("/create");
    expect(body.text).not.toContain("/import");
    expect(body.text).toContain("@meiebhiebot");
  });

  it("keeps creator shortcuts focused on my surveys and the web admin", async () => {
    mocks.getUserByTelegramId.mockResolvedValue({
      id: 7,
      telegramUserId: 99,
      systemRole: "admin",
    });
    mocks.getActiveResponseByUser.mockResolvedValue(null);
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await handleTelegramMessage(
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
        message_id: 5,
        chat: { id: 6 },
        from: { id: 99 },
        text: "/help",
      },
    );

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as {
      text: string;
      reply_markup: { inline_keyboard: Array<Array<{ text: string }>> };
    };
    const buttonTexts = body.reply_markup.inline_keyboard.flat().map((button) => button.text);
    expect(body.text).toContain("网页后台");
    expect(buttonTexts).toContain("🌐 网页管理后台");
    expect(buttonTexts).toContain("我的问卷");
    expect(buttonTexts).toContain("管理员中心");
    expect(buttonTexts).not.toContain("创建与导入");
  });

  it("edits the current public survey list message when changing pages", async () => {
    mocks.getUserByTelegramId.mockResolvedValue({
      id: 7,
      telegramUserId: 88,
      systemRole: "participant",
    });
    const statement = {
      bind: vi.fn(() => statement),
      first: vi.fn(async () => ({ count: 9 })),
      all: vi.fn(async () => ({
        results: [{ id: 9, title: "第九份问卷", description: null, access_code: null, completed_count: 0 }],
      })),
    };
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("{}"),
    );
    vi.stubGlobal("fetch", fetchMock);

    await handleTelegramCallback(
      {
        botToken: "token",
        db: { prepare: vi.fn(() => statement) } as unknown as D1Database,
        session: {} as SurveySessionNamespace,
        builder: {} as SurveyBuilderNamespace,
        adminIds: [],
        exportQueue: {} as Queue,
      },
      {
        id: "callback-1",
        from: { id: 88 },
        data: "public:list:1:latest",
        message: { message_id: 100, chat: { id: 3 } },
      },
    );

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/editMessageText");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      chat_id: 3,
      message_id: 100,
    });
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/answerCallbackQuery");
  });
});
