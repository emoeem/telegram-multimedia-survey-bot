import type { Env } from "../env";
import { parseAdminIds } from "../core/admin-ids";
import { isLicenseCenter } from "../services/deployment-role.service";
import { getWebhookInfo, setWebhook, syncBotCommands } from "./telegram";

const commandMenuCacheKey = "telegram-command-menu:v2";
const webhookConfigCacheKey = "telegram-webhook-config:v2";

export async function ensureTelegramCommandMenu(env: Env): Promise<void> {
  try {
    if (await env.CACHE.get(commandMenuCacheKey)) return;
    await syncBotCommands(env.BOT_TOKEN, {
      adminIds: parseAdminIds(env.ADMIN_IDS),
      vendor: isLicenseCenter(env),
    });
    await env.CACHE.put(commandMenuCacheKey, "synced", { expirationTtl: 24 * 3600 });
  } catch (error) {
    console.warn("Telegram command menu sync failed", error);
  }
}

/**
 * channel_post updates are required for automatic report-channel detection.
 * Self-heals the webhook allowed_updates whenever a request reaches the bot.
 */
export async function ensureWebhookAllowsChannelPosts(env: Env, origin: string): Promise<void> {
  try {
    if (await env.CACHE.get(webhookConfigCacheKey)) return;
    const info = await getWebhookInfo(env.BOT_TOKEN);
    const updates = info.allowed_updates ?? [];
    if (info.url === `${origin}/telegram/webhook` && updates.includes("channel_post")) {
      await env.CACHE.put(webhookConfigCacheKey, "ok", { expirationTtl: 7 * 24 * 60 * 60 });
      return;
    }
    await setWebhook(env.BOT_TOKEN, `${origin}/telegram/webhook`, env.WEBHOOK_SECRET);
    await env.CACHE.put(webhookConfigCacheKey, "ok", { expirationTtl: 7 * 24 * 60 * 60 });
    console.info("Telegram webhook updated to include channel_post updates");
  } catch (error) {
    console.warn("Telegram webhook self-heal failed", error);
  }
}
