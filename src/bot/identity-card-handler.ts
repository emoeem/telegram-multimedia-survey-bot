import { answerCallbackQuery, sendMessage, type InlineKeyboardMarkup } from "./telegram";
import { renderScreen } from "./ui-message-controller";
import type { BotContext, TelegramCallbackQuery, TelegramMessage } from "./types";
import { registerMediaAsset } from "../services/media.service";
import { createIdentityProfile, type IdentityProfileRecord } from "../db/repositories/identity-card.repository";
import { clearUiSession, getUiSession, replaceUiScreen, setUiMessage } from "../services/ui-session.service";
import type { ResultProfileSnapshot } from "../result/schema";
import type { VisualTemplateDefinition } from "../visual-template/schema";
import {
  getIdentityCardAccessSetting,
  grantIdentityCardAccess,
  hasIdentityCardAccess,
} from "../db/repositories/feature-access.repository";
import { verifySurveyAccessCode } from "../core/security";

export type IdentityStyle = "simple" | "dark" | "classic";
type IdentityStep = "front" | "back" | "name" | "nickname" | "age" | "label" | "description" | "background" | "confirm";
interface IdentitySession {
  chatId: number;
  messageId?: number;
  uiStep?: IdentityStep | "style";
  step: IdentityStep;
  style: IdentityStyle;
  frontAssetId: number | null;
  backAssetId: number | null;
  backgroundAssetId: number | null;
  name?: string;
  nickname?: string;
  age?: number;
  label?: string;
  description?: string;
}

const key = (userId: number) => `identity-card-session:${userId}`;

const stepNumber: Record<IdentityStep, number> = {
  front: 1,
  back: 2,
  name: 3,
  nickname: 4,
  age: 5,
  label: 6,
  description: 7,
  background: 8,
  confirm: 9,
};

function progress(step: IdentityStep): string {
  return `步骤 ${stepNumber[step]}/9`;
}

function skipped(value: string): boolean {
  return ["-", "跳过", "- 跳过", "skip"].includes(value.trim().toLowerCase());
}

function optionalKeyboard(step: Exclude<IdentityStep, "front" | "back" | "name" | "confirm">): InlineKeyboardMarkup {
  if (step === "background") {
    return {
      inline_keyboard: [
        [{ text: "📤 上传我的背景", callback_data: "identity:background_upload" }],
        [{ text: "🖼 使用正面图片作背景", callback_data: "identity:background_front" }],
        [{ text: "使用样式默认背景", callback_data: "identity:skip:background" }, { text: "取消", callback_data: "identity:cancel" }],
      ],
    };
  }
  return { inline_keyboard: [[{ text: "跳过此项", callback_data: `identity:skip:${step}` }, { text: "取消", callback_data: "identity:cancel" }]] };
}

async function getState(ctx: BotContext, userId: number, chatId?: number): Promise<IdentitySession | null> {
  if (ctx.ui) {
    try {
      const ui = await getUiSession(ctx.ui, userId, chatId ?? userId);
      const encoded = ui.screenState.identityState;
      if (ui.screen?.startsWith("identity_") && typeof encoded === "string") {
        return JSON.parse(encoded) as IdentitySession;
      }
    } catch {
    }
  }
  const raw = await ctx.cache?.get(key(userId));
  if (!raw) return null;
  try { return JSON.parse(raw) as IdentitySession; } catch { return null; }
}

async function putState(ctx: BotContext, userId: number, state: IdentitySession): Promise<void> {
  if (!ctx.cache) throw new Error("当前部署未启用身份卡会话");
  await ctx.cache.put(key(userId), JSON.stringify(state), { expirationTtl: 30 * 60 });
}

export async function clearIdentityCardInteractionState(ctx: BotContext, userId: number, chatId?: number): Promise<void> {
  await Promise.all([
    ctx.cache?.delete(key(userId)),
    ctx.cache?.delete(unlockKey(userId)),
  ]);
  if (ctx.ui) {
    await clearUiSession(ctx.ui, userId, chatId ?? userId).catch(() => undefined);
  }
}

async function screen(ctx: BotContext, state: IdentitySession, userId: number, text: string, replyMarkup?: InlineKeyboardMarkup, renderStep: IdentityStep | "style" = state.step): Promise<void> {
  const editCurrentStep = state.uiStep === renderStep && state.messageId !== undefined;
  const result = await renderScreen({
    botToken: ctx.botToken,
    chatId: state.chatId,
    userId,
    screen: `identity_${renderStep}`,
    text,
    ...(replyMarkup ? { replyMarkup } : {}),
    ...(editCurrentStep ? { messageId: state.messageId } : {}),
  });
  state.messageId = result.messageId;
  state.uiStep = renderStep;
  await putState(ctx, userId, state);
  if (ctx.ui) {
    await replaceUiScreen(ctx.ui, userId, state.chatId, `identity_${renderStep}`, {
      identityState: JSON.stringify(state),
    }).catch(() => undefined);
    await setUiMessage(ctx.ui, userId, state.chatId, result.messageId).catch(() => undefined);
  }
}

