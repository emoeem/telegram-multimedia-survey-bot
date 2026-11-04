import { describe, expect, it } from "vitest";

import { renderGalleryBlock } from "../../../src/services/report/blocks/gallery";
import { renderHeroBlock } from "../../../src/services/report/blocks/content";

const context = {
  escape: (value: string): string =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
  limit: (value: string, length: number): string => value.slice(0, length),
};

describe("report block image src slots", () => {
  it("renders inline data URLs and same-origin media links verbatim (escaped)", () => {
    const html = renderGalleryBlock([{ url: "data:image/png;base64,AAAA", caption: "图一" }], context);
    expect(html).toContain('src="data:image/png;base64,AAAA"');
    const linked = renderGalleryBlock([{ url: "/api/report/media/8?t=x", caption: "图二" }], context);
    expect(linked).toContain('src="/api/report/media/8?t=x"');
  });

  it("neutralizes remote and scheme-injection URLs in the gallery", () => {
    // The 2026-10-31 probe: a metadata URL pasted into an answer, plus an
    // attribute-breakout attempt. Neither may reach the <img src> attribute.
    for (const evil of [
      "http://169.254.169.254/x.png",
      `http://169.254.169.254/" onerror="alert(1)`,
      "javascript:alert(1)",
      "data:text/html;base64,AAAA",
    ]) {
      const html = renderGalleryBlock([{ url: evil, caption: "x" }], context);
      expect(html, evil).toContain('src=""');
      expect(html, evil).not.toContain(evil);
    }
  });

  it("applies the same rule to the hero avatar slot", () => {
    const ok = renderHeroBlock({ title: "t", thesis: "x", avatar: "data:image/png;base64,AAAA", tags: [] }, context);
    expect(ok).toContain('src="data:image/png;base64,AAAA"');
    const evil = renderHeroBlock({ title: "t", thesis: "x", avatar: "javascript:alert(1)", tags: [] }, context);
    expect(evil).not.toContain("javascript:");
    expect(evil).not.toContain("hero-avatar");
  });
});
