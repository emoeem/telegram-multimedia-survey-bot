import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A2：抽卡 / 个人中心 / 纸条聊天在网页端早就做完了，机器人主菜单里却完全没有
 * 入口。这里钉住三件事：
 *
 *   1. 三个入口都出现在主菜单键盘上，指向既有的网页路由（/gacha、/me、/notes）；
 *   2. 链接带上参与者 token（pt=…），站内浏览器没有 initData 时身份仍然是通的；
 *   3. 没有 webhookSecret 时优雅降级 —— 链接里既没有 pt，也不会出现 "undefined"。
 */
const mocks = vi.hoisted(() => ({
  getUserByTelegramId: vi.fn(),
  hasActiveCreatorTrial: vi.fn(),
}));

vi.mock("../../../src/db/repositories/user.repository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/db/repositories/user.repository")>()),
  getUserByTelegramId: mocks.getUserByTelegramId,
}));

vi.mock("../../../src/db/repositories/creator-trial.repository", () => ({
  hasActiveCreatorTrial: mocks.hasActiveCreatorTrial,
}));

import { handleTelegramMessage } from "../../../src/bot/survey-handler";
import type { BotContext } from "../../../src/bot/types";
import type { SurveySessionNamespace } from "../../../src/services/session.service";
import type { SurveyBuilderNamespace } from "../../../src/services/survey-builder.service";

function makeCtx(overrides: Partial<BotContext> = {}): BotContext {
  return {
    botToken: "token",
    db: {} as D1Database,
    session: {} as SurveySessionNamespace,
    builder: {} as SurveyBuilderNamespace,
    adminIds: [],
    exportQueue: {} as Queue,
    origin: "https://example.com",
    webhookSecret: "home-menu-secret",
    ...overrides,
  };
}

type KeyboardButton = { text: string; url?: string; callback_data?: string };

async function homeKeyboard(ctx: BotContext): Promise<{ rows: KeyboardButton[][]; raw: string }> {
  const bodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }),
  );
  await handleTelegramMessage(ctx, {
    message_id: 1,
    chat: { id: 2 },
    from: { id: 88, first_name: "tester" },
    text: "/help",
  });
  const body = bodies[0] ?? {};
  const markup = body.reply_markup as { inline_keyboard?: KeyboardButton[][] } | undefined;
  return { rows: markup?.inline_keyboard ?? [], raw: JSON.stringify(markup ?? {}) };
}

/** `origin` / `webhookSecret` 是可选项：exactOptionalPropertyTypes 下不能显式传
 * `undefined`，所以直接删字段来模拟「没配」。 */
function ctxWithout(field: "origin" | "webhookSecret"): BotContext {
  const ctx = makeCtx();
  delete (ctx as unknown as Record<string, unknown>)[field];
  return ctx;
}

function findButton(rows: KeyboardButton[][], text: string): KeyboardButton | undefined {
  return rows.flat().find((button) => button.text === text);
}

describe("home menu web entries", () => {
  beforeEach(() => {
    mocks.getUserByTelegramId.mockResolvedValue({ id: 7, telegramUserId: 88, systemRole: "participant" });
    mocks.hasActiveCreatorTrial.mockResolvedValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("在一个键盘里同时给出抽卡、个人中心、纸条聊天三个入口", async () => {
    const { rows, raw } = await homeKeyboard(makeCtx());

    const me = findButton(rows, "👤 个人中心");
    const gacha = findButton(rows, "🎴 抽卡");
    const notes = findButton(rows, "💌 纸条聊天");
    expect(me?.url).toBeTruthy();
    expect(gacha?.url).toBeTruthy();
    expect(notes?.url).toBeTruthy();

    // 复用既有路由，不新造页面。
    expect(new URL(me!.url!).pathname).toBe("/me");
    expect(new URL(gacha!.url!).pathname).toBe("/gacha");
    expect(new URL(notes!.url!).pathname).toBe("/notes");
    // 金币中心与抽卡是一对，顺带也开着。
    expect(new URL(findButton(rows, "🪙 金币中心")!.url!).pathname).toBe("/coins");

    // 身份是通的：pt 与 /trial、/me 以前用的参与者 token 同一个来源。
    for (const url of [me!.url!, gacha!.url!, notes!.url!]) {
      expect(new URL(url).searchParams.get("pt")).toBeTruthy();
    }
    expect(raw).not.toContain("undefined");
  });

  it("没有 webhookSecret 时不签 token，但仍然给出可用链接", async () => {
    const { rows, raw } = await homeKeyboard(ctxWithout("webhookSecret"));

    for (const text of ["👤 个人中心", "🎴 抽卡", "💌 纸条聊天"]) {
      const button = findButton(rows, text);
      expect(button?.url).toBeTruthy();
      expect(new URL(button!.url!).searchParams.get("pt")).toBeNull();
    }
    expect(raw).not.toContain("undefined");
  });

  it("没有 origin 时退回 callback 按钮，不生成半截链接", async () => {
    const { rows, raw } = await homeKeyboard(ctxWithout("origin"));

    expect(findButton(rows, "👤 个人中心")).toBeUndefined();
    expect(findButton(rows, "浏览问卷")?.callback_data).toBe("home:surveys");
    expect(findButton(rows, "🌳 树洞")?.callback_data).toBe("plaza:treehole:0");
    expect(raw).not.toContain("undefined");
  });
});
