import { WebSubmitStore } from "./store";
import {
  attachmentsOf,
  composeWebSubmissionText,
  type WebSubmitAttachment,
  type WebSubmitFormConfig,
} from "./form-config";
import { sendMessage, sendPhoto, sendPhotoAlbum } from "../../bot/telegram";
import { createMediaStore } from "../media/temporary-media-store";

/**
 * 免登录投稿的审核动作（HTTP 管理端与 TG bot 管理共用）。
 *
 * 通过 = CAS 状态翻转到 published（防并发双击/两处同时通过）→ 可选频道摘要
 * 推送（运营在 web_submit_form 配置 publishChannelId 时）→ 给作者线程留言。
 * 发送失败不回滚状态；驳回同理，理由进作者线程。
 */

export type ReviewFailureCode = "not_found" | "already_published" | "already_rejected" | "in_flight";

export type ReviewOutcome = { ok: true; link: string | null } | { ok: false; code: ReviewFailureCode };

export interface ReviewEnv {
  BOT_TOKEN: string;
  /** 附件字节读取（网页投稿的图片卡片发布）；与 BotContext.media 同源。 */
  MEDIA?: R2Bucket | undefined;
  MEDIA_KV?: KVNamespace | undefined;
  /** loadAttachmentPhotos 批量取资产行用。 */
  DB: D1Database;
}

/**
 * 把通过的网页投稿发布成旧投稿机器人同款卡片：图片走相册（≥2 张）或单图
 * （1 张），文字卡片跟在后面，一起发进配置的群/话题（曝光区）。文本摘要
 * 推送（publishChannelId 配了但没配话题时的旧行为）保留为图片不可用时的
 * 兜底。卡片消息 id 会写回投稿行，作者收件箱的「查看发布」链接靠它。
 */
export async function approveWebSubmission(
  env: ReviewEnv,
  db: D1Database,
  config: WebSubmitFormConfig,
  id: number,
): Promise<ReviewOutcome> {
  const store = new WebSubmitStore(db);
  const row = await store.getSubmission(id);
  if (!row) return { ok: false, code: "not_found" };
  if (row.status === "published") return { ok: false, code: "already_published" };
  const won = await store.setStatus(id, "published", ["pending", "failed", "publishing"]);
  if (!won) {
    const fresh = await store.getSubmission(id);
    return { ok: false, code: fresh?.status === "published" ? "already_published" : "in_flight" };
  }
  const channelId = Number(config.publishChannelId);
  let link: string | null = null;
  if (Number.isInteger(channelId) && channelId !== 0) {
    const threadId = Number(config.publishThreadId);
    const messageThreadId = Number.isInteger(threadId) && threadId > 0 ? threadId : undefined;
    try {
      const card = composeWebSubmissionText(config, row.data, id).slice(0, 4000);
      const photos = await loadAttachmentPhotos(env, row.data, config);
      let cardMessageId: number | null = null;
      if (photos.length >= 2) {
        await sendPhotoAlbum(env.BOT_TOKEN, channelId, photos, messageThreadId);
      } else if (photos.length === 1) {
        await sendPhoto(
          env.BOT_TOKEN,
          channelId,
          photos[0]?.bytes ?? new Uint8Array(),
          undefined,
          undefined,
          messageThreadId,
        );
      }
      const sent = await sendMessage(env.BOT_TOKEN, channelId, card, undefined, messageThreadId, "HTML");
      const payload = (await sent.json()) as { result?: { message_id?: number }; description?: string };
      cardMessageId = typeof payload?.result?.message_id === "number" ? payload.result.message_id : null;
      if (cardMessageId === null) {
        console.warn("web submission card push rejected", { id, description: payload?.description?.slice(0, 200) });
      }
      if (cardMessageId !== null) {
        const chatRef = String(channelId);
        link = `https://t.me/c/${chatRef.slice(4)}/${cardMessageId}`;
        await store.setPublishInfo(id, chatRef, cardMessageId);
      }
    } catch (error) {
      console.warn("web submission channel push failed", { id, error: String(error) });
    }
  }
  await store.addThreadMessage(id, "to_author", "你的投稿已通过审核 ✅");
  return { ok: true, link };
}

/** 读回图片附件的字节（media_refs 保护下的 media_assets），坏图跳过。 */
async function loadAttachmentPhotos(
  env: ReviewEnv,
  data: Record<string, unknown>,
  config: WebSubmitFormConfig,
): Promise<Array<{ bytes: Uint8Array; caption?: string }>> {
  const attachments: WebSubmitAttachment[] = attachmentsOf(data, config.steps).filter(
    (item) => item.kind === "photo" && typeof item.mediaAssetId === "number",
  );
  if (attachments.length === 0 || (!env.MEDIA && !env.MEDIA_KV)) return [];
  const assetIds = attachments.map((item) => item.mediaAssetId as number);
  const { getMediaAssetsByIds } = await import("../../db/repositories/media.repository");
  const assets = await getMediaAssetsByIds(env.DB, assetIds);
  const store = createMediaStore({ MEDIA: env.MEDIA, MEDIA_KV: env.MEDIA_KV });
  const photos: Array<{ bytes: Uint8Array; caption?: string }> = [];
  for (const attachment of attachments) {
    const asset = assets.get(attachment.mediaAssetId as number);
    if (!asset?.storageKey) continue;
    const bytes = await store.get(asset.storageKey);
    if (bytes) photos.push({ bytes });
  }
  return photos;
}

export async function rejectWebSubmission(db: D1Database, id: number, reason: string): Promise<ReviewOutcome> {
  const store = new WebSubmitStore(db);
  const row = await store.getSubmission(id);
  if (!row) return { ok: false, code: "not_found" };
  if (row.status === "published") return { ok: false, code: "already_published" };
  const won = await store.setStatus(id, "rejected", ["pending", "failed"]);
  if (!won) {
    const fresh = await store.getSubmission(id);
    return { ok: false, code: fresh?.status === "rejected" ? "already_rejected" : "in_flight" };
  }
  if (reason) await store.addThreadMessage(id, "to_author", `你的投稿未通过审核：${reason}`);
  return { ok: true, link: null };
}
