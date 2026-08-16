import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUserByTelegramId: vi.fn(),
  getActiveResponseByUser: vi.fn(),
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

import { handleTelegramMessage } from "../../../src/bot/survey-handler";
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
});
