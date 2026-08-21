import { answerCallbackQuery, downloadTelegramFile, type InlineKeyboardMarkup } from "./telegram";
import { renderScreen } from "./ui-message-controller";
import type { BotContext, TelegramCallbackQuery, TelegramMessage } from "./types";
import { registerMediaAsset } from "../services/media.service";
import {
  getVisualTemplateById,
  createVisualTemplate,
  createVisualTemplateVersion,
  listVisualTemplates,
  updateVisualTemplateStatus,
} from "../db/repositories/visual-template.repository";
import {
  addGeneratorBackground,
  addGeneratorQuestion,
  deleteGenerator,
  deleteGeneratorQuestion,
  createGenerator,
  getGenerator,
  listGeneratorBackgrounds,
  listGeneratorQuestions,
  listGenerators,
  listPublishedGenerators,
  moveGeneratorQuestion,
  updateGenerator,
  type GeneratorQuestion,
  type GeneratorQuestionSettings,
  type GeneratorQuestionType,
} from "../db/repositories/image-generator.repository";
import { enqueueImageGeneratorJob } from "../services/image-generator-worker.service";
import type { ResultJsonValue } from "../result/schema";
import { getVisualTemplateVersion } from "../db/repositories/visual-template.repository";
import { parseVisualTemplateDefinition } from "../services/visual-template-validator.service";
import { visualReportExampleTemplate } from "../visual-template/examples";
import { midnightReportExampleTemplate, roseReportExampleTemplate } from "../visual-template/examples";
import { previewTemplate } from "./result-visual-admin-handler";
import { parseReportGeneratorImport } from "../services/report-generator-import.service";

type AdminState =
  | { kind: "new"; templateId: number; chatId: number; messageId: number }
  | { kind: "new_report"; chatId: number; messageId: number }
  | { kind: "import"; chatId: number; messageId: number }
  | { kind: "import_style"; generatorId: number; chatId: number; messageId: number }
  | { kind: "question"; generatorId: number; chatId: number; messageId: number }
  | { kind: "background"; generatorId: number; chatId: number; messageId: number }
  | { kind: "report_background"; generatorId: number; chatId: number; messageId: number };

interface Session {
  generatorId: number;
  chatId: number;
  messageId: number;
  index: number;
  values: Record<string, ResultJsonValue>;
  backgroundAssetId: number | null;
}

const adminKey = (userId: number) => `image-generator-admin:${userId}`;
const sessionKey = (userId: number) => `image-generator-session:${userId}`;

export async function clearImageGeneratorInteractionState(ctx: BotContext, userId: number): Promise<void> {
  await Promise.all([
    ctx.cache?.delete(adminKey(userId)),
    ctx.cache?.delete(sessionKey(userId)),
  ]);
}

