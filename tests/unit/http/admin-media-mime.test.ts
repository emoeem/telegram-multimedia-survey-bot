import { beforeEach, describe, expect, it, vi } from "vitest";

const { storeDeduplicatedMedia } = vi.hoisted(() => ({ storeDeduplicatedMedia: vi.fn() }));
const { createMediaStore } = vi.hoisted(() => ({ createMediaStore: vi.fn() }));

vi.mock("../../../src/services/media/media-dedup.service", () => ({ storeDeduplicatedMedia }));
vi.mock("../../../src/services/media/temporary-media-store", () => ({
  createMediaStore,
  KVMediaStore: class {},
}));

import { storeSurveyAdminMedia } from "../../../src/http/admin/helpers";

/**
 * 管理端素材上传的 MIME 规范化（与答卷媒体上传 media.ts 同一规则）：
 *  - 检测出媒体类精确签名（image/video/audio）时，入库/存储用检测 MIME——
 *    声明值可能是 audio/x-wav 这类平台别名，serve 端会原样回显；
 *  - document 家族的检测输出（zip——docx 的字节就是 zip）不能覆盖声明值，
 *    否则合法文档会被错标成 application/zip，与答卷 file 题保留声明 MIME
 *    的取舍一致。
 */
describe("storeSurveyAdminMedia · MIME 规范化", () => {
  function fakeStore() {
    return {
      kind: "temporary",
      async put() {},
      async get() {
        return null;
      },
      async delete() {},
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    storeDeduplicatedMedia.mockImplementation(async (_db, _store, input) => ({
      asset: { id: 1, mimeType: input.mimeType, deduplicated: false },
      deduplicated: false,
    }));
    createMediaStore.mockReturnValue(fakeStore());
  });

  it("声明 audio/x-wav（别名）的 WAV 用检测 MIME audio/wav 入库", async () => {
    // WAV 魔数（RIFF....WAVE）：detectContent 按 12 字节头识别为 wav。
    const wav = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45, 0x00, 0x00]);
    const file = new File([wav], "voice.wav", { type: "audio/x-wav" });

    const asset = await storeSurveyAdminMedia({} as D1Database, { MEDIA_KV: {} as KVNamespace }, file);

    expect(asset.mimeType).toBe("audio/wav");
    expect(storeDeduplicatedMedia.mock.calls[0]![2].mimeType).toBe("audio/wav");
    expect(storeDeduplicatedMedia.mock.calls[0]![2].mediaType).toBe("audio");
  });

  it("docx（zip 字节，document 家族）保持声明 MIME，不被错标成 application/zip", async () => {
    // PK\x03\x04 魔数：detectContent 识别为 zip（document 家族，family 级放行）。
    const zip = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00]);
    const file = new File([zip], "paper.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });

    const asset = await storeSurveyAdminMedia({} as D1Database, { MEDIA_KV: {} as KVNamespace }, file);

    expect(asset.mimeType).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(storeDeduplicatedMedia.mock.calls[0]![2].mediaType).toBe("document");
  });

  it("声明已是规范值（image/png）的 1x1 PNG 保持不变", async () => {
    // 结构合法的 1x1 PNG（声明 image/* 时 verifyImageUpload 会跑结构解析，
    // 需要真实图片字节；submit-api.test.ts 同款常量）。
    const png = Uint8Array.from(
      atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="),
      (char) => char.charCodeAt(0),
    );
    const file = new File([png], "cover.png", { type: "image/png" });

    const asset = await storeSurveyAdminMedia({} as D1Database, { MEDIA_KV: {} as KVNamespace }, file);

    expect(asset.mimeType).toBe("image/png");
    expect(storeDeduplicatedMedia.mock.calls[0]![2].mediaType).toBe("photo");
  });
});
