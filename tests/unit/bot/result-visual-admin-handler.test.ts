import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSurveyById: vi.fn(),
  getSurveyResultRuleSet: vi.fn(),
  saveSurveyResultRuleSet: vi.fn(),
  getSurveyResultVisualSettings: vi.fn(),
  saveSurveyResultVisualSettings: vi.fn(),
  createVisualTemplate: vi.fn(),
  createVisualTemplateVersion: vi.fn(),
  deleteVisualTemplate: vi.fn(),
  getVisualTemplateById: vi.fn(),
  getVisualTemplateVersion: vi.fn(),
  listVisualTemplates: vi.fn(),
  updateVisualTemplateStatus: vi.fn(),
  registerMediaAsset: vi.fn(),
  renderResultVisualPng: vi.fn(),
  resolveResultVisualImages: vi.fn(),
}));

vi.mock("../../../src/db/repositories/survey.repository", () => ({
  getSurveyById: mocks.getSurveyById,
}));

vi.mock("../../../src/db/repositories/result-profile.repository", () => ({
  getSurveyResultRuleSet: mocks.getSurveyResultRuleSet,
  saveSurveyResultRuleSet: mocks.saveSurveyResultRuleSet,
}));

vi.mock("../../../src/db/repositories/survey-result-visual-settings.repository", () => ({
  getSurveyResultVisualSettings: mocks.getSurveyResultVisualSettings,
  saveSurveyResultVisualSettings: mocks.saveSurveyResultVisualSettings,
}));

vi.mock("../../../src/db/repositories/visual-template.repository", () => ({
  createVisualTemplate: mocks.createVisualTemplate,
  createVisualTemplateVersion: mocks.createVisualTemplateVersion,
  deleteVisualTemplate: mocks.deleteVisualTemplate,
  getVisualTemplateById: mocks.getVisualTemplateById,
  getVisualTemplateVersion: mocks.getVisualTemplateVersion,
  listVisualTemplates: mocks.listVisualTemplates,
  updateVisualTemplateStatus: mocks.updateVisualTemplateStatus,
}));

vi.mock("../../../src/services/media.service", () => ({
  registerMediaAsset: mocks.registerMediaAsset,
}));

vi.mock("../../../src/services/result-visual-renderer.service", () => ({
  renderResultVisualPng: mocks.renderResultVisualPng,
}));

vi.mock("../../../src/services/result-visual-font", () => ({
  RESULT_VISUAL_FONT: new Uint8Array([1]),
  RESULT_VISUAL_FONTS: [new Uint8Array([1])],
}));

vi.mock("../../../src/services/result-visual-wasm", () => ({
  RESULT_VISUAL_WASM: {} as WebAssembly.Module,
}));

vi.mock("../../../src/services/result-visual-image.service", () => ({
  resolveResultVisualImages: mocks.resolveResultVisualImages,
}));

import {
  handleResultVisualAdminCallback,
  handleResultVisualAdminMessage,
} from "../../../src/bot/result-visual-admin-handler";
import type { BotContext } from "../../../src/bot/types";
import type { SurveySessionNamespace } from "../../../src/services/session.service";
import type { SurveyBuilderNamespace } from "../../../src/services/survey-builder.service";

