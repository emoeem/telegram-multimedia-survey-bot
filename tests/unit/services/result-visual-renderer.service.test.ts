import { describe, expect, it } from "vitest";

import {
  renderResultVisualSvg,
  TEMPLATE_BACKGROUND_IMAGE_KEY,
} from "../../../src/services/result-visual-renderer.service";
import { RESULT_VISUAL_EMOJI_FONT, RESULT_VISUAL_FONT, RESULT_VISUAL_FONTS } from "../../../src/services/result-visual-font";
import type { ResultProfileSnapshot } from "../../../src/result/schema";
import type { VisualTemplateDefinition } from "../../../src/visual-template/schema";
import { visualReportExampleTemplate } from "../../../src/visual-template/examples";

const profile: ResultProfileSnapshot = {
  resultType: "personality",
  title: "<夜行者>",
  subtitle: null,
  fields: {
    name: { id: "name", type: "text", value: "小明 & 小红" },
    score: { id: "score", type: "score", value: 87, max: 100 },
  },
  stats: [{ id: "sensitivity", label: "敏感度", value: 72, max: 100 }],
  tags: ["冷静", "观察者"],
  images: {},
  metadata: {},
  schemaVersion: 1,
};

const template: VisualTemplateDefinition = {
  schemaVersion: 1,
  width: 1080,
  height: 1350,
  format: "png",
  background: { type: "gradient", from: "#111827", to: "#7c3aed" },
  variables: [],
  elements: [
    { id: "late", type: "text", value: "后层", x: 1, y: 1, zIndex: 9 },
    { id: "title", type: "text", value: "{{result.fields.name}}\n{{result.title}}", x: 80, y: 90, width: 600, fontSize: 48, maxLines: 2, overflow: "ellipsis", zIndex: 1 },
    { id: "score", type: "progress_bar", value: "{{result.fields.score}}", max: 100, x: 80, y: 300, width: 500, height: 30, color: "#22c55e", zIndex: 2 },
    { id: "stats", type: "stat_group", source: "{{result.stats}}", x: 80, y: 400, width: 700, height: 180, zIndex: 3 },
  ],
};

describe("result visual SVG renderer", () => {
  it("renders dynamic fields, Chinese text, stats, and z-index in safe SVG", () => {
    const svg = renderResultVisualSvg(template, profile);

    expect(svg).toContain("小明 &amp; 小红");
    expect(svg).toContain("&lt;夜行者&gt;");
    expect(svg).toContain("敏感度");
    expect(svg).toContain('width="435"');
    expect(svg.indexOf("后层")).toBeGreaterThan(svg.indexOf("敏感度"));
  });

  it("only embeds supplied image data URIs", () => {
    const imageTemplate = { ...template, elements: [{ id: "avatar", type: "image" as const, source: "{{result.images.avatar}}", x: 0, y: 0, width: 100, height: 100 }] };
    const svg = renderResultVisualSvg(imageTemplate, profile, {
      "result.images.avatar": "data:image/png;base64,AAAA",
    });

    expect(svg).toContain("data:image/png;base64,AAAA");
    expect(svg).not.toContain("https://");
  });

  it("uses the resolved Telegram asset image as the background", () => {
    const poster = {
      ...template,
      background: { type: "telegram_asset" as const, assetId: 77, fit: "cover" as const },
    };
    const svg = renderResultVisualSvg(poster, profile, {
      [TEMPLATE_BACKGROUND_IMAGE_KEY]: "data:image/jpeg;base64,BACKGROUND",
    });

    expect(svg).toContain("data:image/jpeg;base64,BACKGROUND");
    expect(svg).not.toContain("assetId");
  });

  it("keeps the bundled Chinese font subset within the Worker package budget", () => {
    expect(RESULT_VISUAL_FONT.byteLength).toBeLessThan(3 * 1024 * 1024);
    expect(RESULT_VISUAL_EMOJI_FONT.byteLength).toBeLessThan(256 * 1024);
  });

  it("keeps common emoji in the SVG for the compact color-font fallback", () => {
    const emojiTemplate: VisualTemplateDefinition = {
      ...template,
      elements: [{ id: "emoji", type: "text", value: "😀 ✨ ❤️ 🚀", x: 80, y: 90, width: 800, fontSize: 72 }],
    };
    expect(RESULT_VISUAL_FONTS).toHaveLength(2);
    expect(renderResultVisualSvg(emojiTemplate, profile)).toContain("😀 ✨ ❤️ 🚀");
  });

  it("lays out list-driven report sections into an automatically growing long image", () => {
    const reportProfile: ResultProfileSnapshot = {
      ...profile,
      title: "个人特质量化报告",
      fields: {
        name: { id: "name", type: "text", value: "测试角色" },
      },
      stats: Array.from({ length: 30 }, (_, index) => ({ id: `metric-${index}`, label: `指标 ${index + 1}`, value: (index % 10) + 1, max: 10 })),
      images: { photo1: "image-a", photo2: "image-b" },
      metadata: {
        profile: [{ label: "姓名", value: "测试角色" }, { label: "城市", value: "上海" }],
        status: [{ name: "沟通状态", passed: true }, { name: "活动记录", passed: false }, { name: "社交偏好", passed: true }],
        summary: "这是根据结构化结果动态排版的总结。",
        gallery: ["image-a", "image-b"],
      },
    };
    const svg = renderResultVisualSvg(visualReportExampleTemplate, reportProfile, {
      "result.metadata.gallery.0": "data:image/png;base64,AAAA",
      "result.metadata.gallery.1": "data:image/png;base64,BBBB",
    });

    expect(svg).toContain("01. 基础概况");
    expect(svg).toContain("沟通状态");
    expect(svg).toContain("指标 30");
    expect(svg).toContain("data:image/png;base64,AAAA");
    expect(svg).toContain("✓");
    expect(svg).toContain('height="');
    const height = Number(/<svg[^>]+height="(\d+)"/.exec(svg)?.[1]);
    expect(height).toBeGreaterThan(2_000);
  });

  it("rejects oversized pixel canvases before the PNG renderer allocates memory", () => {
    expect(() => renderResultVisualSvg({ ...template, width: 4096, height: 16_384 }, profile)).toThrow("结果报告尺寸过大");
  });

});
