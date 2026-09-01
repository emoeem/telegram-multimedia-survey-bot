import { answerCallbackQuery, sendMessage, sendPhoto, type InlineKeyboardMarkup } from "./telegram";
import { renderScreen } from "./ui-message-controller";
import type { BotContext, TelegramCallbackQuery, TelegramMessage } from "./types";
import {
  getIdentityProfileOwners,
  listIdentityProfiles,
  type IdentityCardOwner,
  type IdentityProfileRecord,
} from "../db/repositories/identity-card.repository";
import { createPlazaPost, listPlazaPosts, type PlazaPostRecord } from "../db/repositories/plaza-post.repository";
import { checkRateLimit } from "../services/rate-limit.service";
import { clearUiSession, getUiSession, replaceUiScreen, setUiMessage } from "../services/ui-session.service";
import { renderIdentityCardReportPng } from "../services/identity-card-report.service";

/**
 * 广场 (plaza): the public self-expression corner of the bot. Two feeds share
 * one entry — published identity cards ("资料卡") and text posts ("树洞").
 */

const PAGE_SIZE = 1;
const composeKey = (userId: number) => `plaza-compose:${userId}`;

interface PlazaComposeSession {
  chatId: number;
  messageId?: number;
  step: "content" | "attribution";
  content: string;
}

async function getCompose(ctx: BotContext, userId: number): Promise<PlazaComposeSession | null> {
  const raw = await ctx.cache?.get(composeKey(userId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PlazaComposeSession;
  } catch {
    return null;
  }
}

async function putCompose(ctx: BotContext, userId: number, state: PlazaComposeSession): Promise<void> {
  if (!ctx.cache) throw new Error("当前部署未启用树洞投稿会话");
  await ctx.cache.put(composeKey(userId), JSON.stringify(state), { expirationTtl: 30 * 60 });
}

async function clearCompose(ctx: BotContext, userId: number): Promise<void> {
  await ctx.cache?.delete(composeKey(userId));
}

async function screen(
  ctx: BotContext,
  userId: number,
  chatId: number,
  screenId: string,
  text: string,
  replyMarkup?: InlineKeyboardMarkup,
  messageId?: number,
): Promise<void> {
  const result = await renderScreen({
    botToken: ctx.botToken,
    chatId,
    userId,
    screen: screenId,
    text,
    ...(replyMarkup ? { replyMarkup } : {}),
    ...(messageId === undefined ? {} : { messageId }),
  });
  if (ctx.ui) {
    await replaceUiScreen(ctx.ui, userId, chatId, screenId, {}).catch(() => undefined);
    await setUiMessage(ctx.ui, userId, chatId, result.messageId).catch(() => undefined);
  }
}

function homeRow(): InlineKeyboardMarkup["inline_keyboard"] {
  return [[{ text: "🏠 主菜单", callback_data: "home:menu" }]];
}

export function plazaOverviewText(cardTotal: number, postTotal: number): string {
  return [
    "🏛 广场",
    "",
    "在这里展示自己，也可以说说心里话：",
    "🖼 资料卡 — 用户主动发布的身份卡",
    "🌳 树洞 — 匿名或署名的心里话",
    "",
    `当前共有资料卡 ${cardTotal} 张 · 树洞 ${postTotal} 条`,
  ].join("\n");
}

function overviewKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "🖼 看资料卡", callback_data: "plaza:cards:0" },
        { text: "🌳 看树洞", callback_data: "plaza:treehole:0" },
      ],
      [{ text: "✏️ 投稿树洞", callback_data: "plaza:post" }],
      ...homeRow(),
    ],
  };
}

function feedNav(kind: "treehole" | "cards", page: number, total: number): InlineKeyboardMarkup["inline_keyboard"] {
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [];
  const nav: Array<{ text: string; callback_data: string }> = [];
  if (page > 0) nav.push({ text: "⬅️ 上一页", callback_data: `plaza:${kind}:${page - 1}` });
  if (page + PAGE_SIZE < total) nav.push({ text: "下一页 ➡️", callback_data: `plaza:${kind}:${page + 1}` });
  if (nav.length > 0) rows.push(nav);
  return rows;
}

function ownerLabel(owner: IdentityCardOwner | PlazaPostRecord["owner"] | null | undefined): string {
  if (!owner) return "匿名";
  return owner.username ? `@${owner.username}` : owner.firstName || `用户 ${owner.telegramUserId}`;
}

function formatDay(iso: string): string {
  return iso.slice(0, 10);
}

async function showOverview(ctx: BotContext, userId: number, chatId: number, messageId?: number): Promise<void> {
  const [cards, posts] = await Promise.all([
    listIdentityProfiles(ctx.db, { limit: 1, offset: 0, view: "published" }),
    listPlazaPosts(ctx.db, { limit: 1, offset: 0, view: "published" }),
  ]);
  await screen(
    ctx,
    userId,
    chatId,
    "plaza_overview",
    plazaOverviewText(cards.total, posts.total),
    overviewKeyboard(),
    messageId,
  );
}

