import { describe, expect, it, vi } from "vitest";

const { findMediaAssetByContentHash, createMediaAsset } = vi.hoisted(() => ({
  findMediaAssetByContentHash: vi.fn(),
  createMediaAsset: vi.fn(),
}));
vi.mock("../../../src/db/repositories/media.repository", () => ({
  findMediaAssetByContentHash,
  createMediaAsset,
}));

import { contentBlobKey, sha256Hex, storeDeduplicatedMedia } from "../../../src/services/media/media-dedup.service";
import type { TemporaryMediaStore } from "../../../src/services/media/temporary-media-store";
import type { MediaAsset } from "../../../src/db/schema";

function fakeStore(): TemporaryMediaStore & { puts: string[] } {
  const puts: string[] = [];
  return {
    kind: "temporary",
    puts,
    async put(input) {
      puts.push(input.storageKey);
    },
    async get() {
      return null;
    },
    async delete() {},
  };
}

function asset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: 1,
    scope: "survey",
    mediaType: "photo",
    telegramFileId: null,
    telegramFileUniqueId: null,
    url: null,
    storageKind: "temporary",
    storageKey: "media:blob:abc",
    expiresAt: null,
    mimeType: "image/png",
    fileName: "a.png",
    fileSize: 4,
    width: null,
    height: null,
    duration: null,
    r2Key: null,
    contentHash: "abc",
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

describe("content addressing", () => {
  it("sha256Hex 稳定且为 64 位十六进制", async () => {
    const bytes = new TextEncoder().encode("hello");
    const hash = await sha256Hex(bytes);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await sha256Hex(bytes)).toBe(hash);
    expect(hash).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });

  it("blob key 带内容寻址前缀", () => {
    expect(contentBlobKey("deadbeef")).toBe("media:blob:deadbeef");
  });
});

describe("storeDeduplicatedMedia", () => {
  const bytes = new TextEncoder().encode("hello");

  it("命中同哈希素材时复用，不写新 blob", async () => {
    const existing = asset({ id: 9 });
    findMediaAssetByContentHash.mockResolvedValueOnce(existing);
    const store = fakeStore();
    const result = await storeDeduplicatedMedia({} as D1Database, store, {
      bytes,
      mimeType: "image/png",
      mediaType: "photo",
      fileName: "a.png",
    });
    expect(result.deduplicated).toBe(true);
    expect(result.asset.id).toBe(9);
    expect(store.puts).toHaveLength(0);
    expect(createMediaAsset).not.toHaveBeenCalled();
  });

  it("未命中时按内容寻址 key 落一份 blob 并记录哈希", async () => {
    findMediaAssetByContentHash.mockResolvedValueOnce(null);
    createMediaAsset.mockImplementationOnce(async (_db: unknown, input: Record<string, unknown>) =>
      asset({ id: 12, ...input, contentHash: input.contentHash as string }),
    );
    const store = fakeStore();
    const result = await storeDeduplicatedMedia({} as D1Database, store, {
      bytes,
      mimeType: "image/png",
      mediaType: "photo",
      fileName: "a.png",
    });
    const hash = await sha256Hex(bytes);
    expect(result.deduplicated).toBe(false);
    expect(store.puts).toEqual([contentBlobKey(hash)]);
    expect(createMediaAsset).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ storageKey: contentBlobKey(hash), contentHash: hash, scope: "survey" }),
    );
  });
});
