import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUserByTelegramId: vi.fn(),
  getActiveResponseByUser: vi.fn(),
  getBuilderState: vi.fn(),
  getSurveyFlow: vi.fn(),
  getSession: vi.fn(),
  setSessionCurrentQuestion: vi.fn(),
  completeSession: vi.fn(),
  getResponseDetail: vi.fn(),
  updateResponseCurrentQuestion: vi.fn(),
  completeResponse: vi.fn(),
  upsertTextAnswer: vi.fn(),
  getQuestionMediaByQuestionId: vi.fn(),
}));

vi.mock("../../../src/db/repositories/user.repository", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../src/db/repositories/user.repository")
  >()),
  getUserByTelegramId: mocks.getUserByTelegramId,
}));

vi.mock("../../../src/db/repositories/response.repository", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../src/db/repositories/response.repository")
  >()),
  getActiveResponseByUser: mocks.getActiveResponseByUser,
  updateResponseCurrentQuestion: mocks.updateResponseCurrentQuestion,
  completeResponse: mocks.completeResponse,
  upsertTextAnswer: mocks.upsertTextAnswer,
}));

vi.mock("../../../src/services/survey-builder.service", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../src/services/survey-builder.service")
  >()),
  getBuilderState: mocks.getBuilderState,
}));

vi.mock("../../../src/services/question.service", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../src/services/question.service")
  >()),
  getSurveyFlow: mocks.getSurveyFlow,
}));

vi.mock("../../../src/services/session.service", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../src/services/session.service")
  >()),
  getSession: mocks.getSession,
  setSessionCurrentQuestion: mocks.setSessionCurrentQuestion,
  completeSession: mocks.completeSession,
}));

vi.mock("../../../src/services/result.service", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../src/services/result.service")
  >()),
  getResponseDetail: mocks.getResponseDetail,
}));

vi.mock("../../../src/db/repositories/media.repository", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../src/db/repositories/media.repository")
  >()),
  getQuestionMediaByQuestionId: mocks.getQuestionMediaByQuestionId,
}));

import {
  handleTelegramCallback,
  handleTelegramMessage,
} from "../../../src/bot/survey-handler";
import { editMessageReplyMarkup, sendMessage } from "../../../src/bot/telegram";
import type { BotContext } from "../../../src/bot/types";
import type { SurveySessionNamespace } from "../../../src/services/session.service";
import type { SurveyBuilderNamespace } from "../../../src/services/survey-builder.service";
import type { SurveyQuestionView } from "../../../src/survey/engine";

function makeQuestion(
  partial: Partial<SurveyQuestionView> & Pick<SurveyQuestionView, "id" | "type">,
): SurveyQuestionView {
  return {
    surveyId: 40,
    title: `题目 ${partial.id}`,
    description: null,
    required: true,
    order: partial.id,
    settingsJson: null,
    conditionJson: null,
    skipToQuestionId: null,
    options: [],
    ...partial,
  } as SurveyQuestionView;
}

function createContext(db?: D1Database): BotContext {
  return {
    botToken: "token",
    db: db ?? ({} as D1Database),
    session: {} as SurveySessionNamespace,
    builder: {} as SurveyBuilderNamespace,
    adminIds: [],
    exportQueue: {} as Queue,
  };
}

function createDbMock(firstResult: unknown): D1Database {
  const statement = {
    bind: vi.fn(() => statement),
    first: vi.fn(async () => firstResult),
    all: vi.fn(async () => ({ results: [] })),
    run: vi.fn(async () => ({ success: true })),
  };
  return { prepare: vi.fn(() => statement) } as unknown as D1Database;
}

function sentTexts(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls
    .map((call) => call[1] as RequestInit | undefined)
    .filter((request) => String(request?.body ?? "").includes("text"))
    .map((request) => {
      const body = JSON.parse(String(request?.body)) as { text?: string };
      return body.text ?? "";
    });
}

