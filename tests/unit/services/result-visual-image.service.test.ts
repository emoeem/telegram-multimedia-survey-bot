import { describe, expect, it, vi } from "vitest";

const { getMediaAssetById, downloadTelegramFile } = vi.hoisted(() => ({
  getMediaAssetById: vi.fn(),
  downloadTelegramFile: vi.fn(),
}));

vi.mock("../../../src/db/repositories/media.repository", () => ({ getMediaAssetById }));
vi.mock("../../../src/bot/telegram", () => ({ downloadTelegramFile }));

import { resolveResultVisualImages } from "../../../src/services/result-visual-image.service";
import { TEMPLATE_BACKGROUND_IMAGE_KEY } from "../../../src/services/result-visual-renderer.service";
import type { ResultProfileSnapshot } from "../../../src/result/schema";
import type { VisualTemplateDefinition } from "../../../src/visual-template/schema";

const template: VisualTemplateDefinition = {
  schemaVersion: 1,
  width: 1080,
  height: 1920,
  format: "png",
  background: { type: "telegram_asset", assetId: 7, fit: "cover" },
  variables: [{ path: "result.images.avatar", label: "头像", type: "image" }],
  elements: [{ id: "avatar", type: "image", source: "{{result.images.avatar}}", x: 0, y: 0, width: 100, height: 100 }],
};

const profile: ResultProfileSnapshot = {
  resultType: "demo", title: "结果", subtitle: null, schemaVersion: 1,
  fields: {}, stats: [], tags: [], metadata: {},
  images: { avatar: { telegramFileId: "avatar-file" } },
};

describe("result visual Telegram image resolver", () => {
  it("downloads the stored background asset and profile image directly from Telegram", async () => {
    getMediaAssetById.mockResolvedValue({
      id: 7, mediaType: "photo", telegramFileId: "background-file", mimeType: "image/jpeg", fileSize: 1024,
    });
    downloadTelegramFile.mockImplementation(async (_token: string, fileId: string) => ({
      data: new Uint8Array(fileId === "background-file" ? [1, 2] : [3, 4]),
      contentType: "image/jpeg",
      filePath: "photos/test.jpg",
    }));

    const images = await resolveResultVisualImages({} as D1Database, "token", template, profile);

    expect(downloadTelegramFile).toHaveBeenCalledWith("token", "background-file");
    expect(downloadTelegramFile).toHaveBeenCalledWith("token", "avatar-file");
    expect(images[TEMPLATE_BACKGROUND_IMAGE_KEY]).toMatch(/^data:image\/jpeg;base64,/);
    expect(images["result.images.avatar"]).toMatch(/^data:image\/jpeg;base64,/);
  });

  it("recognizes a Telegram JPG even when the download response omits an image MIME type", async () => {
    getMediaAssetById.mockResolvedValue({
      id: 7, mediaType: "photo", telegramFileId: "background-file", mimeType: null, fileSize: 1024,
    });
    downloadTelegramFile.mockImplementation(async (_token: string, fileId: string) => ({
      data: fileId === "background-file"
        ? new Uint8Array([0xff, 0xd8, 0xff, 0xe0])
        : new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
      contentType: "application/octet-stream",
      filePath: "photos/file_123.jpg",
    }));

    const images = await resolveResultVisualImages({} as D1Database, "token", template, profile);

    expect(images[TEMPLATE_BACKGROUND_IMAGE_KEY]).toMatch(/^data:image\/jpeg;base64,/);
    expect(images["result.images.avatar"]).toMatch(/^data:image\/jpeg;base64,/);
  });

  it("allows an 8000x6000 source image for browser-side report resizing", async () => {
    getMediaAssetById.mockResolvedValue({
      id: 7, mediaType: "photo", telegramFileId: "background-file", mimeType: "image/jpeg", fileSize: 7 * 1024 * 1024, width: 8000, height: 6000,
    });
    downloadTelegramFile.mockResolvedValue({ data: new Uint8Array([0xff, 0xd8, 0xff]), contentType: "image/jpeg", filePath: "photos/large.jpg" });
    const images = await resolveResultVisualImages({} as D1Database, "token", template, profile);
    expect(images[TEMPLATE_BACKGROUND_IMAGE_KEY]).toMatch(/^data:image\/jpeg;base64,/);
  });
});