function prompt(step: IdentityStep, text: string): string {
  return `${progress(step)}\n${text}`;
}

export async function startIdentityCard(ctx: BotContext, chatId: number, userId: number, messageId?: number): Promise<void> {
  const state: IdentitySession = {
    chatId, ...(messageId === undefined ? {} : { messageId }), step: "front", style: "simple",
    frontAssetId: null, backAssetId: null, backgroundAssetId: null,
  };
  await putState(ctx, userId, state);
  await screen(ctx, state, userId, "🪪 自定义身份卡\n\n这是一张个人资料卡，不是官方身份证明。\n\n先选择视觉风格，之后会依次收集图片和资料：", {
    inline_keyboard: [
      [{ text: "☁️ 玻璃极简", callback_data: "identity:style:simple" }],
      [{ text: "⚡ 霓虹赛博档案", callback_data: "identity:style:dark" }],
      [{ text: "✦ Art Deco 复古", callback_data: "identity:style:classic" }],
      [{ text: "取消", callback_data: "identity:cancel" }],
    ],
  }, "style");
}

export function getIdentityCardTemplate(style: IdentityStyle): VisualTemplateDefinition {
  const shared = { schemaVersion: 1 as const, width: 1080, height: 1350 as const, format: "png" as const, variables: [] };
  if (style === "dark") {
    return {
      ...shared, background: { type: "gradient", from: "#050816", to: "#18284e", angle: 135 },
      elements: [
        { id: "glow-a", type: "rectangle", x: 52, y: 58, width: 976, height: 1234, radius: 38, fill: "#071326", stroke: "#00E5FF", strokeWidth: 3 },
        { id: "glow-b", type: "rectangle", x: 72, y: 78, width: 936, height: 1194, radius: 28, fill: "#0B1022", stroke: "#FF3CAC", strokeWidth: 2, opacity: 0.95 },
        { id: "topline", type: "rectangle", x: 112, y: 136, width: 620, height: 8, fill: "#00E5FF" },
        { id: "heading", type: "text", x: 112, y: 170, width: 820, value: "IDENTITY // NEON ARCHIVE", color: "#8BE9FD", fontSize: 27, fontWeight: "bold", letterSpacing: 2 },
        { id: "serial", type: "text", x: 822, y: 170, width: 130, value: "# 01", align: "right", color: "#FF78C6", fontSize: 27, fontWeight: "bold" },
        { id: "portrait-frame", type: "rectangle", x: 112, y: 250, width: 430, height: 560, radius: 24, fill: "#00E5FF", opacity: 0.8 },
        { id: "front", type: "image", x: 126, y: 264, width: 402, height: 532, source: "{{result.images.front_image}}", fit: "cover", shape: "rounded", radius: 18 },
        { id: "portrait-chip", type: "text", x: 146, y: 734, width: 300, value: "VISUAL SIGNATURE", color: "#071326", fontSize: 24, fontWeight: "bold" },
        { id: "name", type: "text", x: 598, y: 274, width: 340, value: "{{result.fields.name}}", color: "#FFFFFF", fontSize: 62, fontWeight: "bold", maxLines: 1, overflow: "ellipsis" },
        { id: "nickname", type: "text", x: 602, y: 370, width: 330, value: "@ {{result.fields.nickname}}", color: "#A8B7D1", fontSize: 30, maxLines: 1, overflow: "ellipsis" },
        { id: "label-bg", type: "rectangle", x: 598, y: 450, width: 340, height: 66, radius: 12, fill: "#FF3CAC" },
        { id: "label", type: "text", x: 622, y: 462, width: 292, value: "{{result.fields.identity_label}}", color: "#FFFFFF", fontSize: 30, fontWeight: "bold", maxLines: 1, overflow: "ellipsis" },
        { id: "age-label", type: "text", x: 602, y: 562, width: 300, value: "AGE / {{result.fields.age}}", color: "#00E5FF", fontSize: 32, fontWeight: "bold" },
        { id: "right-rule", type: "rectangle", x: 598, y: 640, width: 340, height: 2, fill: "#41628F" },
        { id: "classification", type: "text", x: 602, y: 672, width: 330, value: "STATUS  •  SELF-DEFINED", color: "#A8B7D1", fontSize: 23, letterSpacing: 1 },
        { id: "bio-panel", type: "rectangle", x: 112, y: 874, width: 826, height: 236, radius: 20, fill: "#111E38", stroke: "#1B365B", strokeWidth: 2 },
        { id: "bio-heading", type: "text", x: 148, y: 908, width: 700, value: "PERSONAL NOTES", color: "#FF78C6", fontSize: 23, fontWeight: "bold", letterSpacing: 2 },
        { id: "description", type: "text", x: 148, y: 950, width: 742, value: "{{result.fields.description}}", color: "#EDF4FF", fontSize: 31, lineHeight: 1.42, maxLines: 3, overflow: "ellipsis" },
        { id: "back", type: "image", x: 112, y: 1160, width: 154, height: 88, source: "{{result.images.back_image}}", fit: "cover", shape: "rounded", radius: 12 },
        { id: "footer", type: "text", x: 290, y: 1188, width: 648, value: "ISSUED / {{result.metadata.created_at}}  ·  PERSONAL CARD", color: "#7891B5", fontSize: 22 },
      ],
    };
  }
  if (style === "classic") {
    return {
      ...shared, background: { type: "gradient", from: "#392318", to: "#A57434", angle: 45 },
      elements: [
        { id: "outer", type: "rectangle", x: 46, y: 46, width: 988, height: 1258, radius: 18, fill: "#EED8A7", stroke: "#2D190F", strokeWidth: 12 },
        { id: "inner", type: "rectangle", x: 72, y: 72, width: 936, height: 1206, radius: 10, fill: "#F8EBCB", stroke: "#B7873D", strokeWidth: 4 },
        { id: "topornament", type: "text", x: 130, y: 124, width: 820, value: "✦  PERSONAL DOSSIER  ✦", align: "center", color: "#7A4822", fontSize: 30, fontWeight: "bold", letterSpacing: 3 },
        { id: "top-rule", type: "rectangle", x: 160, y: 184, width: 760, height: 4, fill: "#B7873D" },
        { id: "front-shadow", type: "rectangle", x: 132, y: 262, width: 368, height: 482, radius: 4, fill: "#62351D" },
        { id: "front", type: "image", x: 146, y: 248, width: 368, height: 482, source: "{{result.images.front_image}}", fit: "cover", shape: "rectangle" },
        { id: "seal", type: "rectangle", x: 172, y: 670, width: 182, height: 48, radius: 24, fill: "#8B2020" },
        { id: "seal-text", type: "text", x: 172, y: 677, width: 182, value: "SELF ISSUED", align: "center", color: "#FFF4D6", fontSize: 18, fontWeight: "bold" },
        { id: "name", type: "text", x: 574, y: 270, width: 320, value: "{{result.fields.name}}", color: "#3A2116", fontSize: 64, fontWeight: "bold", maxLines: 1, overflow: "ellipsis" },
        { id: "nickname", type: "text", x: 580, y: 370, width: 310, value: "{{result.fields.nickname}}", color: "#8C5C35", fontSize: 30, maxLines: 1, overflow: "ellipsis" },
        { id: "label-title", type: "text", x: 580, y: 455, width: 300, value: "DISTINCTION", color: "#A16B2C", fontSize: 22, fontWeight: "bold", letterSpacing: 2 },
        { id: "label", type: "text", x: 580, y: 495, width: 300, value: "{{result.fields.identity_label}}", color: "#3A2116", fontSize: 37, fontWeight: "bold", maxLines: 1, overflow: "ellipsis" },
        { id: "age-title", type: "text", x: 580, y: 588, width: 300, value: "AGE", color: "#A16B2C", fontSize: 22, fontWeight: "bold", letterSpacing: 2 },
        { id: "age", type: "text", x: 580, y: 628, width: 300, value: "{{result.fields.age}}", color: "#3A2116", fontSize: 42, fontWeight: "bold" },
        { id: "name-rule", type: "rectangle", x: 574, y: 704, width: 320, height: 3, fill: "#B7873D" },
        { id: "chapter", type: "text", x: 146, y: 826, width: 788, value: "A SHORT PORTRAIT", align: "center", color: "#7A4822", fontSize: 25, fontWeight: "bold", letterSpacing: 3 },
        { id: "description", type: "text", x: 164, y: 882, width: 752, value: "{{result.fields.description}}", align: "center", color: "#4C2C1E", fontSize: 32, lineHeight: 1.48, maxLines: 4, overflow: "ellipsis" },
        { id: "bottom-rule", type: "rectangle", x: 160, y: 1120, width: 760, height: 4, fill: "#B7873D" },
        { id: "back", type: "image", x: 164, y: 1160, width: 122, height: 76, source: "{{result.images.back_image}}", fit: "cover", shape: "rounded", radius: 8 },
        { id: "footer", type: "text", x: 310, y: 1180, width: 604, value: "ARCHIVED · {{result.metadata.created_at}}", align: "center", color: "#8C5C35", fontSize: 24, letterSpacing: 2 },
      ],
    };
  }
  return {
    ...shared, background: { type: "gradient", from: "#DDEEFF", to: "#F5E7FF", angle: 135 },
    elements: [
      { id: "shadow", type: "rectangle", x: 76, y: 84, width: 928, height: 1180, radius: 46, fill: "#94A3B8", opacity: 0.22 },
      { id: "card", type: "rectangle", x: 60, y: 60, width: 928, height: 1180, radius: 46, fill: "#FFFFFF", stroke: "#FFFFFF", strokeWidth: 3, opacity: 0.94 },
      { id: "accent-a", type: "rectangle", x: 60, y: 60, width: 928, height: 18, radius: 9, fill: "#7C3AED" },
      { id: "accent-b", type: "rectangle", x: 60, y: 78, width: 590, height: 8, fill: "#38BDF8" },
      { id: "eyebrow", type: "text", x: 116, y: 138, width: 780, value: "PERSONAL PROFILE  /  SELF-DEFINED", color: "#64748B", fontSize: 23, fontWeight: "bold", letterSpacing: 2 },
      { id: "front-ring", type: "rectangle", x: 116, y: 218, width: 350, height: 350, radius: 175, fill: "#DDD6FE" },
      { id: "front", type: "image", x: 128, y: 230, width: 326, height: 326, source: "{{result.images.front_image}}", fit: "cover", shape: "circle" },
      { id: "name", type: "text", x: 530, y: 242, width: 360, value: "{{result.fields.name}}", color: "#172554", fontSize: 65, fontWeight: "bold", maxLines: 1, overflow: "ellipsis" },
      { id: "nickname", type: "text", x: 536, y: 342, width: 340, value: "{{result.fields.nickname}}", color: "#64748B", fontSize: 30, maxLines: 1, overflow: "ellipsis" },
      { id: "label-bg", type: "rectangle", x: 530, y: 422, width: 342, height: 64, radius: 32, fill: "#EDE9FE" },
      { id: "label", type: "text", x: 558, y: 435, width: 292, value: "{{result.fields.identity_label}}", color: "#6D28D9", fontSize: 29, fontWeight: "bold", maxLines: 1, overflow: "ellipsis" },
      { id: "age", type: "text", x: 536, y: 526, width: 300, value: "AGE  {{result.fields.age}}", color: "#0F766E", fontSize: 29, fontWeight: "bold", letterSpacing: 2 },
      { id: "divider", type: "rectangle", x: 116, y: 652, width: 756, height: 2, fill: "#CBD5E1" },
      { id: "bio-title", type: "text", x: 116, y: 704, width: 700, value: "ABOUT ME", color: "#7C3AED", fontSize: 24, fontWeight: "bold", letterSpacing: 2 },
      { id: "description", type: "text", x: 116, y: 750, width: 756, value: "{{result.fields.description}}", color: "#334155", fontSize: 35, lineHeight: 1.45, maxLines: 4, overflow: "ellipsis" },
      { id: "quote-box", type: "rectangle", x: 116, y: 1014, width: 756, height: 122, radius: 22, fill: "#F1F5F9" },
      { id: "quote", type: "text", x: 150, y: 1040, width: 680, value: "A card for the person I choose to be.", align: "center", color: "#64748B", fontSize: 26, fontWeight: "bold" },
      { id: "back", type: "image", x: 116, y: 1166, width: 112, height: 54, source: "{{result.images.back_image}}", fit: "cover", shape: "rounded", radius: 12 },
      { id: "footer", type: "text", x: 250, y: 1176, width: 622, value: "CREATED  {{result.metadata.created_at}}", color: "#64748B", fontSize: 23, letterSpacing: 2 },
    ],
  };
}

