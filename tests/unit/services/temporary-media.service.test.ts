import { beforeEach, describe, expect, it, vi } from "vitest";

const repositoryMocks = vi.hoisted(() => ({
  createMediaAsset: vi.fn(),
  listTemporaryMediaByResponse: vi.fn(),
  listResponseMediaForPromotion: vi.fn(),
  listRetainableCompletedMedia: vi.fn(),
  markMediaAssetDurable: vi.fn(),
  sumTemporaryMediaBytesForResponse: vi.fn(),
  expireMediaAsset: vi.fn(),
}));

vi.mock("../../../src/db/repositories/media.repository", () => ({
  createMediaAsset: repositoryMocks.createMediaAsset,
  listTemporaryMediaByResponse: repositoryMocks.listTemporaryMediaByResponse,
  listResponseMediaForPromotion: repositoryMocks.listResponseMediaForPromotion,
  listRetainableCompletedMedia: repositoryMocks.listRetainableCompletedMedia,
  markMediaAssetDurable: repositoryMocks.markMediaAssetDurable,
  sumTemporaryMediaBytesForResponse: repositoryMocks.sumTemporaryMediaBytesForResponse,
  expireMediaAsset: repositoryMocks.expireMediaAsset,
}));

import {
  cleanupExpiredTemporaryMedia,
  deleteTemporaryMediaForResponse,
  DURABLE_RESPONSE_MEDIA_PREFIX,
  promoteResponseMediaToDurable,
  readTemporaryMedia,
  retainFinishedResponseMedia,
  storeTemporaryMedia,
  TEMP_MEDIA_KV_BACKSTOP_SECONDS,
  TEMP_MEDIA_TTL_SECONDS,
} from "../../../src/services/media/temporary-media.service";
import { KVMediaStore } from "../../../src/services/media/temporary-media-store";

