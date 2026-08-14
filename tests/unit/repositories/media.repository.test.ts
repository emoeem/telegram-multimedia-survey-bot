import { describe, expect, it, vi } from "vitest";

import { createMediaAsset } from "../../../src/db/repositories/media.repository";

interface StatementMock {
  bind: ReturnType<typeof vi.fn>;
  first: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
}

function createD1Mock(): D1Database {
  const now = "2026-08-14T00:00:00.000Z";
  const statement: StatementMock = {
    bind: vi.fn(() => statement),
    first: vi.fn(async () => ({
      id: 9,
      media_type: "photo",
      telegram_file_id: "file-id",
      telegram_file_unique_id: "unique-id",
      mime_type: "image/jpeg",
      file_name: null,
      file_size: 100,
      width: 800,
      height: 600,
      duration: null,
      r2_key: null,
      created_at: now,
      updated_at: now,
    })),
    run: vi.fn(async () => ({
      success: true,
      meta: { last_row_id: 9 },
    })),
  };

  return {
    prepare: vi.fn(() => statement),
  } as unknown as D1Database;
}

describe("media repository", () => {
  it("creates and maps a media asset", async () => {
    const db = createD1Mock();

    const asset = await createMediaAsset(db, {
      mediaType: "photo",
      telegramFileId: "file-id",
      telegramFileUniqueId: "unique-id",
      mimeType: "image/jpeg",
      fileSize: 100,
      width: 800,
      height: 600,
    });

    expect(asset.id).toBe(9);
    expect(asset.mediaType).toBe("photo");
    expect(asset.telegramFileUniqueId).toBe("unique-id");
  });
});