function profile(state: {
  frontAssetId: number | null;
  backAssetId: number | null;
  name?: string | undefined;
  nickname?: string | undefined;
  age?: number | undefined;
  label?: string | undefined;
  description?: string | undefined;
}): ResultProfileSnapshot {
  const fields = {
    name: { id: "name", type: "text" as const, value: state.name ?? "" },
    nickname: { id: "nickname", type: "text" as const, value: state.nickname ?? "" },
    age: { id: "age", type: "number" as const, value: state.age ?? "" },
    identity_label: { id: "identity_label", type: "text" as const, value: state.label ?? "" },
    description: { id: "description", type: "long_text" as const, value: state.description ?? "" },
  };
  const images: ResultProfileSnapshot["images"] = { front_image: { mediaAssetId: state.frontAssetId ?? 0 } };
  if (state.backAssetId) images.back_image = { mediaAssetId: state.backAssetId };
  return { resultType: "identity_card", title: state.name ?? null, subtitle: state.label ?? null, fields, stats: [], tags: [], images, metadata: { created_at: new Date().toLocaleDateString("zh-CN") }, schemaVersion: 1 };
}

export function applyIdentityBackground(
  definition: VisualTemplateDefinition,
  style: IdentityStyle,
  assetId: number | null,
): VisualTemplateDefinition {
  if (!assetId) return definition;
  const overlay = style === "dark" ? "#050816" : style === "classic" ? "#3b2115" : "#ffffff";
  const panelOpacity = style === "dark" ? 0.68 : style === "classic" ? 0.70 : 0.64;
  return {
    ...definition,
    background: { type: "telegram_asset", assetId, fit: "cover" },
    elements: [
      { id: "identity-background-overlay", type: "rectangle", x: 0, y: 0, width: definition.width, height: 1350, fill: overlay, opacity: style === "dark" ? 0.25 : style === "classic" ? 0.22 : 0.16, zIndex: -100 },
      ...definition.elements.map((element) => (
        ["card", "glow-a", "glow-b", "outer", "inner"].includes(element.id)
          ? { ...element, opacity: panelOpacity }
          : element
      )),
    ],
  };
}

