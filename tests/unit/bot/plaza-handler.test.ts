import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listIdentityProfiles: vi.fn(),
  getIdentityProfileOwners: vi.fn(),
  listPlazaPosts: vi.fn(),
  createPlazaPost: vi.fn(),
  checkRateLimit: vi.fn(),
  renderIdentityCardReportPng: vi.fn(),
  renderScreen: vi.fn(),
  sendMessage: vi.fn(),
  sendPhoto: vi.fn(),
  answerCallbackQuery: vi.fn(),
}));

vi.mock("../../../src/db/repositories/identity-card.repository", () => ({
  listIdentityProfiles: mocks.listIdentityProfiles,
  getIdentityProfileOwners: mocks.getIdentityProfileOwners,
}));
vi.mock("../../../src/db/repositories/plaza-post.repository", () => ({
  listPlazaPosts: mocks.listPlazaPosts,
  createPlazaPost: mocks.createPlazaPost,
}));
vi.mock("../../../src/services/rate-limit.service", () => ({
  checkRateLimit: mocks.checkRateLimit,
}));
vi.mock("../../../src/services/identity-card-report.service", () => ({
  renderIdentityCardReportPng: mocks.renderIdentityCardReportPng,
  IDENTITY_CARD_TEMPLATES: [],
  isIdentityCardTemplateId: () => false,
}));
vi.mock("../../../src/bot/ui-message-controller", () => ({ renderScreen: mocks.renderScreen }));
vi.mock("../../../src/bot/telegram", () => ({
  sendMessage: mocks.sendMessage,
  sendPhoto: mocks.sendPhoto,
  answerCallbackQuery: mocks.answerCallbackQuery,
}));

import { handlePlazaCallback, handlePlazaMessage } from "../../../src/bot/plaza-handler";
import type { BotContext } from "../../../src/bot/types";
import type { SurveySessionNamespace } from "../../../src/services/session.service";
import type { SurveyBuilderNamespace } from "../../../src/services/survey-builder.service";

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

function context(): BotContext {
  return {
    botToken: "token",
    db: {} as D1Database,
    cache: memoryCache(),
    mediaKv: {} as KVNamespace,
    session: {} as SurveySessionNamespace,
    builder: {} as SurveyBuilderNamespace,
    adminIds: [],
    exportQueue: {} as Queue,
  };
}

function callback(data: string) {
  return {
    id: data,
    from: { id: 7, username: "rose", first_name: "Rose" },
    message: { message_id: 10, chat: { id: 3 } },
    data,
  } as never;
}

function lastScreenText(): string {
  const call = mocks.renderScreen.mock.calls.at(-1)?.[0] as { text?: string } | undefined;
  return call?.text ?? "";
}

describe("plaza bot handler", () => {
  afterEach(() => vi.clearAllMocks());

  it("shows an overview with both feed totals", async () => {
    mocks.listIdentityProfiles.mockResolvedValue({ items: [], total: 3 });
    mocks.listPlazaPosts.mockResolvedValue({ items: [], total: 5 });

    await expect(handlePlazaCallback(context(), callback("plaza:list"), 7)).resolves.toBe(true);

    expect(lastScreenText()).toContain("资料卡 3 张 · 树洞 5 条");
  });

  it("renders treehole posts with author attribution", async () => {
    mocks.listPlazaPosts.mockResolvedValue({
      items: [
        {
          id: 2,
          userId: 7,
          content: "今天也想被听见。",
          anonymous: false,
          status: "published",
          createdAt: "2026-08-29T10:00:00.000Z",
          owner: { telegramUserId: 777, username: "rose", firstName: "Rose" },
        },
      ],
      total: 1,
    });

    await expect(handlePlazaCallback(context(), callback("plaza:treehole:0"), 7)).resolves.toBe(true);

    const text = lastScreenText();
    expect(text).toContain("树洞 1/1");
    expect(text).toContain("今天也想被听见。");
    expect(text).toContain("@rose");
  });

  it("routes legacy gallery callbacks to the card feed and shows the card owner", async () => {
    mocks.listIdentityProfiles.mockResolvedValue({
      items: [
        {
          id: 9,
          userId: 7,
          name: "暮色蔷薇",
          identityLabel: "夜行者",
          cardAssetId: null,
          galleryPublished: true,
        },
      ],
      total: 1,
    });
    mocks.getIdentityProfileOwners.mockResolvedValue(
      new Map([[7, { telegramUserId: 777, username: "rose", firstName: "Rose" }]]),
    );
    mocks.renderIdentityCardReportPng.mockResolvedValue(new Uint8Array([1, 2, 3]));
    mocks.sendPhoto.mockResolvedValue(new Response(JSON.stringify({ ok: true })));
    const ctx = {
      ...context(),
      browser: { fetch: vi.fn() } as unknown as import("@cloudflare/puppeteer").BrowserWorker,
    };

    await expect(handlePlazaCallback(ctx, callback("gallery:list"), 7)).resolves.toBe(true);

    expect(mocks.listIdentityProfiles).toHaveBeenCalledWith(expect.anything(), {
      limit: 1,
      offset: 0,
      view: "published",
    });
    expect(mocks.sendPhoto).toHaveBeenCalledWith(
      "token",
      3,
      expect.anything(),
      expect.stringContaining("by @rose"),
      expect.anything(),
    );
  });

  it("collects treehole content, then saves it with the chosen attribution", async () => {
    mocks.checkRateLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 60 });
    mocks.createPlazaPost.mockResolvedValue({ id: 1 });
    const ctx = context();

    await expect(handlePlazaCallback(ctx, callback("plaza:post"), 7)).resolves.toBe(true);
    await expect(
      handlePlazaMessage(
        ctx,
        { message_id: 11, chat: { id: 3 }, from: { id: 7 }, text: "今天想找个树洞说说心里话。" } as never,
        7,
      ),
    ).resolves.toBe(true);
    expect(lastScreenText()).toContain("选择署名方式");

    await expect(handlePlazaCallback(ctx, callback("plaza:anon"), 7)).resolves.toBe(true);
    expect(mocks.createPlazaPost).toHaveBeenCalledWith(expect.anything(), {
      userId: 7,
      content: "今天想找个树洞说说心里话。",
      anonymous: true,
    });
    expect(lastScreenText()).toContain("已发布到树洞广场");
  });

  it("blocks posting when the rate limit is exhausted", async () => {
    mocks.checkRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 600 });
    const ctx = context();
    await ctx.cache?.put(
      "plaza-compose:7",
      JSON.stringify({ chatId: 3, step: "attribution", content: "想说的话。想说的话。" }),
    );

    await expect(handlePlazaCallback(ctx, callback("plaza:anon"), 7)).resolves.toBe(true);

    expect(mocks.createPlazaPost).not.toHaveBeenCalled();
    expect(mocks.sendMessage).toHaveBeenCalledWith("token", 3, expect.stringContaining("发言太频繁"));
  });
});
