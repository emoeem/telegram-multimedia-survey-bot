import { beforeEach, describe, expect, it, vi } from "vitest";

const repositoryMocks = vi.hoisted(() => ({
  getMediaAssetById: vi.fn(),
  getMediaAssetsByIds: vi.fn(),
}));

vi.mock("../../../src/db/repositories/media.repository", () => ({
  getMediaAssetById: repositoryMocks.getMediaAssetById,
  getMediaAssetsByIds: repositoryMocks.getMediaAssetsByIds,
}));

import {
  resolveMediaAssetDataUrl,
  resolveReportProfileImages,
} from "../../../src/services/report/report-images.service";
import type { ResultProfileSnapshot } from "../../../src/result/schema";

/**
 * Regression guard for "❌ 报告归档失败：Key name cannot be empty.".
 *
 * When the retention sweep expires an asset it nulls `storage_key`. The report
 * archive then called `KV.get(asset.storageKey ?? "")`, and KV rejects an empty
 * key — so one already-deleted photo failed the whole archive instead of being
 * skipped. The doc contract is "unavailable images are skipped".
 */
function asset(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    scope: "response",
    mediaType: "photo",
    telegramFileId: null,
    telegramFileUniqueId: null,
    url: null,
    storageKind: "temporary",
    storageKey: null,
    r2Key: null,
    mimeType: "image/png",
    fileName: null,
    fileSize: null,
    width: null,
    height: null,
    expiresAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** KV stub that throws exactly like Cloudflare does for an empty key. */
function kvStub(value: Uint8Array | null = null) {
  const get = vi.fn(async (key: string) => {
    if (!key) throw new Error("Key name cannot be empty.");
    return value ? value.buffer.slice(0) : null;
  });
  return { get };
}

function envWith(kv: { get: unknown }) {
  return {
    DB: {} as D1Database,
    BOT_TOKEN: "test-token",
    MEDIA_KV: kv as unknown as KVNamespace,
  };
}

describe("report image resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips an asset whose storage key was cleared instead of throwing", async () => {
    repositoryMocks.getMediaAssetById.mockResolvedValue(asset({ storageKey: null }));
    const kv = kvStub(new Uint8Array([1, 2, 3]));

    await expect(resolveMediaAssetDataUrl(envWith(kv), 1)).resolves.toBeNull();
    // The empty key must never reach KV — that call is what broke archiving.
    expect(kv.get).not.toHaveBeenCalled();
  });

  it("still returns a data URL for a readable temporary asset", async () => {
    repositoryMocks.getMediaAssetById.mockResolvedValue(asset({ storageKey: "media:temp:42:abc" }));
    const kv = kvStub(new Uint8Array([1, 2, 3]));

    await expect(resolveMediaAssetDataUrl(envWith(kv), 1)).resolves.toMatch(/^data:image\/png;base64,/);
    expect(kv.get).toHaveBeenCalledWith("media:temp:42:abc", "arrayBuffer");
  });

  it("keeps the other images when one asset read throws", async () => {
    // The doc contract is "unavailable images are skipped so archiving never
    // fails"; a single storage error must not abort the whole report.
    repositoryMocks.getMediaAssetsByIds.mockResolvedValue(
      new Map([
        [1, asset({ id: 1, storageKey: "media:temp:42:bad" })],
        [2, asset({ id: 2, storageKey: "media:temp:42:good" })],
      ]),
    );
    const kv = {
      get: vi.fn(async (key: string) => {
        if (key.endsWith(":bad")) throw new Error("KV unavailable");
        return new Uint8Array([1, 2, 3]).buffer.slice(0);
      }),
    };
    const profile = {
      schemaVersion: 1,
      resultType: "survey_result",
      title: "t",
      fields: {},
      stats: [],
      tags: [],
      images: { first: { mediaAssetId: 1 }, second: { mediaAssetId: 2 } },
      metadata: {},
    } as unknown as ResultProfileSnapshot;

    const resolved = await resolveReportProfileImages(envWith(kv), profile);

    expect(resolved.first ?? null).toBeNull();
    expect(resolved.second).toMatch(/^data:image\/png;base64,/);
  });

  it("skips an R2 asset with no key rather than fetching an empty object", async () => {
    repositoryMocks.getMediaAssetById.mockResolvedValue(
      asset({ storageKind: "r2", storageKey: null, r2Key: null }),
    );
    const r2Get = vi.fn(async () => null);

    await expect(
      resolveMediaAssetDataUrl({ ...envWith(kvStub()), MEDIA: { get: r2Get } as unknown as R2Bucket }, 1),
    ).resolves.toBeNull();
    expect(r2Get).not.toHaveBeenCalled();
  });
});
