import { answerCallbackQuery, sendMessage, type InlineKeyboardMarkup } from "./telegram";
import { renderScreen } from "./ui-message-controller";
import type { BotContext, TelegramCallbackQuery, TelegramMessage } from "./types";
import { registerMediaAsset } from "../services/media.service";
import { createIdentityProfile } from "../db/repositories/identity-card.repository";
import { clearUiSession, getUiSession, replaceUiScreen, setUiMessage } from "../services/ui-session.service";
import {
  getIdentityCardAccessSetting,
  grantIdentityCardAccess,
  hasIdentityCardAccess,
} from "../db/repositories/feature-access.repository";
import { verifySurveyAccessCode } from "../core/security";
import { IDENTITY_CARD_TEMPLATES, isIdentityCardTemplateId } from "../services/identity-card-report.service";
import { getCardTemplateById, listCardTemplates } from "../db/repositories/card-template.repository";

type IdentityStep =
  "front" | "back" | "name" | "nickname" | "age" | "label" | "description" | "background" | "gallery" | "confirm";
interface IdentitySession {
  chatId: number;
  messageId?: number;
  uiStep?: IdentityStep | "style";
  step: IdentityStep;
  /** Selected card template id (see IDENTITY_CARD_TEMPLATES). */
  style: string;
  galleryPublished: boolean;
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
  gallery: 9,
  confirm: 10,
};

function progress(step: IdentityStep): string {
  return `步骤 ${stepNumber[step]}/${stepNumber.confirm}`;
}

function skipped(value: string): boolean {
  return ["-", "跳过", "- 跳过", "skip"].includes(value.trim().toLowerCase());
}

function optionalKeyboard(
  step: Exclude<IdentityStep, "front" | "back" | "name" | "gallery" | "confirm">,
): InlineKeyboardMarkup {
  if (step === "background") {
    return {
      inline_keyboard: [
        [{ text: "📤 上传我的背景", callback_data: "identity:background_upload" }],
        [{ text: "🖼 使用正面图片作背景", callback_data: "identity:background_front" }],
        [
          { text: "使用样式默认背景", callback_data: "identity:skip:background" },
          { text: "取消", callback_data: "identity:cancel" },
        ],
      ],
    };
  }
  return {
    inline_keyboard: [
      [
        { text: "跳过此项", callback_data: `identity:skip:${step}` },
        { text: "取消", callback_data: "identity:cancel" },
      ],
    ],
  };
}

async function getState(ctx: BotContext, userId: number, chatId?: number): Promise<IdentitySession | null> {
  if (ctx.ui) {
    try {
      const ui = await getUiSession(ctx.ui, userId, chatId ?? userId);
      const encoded = ui.screenState.identityState;
      if (ui.screen?.startsWith("identity_") && typeof encoded === "string") {
        return JSON.parse(encoded) as IdentitySession;
      }
    } catch {}
  }
  const raw = await ctx.cache?.get(key(userId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as IdentitySession;
  } catch {
    return null;
  }
}

async function putState(ctx: BotContext, userId: number, state: IdentitySession): Promise<void> {
  if (!ctx.cache) throw new Error("当前部署未启用身份卡会话");
  await ctx.cache.put(key(userId), JSON.stringify(state), { expirationTtl: 30 * 60 });
}

export async function clearIdentityCardInteractionState(
  ctx: BotContext,
  userId: number,
  chatId?: number,
): Promise<void> {
  await Promise.all([ctx.cache?.delete(key(userId)), ctx.cache?.delete(unlockKey(userId))]);
  if (ctx.ui) {
    await clearUiSession(ctx.ui, userId, chatId ?? userId).catch(() => undefined);
  }
}

async function screen(
  ctx: BotContext,
  state: IdentitySession,
  userId: number,
  text: string,
  replyMarkup?: InlineKeyboardMarkup,
  renderStep: IdentityStep | "style" = state.step,
): Promise<void> {
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

export async function startIdentityCard(
  ctx: BotContext,
  chatId: number,
  userId: number,
  messageId?: number,
): Promise<void> {
  const state: IdentitySession = {
    chatId,
    ...(messageId === undefined ? {} : { messageId }),
    step: "front",
    style: "identity",
    galleryPublished: false,
    frontAssetId: null,
    backAssetId: null,
    backgroundAssetId: null,
  };
  await putState(ctx, userId, state);
  const customTemplates = await listCardTemplates(ctx.db, { enabledOnly: true }).catch(() => []);
  await screen(
    ctx,
    state,
    userId,
    "🪪 自定义资料卡\n\n这是一张个人资料卡，不是官方身份证明。\n\n卡片使用网页报告渲染管线生成。先选择卡片版式，之后会依次收集图片和资料：",
    {
      inline_keyboard: [
        ...IDENTITY_CARD_TEMPLATES.map((template) => [
          { text: template.label, callback_data: `identity:style:${template.id}` },
        ]),
        ...customTemplates.map((template) => [
          { text: `🃏 ${template.name}`, callback_data: `identity:style:custom:${template.id}` },
        ]),
        [{ text: "取消", callback_data: "identity:cancel" }],
      ],
    },
    "style",
  );
}

function confirmSummary(state: IdentitySession): string {
  const background =
    state.backgroundAssetId === state.frontAssetId && state.frontAssetId !== null
      ? "背景：使用正面图片"
      : state.backgroundAssetId
        ? "背景：已上传自定义图片"
        : "背景：样式默认";
  return [
    "请确认资料卡内容：",
    "",
    `姓名：${state.name}`,
    `昵称：${state.nickname ?? "未填写"}`,
    `年龄：${state.age ?? "未填写"}`,
    `标签：${state.label ?? "未填写"}`,
    `简介：${state.description ?? "未填写"}`,
    background,
    `画廊：${state.galleryPublished ? "🌍 发布到资料卡画廊" : "🔒 仅自己可见"}`,
  ].join("\n");
}

function confirmKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: "✅ 生成资料卡", callback_data: "identity:confirm" }],
      [{ text: "取消", callback_data: "identity:cancel" }],
    ],
  };
}

