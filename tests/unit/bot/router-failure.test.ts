import { afterEach, describe, expect, it, vi } from "vitest";

import type { BotContext } from "../../../src/bot/types";
import type { SurveySessionNamespace } from "../../../src/services/session.service";
import type { SurveyBuilderNamespace } from "../../../src/services/survey-builder.service";

/**
 * A handler failure must surface as `TelegramUpdateHandledError` so the webhook
 * releases the update_id claim (and Telegram can redeliver) instead of marking
 * a failed action as done. The user-facing notice is still sent exactly once.
 */
vi.mock("../../../src/bot/survey-handler", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/bot/survey-handler")>();
  return {
    ...actual,
    handleTelegramMessage: vi.fn(async () => {
      throw new Error("message handler boom");
    }),
    handleTelegramCallback: vi.fn(async () => {
      throw new Error("callback handler boom");
    }),
  };
});

const { handleTelegramUpdate, isTelegramUpdateHandledError } = await import("../../../src/bot/router");

function createDbMock(): D1Database {
  const statement = {
    bind: vi.fn(() => statement),
    first: vi.fn(async () => ({
      id: 1,
      telegram_user_id: 99,
      username: null,
      first_name: null,
      last_name: null,
      language_code: null,
      system_role: "participant",
      created_at: "2026-08-14T00:00:00.000Z",
      updated_at: "2026-08-14T00:00:00.000Z",
    })),
    run: vi.fn(async () => ({ success: true })),
    all: vi.fn(async () => ({ results: [] })),
  };
  return { prepare: vi.fn(() => statement) } as unknown as D1Database;
}

function createContext(): BotContext {
  return {
    botToken: "test-token",
    db: createDbMock(),
    session: {} as SurveySessionNamespace,
    builder: {} as SurveyBuilderNamespace,
    adminIds: [],
    exportQueue: {} as Queue,
  };
}

describe("handleTelegramUpdate failure signalling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rethrows a message failure as a handled error after notifying once", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      handleTelegramUpdate(
        {
          update_id: 11,
          message: { message_id: 1, chat: { id: 42 }, from: { id: 99 }, text: "hi" },
        },
        createContext(),
      ),
    ).rejects.toSatisfy(isTelegramUpdateHandledError);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/sendMessage");
  });

  it("rethrows a callback failure as a handled error after answering once", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      handleTelegramUpdate(
        {
          update_id: 12,
          callback_query: { id: "cb", from: { id: 42 }, data: "pressed" },
        },
        createContext(),
      ),
    ).rejects.toSatisfy(isTelegramUpdateHandledError);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/answerCallbackQuery");
  });
});
