import { afterEach, describe, expect, it, vi } from "vitest";

import {
  deleteImage,
  imageDeliveryUrl,
  imagesConfigured,
  uploadImage,
} from "../../../src/services/media/images.service";

const ENV = { IMAGES_ACCOUNT_ID: "acct", IMAGES_DELIVERY_HASH: "hash", CLOUDFLARE_API_TOKEN: "tok" };
const BYTES = new Uint8Array([137, 80, 78, 71]);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("imagesConfigured", () => {
  it("三项配置齐备才算配置", () => {
    expect(imagesConfigured(ENV)).toBe(true);
    expect(imagesConfigured({ ...ENV, CLOUDFLARE_API_TOKEN: "" })).toBe(false);
    expect(imagesConfigured({})).toBe(false);
  });
});

describe("imageDeliveryUrl", () => {
  it("拼接 imagedelivery 交付地址", () => {
    expect(imageDeliveryUrl(ENV, "img-1")).toBe("https://imagedelivery.net/hash/img-1/public");
    expect(imageDeliveryUrl(ENV, "img-1", "thumb")).toBe("https://imagedelivery.net/hash/img-1/thumb");
  });
});

describe("uploadImage", () => {
  it("上传字节并返回 imageId 与交付地址", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { success: true, result: { id: "img-9" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await uploadImage(ENV, { bytes: BYTES, name: "card.png", contentType: "image/png" });
    expect(result).toEqual({ imageId: "img-9", url: "https://imagedelivery.net/hash/img-9/public" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/acct/images/v1");
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
  });

  it("API 报错抛出带状态码的异常", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(413, { success: false, errors: [{ message: "too large" }] })),
    );
    await expect(uploadImage(ENV, { bytes: BYTES, name: "a.png", contentType: "image/png" })).rejects.toThrow(
      "too large",
    );
  });
});

describe("deleteImage", () => {
  it("404 视为已删除", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nf", { status: 404 })),
    );
    await expect(deleteImage(ENV, "img-x")).resolves.toBeUndefined();
  });

  it("其他非 2xx 抛错", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 500 })),
    );
    await expect(deleteImage(ENV, "img-x")).rejects.toThrow("500");
  });
});
