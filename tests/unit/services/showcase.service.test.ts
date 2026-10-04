import { describe, expect, it } from "vitest";

import {
  normalizeShowcaseItemInput,
  normalizeShowcaseLinks,
  normalizeShowcasePersonInput,
  normalizeShowcaseTags,
  normalizeShowcaseUrl,
  toAdminShowcasePerson,
  SHOWCASE_ITEM_PREVIEW_CHARS,
  SHOWCASE_LIMITS,
  toPublicShowcaseItem,
  toPublicShowcasePerson,
} from "../../../src/services/showcase.service";
import type { ShowcaseItem, ShowcasePersonWithItems } from "../../../src/db/schema";

/**
 * The admin form is the only writer of a public, unauthenticated page, so the
 * validation lives on the server. These cover the values that would otherwise
 * be stored and rendered to every visitor.
 *
 * Failures are asserted with `toEqual({ error: expect.stringContaining(...) })`
 * rather than `.error.toContain(...)`: the normalizers return a discriminated
 * union, and reading `.error` off it does not type-check.
 */
const failure = (message: string) => ({ error: expect.stringContaining(message) });

describe("showcase person validation", () => {
  it("requires a name when creating and keeps updates partial", () => {
    expect(normalizeShowcasePersonInput({}, { creating: true })).toEqual({ error: "昵称必须是字符串" });
    expect(normalizeShowcasePersonInput({ name: "  " }, { creating: true })).toEqual({ error: "昵称不能为空" });
    expect(normalizeShowcasePersonInput({ name: "月见" }, { creating: true })).toEqual({
      value: { name: "月见" },
    });
    // An update that only toggles publication must not require (or erase) a name.
    expect(normalizeShowcasePersonInput({ published: true }, { creating: false })).toEqual({
      value: { published: true },
    });
  });

  it("trims text, caps lengths and normalizes colours", () => {
    expect(
      normalizeShowcasePersonInput(
        { name: " 月见 ", subtitle: " 插画师 ", accentColor: "#AABBCC" },
        { creating: true },
      ),
    ).toEqual({ value: { name: "月见", subtitle: "插画师", accentColor: "#aabbcc" } });

    expect(normalizeShowcasePersonInput({ name: "x".repeat(41) }, { creating: true })).toEqual(failure("不能超过"));
    expect(normalizeShowcasePersonInput({ name: "月见", accentColor: "red" }, { creating: true })).toEqual(
      failure("#RGB"),
    );
  });

  it("rejects ids that are not positive integers", () => {
    expect(normalizeShowcasePersonInput({ illustrationMediaId: -1 }, { creating: false })).toEqual(failure("正整数"));
    expect(normalizeShowcasePersonInput({ surveyId: 0 }, { creating: false })).toEqual(failure("正整数"));
    expect(normalizeShowcasePersonInput({ surveyId: null }, { creating: false })).toEqual({
      value: { surveyId: null },
    });
  });
});

describe("showcase url and link validation", () => {
  it("only allows http(s), mailto and tg links", () => {
    expect(normalizeShowcaseUrl("https://example.com/a", "链接")).toEqual({ value: "https://example.com/a" });
    expect(normalizeShowcaseUrl("mailto:me@example.com", "链接")).toEqual({ value: "mailto:me@example.com" });
    // The stored value ends up in an <a href> on a public page.
    expect(normalizeShowcaseUrl("javascript:alert(1)", "链接")).toEqual(failure("只支持 http(s)"));
    // `data:` parses as a URL but is not web content we are willing to publish.
    expect(normalizeShowcaseUrl("data:text/html,<script>", "链接")).toEqual(failure("只支持 http(s)"));
    expect(normalizeShowcaseUrl("example.com/a", "链接")).toEqual(failure("完整的 http(s) 链接"));
    expect(normalizeShowcaseUrl("", "链接")).toEqual({ value: null });
  });

  it("drops blank links, defaults the label and caps the count", () => {
    expect(
      normalizeShowcaseLinks([
        { type: "github", url: "https://github.com/a" },
        { type: "website", label: "空链接", url: "   " },
        { type: "social", label: "微博", url: "https://weibo.com/a" },
      ]),
    ).toEqual({
      value: [
        { type: "github", label: "https://github.com/a", url: "https://github.com/a" },
        { type: "social", label: "微博", url: "https://weibo.com/a" },
      ],
    });
    const tooManyLinks = Array.from({ length: 9 }, (_, index) => ({ url: `https://a${index}.test` }));
    expect(normalizeShowcaseLinks(tooManyLinks)).toEqual(failure("最多"));
    // An unknown type falls back instead of being stored verbatim.
    const unknownType = normalizeShowcaseLinks([{ type: "hack", url: "https://a.test" }]);
    expect("value" in unknownType ? unknownType.value[0]?.type : null).toBe("other");
  });
});

