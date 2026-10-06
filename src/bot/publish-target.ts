import { getUserByTelegramId } from "../db/repositories/user.repository";
import { upsertPublicationTargetForChat } from "../db/repositories/publication-target.repository";
import { canCreateSurvey, isAdmin } from "../services/permission.service";
import type { BotContext, TelegramMessage } from "./types";
import { replyMessage } from "./reply";

export const PUBLISH_TARGET_COMMAND_PATTERN = /^\/set_publish_target(?:@[A-Za-z0-9_]{3,64})?(?:\s|$)/;

/**
 * 「公开发布到 Telegram」的目标群组绑定。
 *
 * Telegram 会把群消息转发变成无来源的副本，所以像 /set_report_channel 那样
 * “转发一条频道消息给我”的识别方式对群组行不通。群组绑定只能由有权限的人在
 * 目标群组里直接发送本命令：机器人收到消息时自带 chat id，无需转发。
 * 频道场景不受影响，继续走 /set_report_channel 与 /detect_channel。
 *
 * 语义是**追加**：公开报告会同时发到所有启用中的目标群，本命令把当前群加入
 * 列表（同一个群/话题重复执行只更新那一行，不会产生重复目标），不会把别的群
 * 挤掉。停用或移除某个群请在后台「控制中心 → 发布目标」列表里操作。
 */
export async function maybeHandlePublishTargetCommand(ctx: BotContext, message: TelegramMessage): Promise<boolean> {
  if (!PUBLISH_TARGET_COMMAND_PATTERN.test(message.text ?? "")) return false;

  const chatType = message.chat.type;
  if (chatType === "group" || chatType === "supergroup") {
    await bindGroupPublishTarget(ctx, message);
    return true;
  }
  await replyMessage(
    ctx,
    message.chat.id,
    "请在「目标群组」里发送 /set_publish_target（私聊里无效）。\n" +
      "机器人会把这条命令所在的群组加入公开报告发布目标，\n" +
      "要求机器人在该群里能正常发言。",
  );
  return true;
}

async function bindGroupPublishTarget(ctx: BotContext, message: TelegramMessage): Promise<void> {
  const senderId = message.from?.id;
  if (!senderId) return;
  const chatId = message.chat.id;
  const name = message.chat.title?.trim() || String(chatId);
  // 论坛群里「General」话题可能被关闭：不带 message_thread_id 的发送会被
  // Telegram 以 TOPIC_CLOSED 拒绝。群内回复统一走 replyMessage，话题由
  // ctx.incoming 提供（见 router.ts / reply.ts）；threadId 另存进发布目标。
  const threadId = message.message_thread_id ?? null;

  const dbUser = await getUserByTelegramId(ctx.db, senderId);
  const allowed =
    isAdmin(senderId, ctx.adminIds) || (dbUser !== null && (await canCreateSurvey(ctx.db, dbUser, ctx.adminIds)));
  if (!allowed) {
    await replyMessage(ctx, chatId, "只有管理员或创作者可以设置公开发布目标。");
    return;
  }

  try {
    // 先试发一条：机器人发不出消息的群（被禁言/已退出）不能作为发布目标。
    await replyMessage(ctx, chatId, "⏳ 正在把本群加入公开报告发布目标…");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const hint = /TOPIC_CLOSED/.test(detail) ? "\n提示：当前话题已被关闭，请在未关闭的话题里重新发送本命令。" : "";
    await replyMessage(
      ctx,
      senderId,
      `⚠️ 无法在「${name}」里发消息，发布目标设置失败。\n请确认机器人仍在该群且未被禁言。\n错误：${detail}${hint}`,
    ).catch(() => undefined);
    return;
  }

  try {
    const { target, created, activeCount } = await upsertPublicationTargetForChat(ctx.db, {
      name,
      chatId: String(chatId),
      threadId,
    });
    await replyMessage(
      ctx,
      chatId,
      [
        created ? "✅ 本群已加入公开报告发布目标" : "✅ 本群已在公开报告发布目标中，已更新",
        `群组：${name}`,
        `Chat ID：${target?.chatId ?? chatId}${threadId ? `（话题 #${threadId}）` : ""}`,
        `当前共有 ${activeCount} 个目标会收到公开报告，报告以图片相册发到各自配置的话题。`,
        "停用或移除某个群：后台「控制中心 → 发布目标」列表。",
      ].join("\n"),
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await replyMessage(ctx, senderId, `⚠️ 群消息发送正常，但保存发布目标失败：${detail}`).catch(() => undefined);
  }
}
