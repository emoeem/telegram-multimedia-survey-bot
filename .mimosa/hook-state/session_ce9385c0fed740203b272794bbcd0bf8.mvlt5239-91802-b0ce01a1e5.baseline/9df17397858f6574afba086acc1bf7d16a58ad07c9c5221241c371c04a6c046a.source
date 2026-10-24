import { sendMessage } from "../bot/telegram";
import { loadSystemSettings } from "./system-settings.service";

/** Mirrors published plaza tree-hole posts to a Telegram channel. */
export interface PlazaChannelEnvironment {
  DB: D1Database;
  BOT_TOKEN: string;
  PLAZA_CHANNEL_ID?: string;
}

export async function resolvePlazaChannelId(env: PlazaChannelEnvironment): Promise<number | null> {
  const settings = await loadSystemSettings(env.DB).catch(() => null);
  const raw = (settings?.plazaChannelId || env.PLAZA_CHANNEL_ID || "").trim();
  const id = Number(raw);
  return Number.isInteger(id) && id !== 0 ? id : null;
}

/** Forwards a new tree-hole post to the channel. */
export async function mirrorPlazaPostToChannel(
  env: PlazaChannelEnvironment,
  content: string,
  authorLabel: string | null,
): Promise<void> {
  try {
    const channelId = await resolvePlazaChannelId(env);
    if (channelId === null) return;
    const header = authorLabel ? `🌳 树洞 · ${authorLabel}` : "🌳 树洞新投稿";
    await sendMessage(env.BOT_TOKEN, channelId, `${header}\n\n${content}`);
  } catch (error) {
    console.warn("Plaza channel mirror failed (tree-hole post)", { error });
  }
}
