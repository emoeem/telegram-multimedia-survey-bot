/**
 * 上传前的图片"压缩发布"——DOM 侧实现，全站唯一的一份。
 *
 * 为什么要有这个文件：投稿图、树洞配图、答卷附件、认证卡原图，四条链路过去
 * 各自决定"传原图还是传缩略图"，结果是同一张 6MB 手机照在不同入口会有四种
 * 体积。带宽是整个部署里最贵的资源（Vercel 出站 + R2 读取），而用户上传的
 * 图片是唯一能真正压下来的那部分——所以把决策收敛到一个地方。
 *
 * 三条硬约束：
 *   1. **绝不更大**：重编码后的字节数不小于原图就退回原图。压缩永远不该让
 *      用户多等一次上传。
 *   2. **绝不改动画**：GIF 会丢帧，直接放行；SVG 是标记语言，交给服务端拒。
 *   3. **绝不上采样**：小图不放大，只在大图超标时才动手。
 *
 * 服务端不做这件事（Worker 里没有 sharp），所以这里是唯一的压缩点；
 * 服务端只负责大小上限、magic-byte 校验和缓存策略。
 *
 * 常量与纯决策函数在 image-publish.shared.ts —— 那份没有 DOM 依赖，node 测试
 * 才能直接 import 它去和 cert/app.js 的实现比对参数。
 */

import {
  PUBLISH_MAX_EDGE,
  PUBLISH_MIME,
  PUBLISH_QUALITY,
  THUMB_MAX_EDGE,
  THUMB_QUALITY,
  shouldReencode,
  type PublishImageOptions,
} from "./image-publish.shared";

export {
  PUBLISH_MAX_EDGE,
  PUBLISH_MIME,
  PUBLISH_QUALITY,
  PUBLISH_SKIP_UNDER_BYTES,
  THUMB_MAX_EDGE,
  THUMB_QUALITY,
  shouldReencode,
} from "./image-publish.shared";
export type { PublishImageOptions } from "./image-publish.shared";

/** 只对"能被 canvas 重新编码"的类型动手；其余原样返回。 */
function isReencodeCandidate(file: File): boolean {
  const type = (file.type || "").toLowerCase();
  if (!type.startsWith("image/")) return false;
  // GIF 重编码会丢动画帧，SVG 是标记语言（服务端本来就会拒），都不碰。
  return type !== "image/gif" && type !== "image/svg+xml";
}

function extensionFor(mime: string): string {
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/png") return "png";
  return "webp";
}

function withExtension(name: string, mime: string): string {
  const base = (name || "image").replace(/\.[^./\\]+$/, "");
  return `${base}.${extensionFor(mime)}`;
}

async function encode(
  bitmap: ImageBitmap,
  width: number,
  height: number,
  mime: string,
  quality: number,
): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0, width, height);
  return new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, mime, quality);
  });
}

/**
 * 上传前的图片归一化。任何一步失败都退回原文件——压缩是优化，不是前置条件。
 */
export async function prepareImageForPublish(
  file: File,
  options: PublishImageOptions = {},
): Promise<File> {
  if (!isReencodeCandidate(file)) return file;
  const maxEdge = options.maxEdge ?? PUBLISH_MAX_EDGE;
  const quality = options.quality ?? PUBLISH_QUALITY;
  const mime = options.mime ?? PUBLISH_MIME;

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    // 浏览器不支持 createImageBitmap 或图片损坏：原图照常上传。
    return file;
  }
  try {
    if (!shouldReencode({ width: bitmap.width, height: bitmap.height, byteLength: file.size }, options)) {
      return file;
    }
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const blob = await encode(bitmap, width, height, mime, quality);
    if (!blob) return file;
    // 绝不更大：重编码反而变大（小图、已高压缩图）就退回原图。
    if (blob.size >= file.size) return file;
    return new File([blob], withExtension(file.name, mime), {
      type: mime,
      lastModified: file.lastModified,
    });
  } catch {
    return file;
  } finally {
    bitmap.close?.();
  }
}

/**
 * 列表缩略图。与发布图的差别只有两点：固定小尺寸、失败返回 null（调用方
 * 可以不传缩略图，服务端会退回原图）。
 */
export async function makeThumbnailFile(file: File): Promise<File | null> {
  if (!isReencodeCandidate(file)) return null;
  try {
    const bitmap = await createImageBitmap(file);
    try {
      const scale = Math.min(1, THUMB_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const blob = await encode(bitmap, width, height, "image/jpeg", THUMB_QUALITY);
      return blob ? new File([blob], "thumb.jpg", { type: "image/jpeg" }) : null;
    } finally {
      bitmap.close?.();
    }
  } catch {
    return null;
  }
}
