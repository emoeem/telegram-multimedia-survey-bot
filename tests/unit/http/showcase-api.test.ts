import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  listShowcasePersons: vi.fn(),
  listShowcasePersonsCursor: vi.fn(),
  getPublishedShowcasePersonIdForAsset: vi.fn(),
  getPublishedShowcaseItemById: vi.fn(),
  getMediaAssetById: vi.fn(),
  buildMediaResponse: vi.fn(),
}));

vi.mock("../../../src/db/repositories/showcase.repository", () => ({
  listShowcasePersons: mocks.listShowcasePersons,
  listShowcasePersonsCursor: mocks.listShowcasePersonsCursor,
  getPublishedShowcasePersonIdForAsset: mocks.getPublishedShowcasePersonIdForAsset,
  getPublishedShowcaseItemById: mocks.getPublishedShowcaseItemById,
}));

vi.mock("../../../src/db/repositories/media.repository", () => ({
  getMediaAssetById: mocks.getMediaAssetById,
}));

vi.mock("../../../src/services/media/media-serve.service", () => ({
  buildMediaResponse: mocks.buildMediaResponse,
}));

import { handleShowcaseApiRequest } from "../../../src/http/showcase-api";
import type { Env } from "../../../src/index";
import type { ShowcasePersonWithItems } from "../../../src/db/schema";

const env = { DB: {} as D1Database, WEBHOOK_SECRET: "local-test-secret" } as unknown as Env;

