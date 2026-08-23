import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUserByTelegramId: vi.fn(),
  getActiveResponseByUser: vi.fn(),
  getBuilderState: vi.fn(),
  completeSession: vi.fn(),
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

vi.mock("../../../src/services/session.service", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../src/services/session.service")
  >()),
  completeSession: mocks.completeSession,
}));

import {
  handleTelegramCallback,
  handleTelegramMessage,
} from "../../../src/bot/survey-handler";
import { editMessageReplyMarkup, sendMessage } from "../../../src/bot/telegram";
import type { BotContext } from "../../../src/bot/types";
import type { SurveySessionNamespace } from "../../../src/services/session.service";
import type { SurveyBuilderNamespace } from "../../../src/services/survey-builder.service";

function createContext(db?: D1Database): BotContext {
  return {
    botToken: "token",
    db: db ?? ({} as D1Database),
    session: {} as SurveySessionNamespace,
    builder: {} as SurveyBuilderNamespace,
    adminIds: [],
    exportQueue: {} as Queue,
  };
}

function createDbMock(firstResult: unknown): D1Database {
  const statement = {
    bind: vi.fn(() => statement),
    first: vi.fn(async () => firstResult),
    all: vi.fn(async () => ({ results: [] })),
    run: vi.fn(async () => ({ success: true })),
  };
  return { prepare: vi.fn(() => statement) } as unknown as D1Database;
}

function sentTexts(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls
    .map((call) => call[1] as RequestInit | undefined)
    .filter((request) => String(request?.body ?? "").includes("text"))
    .map((request) => {
      const body = JSON.parse(String(request?.body)) as { text?: string };
      return body.text ?? "";
    });
}

describe("survey answer guards", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("treats /cancel as a global cancellation instead of a text answer", async () => {
    mocks.getUserByTelegramId.mockResolvedValue({
      id: 7,
      telegramUserId: 99,
      systemRole: "participant",
    });
    mocks.getBuilderState.mockResolvedValue({ step: "idle" });
    mocks.getActiveResponseByUser.mockResolvedValue({
      id: 30,
      surveyId: 40,
      currentQuestionId: 50,
      status: "in_progress",
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await handleTelegramMessage(createContext(), {
      message_id: 1,
      chat: { id: 2 },
      from: { id: 99 },
      text: "/cancel",
    });

    const texts = sentTexts(fetchMock);
    expect(texts.some((text) => text.includes("已取消当前问卷填写"))).toBe(true);
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as {
      reply_markup: {
        inline_keyboard: Array<Array<{ callback_data: string }>>;
      };
    };
    expect(body.reply_markup.inline_keyboard.flat()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ callback_data: "home:surveys" }),
      ]),
    );
  });

  it("retries sendMessage when Telegram answers 429 with retry_after", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: false,
            description: "Too Many Requests: retry after 1",
            parameters: { retry_after: 1 },
          }),
          { status: 429 },
        ),
      )
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await sendMessage("token", 42, "hello");

    expect(response.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("treats an identical reply markup edit as a successful no-op", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: false,
          description: "Bad Request: message is not modified",
        }),
        { status: 400 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await editMessageReplyMarkup("token", 42, 1, {
      inline_keyboard: [],
    });

    expect(response.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
