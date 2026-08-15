import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUserByTelegramId: vi.fn(),
  getActiveResponseByUser: vi.fn(),
  getBuilderState: vi.fn(),
  handleBuilderMessage: vi.fn(),
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
}));

vi.mock("../../../src/services/survey-builder.service", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../src/services/survey-builder.service")
  >()),
  getBuilderState: mocks.getBuilderState,
}));

vi.mock("../../../src/bot/builder-handler", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/bot/builder-handler")>()),
  handleBuilderMessage: mocks.handleBuilderMessage,
}));

import { handleTelegramMessage } from "../../../src/bot/survey-handler";
import type { BotContext } from "../../../src/bot/types";
import type { SurveySessionNamespace } from "../../../src/services/session.service";
import type { SurveyBuilderNamespace } from "../../../src/services/survey-builder.service";

describe("survey message routing", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("routes an option label edit before an active survey answer", async () => {
    mocks.getUserByTelegramId.mockResolvedValue({
      id: 7,
      telegramUserId: 99,
      systemRole: "admin",
    });
    mocks.getBuilderState.mockResolvedValue({
      step: "edit_option_label",
    });
    mocks.getActiveResponseByUser.mockResolvedValue({
      id: 30,
      surveyId: 40,
      currentQuestionId: 50,
      status: "in_progress",
    });
    mocks.handleBuilderMessage.mockResolvedValue(true);

    const prepare = vi.fn(() => {
      throw new Error("answer routing should not query the survey");
    });
    const ctx: BotContext = {
      botToken: "token",
      db: { prepare } as unknown as D1Database,
      session: {} as SurveySessionNamespace,
      builder: {} as SurveyBuilderNamespace,
      adminIds: [99],
      exportQueue: {} as Queue,
    };

    await handleTelegramMessage(ctx, {
      message_id: 1,
      chat: { id: 2 },
      from: { id: 99 },
      text: "新的选项名称",
    });

    expect(mocks.handleBuilderMessage).toHaveBeenCalledOnce();
    expect(prepare).not.toHaveBeenCalled();
  });
});