export async function renderIdentityCardPng(
  db: D1Database,
  botToken: string,
  identity: IdentityProfileRecord,
): Promise<Uint8Array> {
  const style: IdentityStyle = identity.templateStyle === "dark" || identity.templateStyle === "classic" ? identity.templateStyle : "simple";
  const definition = applyIdentityBackground(getIdentityCardTemplate(style), style, identity.backgroundAssetId);
  const resultProfile = profile({
    frontAssetId: identity.frontAssetId, backAssetId: identity.backAssetId,
    name: identity.name, nickname: identity.nickname ?? undefined, age: identity.age ?? undefined,
    label: identity.identityLabel ?? undefined, description: identity.description ?? undefined,
  });
  const [{ renderResultVisualPng, TEMPLATE_BACKGROUND_IMAGE_KEY }, { RESULT_VISUAL_FONTS }, { RESULT_VISUAL_WASM }, { resolveResultVisualImages }] = await Promise.all([
    import("../services/result-visual-renderer.service"), import("../services/result-visual-font"), import("../services/result-visual-wasm"), import("../services/result-visual-image.service"),
  ]);
  const images = await resolveResultVisualImages(db, botToken, definition, resultProfile);
  if (identity.backgroundAssetId && !images[TEMPLATE_BACKGROUND_IMAGE_KEY]) {
    throw new Error("资料卡背景图片无法下载，请重新上传后再生成");
  }
  return renderResultVisualPng(definition, resultProfile, { wasmModule: RESULT_VISUAL_WASM, fontBuffers: RESULT_VISUAL_FONTS, images });
}

