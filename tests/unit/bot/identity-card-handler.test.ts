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

import { applyIdentityBackground, getIdentityCardTemplate, handleIdentityCardCallback, handleIdentityCardMessage } from "../../../src/bot/identity-card-handler";
import type { BotContext } from "../../../src/bot/types";
import type { SurveySessionNamespace } from "../../../src/services/session.service";
import type { SurveyBuilderNamespace } from "../../../src/services/survey-builder.service";

function context(cache: KVNamespace): BotContext {
  return {
    botToken: "token", db: {} as D1Database, cache,
    session: {} as SurveySessionNamespace, builder: {} as SurveyBuilderNamespace,
    adminIds: [9], exportQueue: {} as Queue,
  };
}

function memoryCache(): KVNamespace {
  const values = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => { values.set(key, value); }),
    delete: vi.fn(async (key: string) => { values.delete(key); }),
  } as unknown as KVNamespace;
}

describe("identity card flow", () => {
  afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

  it("starts independently and records the front image as an identity asset", async () => {
    const cache = memoryCache();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ result: { message_id: 55 } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    mocks.registerMediaAsset.mockResolvedValue(42);
    const ctx = context(cache);

    await expect(handleIdentityCardCallback(ctx, {
      id: "one", from: { id: 9 }, message: { message_id: 10, chat: { id: 3 } }, data: "identity:list",
    }, 7)).resolves.toBe(true);
    await expect(handleIdentityCardCallback(ctx, {
      id: "two", from: { id: 9 }, message: { message_id: 10, chat: { id: 3 } }, data: "identity:style:dark",
    }, 7)).resolves.toBe(true);
    await expect(handleIdentityCardMessage(ctx, {
      message_id: 11, chat: { id: 3 }, from: { id: 9 },
      photo: [{ file_id: "photo-id", file_unique_id: "photo-unique" }],
    }, 7)).resolves.toBe(true);

    expect(mocks.registerMediaAsset).toHaveBeenCalledWith(ctx, expect.anything(), { scope: "identity_card" });
    const promptBodies = fetchMock.mock.calls
      .filter(([url]) => String(url).includes("sendMessage"))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as { text?: string });
    expect(promptBodies.at(-1)?.text).toContain("步骤 2/9");
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("editMessageText"))).toBe(false);
  });

  it("uses three visually distinct built-in card compositions", () => {
    const simple = getIdentityCardTemplate("simple");
    const dark = getIdentityCardTemplate("dark");
    const classic = getIdentityCardTemplate("classic");
    expect(simple.background).toMatchObject({ type: "gradient", from: "#DDEEFF" });
    expect(dark.background).toMatchObject({ type: "gradient", from: "#050816" });
    expect(classic.background).toMatchObject({ type: "gradient", from: "#392318" });
    expect(simple.elements.map((element) => element.id)).not.toEqual(dark.elements.map((element) => element.id));
    expect(classic.elements.some((element) => element.id === "topornament")).toBe(true);
    const withBackground = applyIdentityBackground(simple, "simple", 22);
    expect(withBackground.background).toEqual({ type: "telegram_asset", assetId: 22, fit: "cover" });
    expect(withBackground.elements.find((element) => element.id === "card")?.opacity).toBe(0.64);
  });

  it("keeps identity card generation locked until an administrator configures a password", async () => {
    const cache = memoryCache();
    const ctx = { ...context(cache), adminIds: [] };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ result: { message_id: 55 } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    mocks.getIdentityCardAccessSetting.mockResolvedValue(null);

    await expect(handleIdentityCardCallback(ctx, {
      id: "locked", from: { id: 7 }, message: { message_id: 10, chat: { id: 3 } }, data: "identity:list",
    }, 7)).resolves.toBe(true);

    const bodies = fetchMock.mock.calls
      .filter(([url]) => String(url).includes("sendMessage"))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as { text?: string });
    expect(bodies.at(-1)?.text).toContain("暂未启用");
  });

  it("queues confirmed cards instead of rendering them in the webhook", async () => {
    const cache = memoryCache();
    const queue = { send: vi.fn().mockResolvedValue(undefined) } as unknown as Queue;
    const db = {
      prepare: vi.fn()
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
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ result: { message_id: 55 } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await cache.put("identity-card-session:7", JSON.stringify({
      chatId: 3, step: "confirm", style: "simple", frontAssetId: 42,
      backAssetId: null, backgroundAssetId: null, name: "琪琪",
    }));

    await expect(handleIdentityCardCallback(ctx, {
      id: "confirm", from: { id: 9 }, message: { message_id: 10, chat: { id: 3 } }, data: "identity:confirm",
    }, 7)).resolves.toBe(true);

    expect(queue.send).toHaveBeenCalledWith({ kind: "identity_card", jobId: 34 });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/sendPhoto"))).toBe(false);
    const bodies = fetchMock.mock.calls
      .filter(([url]) => String(url).includes("sendMessage"))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as { text?: string });
    expect(bodies.some((body) => body.text?.includes("正在后台下载图片"))).toBe(true);
  });
});
