import {
  answerCallbackQuery,
  editMessageText,
  sendMessage,
  sendPhoto,
  type InlineKeyboardMarkup,
} from "./telegram";
import type { BotContext, TelegramCallbackQuery } from "./types";
import {
  cardBadges,
  fetchGalleryCards,
  galleryCardCaption,
  galleryImageUrl,
  GALLERY_BADGE_LABEL,
  type GalleryCard,
} from "../services/media-cards-gallery.service";

const PAGE_SIZE = 6;

function badgeLine(card: GalleryCard): string {
  const labels = cardBadges(card)
    .map((key) => GALLERY_BADGE_LABEL[key])
    .filter(Boolean);
  return labels.length > 0 ? labels.map((label) => `【${label}】`).join("") : "";
}

function cardEntryLabel(card: GalleryCard): string {
  const title = typeof card.title === "string" && card.title ? card.title : "未命名";
  const date = typeof card.generated_at === "string" ? card.generated_at.slice(0, 10) : "";
  const badges = badgeLine(card);
  return `${title} · ${date}${badges ? ` ${badges}` : ""}`;
}

function buildGalleryKeyboard(
  cards: GalleryCard[],
  page: number,
  totalPages: number,
): InlineKeyboardMarkup {
  const start = page * PAGE_SIZE;
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [];
  for (let i = start; i < Math.min(start + PAGE_SIZE, cards.length); i += 1) {
    const card = cards[i];
    if (!card) continue;
    rows.push([{ text: cardEntryLabel(card), callback_data: `mediacard:view:${i}` }]);
  }
  const nav: InlineKeyboardMarkup["inline_keyboard"][number] = [];
  if (page > 0) nav.push({ text: "◀️ 上一页", callback_data: `mediacard:page:${page - 1}` });
  nav.push({ text: `${page + 1} / ${totalPages}`, callback_data: "mediacard:noop" });
  if (page < totalPages - 1) nav.push({ text: "下一页 ▶️", callback_data: `mediacard:page:${page + 1}` });
  rows.push(nav);
  rows.push([
    { text: "🌐 网页画廊", url: "https://emoeem.github.io/cards/" },
    { text: "🏠 主菜单", callback_data: "home:menu" },
  ]);
  return { inline_keyboard: rows };
}

async function showGalleryPage(
  ctx: BotContext,
  chatId: number,
  page: number,
  messageId?: number,
): Promise<void> {
  const cards = await fetchGalleryCards(ctx.cardsGalleryUrl);
  if (cards.length === 0) {
    const text = "📷 资料卡画廊\n\n还没有公开的资料卡。在 mpv 里按 CTRL+ALT+S 分享第一张吧。";
    const keyboard: InlineKeyboardMarkup = {
      inline_keyboard: [[{ text: "🏠 主菜单", callback_data: "home:menu" }]],
    };
    if (messageId !== undefined) {
      await editMessageText(ctx.botToken, chatId, messageId, text, keyboard);
    } else {
      await sendMessage(ctx.botToken, chatId, text, keyboard);
    }
    return;
  }

  const totalPages = Math.ceil(cards.length / PAGE_SIZE);
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const text = [
    "📷 资料卡画廊",
    "",
    `共 ${cards.length} 张公开卡片 · 第 ${safePage + 1}/${totalPages} 页`,
    "点击卡片查看大图与完整规格。",
  ].join("\n");
  const keyboard = buildGalleryKeyboard(cards, safePage, totalPages);
  if (messageId !== undefined) {
    await editMessageText(ctx.botToken, chatId, messageId, text, keyboard);
  } else {
    await sendMessage(ctx.botToken, chatId, text, keyboard);
  }
}

async function sendGalleryCard(
  ctx: BotContext,
  chatId: number,
  index: number,
  callbackId: string,
): Promise<void> {
  const cards = await fetchGalleryCards(ctx.cardsGalleryUrl);
  const card = cards[index];
  if (!card) {
    await answerCallbackQuery(ctx.botToken, callbackId, "画廊已更新，请重新打开画廊");
    await showGalleryPage(ctx, chatId, 0);
    return;
  }
  await sendPhoto(
    ctx.botToken,
    chatId,
    galleryImageUrl(card),
    galleryCardCaption(card),
  );
}

export async function handleMediaCardCallback(
  ctx: BotContext,
  callback: TelegramCallbackQuery,
): Promise<boolean> {
  const data = callback.data ?? "";
  if (!data.startsWith("mediacard:")) return false;

  const chatId = callback.message?.chat.id;
  if (!chatId) {
    await answerCallbackQuery(ctx.botToken, callback.id, "无法定位会话");
    return true;
  }

  try {
    if (data === "mediacard:gallery") {
      await showGalleryPage(ctx, chatId, 0, callback.message?.message_id);
      await answerCallbackQuery(ctx.botToken, callback.id);
      return true;
    }

    const pageMatch = data.match(/^mediacard:page:(\d+)$/);
    if (pageMatch) {
      await showGalleryPage(ctx, chatId, Number(pageMatch[1]), callback.message?.message_id);
      await answerCallbackQuery(ctx.botToken, callback.id);
      return true;
    }

    const viewMatch = data.match(/^mediacard:view:(\d+)$/);
    if (viewMatch) {
      await sendGalleryCard(ctx, chatId, Number(viewMatch[1]), callback.id);
      await answerCallbackQuery(ctx.botToken, callback.id);
      return true;
    }

    if (data === "mediacard:noop") {
      await answerCallbackQuery(ctx.botToken, callback.id);
      return true;
    }

    await answerCallbackQuery(ctx.botToken, callback.id, "未知操作");
  } catch (error) {
    console.error("Media card gallery handling failed", error);
    await answerCallbackQuery(ctx.botToken, callback.id, "画廊加载失败，请稍后再试");
  }
  return true;
}
