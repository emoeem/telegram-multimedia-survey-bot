import {
  answerCallbackQuery,
  sendDocument,
  sendMessage,
  sendPhoto,
  type InlineKeyboardMarkup,
} from "./telegram";
import { renderScreen } from "./ui-message-controller";
import type { BotContext, TelegramCallbackQuery, TelegramMessage } from "./types";
import { registerMediaAsset } from "../services/media.service";
import { applyReportPresentation, type ReportContrastMode } from "../services/report-presentation.service";
import { getMediaAssetById } from "../db/repositories/media.repository";
import { getSurveyById } from "../db/repositories/survey.repository";
import {
  getSurveyResultRuleSet,
  saveSurveyResultRuleSet,
} from "../db/repositories/result-profile.repository";
import {
  getSurveyResultVisualSettings,
  saveSurveyResultVisualSettings,
} from "../db/repositories/survey-result-visual-settings.repository";
import {
  createVisualTemplate,
  createVisualTemplateVersion,
  deleteVisualTemplate,
  getVisualTemplateById,
  getVisualTemplateVersion,
  listVisualTemplates,
  updateVisualTemplateStatus,
} from "../db/repositories/visual-template.repository";
import type { ResultProfileSnapshot } from "../result/schema";
import { parseVisualTemplateDefinition } from "../services/visual-template-validator.service";
import {
  characterCardExampleTemplate,
  completionResultExampleTemplate,
  customResultPosterExampleTemplate,
  personalityResultExampleTemplate,
  visualReportExampleTemplate,
} from "../visual-template/examples";
import type { VisualTemplateDefinition } from "../visual-template/schema";

const templateImportStatePrefix = "result-visual-template-import:";
const templateEditorStatePrefix = "result-visual-template-editor:";

export async function clearResultVisualInteractionState(ctx: BotContext, userId: number): Promise<void> {
  await Promise.all([
    ctx.cache?.delete(templateImportStateKey(userId)),
    ctx.cache?.delete(templateEditorStateKey(userId)),
  ]);
}

type BuiltInTemplateKind = "completion" | "character" | "personality" | "poster" | "report";

type TemplateEditorState =
  | {
      mode: "background";
      templateId: number;
      chatId: number;
      messageId: number;
    }
  | {
      mode: "element_variable";
      templateId: number;
      chatId: number;
      messageId: number;
      elementType: "text" | "image" | "badge";
    }
  | {
      mode: "element_layout";
      templateId: number;
      chatId: number;
      messageId: number;
      elementType: "text" | "image" | "badge";
      source: string;
    };

const builtInTemplates: Record<BuiltInTemplateKind, { name: string; type: string; definition: VisualTemplateDefinition }> = {
  completion: { name: "通用完成结果卡", type: "result_card", definition: completionResultExampleTemplate },
  character: { name: "游戏角色卡", type: "character_card", definition: characterCardExampleTemplate },
  personality: { name: "人格结果卡", type: "result_card", definition: personalityResultExampleTemplate },
  poster: { name: "自定义结果海报", type: "poster", definition: customResultPosterExampleTemplate },
  report: { name: "个人特质量化报告", type: "report", definition: visualReportExampleTemplate },
};

function templateImportStateKey(userId: number): string {
  return `${templateImportStatePrefix}${userId}`;
}

function templateEditorStateKey(userId: number): string {
  return `${templateEditorStatePrefix}${userId}`;
}

async function getTemplateEditorState(
  ctx: BotContext,
  userId: number,
): Promise<TemplateEditorState | null> {
  const raw = await ctx.cache?.get(templateEditorStateKey(userId));
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const templateId = value.templateId;
    const chatId = value.chatId;
    const messageId = value.messageId;
    const mode = value.mode;
    if (
      typeof templateId !== "number" || !Number.isSafeInteger(templateId) ||
      typeof chatId !== "number" || !Number.isSafeInteger(chatId) ||
      typeof messageId !== "number" || !Number.isSafeInteger(messageId) ||
      !["background", "element_variable", "element_layout"].includes(String(mode))
    ) return null;
    if (mode === "background") {
      return { mode: "background", templateId, chatId, messageId };
    }
    if (
      !["text", "image", "badge"].includes(String(value.elementType))
    ) return null;
    const elementType = value.elementType as "text" | "image" | "badge";
    if (mode === "element_variable") {
      return {
        mode: "element_variable", templateId, chatId, messageId, elementType,
      };
    }
    if (typeof value.source !== "string") return null;
    return {
      mode: "element_layout", templateId, chatId, messageId, elementType,
      source: value.source,
    };
  } catch {
    return null;
  }
}

async function setTemplateEditorState(
  ctx: BotContext,
  userId: number,
  state: TemplateEditorState,
): Promise<void> {
  if (!ctx.cache) throw new Error("当前部署未启用模板编辑状态");
  await ctx.cache.put(templateEditorStateKey(userId), JSON.stringify(state), { expirationTtl: 15 * 60 });
}

function blankPosterTemplate(): VisualTemplateDefinition {
  return {
    schemaVersion: 1,
    width: 1080,
    height: 1920,
    format: "png",
    background: { type: "solid", color: "#111827" },
    variables: [],
    elements: [],
  };
}

