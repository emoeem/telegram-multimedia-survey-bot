import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getBotIdentity: vi.fn() }));

vi.mock("../../../src/bot/telegram", () => ({
  getBotIdentity: mocks.getBotIdentity,
}));

import {
  BOT_ID_CACHE_KEY,
  BOT_USERNAME_CACHE_KEY,
  buildGroupUsageHint,
  isGroupChat,
  isMessageAddressedToBot,
  resolveBotIdentity,
} from "../../../src/bot/chat-addressing";
import type { BotContext, TelegramMessage } from "../../../src/bot/types";

let tokenCounter = 0;

/** 每个用例一个独立 token：模块级 memoizedIdentity 按 token 记忆，避免互相污染。 */
function nextToken(): string {
  tokenCounter += 1;
  return `token-${tokenCounter}`;
}

function createContext(entries: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(entries));
  const cache = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
  };
  return {
    ctx: { botToken: nextToken(), cache } as unknown as BotContext,
    cache,
    store,
  };
}

function groupMessage(overrides: Partial<TelegramMessage> = {}): TelegramMessage {
  return {
    message_id: 1,
    chat: { id: -1004497177255, type: "supergroup", title: "天地一家大爱盟" },
    from: { id: 99 },
    text: "你好",
    ...overrides,
  };
}

beforeEach(() => {
  mocks.getBotIdentity.mockReset();
  mocks.getBotIdentity.mockResolvedValue({ id: 777, username: "hnhgggfj_bot" });
});

describe("isGroupChat", () => {
  it("recognises groups and supergroups only", () => {
    expect(isGroupChat("group")).toBe(true);
    expect(isGroupChat("supergroup")).toBe(true);
    expect(isGroupChat("private")).toBe(false);
    expect(isGroupChat(undefined)).toBe(false);
    expect(isGroupChat("channel")).toBe(false);
  });
});

