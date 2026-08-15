import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getQuestionById: vi.fn(),
  listOptionsForQuestions: vi.fn(),
  listQuestionsBySurvey: vi.fn(),
  getQuestionMediaByQuestionId: vi.fn(),
  listOptionMediaByOptionIds: vi.fn(),
  getSurveyById: vi.fn(),
  getUserByTelegramId: vi.fn(),
  assertCanManageSurvey: vi.fn(),
  getResponseCount: vi.fn(),
  sendLongMessage: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock("../../../src/db/repositories/question.repository", () => ({
  getQuestionById: mocks.getQuestionById,
  listOptionsForQuestions: mocks.listOptionsForQuestions,
  listQuestionsBySurvey: mocks.listQuestionsBySurvey,
}));

vi.mock("../../../src/db/repositories/media.repository", () => ({
  getQuestionMediaByQuestionId: mocks.getQuestionMediaByQuestionId,
  listOptionMediaByOptionIds: mocks.listOptionMediaByOptionIds,
}));

vi.mock("../../../src/db/repositories/survey.repository", () => ({
  getSurveyById: mocks.getSurveyById,
}));

vi.mock("../../../src/db/repositories/user.repository", () => ({
  getUserByTelegramId: mocks.getUserByTelegramId,
}));

vi.mock("../../../src/services/permission.service", () => ({
  assertCanManageSurvey: mocks.assertCanManageSurvey,
}));

vi.mock("../../../src/services/statistics.service", () => ({
  getResponseCount: mocks.getResponseCount,
}));

vi.mock("../../../src/bot/telegram", () => ({
  sendLongMessage: mocks.sendLongMessage,
  sendMessage: mocks.sendMessage,
}));

import { showQuestionEditor } from "../../../src/bot/question-editor";
import type { BotContext } from "../../../src/bot/types";
import type { SurveyBuilderNamespace } from "../../../src/services/survey-builder.service";
import type { SurveySessionNamespace } from "../../../src/services/session.service";

function createContext(): BotContext {
  return {
    botToken: "token",
    db: {} as D1Database,
    builder: {} as SurveyBuilderNamespace,
    session: {} as SurveySessionNamespace,
    adminIds: [99],
    exportQueue: {} as Queue,
  };
}

function callbackData(): string[] {
  const replyMarkup = mocks.sendLongMessage.mock.calls[0]?.[3] as {
    inline_keyboard: Array<Array<{ callback_data: string }>>;
  };
  return replyMarkup.inline_keyboard
    .flat()
    .map((button) => button.callback_data);
}

describe("question editor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUserByTelegramId.mockResolvedValue({
      id: 7,
      telegramUserId: 99,
    });
    mocks.getQuestionMediaByQuestionId.mockResolvedValue([]);
    mocks.listOptionMediaByOptionIds.mockResolvedValue([]);
    mocks.getResponseCount.mockResolvedValue(0);
    mocks.listOptionsForQuestions.mockResolvedValue([
      {
        id: 21,
        questionId: 10,
        label: "选项一",
        value: "选项一",
        order: 0,
      },
      {
        id: 22,
        questionId: 10,
        label: "选项二",
        value: "选项二",
        order: 1,
      },
    ]);
  });

  it("shows option structure controls for single-choice questions", async () => {
    mocks.getQuestionById.mockResolvedValue({
      id: 10,
      surveyId: 5,
      type: "single",
      title: "请选择",
      required: true,
      order: 0,
    });

    await showQuestionEditor(createContext(), 2, 99, 10);

    const callbacks = callbackData();
    expect(callbacks).toContain("qedit:option_add:10");
    expect(callbacks).toContain("qedit:option_up:21");
    expect(callbacks).toContain("qedit:option_delete_ask:21");
  });

  it("keeps rating options fixed", async () => {
    mocks.getQuestionById.mockResolvedValue({
      id: 10,
      surveyId: 5,
      type: "rating",
      title: "请评分",
      required: true,
      order: 0,
    });

    await showQuestionEditor(createContext(), 2, 99, 10);

    const callbacks = callbackData();
    expect(callbacks).not.toContain("qedit:option_add:10");
    expect(callbacks).not.toContain("qedit:option_up:21");
    expect(callbacks).not.toContain("option_label:21");
    expect(callbacks).toContain("option_media:21");
  });

  it("only offers duplication when responses already exist", async () => {
    mocks.getQuestionById.mockResolvedValue({
      id: 10,
      surveyId: 5,
      type: "single",
      title: "请选择",
      required: true,
      order: 0,
    });
    mocks.getResponseCount.mockResolvedValue(3);

    await showQuestionEditor(createContext(), 2, 99, 10);

    const callbacks = callbackData();
    expect(callbacks).toEqual([
      "owner:duplicate:5",
      "qedit:list:5",
    ]);
  });
});
