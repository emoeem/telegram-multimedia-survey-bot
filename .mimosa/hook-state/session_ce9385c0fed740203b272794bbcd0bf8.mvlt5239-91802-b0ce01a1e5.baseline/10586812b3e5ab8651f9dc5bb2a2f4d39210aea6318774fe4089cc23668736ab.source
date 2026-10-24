import type { MediaAsset } from "../../db/schema";
import { downloadTelegramFile } from "../../bot/telegram";
import { readTemporaryMedia } from "./temporary-media.service";
import { KVMediaStore } from "./temporary-media-store";
import { decodeDataUrl } from "../import.service";
import { isActiveContentMime } from "./upload-validation.service";

export interface MediaServeEnv {
  BOT_TOKEN: string;
  MEDIA?: R2Bucket;
  MEDIA_KV: KVNamespace;
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
      secureHeaders(headers, "public, max-age=300");
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
    const data = await readTemporaryMedia(new KVMediaStore(env.MEDIA_KV), asset);
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
    secureHeaders(headers, "private, no-store");
    return new Response(new Uint8Array(data).buffer, { headers });
  }

  if (asset.storageKind === "r2") {
    const storageKey = asset.storageKey ?? asset.r2Key;
    if (!storageKey || !env.MEDIA) return null;
    const headers = new Headers();
    headers.set("Content-Type", servedContentType(asset.mimeType));
    secureHeaders(headers, "public, max-age=300");
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
      const telegramMime = asset.mimeType ?? downloaded.contentType;
      const telegramHeaders = new Headers({
        "Content-Type": servedContentType(telegramMime),
      });
      if (telegramMime && isActiveContentMime(telegramMime)) {
        telegramHeaders.set("Content-Disposition", "attachment");
      }
      return new Response(new Uint8Array(downloaded.data).buffer, {
        headers: secureHeaders(telegramHeaders, "public, max-age=300"),
      });
    } catch {
      return null;
    }
  }

  return null;
}