function elementSummary(element: VisualTemplateDefinition["elements"][number], index: number): string {
  const source = element.type === "image" ? element.source : element.value;
  const dimensions = element.type === "image"
    ? `${element.width ?? 0}×${element.height ?? 0}`
    : `字号 ${element.fontSize ?? 32}`;
  return `${index + 1}. ${element.type === "image" ? "🖼" : element.type === "badge" ? "🏷" : "📝"} ${source ?? ""}\n   X: ${element.x ?? 0} · Y: ${element.y ?? 0} · ${dimensions}`;
}

function ensureEditorVariable(
  definition: VisualTemplateDefinition,
  expression: string,
  type: "text" | "image",
): void {
  const path = expression.slice(2, -2);
  if (definition.variables.some((variable) => variable.path === path)) return;
  definition.variables.push({
    path,
    label: path.startsWith("result.images.") ? `图片：${path.slice("result.images.".length)}` : `结果字段：${path.slice("result.".length)}`,
    type,
  });
}

function nextElementId(type: string): string {
  return `${type}-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function statusLabel(status: "draft" | "published" | "archived"): string {
  return status === "published" ? "已发布" : status === "archived" ? "已停用" : "草稿";
}

function compact(value: string, max = 28): string {
  return Array.from(value).length <= max ? value : `${Array.from(value).slice(0, max - 1).join("")}…`;
}

async function render(
  ctx: BotContext,
  chatId: number,
  userId: number,
  screen: string,
  text: string,
  replyMarkup: InlineKeyboardMarkup,
  messageId?: number,
): Promise<void> {
  if (messageId === undefined) {
    await sendMessage(ctx.botToken, chatId, text, replyMarkup);
    return;
  }
  await renderScreen({ botToken: ctx.botToken, chatId, userId, messageId, screen, text, replyMarkup });
}

async function loadTemplateDefinition(
  ctx: BotContext,
  templateId: number,
): Promise<{ template: Awaited<ReturnType<typeof getVisualTemplateById>> & {}; definition: VisualTemplateDefinition }> {
  const template = await getVisualTemplateById(ctx.db, templateId);
  if (!template?.currentVersion) throw new Error("模板不存在或没有可编辑版本");
  const version = await getVisualTemplateVersion(ctx.db, template.id, template.currentVersion);
  if (!version) throw new Error("模板版本不存在");
  return { template, definition: parseVisualTemplateDefinition(version.definitionJson) };
}

async function saveTemplateDefinition(
  ctx: BotContext,
  templateId: number,
  userId: number,
  definition: VisualTemplateDefinition,
): Promise<void> {
  const template = await getVisualTemplateById(ctx.db, templateId);
  if (!template?.currentVersion) throw new Error("模板不存在或没有可编辑版本");
  const checked = parseVisualTemplateDefinition(JSON.stringify(definition));
  await createVisualTemplateVersion(ctx.db, {
    templateId,
    version: template.currentVersion + 1,
    templateSchemaVersion: checked.schemaVersion,
    definitionJson: JSON.stringify(checked),
    variablesJson: JSON.stringify(checked.variables),
    createdBy: userId,
  });
}

async function showTemplateEditor(
  ctx: BotContext,
  chatId: number,
  userId: number,
  templateId: number,
  messageId?: number,
): Promise<void> {
  const { template, definition } = await loadTemplateDefinition(ctx, templateId);
  const backgroundAsset = definition.background.type === "telegram_asset"
    ? await getMediaAssetById(ctx.db, definition.background.assetId)
    : null;
  const background = definition.background.type === "telegram_asset"
    ? `🖼 Telegram 图片 #${definition.background.assetId}${backgroundAsset?.width && backgroundAsset.height ? ` · ${backgroundAsset.width} × ${backgroundAsset.height}` : ""}`
    : definition.background.type === "gradient"
      ? "🎨 渐变背景"
      : definition.background.type === "solid"
        ? `🎨 纯色 ${definition.background.color}`
        : "🖼 动态图片背景";
  const elements = definition.elements.map(elementSummary);
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [
    [{ text: "🖼 上传背景", callback_data: `visual:editor:background:${templateId}` }],
    [
      { text: "➕ 添加文字", callback_data: `visual:editor:add:text:${templateId}` },
      { text: "➕ 添加图片", callback_data: `visual:editor:add:image:${templateId}` },
    ],
    [{ text: "🏷 添加属性/标签", callback_data: `visual:editor:add:badge:${templateId}` }],
    [{ text: "👁 预览", callback_data: `visual:preview:${templateId}` }, { text: "💾 保存草稿", callback_data: `visual:editor:save:${templateId}` }],
    [template.status === "published"
      ? { text: "⏸ 停用", callback_data: `visual:archive:${templateId}` }
      : { text: "🚀 发布", callback_data: `visual:publish:${templateId}` }],
    [{ text: "⬅️ 返回模板详情", callback_data: `visual:view:${templateId}` }],
  ];
  await render(ctx, chatId, userId, "VISUAL_TEMPLATE_EDITOR", [
    "🎨 模板编辑器",
    `模板：${template.name}`,
    `画布：${definition.width} × ${definition.height}`,
    `背景：${background}`,
    "",
    "元素：",
    ...(elements.length > 0 ? elements : ["尚未添加动态元素。"]),
    "",
    "添加动态元素后，从字段列表选择数据来源；无需输入变量地址。",
  ].join("\n"), { inline_keyboard: rows }, messageId);
}

