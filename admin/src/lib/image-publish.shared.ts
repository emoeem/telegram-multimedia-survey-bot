/**
 * "压缩发布"的决策层——不碰 DOM，纯参数 + 纯函数。
 *
 * 拆出来的唯一原因：认证卡（cert/app.js）是零依赖离线单文件，不能 import
 * 这个模块，只能保留一份同参数实现；而两边的参数必须永远一致。把常量放进
 * 一个**没有 DOM 依赖**的文件里，node 端的测试就能直接 import 它，再和
 * cert/app.js 的源码逐项比对——改一边不改另一边，测试立刻红。
 *
 * DOM 侧的实现在同目录的 image-publish.ts。
 */

/** 发布图最长边。1600 在手机 3x 屏上仍然清晰，体积约为 4000px 原图的 1/6。 */
export const PUBLISH_MAX_EDGE = 1600;

/** WebP 有损质量。0.86 是照片在 100% 缩放下看不出块的拐点。 */
export const PUBLISH_QUALITY = 0.86;

/** 发布图的编码格式。WebP 比同质量 JPEG 小 25%–35%，且保留透明通道。 */
export const PUBLISH_MIME = "image/webp";

/** 尺寸没超标、体积也在这条线以下的图，重编码纯属浪费 CPU —— 直接放行。 */
export const PUBLISH_SKIP_UNDER_BYTES = 320 * 1024;

/** 列表缩略图最长边（投稿列表、奖池预览）。 */
export const THUMB_MAX_EDGE = 480;

/** 缩略图质量。缩略图只用于列表，0.82 足够。 */
export const THUMB_QUALITY = 0.82;

export interface PublishImageOptions {
  maxEdge?: number;
  quality?: number;
  mime?: string;
}

/**
 * 不解码就能判定要不要重编码。
 *
 * 三条规则：大到超过最长边 → 重编码；体积超过跳过线 → 重编码；其余放行。
 * 读不出尺寸（0 / NaN）一律放行：宁可传原图，也不要凭猜测重编码。
 */
export function shouldReencode(
  input: { width: number; height: number; byteLength: number },
  options: PublishImageOptions = {},
): boolean {
  const maxEdge = options.maxEdge ?? PUBLISH_MAX_EDGE;
  const { width, height, byteLength } = input;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return false;
  }
  if (Math.max(width, height) > maxEdge) return true;
  return byteLength > PUBLISH_SKIP_UNDER_BYTES;
}