function unlockKey(userId: number): string {
  return `identity-card-unlock:${userId}`;
}

async function promptIdentityCardUnlock(ctx: BotContext, chatId: number, userId: number): Promise<void> {
  await ctx.cache?.put(unlockKey(userId), String(chatId), { expirationTtl: 10 * 60 });
  await sendMessage(ctx.botToken, chatId, "🔐 自定义身份卡需要使用密码解锁。\n\n请输入图片生成功能密码；发送 /cancel 取消。", {
    inline_keyboard: [[{ text: "取消", callback_data: "identity:cancel" }]],
  });
}

async function enqueueGeneration(ctx: BotContext, userId: number, state: IdentitySession): Promise<void> {
  if (!state.frontAssetId || !state.name) throw new Error("缺少正面图片或姓名");
  const identity = await createIdentityProfile(ctx.db, {
    userId, name: state.name, nickname: state.nickname ?? null, age: state.age ?? null,
    identityLabel: state.label ?? null, description: state.description ?? null,
    frontAssetId: state.frontAssetId, backAssetId: state.backAssetId, backgroundAssetId: state.backgroundAssetId ?? null, templateStyle: state.style,
  });
  const createdAt = new Date().toISOString();
  const result = await ctx.db.prepare(
    `INSERT INTO identity_card_jobs (identity_profile_id, chat_id, user_id, created_at)
     VALUES (?, ?, ?, ?)`,
  ).bind(identity.id, state.chatId, userId, createdAt).run();
  const jobId = result.meta?.last_row_id;
  if (typeof jobId !== "number") throw new Error("身份卡生成任务创建失败");
  await ctx.exportQueue.send({ kind: "identity_card", jobId });
}

