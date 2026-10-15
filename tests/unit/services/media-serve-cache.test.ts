import { describe, expect, it, vi } from "vitest";

import type { MediaAsset } from "../../../src/db/schema";
import { buildMediaResponse, type MediaServeEnv } from "../../../src/services/media/media-serve.service";

// 媒体缓存策略（mediaCacheControl）：survey 作用域（题面/选项配图、主题背景与音乐、
// 立绘）是问卷内容，按 asset id 寻址且永不原地覆盖，所以**无论字节存在哪个后端**
// （KV blob / R2 / Telegram file_id / data URL）都是长缓存不可变资源——短 TTL 会让
// 国内弱网参与者每隔几分钟重新下载同一张立绘；response 作用域（答题者上传）是个人
// 数据：临时存储必须完全不可缓存，durable 存储沿用短的公开 TTL。其余内部作用域
// （模板、生成结果等）维持保守的公开短 TTL。
const IMMUTABLE = "public, max-age=31536000, immutable";

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

const kvEnv = {
  BOT_TOKEN: "test",
  MEDIA_KV: {
    get: async () => new ArrayBuffer(3),
    put: async () => undefined,
    delete: async () => undefined,
  },
} as unknown as MediaServeEnv;

const r2Env = {
  BOT_TOKEN: "test",
  MEDIA_KV: { get: async () => new ArrayBuffer(3) },
  MEDIA: {
    get: async () => ({ body: new ReadableStream() }),
  },
} as unknown as MediaServeEnv;

vi.mock("../../../src/bot/telegram", () => ({
  downloadTelegramFile: async () => ({ data: new Uint8Array([1, 2, 3]), contentType: "image/png" }),
}));

const telegramEnv = {
  BOT_TOKEN: "test-token",
  MEDIA_KV: { get: async () => new ArrayBuffer(3) },
} as unknown as MediaServeEnv;

function dataUrlAsset(overrides: Partial<MediaAsset>): MediaAsset {
  const png = "iVBORw0KGgoAAAANSUhEUg==";
  return makeAsset({ url: `data:image/png;base64,${png}`, ...overrides });
}

describe("unified media cache-control across storage branches", () => {
  it("KV branch: survey-scope assets are immutable for a year", async () => {
    const response = await buildMediaResponse(kvEnv, makeAsset({}));
    expect(response?.headers.get("Cache-Control")).toBe(IMMUTABLE);
  });

  it("KV branch: response-scope temporary uploads stay uncacheable", async () => {
    const response = await buildMediaResponse(
      kvEnv,
      makeAsset({ scope: "response", storageKey: "media:temp:1:abc" }),
    );
    expect(response?.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("KV branch: internal scopes stay uncacheable while temporary", async () => {
    const response = await buildMediaResponse(kvEnv, makeAsset({ scope: "generated_result" }));
    expect(response?.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("data-URL branch: survey-scope assets are immutable (used to be max-age=300)", async () => {
    const response = await buildMediaResponse(kvEnv, dataUrlAsset({}));
    expect(response?.headers.get("Cache-Control")).toBe(IMMUTABLE);
  });

  it("data-URL branch: response-scope data URLs stay uncacheable", async () => {
    const response = await buildMediaResponse(kvEnv, dataUrlAsset({ scope: "response" }));
    expect(response?.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("R2 branch: survey-scope assets are immutable (used to be max-age=300)", async () => {
    const response = await buildMediaResponse(
      r2Env,
      makeAsset({ storageKind: "r2", storageKey: "media/r2/1", r2Key: "media/r2/1" }),
    );
    expect(response?.headers.get("Cache-Control")).toBe(IMMUTABLE);
  });

  it("R2 branch: response-scope durable assets keep the short public TTL", async () => {
    const response = await buildMediaResponse(
      r2Env,
      makeAsset({ scope: "response", storageKind: "r2", storageKey: "media/r2/2", r2Key: "media/r2/2" }),
    );
    expect(response?.headers.get("Cache-Control")).toBe("public, max-age=300");
  });

  it("Telegram branch: survey-scope assets are immutable (used to be max-age=300)", async () => {
    const response = await buildMediaResponse(
      telegramEnv,
      makeAsset({ storageKind: "telegram", telegramFileId: "AgAC-file-id" }),
    );
    expect(response?.headers.get("Cache-Control")).toBe(IMMUTABLE);
  });

  it("Telegram branch: response-scope assets keep the short public TTL", async () => {
    const response = await buildMediaResponse(
      telegramEnv,
      makeAsset({ scope: "response", storageKind: "telegram", telegramFileId: "AgAC-file-id" }),
    );
    expect(response?.headers.get("Cache-Control")).toBe("public, max-age=300");
  });

  it("Telegram branch: active-content types still downgrade to attachment", async () => {
    const response = await buildMediaResponse(
      telegramEnv,
      makeAsset({
        storageKind: "telegram",
        telegramFileId: "AgAC-file-id",
        mimeType: "image/svg+xml",
        mediaType: "document",
      }),
    );
    expect(response?.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(response?.headers.get("Content-Disposition")).toBe("attachment");
  });
});