describe("showcase tags and items", () => {
  it("dedupes tags and enforces the per-tag and total budget", () => {
    expect(normalizeShowcaseTags(["插画", " 插画 ", "角色设计"])).toEqual({ value: ["插画", "角色设计"] });
    // Distinct tags: duplicates are collapsed before the cap is checked.
    const tooManyTags = Array.from({ length: 9 }, (_, index) => `标签${index}`);
    expect(normalizeShowcaseTags(tooManyTags)).toEqual(failure("最多"));
    expect(normalizeShowcaseTags(["x".repeat(17)])).toEqual(failure("标签"));
    expect(normalizeShowcaseTags(null)).toEqual({ value: [] });
  });

  it("validates item kind, title and links", () => {
    expect(normalizeShowcaseItemInput({}, { creating: true })).toEqual(failure("作品标题"));
    expect(normalizeShowcaseItemInput({ title: "作品", kind: "nope" }, { creating: true })).toEqual(
      failure("作品类型"),
    );
    expect(
      normalizeShowcaseItemInput({ title: "作品", kind: "github", url: "javascript:x" }, { creating: true }),
    ).toEqual(failure("只支持 http(s)"));
    expect(normalizeShowcaseItemInput({ featured: "yes" }, { creating: false })).toEqual({
      error: "featured 必须是布尔值",
    });
    expect(normalizeShowcaseItemInput({ title: " 作品 ", featured: true }, { creating: true })).toEqual({
      value: { title: "作品", featured: true },
    });
  });
});