function galleryPrompt(state: IdentitySession): string {
  const backgroundNote = state.style.startsWith("custom:")
    ? "已使用模板自带卡面"
    : state.backgroundAssetId
      ? "背景已设置"
      : "已使用样式默认背景";
  return prompt(
    "gallery",
    `✅ ${backgroundNote}。\n\n🌍 画廊发布\n是否把这张资料卡发布到资料卡画廊？发布后其他用户可以在机器人的「资料卡画廊」里浏览这张卡片。`,
  );
}

function galleryKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "🌍 发布到画廊", callback_data: "identity:gallery:yes" },
        { text: "🔒 仅自己可见", callback_data: "identity:gallery:no" },
      ],
    ],
  };
}

function unlockKey(userId: number): string {
  return `identity-card-unlock:${userId}`;
}

// Custom card face templates carry their own background, so the separate
// "upload a background" step would only confuse; skip straight to gallery.
function usesBuiltInBackground(state: IdentitySession): boolean {
  return state.style.startsWith("custom:");
}

async function advanceAfterDescription(
  ctx: BotContext,
  state: IdentitySession,
  userId: number,
  note: string,
): Promise<void> {
  if (usesBuiltInBackground(state)) {
    state.step = "gallery";
    await screen(ctx, state, userId, galleryPrompt(state), galleryKeyboard());
    return;
  }
  state.step = "background";
  await screen(
    ctx,
    state,
    userId,
    prompt(
      "background",
      `✅ ${note}\n\n卡片背景（可选）\n可以上传一张自己的图片作为整张资料卡背景，也可以使用样式默认背景：`,
    ),
    optionalKeyboard("background"),
  );
}

async function promptIdentityCardUnlock(ctx: BotContext, chatId: number, userId: number): Promise<void> {
  await ctx.cache?.put(unlockKey(userId), String(chatId), { expirationTtl: 10 * 60 });
  await sendMessage(
    ctx.botToken,
    chatId,
    "🔐 自定义资料卡需要使用密码解锁。\n\n请输入图片生成功能密码；发送 /cancel 取消。",
    {
      inline_keyboard: [[{ text: "取消", callback_data: "identity:cancel" }]],
    },
  );
}

