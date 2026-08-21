import { describe, expect, it } from "vitest";

import { parseVisualTemplateDefinition, VisualTemplateValidationError } from "../../../src/services/visual-template-validator.service";
import { visualReportExampleTemplate } from "../../../src/visual-template/examples";

const validTemplate = {
  schemaVersion: 1,
  width: 1080,
  height: 1350,
  format: "png",
  background: { type: "gradient", from: "#111827", to: "#7c3aed", angle: 45 },
  variables: [
    { path: "result.fields.name", label: "名称", type: "text" },
    { path: "result.fields.avatar", label: "头像", type: "image" },
    { path: "result.fields.rarity", label: "稀有度", type: "enum" },
    { path: "result.stats", label: "属性", type: "stats" },
  ],
  elements: [
    { id: "title", type: "text", value: "{{result.fields.name}}", x: 80, y: 90, width: 920, fontSize: 64, color: "#ffffff" },
    { id: "avatar", type: "image", source: "{{result.fields.avatar}}", x: 180, y: 210, width: 720, height: 600, fit: "cover", shape: "rounded" },
    { id: "rarity", type: "badge", value: "{{result.fields.rarity}}", x: 80, y: 40, visibleIf: { path: "result.fields.rarity", operator: "exists" } },
    { id: "stats", type: "stat_group", source: "{{result.stats}}", x: 80, y: 880, width: 920, height: 300 },
  ],
};

describe("visual template validator", () => {
  it("accepts a non-RPG template with dynamic fields and stats", () => {
    const parsed = parseVisualTemplateDefinition(JSON.stringify(validTemplate));
    expect(parsed.elements).toHaveLength(4);
    expect(parsed.variables[0]?.path).toBe("result.fields.name");
  });

  it("accepts a Telegram media asset background without any object-storage URL", () => {
    const poster = { ...validTemplate, background: { type: "telegram_asset", assetId: 123, fit: "cover" } };
    const parsed = parseVisualTemplateDefinition(JSON.stringify(poster));
    expect(parsed.background).toMatchObject({ type: "telegram_asset", assetId: 123 });

    expect(() => parseVisualTemplateDefinition(JSON.stringify({
      ...validTemplate,
      background: { type: "telegram_asset", assetId: 0 },
    }))).toThrow("background.assetId");
  });

  it("rejects undeclared variables and arbitrary image URLs", () => {
    const unknown = structuredClone(validTemplate);
    unknown.elements[0]!.value = "{{result.fields.unknown}}";
    expect(() => parseVisualTemplateDefinition(JSON.stringify(unknown))).toThrow(VisualTemplateValidationError);

    const url = structuredClone(validTemplate);
    url.elements[1]!.source = "https://example.invalid/image.png";
    expect(() => parseVisualTemplateDefinition(JSON.stringify(url))).toThrow("必须是 {{result.*}} 变量");
  });

  it("rejects unsafe paths, colors, and unsupported elements", () => {
    const unsafe = structuredClone(validTemplate);
    unsafe.variables[0]!.path = "result.fields.__proto__";
    expect(() => parseVisualTemplateDefinition(JSON.stringify(unsafe))).toThrow("允许的 ResultProfile 路径");

    const color = structuredClone(validTemplate);
    color.elements[0]!.color = "url(javascript:alert(1))";
    expect(() => parseVisualTemplateDefinition(JSON.stringify(color))).toThrow("不是合法颜色");

    const unsupported = structuredClone(validTemplate);
    unsupported.elements[0]!.type = "script";
    expect(() => parseVisualTemplateDefinition(JSON.stringify(unsupported))).toThrow("不受支持");
  });

  it("accepts an auto-height report with list-driven sections", () => {
    const parsed = parseVisualTemplateDefinition(JSON.stringify(visualReportExampleTemplate));
    expect(parsed.height).toBe("auto");
    expect(parsed.sections?.map((section) => section.type)).toEqual([
      "table", "gallery", "status_grid", "metrics", "summary",
    ]);
  });
});