async function createBlankPosterTemplate(ctx: BotContext, userId: number): Promise<number> {
  const definition = blankPosterTemplate();
  const template = await createVisualTemplate(ctx.db, {
    ownerId: userId,
    surveyId: null,
    name: `海报模板 ${new Date().toISOString().slice(0, 10)}`,
    description: "由 Telegram 背景图片和动态元素组成。",
    type: "custom",
  });
  await createVisualTemplateVersion(ctx.db, {
    templateId: template.id,
    version: 1,
    templateSchemaVersion: definition.schemaVersion,
    definitionJson: JSON.stringify(definition),
    variablesJson: JSON.stringify(definition.variables),
    createdBy: userId,
  });
  return template.id;
}

async function showTemplateList(
  ctx: BotContext,
  chatId: number,
  userId: number,
  messageId?: number,
): Promise<void> {
  const templates = await listVisualTemplates(ctx.db, 20);
  const rows: InlineKeyboardMarkup["inline_keyboard"] = templates.map((template) => [{
    text: `${template.status === "published" ? "🟢" : template.status === "archived" ? "⚫" : "📝"} ${compact(template.name)} · v${template.currentVersion ?? "-"}`,
    callback_data: `visual:view:${template.id}`,
  }]);
  rows.push([{ text: "➕ 创建模板", callback_data: "visual:create" }]);
  rows.push([{ text: "📊 报告生成器", callback_data: "generator:list" }]);
  rows.push([{ text: "📥 导入 JSON", callback_data: "visual:import" }]);
  rows.push([{ text: "⬅️ 返回管理员中心", callback_data: "admin:home" }]);
  const text = templates.length === 0
    ? "🎨 视觉模板\n\n还没有模板。可从内置结果卡开始，之后也能导入经过校验的模板 JSON。"
    : `🎨 视觉模板\n\n共 ${templates.length} 个模板。已发布模板可关联到问卷，用于生成 PNG 结果卡。`;
  await render(ctx, chatId, userId, "VISUAL_TEMPLATE_LIST", text, { inline_keyboard: rows }, messageId);
}

async function showCreateMenu(
  ctx: BotContext,
  chatId: number,
  userId: number,
  messageId?: number,
): Promise<void> {
  await render(ctx, chatId, userId, "VISUAL_TEMPLATE_CREATE", "🎨 创建视觉模板\n\n先选择一个可编辑、可复制的内置结构。它们使用不同的 ResultProfile 字段，不会把角色卡字段写死到 Renderer。", {
    inline_keyboard: [
      [{ text: "🖼 上传海报背景并编辑", callback_data: "visual:create:blank" }],
      [{ text: "✅ 通用完成结果卡", callback_data: "visual:seed:completion" }],
      [{ text: "🎮 游戏角色卡", callback_data: "visual:seed:character" }],
      [{ text: "🧠 人格结果卡", callback_data: "visual:seed:personality" }],
      [{ text: "🖼 自定义结果海报", callback_data: "visual:seed:poster" }],
      [{ text: "📊 长图量化报告", callback_data: "visual:seed:report" }],
      [{ text: "⬅️ 返回模板列表", callback_data: "visual:list" }],
    ],
  }, messageId);
}

async function createBuiltInTemplate(
  ctx: BotContext,
  userId: number,
  kind: BuiltInTemplateKind,
): Promise<number> {
  const builtIn = builtInTemplates[kind];
  const definition = parseVisualTemplateDefinition(JSON.stringify(builtIn.definition));
  const template = await createVisualTemplate(ctx.db, {
    ownerId: null,
    surveyId: null,
    name: builtIn.name,
    description: "由内置模板创建；可复制、导出和继续编辑。",
    type: builtIn.type,
  });
  await createVisualTemplateVersion(ctx.db, {
    templateId: template.id,
    version: 1,
    templateSchemaVersion: definition.schemaVersion,
    definitionJson: JSON.stringify(definition),
    variablesJson: JSON.stringify(definition.variables),
    createdBy: userId,
  });
  return template.id;
}

async function showTemplateDetail(
  ctx: BotContext,
  chatId: number,
  userId: number,
  templateId: number,
  messageId?: number,
): Promise<void> {
  const template = await getVisualTemplateById(ctx.db, templateId);
  if (!template) throw new Error("模板不存在");
  const version = template.currentVersion
    ? await getVisualTemplateVersion(ctx.db, template.id, template.currentVersion)
    : null;
  const variables = version ? JSON.parse(version.variablesJson) as Array<{ label?: string; path?: string }> : [];
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [
    [{ text: "🛠 编辑背景与元素", callback_data: `visual:editor:${template.id}` }],
    [{ text: "👁 预览", callback_data: `visual:preview:${template.id}` }, { text: "📤 导出 JSON", callback_data: `visual:export:${template.id}` }],
    [{ text: "📋 复制模板", callback_data: `visual:copy:${template.id}` }],
    [template.status === "published"
      ? { text: "⏸ 停用", callback_data: `visual:archive:${template.id}` }
      : { text: "🚀 发布", callback_data: `visual:publish:${template.id}` }],
    [{ text: "🗑 删除", callback_data: `visual:delete_ask:${template.id}` }],
    [{ text: "⬅️ 返回模板列表", callback_data: "visual:list" }],
  ];
  const variableLines = variables.slice(0, 8).map((variable) => `• ${variable.label ?? "变量"}：${variable.path ?? ""}`);
  await render(ctx, chatId, userId, "VISUAL_TEMPLATE_DETAIL", [
    `🎨 ${template.name}`,
    `类型：${template.type}`,
    `状态：${statusLabel(template.status)}`,
    `版本：v${template.currentVersion ?? "未创建"}`,
    template.description ? `说明：${template.description}` : "",
    "",
    "模板变量：",
    ...(variableLines.length > 0 ? variableLines : ["尚无变量"]),
  ].filter(Boolean).join("\n"), { inline_keyboard: rows }, messageId);
}

