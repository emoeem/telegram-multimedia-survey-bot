import { describe, expect, it } from "vitest";

import type { MediaAsset } from "../../../src/db/schema";
import { buildMediaResponse, type MediaServeEnv } from "../../../src/services/media/media-serve.service";

// KV 媒体的缓存策略：survey 作用域（题面/选项配图）是问卷内容，允许浏览器与
// 边缘短缓存；response 作用域（答题者上传）是个人数据，必须保持不可缓存。
function makeAsset(overrides: Partial<MediaAsset>): MediaAsset {
  return {
    id: 1,
    scope: "survey",
    mediaType: "photo",
    telegramFileId: null,
    telegramFileUniqueId: null,
    url: null,
    storageKind: "temporary",
    storageKey: "media:survey:test",
    expiresAt: null,
    mimeType: "image/png",
    fileName: "a.png",
    fileSize: 3,
    width: null,
    height: null,
    duration: null,
    r2Key: null,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

const env = {
  BOT_TOKEN: "test",
  MEDIA_KV: {
    get: async () => new ArrayBuffer(3),
    put: async () => undefined,
    delete: async () => undefined,
  },
} as unknown as MediaServeEnv;

describe("KV media cache-control", () => {
  it("caches survey-scope attachments publicly for a short window", async () => {
    const response = await buildMediaResponse(env, makeAsset({}));
    expect(response).not.toBeNull();
    expect(response?.headers.get("Cache-Control")).toBe("public, max-age=300");
  });

  it("keeps response-scope uploads uncacheable", async () => {
    const response = await buildMediaResponse(
      env,
      makeAsset({ scope: "response", storageKey: "media:temp:1:abc" }),
    );
    expect(response).not.toBeNull();
    expect(response?.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("keeps template/generated scopes uncacheable too", async () => {
    const response = await buildMediaResponse(env, makeAsset({ scope: "generated_result" }));
    expect(response?.headers.get("Cache-Control")).toBe("private, no-store");
  });
});