describe("survey answer guards", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("treats /cancel as a global cancellation instead of a text answer", async () => {
    mocks.getUserByTelegramId.mockResolvedValue({
      id: 7,
      telegramUserId: 99,
      systemRole: "participant",
    });
    mocks.getBuilderState.mockResolvedValue({ step: "idle" });
    mocks.getActiveResponseByUser.mockResolvedValue({
      id: 30,
      surveyId: 40,
      currentQuestionId: 50,
      status: "in_progress",
    });
    mocks.getSurveyFlow.mockResolvedValue({
      questions: [makeQuestion({ id: 50, type: "text" })],
    });
    mocks.getSession.mockResolvedValue({ currentQuestionId: 50 });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await handleTelegramMessage(createContext(), {
      message_id: 1,
      chat: { id: 2 },
      from: { id: 99 },
      text: "/cancel",
    });

    expect(mocks.upsertTextAnswer).not.toHaveBeenCalled();
    const texts = sentTexts(fetchMock);
    expect(texts.some((text) => text.includes("已取消当前问卷填写"))).toBe(true);
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as {
      reply_markup: {
        inline_keyboard: Array<Array<{ callback_data: string }>>;
      };
    };
    expect(body.reply_markup.inline_keyboard.flat()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ callback_data: "home:surveys" }),
      ]),
    );
  });

  it("still records ordinary text answers", async () => {
    mocks.getUserByTelegramId.mockResolvedValue({
      id: 7,
      telegramUserId: 99,
      systemRole: "participant",
    });
    mocks.getBuilderState.mockResolvedValue({ step: "idle" });
    mocks.getActiveResponseByUser.mockResolvedValue({
      id: 30,
      surveyId: 40,
      currentQuestionId: 50,
      status: "in_progress",
    });
    mocks.getSurveyFlow.mockResolvedValue({
      questions: [
        makeQuestion({ id: 50, type: "text" }),
        makeQuestion({ id: 51, type: "text", required: false }),
      ],
    });
    mocks.getSession.mockResolvedValue({ currentQuestionId: 50 });
    mocks.updateResponseCurrentQuestion.mockResolvedValue(undefined);
    mocks.setSessionCurrentQuestion.mockResolvedValue(undefined);
    mocks.upsertTextAnswer.mockResolvedValue(undefined);
    mocks.getQuestionMediaByQuestionId.mockResolvedValue([]);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await handleTelegramMessage(createContext(), {
      message_id: 1,
      chat: { id: 2 },
      from: { id: 99 },
      text: "我的回答",
    });

    expect(mocks.upsertTextAnswer).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ textValue: "我的回答" }),
    );
  });

  it("blocks submit and jumps to the first unanswered required question", async () => {
    const flow = {
      questions: [
        makeQuestion({ id: 10, type: "single", options: [] }),
        makeQuestion({ id: 50, type: "text" }),
        makeQuestion({ id: 51, type: "text", required: false }),
      ],
    };
    mocks.getUserByTelegramId.mockResolvedValue({
      id: 7,
      telegramUserId: 99,
      systemRole: "participant",
    });
    mocks.getSurveyFlow.mockResolvedValue(flow);
    mocks.getResponseDetail.mockResolvedValue({
      response: { id: 30, surveyId: 40 },
      answers: [
        {
          questionId: 10,
          jsonValue: "[101]",
          textValue: null,
          numberValue: null,
          booleanValue: null,
          ratingValue: null,
          dateValue: null,
          timeValue: null,
        },
      ],
      respondent: null,
    });
    mocks.updateResponseCurrentQuestion.mockResolvedValue(undefined);
    mocks.setSessionCurrentQuestion.mockResolvedValue(undefined);
    mocks.getQuestionMediaByQuestionId.mockResolvedValue([]);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await handleTelegramCallback(createContext(createDbMock({ id: 30, survey_id: 40 })), {
      id: "cb-1",
      from: { id: 99 },
      message: { message_id: 5, chat: { id: 2 } },
      data: "q:submit:40",
    });

    expect(mocks.completeResponse).not.toHaveBeenCalled();
    expect(mocks.completeSession).not.toHaveBeenCalled();
    expect(mocks.updateResponseCurrentQuestion).toHaveBeenCalledWith(
      expect.anything(),
      30,
      50,
    );
    expect(mocks.setSessionCurrentQuestion).toHaveBeenCalledWith(
      expect.anything(),
      99,
      40,
      50,
    );
    expect(sentTexts(fetchMock).some((text) => text.includes("必答题"))).toBe(
      true,
    );
  });

  it("completes the response once every required question on the path is answered", async () => {
    mocks.getUserByTelegramId.mockResolvedValue({
      id: 7,
      telegramUserId: 99,
      systemRole: "participant",
    });
    mocks.getSurveyFlow.mockResolvedValue({
      questions: [
        makeQuestion({ id: 10, type: "single", options: [] }),
        makeQuestion({ id: 50, type: "text" }),
      ],
    });
    mocks.getResponseDetail.mockResolvedValue({
      response: { id: 30, surveyId: 40 },
      answers: [
        {
          questionId: 10,
          jsonValue: "[101]",
          textValue: null,
          numberValue: null,
          booleanValue: null,
          ratingValue: null,
          dateValue: null,
          timeValue: null,
        },
        {
          questionId: 50,
          jsonValue: null,
          textValue: "好的",
          numberValue: null,
          booleanValue: null,
          ratingValue: null,
          dateValue: null,
          timeValue: null,
        },
      ],
      respondent: null,
    });
    mocks.completeResponse.mockResolvedValue(undefined);
    mocks.completeSession.mockResolvedValue(undefined);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await handleTelegramCallback(createContext(createDbMock({ id: 30, survey_id: 40 })), {
      id: "cb-2",
      from: { id: 99 },
      message: { message_id: 6, chat: { id: 2 } },
      data: "q:submit:40",
    });

    expect(mocks.completeResponse).toHaveBeenCalledWith(expect.anything(), 30);
    expect(mocks.completeSession).toHaveBeenCalledWith(
      expect.anything(),
      99,
      40,
    );
    expect(mocks.updateResponseCurrentQuestion).not.toHaveBeenCalled();
    expect(sentTexts(fetchMock).some((text) => text.includes("感谢参与"))).toBe(
      true,
    );
  });

  it("retries sendMessage when Telegram answers 429 with retry_after", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: false,
            description: "Too Many Requests: retry after 1",
            parameters: { retry_after: 1 },
          }),
          { status: 429 },
        ),
      )
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await sendMessage("token", 42, "hello");

    expect(response.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("treats an identical reply markup edit as a successful no-op", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: false,
          description: "Bad Request: message is not modified",
        }),
        { status: 400 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await editMessageReplyMarkup("token", 42, 1, {
      inline_keyboard: [],
    });

    expect(response.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