async function showTreeholePost(
  ctx: BotContext,
  userId: number,
  chatId: number,
  page: number,
  messageId?: number,
): Promise<void> {
  const { items, total } = await listPlazaPosts(ctx.db, {
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
    view: "published",
  });
  if (total === 0) {
    await screen(
      ctx,
      userId,
      chatId,
      "plaza_treehole_empty",
      "🌳 树洞还没有内容。\n\n点击下方按钮，说出你的第一句心里话（可以匿名）。",
      { inline_keyboard: [[{ text: "✏️ 投稿树洞", callback_data: "plaza:post" }], ...homeRow()] },
      messageId,
    );
    return;
  }
  const post = items[0];
  if (!post) {
    await answerOutOfBounds(ctx, chatId);
    return;
  }
  const author = post.anonymous ? "匿名" : ownerLabel(post.owner);
  const text = [
    `🌳 树洞 ${page + 1}/${total}`,
    "",
    post.content,
    "",
    `—— ${author} · ${formatDay(post.createdAt)}`,
  ].join("\n");
  const keyboard = feedNav("treehole", page, total);
  keyboard.push([{ text: "✏️ 投稿树洞", callback_data: "plaza:post" }]);
  keyboard.push([{ text: "⬅️ 返回广场", callback_data: "plaza:list" }]);
  await screen(ctx, userId, chatId, "plaza_treehole", text, { inline_keyboard: keyboard }, messageId);
}

async function answerOutOfBounds(ctx: BotContext, chatId: number): Promise<void> {
  await sendMessage(ctx.botToken, chatId, "已经到最后一条了。");
}

async function showCardPage(ctx: BotContext, userId: number, chatId: number, page: number): Promise<void> {
  const { items, total } = await listIdentityProfiles(ctx.db, {
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
    view: "published",
  });
  if (total === 0) {
    await screen(
      ctx,
      userId,
      chatId,
      "plaza_cards_empty",
      "🖼 资料卡画廊还没有内容。\n\n制作一张资料卡并选择「发布到画廊」，它就会出现在这里供大家浏览。",
      { inline_keyboard: [[{ text: "🪪 制作资料卡", callback_data: "identity:list" }], ...homeRow()] },
    );
    return;
  }
  const card = items[0];
  if (!card) {
    await answerOutOfBounds(ctx, chatId);
    return;
  }
  const png = await cardPhotoBytes(ctx, card);
  if (!png) {
    await sendMessage(ctx.botToken, chatId, "🖼 这张资料卡暂时无法展示，请翻看下一页。");
    return;
  }
  const owners = await getIdentityProfileOwners(ctx.db, [card.userId]);
  const author = ownerLabel(owners.get(card.userId));
  const caption = [
    `🖼 资料卡画廊 ${page + 1}/${total}`,
    `${card.name}${card.identityLabel ? ` · ${card.identityLabel}` : ""}`,
    `by ${author}`,
  ].join("\n");
  const keyboard = feedNav("cards", page, total);
  keyboard.push([{ text: "⬅️ 返回广场", callback_data: "plaza:list" }]);
  await sendPhoto(ctx.botToken, chatId, png, caption, { inline_keyboard: keyboard });
}

async function cardPhotoBytes(ctx: BotContext, card: IdentityProfileRecord): Promise<Uint8Array | null> {
  if (card.cardAssetId && ctx.mediaKv) {
    const asset = await ctx.db
      .prepare("SELECT storage_key FROM media_assets WHERE id = ? AND storage_kind = 'temporary' LIMIT 1")
      .bind(card.cardAssetId)
      .first<{ storage_key: string | null }>();
    if (asset?.storage_key) {
      const { KVMediaStore } = await import("../services/media/temporary-media-store");
      const bytes = await new KVMediaStore(ctx.mediaKv).get(asset.storage_key);
      if (bytes) return bytes;
    }
  }
  if (!ctx.browser) return null;
  return renderIdentityCardReportPng({ DB: ctx.db, BOT_TOKEN: ctx.botToken, BROWSER: ctx.browser }, card);
}

async function startCompose(ctx: BotContext, userId: number, chatId: number, messageId?: number): Promise<void> {
  await putCompose(ctx, userId, { chatId, step: "content", content: "" });
  await screen(
    ctx,
    userId,
    chatId,
    "plaza_compose_content",
    "✏️ 投稿树洞\n\n写下你想说的话（5-500 字），发送给我：\n\n发布后可以选择匿名或署名；管理员可以下架违规内容。",
    { inline_keyboard: [[{ text: "取消", callback_data: "plaza:cancel" }]] },
    messageId,
  );
}