async function enqueueGeneration(ctx: BotContext, userId: number, state: IdentitySession): Promise<void> {
  if (!state.frontAssetId || !state.name) throw new Error("缺少正面图片或姓名");
  const identity = await createIdentityProfile(ctx.db, {
    userId,
    name: state.name,
    nickname: state.nickname ?? null,
    age: state.age ?? null,
    identityLabel: state.label ?? null,
    description: state.description ?? null,
    frontAssetId: state.frontAssetId,
    backAssetId: state.backAssetId,
    backgroundAssetId: state.backgroundAssetId ?? null,
    templateStyle: state.style,
    galleryPublished: state.galleryPublished,
    galleryPublishedAt: null,
    cardAssetId: null,
  });
  const createdAt = new Date().toISOString();
  const result = await ctx.db
    .prepare(`INSERT INTO identity_card_jobs (identity_profile_id, chat_id, user_id, created_at) VALUES (?, ?, ?, ?)`)
    .bind(identity.id, state.chatId, userId, createdAt)
    .run();
  const jobId = result.meta?.last_row_id;
  if (typeof jobId !== "number") throw new Error("资料卡生成任务创建失败");
  await ctx.exportQueue.send({ kind: "identity_card", jobId });
}

export async function handleIdentityCardCallback(
  ctx: BotContext,
  callback: TelegramCallbackQuery,
  userId: number,
): Promise<boolean> {
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
  if (data === "identity:cancel") {
    await clearIdentityCardInteractionState(ctx, userId, chatId);
    await sendMessage(ctx.botToken, chatId, "已取消资料卡制作。\n\n你可以从主菜单重新开始。", {
      inline_keyboard: [[{ text: "返回主菜单", callback_data: "home:menu" }]],
    });
    await answerCallbackQuery(ctx.botToken, callback.id);
    return true;
  }
  if (data.startsWith("identity:style:")) {
    const style = data.slice("identity:style:".length);
    const customMatch = /^custom:(\d+)$/.exec(style);
    if (customMatch) {
      const cardTemplate = await getCardTemplateById(ctx.db, Number(customMatch[1]));
      if (!cardTemplate?.enabled) return false;
    } else if (!isIdentityCardTemplateId(style)) return false;
    state.style = style;
    state.step = "front";
    await screen(ctx, state, userId, prompt("front", "✅ 已选择卡片版式。\n\n正面图片（必填）\n请上传一张图片："), {
      inline_keyboard: [[{ text: "取消", callback_data: "identity:cancel" }]],
    });
    await answerCallbackQuery(ctx.botToken, callback.id);
    return true;
  }
  if (data === "identity:skip_back" && state.step === "back") {
    state.step = "name";
    await screen(
      ctx,
      state,
      userId,
      prompt("name", "✅ 已跳过背面图片。\n\n姓名（必填）\n请输入卡片上的姓名或称呼："),
      {
        inline_keyboard: [[{ text: "取消", callback_data: "identity:cancel" }]],
      },
    );
    await answerCallbackQuery(ctx.botToken, callback.id);
    return true;
  }
  if (data === "identity:background_upload" && state.step === "background") {
    await screen(ctx, state, userId, prompt("background", "📤 请上传一张作为资料卡背景的图片。"), {
      inline_keyboard: [
        [
          { text: "使用样式默认背景", callback_data: "identity:skip:background" },
          { text: "取消", callback_data: "identity:cancel" },
        ],
      ],
    });
    await answerCallbackQuery(ctx.botToken, callback.id);
    return true;
  }
  if (data === "identity:background_front" && state.step === "background" && state.frontAssetId) {
    state.backgroundAssetId = state.frontAssetId;
    state.step = "gallery";
    await screen(ctx, state, userId, galleryPrompt(state), galleryKeyboard());
    await answerCallbackQuery(ctx.botToken, callback.id);
    return true;
  }
  if (data === "identity:gallery:yes" || data === "identity:gallery:no") {
    if (state.step !== "gallery") return false;
    state.galleryPublished = data === "identity:gallery:yes";
    state.step = "confirm";
    await screen(
      ctx,
      state,
      userId,
      prompt(
        "confirm",
        `✅ 已选择${state.galleryPublished ? "发布到画廊" : "仅自己可见"}。\n\n${confirmSummary(state)}`,
      ),
      confirmKeyboard(),
    );
    await answerCallbackQuery(ctx.botToken, callback.id);
    return true;
  }
  if (data.startsWith("identity:skip:")) {
    const step = data.slice("identity:skip:".length) as IdentityStep;
    if (step !== state.step || !["nickname", "age", "label", "description", "background"].includes(step)) return false;
    if (step === "nickname") {
      state.step = "age";
      await screen(
        ctx,
        state,
        userId,
        prompt("age", "✅ 已跳过昵称。\n\n年龄（可选）\n请输入 0-150 的整数，或点击跳过："),
        optionalKeyboard("age"),
      );
    } else if (step === "age") {
      state.step = "label";
      await screen(
        ctx,
        state,
        userId,
        prompt("label", "✅ 已跳过年龄。\n\n身份标签（可选）\n请输入身份标签，或点击跳过："),
        optionalKeyboard("label"),
      );
    } else if (step === "label") {
      state.step = "description";
      await screen(
        ctx,
        state,
        userId,
        prompt("description", "✅ 已跳过身份标签。\n\n简介（可选）\n请输入简介，或点击跳过："),
        optionalKeyboard("description"),
      );
    } else if (step === "description") {
      await advanceAfterDescription(ctx, state, userId, "已跳过简介。");
    } else if (step === "background") {
      state.step = "gallery";
      await screen(ctx, state, userId, galleryPrompt(state), galleryKeyboard());
    }
    await answerCallbackQuery(ctx.botToken, callback.id);
    return true;
  }
  if (data === "identity:confirm" && state.step === "confirm") {
    if (!ctx.adminIds.includes(callback.from.id)) {
      const accessSetting = await getIdentityCardAccessSetting(ctx.db);
      if (!accessSetting || !(await hasIdentityCardAccess(ctx.db, userId))) {
        await clearIdentityCardInteractionState(ctx, userId, chatId);
        await sendMessage(ctx.botToken, chatId, "🔐 图片生成功能密码已更换或已关闭。请重新解锁后再制作资料卡。", {
          inline_keyboard: [[{ text: "重新解锁", callback_data: "identity:list" }]],
        });
        await answerCallbackQuery(ctx.botToken, callback.id);
        return true;
      }
    }
    await screen(
      ctx,
      state,
      userId,
      "🎨 已提交资料卡生成任务。\n\n正在通过网页报告渲染管线生成 PNG，完成后会直接发送给你。你可以继续使用机器人。",
      {
        inline_keyboard: [[{ text: "返回主菜单", callback_data: "home:menu" }]],
      },
    );
    try {
      await enqueueGeneration(ctx, userId, state);
      await clearIdentityCardInteractionState(ctx, userId, chatId);
    } catch (error) {
      await screen(ctx, state, userId, `生成任务创建失败：${error instanceof Error ? error.message : "未知错误"}`, {
        inline_keyboard: [[{ text: "取消", callback_data: "identity:cancel" }]],
      });
    }
    await answerCallbackQuery(ctx.botToken, callback.id);
    return true;
  }
  return false;
}