describe("isMessageAddressedToBot", () => {
  it("lets private chat messages through untouched", async () => {
    const { ctx } = createContext();
    const message = groupMessage({ chat: { id: 42 }, text: "随便说点什么" });

    await expect(isMessageAddressedToBot(ctx, message)).resolves.toBe(true);
    expect(mocks.getBotIdentity).not.toHaveBeenCalled();
  });

  it("ignores plain group chatter without resolving the bot identity", async () => {
    const { ctx } = createContext();

    await expect(isMessageAddressedToBot(ctx, groupMessage({ text: "你好" }))).resolves.toBe(false);
    expect(mocks.getBotIdentity).not.toHaveBeenCalled();
  });

  it("accepts a bare command in a group", async () => {
    const { ctx } = createContext();

    await expect(isMessageAddressedToBot(ctx, groupMessage({ text: "/set_publish_target" }))).resolves.toBe(true);
  });

  it("accepts a command that names this bot and rejects one naming another", async () => {
    const { ctx } = createContext({ [BOT_USERNAME_CACHE_KEY]: "hnhgggfj_bot" });

    await expect(
      isMessageAddressedToBot(ctx, groupMessage({ text: "/set_publish_target@hnhgggfj_bot" })),
    ).resolves.toBe(true);
    await expect(isMessageAddressedToBot(ctx, groupMessage({ text: "/start@someone_else_bot" }))).resolves.toBe(false);
  });

  it("accepts a mention entity of this bot and rejects a mention of another bot", async () => {
    const { ctx } = createContext({ [BOT_USERNAME_CACHE_KEY]: "hnhgggfj_bot" });
    // Telegram 的 mention 实体长度只覆盖 @username 本身
    const mention = (text: string, handle: string) =>
      groupMessage({ text, entities: [{ type: "mention", offset: 0, length: handle.length }] });

    await expect(isMessageAddressedToBot(ctx, mention("@hnhgggfj_bot 你好", "@hnhgggfj_bot"))).resolves.toBe(true);
    await expect(isMessageAddressedToBot(ctx, mention("@HNHGGGFJ_BOT 你好", "@HNHGGGFJ_BOT"))).resolves.toBe(true);
    await expect(isMessageAddressedToBot(ctx, mention("@other_bot 你好", "@other_bot"))).resolves.toBe(false);
  });

  it("accepts a text_mention entity that points at this bot's id", async () => {
    const { ctx } = createContext({ [BOT_ID_CACHE_KEY]: "777" });

    const addressed = await isMessageAddressedToBot(
      ctx,
      groupMessage({
        text: "机器人 你好",
        entities: [{ type: "text_mention", offset: 0, length: 3, user: { id: 777, first_name: "问卷机器人" } }],
      }),
    );
    expect(addressed).toBe(true);

    const other = await isMessageAddressedToBot(
      ctx,
      groupMessage({
        text: "某人 你好",
        entities: [{ type: "text_mention", offset: 0, length: 2, user: { id: 12345, first_name: "某人" } }],
      }),
    );
    expect(other).toBe(false);
  });

  it("accepts a reply to this bot's own message and rejects a reply to somebody else", async () => {
    const { ctx } = createContext({ [BOT_ID_CACHE_KEY]: "777" });

    await expect(
      isMessageAddressedToBot(ctx, groupMessage({ reply_to_message: { message_id: 5, from: { id: 777 } } })),
    ).resolves.toBe(true);
    await expect(
      isMessageAddressedToBot(ctx, groupMessage({ reply_to_message: { message_id: 6, from: { id: 12345 } } })),
    ).resolves.toBe(false);
  });

  it("ignores mentions when the bot identity cannot be determined", async () => {
    mocks.getBotIdentity.mockRejectedValue(new Error("Telegram getMe failed: 401"));
    const { ctx } = createContext();
    const text = "@hnhgggfj_bot 你好";

    await expect(
      isMessageAddressedToBot(
        ctx,
        groupMessage({ text, entities: [{ type: "mention", offset: 0, length: "@hnhgggfj_bot".length }] }),
      ),
    ).resolves.toBe(false);
    // 命令仍然放行：不依赖身份解析
    await expect(isMessageAddressedToBot(ctx, groupMessage({ text: "/set_publish_target" }))).resolves.toBe(true);
  });
});

describe("resolveBotIdentity", () => {
  it("caches the getMe result in KV and reuses it", async () => {
    const { ctx, cache, store } = createContext();

    await expect(resolveBotIdentity(ctx)).resolves.toEqual({ id: 777, username: "hnhgggfj_bot" });
    expect(mocks.getBotIdentity).toHaveBeenCalledTimes(1);
    expect(store.get(BOT_ID_CACHE_KEY)).toBe("777");
    expect(store.get(BOT_USERNAME_CACHE_KEY)).toBe("hnhgggfj_bot");

    cache.get.mockClear();
    await expect(resolveBotIdentity(ctx)).resolves.toEqual({ id: 777, username: "hnhgggfj_bot" });
    expect(mocks.getBotIdentity).toHaveBeenCalledTimes(1);
  });

  it("survives an unavailable cache", async () => {
    const ctx = { botToken: nextToken() } as unknown as BotContext;

    await expect(resolveBotIdentity(ctx)).resolves.toEqual({ id: 777, username: "hnhgggfj_bot" });
  });
});

describe("buildGroupUsageHint", () => {
  it("points at the private chat and names /set_publish_target", async () => {
    const { ctx } = createContext({ [BOT_USERNAME_CACHE_KEY]: "hnhgggfj_bot" });

    const hint = await buildGroupUsageHint(ctx);
    expect(hint).toContain("/set_publish_target");
    expect(hint).toContain("https://t.me/hnhgggfj_bot");
  });

  it("still explains the group's only job when the username is unknown", async () => {
    mocks.getBotIdentity.mockRejectedValue(new Error("Telegram getMe failed: 401"));
    const { ctx } = createContext();

    const hint = await buildGroupUsageHint(ctx);
    expect(hint).toContain("/set_publish_target");
    expect(hint).toContain("请在 Telegram 里私聊本机器人。");
  });
});
