import { beforeEach, describe, expect, it, vi } from "vitest";

const repositoryMocks = vi.hoisted(() => ({
  createMediaAsset: vi.fn(),
  listTemporaryMediaByResponse: vi.fn(),
  sumTemporaryMediaBytesForResponse: vi.fn(),
  expireMediaAsset: vi.fn(),
}));

vi.mock("../../../src/db/repositories/media.repository", () => ({
  createMediaAsset: repositoryMocks.createMediaAsset,
  listTemporaryMediaByResponse: repositoryMocks.listTemporaryMediaByResponse,
  sumTemporaryMediaBytesForResponse: repositoryMocks.sumTemporaryMediaBytesForResponse,
  expireMediaAsset: repositoryMocks.expireMediaAsset,
}));

import {
  cleanupExpiredTemporaryMedia,
  deleteTemporaryMediaForResponse,
  readTemporaryMedia,
  storeTemporaryMedia,
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
    expect(repositoryMocks.expireMediaAsset).toHaveBeenCalledWith(
      db,
      1,
      "2026-08-22T00:00:00.000Z",
    );
    expect(repositoryMocks.expireMediaAsset).toHaveBeenCalledWith(
      db,
      2,
      "2026-08-22T00:00:00.000Z",
    );
  });
});
