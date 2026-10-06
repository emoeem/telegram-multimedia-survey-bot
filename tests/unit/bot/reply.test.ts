import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { BotContext } from "../../../src/bot/types";
import type { SurveySessionNamespace } from "../../../src/services/session.service";
import type { SurveyBuilderNamespace } from "../../../src/services/survey-builder.service";
import { replyMessage, replyScreen, replyThreadId } from "../../../src/bot/reply";

/**
 * 论坛群（话题群）回复必须带回消息所在的 message_thread_id：不带的消息会落到
 * General 话题，该话题被关闭时 Telegram 直接返回 400 Bad Request: TOPIC_CLOSED，
 * 哪怕机器人权限完全正常。这里守住三件事：话题只发给本条 update 所在的会话、
 * 编辑既有消息时不受影响、以及 handler 层不得绕过 reply.ts 直接发送。
 */
const GROUP_CHAT_ID = -1009876543210;

function context(incoming?: { chatId: number; threadId?: number }): BotContext {
  return { botToken: "token", ...(incoming ? { incoming } : {}) } as unknown as BotContext;
}

function stubFetch(body = "{}"): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(new Response(body, { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function sentBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  return JSON.parse(String(call?.[1]?.body)) as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reply helpers", () => {
  it("only hands out the topic for the chat the update came from", () => {
    const ctx = context({ chatId: GROUP_CHAT_ID, threadId: 77 });

    expect(replyThreadId(ctx, GROUP_CHAT_ID)).toBe(77);
    // 发往别的会话（例如把失败原因私聊给操作者）不能带群话题，
    // Telegram 会以 message thread not found 拒绝。
    expect(replyThreadId(ctx, 42)).toBeUndefined();
    expect(replyThreadId(context(), GROUP_CHAT_ID)).toBeUndefined();
  });

  it("carries the topic when answering the update's own chat", async () => {
    const fetchMock = stubFetch();

    await replyMessage(context({ chatId: GROUP_CHAT_ID, threadId: 77 }), GROUP_CHAT_ID, "hi");

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/sendMessage");
    expect(sentBody(fetchMock)).toMatchObject({ chat_id: GROUP_CHAT_ID, message_thread_id: 77 });
  });

  it("sends without a topic outside forum groups", async () => {
    const fetchMock = stubFetch();

    await replyMessage(context({ chatId: GROUP_CHAT_ID }), GROUP_CHAT_ID, "hi");

    expect(sentBody(fetchMock)).not.toHaveProperty("message_thread_id");
  });

  it("never leaks a group topic into another chat", async () => {
    const fetchMock = stubFetch();

    await replyMessage(context({ chatId: GROUP_CHAT_ID, threadId: 77 }), 42, "dm");

    expect(sentBody(fetchMock)).toMatchObject({ chat_id: 42 });
    expect(sentBody(fetchMock)).not.toHaveProperty("message_thread_id");
  });

  it("threads a newly sent UI screen", async () => {
    const fetchMock = stubFetch(JSON.stringify({ ok: true, result: { message_id: 5 } }));

    const state = await replyScreen(context({ chatId: GROUP_CHAT_ID, threadId: 77 }), {
      chatId: GROUP_CHAT_ID,
      userId: 7,
      screen: "ADMIN_HOME",
      text: "管理后台",
    });

    expect(state.method).toBe("send");
    expect(sentBody(fetchMock)).toMatchObject({ chat_id: GROUP_CHAT_ID, message_thread_id: 77 });
  });
});

describe("router topic wiring", () => {
  it("answers a banned member inside the original forum topic", async () => {
    const fetchMock = stubFetch();
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
        banned_at: "2026-08-14T00:00:00.000Z",
      })),
      run: vi.fn(async () => ({ success: true })),
      all: vi.fn(async () => ({ results: [] })),
    };
    const ctx = {
      ...context(),
      db: { prepare: vi.fn(() => statement) } as unknown as D1Database,
      session: {} as SurveySessionNamespace,
      builder: {} as SurveyBuilderNamespace,
      adminIds: [],
      exportQueue: {} as Queue,
    };

    const { handleTelegramUpdate } = await import("../../../src/bot/router");
    await handleTelegramUpdate(
      {
        update_id: 21,
        message: {
          message_id: 1,
          chat: { id: GROUP_CHAT_ID },
          from: { id: 99 },
          text: "hi",
          message_thread_id: 77,
        },
      },
      ctx,
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sentBody(fetchMock)).toMatchObject({
      chat_id: GROUP_CHAT_ID,
      message_thread_id: 77,
    });
  });
});

describe("bot sender convention", () => {
  const botSrc = join(process.cwd(), "src", "bot");
  const rawSender = /\b(?:sendMessage|sendLongMessage|sendPhoto|sendPhotoAlbum|sendDocument)\(\s*ctx\.botToken\s*,/;
  const rawRender = /renderScreen\(\{\s*botToken:\s*ctx\.botToken\s*,/;
  // reply.ts 是唯一允许把 ctx.botToken 直接交给 telegram.ts 的地方。
  const allowed = new Set(["reply.ts", "telegram.ts"]);

  it("forbids handlers from sending through telegram.ts with ctx.botToken", () => {
    const offenders = readdirSync(botSrc)
      .filter((entry) => entry.endsWith(".ts"))
      .filter((entry) => !allowed.has(entry))
      .filter((entry) => {
        const source = readFileSync(join(botSrc, entry), "utf8");
        return rawSender.test(source) || rawRender.test(source);
      });

    expect(offenders).toEqual([]);
  });

  it("keeps reply.ts as the single ctx-aware sender", () => {
    const replySource = readFileSync(join(botSrc, "reply.ts"), "utf8");

    expect(rawSender.test(replySource)).toBe(true);
  });
});
