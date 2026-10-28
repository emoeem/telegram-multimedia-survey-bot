import type { MediaAsset } from "../../db/schema";
import { downloadTelegramFile } from "../../bot/telegram";
import { readTemporaryMedia } from "./temporary-media.service";
import { createMediaStore } from "./temporary-media-store";
import { decodeDataUrl } from "../import.service";
import { isActiveContentMime } from "./upload-validation.service";
import { expireMediaAsset, markMediaAssetPromotedToR2 } from "../../db/repositories/media.repository";
import { getStreamVideoStatus, type StreamEnv } from "./stream.service";

interface StreamEnvSlice extends MediaServeEnv, StreamEnv {
  DB: D1Database;
}

export interface MediaServeEnv {
  BOT_TOKEN: string;
  MEDIA?: R2Bucket;
  MEDIA_KV: KVNamespace;
  /** 首读回写（Telegram → R2 搬移）需要；未绑定的调用方可以不带。 */
  DB?: D1Database;
}

/**
 * Never serve a client-declared active-content type inline. A `text/html` or
 * `image/svg+xml` asset served back verbatim from the media endpoint would
 * execute on the application origin, so it is downgraded to an attachment
 * download of `application/octet-stream` (the stored bytes are unchanged).
 */
function servedContentType(mimeType: string | null): string {
  if (mimeType && isActiveContentMime(mimeType)) return "application/octet-stream";
  return mimeType ?? "application/octet-stream";
}

/**
 * How long a client — and any cache in front of it — may keep an asset.
 *
 * Survey assets (question and option images, theme backgrounds, per-page music,
 * sprites) are immutable: an upload is never overwritten in place, a
 * replacement gets a new asset id, so the URL identifies the bytes for good.
 * The five-minute TTL it used to carry made every respondent re-download the
 * same 1.4MB background track a few questions into a survey, and left the relay
 * in front of the Worker nothing to hold on to. On a cross-border mobile link
 * that re-download *is* the wait a respondent notices between questions.
 *
 * Response uploads are someone's personal data and keep the short TTLs they
 * had: private for the temporary store, short public for the durable branches.
 */
/**
 * The one cache-policy function for every storage branch. A media asset is
 * addressed by its id and never overwritten in place — a replacement upload
 * gets a new id — so *survey*-scope bytes are immutable no matter where they
 * live (KV blob, R2 object, Telegram file, inline data URL). The branches used
 * to disagree: the KV path served the immutable policy while the R2, Telegram
 * and data-URL paths hardcoded `max-age=300`, so the same survey illustration
 * re-downloaded every five minutes whenever its bytes happened to sit on
 * Telegram instead of KV. Response-scope uploads stay private/short-lived and
 * internal scopes keep the conservative default.
 */
function mediaCacheControl(asset: MediaAsset): string {
  if (asset.scope === "survey") return "public, max-age=31536000, immutable";
  return asset.storageKind === "temporary" ? "private, no-store" : "public, max-age=300";
}

/**
 * Streams an asset's bytes from its declared storage provider. Returns null
 * when the provider cannot serve it (missing config or unknown kind); callers
 * translate null into their own 404/503 response.
 */