export async function handleIdentityCardCallback(ctx: BotContext, callback: TelegramCallbackQuery, userId: number): Promise<boolean> {
  const data = callback.data;
  const chatId = callback.message?.chat.id;
  if (!data || !chatId) return false;
  if (data === "identity:list") {
    const isAdministrator = ctx.adminIds.includes(callback.from.id);
    const accessSetting = await getIdentityCardAccessSetting(ctx.db);
    if (!isAdministrator && !accessSetting) {
      await answerCallbackQuery(ctx.botToken, callback.id, "功能尚未启用");
      await sendMessage(ctx.botToken, chatId, "🔒 图片生成功能暂未启用，请联系管理员设置使用密码。");
      return true;
    }
    if (!isAdministrator && !(await hasIdentityCardAccess(ctx.db, userId))) {
      if (!ctx.cache) {
        await answerCallbackQuery(ctx.botToken, callback.id, "功能暂时不可用");
        await sendMessage(ctx.botToken, chatId, "图片生成功能当前无法验证密码，请稍后重试。");
        return true;
      }
      await promptIdentityCardUnlock(ctx, chatId, userId);
      await answerCallbackQuery(ctx.botToken, callback.id);
      return true;
    }
    await startIdentityCard(ctx, chatId, userId, callback.message?.message_id);
    await answerCallbackQuery(ctx.botToken, callback.id);
    return true;
  }
  const state = await getState(ctx, userId, chatId);
  if (!state) return false;
  if (data === "identity:cancel") { await clearIdentityCardInteractionState(ctx, userId, chatId); await sendMessage(ctx.botToken, chatId, "已取消身份卡制作。\n\n你可以从主菜单重新开始。", { inline_keyboard: [[{ text: "返回主菜单", callback_data: "home:menu" }]] }); await answerCallbackQuery(ctx.botToken, callback.id); return true; }
  if (data.startsWith("identity:style:")) {
    const style = data.slice("identity:style:".length) as IdentityStyle;
    if (!["simple", "dark", "classic"].includes(style)) return false;
    state.style = style; state.step = "front";
    await screen(ctx, state, userId, prompt("front", "✅ 已选择样式。\n\n正面图片（必填）\n请上传一张图片："), { inline_keyboard: [[{ text: "取消", callback_data: "identity:cancel" }]] });
    await answerCallbackQuery(ctx.botToken, callback.id); return true;
  }
  if (data === "identity:skip_back" && state.step === "back") {
    state.step = "name"; await screen(ctx, state, userId, prompt("name", "✅ 已跳过背面图片。\n\n姓名（必填）\n请输入卡片上的姓名或称呼："), { inline_keyboard: [[{ text: "取消", callback_data: "identity:cancel" }]] }); await answerCallbackQuery(ctx.botToken, callback.id); return true;
  }
  if (data === "identity:background_upload" && state.step === "background") {
    await screen(ctx, state, userId, prompt("background", "📤 请上传一张作为资料卡背景的图片。\n\n图片会自动叠加可读性遮罩，避免文字与背景撞色。"), { inline_keyboard: [[{ text: "使用样式默认背景", callback_data: "identity:skip:background" }, { text: "取消", callback_data: "identity:cancel" }]] });
    await answerCallbackQuery(ctx.botToken, callback.id);
    return true;
  }
  if (data === "identity:background_front" && state.step === "background" && state.frontAssetId) {
    state.backgroundAssetId = state.frontAssetId;
    state.step = "confirm";
    await screen(ctx, state, userId, prompt("confirm", `✅ 已使用正面图片作为背景。\n\n请确认身份卡资料：\n\n姓名：${state.name}\n昵称：${state.nickname ?? "未填写"}\n年龄：${state.age ?? "未填写"}\n标签：${state.label ?? "未填写"}\n简介：${state.description ?? "未填写"}\n背景：使用正面图片`), { inline_keyboard: [[{ text: "✅ 生成身份卡", callback_data: "identity:confirm" }], [{ text: "取消", callback_data: "identity:cancel" }]] });
    await answerCallbackQuery(ctx.botToken, callback.id);
    return true;
  }
  if (data.startsWith("identity:skip:")) {
    const step = data.slice("identity:skip:".length) as IdentityStep;
    if (step !== state.step || !["nickname", "age", "label", "description", "background"].includes(step)) return false;
    if (step === "nickname") { state.step = "age"; await screen(ctx, state, userId, prompt("age", "✅ 已跳过昵称。\n\n年龄（可选）\n请输入 0-150 的整数，或点击跳过："), optionalKeyboard("age")); }
    else if (step === "age") { state.step = "label"; await screen(ctx, state, userId, prompt("label", "✅ 已跳过年龄。\n\n身份标签（可选）\n请输入身份标签，或点击跳过："), optionalKeyboard("label")); }
    else if (step === "label") { state.step = "description"; await screen(ctx, state, userId, prompt("description", "✅ 已跳过身份标签。\n\n简介（可选）\n请输入简介，或点击跳过："), optionalKeyboard("description")); }
    else if (step === "description") { state.step = "background"; await screen(ctx, state, userId, prompt("background", "✅ 已跳过简介。\n\n报告背景（可选）\n可以上传一张自己的图片作为整张资料卡背景，也可以使用样式默认背景："), optionalKeyboard("background")); }
    else if (step === "background") { state.step = "confirm"; await screen(ctx, state, userId, prompt("confirm", `✅ 已使用样式默认背景。\n\n请确认身份卡资料：\n\n姓名：${state.name}\n昵称：${state.nickname ?? "未填写"}\n年龄：${state.age ?? "未填写"}\n标签：${state.label ?? "未填写"}\n简介：${state.description ?? "未填写"}`), { inline_keyboard: [[{ text: "✅ 生成身份卡", callback_data: "identity:confirm" }], [{ text: "取消", callback_data: "identity:cancel" }]] }); }
    await answerCallbackQuery(ctx.botToken, callback.id);
    return true;
  }
  if (data === "identity:confirm" && state.step === "confirm") {
    if (!ctx.adminIds.includes(callback.from.id)) {
      const accessSetting = await getIdentityCardAccessSetting(ctx.db);
      if (!accessSetting || !(await hasIdentityCardAccess(ctx.db, userId))) {
        await clearIdentityCardInteractionState(ctx, userId, chatId);
        await sendMessage(ctx.botToken, chatId, "🔐 图片生成功能密码已更换或已关闭。请重新解锁后再制作身份卡。", {
          inline_keyboard: [[{ text: "重新解锁", callback_data: "identity:list" }]],
        });
        await answerCallbackQuery(ctx.botToken, callback.id);
        return true;
      }
    }
    await screen(ctx, state, userId, "🎨 已提交身份卡生成任务。\n\n正在后台下载图片并生成 PNG，完成后会直接发送给你。你可以继续使用机器人。", { inline_keyboard: [[{ text: "返回主菜单", callback_data: "home:menu" }]] });
    try { await enqueueGeneration(ctx, userId, state); await clearIdentityCardInteractionState(ctx, userId, chatId); } catch (error) { await screen(ctx, state, userId, `生成任务创建失败：${error instanceof Error ? error.message : "未知错误"}`, { inline_keyboard: [[{ text: "取消", callback_data: "identity:cancel" }]] }); }
    await answerCallbackQuery(ctx.botToken, callback.id); return true;
  }
  return false;
}

