import {
  sendDocument,
  sendLongMessage,
  sendMessage,
  sendPhoto,
  sendPhotoAlbum,
  type InlineKeyboardMarkup,
} from "./telegram";
import { renderScreen, type RenderScreenInput, type UiMessageState } from "./ui-message-controller";
import type { BotContext } from "./types";

/**
 * 论坛群（话题群）回复的会话上下文。
 *
 * 不带 message_thread_id 的发送会落到 General 话题，而该话题被关闭时 Telegram
 * 直接返回 400 Bad Request: TOPIC_CLOSED —— 哪怕机器人权限完全正常。所以凡是
 * 「回复本条 update 所在会话」的发送都必须带回话题 id。
 *
 * handler 层一律使用本模块的 replyXxx，不要直接调用 ./telegram.ts 的发送函数；
 * 少传一个话题参数就会在这个群里静默失联。src/bot/reply.test.ts 里有对应的守卫
 * 测试（扫描 src/bot 下是否还存在直接发送）。
 */
export function replyThreadId(ctx: BotContext, chatId: number): number | undefined {
  return ctx.incoming?.chatId === chatId ? ctx.incoming.threadId : undefined;
}

/**
 * 只有发往本条 update 所在会话才带话题。把消息发到别的会话（例如把失败原因
 * 私聊给操作者、或按 chat id 给另一个群发通知）时必须不带：Telegram 对不存在
 * 于该会话的 message_thread_id 会回 message thread not found。
 */
export function replyMessage(
  ctx: BotContext,
  chatId: number,
  text: string,
  replyMarkup?: InlineKeyboardMarkup,
): Promise<Response> {
  const threadId = replyThreadId(ctx, chatId);
  // 没有话题时保持与改动前完全一致的调用形状（参数个数与请求体都不变），
  // 把行为差异限制在论坛群内。
  return threadId === undefined
    ? sendMessage(ctx.botToken, chatId, text, replyMarkup)
    : sendMessage(ctx.botToken, chatId, text, replyMarkup, threadId);
}

export function replyLongMessage(
  ctx: BotContext,
  chatId: number,
  text: string,
  replyMarkup?: InlineKeyboardMarkup,
): Promise<void> {
  const threadId = replyThreadId(ctx, chatId);
  // 没有话题时保持与改动前完全一致的调用形状（参数个数与请求体都不变），
  // 把行为差异限制在论坛群内。
  return threadId === undefined
    ? sendLongMessage(ctx.botToken, chatId, text, replyMarkup)
    : sendLongMessage(ctx.botToken, chatId, text, replyMarkup, threadId);
}

export function replyPhoto(
  ctx: BotContext,
  chatId: number,
  photo: string | Uint8Array,
  caption?: string,
  replyMarkup?: InlineKeyboardMarkup,
): Promise<Response> {
  const threadId = replyThreadId(ctx, chatId);
  // 没有话题时保持与改动前完全一致的调用形状（参数个数与请求体都不变），
  // 把行为差异限制在论坛群内。
  return threadId === undefined
    ? sendPhoto(ctx.botToken, chatId, photo, caption, replyMarkup)
    : sendPhoto(ctx.botToken, chatId, photo, caption, replyMarkup, threadId);
}

export function replyPhotoAlbum(
  ctx: BotContext,
  chatId: number,
  photos: Array<{ bytes: Uint8Array; caption?: string }>,
): Promise<Response> {
  const threadId = replyThreadId(ctx, chatId);
  // 没有话题时保持与改动前完全一致的调用形状（参数个数与请求体都不变），
  // 把行为差异限制在论坛群内。
  return threadId === undefined
    ? sendPhotoAlbum(ctx.botToken, chatId, photos)
    : sendPhotoAlbum(ctx.botToken, chatId, photos, threadId);
}

export function replyDocument(
  ctx: BotContext,
  chatId: number,
  fileName: string,
  content: Uint8Array | string,
  contentType?: string,
  caption?: string,
  parseMode?: "Markdown" | "MarkdownV2" | "HTML",
): Promise<Response> {
  const threadId = replyThreadId(ctx, chatId);
  // 没有话题时保持与改动前完全一致的调用形状（参数个数与请求体都不变），
  // 把行为差异限制在论坛群内。
  return threadId === undefined
    ? sendDocument(ctx.botToken, chatId, fileName, content, contentType, caption, parseMode)
    : sendDocument(ctx.botToken, chatId, fileName, content, contentType, caption, parseMode, threadId);
}

/** renderScreen 的会话感知版本：发送新消息时（编辑分支不需要）带上话题。 */
export function replyScreen(
  ctx: BotContext,
  input: Omit<RenderScreenInput, "botToken" | "messageThreadId">,
): Promise<UiMessageState> {
  const threadId = replyThreadId(ctx, input.chatId);
  return renderScreen({
    ...input,
    botToken: ctx.botToken,
    ...(threadId !== undefined ? { messageThreadId: threadId } : {}),
  });
}