export async function buildMediaResponse(env: MediaServeEnv, asset: MediaAsset): Promise<Response | null> {
  const secureHeaders = (headers: Headers, cacheControl: string): Headers => {
    headers.set("Cache-Control", cacheControl);
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "no-referrer");
    // Defense in depth: even if an HTML-ish blob ever reaches a browser with a
    // renderable type, sandbox it off the origin so it cannot script /admin.
    headers.set("Content-Security-Policy", "default-src 'none'; sandbox");
    return headers;
  };
  if (asset.url) {
    if (asset.url.startsWith("data:")) {
      const decoded = decodeDataUrl(asset.url);
      if (!decoded) {
        return new Response("媒体无效", {
          status: 410,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }
      const headers = new Headers();
      headers.set("Content-Type", servedContentType(decoded.mimeType));
      secureHeaders(headers, mediaCacheControl(asset));
      const filename = asset.fileName ? asset.fileName.replace(/[\r\n"]/g, "_") : "download";
      headers.set(
        "Content-Disposition",
        `${isActiveContentMime(decoded.mimeType ?? "") ? "attachment" : "inline"}; filename="${filename}"`,
      );
      return new Response(
        decoded.bytes.buffer.slice(
          decoded.bytes.byteOffset,
          decoded.bytes.byteOffset + decoded.bytes.byteLength,
        ) as ArrayBuffer,
        { headers },
      );
    }
    return Response.redirect(asset.url, 302);
  }

  if (asset.storageKind === "temporary") {
    const data = await readTemporaryMedia(createMediaStore({ MEDIA: env.MEDIA, MEDIA_KV: env.MEDIA_KV }), asset);
    if (!data) {
      return new Response("媒体已过期或已被清理", {
        status: 410,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    const headers = new Headers();
    headers.set("Content-Type", servedContentType(asset.mimeType));
    if (asset.mimeType && isActiveContentMime(asset.mimeType)) {
      headers.set("Content-Disposition", "attachment");
    }
    // Survey-scope assets are the survey's own content: every respondent
    // re-downloads them otherwise, so let browsers and the edge cache them like
    // the R2/Telegram kinds. Assets are never overwritten in place (a new
    // upload gets a new id), so the long TTL cannot serve a replaced blob.
    // Response-scope uploads are personal data and stay uncacheable.
    secureHeaders(headers, mediaCacheControl(asset));
    return new Response(new Uint8Array(data).buffer, { headers });
  }

  if (asset.storageKind === "stream") {
    return serveStreamAsset(env as MediaServeEnv & StreamEnvSlice, asset);
  }

  if (asset.storageKind === "r2") {
    const storageKey = asset.storageKey ?? asset.r2Key;
    if (!storageKey || !env.MEDIA) return null;
    const headers = new Headers();
    headers.set("Content-Type", servedContentType(asset.mimeType));
    secureHeaders(headers, mediaCacheControl(asset));
    const r2Filename = asset.fileName ? asset.fileName.replace(/[\r\n"]/g, "_") : "download";
    headers.set(
      "Content-Disposition",
      `${asset.mimeType && isActiveContentMime(asset.mimeType) ? "attachment" : "inline"}; filename="${r2Filename}"`,
    );
    const object = await env.MEDIA.get(storageKey);
    if (!object) return null;
    return new Response(object.body, { headers });
  }

  if (asset.telegramFileId) {
    try {
      const downloaded = await downloadTelegramFile(env.BOT_TOKEN, asset.telegramFileId);
      // 首读回写（0091）：Telegram 资产只在第一次 cache miss 时走两趟 Bot
      // API；下载成功且本部署绑了 R2 时把字节搬进来并翻转存储类型，此后
      // 与 R2 资产同速。file_id 保留作兜底，搬移失败不影响本次返回。
      if (env.MEDIA && env.DB) {
        try {
          const promotedKey = `media:telegram:${asset.id}`;
          await env.MEDIA.put(promotedKey, downloaded.data);
          await markMediaAssetPromotedToR2(env.DB, asset.id, promotedKey);
        } catch (error) {
          console.warn("Telegram media promotion failed", error instanceof Error ? error.message : error);
        }
      }
      const telegramMime = asset.mimeType ?? downloaded.contentType;
      const telegramHeaders = new Headers({
        "Content-Type": servedContentType(telegramMime),
      });
      if (telegramMime && isActiveContentMime(telegramMime)) {
        telegramHeaders.set("Content-Disposition", "attachment");
      }
      return new Response(new Uint8Array(downloaded.data).buffer, {
        headers: secureHeaders(telegramHeaders, mediaCacheControl(asset)),
      });
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Stream 视频的状态分流（Pro 部署的视频/音频答卷）。
 *
 * ready   → 302 到 Stream 的 HLS 播放地址（转码、自适应码率、边缘分发都归
 *           Stream；Worker 不代理字节）。
 * 未完成  → 上传凭证过期未转正：删行 + 删 Stream 对象，回 410，让前端知道
 *           这条视频永远不会好了。
 * processing → 202 + Retry-After：转码通常几十秒内完成。
 */
async function serveStreamAsset(env: StreamEnvSlice, asset: MediaAsset): Promise<Response | null> {
  const key = asset.storageKey ?? "";
  // storage_key 编码：`stream:{responseId}:{videoUid}`（见 stream-ticket 端点）。
  const videoUid = key.includes(":") ? (key.split(":")[2] ?? "") : key;
  if (!videoUid) return null;

  let status;
  try {
    status = await getStreamVideoStatus(env, videoUid);
  } catch (error) {
    console.error("Stream status lookup failed", { videoUid, error });
    return new Response(JSON.stringify({ ok: false, code: "stream_unavailable" }), {
      status: 503,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }

  if (status.state === "ready" && status.hlsUrl) {
    // 上传已完成：清掉凭证期的 expires_at（否则每日对账 cron 会把好视频删掉）。
    // 转正失败不影响本次播放。
    if (asset.expiresAt) {
      await env.DB.prepare("UPDATE media_assets SET expires_at = NULL, updated_at = ? WHERE id = ?")
        .bind(new Date().toISOString(), asset.id)
        .run()
        .catch(() => undefined);
    }
    return new Response(null, {
      status: 302,
      headers: { Location: status.hlsUrl, "cache-control": "private, max-age=60" },
    });
  }
  if (status.state === "processing") {
    return new Response(JSON.stringify({ ok: true, processing: true }), {
      status: 202,
      headers: { "content-type": "application/json", "retry-after": "10", "cache-control": "no-store" },
    });
  }
  // not_found / errored：凭证过期未上传或转码失败，这条视频不会好了——
  // 顺手失效占位行（不删行，保留对账痕迹）。
  await env.DB.prepare("UPDATE media_assets SET expires_at = ?, updated_at = ? WHERE id = ?")
    .bind(new Date(0).toISOString(), new Date().toISOString(), asset.id)
    .run()
    .catch(() => undefined);
  return new Response(JSON.stringify({ ok: false, code: "stream_gone" }), {
    status: 410,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
