import { afterEach, describe, expect, it, vi } from "vitest";

import { renderUiScreen } from "../../../src/bot/ui";
import type { BotContext } from "../../../src/bot/types";
import type { UiSessionNamespace } from "../../../src/services/ui-session.service";

function uiNamespace(states: unknown[]): UiSessionNamespace {
  const stub = {
    fetch: vi.fn(async () => new Response(JSON.stringify(states.shift() ?? {}))),
  };
  return {
    idFromName: vi.fn(() => ({})),
    get: vi.fn(() => stub),
  } as unknown as UiSessionNamespace;
}

function context(ui: UiSessionNamespace): BotContext {
  return {
    botToken: "token",
    db: {} as D1Database,
    session: {} as BotContext["session"],
    ui,
    builder: {} as BotContext["builder"],
    adminIds: [],
    exportQueue: {} as Queue,
  };
}

describe("UI screen renderer", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("edits the existing UI message for navigation", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("{}"),
    );
    vi.stubGlobal("fetch", fetchMock);

    await renderUiScreen(
      context(uiNamespace([
        { messageId: 100, screen: "survey_list", screenState: {}, stack: [], version: 1 },
        { messageId: 100, screen: "survey_list", screenState: {}, stack: [], version: 2 },
      ])),
      42,
      99,
      {
        screen: "survey_list",
        text: "第 2/2 页",
        replyMarkup: { inline_keyboard: [[{ text: "上一页", callback_data: "public:list:0:latest" }]] },
      },
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/editMessageText");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      chat_id: 42,
      message_id: 100,
      text: "第 2/2 页",
    });
  });

  it("sends once when no UI message exists, then records it", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ result: { message_id: 101 } })),
    );
    vi.stubGlobal("fetch", fetchMock);

    await renderUiScreen(
      context(uiNamespace([
        { messageId: null, screen: null, screenState: {}, stack: [], version: 0 },
        { messageId: 101, screen: null, screenState: {}, stack: [], version: 0 },
        { messageId: 101, screen: "home", screenState: {}, stack: [], version: 1 },
      ])),
      42,
      99,
      { screen: "home", text: "主菜单" },
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/sendMessage");
  });
});