async function getState<T>(ctx: BotContext, key: string): Promise<T | null> {
  const raw = await ctx.cache?.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function putState(ctx: BotContext, key: string, value: unknown): Promise<void> {
  if (!ctx.cache) throw new Error("当前部署未启用生成器会话");
  await ctx.cache.put(key, JSON.stringify(value), { expirationTtl: 30 * 60 });
}

function isAdminState(value: unknown): value is AdminState {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  return (state.kind === "new" || state.kind === "new_report" || state.kind === "import" || state.kind === "import_style" || state.kind === "question" || state.kind === "background" || state.kind === "report_background")
    && Number.isSafeInteger(state.chatId)
    && Number.isSafeInteger(state.messageId)
    && (state.kind === "new" ? Number.isSafeInteger(state.templateId) : state.kind === "new_report" || state.kind === "import" || Number.isSafeInteger(state.generatorId));
}

function isSession(value: unknown): value is Session {
  if (!value || typeof value !== "object") return false;
  const session = value as Partial<Session>;
  return Number.isSafeInteger(session.generatorId)
    && Number.isSafeInteger(session.chatId)
    && Number.isSafeInteger(session.messageId)
    && Number.isSafeInteger(session.index)
    && !!session.values
    && typeof session.values === "object"
    && (session.backgroundAssetId === null || Number.isSafeInteger(session.backgroundAssetId));
}

async function render(
  ctx: BotContext,
  chatId: number,
  userId: number,
  messageId: number | undefined,
  screen: string,
  text: string,
  replyMarkup: InlineKeyboardMarkup,
): Promise<number> {
  const result = await renderScreen({
    botToken: ctx.botToken,
    chatId,
    userId,
    screen,
    text,
    replyMarkup,
    ...(messageId === undefined ? {} : { messageId }),
  });
  return result.messageId;
}

async function renderParticipantScreen(
  ctx: BotContext,
  userId: number,
  session: Session,
  screen: string,
  text: string,
  replyMarkup: InlineKeyboardMarkup,
): Promise<void> {
  session.messageId = await render(ctx, session.chatId, userId, session.messageId, screen, text, replyMarkup);
  await putState(ctx, sessionKey(userId), session);
}

async function showGeneratorList(
  ctx: BotContext,
  chatId: number,
  userId: number,
  messageId?: number,
): Promise<void> {
  const rows = (await listPublishedGenerators(ctx.db)).map((generator) => [{
    text: `🖼 ${generator.name}`,
    callback_data: `generator:use:${generator.id}`,
  }]);
  rows.push([{ text: "⬅️ 返回首页", callback_data: "home:menu" }]);
  await render(
    ctx,
    chatId,
    userId,
    messageId,
    "IMAGE_GENERATOR_LIST",
    "📊 报告生成\n\n选择一个已发布报告：",
    { inline_keyboard: rows },
  );
}

async function showAdminList(
  ctx: BotContext,
  chatId: number,
  userId: number,
  messageId?: number,
): Promise<void> {
  const rows = (await listGenerators(ctx.db)).map((generator) => [{
    text: `${generator.status === "published" ? "🟢" : "📝"} ${generator.name}`,
    callback_data: `generator:view:${generator.id}`,
  }]);
  rows.push(
    [{ text: "➕ 创建报告", callback_data: "generator:create" }],
    [{ text: "📥 导入问卷 JSON", callback_data: "generator:import" }],
    [{ text: "✨ 创建示例报告", callback_data: "generator:demo" }],
    [{ text: "⬅️ 返回视觉模板", callback_data: "visual:list" }],
  );
  await render(
    ctx,
    chatId,
    userId,
    messageId,
    "IMAGE_GENERATOR_ADMIN",
    "📊 报告生成器\n\n报告问题负责收集数据；Visual Report Template 负责绘制长图 PNG。",
    { inline_keyboard: rows },
  );
}

async function createDemoReportGenerator(ctx: BotContext, ownerId: number): Promise<number> {
  const template = await getOrCreateDefaultReportTemplate(ctx, ownerId);
  const generator = await createGenerator(ctx.db, {
    ownerId,
    name: "个人 XP 偏好测试",
    description: "示例报告：展示文字、选项、评分、图片、长文本和长图布局。",
    templateId: template.id,
  });
  const questions: Array<Omit<GeneratorQuestion, "id" | "generatorId" | "sortOrder">> = [
    { variableName: "name", prompt: "你的昵称？", type: "text", required: true, options: [], settings: {} },
    { variableName: "age", prompt: "你的年龄？", type: "number", required: true, options: [], settings: {} },
    { variableName: "education", prompt: "你的学历？", type: "single", required: true, options: ["高中", "大专", "本科", "硕士", "博士"], settings: {} },
    { variableName: "location", prompt: "你所在的地区？", type: "text", required: true, options: [], settings: {} },
    { variableName: "profilePhoto", prompt: "上传你的照片？", type: "image", required: false, options: [], settings: { maxImages: 1 } },
    { variableName: "photos", prompt: "上传希望展示在报告中的照片？", type: "image", required: false, options: [], settings: { minImages: 0, maxImages: 4 } },
    { variableName: "tags", prompt: "选择你的偏好标签？", type: "multiple", required: false, options: ["角色扮演", "规则感", "情境沉浸", "创意表达"], settings: {} },
    { variableName: "scoreA", prompt: "评分项目 A？", type: "rating", required: true, options: [], settings: { min: 1, max: 10, step: 1 } },
    { variableName: "scoreB", prompt: "评分项目 B？", type: "rating", required: true, options: [], settings: { min: 1, max: 10, step: 1 } },
    { variableName: "scoreC", prompt: "评分项目 C？", type: "rating", required: true, options: [], settings: { min: 1, max: 10, step: 1 } },
    { variableName: "summary", prompt: "请简单介绍一下自己？", type: "long_text", required: false, options: [], settings: {} },
  ];
  for (const question of questions) await addGeneratorQuestion(ctx.db, { generatorId: generator.id, ...question });
  await updateGenerator(ctx.db, generator.id, { status: "published", backgroundMode: "preset" });
  return generator.id;
}

async function getOrCreateDefaultReportTemplate(ctx: BotContext, ownerId: number) {
  return getOrCreateReportTemplate(ctx, ownerId, "个人数据量化评估报告", visualReportExampleTemplate);
}

async function getOrCreateReportTemplate(
  ctx: BotContext,
  ownerId: number,
  name: string,
  definitionInput: typeof visualReportExampleTemplate,
) {
  const existing = (await listVisualTemplates(ctx.db, 100)).find((template) =>
    template.name === name && template.type === "report" && template.status === "published" && template.currentVersion,
  );
  if (existing) return existing;
  const definition = parseVisualTemplateDefinition(JSON.stringify(definitionInput));
  const template = await createVisualTemplate(ctx.db, {
    ownerId,
    surveyId: null,
    name,
    description: "内置长图报告示例；可在视觉模板中继续编辑。",
    type: "report",
  });
  await createVisualTemplateVersion(ctx.db, {
    templateId: template.id,
    version: 1,
    templateSchemaVersion: definition.schemaVersion,
    definitionJson: JSON.stringify(definition),
    variablesJson: JSON.stringify(definition.variables),
    createdBy: ownerId,
  });
  await updateVisualTemplateStatus(ctx.db, template.id, "published");
  return template;
}

export async function ensureReportStyleTemplates(ctx: BotContext, ownerId: number) {
  return Promise.all([
    getOrCreateReportTemplate(ctx, ownerId, "个人报告 · 玻璃极简", visualReportExampleTemplate),
    getOrCreateReportTemplate(ctx, ownerId, "个人报告 · 霓虹赛博档案", midnightReportExampleTemplate),
    getOrCreateReportTemplate(ctx, ownerId, "个人报告 · Art Deco 复古", roseReportExampleTemplate),
  ]);
}

async function showReportStyleSelection(
  ctx: BotContext,
  chatId: number,
  userId: number,
  ownerId: number,
  generatorId: number,
  messageId?: number,
): Promise<void> {
  const [light, midnight, rose] = await ensureReportStyleTemplates(ctx, ownerId);
  await render(ctx, chatId, userId, messageId, "REPORT_GENERATOR_STYLE", "🎨 第 1 步：选择报告样式\n\n样式决定报告的排版与配色；不会改变题目。选择后会回到报告设置，可上传默认背景、预览并发布。", {
    inline_keyboard: [
      [{ text: "☁️ 玻璃极简报告", callback_data: `generator:style:${generatorId}:${light.id}` }],
      [{ text: "⚡ 霓虹赛博报告", callback_data: `generator:style:${generatorId}:${midnight.id}` }],
      [{ text: "✦ Art Deco 复古报告", callback_data: `generator:style:${generatorId}:${rose.id}` }],
      [{ text: "⬅️ 返回报告设置", callback_data: `generator:view:${generatorId}` }],
    ],
  });
}

async function showAdminDetail(
  ctx: BotContext,
  chatId: number,
  userId: number,
  generatorId: number,
  messageId?: number,
): Promise<void> {
  const generator = await getGenerator(ctx.db, generatorId);
  if (!generator) throw new Error("生成器不存在");
  const [questions, template] = await Promise.all([
    listGeneratorQuestions(ctx.db, generatorId),
    getVisualTemplateById(ctx.db, generator.templateId),
  ]);
  const text = [
    `📊 ${generator.name}`,
    generator.description ?? "",
    `模板：${template?.name ?? `#${generator.templateId}`}`,
    `状态：${generator.status}`,
    `报告样式：${template?.name ?? `#${generator.templateId}`}`,
    `报告默认背景：${generator.reportBackgroundAssetId ? "已上传" : "使用样式配色"}`,
    `可读性：${generator.reportContrastMode === "auto" ? "自动（浅色内容卡）" : generator.reportContrastMode === "light" ? "浅色内容卡" : "深色内容卡"}`,
    "填写者背景：已禁用（使用报告样式或管理员默认背景）",
    "",
    questions.length
      ? `问题：${questions.length} 道（${Object.entries(questions.reduce<Record<string, number>>((summary, question) => ({ ...summary, [question.type]: (summary[question.type] ?? 0) + 1 }), {})).map(([type, count]) => `${type} ${count}`).join(" · ")}）`
      : "问题：尚未配置",
  ].filter(Boolean).join("\n");
  const publishButton = generator.status === "published"
    ? { text: "⏸ 停用", callback_data: `generator:archive:${generatorId}` }
    : { text: "🚀 发布", callback_data: `generator:publish:${generatorId}` };
  await render(ctx, chatId, userId, messageId, "IMAGE_GENERATOR_DETAIL", text, {
    inline_keyboard: [
      [{ text: "➕ 添加问题", callback_data: `generator:question:${generatorId}` }],
      [{ text: "🎨 报告样式", callback_data: `generator:styles:${generatorId}` }],
      [{ text: generator.reportBackgroundAssetId ? "🖼 更换报告默认背景" : "🖼 上传报告默认背景", callback_data: `generator:report_background:${generatorId}` }, { text: "♻️ 清除", callback_data: `generator:report_background_clear:${generatorId}` }],
      [{ text: "🌓 内容颜色", callback_data: `generator:contrast_menu:${generatorId}` }],
      [{ text: "👁 预览报告", callback_data: `generator:preview:${generatorId}` }],
      [publishButton],
      [{ text: "🗑 删除报告", callback_data: `generator:delete_ask:${generatorId}` }],
      [{ text: "⬅️ 返回列表", callback_data: "generator:list" }],
    ],
  });
}

function questionKeyboard(required: boolean): InlineKeyboardMarkup {
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [];
  if (!required) rows.push([{ text: "跳过", callback_data: "generator:skip" }]);
  rows.push([
    { text: "⬅️ 返回", callback_data: "generator:back" },
    { text: "❌ 取消", callback_data: "generator:cancel" },
  ]);
  return { inline_keyboard: rows };
}

function questionSettings(question: GeneratorQuestion): { minImages: number; maxImages: number; min: number; max: number; step: number } {
  const configured = question.settings ?? {};
  return {
    minImages: Math.max(0, Math.floor(configured.minImages ?? (question.required ? 1 : 0))),
    maxImages: Math.max(1, Math.min(10, Math.floor(configured.maxImages ?? 1))),
    min: configured.min ?? 1,
    max: configured.max ?? 10,
    step: configured.step ?? 1,
  };
}

function answerKeyboard(question: GeneratorQuestion, selected: string[] = []): InlineKeyboardMarkup | null {
  const settings = questionSettings(question);
  if (question.type === "single") return { inline_keyboard: [
    ...question.options.map((option, index) => [{ text: option, callback_data: `generator:answer:${question.id}:${index}` }]),
    ...questionKeyboard(question.required).inline_keyboard,
  ] };
  if (question.type === "multiple") return { inline_keyboard: [
    ...question.options.map((option, index) => [{ text: `${selected.includes(option) ? "✅ " : ""}${option}`, callback_data: `generator:multi:${question.id}:${index}` }]),
    [{ text: "完成选择", callback_data: `generator:multi_done:${question.id}` }],
    ...questionKeyboard(question.required).inline_keyboard,
  ] };
  if (question.type === "rating") {
    const values: InlineKeyboardMarkup["inline_keyboard"] = [];
    for (let value = settings.min; value <= settings.max; value += settings.step) {
      const row = values.at(-1);
      const button = { text: String(value), callback_data: `generator:answer:${question.id}:${value}` };
      if (!row || row.length >= 5) values.push([button]); else row.push(button);
    }
    return { inline_keyboard: [...values, ...questionKeyboard(question.required).inline_keyboard] };
  }
  if (question.type === "boolean") return { inline_keyboard: [
    [{ text: "✅ 是", callback_data: `generator:answer:${question.id}:true` }, { text: "❌ 否", callback_data: `generator:answer:${question.id}:false` }],
    ...questionKeyboard(question.required).inline_keyboard,
  ] };
  return null;
}

function imageKeyboard(question: GeneratorQuestion, uploaded: number): InlineKeyboardMarkup {
  const settings = questionSettings(question);
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [];
  if (uploaded >= settings.minImages) rows.push([{ text: "完成上传", callback_data: `generator:image_done:${question.id}` }]);
  rows.push(...questionKeyboard(question.required).inline_keyboard);
  return { inline_keyboard: rows };
}

async function renderParticipant(
  ctx: BotContext,
  userId: number,
  session: Session,
): Promise<void> {
  const generator = await getGenerator(ctx.db, session.generatorId);
  if (!generator || generator.status !== "published") throw new Error("生成器不可用");
  const questions = await listGeneratorQuestions(ctx.db, generator.id);
  if (session.index < questions.length) {
    const question = questions[session.index]!;
    const existing = session.values[question.variableName];
    const uploaded = Array.isArray(existing) ? existing.length : existing ? 1 : 0;
    const controls = question.type === "image"
      ? imageKeyboard(question, uploaded)
      : answerKeyboard(question, Array.isArray(existing) ? existing.filter((item): item is string => typeof item === "string") : []) ?? questionKeyboard(question.required);
    await renderParticipantScreen(
      ctx,
      userId,
      session,
      "IMAGE_GENERATOR_STEP",
      [
        `📊 ${generator.name}`,
        `第 ${session.index + 1}/${questions.length}`,
        "",
        question.prompt,
        question.type === "image" ? `请发送图片（${uploaded}/${questionSettings(question).maxImages}）。` : question.type === "number" ? "请输入数字。" : question.type === "date" ? "请输入日期，例如 2026-08-19。" : "请直接发送内容。",
      ].join("\n"),
      controls,
    );
    return;
  }

  await renderParticipantScreen(
    ctx,
    userId,
    session,
    "IMAGE_GENERATOR_CONFIRM",
    [
      "🎨 已收集完成",
      ...Object.entries(session.values)
        .filter(([, value]) => typeof value === "string")
        .map(([key, value]) => `${key}：${value}`),
      "",
      "确认后将异步生成 PNG。",
    ].join("\n"),
    {
      inline_keyboard: [
        [{ text: "🚀 生成图片", callback_data: "generator:render" }],
        [
          { text: "⬅️ 修改", callback_data: "generator:back" },
          { text: "❌ 取消", callback_data: "generator:cancel" },
        ],
      ],
    },
  );
}

function parseGeneratorName(text: string): { name: string; description?: string } | null {
  const [rawName, ...descriptionParts] = text.split("|");
  const name = rawName?.trim().slice(0, 80);
  if (!name) return null;
  const description = descriptionParts.join("|").trim().slice(0, 500);
  return description ? { name, description } : { name };
}

export async function handleImageGeneratorAdminMessage(
  ctx: BotContext,
  message: TelegramMessage,
  internalUserId: number,
): Promise<boolean> {
  const userId = message.from?.id;
  if (!userId || !ctx.cache) return false;
  const current = await getState<unknown>(ctx, adminKey(userId));
  if (!isAdminState(current)) return false;
  if (message.text === "/cancel") {
    await ctx.cache.delete(adminKey(userId));
    if (current.kind === "background" || current.kind === "report_background" || current.kind === "question") {
      await showAdminDetail(ctx, current.chatId, userId, current.generatorId, current.messageId);
    } else {
      await showAdminList(ctx, current.chatId, userId, current.messageId);
    }
    return true;
  }

  if (current.kind === "import") {
    const document = message.document;
    if (!document?.file_id || (document.file_size ?? 0) > 512 * 1024) {
      current.messageId = await render(ctx, current.chatId, userId, current.messageId, "REPORT_GENERATOR_IMPORT", "请发送不超过 512 KB 的 JSON 文件，或发送 /cancel。", { inline_keyboard: [] });
      await putState(ctx, adminKey(userId), current);
      return true;
    }
    const downloaded = await downloadTelegramFile(ctx.botToken, document.file_id);
    const imported = parseReportGeneratorImport(new TextDecoder().decode(downloaded.data));
    const template = await getOrCreateDefaultReportTemplate(ctx, internalUserId);
    const generator = await createGenerator(ctx.db, {
      ownerId: internalUserId,
      templateId: template.id,
      name: imported.name,
      description: imported.description,
    });
    for (const question of imported.questions) {
      await addGeneratorQuestion(ctx.db, { generatorId: generator.id, ...question });
    }
    await updateGenerator(ctx.db, generator.id, { backgroundMode: "preset" });
    await ctx.cache.delete(adminKey(userId));
    await showReportStyleSelection(ctx, current.chatId, userId, internalUserId, generator.id, current.messageId);
    return true;
  }

  if (current.kind === "new_report") {
    const input = parseGeneratorName(message.text?.trim() ?? "");
    if (!input) {
      current.messageId = await render(ctx, current.chatId, userId, current.messageId, "REPORT_GENERATOR_NAME", "请输入报告名称，可选格式：名称 | 说明", { inline_keyboard: [] });
      await putState(ctx, adminKey(userId), current);
      return true;
    }
    const template = await getOrCreateDefaultReportTemplate(ctx, internalUserId);
    const generator = await createGenerator(ctx.db, { ownerId: internalUserId, templateId: template.id, ...input });
    await ctx.cache.delete(adminKey(userId));
    await showReportStyleSelection(ctx, current.chatId, userId, internalUserId, generator.id, current.messageId);
    return true;
  }

  if (current.kind === "background" || current.kind === "report_background") {
    if (!message.photo?.length) {
      current.messageId = await render(ctx, current.chatId, userId, current.messageId, "IMAGE_GENERATOR_BACKGROUND_UPLOAD", current.kind === "report_background" ? "请发送报告默认背景图片，或发送 /cancel。\n\n系统会自动加入遮罩和内容卡，保护文字可读性。" : "请发送预设背景图片，或发送 /cancel。", { inline_keyboard: [] });
      await putState(ctx, adminKey(userId), current);
      return true;
    }
    const assetId = await registerMediaAsset(ctx, message, { scope: "template" });
    if (!assetId) throw new Error("背景保存失败");
    if (current.kind === "report_background") {
      await updateGenerator(ctx.db, current.generatorId, { reportBackgroundAssetId: assetId });
    } else {
      const label = message.caption?.trim().slice(0, 80) || `背景 ${new Date().toISOString().slice(11, 16)}`;
      await addGeneratorBackground(ctx.db, { generatorId: current.generatorId, assetId, label });
    }
    await ctx.cache.delete(adminKey(userId));
    await showAdminDetail(ctx, current.chatId, userId, current.generatorId, current.messageId);
    return true;
  }

  const text = message.text?.trim();
  if (!text) {
    current.messageId = await render(ctx, current.chatId, userId, current.messageId, "IMAGE_GENERATOR_INPUT", "请发送文字内容，或发送 /cancel。", { inline_keyboard: [] });
    await putState(ctx, adminKey(userId), current);
    return true;
  }

  if (current.kind === "new") {
    const input = parseGeneratorName(text);
    if (!input) {
      current.messageId = await render(ctx, current.chatId, userId, current.messageId, "IMAGE_GENERATOR_NAME", "请输入生成器名称。可选格式：名称 | 说明", { inline_keyboard: [] });
      await putState(ctx, adminKey(userId), current);
      return true;
    }
    const generator = await createGenerator(ctx.db, { ownerId: internalUserId, templateId: current.templateId, ...input });
    await ctx.cache.delete(adminKey(userId));
    await showAdminDetail(ctx, current.chatId, userId, generator.id, current.messageId);
    return true;
  }

  const [variableName, prompt, typeRaw, requiredRaw, optionsRaw, settingsRaw] = text.split("|").map((item) => item.trim());
  const allowedTypes: GeneratorQuestionType[] = ["text", "long_text", "number", "single", "multiple", "rating", "image", "boolean", "date"];
  const type = allowedTypes.includes(typeRaw as GeneratorQuestionType) ? typeRaw as GeneratorQuestionType : null;
  const options = (optionsRaw ?? "").split(",").map((item) => item.trim()).filter(Boolean).slice(0, 50);
  const settings: GeneratorQuestionSettings = {};
  for (const part of (settingsRaw ?? "").split(",")) {
    const [key, rawValue] = part.split("=").map((item) => item.trim());
    const value = Number(rawValue);
    if (["minImages", "maxImages", "min", "max", "step"].includes(key ?? "") && Number.isFinite(value)) settings[key as keyof GeneratorQuestionSettings] = value;
  }
  if (!variableName || !prompt || !type || !/^[A-Za-z][A-Za-z0-9_-]{0,40}$/.test(variableName) ||
    (["single", "multiple"].includes(type) && options.length < 2) ||
    (type === "image" && (settings.maxImages !== undefined && (!Number.isInteger(settings.maxImages) || settings.maxImages < 1 || settings.maxImages > 10)))) {
    current.messageId = await render(ctx, current.chatId, userId, current.messageId, "IMAGE_GENERATOR_QUESTION", "格式：变量名 | 问题文字 | 类型 | required|optional | 选项(逗号分隔) | 设置\n\n类型：text、long_text、number、single、multiple、rating、image、boolean、date\n图片设置示例：minImages=1,maxImages=4\n评分设置示例：min=1,max=10,step=1", { inline_keyboard: [] });
    await putState(ctx, adminKey(userId), current);
    return true;
  }
  await addGeneratorQuestion(ctx.db, {
    generatorId: current.generatorId,
    variableName,
    prompt,
    type,
    required: requiredRaw !== "optional",
    options,
    settings,
  });
  await ctx.cache.delete(adminKey(userId));
  await showAdminDetail(ctx, current.chatId, userId, current.generatorId, current.messageId);
  return true;
}

export async function handleImageGeneratorParticipantMessage(
  ctx: BotContext,
  message: TelegramMessage,
  _internalUserId: number,
): Promise<boolean> {
  const userId = message.from?.id;
  if (!userId || !ctx.cache) return false;
  const session = await getState<unknown>(ctx, sessionKey(userId));
  if (!isSession(session)) return false;
  const questions = await listGeneratorQuestions(ctx.db, session.generatorId);
  if (session.index < questions.length) {
    const question = questions[session.index]!;
    if (["single", "multiple", "rating", "boolean"].includes(question.type)) {
      await renderParticipantScreen(ctx, userId, session, "IMAGE_GENERATOR_STEP", "请使用下方按钮回答此题。", answerKeyboard(question) ?? questionKeyboard(question.required));
      return true;
    }
    if (question.type === "image") {
      const photo = message.photo?.at(-1);
      if (!photo) {
        await renderParticipantScreen(ctx, userId, session, "IMAGE_GENERATOR_STEP", "请发送一张图片。", questionKeyboard(question.required));
        return true;
      }
      const settings = questionSettings(question);
      const existing = session.values[question.variableName];
      const images = Array.isArray(existing) ? existing : existing ? [existing] : [];
      if (images.length >= settings.maxImages) {
        await renderParticipantScreen(ctx, userId, session, "IMAGE_GENERATOR_STEP", `最多只能上传 ${settings.maxImages} 张图片。`, imageKeyboard(question, images.length));
        return true;
      }
      images.push({ telegramFileId: photo.file_id });
      session.values[question.variableName] = settings.maxImages === 1 ? images[0]! : images;
      if (images.length < settings.maxImages) {
        await putState(ctx, sessionKey(userId), session);
        await renderParticipant(ctx, userId, session);
        return true;
      }
    } else {
      const text = message.text?.trim();
      if (!text) {
        await renderParticipantScreen(ctx, userId, session, "IMAGE_GENERATOR_STEP", "请输入文字内容。", questionKeyboard(question.required));
        return true;
      }
      if (question.type === "number" || question.type === "rating") {
        const value = Number(text);
        if (!Number.isFinite(value)) {
          await renderParticipantScreen(ctx, userId, session, "IMAGE_GENERATOR_STEP", "请输入有效数字。", questionKeyboard(question.required));
          return true;
        }
        const settings = questionSettings(question);
        if (question.type === "rating" && (value < settings.min || value > settings.max)) {
          await renderParticipantScreen(ctx, userId, session, "IMAGE_GENERATOR_STEP", `评分范围为 ${settings.min}-${settings.max}。`, answerKeyboard(question) ?? questionKeyboard(question.required));
          return true;
        }
        session.values[question.variableName] = value;
      } else if (question.type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(text)) {
        await renderParticipantScreen(ctx, userId, session, "IMAGE_GENERATOR_STEP", "请输入 YYYY-MM-DD 格式的日期。", questionKeyboard(question.required));
        return true;
      } else {
        session.values[question.variableName] = text.slice(0, 4000);
      }
    }
    session.index += 1;
    await putState(ctx, sessionKey(userId), session);
    await renderParticipant(ctx, userId, session);
    return true;
  }

  return false;
}

async function validateGeneratorForPublish(ctx: BotContext, generatorId: number): Promise<void> {
  const generator = await getGenerator(ctx.db, generatorId);
  if (!generator) throw new Error("生成器不存在");
  const [questions, backgrounds, template] = await Promise.all([
    listGeneratorQuestions(ctx.db, generatorId),
    listGeneratorBackgrounds(ctx.db, generatorId),
    getVisualTemplateById(ctx.db, generator.templateId),
  ]);
  if (!questions.length) throw new Error("至少配置一个问题后才能发布");
  if (!template || template.status !== "published" || !template.currentVersion) {
    throw new Error("必须关联一个已发布的 VisualTemplate");
  }
  const names = new Set<string>();
  for (const question of questions) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,40}$/.test(question.variableName) || names.has(question.variableName)) throw new Error(`问题变量 ${question.variableName} 无效或重复`);
    names.add(question.variableName);
    if ((question.type === "single" || question.type === "multiple") && question.options.length < 2) throw new Error(`${question.variableName} 至少需要两个选项`);
    if (question.type === "image") {
      const settings = questionSettings(question);
      if (settings.minImages > settings.maxImages) throw new Error(`${question.variableName} 的图片数量配置无效`);
    }
  }
  const version = await getVisualTemplateVersion(ctx.db, template.id, template.currentVersion);
  if (!version) throw new Error("模板版本不存在");
  const definition = parseVisualTemplateDefinition(version.definitionJson);
  for (const variable of definition.variables) {
    const match = /^result\.(fields|images)\.([A-Za-z0-9_-]+)$/.exec(variable.path);
    if (!match) continue;
    const question = questions.find((entry) => entry.variableName === match[2]);
    if (!question) throw new Error(`模板引用了不存在的变量：{{${match[2]}}}`);
    if (match[1] === "images" && question.type !== "image") throw new Error(`模板图片变量 {{${match[2]}}} 必须关联 image 类型问题`);
    if (match[1] === "fields" && question.type === "image") throw new Error(`模板文字变量 {{${match[2]}}} 不能关联 image 类型问题`);
  }
}

