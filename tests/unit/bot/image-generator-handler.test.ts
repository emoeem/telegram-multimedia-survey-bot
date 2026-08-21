import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  renderScreen: vi.fn(),
  answerCallbackQuery: vi.fn(),
  registerMediaAsset: vi.fn(),
  getVisualTemplateById: vi.fn(),
  listVisualTemplates: vi.fn(),
  addGeneratorBackground: vi.fn(),
  addGeneratorQuestion: vi.fn(),
  createGenerator: vi.fn(),
  deleteGenerator: vi.fn(),
  getGenerator: vi.fn(),
  listGeneratorBackgrounds: vi.fn(),
  listGeneratorQuestions: vi.fn(),
  listGenerators: vi.fn(),
  listPublishedGenerators: vi.fn(),
  updateGenerator: vi.fn(),
  enqueueImageGeneratorJob: vi.fn(),
}));

vi.mock("../../../src/bot/ui-message-controller", () => ({ renderScreen: mocks.renderScreen }));
vi.mock("../../../src/bot/telegram", () => ({ answerCallbackQuery: mocks.answerCallbackQuery }));
vi.mock("../../../src/services/media.service", () => ({ registerMediaAsset: mocks.registerMediaAsset }));
vi.mock("../../../src/db/repositories/visual-template.repository", () => ({
  getVisualTemplateById: mocks.getVisualTemplateById,
  listVisualTemplates: mocks.listVisualTemplates,
}));
vi.mock("../../../src/db/repositories/image-generator.repository", () => ({
  addGeneratorBackground: mocks.addGeneratorBackground,
  addGeneratorQuestion: mocks.addGeneratorQuestion,
  createGenerator: mocks.createGenerator,
  deleteGenerator: mocks.deleteGenerator,
  getGenerator: mocks.getGenerator,
  listGeneratorBackgrounds: mocks.listGeneratorBackgrounds,
  listGeneratorQuestions: mocks.listGeneratorQuestions,
  listGenerators: mocks.listGenerators,
  listPublishedGenerators: mocks.listPublishedGenerators,
  updateGenerator: mocks.updateGenerator,
}));
vi.mock("../../../src/services/image-generator-worker.service", () => ({
  enqueueImageGeneratorJob: mocks.enqueueImageGeneratorJob,
}));

import {
  handleImageGeneratorAdminMessage,
  handleImageGeneratorCallback,
  handleImageGeneratorParticipantMessage,
} from "../../../src/bot/image-generator-handler";
import type { BotContext } from "../../../src/bot/types";

function cache() {
  const values = new Map<string, string>();
  return {
    values,
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => { values.set(key, value); }),
    delete: vi.fn(async (key: string) => { values.delete(key); }),
  };
}

function context(state = cache()): BotContext {
  return {
    botToken: "token",
    db: {} as D1Database,
    cache: state as unknown as KVNamespace,
    session: {} as BotContext["session"],
    builder: {} as BotContext["builder"],
    adminIds: [99],
    exportQueue: {} as Queue,
  };
}

function callback(data: string) {
  return {
    id: "callback",
    from: { id: 99 },
    message: { message_id: 500, chat: { id: 3 } },
    data,
  };
}

const publishedGenerator = {
  id: 7,
  ownerId: 1,
  name: "人物海报",
  description: "海报生成器",
  templateId: 12,
  status: "published" as const,
  backgroundMode: "preset" as const,
};