function demoProfile(): ResultProfileSnapshot {
  return {
    resultType: "demo",
    title: "测试结果",
    subtitle: "这是模板预览，不使用真实答卷数据。",
    schemaVersion: 1,
    fields: {
      name: { id: "name", type: "text", value: "测试角色" },
      title: { id: "title", type: "text", value: "夜行者" },
      role: { id: "role", type: "text", value: "探索者" },
      level: { id: "level", type: "integer", value: 42 },
      rarity: { id: "rarity", type: "enum", value: "SSR" },
      description: { id: "description", type: "long_text", value: "此图片只使用脱敏的 Demo ResultProfile，展示模板布局、文字和属性区域。" },
      personality: { id: "personality", type: "enum", value: "分析者" },
      summary: { id: "summary", type: "long_text", value: "你倾向于先理解环境，再做出清晰的判断。" },
      traits: { id: "traits", type: "tags", value: ["冷静", "好奇"] },
      category: { id: "category", type: "enum", value: "自定义分类" },
      relationship: { id: "relationship", type: "text", value: "协作伙伴" },
      special_label: { id: "special_label", type: "text", value: "自定义结果" },
      special_trait: { id: "special_trait", type: "text", value: "将不确定性转化为新的选择" },
    },
    stats: [
      { id: "focus", label: "专注度", value: 92, max: 100 },
      { id: "communication", label: "沟通", value: 76, max: 100 },
      { id: "activity", label: "活跃", value: 65, max: 100 },
      { id: "social", label: "社交", value: 88, max: 100 },
    ],
    tags: ["冷静", "观察者"],
    images: {
      demoPhotoOne: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyMDAiIGhlaWdodD0iMjAwIj48cmVjdCB3aWR0aD0iMjAwIiBoZWlnaHQ9IjIwMCIgZmlsbD0iI2ZkYmE3NCIvPjxjaXJjbGUgY3g9IjEwMCIgY3k9Ijc2IiByPSI0MCIgZmlsbD0iI2ZmZWVkNSIvPjxwYXRoIGQ9Ik0zMCAyMDBjMTAtNTAgMTMwLTUwIDE0MCAwIiBmaWxsPSIjZmZlZWQ1Ii8+PC9zdmc+",
      demoPhotoTwo: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyMDAiIGhlaWdodD0iMjAwIj48cmVjdCB3aWR0aD0iMjAwIiBoZWlnaHQ9IjIwMCIgZmlsbD0iI2ZiNzE4NSIvPjxwYXRoIGQ9Ik00MCAxNjBMODAgNjBsNDAgNjBsNDAtNjAiIGZpbGw9Im5vbmUiIHN0cm9rZT0iI2ZmZmZmZiIgc3Ryb2tlLXdpZHRoPSIxNiIvPjwvc3ZnPg==",
    },
    metadata: {
      profile: [{ label: "姓名", value: "测试角色" }, { label: "所在地区", value: "上海" }, { label: "角色", value: "探索者" }],
      status: [{ name: "已完成", passed: true }, { name: "已验证", passed: true }, { name: "公开展示", passed: false }],
      summary: "这是一段仅用于预览的脱敏长文本。模板会根据实际回答自动换行并向下扩展，不会读取任何真实答卷。",
      gallery: [
        "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyMDAiIGhlaWdodD0iMjAwIj48cmVjdCB3aWR0aD0iMjAwIiBoZWlnaHQ9IjIwMCIgZmlsbD0iI2ZkYmE3NCIvPjxjaXJjbGUgY3g9IjEwMCIgY3k9Ijc2IiByPSI0MCIgZmlsbD0iI2ZmZWVkNSIvPjxwYXRoIGQ9Ik0zMCAyMDBjMTAtNTAgMTMwLTUwIDE0MCAwIiBmaWxsPSIjZmZlZWQ1Ii8+PC9zdmc+",
        "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyMDAiIGhlaWdodD0iMjAwIj48cmVjdCB3aWR0aD0iMjAwIiBoZWlnaHQ9IjIwMCIgZmlsbD0iI2ZiNzE4NSIvPjxwYXRoIGQ9Ik00MCAxNjBMODAgNjBsNDAgNjBsNDAtNjAiIGZpbGw9Im5vbmUiIHN0cm9rZT0iI2ZmZmZmZiIgc3Ryb2tlLXdpZHRoPSIxNiIvPjwvc3ZnPg==",
      ],
    },
  };
}