describe("temporary media lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stores the blob in KV and records a temporary asset with expiry", async () => {
    const kvPut = vi.fn(async (_key: string, _value: Uint8Array) => {});
    const store = new KVMediaStore({ put: kvPut, get: vi.fn(), delete: vi.fn() } as unknown as KVNamespace);
    repositoryMocks.createMediaAsset.mockResolvedValue({ id: 7 });

    const asset = await storeTemporaryMedia({} as D1Database, store, {
      responseId: 42,
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "image/png",
      fileName: "photo.png",
    });

    expect(asset.id).toBe(7);
    const storedKey = kvPut.mock.calls[0]?.[0] as string;
    expect(storedKey).toMatch(/^media:temp:42:/);
    expect(repositoryMocks.createMediaAsset).toHaveBeenCalledWith(
      {} as D1Database,
      expect.objectContaining({
        scope: "response",
        mediaType: "photo",
        storageKind: "temporary",
        storageKey: storedKey,
        expiresAt: expect.any(String),
        fileSize: 3,
      }),
    );
  });

  it("keeps the KV backstop well beyond the media TTL so rescue has time", async () => {
    const kvPut = vi.fn(async (_key: string, _value: Uint8Array, _options?: { expirationTtl?: number }) => {});
    const store = new KVMediaStore({ put: kvPut, get: vi.fn(), delete: vi.fn() } as unknown as KVNamespace);
    repositoryMocks.createMediaAsset.mockResolvedValue({ id: 8 });

    await storeTemporaryMedia({} as D1Database, store, {
      responseId: 43,
      bytes: new Uint8Array([1]),
      mimeType: "image/png",
      fileName: null,
    });

    const options = kvPut.mock.calls[0]?.[2] as { expirationTtl?: number } | undefined;
    // The daily retention sweep can only promote a completed response's photo
    // while the blob exists, so the KV window must not equal the media TTL.
    expect(options?.expirationTtl).toBe(TEMP_MEDIA_KV_BACKSTOP_SECONDS);
    expect(TEMP_MEDIA_KV_BACKSTOP_SECONDS).toBeGreaterThan(TEMP_MEDIA_TTL_SECONDS);
  });

  it("deletes blobs and detaches references for a response", async () => {
    const kvDelete = vi.fn(async (_key: string) => {});
    const store = new KVMediaStore({ put: vi.fn(), get: vi.fn(), delete: kvDelete } as unknown as KVNamespace);
    repositoryMocks.listTemporaryMediaByResponse.mockResolvedValue([
      { id: 1, storageKey: "media:temp:42:a", expiresAt: null },
      { id: 2, storageKey: "media:temp:42:b", expiresAt: null },
    ]);

    const deleted = await deleteTemporaryMediaForResponse({} as D1Database, store, 42);

    expect(deleted).toBe(2);
    expect(kvDelete).toHaveBeenCalledTimes(2);
    expect(repositoryMocks.expireMediaAsset).toHaveBeenCalledTimes(2);
  });

  it("skips store reads for expired assets", async () => {
    const kvGet = vi.fn(async (_key: string) => new Uint8Array([1]).buffer as ArrayBuffer);
    const store = new KVMediaStore({ put: vi.fn(), get: kvGet, delete: vi.fn() } as unknown as KVNamespace);
    const data = await readTemporaryMedia(store, {
      storageKey: "media:temp:42:a",
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    expect(data).toBeNull();
    expect(kvGet).not.toHaveBeenCalled();
  });

  it("cleans expired temporary media in a bounded batch", async () => {
    const kvDelete = vi.fn(async (_key: string) => {});
    const store = new KVMediaStore({ put: vi.fn(), get: vi.fn(), delete: kvDelete } as unknown as KVNamespace);
    const statement = {
      bind: vi.fn(() => statement),
      all: vi.fn(async () => ({
        results: [
          { id: 1, storageKey: "media:temp:9:x" },
          { id: 2, storageKey: null },
        ],
      })),
    };
    const db = { prepare: vi.fn(() => statement) } as unknown as D1Database;

    const summary = await cleanupExpiredTemporaryMedia(db, store, new Date("2026-08-22T00:00:00.000Z"));

    expect(summary).toEqual({ scanned: 2, deleted: 1 });
    expect(kvDelete).toHaveBeenCalledWith("media:temp:9:x");
    expect(repositoryMocks.expireMediaAsset).toHaveBeenCalledWith(db, 1, "2026-08-22T00:00:00.000Z");
    expect(repositoryMocks.expireMediaAsset).toHaveBeenCalledWith(db, 2, "2026-08-22T00:00:00.000Z");
  });

  it("moves a completed response's blobs out of the temporary namespace", async () => {
    const kvPut = vi.fn(async (_key: string, _value: Uint8Array) => {});
    const kvDelete = vi.fn(async (_key: string) => {});
    const store = new KVMediaStore({
      put: kvPut,
      get: vi.fn(async () => new Uint8Array([1, 2, 3]).buffer as ArrayBuffer),
      delete: kvDelete,
    } as unknown as KVNamespace);
    repositoryMocks.listResponseMediaForPromotion.mockResolvedValue([
      { id: 5, storageKey: "media:temp:42:a", expiresAt: "2026-09-01T00:00:00.000Z", mimeType: "image/png" },
    ]);

    const summary = await promoteResponseMediaToDurable({} as D1Database, store, 42);

    expect(summary).toEqual({ promoted: 1, alreadyDurable: 0, discarded: 0 });
    const durableKey = kvPut.mock.calls[0]?.[0] as string;
    expect(durableKey).toMatch(new RegExp(`^${DURABLE_RESPONSE_MEDIA_PREFIX}42:`));
    expect(repositoryMocks.markMediaAssetDurable).toHaveBeenCalledWith({} as D1Database, 5, durableKey);
    expect(kvDelete).toHaveBeenCalledWith("media:temp:42:a");
    expect(repositoryMocks.expireMediaAsset).not.toHaveBeenCalled();
  });

  it("leaves already-retained media alone and detaches blobs that are gone", async () => {
    const kvPut = vi.fn(async (_key: string, _value: Uint8Array) => {});
    const store = new KVMediaStore({
      put: kvPut,
      get: vi.fn(async () => null),
      delete: vi.fn(async () => {}),
    } as unknown as KVNamespace);
    repositoryMocks.listResponseMediaForPromotion.mockResolvedValue([
      { id: 5, storageKey: "media:report:42:kept", expiresAt: null, mimeType: "image/png" },
      { id: 6, storageKey: "media:temp:42:gone", expiresAt: null, mimeType: "image/png" },
      { id: 7, storageKey: null, expiresAt: null, mimeType: null },
    ]);

    const summary = await promoteResponseMediaToDurable({} as D1Database, store, 42);

    expect(summary).toEqual({ promoted: 0, alreadyDurable: 1, discarded: 2 });
    expect(kvPut).not.toHaveBeenCalled();
    expect(repositoryMocks.markMediaAssetDurable).not.toHaveBeenCalled();
    expect(repositoryMocks.expireMediaAsset).toHaveBeenCalledTimes(2);
  });

  it("retains attachments of finished responses in one bounded sweep", async () => {
    const kvPut = vi.fn(async (_key: string, _value: Uint8Array) => {});
    const store = new KVMediaStore({
      put: kvPut,
      get: vi.fn(async () => new Uint8Array([4, 5]).buffer as ArrayBuffer),
      delete: vi.fn(async () => {}),
    } as unknown as KVNamespace);
    repositoryMocks.listRetainableCompletedMedia.mockResolvedValue([
      {
        id: 11,
        responseId: 70,
        storageKey: "media:temp:70:a",
        expiresAt: "2026-09-01T00:00:00.000Z",
        mimeType: "image/png",
      },
      {
        id: 12,
        responseId: 71,
        storageKey: "media:temp:71:b",
        expiresAt: "2026-09-02T00:00:00.000Z",
        mimeType: "image/png",
      },
    ]);

    const summary = await retainFinishedResponseMedia({} as D1Database, store, 25);

    expect(summary).toEqual({ promoted: 2, alreadyDurable: 0, discarded: 0, responses: 2, scanned: 2 });
    expect(repositoryMocks.listRetainableCompletedMedia).toHaveBeenCalledWith({} as D1Database, 25);
    expect(kvPut.mock.calls.map((call) => call[0])).toEqual([
      expect.stringMatching(/^media:report:70:/),
      expect.stringMatching(/^media:report:71:/),
    ]);
  });
});