function context(): BotContext {
  return {
    botToken: "token",
    db: {} as D1Database,
    session: {} as SurveySessionNamespace,
    builder: {} as SurveyBuilderNamespace,
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

describe("result visual admin UI", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("edits the existing admin message to show template management", async () => {
    mocks.listVisualTemplates.mockResolvedValue([{
      id: 5,
      name: "通用完成结果卡",
      status: "published",
      currentVersion: 1,
    }]);
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(handleResultVisualAdminCallback(context(), callback("visual:list"), 1)).resolves.toBe(true);

    const editCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/editMessageText"));
    expect(editCall).toBeDefined();
    expect(JSON.parse(String((editCall?.[1] as RequestInit).body))).toMatchObject({
      chat_id: 3,
      message_id: 500,
      text: expect.stringContaining("视觉模板"),
    });
  });

  it("binds only a published template and creates a safe default result rule", async () => {
    mocks.getVisualTemplateById.mockResolvedValue({ id: 5, status: "published", currentVersion: 1 });
    mocks.getSurveyResultVisualSettings.mockResolvedValue({
      surveyId: 40,
      enabled: false,
      autoGenerate: false,
      templateId: null,
      updatedAt: "",
    });
    mocks.getSurveyResultRuleSet.mockResolvedValue(null);
    mocks.getSurveyById.mockResolvedValue({ id: 40, title: "满意度调查" });
    mocks.listVisualTemplates.mockResolvedValue([{
      id: 5,
      name: "通用完成结果卡",
      status: "published",
      currentVersion: 1,
    }]);
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(handleResultVisualAdminCallback(context(), callback("visual:select:40:5"), 1)).resolves.toBe(true);

    expect(mocks.saveSurveyResultRuleSet).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ surveyId: 40, createdBy: 1 }),
    );
    expect(mocks.saveSurveyResultVisualSettings).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ surveyId: 40, templateId: 5 }),
    );
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/editMessageText");
  });

  it("stores an uploaded background as a Telegram media asset in a new template version", async () => {
    const blankDefinition = {
      schemaVersion: 1,
      width: 1080,
      height: 1920,
      format: "png",
      background: { type: "solid", color: "#111827" },
      variables: [],
      elements: [],
    };
    mocks.getVisualTemplateById.mockResolvedValue({
      id: 5, name: "海报模板", description: null, type: "custom", status: "draft", currentVersion: 1,
    });
    mocks.getVisualTemplateVersion.mockResolvedValue({
      templateId: 5, version: 1, definitionJson: JSON.stringify(blankDefinition), variablesJson: "[]",
    });
    mocks.registerMediaAsset.mockResolvedValue(11);
    const state = new Map<string, string>();
    state.set("result-visual-template-editor:99", JSON.stringify({
      mode: "background", templateId: 5, chatId: 3, messageId: 500,
    }));
    const cache = {
      get: vi.fn(async (key: string) => state.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => { state.set(key, value); }),
      delete: vi.fn(async (key: string) => { state.delete(key); }),
    } as unknown as KVNamespace;
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const handled = await handleResultVisualAdminMessage(
      { ...context(), cache },
      {
        message_id: 501,
        chat: { id: 3 },
        from: { id: 99 },
        photo: [{ file_id: "photo", file_unique_id: "unique", width: 1080, height: 1920 }],
      },
      1,
    );

    expect(handled).toBe(true);
    expect(mocks.registerMediaAsset).toHaveBeenCalledOnce();
    const versionInput = mocks.createVisualTemplateVersion.mock.calls[0]?.[1] as { definitionJson: string };
    expect(JSON.parse(versionInput.definitionJson).background).toEqual({
      type: "telegram_asset", assetId: 11, fit: "cover",
    });
  });

  it("adds a configured dynamic text element as a new immutable template version", async () => {
    const blankDefinition = {
      schemaVersion: 1,
      width: 1080,
      height: 1920,
      format: "png",
      background: { type: "solid", color: "#111827" },
      variables: [],
      elements: [],
    };
    mocks.getVisualTemplateById.mockResolvedValue({
      id: 5, name: "海报模板", description: null, type: "custom", status: "draft", currentVersion: 1,
    });
    mocks.getVisualTemplateVersion.mockResolvedValue({
      templateId: 5, version: 1, definitionJson: JSON.stringify(blankDefinition), variablesJson: "[]",
    });
    const state = new Map<string, string>();
    state.set("result-visual-template-editor:99", JSON.stringify({
      mode: "element_layout", templateId: 5, chatId: 3, messageId: 500,
      elementType: "text", source: "{{result.fields.name}}",
    }));
    const cache = {
      get: vi.fn(async (key: string) => state.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => { state.set(key, value); }),
      delete: vi.fn(async (key: string) => { state.delete(key); }),
    } as unknown as KVNamespace;
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const handled = await handleResultVisualAdminMessage(
      { ...context(), cache },
      { message_id: 502, chat: { id: 3 }, from: { id: 99 }, text: "90,300,900,64,center,#FFFFFF" },
      1,
    );

    expect(handled).toBe(true);
    const versionInput = mocks.createVisualTemplateVersion.mock.calls[0]?.[1] as { definitionJson: string };
    const definition = JSON.parse(versionInput.definitionJson) as {
      variables: Array<{ path: string }>;
      elements: Array<{ type: string; value: string; x: number; align: string }>;
    };
    expect(definition.variables).toContainEqual(expect.objectContaining({ path: "result.fields.name" }));
    expect(definition.elements).toContainEqual(expect.objectContaining({
      type: "text", value: "{{result.fields.name}}", x: 90, align: "center",
    }));
  });

  it("acknowledges a preview click before sending the rendered PNG", async () => {
    const definition = {
      schemaVersion: 1,
      width: 1080,
      height: 1920,
      format: "png",
      background: { type: "solid", color: "#111827" },
      variables: [],
      elements: [],
    };
    mocks.getVisualTemplateById.mockResolvedValue({
      id: 5, name: "海报模板", status: "draft", currentVersion: 1,
    });
    mocks.getVisualTemplateVersion.mockResolvedValue({
      templateId: 5, version: 1, definitionJson: JSON.stringify(definition), variablesJson: "[]",
    });
    mocks.resolveResultVisualImages.mockResolvedValue({});
    mocks.renderResultVisualPng.mockResolvedValue(new Uint8Array([1, 2, 3]));
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(handleResultVisualAdminCallback(context(), callback("visual:preview:5"), 1)).resolves.toBe(true);

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/answerCallbackQuery");
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/sendPhoto"))).toBe(true);
  });
});
