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

  it("stays silent for plain group chatter and never registers the sender", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = createContext();
    const prepare = vi.fn(() => {
      throw new Error("group chatter must not touch the database");
    });
    ctx.db = { prepare } as unknown as D1Database;

    await handleTelegramUpdate(
      {
        update_id: 3,
        message: {
          message_id: 11,
          chat: { id: -1004497177255, type: "supergroup", title: "天地一家大爱盟" },
          from: { id: 99 },
          text: "你好",
        },
      },
      ctx,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });

  it("answers an @-mention in a group with the group hint and no menu", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/getMe")) {
        return new Response(JSON.stringify({ ok: true, result: { id: 777, username: "hnhgggfj_bot" } }), {
          status: 200,
        });
      }
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const ctx = createContext();
    // 独立的 botToken：chat-addressing 会按 token 记忆 getMe 结果
    ctx.botToken = "group-mention-token";

    await handleTelegramUpdate(
      {
        update_id: 4,
        message: {
          message_id: 12,
          chat: { id: -1004497177255, type: "supergroup", title: "天地一家大爱盟" },
          from: { id: 99 },
          text: "@hnhgggfj_bot 你好",
          entities: [{ type: "mention", offset: 0, length: "@hnhgggfj_bot".length }],
        },
      },
      ctx,
    );

    const sendCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes("/sendMessage"));
    expect(sendCalls).toHaveLength(1);
    const body = JSON.parse(String((sendCalls[0]?.[1] as RequestInit).body));
    expect(body.text).toContain("/set_publish_target");
    expect(body.text).toContain("https://t.me/hnhgggfj_bot");
    expect(body.reply_markup).toBeUndefined();
  });

  it("refuses a callback coming from a group chat", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await handleTelegramUpdate(
      {
        update_id: 5,
        callback_query: {
          id: "cb-group",
          from: { id: 99 },
          data: "home:menu",
          message: {
            message_id: 13,
            chat: { id: -1004497177255, type: "supergroup", title: "天地一家大爱盟" },
            from: { id: 777 },
          },
        },
      },
      createContext(),
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain("/answerCallbackQuery");
    expect(JSON.parse(String((init as RequestInit).body)).text).toBe("请在私聊里使用本机器人");
  });
});
