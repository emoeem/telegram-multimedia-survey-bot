import type { IdentityProfileRecord } from "../db/repositories/identity-card.repository";
import { sendMessage, sendPhoto } from "../bot/telegram";
import { loadSystemSettings } from "./system-settings.service";

/**
 * Mirrors published plaza content (identity cards, tree-hole posts) to a
 * Telegram channel. The channel drives discovery back to the bot while the
 * web plaza stays the long-term archive. Mirroring must never break the
 * primary flow, so every failure is logged and swallowed.
 */
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

/** Forwards a freshly published gallery card to the channel. Card fields only — never the owner's Telegram identity. */
export async function mirrorIdentityCardToChannel(
  env: PlazaChannelEnvironment,
  identity: IdentityProfileRecord,
  png: Uint8Array,
): Promise<void> {
  try {
    const channelId = await resolvePlazaChannelId(env);
    if (channelId === null) return;
    const lines = ["🎴 资料卡画廊上新", "", `「${identity.name}」`];
    if (identity.identityLabel) lines.push(`标签：${identity.identityLabel}`);
    if (identity.description) lines.push("", identity.description.slice(0, 120));
    lines.push("", "👉 来机器人「资料卡画廊」看更多");
    await sendPhoto(env.BOT_TOKEN, channelId, png, lines.join("\n"));
  } catch (error) {
    console.warn("Plaza channel mirror failed (identity card)", { identityId: identity.id, error });
  }
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
