import type { MediaAsset, MediaType } from "../../db/schema";
import { createMediaAsset, findMediaAssetByContentHash } from "../../db/repositories/media.repository";
import type { TemporaryMediaStore } from "./temporary-media-store";

/**
 * 内容寻址去重（0091）：上传前算 SHA-256，同内容的素材全库只存一份字节。
 *
 * 适用范围是**永久素材**（survey 范围的后台附件 / BGM / 素材库上传）——它们
 * 没有过期语义，多个问卷指向同一个 blob 才安全。答卷临时上传（media:temp:*，
 * 按 response 过期）刻意不走这条路径，否则清理一份答卷会连带删掉别答卷的
 * 同内容照片。
 *
 * blob key 即内容哈希（media:blob:<sha256>）：R2 层面天然单副本；并发上传
 * 可能在 D1 里各得到一行 asset（索引不唯一），读侧命中即复用，孤儿清扫兜底。
 */

export const CONTENT_BLOB_PREFIX = "media:blob:";

export function contentBlobKey(contentHash: string): string {
  return `${CONTENT_BLOB_PREFIX}${contentHash}`;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface DedupUploadResult {
  asset: MediaAsset;
  /** true = 命中已有素材（没有写新 blob）。 */
  deduplicated: boolean;
}

/**
 * 带去重的永久素材写入：哈希命中即复用既有 asset 行（不写 blob），未命中
 * 才落一份内容寻址 blob 并建行。
 */
export async function storeDeduplicatedMedia(
  db: D1Database,
  store: TemporaryMediaStore,
  input: {
    bytes: Uint8Array;
    mimeType: string;
    mediaType: MediaType;
    fileName: string | null;
    scope?: "survey";
  },
): Promise<DedupUploadResult> {
  const contentHash = await sha256Hex(input.bytes);
  const existing = await findMediaAssetByContentHash(db, contentHash);
  if (existing) {
    return { asset: existing, deduplicated: true };
  }
  const storageKey = contentBlobKey(contentHash);
  await store.put({ storageKey, bytes: input.bytes, contentType: input.mimeType });
  const asset = await createMediaAsset(db, {
    scope: input.scope ?? "survey",
    mediaType: input.mediaType,
    storageKind: store.kind,
    storageKey,
    expiresAt: null,
    mimeType: input.mimeType,
    fileName: input.fileName,
    fileSize: input.bytes.byteLength,
    contentHash,
  });
  return { asset, deduplicated: false };
}
