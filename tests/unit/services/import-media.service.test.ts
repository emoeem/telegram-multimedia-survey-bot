import { afterEach, describe, expect, it, vi } from "vitest";

import { createImportMediaResolver } from "../../../src/services/import-media.service";

function createKvMock() {
  return {
    put: vi.fn(async () => undefined),
    get: vi.fn(async () => null),
    delete: vi.fn(async () => undefined),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createImportMediaResolver", () => {
  it("caches data URL media into KV", async () => {
    const kv = createKvMock();
    const resolver = createImportMediaResolver({
      MEDIA_KV: kv as unknown as KVNamespace,
    });

    const resolved = await resolver({
      type: "photo",
      source: "url",
      url: "data:image/png;base64,aGVsbG8=",
      fileName: "img.png",
      width: 100,
      height: 50,
    });

    expect(resolved?.storageKind).toBe("temporary");
    expect(resolved?.storageKey).toMatch(/^media:import:/);
    expect(resolved?.mimeType).toBe("image/png");
    expect(resolved?.size).toBe(5);
    expect(kv.put).toHaveBeenCalledTimes(1);
  });

  it("fetches and caches publicly shared Microsoft form images", async () => {
    const kv = createKvMock();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new Uint8Array([1, 2, 3, 4]), {
            status: 200,
            headers: { "Content-Type": "image/jpeg" },
          }),
      ),
    );
    const resolver = createImportMediaResolver({
      MEDIA_KV: kv as unknown as KVNamespace,
    });

    const resolved = await resolver({
      type: "photo",
      source: "url",
      url: "https://hive.forms.usercontent.microsoft/images/x/y.jpg",
    });

    expect(resolved?.storageKind).toBe("temporary");
    expect(resolved?.storageKey).toMatch(/^media:import:/);
    expect(resolved?.mimeType).toBe("image/jpeg");
    expect(resolved?.size).toBe(4);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("leaves non-Microsoft remote media unchanged", async () => {
    const kv = createKvMock();
    const resolver = createImportMediaResolver({
      MEDIA_KV: kv as unknown as KVNamespace,
    });
    const media = {
      type: "photo" as const,
      source: "url" as const,
      url: "https://example.com/pic.jpg",
    };

    expect(await resolver(media)).toBe(media);
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("falls back to the remote URL when fetching fails", async () => {
    const kv = createKvMock();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 500 })),
    );
    const resolver = createImportMediaResolver({
      MEDIA_KV: kv as unknown as KVNamespace,
    });
    const media = {
      type: "photo" as const,
      source: "url" as const,
      url: "https://hive.forms.usercontent.microsoft/images/x/y.jpg",
    };

    expect(await resolver(media)).toBe(media);
    expect(kv.put).not.toHaveBeenCalled();
  });
});
