import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  registerMediaAsset: vi.fn(),
  getIdentityCardAccessSetting: vi.fn(),
  grantIdentityCardAccess: vi.fn(),
  hasIdentityCardAccess: vi.fn(),
}));

vi.mock("../../../src/services/media.service", () => ({ registerMediaAsset: mocks.registerMediaAsset }));
vi.mock("../../../src/db/repositories/feature-access.repository", () => ({
  getIdentityCardAccessSetting: mocks.getIdentityCardAccessSetting,
  grantIdentityCardAccess: mocks.grantIdentityCardAccess,
  hasIdentityCardAccess: mocks.hasIdentityCardAccess,
}));

import { handleIdentityCardCallback, handleIdentityCardMessage } from "../../../src/bot/identity-card-handler";
import type { BotContext } from "../../../src/bot/types";
import type { SurveySessionNamespace } from "../../../src/services/session.service";
import type { SurveyBuilderNamespace } from "../../../src/services/survey-builder.service";

function context(cache: KVNamespace): BotContext {
  return {
    botToken: "token",
    db: {} as D1Database,
    cache,
    mediaKv: {} as KVNamespace,
    session: {} as SurveySessionNamespace,
    builder: {} as SurveyBuilderNamespace,
    adminIds: [9],
    exportQueue: {} as Queue,
  };
}

function memoryCache(): KVNamespace {
  const values = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      values.delete(key);
    }),
  } as unknown as KVNamespace;
}

function callback(data: string) {
  return {
    id: data,
    from: { id: 9 },
    message: { message_id: 10, chat: { id: 3 } },
    data,
  } as const;
}

async function lastPromptText(fetchMock: ReturnType<typeof vi.fn>): Promise<string> {
  const bodies = fetchMock.mock.calls
    .filter(([url]) => String(url).includes("sendMessage") || String(url).includes("editMessageText"))
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as { text?: string });
  return bodies.at(-1)?.text ?? "";
}

describe("identity card flow", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("starts with web report card templates and records the front image as an identity asset", async () => {
    const cache = memoryCache();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ result: { message_id: 55 } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    mocks.registerMediaAsset.mockResolvedValue(42);
    const ctx = context(cache);

    await expect(handleIdentityCardCallback(ctx, callback("identity:list"), 7)).resolves.toBe(true);
    await expect(handleIdentityCardCallback(ctx, callback("identity:style:gallery"), 7)).resolves.toBe(true);
    await expect(
      handleIdentityCardMessage(
        ctx,
        {
          message_id: 11,
          chat: { id: 3 },
          from: { id: 9 },
          photo: [{ file_id: "photo-id", file_unique_id: "photo-unique" }],
        },
        7,
      ),
    ).resolves.toBe(true);

    expect(mocks.registerMediaAsset).toHaveBeenCalledWith(ctx, expect.anything(), { scope: "identity_card" });
    const promptText = await lastPromptText(fetchMock);
    expect(promptText).toContain("步骤 2/10");
    const allTexts = fetchMock.mock.calls
      .filter(([url]) => String(url).includes("sendMessage") || String(url).includes("editMessageText"))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as { text?: string });
    expect(allTexts.some((body) => body.text?.includes("网页报告渲染管线"))).toBe(true);
  });

  it("asks whether the card should be published to the gallery before confirming", async () => {
    const cache = memoryCache();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ result: { message_id: 55 } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = context(cache);
    await cache.put(
      "identity-card-session:7",
      JSON.stringify({
        chatId: 3,
        step: "background",
        style: "identity",
        galleryPublished: false,
        frontAssetId: 42,
        backAssetId: null,
        backgroundAssetId: null,
        name: "琪琪",
      }),
    );

    await expect(handleIdentityCardCallback(ctx, callback("identity:skip:background"), 7)).resolves.toBe(true);
    const galleryPrompt = await lastPromptText(fetchMock);
    expect(galleryPrompt).toContain("画廊发布");

    await expect(handleIdentityCardCallback(ctx, callback("identity:gallery:yes"), 7)).resolves.toBe(true);
    const confirmText = await lastPromptText(fetchMock);
    expect(confirmText).toContain("发布到资料卡画廊");

    // The session advanced to "confirm", so a late gallery callback is rejected.
    await expect(handleIdentityCardCallback(ctx, callback("identity:gallery:no"), 7)).resolves.toBe(false);

    // A fresh session that picks "仅自己可见" shows the private choice.
    await cache.put(
      "identity-card-session:7",
      JSON.stringify({
        chatId: 3,
        step: "gallery",
        style: "identity",
        galleryPublished: false,
        frontAssetId: 42,
        backAssetId: null,
        backgroundAssetId: null,
        name: "琪琪",
      }),
    );
    await expect(handleIdentityCardCallback(ctx, callback("identity:gallery:no"), 7)).resolves.toBe(true);
    expect(await lastPromptText(fetchMock)).toContain("仅自己可见");
  });

  it("keeps identity card generation locked until an administrator configures a password", async () => {
    const cache = memoryCache();
    const ctx = { ...context(cache), adminIds: [] };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ result: { message_id: 55 } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    mocks.getIdentityCardAccessSetting.mockResolvedValue(null);

    await expect(handleIdentityCardCallback(ctx, callback("identity:list"), 7)).resolves.toBe(true);

    const bodies = fetchMock.mock.calls
      .filter(([url]) => String(url).includes("sendMessage"))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as { text?: string });
    expect(bodies.at(-1)?.text).toContain("暂未启用");
  });

  it("queues confirmed cards with the gallery choice instead of rendering in the webhook", async () => {
    const cache = memoryCache();
    const queue = { send: vi.fn().mockResolvedValue(undefined) } as unknown as Queue;
    const db = {
      prepare: vi
        .fn()
        .mockImplementationOnce(() => {
          const statement = {
            bind: vi.fn(() => statement),
            run: vi.fn().mockResolvedValue({ meta: { last_row_id: 12 } }),
          };
          return statement;
        })
        .mockImplementationOnce(() => {
          const statement = {
            bind: vi.fn(() => statement),
            run: vi.fn().mockResolvedValue({ meta: { last_row_id: 34 } }),
          };
          return statement;
        }),
    } as unknown as D1Database;
    const ctx = { ...context(cache), db, exportQueue: queue };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ result: { message_id: 55 } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await cache.put(
      "identity-card-session:7",
      JSON.stringify({
        chatId: 3,
        step: "confirm",
        style: "gallery",
        galleryPublished: true,
        frontAssetId: 42,
        backAssetId: null,
        backgroundAssetId: null,
        name: "琪琪",
      }),
    );

    await expect(handleIdentityCardCallback(ctx, callback("identity:confirm"), 7)).resolves.toBe(true);

    expect(queue.send).toHaveBeenCalledWith({ kind: "identity_card", jobId: 34 });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/sendPhoto"))).toBe(false);
    const insertCall = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(insertCall).toContain("gallery_published");
  });
});