export async function handlePlazaCallback(
  ctx: BotContext,
  callback: TelegramCallbackQuery,
  userId: number,
): Promise<boolean> {
  const data = callback.data;
  const chatId = callback.message?.chat.id;
  if (!data || !chatId) return false;
  if (
    data !== "plaza:list" &&
    !data.startsWith("plaza:") &&
    data !== "gallery:list" &&
    !data.startsWith("gallery:page:")
  ) {
    return false;
  }

  // Legacy cached menus may still carry "gallery:" buttons from before the
  // plaza rename; route them to the card feed so nothing dead-ends.
  let route = data;
  if (route === "gallery:list") route = "plaza:cards:0";
  const legacyPage = route.match(/^gallery:page:(\d+)$/);
  if (legacyPage) route = `plaza:cards:${legacyPage[1]}`;

  if (route === "plaza:list") {
    await showOverview(ctx, userId, chatId, callback.message?.message_id);
    await answerCallbackQuery(ctx.botToken, callback.id);
    return true;
  }
  const feedMatch = route.match(/^plaza:(treehole|cards):(\d+)$/);
  if (feedMatch) {
    const page = Number(feedMatch[2]);
    if (!Number.isInteger(page) || page < 0) {
      await answerCallbackQuery(ctx.botToken, callback.id);
      return true;
    }
    if (feedMatch[1] === "treehole") {
      await showTreeholePost(ctx, userId, chatId, page, callback.message?.message_id);
    } else {
      await showCardPage(ctx, userId, chatId, page);
    }
    await answerCallbackQuery(ctx.botToken, callback.id);
    return true;
  }
  if (route === "plaza:post") {
    await startCompose(ctx, userId, chatId, callback.message?.message_id);
    await answerCallbackQuery(ctx.botToken, callback.id);
    return true;
  }
  const compose = await getCompose(ctx, userId);
  if (!compose) return false;
  if (route === "plaza:cancel") {
    await clearCompose(ctx, userId);
    await sendMessage(ctx.botToken, chatId, "已取消树洞投稿。", {
      inline_keyboard: [[{ text: "⬅️ 返回广场", callback_data: "plaza:list" }]],
    });
    await answerCallbackQuery(ctx.botToken, callback.id);
    return true;
  }
  if (route === "plaza:anon" || route === "plaza:named") {
    if (compose.step !== "attribution") return false;
    if (!ctx.cache) {
      await answerCallbackQuery(ctx.botToken, callback.id, "功能暂时不可用");
      return true;
    }
    const anonymous = route === "plaza:anon";
    const limit = await checkRateLimit(ctx.cache, "plaza-post", String(userId), 5, 3600);
    if (!limit.allowed) {
      await sendMessage(
        ctx.botToken,
        chatId,
        `发言太频繁啦，请 ${Math.ceil(limit.retryAfterSeconds / 60)} 分钟后再来投稿。`,
      );
      await answerCallbackQuery(ctx.botToken, callback.id);
      return true;
    }
    await createPlazaPost(ctx.db, { userId, content: compose.content, anonymous });
    await clearCompose(ctx, userId);
    await screen(
      ctx,
      userId,
      chatId,
      "plaza_compose_done",
      `✅ 已发布到树洞广场（${anonymous ? "匿名" : `署名 ${ownerLabel({ telegramUserId: callback.from.id, username: callback.from.username ?? null, firstName: callback.from.first_name ?? null })}`}）。\n\n感谢你的分享。`,
      { inline_keyboard: [[{ text: "🌳 看看树洞", callback_data: "plaza:treehole:0" }], ...homeRow()] },
    );
    await answerCallbackQuery(ctx.botToken, callback.id);
    return true;
  }
  return false;
}

export async function handlePlazaMessage(ctx: BotContext, message: TelegramMessage, userId: number): Promise<boolean> {
  const compose = await getCompose(ctx, userId);
  if (!compose || message.chat.id !== compose.chatId) return false;
  const text = message.text?.trim();
  if (!text) {
    await screen(ctx, userId, message.chat.id, "plaza_compose_content", "⚠️ 树洞只收文字，请直接发送文字内容。", {
      inline_keyboard: [[{ text: "取消", callback_data: "plaza:cancel" }]],
    });
    return true;
  }
  if (compose.step === "content") {
    if (text.length < 5 || text.length > 500) {
      await screen(
        ctx,
        userId,
        message.chat.id,
        "plaza_compose_content",
        `⚠️ 内容需要 5-500 个字，当前 ${text.length} 个字。请重新发送。`,
        {
          inline_keyboard: [[{ text: "取消", callback_data: "plaza:cancel" }]],
        },
      );
      return true;
    }
    await putCompose(ctx, userId, { ...compose, step: "attribution", content: text });
    await screen(ctx, userId, message.chat.id, "plaza_compose_attribution", "✅ 已收到内容。\n\n选择署名方式：", {
      inline_keyboard: [
        [
          { text: "👤 署名发布", callback_data: "plaza:named" },
          { text: "🎭 匿名发布", callback_data: "plaza:anon" },
        ],
        [{ text: "取消", callback_data: "plaza:cancel" }],
      ],
    });
    return true;
  }
  return true;
}

export { clearPlazaInteractionState };
async function clearPlazaInteractionState(ctx: BotContext, userId: number, chatId: number): Promise<void> {
  await clearCompose(ctx, userId);
  if (ctx.ui) {
    await clearUiSession(ctx.ui, userId, chatId).catch(() => undefined);
  }
}
