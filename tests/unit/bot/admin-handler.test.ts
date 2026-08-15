import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUserByTelegramId: vi.fn(),
  getSurveyById: vi.fn(),
  getSurveyStatistics: vi.fn(),
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

  it("shows contiguous display positions without exposing database ids", async () => {
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

    expect(buttonTexts).toContain("1. 你好（已发布）");
    expect(buttonTexts).toContain("2. 第二份（草稿）");
    expect(buttonTexts.join(" ")).not.toContain("#16");
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
      text: "查看答卷",
      callback_data: "owner:responses:16:0",
    });
    expect(buttons).toContainEqual({
      text: "CSV",
      callback_data: "owner:export:csv:16",
    });
  });
});
