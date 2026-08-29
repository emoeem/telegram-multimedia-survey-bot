import { describe, expect, it } from "vitest";

import {
  cardBadges,
  galleryCardCaption,
  parseGalleryCards,
  selectNewCards,
  type GalleryCard,
} from "../../../src/services/media-cards-gallery.service";

function makeCard(slug: string, overrides: Partial<GalleryCard> = {}): GalleryCard {
  return {
    _slug: slug,
    title: `卡片 ${slug}`,
    generated_at: "2026-08-29T00:00:00Z",
    visibility: "public",
    badges: { video: ["dolby-vision"], audio: ["dolby-atmos"] },
    video: { codec: "H.265/HEVC", width: 3840, height: 2160, fps: 23.976 },
    audio: { codec: "Dolby TrueHD", layout: "7.1", samplerate: 48 },
    ...overrides,
  };
}

describe("parseGalleryCards", () => {
  it("保留合法公开卡片并过滤脏数据", () => {
    const cards = parseGalleryCards({
      cards: [
        makeCard("a"),
        { _slug: "../evil" },
        makeCard("b", { visibility: "private" }),
        "junk",
        null,
        { _slug: "c" },
      ],
    });
    expect(cards.map((card) => card._slug)).toEqual(["a", "c"]);
  });

  it("拒绝非对象输入", () => {
    expect(parseGalleryCards(null)).toEqual([]);
    expect(parseGalleryCards("text")).toEqual([]);
    expect(parseGalleryCards({})).toEqual([]);
    expect(parseGalleryCards({ cards: "not-array" })).toEqual([]);
  });
});

describe("selectNewCards", () => {
  const cards = [makeCard("newest"), makeCard("second"), makeCard("oldest")];

  it("首次运行只推送最近 limit 张并按时间正序发送", () => {
    const fresh = selectNewCards(cards, null, 2);
    expect(fresh.map((card) => card._slug)).toEqual(["second", "newest"]);
  });

  it("有记录时只推送上次记录之后的新卡", () => {
    const fresh = selectNewCards(cards, "newest", 5);
    expect(fresh).toEqual([]);
    const fresh2 = selectNewCards([makeCard("fresher"), ...cards], "newest", 5);
    expect(fresh2.map((card) => card._slug)).toEqual(["fresher"]);
  });

  it("记录找不到时回退为最近 limit 张", () => {
    const fresh = selectNewCards(cards, "unknown-slug", 2);
    expect(fresh.map((card) => card._slug)).toEqual(["second", "newest"]);
  });
});

describe("cardBadges / galleryCardCaption", () => {
  it("合并视频与音频徽章", () => {
    expect(cardBadges(makeCard("a"))).toEqual(["dolby-vision", "dolby-atmos"]);
  });

  it("caption 包含标题、徽章与规格", () => {
    const caption = galleryCardCaption(makeCard("a"));
    expect(caption).toContain("卡片 a");
    expect(caption).toContain("【杜比视界】");
    expect(caption).toContain("【Atmos】");
    expect(caption).toContain("H.265/HEVC · 3840×2160 · 23.98 fps");
    expect(caption).toContain("Dolby TrueHD · 7.1");
  });

  it("caption 对缺失字段保持健壮", () => {
    const caption = galleryCardCaption({ _slug: "bare" });
    expect(caption).toContain("未命名");
    expect(caption).not.toContain("undefined");
  });
});
