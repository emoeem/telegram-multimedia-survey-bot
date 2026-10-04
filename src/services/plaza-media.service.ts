import { createMediaAsset, expireMediaAsset, getMediaAssetById } from "../db/repositories/media.repository";
import { detachPlazaPostImage, getPlazaPostImageAssetId } from "../db/repositories/plaza-post.repository";
import { KVMediaStore } from "./media/temporary-media-store";
import { verifyUploadContent } from "./media/upload-validation.service";
import type { MediaAsset } from "../db/schema";

/**
 * 树洞配图（0068）。
 *
 * 存储复用「durable KV」那一套（和展示区图片相同）：KVMediaStore + 无过期时间
 * 的 storage_key。授权边界放在读取侧——只有挂在一张 published 帖子上的图片才
 * 能读，下架（或删除）后链接立即 404，管理员下架时还会把 KV 里的字节删掉。
 *
 * scope 为什么是 "response"：media_assets.asset_scope 上有 CHECK 约束，而 D1 的
 * 迁移是一次原子批处理、事务内关不掉外键，所以 0068 不能像本地那样「重建父表
 * 放宽 CHECK」（会报 SQLITE_CONSTRAINT_TRIGGER 7500，且 DROP 的级联会波及子表）。
 * response 是 CHECK 允许的、同样代表「用户上传内容」的 scope，而 /api/survey/media
 * 与 /api/report 对 response 资产都要求「答卷 + 本人」才放行，因此树洞图不会从
 * 别的路由被旁路读走。真正的身份判据是 PLAZA_IMAGE_STORAGE_PREFIX 前缀。
 */

export const PLAZA_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const PLAZA_IMAGE_STORAGE_PREFIX = "media:plaza:";

const PLAZA_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"]);

export interface PlazaMediaEnvironment {
  DB: D1Database;
  MEDIA_KV: KVNamespace;
}

export async function storePlazaPostImage(
  env: PlazaMediaEnvironment,
  file: File,
): Promise<{ asset: MediaAsset } | { error: string }> {
  const mimeType = (file.type || "").toLowerCase();
  if (!PLAZA_IMAGE_MIME_TYPES.has(mimeType)) {
    return { error: "只支持 JPG / PNG / WebP / GIF 图片" };
  }
  if (file.size <= 0) return { error: "图片内容为空，请重新选择" };
  if (file.size > PLAZA_IMAGE_MAX_BYTES) {
    return { error: `单张图片不能超过 ${PLAZA_IMAGE_MAX_BYTES / 1024 / 1024}MB` };
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  // 声明的 MIME 不可信：字节签名必须真的是图片，否则一张 HTML 会被当成图片存下来。
  const verified = verifyUploadContent(bytes, mimeType);
  if (!verified.ok) return { error: verified.reason ?? "图片内容无法识别" };

  const store = new KVMediaStore(env.MEDIA_KV);
  const storageKey = `${PLAZA_IMAGE_STORAGE_PREFIX}${crypto.randomUUID()}`;
  await store.put({ storageKey, bytes, contentType: mimeType });
  const asset = await createMediaAsset(env.DB, {
    scope: "response",
    mediaType: "photo",
    storageKind: store.kind,
    storageKey,
    // 没有过期时间：临时媒体的清理任务（按 expires_at）不会扫到它。
    expiresAt: null,
    mimeType,
    fileName: file.name || null,
    fileSize: bytes.byteLength,
  });
  return { asset };
}

/**
 * 删除一张帖子配图的字节与元数据，并摘掉帖子上的引用。
 * 下架违规内容时调用；恢复帖子不会带回图片（字节已经删了，这是有意的）。
 */
export async function purgePlazaPostImage(env: PlazaMediaEnvironment, postId: number): Promise<boolean> {
  const assetId = await getPlazaPostImageAssetId(env.DB, postId);
  if (assetId === null) return false;
  const asset = await getMediaAssetById(env.DB, assetId);
  if (asset?.storageKey) {
    try {
      await new KVMediaStore(env.MEDIA_KV).delete(asset.storageKey);
    } catch (error) {
      console.error("Plaza image purge failed", { postId, assetId, error });
    }
  }
  await expireMediaAsset(env.DB, assetId);
  await detachPlazaPostImage(env.DB, postId);
  return true;
}

/**
 * 这张 asset 是不是树洞配图？
 *
 * scope 只说明「用户上传内容」，把它和答卷附件区分开的是 KV key 前缀——两个
 * 条件必须同时成立，否则一张普通答卷附件就可能被树洞路由读出去。
 */
export function isPlazaImageAsset(asset: Pick<MediaAsset, "scope" | "storageKey">): boolean {
  return asset.scope === "response" && (asset.storageKey?.startsWith(PLAZA_IMAGE_STORAGE_PREFIX) ?? false);
}

/** 帖子配图的公开 URL（None 表示没有图）。 */
export function plazaImageUrl(imageAssetId: number | null): string | null {
  return imageAssetId === null ? null : `/api/plaza/media/${imageAssetId}`;
}
