import { beforeEach, describe, expect, it, vi } from "vitest";

const { createMediaAsset } = vi.hoisted(() => ({ createMediaAsset: vi.fn() }));
const { createMediaStore } = vi.hoisted(() => ({ createMediaStore: vi.fn() }));

vi.mock("../../../src/db/repositories/media.repository", () => ({
  createMediaAsset,
  expireMediaAsset: vi.fn(),
  getMediaAssetById: vi.fn(),
}));
vi.mock("../../../src/db/repositories/plaza-post.repository", () => ({
  detachPlazaPostImage: vi.fn(),
  getPlazaPostImageAssetId: vi.fn(),
}));
// 树洞配图只消费 store.kind / store.put / store.delete；put 捕获 contentType。
vi.mock("../../../src/services/media/temporary-media-store", () => ({
  createMediaStore,
  KVMediaStore: class {},
}));

import { storePlazaPostImage } from "../../../src/services/plaza-media.service";

/**
 * 树洞配图的 MIME 规范化（与答卷媒体上传 media.ts 同一规则）：放行后
 * 入库/存储统一用检测出的规范 MIME——声明值可能是 image/jpg 这类别名，
 * serve 端会把存储值原样回显成 Content-Type。
 */
describe("storePlazaPostImage · MIME 规范化", () => {
  function fakeStore() {
    const puts: { storageKey: string; contentType: string }[] = [];
    return {
      kind: "temporary",
      puts,
      async put(input: { storageKey: string; contentType: string }) {
        puts.push(input);
      },
      async get() {
        return null;
      },
      async delete() {},
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    createMediaAsset.mockResolvedValue({ id: 1 });
  });

  it("声明 image/jpg（别名）的 JPEG 落库与 KV 写入均为 image/jpeg", async () => {
    const store = fakeStore();
    createMediaStore.mockReturnValue(store);
    // JPEG 魔数（SOI + JFIF APP0 头）：verifyUploadContent 按 SOI 识别为 jpeg。
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
    const file = new File([jpeg], "photo.jpg", { type: "image/jpg" });

    const result = await storePlazaPostImage({ DB: {} as D1Database, MEDIA_KV: {} as KVNamespace }, file);

    expect(result).toHaveProperty("asset");
    expect(createMediaAsset).toHaveBeenCalledTimes(1);
    expect(createMediaAsset.mock.calls[0]![1].mimeType).toBe("image/jpeg");
    expect(store.puts[0]!.contentType).toBe("image/jpeg");
  });

  it("声明已是规范值（image/png）的 PNG 保持不变", async () => {
    const store = fakeStore();
    createMediaStore.mockReturnValue(store);
    // PNG 魔数 + IHDR 前缀：detectContent 按 8 字节签名识别为 png。
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
    const file = new File([png], "photo.png", { type: "image/png" });

    const result = await storePlazaPostImage({ DB: {} as D1Database, MEDIA_KV: {} as KVNamespace }, file);

    expect(result).toHaveProperty("asset");
    expect(createMediaAsset.mock.calls[0]![1].mimeType).toBe("image/png");
    expect(store.puts[0]!.contentType).toBe("image/png");
  });

  it("HTML 字节冒充图片仍被拒绝（字节签名门不受本次改动影响）", async () => {
    const html = new TextEncoder().encode("<html><body>x</body></html>");
    const file = new File([html], "evil.png", { type: "image/png" });

    const result = await storePlazaPostImage({ DB: {} as D1Database, MEDIA_KV: {} as KVNamespace }, file);

    expect(result).toHaveProperty("error");
    expect(createMediaAsset).not.toHaveBeenCalled();
  });
});