export async function previewTemplate(ctx: BotContext, chatId: number, templateId: number, presentation?: { backgroundAssetId: number | null; contrastMode: ReportContrastMode }): Promise<void> {
  const template = await getVisualTemplateById(ctx.db, templateId);
  const version = template?.currentVersion ? await getVisualTemplateVersion(ctx.db, template.id, template.currentVersion) : null;
  if (!template || !version) throw new Error("模板版本不存在");
  const parsed = parseVisualTemplateDefinition(version.definitionJson);
  const definition = presentation ? applyReportPresentation(parsed, presentation.backgroundAssetId, presentation.contrastMode) : parsed;
  const [
    { renderResultVisualPng },
    { RESULT_VISUAL_FONTS },
    { RESULT_VISUAL_WASM },
    { resolveResultVisualImages },
  ] = await Promise.all([
    import("../services/result-visual-renderer.service"),
    import("../services/result-visual-font"),
    import("../services/result-visual-wasm"),
    import("../services/result-visual-image.service"),
  ]);
  const profile = demoProfile();
  const images = await resolveResultVisualImages(ctx.db, ctx.botToken, definition, profile);
  const png = await renderResultVisualPng(definition, profile, {
    wasmModule: RESULT_VISUAL_WASM,
    fontBuffers: RESULT_VISUAL_FONTS,
    images,
  });
  await sendPhoto(ctx.botToken, chatId, png, `🎨 模板预览：${template.name}`);
}

async function showSurveySettings(
  ctx: BotContext,
  chatId: number,
  userId: number,
  surveyId: number,
  messageId?: number,
): Promise<void> {
  const survey = await getSurveyById(ctx.db, surveyId);
  if (!survey) throw new Error("问卷不存在");
  const [settings, templates] = await Promise.all([
    getSurveyResultVisualSettings(ctx.db, surveyId),
    listVisualTemplates(ctx.db, 20),
  ]);
  const published = templates.filter((template) => template.status === "published" && template.currentVersion !== null);
  const rows: InlineKeyboardMarkup["inline_keyboard"] = published.map((template) => [{
    text: `${settings.templateId === template.id ? "✅" : "▫️"} ${compact(template.name)}`,
    callback_data: `visual:select:${surveyId}:${template.id}`,
  }]);
  rows.push([{ text: `${settings.enabled ? "✅" : "▫️"} 启用结果卡`, callback_data: `visual:enable:${surveyId}` }]);
  rows.push([{ text: `${settings.autoGenerate ? "✅" : "▫️"} 完成后自动生成`, callback_data: `visual:auto:${surveyId}` }]);
  rows.push([{ text: "📄 从已完成答卷生成报告", callback_data: `owner:responses:${surveyId}:0` }]);
  rows.push([{ text: "🎨 管理模板", callback_data: "visual:list" }]);
  rows.push([{ text: "⬅️ 返回问卷详情", callback_data: `admin:survey:${surveyId}` }]);
  await render(ctx, chatId, userId, "SURVEY_RESULT_VISUAL_SETTINGS", [
    `🎨 ${survey.title} · 结果卡`,
    "",
    `功能：${settings.enabled ? "已启用" : "未启用"}`,
    `生成方式：${settings.autoGenerate ? "完成后自动生成" : "用户手动点击生成"}`,
    `当前模板：${templates.find((template) => template.id === settings.templateId)?.name ?? "未选择"}`,
    "",
    published.length > 0 ? "选择一个已发布模板，然后开启功能。首次选择会创建安全的默认结果规则。" : "还没有已发布模板，请先创建并发布模板。",
  ].join("\n"), { inline_keyboard: rows }, messageId);
}

async function ensureDefaultRuleSet(ctx: BotContext, surveyId: number, userId: number): Promise<void> {
  if (await getSurveyResultRuleSet(ctx.db, surveyId)) return;
  const survey = await getSurveyById(ctx.db, surveyId);
  if (!survey) throw new Error("问卷不存在");
  await saveSurveyResultRuleSet(ctx.db, {
    surveyId,
    schemaVersion: 1,
    createdBy: userId,
    rulesJson: JSON.stringify({
      schemaVersion: 1,
      defaults: {
        resultType: "completion",
        title: `${survey.title} · 问卷结果`,
        subtitle: "已完成问卷，感谢参与。",
        tags: ["问卷完成"],
      },
      rules: [],
    }),
  });
}

function parseTextLayout(value: string): {
  x: number;
  y: number;
  width: number;
  fontSize: number;
  align: "left" | "center" | "right";
  color: string;
} | null {
  const [xRaw, yRaw, widthRaw, sizeRaw, alignRaw, colorRaw] = value.split(",").map((part) => part.trim());
  const x = Number(xRaw);
  const y = Number(yRaw);
  const width = Number(widthRaw);
  const fontSize = Number(sizeRaw);
  const align = alignRaw === "left" || alignRaw === "center" || alignRaw === "right" ? alignRaw : null;
  if (![x, y, width, fontSize].every(Number.isFinite) || width <= 0 || fontSize <= 0 || !align || !colorRaw) return null;
  return { x, y, width, fontSize, align, color: colorRaw };
}

function parseImageLayout(value: string): {
  x: number;
  y: number;
  width: number;
  height: number;
  fit: "cover" | "contain" | "stretch";
  shape: "rectangle" | "rounded" | "circle";
} | null {
  const [xRaw, yRaw, widthRaw, heightRaw, fitRaw, shapeRaw] = value.split(",").map((part) => part.trim());
  const x = Number(xRaw);
  const y = Number(yRaw);
  const width = Number(widthRaw);
  const height = Number(heightRaw);
  const fit = fitRaw === "cover" || fitRaw === "contain" || fitRaw === "stretch" ? fitRaw : null;
  const shape = shapeRaw === "rectangle" || shapeRaw === "rounded" || shapeRaw === "circle" ? shapeRaw : null;
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0 || !fit || !shape) return null;
  return { x, y, width, height, fit, shape };
}

