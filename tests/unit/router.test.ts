import { afterEach, describe, expect, it, vi } from "vitest";

import { handleTelegramUpdate } from "../../src/bot/router";
import type { BotContext } from "../../src/bot/types";
import type { SurveySessionNamespace } from "../../src/services/session.service";
import type { SurveyBuilderNamespace } from "../../src/services/survey-builder.service";

interface StatementMock {
  bind: ReturnType<typeof vi.fn>;
  first: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
  all: ReturnType<typeof vi.fn>;
}

function createDbMock(): D1Database {
  const statement: StatementMock = {
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

  return {
    prepare: vi.fn(() => statement),
  } as unknown as D1Database;
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

describe("handleTelegramUpdate", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends a text response for a message", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await handleTelegramUpdate(
      {
        update_id: 1,
        message: {
          message_id: 10,
          chat: { id: 42 },
          from: { id: 99 },
          text: "/surveys",
        },
      },
      createContext(),
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/sendMessage");
  });

  it("answers a callback query", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await handleTelegramUpdate(
      {
        update_id: 2,
        callback_query: {
          id: "cb-1",
          from: { id: 42 },
          data: "pressed",
        },
      },
      createContext(),
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/answerCallbackQuery");
  });
});