export async function handleIdentityCardMessage(
  ctx: BotContext,
  message: TelegramMessage,
  userId: number,
): Promise<boolean> {
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
      await screen(
        ctx,
        state,
        userId,
        prompt("name", "✅ 已跳过背面图片。\n\n姓名（必填）\n请输入卡片上的姓名或称呼："),
        {
          inline_keyboard: [[{ text: "取消", callback_data: "identity:cancel" }]],
        },
      );
      return true;
    }
    if (!message.photo) {
      await screen(
        ctx,
        state,
        userId,
        prompt(state.step, "⚠️ 当前需要一张图片，请直接发送图片。"),
        state.step === "back"
          ? {
              inline_keyboard: [
                [
                  { text: "跳过背面", callback_data: "identity:skip_back" },
                  { text: "取消", callback_data: "identity:cancel" },
                ],
              ],
            }
          : { inline_keyboard: [[{ text: "取消", callback_data: "identity:cancel" }]] },
      );
      return true;
    }
    const assetId = await registerMediaAsset(ctx, message, { scope: "identity_card" });
    if (!assetId) {
      await screen(
        ctx,
        state,
        userId,
        prompt(state.step, "⚠️ 图片接收失败，请重新发送图片。"),
        state.step === "back"
          ? {
              inline_keyboard: [
                [
                  { text: "跳过背面", callback_data: "identity:skip_back" },
                  { text: "取消", callback_data: "identity:cancel" },
                ],
              ],
            }
          : { inline_keyboard: [[{ text: "取消", callback_data: "identity:cancel" }]] },
      );
      return true;
    }
    if (state.step === "front") {
      state.frontAssetId = assetId;
      state.step = "back";
      await screen(
        ctx,
        state,
        userId,
        prompt("back", "✅ 已收到正面图片。\n\n背面图片（可选）\n可以再上传一张图片，也可以点击跳过："),
        {
          inline_keyboard: [
            [
              { text: "跳过背面", callback_data: "identity:skip_back" },
              { text: "取消", callback_data: "identity:cancel" },
            ],
          ],
        },
      );
    } else {
      state.backAssetId = assetId;
      state.step = "name";
      await screen(
        ctx,
        state,
        userId,
        prompt("name", "✅ 已收到背面图片。\n\n姓名（必填）\n请输入卡片上的姓名或称呼："),
        {
          inline_keyboard: [[{ text: "取消", callback_data: "identity:cancel" }]],
        },
      );
    }
    return true;
  }
  if (state.step === "background") {
    if (!message.photo) {
      await screen(
        ctx,
        state,
        userId,
        prompt("background", "请上传一张图片作为资料卡背景，或点击“使用样式默认背景”。"),
        optionalKeyboard("background"),
      );
      return true;
    }
    const assetId = await registerMediaAsset(ctx, message, { scope: "identity_card" });
    if (!assetId) {
      await screen(
        ctx,
        state,
        userId,
        prompt("background", "⚠️ 背景图片接收失败，请重新上传。"),
        optionalKeyboard("background"),
      );
      return true;
    }
    state.backgroundAssetId = assetId;
    state.step = "gallery";
    await screen(ctx, state, userId, galleryPrompt(state), galleryKeyboard());
    return true;
  }
  if (!text) {
    const retryMarkup =
      state.step === "name"
        ? { inline_keyboard: [[{ text: "取消", callback_data: "identity:cancel" }]] }
        : optionalKeyboard(state.step as Exclude<IdentityStep, "front" | "back" | "name" | "gallery" | "confirm">);
    await screen(
      ctx,
      state,
      userId,
      prompt(
        state.step,
        state.step === "name" ? "⚠️ 当前需要姓名，请发送文字。" : "⚠️ 当前需要文字内容，请发送文字或使用“跳过此项”。",
      ),
      retryMarkup,
    );
    return true;
  }
  if (state.step === "name") {
    state.name = text.slice(0, 80);
    state.step = "nickname";
    await screen(
      ctx,
      state,
      userId,
      prompt("nickname", "✅ 已收到姓名。\n\n昵称（可选）\n请输入昵称，或点击跳过："),
      optionalKeyboard("nickname"),
    );
    return true;
  }
  if (state.step === "nickname") {
    if (!skipped(text)) state.nickname = text.slice(0, 80);
    state.step = "age";
    await screen(
      ctx,
      state,
      userId,
      prompt(
        "age",
        skipped(text)
          ? "✅ 已跳过昵称。\n\n年龄（可选）\n请输入 0-150 的整数，或点击跳过："
          : "✅ 已收到昵称。\n\n年龄（可选）\n请输入 0-150 的整数，或点击跳过:",
      ),
      optionalKeyboard("age"),
    );
    return true;
  }
  if (state.step === "age") {
    if (!skipped(text)) {
      const age = Number(text);
      if (!Number.isInteger(age) || age < 0 || age > 150) {
        await screen(
          ctx,
          state,
          userId,
          prompt("age", "⚠️ 年龄需要是 0-150 的整数；也可以点击“跳过此项”。"),
          optionalKeyboard("age"),
        );
        return true;
      }
      state.age = age;
    }
    state.step = "label";
    await screen(
      ctx,
      state,
      userId,
      prompt(
        "label",
        skipped(text)
          ? "✅ 已跳过年龄。\n\n身份标签（可选）\n请输入身份标签，或点击跳过："
          : "✅ 已收到年龄。\n\n身份标签（可选）\n请输入身份标签，或点击跳过：",
      ),
      optionalKeyboard("label"),
    );
    return true;
  }
  if (state.step === "label") {
    if (!skipped(text)) state.label = text.slice(0, 80);
    state.step = "description";
    await screen(
      ctx,
      state,
      userId,
      prompt(
        "description",
        skipped(text)
          ? "✅ 已跳过身份标签。\n\n简介（可选）\n请输入简介，或点击跳过："
          : "✅ 已收到身份标签。\n\n简介（可选）\n请输入简介，或点击跳过：",
      ),
      optionalKeyboard("description"),
    );
    return true;
  }
  if (state.step === "description") {
    if (!skipped(text)) state.description = text.slice(0, 500);
    await advanceAfterDescription(ctx, state, userId, skipped(text) ? "已跳过简介。" : "已收到简介。");
    return true;
  }
  return true;
}