function person(overrides: Partial<ShowcasePersonWithItems> = {}): ShowcasePersonWithItems {
  return {
    id: 1,
    name: "月见",
    subtitle: "插画师",
    description: "画一些夜色里的角色",
    accentColor: "#7c8cff",
    backgroundFrom: "#182042",
    backgroundTo: "#05070d",
    backgroundMediaId: null,
    illustrationMediaId: 901,
    avatarMediaId: null,
    backgroundUrl: "https://cdn.example/bg.png",
    illustrationUrl: null,
    tags: ["插画"],
    links: [{ type: "github", label: "GitHub", url: "https://github.com/example" }],
    surveyId: 12,
    responseId: null,
    ownerUserId: 7,
    featureRank: 0,
    published: true,
    sortOrder: 0,
    createdBy: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    items: [
      {
        id: 5,
        personId: 1,
        title: "夜色",
        description: null,
        kind: "image",
        coverMediaId: 902,
        coverUrl: null,
        mediaAssetId: null,
        url: "https://example.com/art",
        featured: true,
        sortOrder: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

describe("public showcase API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listShowcasePersons.mockResolvedValue({ persons: [person()], total: 1 });
    mocks.listShowcasePersonsCursor.mockResolvedValue({
      persons: [person()],
      hasMore: false,
      nextCreatedAt: null,
      nextId: null,
    });
  });

  it("asks the repository for published people only and serves media URLs", async () => {
    const response = await handleShowcaseApiRequest(
      new Request("https://example.test/api/showcase?limit=10&offset=0"),
      env,
      new URL("https://example.test/api/showcase?limit=10&offset=0"),
    );
    expect(response?.status).toBe(200);
    expect(mocks.listShowcasePersons).toHaveBeenCalledWith(expect.anything(), {
      publishedOnly: true,
      limit: 10,
      offset: 0,
    });
    const body = (await response!.json()) as {
      items: Array<Record<string, unknown>>;
      total: number;
    };
    expect(body.total).toBe(1);
    const item = body.items[0]!;
    // Uploads are served through the public media route, external URLs pass through.
    expect(item.illustrationUrl).toBe("/api/showcase/media/901");
    expect((item.background as Record<string, unknown>).imageUrl).toBe("https://cdn.example/bg.png");
    expect((item.items as Array<Record<string, unknown>>)[0]!.coverUrl).toBe("/api/showcase/media/902");
    expect(item.surveyId).toBe(12);
    // Internal bookkeeping never reaches a public payload.
    expect(item.ownerUserId).toBeUndefined();
    expect(item.createdBy).toBeUndefined();
    expect(item.responseId).toBeUndefined();
  });

  it("applies the default page size when no limit param is given", async () => {
    // Number(null) is 0 — a naive parse would clamp the missing default to 1
    // and every plain GET /api/showcase would serve a single person.
    const response = await handleShowcaseApiRequest(
      new Request("https://example.test/api/showcase"),
      env,
      new URL("https://example.test/api/showcase"),
    );
    expect(response?.status).toBe(200);
    expect(mocks.listShowcasePersons).toHaveBeenCalledWith(expect.anything(), {
      publishedOnly: true,
      limit: 100,
      offset: 0,
    });
    const body = (await response!.json()) as { limit: number; offset: number };
    expect(body.limit).toBe(100);
    expect(body.offset).toBe(0);
  });

  it("supports cursor mode and returns an opaque nextCursor", async () => {
    mocks.listShowcasePersonsCursor.mockResolvedValue({
      persons: [person({ id: 24, createdAt: "2026-01-02T00:00:00.000Z" })],
      hasMore: true,
      nextCreatedAt: "2026-01-02T00:00:00.000Z",
      nextId: 24,
    });
    const response = await handleShowcaseApiRequest(
      new Request("https://example.test/api/showcase?cursor=&limit=24"),
      env,
      new URL("https://example.test/api/showcase?cursor=&limit=24"),
    );
    expect(response?.status).toBe(200);
    expect(mocks.listShowcasePersonsCursor).toHaveBeenCalledWith(expect.anything(), {
      publishedOnly: true,
      limit: 24,
      cursor: null,
    });
    const body = (await response!.json()) as { items: unknown[]; nextCursor: string | null };
    expect(body.items).toHaveLength(1);
    expect(body.nextCursor).toEqual(expect.any(String));
  });

  it.each(["0", "201", "abc"])("rejects cursor limit %s", async (limit) => {
    const response = await handleShowcaseApiRequest(
      new Request(`https://example.test/api/showcase?cursor=&limit=${limit}`),
      env,
      new URL(`https://example.test/api/showcase?cursor=&limit=${limit}`),
    );
    expect(response?.status).toBe(400);
  });

  it("rejects forged and expired cursors at the API boundary", async () => {
    const response = await handleShowcaseApiRequest(
      new Request("https://example.test/api/showcase?cursor=forged&limit=24"),
      env,
      new URL("https://example.test/api/showcase?cursor=forged&limit=24"),
    );
    expect(response?.status).toBe(400);
  });

  it("treats blank and non-numeric paging params as absent", async () => {
    const response = await handleShowcaseApiRequest(
      new Request("https://example.test/api/showcase?limit=&offset=abc"),
      env,
      new URL("https://example.test/api/showcase?limit=&offset=abc"),
    );
    expect(response?.status).toBe(200);
    expect(mocks.listShowcasePersons).toHaveBeenCalledWith(expect.anything(), {
      publishedOnly: true,
      limit: 100,
      offset: 0,
    });
  });

  it("refuses artwork that no published person references", async () => {
    mocks.getPublishedShowcasePersonIdForAsset.mockResolvedValue(null);
    const response = await handleShowcaseApiRequest(
      new Request("https://example.test/api/showcase/media/901"),
      env,
      new URL("https://example.test/api/showcase/media/901"),
    );
    expect(response?.status).toBe(404);
    expect(mocks.getMediaAssetById).not.toHaveBeenCalled();
  });

  it("serves published artwork with a public cache header", async () => {
    mocks.getPublishedShowcasePersonIdForAsset.mockResolvedValue(1);
    mocks.getMediaAssetById.mockResolvedValue({ id: 901, url: "data:image/png;base64,AA==" });
    const built = new Response("bytes", { headers: { "Content-Type": "image/png" } });
    mocks.buildMediaResponse.mockResolvedValue(built);

    const response = await handleShowcaseApiRequest(
      new Request("https://example.test/api/showcase/media/901"),
      env,
      new URL("https://example.test/api/showcase/media/901"),
    );
    expect(response?.status).toBe(200);
    expect(response?.headers.get("Cache-Control")).toBe("public, max-age=3600");
  });

  it("still answers with JSON when the storage backend is gone", async () => {
    mocks.getPublishedShowcasePersonIdForAsset.mockResolvedValue(1);
    mocks.getMediaAssetById.mockResolvedValue({ id: 901 });
    mocks.buildMediaResponse.mockResolvedValue(null);
    const response = await handleShowcaseApiRequest(
      new Request("https://example.test/api/showcase/media/901"),
      env,
      new URL("https://example.test/api/showcase/media/901"),
    );
    expect(response?.status).toBe(410);
    expect(((await response!.json()) as { code: string }).code).toBe("gone");
  });

  // 文字作品（文章 / 小说）：feed 只给预览，全文在这个接口取。
  it("serves the full text of a published work", async () => {
    mocks.getPublishedShowcaseItemById.mockResolvedValue({
      personId: 1,
      item: {
        id: 5,
        personId: 1,
        title: "长夜将明",
        description: "夜".repeat(600),
        kind: "article",
        coverMediaId: null,
        coverUrl: null,
        url: "https://example.com/novel",
        featured: true,
        sortOrder: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    });
    const response = await handleShowcaseApiRequest(
      new Request("https://example.test/api/showcase/items/5"),
      env,
      new URL("https://example.test/api/showcase/items/5"),
    );
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toMatchObject({
      item: { id: 5, personId: 1, title: "长夜将明", descriptionTruncated: false, url: "https://example.com/novel" },
    });
    const body = (await (await handleShowcaseApiRequest(
      new Request("https://example.test/api/showcase/items/5"),
      env,
      new URL("https://example.test/api/showcase/items/5"),
    ))!.json()) as { item: { description: string } };
    expect(body.item.description).toHaveLength(600);
  });

  it("hides the text of a work whose person is not published", async () => {
    mocks.getPublishedShowcaseItemById.mockResolvedValue(null);
    const response = await handleShowcaseApiRequest(
      new Request("https://example.test/api/showcase/items/5"),
      env,
      new URL("https://example.test/api/showcase/items/5"),
    );
    expect(response?.status).toBe(404);
  });

  it("ignores requests outside the showcase namespace", async () => {
    const response = await handleShowcaseApiRequest(
      new Request("https://example.test/api/plaza/posts"),
      env,
      new URL("https://example.test/api/plaza/posts"),
    );
    expect(response).toBeNull();
  });
});
