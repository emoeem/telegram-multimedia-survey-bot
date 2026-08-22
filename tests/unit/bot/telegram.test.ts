import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getChat,
  sendDocumentByFileId,
  sendPhoto,
  sendPhotoAlbum,
  getBotUsername,
  splitTelegramText,
  syncDefaultBotCommands,
  uploadMediaForReuse,
} from "../../../src/bot/telegram";

describe("telegram media requests", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("resolves a channel from an @username via getChat", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          result: { id: -1001234567890, type: "channel", title: "报告归档" },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const chat = await getChat("token", "@report_archive");

    expect(chat.id).toBe(-1001234567890);
    expect(chat.type).toBe("channel");
    const request = fetchMock.mock.calls[0];
    expect(String(request?.[0])).toContain("/getChat?chat_id=%40report_archive");
  });

  it("sends an existing Telegram document by file ID", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"ok":true}', { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await sendDocumentByFileId(
      "token",
      42,
      "telegram-file-id",
      "题目附件",
      {
        inline_keyboard: [
          [{ text: "退出", callback_data: "q:exit:1" }],
        ],
      },
    );

    const request = fetchMock.mock.calls[0];
    const body = JSON.parse(String(request?.[1]?.body)) as {
      document: string;
      caption: string;
      reply_markup: unknown;
    };
    expect(body.document).toBe("telegram-file-id");
    expect(body.caption).toBe("题目附件");
    expect(body.reply_markup).toBeTruthy();
  });

  it("replaces legacy command entries with the compact command menu", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"ok":true}', { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await syncDefaultBotCommands("token");

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/setMyCommands");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      commands: [
        { command: "start", description: "打开主菜单" },
        { command: "surveys", description: "浏览可填写问卷" },
        { command: "my_surveys", description: "管理我的问卷" },
        { command: "admin", description: "打开管理员中心" },
      ],
    });
  });

  it("reads the bot username for direct survey links", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"ok":true,"result":{"username":"survey_demo_bot"}}', { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getBotUsername("token")).resolves.toBe("survey_demo_bot");
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/getMe");
  });

  it("surfaces Telegram media API errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response('{"ok":false,"description":"bad file id"}', {
          status: 400,
        }),
      ),
    );

    await expect(
      sendPhoto("token", 42, "bad-file-id"),
    ).rejects.toThrow("Telegram sendPhoto failed: 400");
  });

  it("uploads two to ten report pages as a Telegram media group", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"ok":true,"result":[]}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await sendPhotoAlbum("token", 42, [
      { bytes: new Uint8Array([1]), caption: "报告 1/2" },
      { bytes: new Uint8Array([2]) },
    ]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/sendMediaGroup");
    const body = fetchMock.mock.calls[0]?.[1]?.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(JSON.parse(String(body.get("media")))).toEqual([
      { type: "photo", media: "attach://report_page_0", caption: "报告 1/2" },
      { type: "photo", media: "attach://report_page_1" },
    ]);
  });

  it("splits long previews below the Telegram message limit", () => {
    const chunks = splitTelegramText(
      `${"第一段".repeat(800)}\n\n${"第二段".repeat(800)}`,
      1000,
    );

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 1000)).toBe(true);
    expect(chunks.join("").replace(/\s/g, "")).toBe(
      `${"第一段".repeat(800)}${"第二段".repeat(800)}`,
    );
  });

  it("uploads an embedded data URL and returns a reusable file ID", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          result: {
            message_id: 77,
            photo: [
              {
                file_id: "small",
                file_unique_id: "small-unique",
                width: 10,
                height: 10,
              },
              {
                file_id: "large",
                file_unique_id: "large-unique",
                width: 100,
                height: 100,
              },
            ],
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const uploaded = await uploadMediaForReuse("token", 42, {
      type: "photo",
      url: "data:image/png;base64,aGVsbG8=",
      fileName: "question.png",
    });

    expect(uploaded.messageId).toBe(77);
    expect(uploaded.file.file_id).toBe("large");
    const request = fetchMock.mock.calls[0];
    expect(String(request?.[0])).toContain("/sendPhoto");
    const body = request?.[1]?.body;
    expect(body).toBeInstanceOf(FormData);
    expect((body as FormData).get("photo")).toBeInstanceOf(Blob);
  });

  it("retries a rate-limited media upload", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: false,
            description: "Too Many Requests",
            parameters: { retry_after: 1 },
          }),
          {
            status: 429,
            headers: { "Content-Type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            result: {
              message_id: 88,
              document: {
                file_id: "document-id",
                file_unique_id: "document-unique",
              },
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const upload = uploadMediaForReuse("token", 42, {
      type: "document",
      url: "data:application/json;base64,e30=",
      fileName: "survey.json",
    });
    await vi.runAllTimersAsync();

    await expect(upload).resolves.toMatchObject({
      messageId: 88,
      file: { file_id: "document-id" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
