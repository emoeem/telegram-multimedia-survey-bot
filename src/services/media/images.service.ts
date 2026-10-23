/**
 * Cloudflare Images 图片管线（Pro 能力，docs/CLOUDFLARE_PLAN_TIERS.md）。
 *
 * 账号订阅 `Images Stream Basic` 后即可用：渲染产物（认证卡成品图等）上传到
 * Images 存储，经 `imagedelivery.net` 的边缘网络分发，并可用 `/cdn-cgi/image/`
 * 做按需变换（缩放/WebP）。相比往 KV 里塞大 blob，写入不计入每日 1,000 写
 * 配额，读取由边缘缓存承担。
 *
 * 上传/删除都是真实的 REST 往返（Images 没有 Worker binding），调用方自行
 * 决定频率与失败策略——本模块只做薄封装与配置判定。
 */

export interface ImagesEnv {
  IMAGES_ACCOUNT_ID?: string | null | undefined;
  IMAGES_DELIVERY_HASH?: string | null | undefined;
  CLOUDFLARE_API_TOKEN?: string | null | undefined;
}

export interface ImagesUploadResult {
  imageId: string;
  /** `https://imagedelivery.net/{hash}/{id}/public`，可直接 <img src>。 */
  url: string;
}

const API_BASE = "https://api.cloudflare.com/client/v4";

export function imagesConfigured(env: ImagesEnv): boolean {
  const required = [env.IMAGES_ACCOUNT_ID, env.IMAGES_DELIVERY_HASH, env.CLOUDFLARE_API_TOKEN];
  return required.every((value) => typeof value === "string" && (value as string).trim().length > 0);
}

/** 交付地址。variant 默认 `public`（账号的默认变体）。 */
export function imageDeliveryUrl(env: ImagesEnv, imageId: string, variant = "public"): string {
  return `https://imagedelivery.net/${env.IMAGES_DELIVERY_HASH ?? ""}/${imageId}/${variant}`;
}

/**
 * 上传一张图片，返回 imageId 与交付地址。图片校验（magic-byte、尺寸上限）
 * 归调用方——本模块只信任已经判定的字节。
 */
export async function uploadImage(
  env: ImagesEnv,
  input: { bytes: Uint8Array; name: string; contentType: string },
): Promise<ImagesUploadResult> {
  if (!imagesConfigured(env)) throw new Error("Images 未配置");
  const form = new FormData();
  form.append(
    "file",
    new Blob([input.bytes as unknown as BlobPart], { type: input.contentType }),
    input.name,
  );
  form.append("requireSignedURLs", "false");
  const response = await fetch(`${API_BASE}/accounts/${env.IMAGES_ACCOUNT_ID}/images/v1`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
    body: form,
  });
  const payload = (await response.json().catch(() => null)) as {
    success?: boolean;
    errors?: Array<{ message?: string }>;
    result?: { id?: string };
  } | null;
  if (!response.ok || !payload?.success || !payload.result?.id) {
    const detail = payload?.errors?.[0]?.message;
    throw new Error(
      detail
        ? `Images 上传失败（HTTP ${response.status}）：${detail}`
        : `Images 上传失败（HTTP ${response.status}）`,
    );
  }
  return { imageId: payload.result.id, url: imageDeliveryUrl(env, payload.result.id) };
}

/** 删除一张图片；404 视为已删除。 */
export async function deleteImage(env: ImagesEnv, imageId: string): Promise<void> {
  if (!imagesConfigured(env)) throw new Error("Images 未配置");
  const response = await fetch(`${API_BASE}/accounts/${env.IMAGES_ACCOUNT_ID}/images/v1/${encodeURIComponent(imageId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Images 删除失败（HTTP ${response.status}）`);
  }
}
