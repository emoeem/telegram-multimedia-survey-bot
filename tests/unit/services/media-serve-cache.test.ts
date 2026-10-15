import { describe, expect, it } from "vitest";

import type { MediaAsset } from "../../../src/db/schema";
import { buildMediaResponse, type MediaServeEnv } from "../../../src/services/media/media-serve.service";

// KV 媒体的缓存策略：survey 作用域（题面/选项配图、主题背景与音乐、立绘）是问卷
// 内容，按 asset id 寻址且永不原地覆盖，所以对浏览器与边缘都是长缓存不可变资源——
// 短 TTL 会让国内弱网参与者每隔几分钟重新下载同一首 BGM；response 作用域（答题者
// 上传）是个人数据，必须保持不可缓存。
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
  it("caches survey-scope attachments as immutable for a year", async () => {
    const response = await buildMediaResponse(env, makeAsset({}));
    expect(response).not.toBeNull();
    expect(response?.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
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
