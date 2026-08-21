import { afterEach, describe, expect, it, vi } from "vitest";

import { renderScreen } from "../../../src/bot/ui-message-controller";

describe("UiMessageController", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("edits the supplied UI message id for navigation", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("{}"),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await renderScreen({
      botToken: "token",
      chatId: 42,
      userId: 99,
      messageId: 100,
      screen: "MY_SURVEYS",
      text: "第 2/2 页",
    });

    expect(result).toMatchObject({ messageId: 100, method: "edit", version: 1 });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/editMessageText");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      chat_id: 42,
      message_id: 100,
      text: "第 2/2 页",
    });
  });

  it("falls back to one new message when the previous UI message is gone", async () => {
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ description: "Bad Request: message to edit not found" }), { status: 400 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: { message_id: 101 } })),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await renderScreen({
      botToken: "token",
      chatId: 42,
      userId: 99,
      messageId: 100,
      screen: "MY_SURVEYS",
      text: "我的问卷",
    });

    expect(result).toMatchObject({ messageId: 101, method: "send" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/editMessageText");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/sendMessage");
  });

  it("does not hide non-edit Telegram failures", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ description: "Bad Request: chat not found" }), { status: 400 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(renderScreen({
      botToken: "token",
      chatId: 42,
      userId: 99,
      messageId: 100,
      screen: "MY_SURVEYS",
      text: "我的问卷",
    })).rejects.toThrow("chat not found");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
