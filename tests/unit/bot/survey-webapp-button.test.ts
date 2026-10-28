import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUserByTelegramId: vi.fn(),
  markBotStarted: vi.fn(),
  listQuestionsBySurvey: vi.fn(),
  hasActiveCreatorTrial: vi.fn(),
}));

vi.mock("../../../src/db/repositories/user.repository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/db/repositories/user.repository")>()),
  getUserByTelegramId: mocks.getUserByTelegramId,
  markBotStarted: mocks.markBotStarted,
}));

vi.mock("../../../src/db/repositories/question.repository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/db/repositories/question.repository")>()),
  listQuestionsBySurvey: mocks.listQuestionsBySurvey,
}));

vi.mock("../../../src/db/repositories/creator-trial.repository", () => ({
  hasActiveCreatorTrial: mocks.hasActiveCreatorTrial,
}));

import { handleTelegramMessage } from "../../../src/bot/survey-handler";
import type { BotContext } from "../../../src/bot/types";
import type { SurveySessionNamespace } from "../../../src/services/session.service";
import type { SurveyBuilderNamespace } from "../../../src/services/survey-builder.service";

/**
 * A2：含小游戏题的问卷走 web_app 内嵌按钮（Bot 端不能玩小游戏，普通 url
 * 按钮会让玩家跳出去再找回来）；无 game 题或非 https origin 回落普通按钮。
 */
function makeCtx(overrides: Partial<BotContext> = {}): BotContext {
  return {
    botToken: "token",
    db: { prepare: () => { throw new Error("unexpected raw db access"); } } as unknown as D1Database,
    session: {} as SurveySessionNamespace,
    builder: {} as SurveyBuilderNamespace,
    adminIds: [],
    exportQueue: {} as Queue,
    origin: "https://emoemok.top",
    webhookSecret: "shhh",
    ...overrides,
  };
}

async function captureReply(ctx: BotContext) {
  const bodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/sendMessage")) {
        bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }),
  );
  await handleTelegramMessage(ctx, {
    message_id: 1,
    chat: { id: 2 },
    from: { id: 99, first_name: " tester" },
    text: "/start survey_5",
  });
  return bodies;
}

function keyboardOf(body: Record<string, unknown>): Array<Array<Record<string, unknown>>> {
  return (body.reply_markup as { inline_keyboard?: Array<Array<Record<string, unknown>>> })?.inline_keyboard ?? [];
}

describe("survey deep-link button", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("问卷含 game 题时用 web_app 内嵌按钮（带参与者 token）", async () => {
    mocks.getUserByTelegramId.mockResolvedValue({ id: 7, telegramUserId: 99 });
    mocks.markBotStarted.mockResolvedValue(undefined);
    mocks.hasActiveCreatorTrial.mockResolvedValue(false);
    mocks.listQuestionsBySurvey.mockResolvedValue([{ id: 1, type: "game" }, { id: 2, type: "single" }]);

    const bodies = await captureReply(makeCtx());
    const markup = bodies.flatMap((body) => keyboardOf(body)).flat();
    const webApp = markup.find((button) => button.web_app) as { text: string; web_app: { url: string } } | undefined;
    expect(webApp).toBeDefined();
    expect(webApp!.text).toBe("🎮 打开问卷作答");
    expect(webApp!.web_app.url).toContain("/s/5?v=3");
    expect(webApp!.web_app.url).toContain("pt=");
  });

  it("问卷没有 game 题时保持普通 url 按钮", async () => {
    mocks.getUserByTelegramId.mockResolvedValue({ id: 7, telegramUserId: 99 });
    mocks.markBotStarted.mockResolvedValue(undefined);
    mocks.hasActiveCreatorTrial.mockResolvedValue(false);
    mocks.listQuestionsBySurvey.mockResolvedValue([{ id: 1, type: "single" }, { id: 2, type: "note" }]);

    const bodies = await captureReply(makeCtx());
    const markup = bodies.flatMap((body) => keyboardOf(body)).flat();
    expect(markup.some((button) => button.web_app)).toBe(false);
    const urlButton = markup.find((button) => button.url) as { text: string; url: string } | undefined;
    expect(urlButton?.text).toBe("填写问卷");
    expect(urlButton?.url).toContain("/s/5?v=3");
  });

  it("非 https origin 不用 web_app（BotFather domain 前提不满足）", async () => {
    mocks.getUserByTelegramId.mockResolvedValue({ id: 7, telegramUserId: 99 });
    mocks.markBotStarted.mockResolvedValue(undefined);
    mocks.hasActiveCreatorTrial.mockResolvedValue(false);
    mocks.listQuestionsBySurvey.mockResolvedValue([{ id: 1, type: "game" }]);

    const bodies = await captureReply(makeCtx({ origin: "http://localhost:8787" }));
    const markup = bodies.flatMap((body) => keyboardOf(body)).flat();
    expect(markup.some((button) => button.web_app)).toBe(false);
  });
});
