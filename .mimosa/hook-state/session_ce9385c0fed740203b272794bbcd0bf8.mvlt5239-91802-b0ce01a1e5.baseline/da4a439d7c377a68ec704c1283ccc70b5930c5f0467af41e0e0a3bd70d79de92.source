import type { ImportedMedia, ImportedMediaResolver } from "./import.service";
import { decodeDataUrl } from "./import.service";
import { KVMediaStore } from "./media/temporary-media-store";

const IMPORT_MEDIA_KV_MAX_BYTES = 24 * 1024 * 1024;

// Microsoft hosts that serve publicly shared form media (hive.forms.*).
// Remote images are cached into KV at import time so surveys stay
// self-contained even if Microsoft rotates or expires the source URLs.
const MICROSOFT_MEDIA_HOST_SUFFIXES = [".usercontent.microsoft"];

const IMPORT_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36";

function isMicrosoftMediaHost(host: string): boolean {
  return host === "usercontent.microsoft" || MICROSOFT_MEDIA_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * Resolves embedded data-URL media (produced by the PDF converter) and
 * publicly shared Microsoft form images into KV blobs so survey media survive
 * with small D1 rows and are served through the normal media pipeline.
 * Oversized or unfetchable payloads fall back to their original form.
 */
export function createImportMediaResolver(env: { MEDIA_KV: KVNamespace }): ImportedMediaResolver {
  const store = new KVMediaStore(env.MEDIA_KV);
  return async (media: ImportedMedia) => {
    if (media.url?.startsWith("data:")) {
      const decoded = decodeDataUrl(media.url);
      if (!decoded || decoded.bytes.byteLength > IMPORT_MEDIA_KV_MAX_BYTES) {
        return media;
      }
      const storageKey = `media:import:${crypto.randomUUID()}`;
      await store.put({
        storageKey,
        bytes: decoded.bytes,
        contentType: decoded.mimeType,
      });
      return {
        type: media.type,
        source: "url",
        storageKind: "temporary",
        storageKey,
        mimeType: media.mimeType ?? decoded.mimeType,
        ...(media.fileName ? { fileName: media.fileName } : {}),
        ...(media.width !== undefined ? { width: media.width } : {}),
        ...(media.height !== undefined ? { height: media.height } : {}),
        size: decoded.bytes.byteLength,
      };
    }

    if (media.url?.startsWith("https://")) {
      let host: string;
      try {
        host = new URL(media.url).hostname;
      } catch {
        return media;
      }
      if (!isMicrosoftMediaHost(host)) return media;
      try {
        const response = await fetch(media.url, {
          headers: { "User-Agent": IMPORT_USER_AGENT },
        });
        if (!response.ok) return media;
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > IMPORT_MEDIA_KV_MAX_BYTES) return media;
        const contentType = response.headers.get("content-type") ?? media.mimeType ?? "application/octet-stream";
        const storageKey = `media:import:${crypto.randomUUID()}`;
        await store.put({ storageKey, bytes, contentType });
        return {
          type: media.type,
          source: "url",
          storageKind: "temporary",
          storageKey,
          mimeType: media.mimeType ?? contentType,
          ...(media.fileName ? { fileName: media.fileName } : {}),
          ...(media.width !== undefined ? { width: media.width } : {}),
          ...(media.height !== undefined ? { height: media.height } : {}),
          size: bytes.byteLength,
        };
      } catch {
        // Fall back to the remote URL when the image cannot be cached.
        return media;
      }
    }
    return media;
  };
}
