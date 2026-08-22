import type { MediaAsset } from "../../db/schema";
import { downloadTelegramFile } from "../../bot/telegram";
import { readTemporaryMedia } from "./temporary-media.service";
import { KVMediaStore } from "./temporary-media-store";

export interface MediaServeEnv {
  BOT_TOKEN: string;
  MEDIA?: R2Bucket;
  MEDIA_KV: KVNamespace;
}

/**
 * Streams an asset's bytes from its declared storage provider. Returns null
 * when the provider cannot serve it (missing config or unknown kind); callers
 * translate null into their own 404/503 response.
 */
export async function buildMediaResponse(
  env: MediaServeEnv,
  asset: MediaAsset,
): Promise<Response | null> {
  if (asset.url) {
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
    if (asset.mimeType) headers.set("Content-Type", asset.mimeType);
    headers.set("Cache-Control", "private, max-age=300");
    return new Response(new Uint8Array(data).buffer, { headers });
  }

  if (asset.storageKind === "r2") {
    const storageKey = asset.storageKey ?? asset.r2Key;
    if (!storageKey || !env.MEDIA) return null;
    const headers = new Headers();
    if (asset.mimeType) headers.set("Content-Type", asset.mimeType);
    if (asset.fileName) {
      headers.set(
        "Content-Disposition",
        `inline; filename="${asset.fileName.replace(/[\r\n"]/g, "_")}"`,
      );
    }
    const object = await env.MEDIA.get(storageKey);
    if (!object) return null;
    return new Response(object.body, { headers });
  }

  if (asset.telegramFileId) {
    try {
      const downloaded = await downloadTelegramFile(env.BOT_TOKEN, asset.telegramFileId);
      return new Response(new Uint8Array(downloaded.data).buffer, {
        headers: {
          "Content-Type":
            asset.mimeType ?? downloaded.contentType ?? "application/octet-stream",
          "Cache-Control": "public, max-age=300",
        },
      });
    } catch {
      return null;
    }
  }

  return null;
}