async function handleTemplateEditorMessage(
  ctx: BotContext,
  message: TelegramMessage,
  internalUserId: number,
): Promise<boolean> {
  const telegramUserId = message.from?.id;
  if (!telegramUserId || !ctx.cache) return false;
  const state = await getTemplateEditorState(ctx, telegramUserId);
  if (!state) return false;
  if (state.chatId !== message.chat.id) return false;
  if (message.text?.trim() === "/cancel") {
    await ctx.cache.delete(templateEditorStateKey(telegramUserId));
    await showTemplateEditor(ctx, state.chatId, telegramUserId, state.templateId, state.messageId);
    return true;
  }

  if (state.mode === "background") {
    if (!message.photo?.length) {
      await sendMessage(ctx.botToken, message.chat.id, "请发送一张图片作为海报背景，或发送 /cancel 取消。");
      return true;
    }
    const assetId = await registerMediaAsset(ctx, message, { scope: "template" });
    if (!assetId) throw new Error("背景图片保存失败");
    const { definition } = await loadTemplateDefinition(ctx, state.templateId);
    definition.background = { type: "telegram_asset", assetId, fit: "cover" };
    await saveTemplateDefinition(ctx, state.templateId, internalUserId, definition);
    await ctx.cache.delete(templateEditorStateKey(telegramUserId));
    await showTemplateEditor(ctx, state.chatId, telegramUserId, state.templateId, state.messageId);
    await sendMessage(ctx.botToken, message.chat.id, "✅ 背景图片已上传。可继续添加动态元素或预览。");
    return true;
  }

  const text = message.text?.trim();
  if (!text) {
    await sendMessage(ctx.botToken, message.chat.id, "请按当前提示发送文字配置，或发送 /cancel 取消。");
    return true;
  }
  if (state.mode === "element_variable") {
    await ctx.cache.delete(templateEditorStateKey(telegramUserId));
    await showTemplateEditor(ctx, state.chatId, telegramUserId, state.templateId, state.messageId);
    await sendMessage(ctx.botToken, message.chat.id, "字段选择已更新，请点击添加动态元素后从列表选择数据来源。");
    return true;
  }

  const { definition } = await loadTemplateDefinition(ctx, state.templateId);
  if (state.elementType === "image") {
    const layout = parseImageLayout(text);
    if (!layout) {
      await sendMessage(ctx.botToken, message.chat.id, "图片布局格式无效。请使用：X,Y,宽度,高度,cover|contain|stretch,rectangle|rounded|circle");
      return true;
    }
    ensureEditorVariable(definition, state.source, "image");
    definition.elements.push({
      id: nextElementId("image"), type: "image", source: state.source,
      ...layout, zIndex: definition.elements.length + 1,
    });
  } else {
    const layout = parseTextLayout(text);
    if (!layout) {
      await sendMessage(ctx.botToken, message.chat.id, "文字布局格式无效。请使用：X,Y,宽度,字号,left|center|right,#RRGGBB");
      return true;
    }
    ensureEditorVariable(definition, state.source, "text");
    definition.elements.push({
      id: nextElementId(state.elementType), type: state.elementType, value: state.source,
      ...layout, maxLines: 3, overflow: "ellipsis", zIndex: definition.elements.length + 1,
    });
  }
  await saveTemplateDefinition(ctx, state.templateId, internalUserId, definition);
  await ctx.cache.delete(templateEditorStateKey(telegramUserId));
  await showTemplateEditor(ctx, state.chatId, telegramUserId, state.templateId, state.messageId);
  await sendMessage(ctx.botToken, message.chat.id, "✅ 动态元素已保存到模板草稿。");
  return true;
}

export async function handleResultVisualAdminMessage(
  ctx: BotContext,
  message: TelegramMessage,
  internalUserId: number,
): Promise<boolean> {
  const text = message.text?.trim();
  const telegramUserId = message.from?.id;
  if (!telegramUserId || !ctx.cache) return false;
  if (await handleTemplateEditorMessage(ctx, message, internalUserId)) return true;
  if (!text) return false;
  if (await ctx.cache.get(templateImportStateKey(telegramUserId)) !== "1") return false;
  if (text === "/cancel") {
    await ctx.cache.delete(templateImportStateKey(telegramUserId));
    await sendMessage(ctx.botToken, message.chat.id, "已取消模板导入。");
    return true;
  }
  if (text.startsWith("/")) return false;
  let definition: VisualTemplateDefinition;
  try {
    definition = parseVisualTemplateDefinition(text);
  } catch (error) {
    await sendMessage(
      ctx.botToken,
      message.chat.id,
      `模板 JSON 无法导入：${error instanceof Error ? error.message : "格式无效"}\n\n请修正后重新发送，或发送 /cancel 取消。`,
    );
    return true;
  }
  const template = await createVisualTemplate(ctx.db, {
    ownerId: internalUserId,
    surveyId: null,
    name: `导入模板 ${new Date().toISOString().slice(0, 10)}`,
    description: "从经过校验的 JSON 导入。",
    type: "custom",
  });
  await createVisualTemplateVersion(ctx.db, {
    templateId: template.id,
    version: 1,
    templateSchemaVersion: definition.schemaVersion,
    definitionJson: JSON.stringify(definition),
    variablesJson: JSON.stringify(definition.variables),
    createdBy: internalUserId,
  });
  await ctx.cache.delete(templateImportStateKey(telegramUserId));
  await sendMessage(ctx.botToken, message.chat.id, "模板 JSON 已导入为草稿。", {
    inline_keyboard: [[{ text: "查看模板", callback_data: `visual:view:${template.id}` }]],
  });
  return true;
}