describe("image generator conversation UI", () => {
  beforeEach(() => {
    mocks.renderScreen.mockResolvedValue({ messageId: 500, method: "edit" });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the UI message while collecting values and queueing a template-based PNG", async () => {
    const state = cache();
    const ctx = context(state);
    mocks.getGenerator.mockResolvedValue(publishedGenerator);
    mocks.listGeneratorQuestions.mockResolvedValue([
      { id: 1, generatorId: 7, variableName: "name", prompt: "请输入人物名称", type: "text", required: true, sortOrder: 1 },
    ]);
    mocks.getVisualTemplateById.mockResolvedValue({ id: 12, status: "published", currentVersion: 2 });

    await expect(handleImageGeneratorCallback(ctx, callback("generator:use:7"), 1, false)).resolves.toBe(true);
    await expect(handleImageGeneratorParticipantMessage(ctx, {
      message_id: 501, chat: { id: 3 }, from: { id: 99 }, text: "张三",
    }, 1)).resolves.toBe(true);
    await expect(handleImageGeneratorCallback(ctx, callback("generator:render"), 1, false)).resolves.toBe(true);

    expect(mocks.enqueueImageGeneratorJob).toHaveBeenCalledWith(
      ctx.db,
      ctx.exportQueue,
      expect.objectContaining({
        generatorId: 7,
        templateId: 12,
        templateVersion: 2,
        values: { name: "张三" },
        backgroundAssetId: null,
        chatId: 3,
      }),
    );
    expect(mocks.renderScreen.mock.calls.map(([input]) => input.messageId)).toEqual([500, 500, 500]);
    expect(state.values.get("image-generator-session:99")).toBeUndefined();
  });

  it("stores a generator description while creating it from an existing UI message", async () => {
    const state = cache();
    const ctx = context(state);
    mocks.createGenerator.mockResolvedValue({ ...publishedGenerator, id: 8, status: "draft" });
    mocks.getGenerator.mockResolvedValue({ ...publishedGenerator, id: 8, status: "draft" });
    mocks.getVisualTemplateById.mockResolvedValue({ id: 12, name: "人物模板", status: "published", currentVersion: 2 });
    mocks.listGeneratorQuestions.mockResolvedValue([]);
    mocks.listGeneratorBackgrounds.mockResolvedValue([]);

    await expect(handleImageGeneratorCallback(ctx, callback("generator:new:12"), 1, true)).resolves.toBe(true);
    await expect(handleImageGeneratorAdminMessage(ctx, {
      message_id: 501, chat: { id: 3 }, from: { id: 99 }, text: "人物海报 | 创建人物介绍海报",
    }, 1)).resolves.toBe(true);

    expect(mocks.createGenerator).toHaveBeenCalledWith(ctx.db, {
      ownerId: 1,
      templateId: 12,
      name: "人物海报",
      description: "创建人物介绍海报",
    });
    expect(mocks.renderScreen.mock.calls.map(([input]) => input.messageId)).toEqual([500, 500]);
  });

  it("refuses to publish a generator linked to an unpublished template", async () => {
    const ctx = context();
    mocks.getGenerator.mockResolvedValue({ ...publishedGenerator, status: "draft" });
    mocks.listGeneratorQuestions.mockResolvedValue([{ id: 1 }]);
    mocks.listGeneratorBackgrounds.mockResolvedValue([{ id: 3 }]);
    mocks.getVisualTemplateById.mockResolvedValue({ id: 12, status: "draft", currentVersion: 2 });

    await expect(handleImageGeneratorCallback(ctx, callback("generator:publish:7"), 1, true)).rejects.toThrow("已发布");
    expect(mocks.updateGenerator).not.toHaveBeenCalled();
  });

  it("returns to the same report settings page after uploading its default background", async () => {
    const state = cache();
    const ctx = context(state);
    const generator = { ...publishedGenerator, status: "draft" as const, reportBackgroundAssetId: null, reportContrastMode: "auto" as const };
    mocks.getGenerator.mockResolvedValue(generator);
    mocks.getVisualTemplateById.mockResolvedValue({ id: 12, name: "浅色数据报告" });
    mocks.listGeneratorQuestions.mockResolvedValue([]);
    mocks.listGeneratorBackgrounds.mockResolvedValue([]);
    mocks.registerMediaAsset.mockResolvedValue(33);

    await expect(handleImageGeneratorCallback(ctx, callback("generator:report_background:7"), 1, true)).resolves.toBe(true);
    await expect(handleImageGeneratorAdminMessage(ctx, {
      message_id: 501, chat: { id: 3 }, from: { id: 99 }, photo: [{ file_id: "background-file", file_unique_id: "background-unique" }],
    }, 1)).resolves.toBe(true);

    expect(mocks.updateGenerator).toHaveBeenCalledWith(ctx.db, 7, { reportBackgroundAssetId: 33 });
    expect(mocks.renderScreen.mock.calls.at(-1)?.[0].text).toContain("报告默认背景");
  });

  it("asks before permanently deleting a report and then returns to the report list", async () => {
    const ctx = context();
    mocks.getGenerator.mockResolvedValue({ ...publishedGenerator, reportBackgroundAssetId: null, reportContrastMode: "auto" });
    mocks.listGenerators.mockResolvedValue([]);

    await expect(handleImageGeneratorCallback(ctx, callback("generator:delete_ask:7"), 1, true)).resolves.toBe(true);
    expect(mocks.renderScreen.mock.calls.at(-1)?.[0].text).toContain("确认永久删除报告");
    await expect(handleImageGeneratorCallback(ctx, callback("generator:delete_confirm:7"), 1, true)).resolves.toBe(true);

    expect(mocks.deleteGenerator).toHaveBeenCalledWith(ctx.db, 7);
    expect(mocks.renderScreen.mock.calls.at(-1)?.[0].screen).toBe("IMAGE_GENERATOR_ADMIN");
  });
});