export async function handleIdentityCardMessage(ctx: BotContext, message: TelegramMessage, userId: number): Promise<boolean> {
  const pendingUnlock = await ctx.cache?.get(unlockKey(userId));
  if (pendingUnlock === String(message.chat.id)) {
    const text = message.text?.trim();
    if (text === "/cancel") {
      await ctx.cache?.delete(unlockKey(userId));
      await sendMessage(ctx.botToken, message.chat.id, "已取消图片生成功能解锁。");
      return true;
    }
    if (!text) {
      await sendMessage(ctx.botToken, message.chat.id, "当前需要输入图片生成功能密码，或发送 /cancel 取消。");
      return true;
    }
    const accessSetting = await getIdentityCardAccessSetting(ctx.db);
    if (!accessSetting) {
      await ctx.cache?.delete(unlockKey(userId));
      await sendMessage(ctx.botToken, message.chat.id, "图片生成功能尚未启用，请联系管理员。");
      return true;
    }
    if (!(await verifySurveyAccessCode(accessSetting.accessCode, text))) {
      await sendMessage(ctx.botToken, message.chat.id, "密码错误，请重试；发送 /cancel 取消。");
      return true;
    }
    await grantIdentityCardAccess(ctx.db, userId, accessSetting.version);
    await ctx.cache?.delete(unlockKey(userId));
    await startIdentityCard(ctx, message.chat.id, userId);
    return true;
  }
  const state = await getState(ctx, userId, message.chat.id);
  if (!state) return false;
  const text = message.text?.trim();
  if (state.step === "front" || state.step === "back") {
    if (state.step === "back" && text && skipped(text)) {
      state.step = "name";
      await screen(ctx, state, userId, prompt("name", "✅ 已跳过背面图片。\n\n姓名（必填）\n请输入卡片上的姓名或称呼："), { inline_keyboard: [[{ text: "取消", callback_data: "identity:cancel" }]] });
      return true;
    }
    if (!message.photo) {
      await screen(ctx, state, userId, prompt(state.step, "⚠️ 当前需要一张图片，请直接发送图片。"), state.step === "back"
        ? { inline_keyboard: [[{ text: "跳过背面", callback_data: "identity:skip_back" }, { text: "取消", callback_data: "identity:cancel" }]] }
        : { inline_keyboard: [[{ text: "取消", callback_data: "identity:cancel" }]] });
      return true;
    }
    const assetId = await registerMediaAsset(ctx, message, { scope: "identity_card" });
    if (!assetId) {
      await screen(ctx, state, userId, prompt(state.step, "⚠️ 图片接收失败，请重新发送图片。"), state.step === "back"
        ? { inline_keyboard: [[{ text: "跳过背面", callback_data: "identity:skip_back" }, { text: "取消", callback_data: "identity:cancel" }]] }
        : { inline_keyboard: [[{ text: "取消", callback_data: "identity:cancel" }]] });
      return true;
    }
    if (state.step === "front") { state.frontAssetId = assetId; state.step = "back"; await screen(ctx, state, userId, prompt("back", "✅ 已收到正面图片。\n\n背面图片（可选）\n可以再上传一张图片，也可以点击跳过："), { inline_keyboard: [[{ text: "跳过背面", callback_data: "identity:skip_back" }, { text: "取消", callback_data: "identity:cancel" }]] }); }
    else { state.backAssetId = assetId; state.step = "name"; await screen(ctx, state, userId, prompt("name", "✅ 已收到背面图片。\n\n姓名（必填）\n请输入卡片上的姓名或称呼："), { inline_keyboard: [[{ text: "取消", callback_data: "identity:cancel" }]] }); }
    return true;
  }
  if (state.step === "background") {
    if (!message.photo) {
      await screen(ctx, state, userId, prompt("background", "请上传一张图片作为资料卡背景，或点击“使用样式默认背景”。"), optionalKeyboard("background"));
      return true;
    }
    const assetId = await registerMediaAsset(ctx, message, { scope: "identity_card" });
    if (!assetId) {
      await screen(ctx, state, userId, prompt("background", "⚠️ 背景图片接收失败，请重新上传。"), optionalKeyboard("background"));
      return true;
    }
    state.backgroundAssetId = assetId;
    state.step = "confirm";
    await screen(ctx, state, userId, prompt("confirm", `✅ 已收到自定义背景。\n\n请确认身份卡资料：\n\n姓名：${state.name}\n昵称：${state.nickname ?? "未填写"}\n年龄：${state.age ?? "未填写"}\n标签：${state.label ?? "未填写"}\n简介：${state.description ?? "未填写"}\n背景：已上传自定义图片`), { inline_keyboard: [[{ text: "✅ 生成身份卡", callback_data: "identity:confirm" }], [{ text: "取消", callback_data: "identity:cancel" }]] });
    return true;
  }
  if (!text) {
    const retryMarkup = state.step === "name"
      ? { inline_keyboard: [[{ text: "取消", callback_data: "identity:cancel" }]] }
      : optionalKeyboard(state.step as Exclude<IdentityStep, "front" | "back" | "name" | "confirm">);
    await screen(ctx, state, userId, prompt(state.step, state.step === "name"
      ? "⚠️ 当前需要姓名，请发送文字。"
      : "⚠️ 当前需要文字内容，请发送文字或使用“跳过此项”。"), retryMarkup);
    return true;
  }
  if (state.step === "name") { state.name = text.slice(0, 80); state.step = "nickname"; await screen(ctx, state, userId, prompt("nickname", "✅ 已收到姓名。\n\n昵称（可选）\n请输入昵称，或点击跳过："), optionalKeyboard("nickname")); return true; }
  if (state.step === "nickname") { if (!skipped(text)) state.nickname = text.slice(0, 80); state.step = "age"; await screen(ctx, state, userId, prompt("age", skipped(text) ? "✅ 已跳过昵称。\n\n年龄（可选）\n请输入 0-150 的整数，或点击跳过：" : "✅ 已收到昵称。\n\n年龄（可选）\n请输入 0-150 的整数，或点击跳过:"), optionalKeyboard("age")); return true; }
  if (state.step === "age") { if (!skipped(text)) { const age = Number(text); if (!Number.isInteger(age) || age < 0 || age > 150) { await screen(ctx, state, userId, prompt("age", "⚠️ 年龄需要是 0-150 的整数；也可以点击“跳过此项”。"), optionalKeyboard("age")); return true; } state.age = age; } state.step = "label"; await screen(ctx, state, userId, prompt("label", skipped(text) ? "✅ 已跳过年龄。\n\n身份标签（可选）\n请输入身份标签，或点击跳过：" : "✅ 已收到年龄。\n\n身份标签（可选）\n请输入身份标签，或点击跳过："), optionalKeyboard("label")); return true; }
  if (state.step === "label") { if (!skipped(text)) state.label = text.slice(0, 80); state.step = "description"; await screen(ctx, state, userId, prompt("description", skipped(text) ? "✅ 已跳过身份标签。\n\n简介（可选）\n请输入简介，或点击跳过：" : "✅ 已收到身份标签。\n\n简介（可选）\n请输入简介，或点击跳过："), optionalKeyboard("description")); return true; }
  if (state.step === "description") { if (!skipped(text)) state.description = text.slice(0, 500); state.step = "background"; await screen(ctx, state, userId, prompt("background", `✅ ${skipped(text) ? "已跳过简介。" : "已收到简介。"}\n\n报告背景（可选）\n可以上传一张自己的图片作为整张资料卡背景，也可以使用样式默认背景：`), optionalKeyboard("background")); return true; }
  return true;
}