describe("showcase serialization", () => {
  // Mirrors the row shape the repository maps; only the fields the serializers
  // touch are meaningful here.
  const row = {
    id: 1,
    name: "月见",
    subtitle: "插画师",
    description: null,
    accentColor: "#7c8cff",
    backgroundFrom: "#182042",
    backgroundTo: "#05070d",
    backgroundMediaId: 902,
    illustrationMediaId: 901,
    avatarMediaId: 903,
    backgroundUrl: "https://cdn.example/bg.png",
    illustrationUrl: null,
    tags: ["插画"],
    links: [],
    surveyId: null,
    responseId: null,
    ownerUserId: 7,
    featureRank: 0,
    published: true,
    sortOrder: 0,
    createdBy: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    items: [],
  } as unknown as ShowcasePersonWithItems;

  it("resolves media-backed artwork through the admin media route for editor previews", () => {
    const admin = toAdminShowcasePerson(row);
    // The public route 404s for drafts, so the editor must preview via /admin.
    expect(admin.illustrationUrl).toBe("/api/admin/media/901/image");
    expect(admin.background.imageUrl).toBe("/api/admin/media/902/image");
    expect(admin.avatarUrl).toBe("/api/admin/media/903/image");
    // Raw external-URL columns stay untouched for the form round-trip.
    expect(admin.backgroundUrl).toBe("https://cdn.example/bg.png");
    expect(admin.illustrationMediaId).toBe(901);
  });

  it("keeps external URLs verbatim when no media asset is attached", () => {
    const externalOnly = { ...row, backgroundMediaId: null, illustrationMediaId: null, avatarMediaId: null } as
      typeof row;
    const admin = toAdminShowcasePerson(externalOnly);
    expect(admin.illustrationUrl).toBeNull();
    expect(admin.background.imageUrl).toBe("https://cdn.example/bg.png");
    const pub = toPublicShowcasePerson(externalOnly);
    expect(pub.background.imageUrl).toBe("https://cdn.example/bg.png");
  });

  it("serves the public view through the authorized public media route", () => {
    const pub = toPublicShowcasePerson(row);
    expect(pub.illustrationUrl).toBe("/api/showcase/media/901");
    expect(pub.background.imageUrl).toBe("/api/showcase/media/902");
    expect(pub.avatarUrl).toBe("/api/showcase/media/903");
  });

  // 文字作品（文章/小说）的正文可能很长：feed 只带预览，全文走 items 接口。
  it("sends only a preview in the feed and the full text on demand", () => {
    const longBody = "夜".repeat(SHOWCASE_ITEM_PREVIEW_CHARS + 200);
    const articleItem: ShowcaseItem = {
      id: 5,
      personId: 1,
      title: "长夜将明",
      description: longBody,
      kind: "article",
      coverMediaId: null,
      coverUrl: null,
      mediaAssetId: null,
      url: null,
      featured: true,
      sortOrder: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const article = { ...row, items: [articleItem] } as unknown as ShowcasePersonWithItems;

    const feedItem = toPublicShowcasePerson(article).items[0];
    expect(feedItem?.descriptionTruncated).toBe(true);
    expect(feedItem?.description).toBe("夜".repeat(SHOWCASE_ITEM_PREVIEW_CHARS) + "…");

    const fullItem = toPublicShowcaseItem(articleItem, { full: true });
    expect(fullItem.descriptionTruncated).toBe(false);
    expect(fullItem.description).toHaveLength(SHOWCASE_ITEM_PREVIEW_CHARS + 200);

    // 短简介不截断，也不标 truncated。
    const short = toPublicShowcaseItem({ ...articleItem, description: "很短的一句话" });
    expect(short).toMatchObject({ description: "很短的一句话", descriptionTruncated: false });
  });

  it("accepts the audio kind and keeps the item media file", () => {
    expect(normalizeShowcaseItemInput({ title: "朗读", kind: "audio", mediaAssetId: 903 }, { creating: true })).toMatchObject({
      value: { kind: "audio", mediaAssetId: 903 },
    });
    expect(normalizeShowcaseItemInput({ title: "x", kind: "music" }, { creating: true })).toMatchObject({
      error: expect.stringContaining("作品类型"),
    });
    // 显式传 null 表示「移除作品文件」。
    expect(normalizeShowcaseItemInput({ mediaAssetId: null }, { creating: false })).toMatchObject({
      value: { mediaAssetId: null },
    });
  });

  it("exposes item media through the route that matches the surface", () => {
    const audioItem: ShowcaseItem = {
      id: 6,
      personId: 1,
      title: "朗读：长夜将明",
      description: null,
      kind: "audio",
      coverMediaId: null,
      coverUrl: null,
      mediaAssetId: 903,
      url: null,
      featured: false,
      sortOrder: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const withMedia = { ...row, items: [audioItem] } as unknown as ShowcasePersonWithItems;

    expect(toPublicShowcasePerson(withMedia).items[0]?.mediaUrl).toBe("/api/showcase/media/903");
    // 草稿的媒体只能走管理端路由，否则编辑时预览 404。
    expect(toAdminShowcasePerson(withMedia).items[0]).toMatchObject({
      mediaAssetId: 903,
      mediaUrl: "/api/admin/media/903/image",
    });

    // 没有内容文件时不产生 mediaUrl，前台据此回退成「跳外链」。
    const noMedia = { ...withMedia, items: [{ ...audioItem, mediaAssetId: null }] } as unknown as ShowcasePersonWithItems;
    expect(toPublicShowcasePerson(noMedia).items[0]?.mediaUrl).toBeNull();
  });

  it("accepts a long article body up to the raised item limit", () => {
    const body = "文".repeat(SHOWCASE_LIMITS.itemDescription);
    expect(normalizeShowcaseItemInput({ title: "长文", description: body }, { creating: true })).toMatchObject({
      value: { description: body },
    });
    expect(
      normalizeShowcaseItemInput({ title: "长文", description: "文".repeat(SHOWCASE_LIMITS.itemDescription + 1) }, { creating: true }),
    ).toMatchObject({ error: expect.stringContaining("作品简介长度不能超过") });
  });
});