export async function handleImageGeneratorCallback(
  ctx: BotContext,
  callback: TelegramCallbackQuery,
  internalUserId: number,
  isAdmin: boolean,
): Promise<boolean> {
  const data = callback.data;
  const chatId = callback.message?.chat.id;
  const messageId = callback.message?.message_id;
  const userId = callback.from.id;
  if (!data?.startsWith("generator:") || !chatId) return false;

  // Report generators are an administrator authoring tool. Participant
  // reports now come from completed survey responses; reject the old admin
  // list callback for non-admins instead of opening a standalone flow.
  if (!isAdmin && data === "generator:list") {
    await answerCallbackQuery(ctx.botToken, callback.id, "报告生成器仅供管理员配置");
    return true;
  }

  if (isAdmin) {
    if (data === "generator:list") {
      await showAdminList(ctx, chatId, userId, messageId);
      await answerCallbackQuery(ctx.botToken, callback.id);
      return true;
    }
    if (data === "generator:create") {
      if (messageId === undefined) return false;
      const state: AdminState = { kind: "new_report", chatId, messageId };
      state.messageId = await render(ctx, chatId, userId, messageId, "REPORT_GENERATOR_NAME", "请输入报告名称，可选格式：名称 | 说明", { inline_keyboard: [] });
      await putState(ctx, adminKey(userId), state);
      await answerCallbackQuery(ctx.botToken, callback.id);
      return true;
    }
    if (data === "generator:import") {
      if (messageId === undefined) return false;
      const state: AdminState = { kind: "import", chatId, messageId };
      state.messageId = await render(ctx, chatId, userId, messageId, "REPORT_GENERATOR_IMPORT", "发送问卷 JSON 文件（不超过 512 KB）。\n\n系统会自动创建或使用默认长图报告模板，并把题目导入为草稿。\n发送 /cancel 取消。", { inline_keyboard: [] });
      await putState(ctx, adminKey(userId), state);
      await answerCallbackQuery(ctx.botToken, callback.id);
      return true;
    }
    if (data === "generator:demo") {
      const generatorId = await createDemoReportGenerator(ctx, internalUserId);
      await showAdminDetail(ctx, chatId, userId, generatorId, messageId);
      await answerCallbackQuery(ctx.botToken, callback.id, "示例报告已创建并发布");
      return true;
    }
    if (data.startsWith("generator:new:")) {
      if (messageId === undefined) return false;
      const state: AdminState = { kind: "new", templateId: Number(data.slice("generator:new:".length)), chatId, messageId };
      state.messageId = await render(ctx, chatId, userId, messageId, "IMAGE_GENERATOR_NAME", "请输入生成器名称。\n\n可选格式：名称 | 说明\n发送 /cancel 取消。", { inline_keyboard: [] });
      await putState(ctx, adminKey(userId), state);
      await answerCallbackQuery(ctx.botToken, callback.id);
      return true;
    }
    if (data.startsWith("generator:view:")) {
      await showAdminDetail(ctx, chatId, userId, Number(data.slice("generator:view:".length)), messageId);
      await answerCallbackQuery(ctx.botToken, callback.id);
      return true;
    }
    if (data.startsWith("generator:preview:")) {
      const generatorId = Number(data.slice("generator:preview:".length));
      const generator = await getGenerator(ctx.db, generatorId);
      if (!generator) throw new Error("报告不存在");
      await answerCallbackQuery(ctx.botToken, callback.id, "正在生成预览…");
      await previewTemplate(ctx, chatId, generator.templateId, {
        backgroundAssetId: generator.reportBackgroundAssetId,
        contrastMode: generator.reportContrastMode,
      });
      return true;
    }
    if (data.startsWith("generator:styles:")) {
      const generatorId = Number(data.slice("generator:styles:".length));
      if (!Number.isSafeInteger(generatorId)) return false;
      await showReportStyleSelection(ctx, chatId, userId, internalUserId, generatorId, messageId);
      await answerCallbackQuery(ctx.botToken, callback.id);
      return true;
    }
    if (data.startsWith("generator:style:")) {
      const [, , generatorRaw, templateRaw] = data.split(":");
      const generatorId = Number(generatorRaw); const templateId = Number(templateRaw);
      const template = await getVisualTemplateById(ctx.db, templateId);
      if (!Number.isSafeInteger(generatorId) || !template || template.status !== "published" || !template.currentVersion) throw new Error("报告样式不存在");
      await updateGenerator(ctx.db, generatorId, { templateId });
      await showAdminDetail(ctx, chatId, userId, generatorId, messageId);
      await answerCallbackQuery(ctx.botToken, callback.id, "样式已选择，可预览后发布");
      return true;
    }
    if (data.startsWith("generator:template:")) {
      const parts = data.split(":");
      const generatorId = Number(parts[2]);
      const templateId = parts[3] === undefined ? null : Number(parts[3]);
      if (!Number.isSafeInteger(generatorId)) return false;
      if (templateId !== null) {
        const template = await getVisualTemplateById(ctx.db, templateId);
        if (!template || template.status !== "published" || !template.currentVersion) throw new Error("请选择已发布的报告模板");
        await updateGenerator(ctx.db, generatorId, { templateId });
        await showAdminDetail(ctx, chatId, userId, generatorId, messageId);
        await answerCallbackQuery(ctx.botToken, callback.id, "报告模板已更新");
        return true;
      }
      const templates = (await listVisualTemplates(ctx.db)).filter((template) => template.status === "published" && template.currentVersion);
      await render(ctx, chatId, userId, messageId, "REPORT_GENERATOR_TEMPLATE", "选择一个已发布的 Visual Report Template：", {
        inline_keyboard: [
          ...templates.map((template) => [{ text: `${template.type === "report" ? "📊 " : "🎨 "}${template.name}`, callback_data: `generator:template:${generatorId}:${template.id}` }]),
          [{ text: "⬅️ 返回", callback_data: `generator:view:${generatorId}` }],
        ],
      });
      await answerCallbackQuery(ctx.botToken, callback.id);
      return true;
    }
    if (data.startsWith("generator:use_default_report:")) {
      const generatorId = Number(data.slice("generator:use_default_report:".length));
      if (!Number.isSafeInteger(generatorId)) return false;
      const template = await getOrCreateDefaultReportTemplate(ctx, internalUserId);
      await updateGenerator(ctx.db, generatorId, { templateId: template.id, backgroundMode: "preset" });
      await showAdminDetail(ctx, chatId, userId, generatorId, messageId);
      await answerCallbackQuery(ctx.botToken, callback.id, "已切换到长图报告模板");
      return true;
    }
    if (data.startsWith("generator:question:")) {
      if (messageId === undefined) return false;
      const generatorId = Number(data.slice("generator:question:".length));
      const state: AdminState = { kind: "question", generatorId, chatId, messageId };
      state.messageId = await render(ctx, chatId, userId, messageId, "IMAGE_GENERATOR_QUESTION", "发送：变量名 | 问题文字 | 类型 | required|optional | 选项 | 设置\n\n示例：education | 你的学历？ | single | required | 高中,本科,硕士\n图片：photos | 上传照片 | image | required |  | minImages=1,maxImages=4\n评分：score | 评分 | rating | required |  | min=1,max=10\n发送 /cancel 取消。", { inline_keyboard: [] });
      await putState(ctx, adminKey(userId), state);
      await answerCallbackQuery(ctx.botToken, callback.id);
      return true;
    }
    if (data.startsWith("generator:background:")) {
      if (messageId === undefined) return false;
      const generatorId = Number(data.slice("generator:background:".length));
      const state: AdminState = { kind: "background", generatorId, chatId, messageId };
      state.messageId = await render(ctx, chatId, userId, messageId, "IMAGE_GENERATOR_BACKGROUND_UPLOAD", "请发送预设背景图片。\n可在图片说明中填写背景名称，例如：黑金。\n发送 /cancel 取消。", { inline_keyboard: [] });
      await putState(ctx, adminKey(userId), state);
      await answerCallbackQuery(ctx.botToken, callback.id);
      return true;
    }
    if (data.startsWith("generator:report_background:")) {
      if (messageId === undefined) return false;
      const generatorId = Number(data.slice("generator:report_background:".length));
      if (!Number.isSafeInteger(generatorId)) return false;
      const state: AdminState = { kind: "report_background", generatorId, chatId, messageId };
      state.messageId = await render(ctx, chatId, userId, messageId, "REPORT_GENERATOR_DEFAULT_BACKGROUND", "请发送一张报告默认背景图片。\n\n它会保存为 Telegram file_id（不使用 R2），并自动铺上遮罩和半透明内容卡，避免图片与文字撞色。\n发送 /cancel 取消。", { inline_keyboard: [] });
      await putState(ctx, adminKey(userId), state);
      await answerCallbackQuery(ctx.botToken, callback.id);
      return true;
    }
    if (data.startsWith("generator:report_background_clear:")) {
      const generatorId = Number(data.slice("generator:report_background_clear:".length));
      if (!Number.isSafeInteger(generatorId)) return false;
      await updateGenerator(ctx.db, generatorId, { reportBackgroundAssetId: null });
      await showAdminDetail(ctx, chatId, userId, generatorId, messageId);
      await answerCallbackQuery(ctx.botToken, callback.id, "已恢复为报告样式配色");
      return true;
    }
    if (data.startsWith("generator:delete:")) {
      const [, , generatorRaw, questionRaw] = data.split(":");
      const generatorId = Number(generatorRaw); const questionId = Number(questionRaw);
      if (Number.isSafeInteger(generatorId) && Number.isSafeInteger(questionId)) await deleteGeneratorQuestion(ctx.db, questionId);
      await showAdminDetail(ctx, chatId, userId, generatorId, messageId);
      await answerCallbackQuery(ctx.botToken, callback.id, "问题已删除");
      return true;
    }
    if (data.startsWith("generator:move:")) {
      const [, , generatorRaw, questionRaw, direction] = data.split(":");
      const generatorId = Number(generatorRaw); const questionId = Number(questionRaw);
      if (Number.isSafeInteger(generatorId) && Number.isSafeInteger(questionId) && (direction === "up" || direction === "down")) await moveGeneratorQuestion(ctx.db, generatorId, questionId, direction);
      await showAdminDetail(ctx, chatId, userId, generatorId, messageId);
      await answerCallbackQuery(ctx.botToken, callback.id);
      return true;
    }
    if (data.startsWith("generator:mode_menu:") || data.startsWith("generator:mode_set:")) {
      const generatorId = Number(data.slice("generator:mode_menu:".length));
      const resolvedGeneratorId = data.startsWith("generator:mode_set:")
        ? Number(data.split(":")[2])
        : generatorId;
      if (!Number.isSafeInteger(resolvedGeneratorId)) return false;
      await updateGenerator(ctx.db, resolvedGeneratorId, { backgroundMode: "preset" });
      await showAdminDetail(ctx, chatId, userId, resolvedGeneratorId, messageId);
      await answerCallbackQuery(ctx.botToken, callback.id, "填写者自定义背景已停用");
      return true;
    }
    if (data.startsWith("generator:contrast_menu:")) {
      const generatorId = Number(data.slice("generator:contrast_menu:".length));
      await render(ctx, chatId, userId, messageId, "REPORT_GENERATOR_CONTRAST", "🌓 内容颜色\n\n自动：照片背景上使用浅色内容卡；深色背景可选白字深色卡。", { inline_keyboard: [
        [{ text: "自动（推荐）", callback_data: `generator:contrast_set:${generatorId}:auto` }],
        [{ text: "浅色内容卡 / 深色文字", callback_data: `generator:contrast_set:${generatorId}:light` }],
        [{ text: "深色内容卡 / 白色文字", callback_data: `generator:contrast_set:${generatorId}:dark` }],
        [{ text: "⬅️ 返回报告设置", callback_data: `generator:view:${generatorId}` }],
      ] });
      await answerCallbackQuery(ctx.botToken, callback.id);
      return true;
    }
    if (data.startsWith("generator:contrast_set:")) {
      const [, , generatorRaw, reportContrastMode] = data.split(":");
      const generatorId = Number(generatorRaw);
      if (!Number.isSafeInteger(generatorId) || !reportContrastMode || !["auto", "light", "dark"].includes(reportContrastMode)) return false;
      await updateGenerator(ctx.db, generatorId, { reportContrastMode: reportContrastMode as "auto" | "light" | "dark" });
      await showAdminDetail(ctx, chatId, userId, generatorId, messageId);
      await answerCallbackQuery(ctx.botToken, callback.id, "内容颜色已保存");
      return true;
    }
    if (data.startsWith("generator:delete_ask:")) {
      const generatorId = Number(data.slice("generator:delete_ask:".length));
      const generator = await getGenerator(ctx.db, generatorId);
      if (!generator) throw new Error("报告不存在");
      await render(ctx, chatId, userId, messageId, "REPORT_GENERATOR_DELETE_CONFIRM", `确认永久删除报告“${generator.name}”？\n\n题目、填写结果和排队任务都会删除。`, { inline_keyboard: [[
        { text: "🗑 确认删除", callback_data: `generator:delete_confirm:${generatorId}` },
        { text: "取消", callback_data: `generator:view:${generatorId}` },
      ]] });
      await answerCallbackQuery(ctx.botToken, callback.id);
      return true;
    }
    if (data.startsWith("generator:delete_confirm:")) {
      const generatorId = Number(data.slice("generator:delete_confirm:".length));
      if (!Number.isSafeInteger(generatorId)) return false;
      await deleteGenerator(ctx.db, generatorId);
      await showAdminList(ctx, chatId, userId, messageId);
      await answerCallbackQuery(ctx.botToken, callback.id, "报告已删除");
      return true;
    }
    if (data.startsWith("generator:publish:") || data.startsWith("generator:archive:")) {
      const published = data.startsWith("generator:publish:");
      const prefix = published ? "generator:publish:" : "generator:archive:";
      const generatorId = Number(data.slice(prefix.length));
      if (published) await validateGeneratorForPublish(ctx, generatorId);
      await updateGenerator(ctx.db, generatorId, { status: published ? "published" : "archived" });
      await showAdminDetail(ctx, chatId, userId, generatorId, messageId);
      await answerCallbackQuery(ctx.botToken, callback.id, published ? "已发布" : "已停用");
      return true;
    }
  }

  if (data === "generator:list_user") {
    // This callback belonged to the retired standalone report flow. Reports
    // are only available after a completed survey response now.
    await render(ctx, chatId, userId, messageId, "REPORT_GENERATOR_RETIRED", "📊 报告需要在问卷提交完成后生成。\n\n请先从问卷列表选择一份问卷并完成填写。", {
      inline_keyboard: [[{ text: "📝 浏览问卷", callback_data: "home:surveys" }], [{ text: "⬅️ 返回首页", callback_data: "home:menu" }]],
    });
    await answerCallbackQuery(ctx.botToken, callback.id);
    return true;
  }
  if (data.startsWith("generator:use:")) {
    if (messageId === undefined) return false;
    const generator = await getGenerator(ctx.db, Number(data.slice("generator:use:".length)));
    if (!generator || generator.status !== "published") {
      await answerCallbackQuery(ctx.botToken, callback.id, "生成器不可用");
      return true;
    }
    const session: Session = { generatorId: generator.id, chatId, messageId, index: 0, values: {}, backgroundAssetId: null };
    await putState(ctx, sessionKey(userId), session);
    await renderParticipant(ctx, userId, session);
    await answerCallbackQuery(ctx.botToken, callback.id);
    return true;
  }

  const session = await getState<unknown>(ctx, sessionKey(userId));
  if (!isSession(session)) return false;
  if (data === "generator:cancel") {
    await ctx.cache?.delete(sessionKey(userId));
    await render(ctx, chatId, userId, messageId, "IMAGE_GENERATOR_CANCEL", "已取消报告生成。", { inline_keyboard: [[{ text: "📊 报告生成", callback_data: "generator:list_user" }]] });
    await answerCallbackQuery(ctx.botToken, callback.id);
    return true;
  }
  if (data === "generator:skip") {
    const questions = await listGeneratorQuestions(ctx.db, session.generatorId);
    const question = questions[session.index];
    if (!question || question.required) {
      await answerCallbackQuery(ctx.botToken, callback.id, "此题不能跳过");
      return true;
    }
    session.index += 1;
    await putState(ctx, sessionKey(userId), session);
    await renderParticipant(ctx, userId, session);
    await answerCallbackQuery(ctx.botToken, callback.id, "已跳过");
    return true;
  }
  if (data.startsWith("generator:answer:")) {
    const [, , questionRaw, rawValue] = data.split(":");
    const questions = await listGeneratorQuestions(ctx.db, session.generatorId);
    const question = questions[session.index];
    if (!question || question.id !== Number(questionRaw)) return false;
    if (question.type === "single") {
      const option = question.options[Number(rawValue)];
      if (!option) return false;
      session.values[question.variableName] = option;
    } else if (question.type === "rating") {
      const value = Number(rawValue); const settings = questionSettings(question);
      if (!Number.isFinite(value) || value < settings.min || value > settings.max) return false;
      session.values[question.variableName] = value;
    } else if (question.type === "boolean") {
      session.values[question.variableName] = rawValue === "true";
    } else return false;
    session.index += 1;
    await putState(ctx, sessionKey(userId), session);
    await renderParticipant(ctx, userId, session);
    await answerCallbackQuery(ctx.botToken, callback.id);
    return true;
  }
  if (data.startsWith("generator:multi:")) {
    const [, , questionRaw, optionRaw] = data.split(":");
    const questions = await listGeneratorQuestions(ctx.db, session.generatorId);
    const question = questions[session.index];
    if (!question || question.type !== "multiple" || question.id !== Number(questionRaw)) return false;
    const option = question.options[Number(optionRaw)]; if (!option) return false;
    const currentValue = session.values[question.variableName];
    const selected = Array.isArray(currentValue) ? currentValue.filter((value): value is string => typeof value === "string") : [];
    session.values[question.variableName] = selected.includes(option) ? selected.filter((value) => value !== option) : [...selected, option];
    await putState(ctx, sessionKey(userId), session);
    await renderParticipant(ctx, userId, session);
    await answerCallbackQuery(ctx.botToken, callback.id);
    return true;
  }
  if (data.startsWith("generator:multi_done:")) {
    const questionId = Number(data.slice("generator:multi_done:".length));
    const questions = await listGeneratorQuestions(ctx.db, session.generatorId);
    const question = questions[session.index];
    if (!question || question.type !== "multiple" || question.id !== questionId) return false;
    const currentValue = session.values[question.variableName];
    const selected = Array.isArray(currentValue) ? currentValue : [];
    if (question.required && selected.length === 0) { await answerCallbackQuery(ctx.botToken, callback.id, "请至少选择一项"); return true; }
    session.index += 1;
    await putState(ctx, sessionKey(userId), session);
    await renderParticipant(ctx, userId, session);
    await answerCallbackQuery(ctx.botToken, callback.id);
    return true;
  }
  if (data.startsWith("generator:image_done:")) {
    const questionId = Number(data.slice("generator:image_done:".length));
    const questions = await listGeneratorQuestions(ctx.db, session.generatorId);
    const question = questions[session.index];
    if (!question || question.type !== "image" || question.id !== questionId) return false;
    const value = session.values[question.variableName]; const count = Array.isArray(value) ? value.length : value ? 1 : 0;
    if (count < questionSettings(question).minImages) { await answerCallbackQuery(ctx.botToken, callback.id, "图片数量不足"); return true; }
    session.index += 1;
    await putState(ctx, sessionKey(userId), session);
    await renderParticipant(ctx, userId, session);
    await answerCallbackQuery(ctx.botToken, callback.id);
    return true;
  }
  if (data === "generator:back") {
    const generator = await getGenerator(ctx.db, session.generatorId);
    if (!generator) throw new Error("生成器不存在");
    if (session.index > 0) {
      const questions = await listGeneratorQuestions(ctx.db, session.generatorId);
      session.index -= 1;
      delete session.values[questions[session.index]!.variableName];
    }
    await putState(ctx, sessionKey(userId), session);
    await renderParticipant(ctx, userId, session);
    await answerCallbackQuery(ctx.botToken, callback.id);
    return true;
  }
  if (data.startsWith("generator:bg:") || data === "generator:bg_upload") {
    await answerCallbackQuery(ctx.botToken, callback.id, "填写者自定义背景已停用");
    return true;
  }
  if (data === "generator:render") {
    const generator = await getGenerator(ctx.db, session.generatorId);
    const template = generator ? await getVisualTemplateById(ctx.db, generator.templateId) : null;
    if (!generator || generator.status !== "published" || !template?.currentVersion) {
      throw new Error("生成器模板不可用");
    }
    await enqueueImageGeneratorJob(ctx.db, ctx.exportQueue, {
      generatorId: generator.id,
      templateId: template.id,
      templateVersion: template.currentVersion,
      values: session.values,
      backgroundAssetId: null,
      chatId,
      userId: internalUserId,
    });
    await render(ctx, chatId, userId, messageId, "IMAGE_GENERATOR_QUEUED", "🎨 正在生成你的报告，完成后会直接发送 PNG。", { inline_keyboard: [] });
    await ctx.cache?.delete(sessionKey(userId));
    await answerCallbackQuery(ctx.botToken, callback.id, "已开始生成");
    return true;
  }
  return false;
}

export { showGeneratorList };
