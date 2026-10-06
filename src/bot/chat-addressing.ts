import { getBotIdentity } from "./telegram";
import type { BotContext, TelegramMessage } from "./types";

/**
 * 群聊（含论坛群）里的机器人准入判断。
 *
 * 背景：机器人在群里只要能收到消息，handleTelegramMessage 的兜底分支就会把
 * **私聊主菜单**（含「网页管理后台」「管理员中心」按钮）渲染到当前会话。于是
 * 公开群里任何人随便说一句话，机器人都会把整套入口菜单贴进群里 —— 发布目标群
 * 「天地一家大爱盟」实测就是这个现象。
 *
 * 群聊里只承认三种「明确对机器人说话」的消息：
 *   1. 命令：/cmd 或 /cmd@本机器人（带 @ 时必须点名本机器人）
 *   2. @ 本机器人：mention / text_mention 实体
 *   3. 回复机器人自己的消息
 * 其余消息一律静默丢弃（连用户表都不写，见 router.ts）。命中的群消息也不会渲染
 * 任何菜单，只回一句提示（见 survey-handler.ts 的群聊早退分支）。
 *
 * 机器人身份取决于部署，所以 id/username 从 KV 缓存取，冷启动才调一次 getMe；
 * 判断不出来时保守处理：群里只认命令，@ 与回复一概视为「没跟机器人说话」。
 */

/** 与 survey-handler 的分享链接共用同一个键，避免两处各存一份用户名。 */
export const BOT_USERNAME_CACHE_KEY = "telegram-bot-username";
export const BOT_ID_CACHE_KEY = "telegram-bot-id";
const BOT_IDENTITY_TTL_SECONDS = 7 * 24 * 60 * 60;

/** `/cmd` 或 `/cmd@bot_username`（Telegram 在群里会把命令写成后者）。 */
const COMMAND_PATTERN = /^\/([A-Za-z0-9_]{1,64})(?:@([A-Za-z0-9_]{3,64}))?/;

export function isGroupChat(chatType: string | undefined): boolean {
  return chatType === "group" || chatType === "supergroup";
}

export interface BotIdentity {
  id?: number;
  username?: string;
}

// 一个 isolate 内复用；只有两个字段都解析出来才记住，避免把一次失败永久缓存。
let memoizedIdentity: { token: string; identity: { id: number; username: string } } | null = null;

export async function resolveBotIdentity(ctx: BotContext): Promise<BotIdentity> {
  if (memoizedIdentity?.token === ctx.botToken) return memoizedIdentity.identity;

  const identity: BotIdentity = {};
  try {
    const [rawId, rawUsername] = ctx.cache
      ? await Promise.all([ctx.cache.get(BOT_ID_CACHE_KEY), ctx.cache.get(BOT_USERNAME_CACHE_KEY)])
      : [null, null];
    const cachedId = Number(rawId);
    if (Number.isSafeInteger(cachedId) && cachedId > 0) identity.id = cachedId;
    if (typeof rawUsername === "string" && rawUsername.trim()) identity.username = rawUsername.trim();
  } catch (error) {
    console.warn("Bot identity cache read failed; falling back to getMe", error);
  }

  if (identity.id === undefined || identity.username === undefined) {
    try {
      const fresh = await getBotIdentity(ctx.botToken);
      if (identity.id === undefined && fresh.id !== undefined) {
        identity.id = fresh.id;
        await cacheIdentity(ctx, BOT_ID_CACHE_KEY, String(fresh.id));
      }
      if (identity.username === undefined && fresh.username) {
        identity.username = fresh.username;
        await cacheIdentity(ctx, BOT_USERNAME_CACHE_KEY, fresh.username);
      }
    } catch (error) {
      console.warn("Bot identity lookup failed; only explicit commands are accepted in groups", error);
    }
  }

  if (identity.id !== undefined && identity.username !== undefined) {
    memoizedIdentity = { token: ctx.botToken, identity: { id: identity.id, username: identity.username } };
  }
  return identity;
}

async function cacheIdentity(ctx: BotContext, key: string, value: string): Promise<void> {
  try {
    await ctx.cache?.put(key, value, { expirationTtl: BOT_IDENTITY_TTL_SECONDS });
  } catch (error) {
    console.warn("Bot identity cache write failed", { key, error });
  }
}

/**
 * 本条消息是否在跟机器人说话。私聊一律放行 —— 只有群里才需要点名。
 */
export async function isMessageAddressedToBot(ctx: BotContext, message: TelegramMessage): Promise<boolean> {
  if (!isGroupChat(message.chat.type)) return true;

  const text = message.text ?? "";
  const command = text.trim().match(COMMAND_PATTERN);
  if (command) {
    const target = command[2];
    if (!target) return true;
    const { username } = await resolveBotIdentity(ctx);
    return username !== undefined && target.toLowerCase() === username.toLowerCase();
  }

  // 既没有 @ 实体也不是在回复某条消息：普通闲聊，不必浪费一次身份解析。
  if (!hasMentionEntity(message) && !message.reply_to_message) return false;

  const identity = await resolveBotIdentity(ctx);

  for (const entity of message.entities ?? []) {
    if (entity.type === "text_mention" && identity.id !== undefined && entity.user?.id === identity.id) return true;
    if (entity.type === "mention" && identity.username !== undefined) {
      const mention = text.slice(entity.offset, entity.offset + entity.length).toLowerCase();
      if (mention === `@${identity.username.toLowerCase()}`) return true;
    }
  }

  const repliedTo = message.reply_to_message?.from;
  if (repliedTo) {
    if (identity.id !== undefined && repliedTo.id === identity.id) return true;
    if (identity.username !== undefined && repliedTo.username?.toLowerCase() === identity.username.toLowerCase()) {
      return true;
    }
  }
  return false;
}

function hasMentionEntity(message: TelegramMessage): boolean {
  return (message.entities ?? []).some((entity) => entity.type === "mention" || entity.type === "text_mention");
}

/** 群里被点名时的唯一回复：一句话说清群里能做什么 + 私聊入口。 */
export async function buildGroupUsageHint(ctx: BotContext): Promise<string> {
  const { username } = await resolveBotIdentity(ctx);
  return [
    "🤖 群里我只负责 /set_publish_target —— 把本群加入公开报告发布目标。",
    "",
    "填写问卷、查看结果、管理问卷请在私聊里进行：",
    username ? `https://t.me/${username}` : "请在 Telegram 里私聊本机器人。",
  ].join("\n");
}