export async function handleResultVisualAdminCallback(
  ctx: BotContext,
  callback: TelegramCallbackQuery,
  internalUserId: number,
): Promise<boolean> {
  const data = callback.data;
  const chatId = callback.message?.chat.id;
  const messageId = callback.message?.message_id;
  if (!data?.startsWith("visual:") || !chatId) return false;
  const userId = callback.from.id;

  if (data === "visual:list") {
    await showTemplateList(ctx, chatId, userId, messageId);
  } else if (data === "visual:create") {
    await showCreateMenu(ctx, chatId, userId, messageId);
  } else if (data === "visual:create:blank") {
    const templateId = await createBlankPosterTemplate(ctx, internalUserId);
    await showTemplateEditor(ctx, chatId, userId, templateId, messageId);
  } else if (data.startsWith("visual:editor:")) {
    if (!ctx.cache || messageId === undefined) throw new Error("当前部署未启用模板编辑状态");
    const parts = data.split(":");
    const action = parts[2];
    const templateId = Number(parts.at(-1));
    if (!Number.isSafeInteger(templateId) || templateId <= 0) throw new Error("模板编号无效");
    if (action === undefined || /^\d+$/.test(action)) {
      await showTemplateEditor(ctx, chatId, userId, templateId, messageId);
    } else if (action === "background") {
      await setTemplateEditorState(ctx, userId, { mode: "background", templateId, chatId, messageId });
      await sendMessage(ctx.botToken, chatId, "请发送一张图片作为海报背景。图片仅保留 Telegram file_id，不上传到 R2；发送 /cancel 取消。");
    } else if (action === "add") {
      const elementType = parts[3];
      if (elementType !== "text" && elementType !== "image" && elementType !== "badge") {
        throw new Error("不支持的动态元素类型");
      }
      const choices = elementType === "image"
        ? [[{ text: "用户上传图片", callback_data: `visual:editor:bind:image:avatar:${templateId}` }]]
        : elementType === "badge"
          ? [[{ text: "结果标签", callback_data: `visual:editor:bind:badge:tags:${templateId}` }]]
          : [
              [{ text: "报告标题", callback_data: `visual:editor:bind:text:title:${templateId}` }, { text: "报告副标题", callback_data: `visual:editor:bind:text:subtitle:${templateId}` }],
              [{ text: "姓名", callback_data: `visual:editor:bind:text:name:${templateId}` }, { text: "描述", callback_data: `visual:editor:bind:text:description:${templateId}` }],
              [{ text: "提交日期", callback_data: `visual:editor:bind:text:submitted_at:${templateId}` }],
            ];
      choices.push([{ text: "⬅️ 返回编辑器", callback_data: `visual:editor:${templateId}` }]);
      await render(ctx, chatId, userId, "VISUAL_TEMPLATE_BINDING", "选择这个元素的数据来源：", { inline_keyboard: choices }, messageId);
    } else if (action === "bind") {
      const elementType = parts[3];
      const selection = parts[4];
      if ((elementType !== "text" && elementType !== "image" && elementType !== "badge") || !selection) throw new Error("字段绑定无效");
      const paths: Record<string, string> = {
        title: "{{result.title}}", subtitle: "{{result.subtitle}}", name: "{{result.fields.name}}",
        description: "{{result.fields.description}}", submitted_at: "{{result.metadata.submitted_at}}",
        avatar: "{{result.images.avatar}}", tags: "{{result.tags}}",
      };
      const source = paths[selection];
      const allowed = elementType === "image" ? selection === "avatar" : elementType === "badge" ? selection === "tags" : selection !== "avatar" && selection !== "tags";
      if (!source || !allowed) throw new Error("该字段不能绑定到此元素类型");
      await setTemplateEditorState(ctx, userId, { mode: "element_layout", templateId, chatId, messageId, elementType, source });
      await sendMessage(ctx.botToken, chatId, elementType === "image"
        ? "请输入图片布局：X,Y,宽度,高度,裁剪,形状\n例如：340,600,400,400,cover,circle\n裁剪：cover / contain / stretch；形状：rectangle / rounded / circle"
        : "请输入文字布局：X,Y,宽度,字号,对齐,色值\n例如：90,300,900,64,center,#FFFFFF\n对齐：left / center / right");
    } else if (action === "save") {
      await showTemplateEditor(ctx, chatId, userId, templateId, messageId);
    } else {
      return false;
    }
  } else if (data.startsWith("visual:seed:")) {
    const kind = data.slice("visual:seed:".length) as BuiltInTemplateKind;
    if (!(kind in builtInTemplates)) throw new Error("内置模板类型无效");
    const templateId = await createBuiltInTemplate(ctx, internalUserId, kind);
    await showTemplateDetail(ctx, chatId, userId, templateId, messageId);
  } else if (data.startsWith("visual:view:")) {
    await showTemplateDetail(ctx, chatId, userId, Number(data.slice("visual:view:".length)), messageId);
  } else if (data.startsWith("visual:publish:") || data.startsWith("visual:archive:")) {
    const publish = data.startsWith("visual:publish:");
    const templateId = Number(data.slice(publish ? "visual:publish:".length : "visual:archive:".length));
    const template = await getVisualTemplateById(ctx.db, templateId);
    if (!template?.currentVersion) throw new Error("模板没有可发布的版本");
    await updateVisualTemplateStatus(ctx.db, templateId, publish ? "published" : "archived");
    await showTemplateDetail(ctx, chatId, userId, templateId, messageId);
  } else if (data.startsWith("visual:copy:")) {
    const source = await getVisualTemplateById(ctx.db, Number(data.slice("visual:copy:".length)));
    const version = source?.currentVersion ? await getVisualTemplateVersion(ctx.db, source.id, source.currentVersion) : null;
    if (!source || !version) throw new Error("模板版本不存在");
    const copy = await createVisualTemplate(ctx.db, {
      ownerId: internalUserId,
      surveyId: null,
      name: `${source.name} 副本`,
      description: source.description,
      type: source.type,
    });
    await createVisualTemplateVersion(ctx.db, {
      templateId: copy.id,
      version: 1,
      templateSchemaVersion: version.templateSchemaVersion,
      definitionJson: version.definitionJson,
      variablesJson: version.variablesJson,
      createdBy: internalUserId,
    });
    await showTemplateDetail(ctx, chatId, userId, copy.id, messageId);
  } else if (data.startsWith("visual:delete_ask:")) {
    const templateId = Number(data.slice("visual:delete_ask:".length));
    const template = await getVisualTemplateById(ctx.db, templateId);
    if (!template) throw new Error("模板不存在");
    await render(ctx, chatId, userId, "VISUAL_TEMPLATE_DELETE_CONFIRM", `⚠️ 删除模板“${template.name}”？\n\n已关联的问卷会保留设置，但无法再生成结果卡。`, {
      inline_keyboard: [
        [{ text: "确认删除", callback_data: `visual:delete:${templateId}` }, { text: "取消", callback_data: `visual:view:${templateId}` }],
      ],
    }, messageId);
  } else if (data.startsWith("visual:delete:")) {
    await deleteVisualTemplate(ctx.db, Number(data.slice("visual:delete:".length)));
    await showTemplateList(ctx, chatId, userId, messageId);
  } else if (data.startsWith("visual:preview:")) {
    await answerCallbackQuery(ctx.botToken, callback.id, "正在生成预览…");
    try {
      await previewTemplate(ctx, chatId, Number(data.slice("visual:preview:".length)));
    } catch (error) {
      const detail = error instanceof Error ? error.message : "未知错误";
      console.error("Visual template preview failed", { templateId: data, error: detail });
      await sendMessage(ctx.botToken, chatId, `⚠️ 模板预览失败：${detail.slice(0, 300)}\n\n请确认背景图片可由 Telegram 下载后重试。`);
    }
    return true;
  } else if (data.startsWith("visual:export:")) {
    const template = await getVisualTemplateById(ctx.db, Number(data.slice("visual:export:".length)));
    const version = template?.currentVersion ? await getVisualTemplateVersion(ctx.db, template.id, template.currentVersion) : null;
    if (!template || !version) throw new Error("模板版本不存在");
    await sendDocument(ctx.botToken, chatId, `visual-template-${template.id}-v${version.version}.json`, version.definitionJson, "application/json");
  } else if (data === "visual:import") {
    if (!ctx.cache) throw new Error("当前部署未启用模板导入状态");
    await ctx.cache.put(templateImportStateKey(userId), "1", { expirationTtl: 15 * 60 });
    await sendMessage(ctx.botToken, chatId, "请发送完整的 VisualTemplate JSON；发送 /cancel 取消。导入前会校验变量、颜色、元素和条件，不执行任何脚本。");
  } else if (data.startsWith("visual:settings:")) {
    await showSurveySettings(ctx, chatId, userId, Number(data.slice("visual:settings:".length)), messageId);
  } else if (data.startsWith("visual:select:")) {
    const [, , surveyIdRaw, templateIdRaw] = data.split(":");
    const surveyId = Number(surveyIdRaw);
    const templateId = Number(templateIdRaw);
    const template = await getVisualTemplateById(ctx.db, templateId);
    if (!template || template.status !== "published" || !template.currentVersion) throw new Error("只能关联已发布模板");
    const settings = await getSurveyResultVisualSettings(ctx.db, surveyId);
    await ensureDefaultRuleSet(ctx, surveyId, internalUserId);
    await saveSurveyResultVisualSettings(ctx.db, { ...settings, surveyId, templateId });
    await showSurveySettings(ctx, chatId, userId, surveyId, messageId);
  } else if (data.startsWith("visual:enable:") || data.startsWith("visual:auto:")) {
    const enabledAction = data.startsWith("visual:enable:");
    const surveyId = Number(data.slice(enabledAction ? "visual:enable:".length : "visual:auto:".length));
    const settings = await getSurveyResultVisualSettings(ctx.db, surveyId);
    if (enabledAction && !settings.templateId) throw new Error("请先选择已发布模板");
    await saveSurveyResultVisualSettings(ctx.db, {
      ...settings,
      surveyId,
      enabled: enabledAction ? !settings.enabled : settings.enabled,
      autoGenerate: enabledAction ? settings.autoGenerate : !settings.autoGenerate,
    });
    await showSurveySettings(ctx, chatId, userId, surveyId, messageId);
  } else {
    return false;
  }
  await answerCallbackQuery(ctx.botToken, callback.id);
  return true;
}
