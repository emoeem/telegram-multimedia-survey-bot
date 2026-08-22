import { getBotId, getChatMember, sendMessage } from "./telegram";
import type { BotContext, TelegramMessage } from "./types";
import { REPORT_CHANNEL_CACHE_KEY } from "../services/report-delivery.service";

/** Global one-shot request: value is the requesting user's id. */
export const REPORT_CHANNEL_DETECT_REQUEST_KEY = "report-channel-detect-request";

/**
 * The report archive channel must be managed by the bot itself. This is the
 * single permission gate for channel setup — it replaces ADMIN_IDS membership
 * checks, so the flow works even when the bot's admin list is stale.
 */
export async function botCanManageChannel(
  botToken: string,
  chatId: number,
): Promise<boolean> {
  try {
    const botId = await getBotId(botToken);
    const member = await getChatMember(botToken, chatId, botId);
    return member.status === "administrator" || member.status === "creator";
  } catch {
    return false;
  }
}

/**
 * Consumes a channel_post update. If an admin previously ran /detect_channel,
 * the posted channel is verified (bot must still be its administrator) and
 * cached as the report archive channel, then the requesting admin is notified
 * in private chat. Non-admin channels and stale posts are ignored.
 */
export async function maybeDetectReportChannel(
  ctx: BotContext,
  post: TelegramMessage,
): Promise<void> {
  if (!ctx.cache) return;
  if (post.chat?.type !== "channel") return;

  const request = await ctx.cache.get(REPORT_CHANNEL_DETECT_REQUEST_KEY);
  if (!request) return;
  const requesterId = Number(request);
  try {
    if (!Number.isInteger(requesterId) ||
        !(await botCanManageChannel(ctx.botToken, post.chat.id))) {
      if (Number.isInteger(requesterId)) {
        await sendMessage(
          ctx.botToken,
          requesterId,
          "⚠️ 频道检测失败：Bot 不是该频道的管理员，请先在频道里把 Bot 添加为管理员。",
        );
      }
    } else {
      await ctx.cache.put(REPORT_CHANNEL_CACHE_KEY, String(post.chat.id));
      await sendMessage(
        ctx.botToken,
        requesterId,
        [
          "✅ 已识别报告归档频道",
          `频道：${post.chat.title ?? String(post.chat.id)}`,
          `Chat ID：${post.chat.id}`,
        ].join("\n"),
      );
    }
  } catch (error) {
    console.error("Report channel detection failed", { requesterId, error });
  } finally {
    await ctx.cache.delete(REPORT_CHANNEL_DETECT_REQUEST_KEY);
  }
}
