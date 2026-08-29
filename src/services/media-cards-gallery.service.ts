import { sendPhoto } from "../bot/telegram";

const DEFAULT_GALLERY_DATA_URL = "https://emoeem.github.io/cards/data.json";
export const MEDIA_CARDS_LAST_SLUG_KEY = "media-cards:last-announced-slug";
const GALLERY_BASE_URL = "https://emoeem.github.io/cards/";

export interface GalleryCard {
  _slug?: unknown;
  title?: unknown;
  generated_at?: unknown;
  visibility?: unknown;
  badges?: unknown;
  video?: unknown;
  audio?: unknown;
  file?: unknown;
  playback?: unknown;
}

export interface GalleryData {
  schema?: number;
  total?: number;
  cards?: GalleryCard[];
}

export interface MediaCardsPollEnv {
  BOT_TOKEN: string;
  CACHE: Pick<KVNamespace, "get" | "put">;
  CARDS_CHANNEL_ID?: string;
  CARDS_GALLERY_URL?: string;
}

export interface MediaCardsPollResult {
  announced: number;
  skipped: boolean;
  reason?: string;
}

export const GALLERY_BADGE_LABEL: Record<string, string> = {
  "dolby-vision": "杜比视界",
  "hdr-vivid": "HDR Vivid",
  "hdr10-plus": "HDR10+",
  hdr10: "HDR10",
  hlg: "HLG",
  "dolby-atmos": "Atmos",
  "dts-x": "DTS:X",
  "audio-vivid": "Audio Vivid",
  "dolby-truehd": "TrueHD",
  "dts-hd": "DTS-HD",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * 解析画廊 data.json：只保留带合法 slug 的公开卡片，防御路径注入与脏数据。
 */
export function parseGalleryCards(payload: unknown): GalleryCard[] {
  if (!isRecord(payload) || !Array.isArray(payload.cards)) return [];
  const out: GalleryCard[] = [];
  for (const item of payload.cards) {
    if (!isRecord(item)) continue;
    const slug = item._slug;
    if (typeof slug !== "string" || slug.length === 0 || slug.length > 80) continue;
    if (!/^[A-Za-z0-9_-]+$/.test(slug)) continue;
    if (item.visibility !== undefined && item.visibility !== "public") continue;
    out.push(item as GalleryCard);
  }
  return out;
}

/**
 * 从画廊数据里挑出需要推送的新卡片。data.json 按时间倒序排列：
 * - 首次运行（无记录）：只推送最近的 limit 张，避免刷屏；
 * - 有记录：推送上次记录之后（更新）的所有卡片，并按时间正序发送。
 */
export function selectNewCards(
  cards: GalleryCard[],
  lastAnnouncedSlug: string | null,
  limit = 5,
): GalleryCard[] {
  if (cards.length === 0) return [];
  if (!lastAnnouncedSlug) {
    return cards.slice(0, Math.min(limit, cards.length)).reverse();
  }
  const index = cards.findIndex((card) => card._slug === lastAnnouncedSlug);
  const fresh = index === -1 ? cards.slice(0, limit) : cards.slice(0, index);
  return fresh.slice(0, limit).reverse();
}

export function cardBadges(card: GalleryCard): string[] {
  if (!isRecord(card.badges)) return [];
  const video = Array.isArray(card.badges.video) ? card.badges.video : [];
  const audio = Array.isArray(card.badges.audio) ? card.badges.audio : [];
  return [...video, ...audio].filter((key): key is string => typeof key === "string");
}

export function galleryImageUrl(card: GalleryCard): string {
  return `${GALLERY_BASE_URL}data/${String(card._slug ?? "")}.png`;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return isRecord(value);
}

function videoSpec(card: GalleryCard): string {
  if (!isRecordValue(card.video)) return "";
  const video = card.video;
  const parts: string[] = [];
  if (typeof video.codec === "string" && video.codec) parts.push(video.codec);
  if (typeof video.width === "number" && typeof video.height === "number") {
    parts.push(`${video.width}×${video.height}`);
  }
  if (typeof video.fps === "number") parts.push(`${Math.round(video.fps * 100) / 100} fps`);
  return parts.join(" · ");
}

function audioSpec(card: GalleryCard): string {
  if (!isRecordValue(card.audio)) return "";
  const audio = card.audio;
  const parts: string[] = [];
  if (typeof audio.codec === "string" && audio.codec) parts.push(audio.codec);
  if (typeof audio.layout === "string" && audio.layout) parts.push(audio.layout);
  else if (typeof audio.channels === "number") parts.push(`${audio.channels} ch`);
  return parts.join(" · ");
}

export function galleryCardCaption(card: GalleryCard): string {
  const title = typeof card.title === "string" && card.title ? card.title : "未命名";
  const badges = cardBadges(card)
    .map((key) => GALLERY_BADGE_LABEL[key])
    .filter(Boolean)
    .map((label) => `【${label}】`)
    .join("");
  const specLines = [videoSpec(card), audioSpec(card)].filter(Boolean);
  return [
    `📷 ${title}`,
    badges,
    ...specLines,
    "",
    `🔗 ${GALLERY_BASE_URL}`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export async function fetchGalleryCards(
  galleryDataUrl: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<GalleryCard[]> {
  const url = galleryDataUrl && galleryDataUrl.length > 0 ? galleryDataUrl : DEFAULT_GALLERY_DATA_URL;
  const response = await fetchImpl(url, {
    headers: { "cache-control": "no-cache" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`gallery data request failed: ${response.status}`);
  }
  return parseGalleryCards(await response.json());
}

/**
 * 定时任务：把画廊里新增的公开卡片推送到频道。
 * 未配置 CARDS_CHANNEL_ID 时直接跳过，保证默认部署零行为变化。
 */
export async function pollMediaCardsForChannel(
  env: MediaCardsPollEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<MediaCardsPollResult> {
  if (!env.CARDS_CHANNEL_ID) {
    return { announced: 0, skipped: true, reason: "CARDS_CHANNEL_ID not configured" };
  }

  const cards = await fetchGalleryCards(env.CARDS_GALLERY_URL, fetchImpl);
  const lastAnnouncedSlug = await env.CACHE.get(MEDIA_CARDS_LAST_SLUG_KEY);
  const fresh = selectNewCards(cards, lastAnnouncedSlug, 5);

  let announced = 0;
  for (const card of fresh) {
    if (typeof card._slug !== "string") continue;
    try {
      await sendPhoto(
        env.BOT_TOKEN,
        Number(env.CARDS_CHANNEL_ID),
        galleryImageUrl(card),
        galleryCardCaption(card),
      );
      announced += 1;
    } catch (error) {
      console.error("Media card channel push failed", error);
      break; // 失败即停：下次运行会基于上次成功记录重试
    }
  }

  const newestSlug = cards[0]?._slug;
  if (announced === fresh.length && typeof newestSlug === "string") {
    await env.CACHE.put(MEDIA_CARDS_LAST_SLUG_KEY, newestSlug);
  }
  return { announced, skipped: false };
}
