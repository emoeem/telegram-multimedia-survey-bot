import { sendMessage } from "../bot/telegram";

export interface PlazaNotifyEnvironment {
  DB: D1Database;
  BOT_TOKEN: string;
}

/**
 * Notifies a tree-hole post author by DM when somebody else comments on
 * their post. Failures are non-fatal: users who never started the bot (or
 * have blocked it) simply don't receive the message.
 */
export async function notifyPostAuthorOfComment(
  env: PlazaNotifyEnvironment,
  input: {
    postId: number;
    authorUserId: number;
    authorTelegramUserId: number;
    commenterTelegramUserId: number;
    commentContent: string;
    origin: string;
  },
): Promise<void> {
  if (input.authorTelegramUserId === input.commenterTelegramUserId) return;
  try {
    const snippet = input.commentContent.length > 120 ? `${input.commentContent.slice(0, 120)}…` : input.commentContent;
    await sendMessage(
      env.BOT_TOKEN,
      input.authorTelegramUserId,
      [
        `💬 你的树洞 #${input.postId} 收到一条新评论`,
        "",
        `「${snippet}」`,
        "",
        `${input.origin}/plaza?tab=treehole`,
      ].join("\n"),
    );
  } catch (error) {
    console.warn("Plaza comment DM failed", { postId: input.postId, error });
  }
}
