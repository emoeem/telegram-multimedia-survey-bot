import { describe, expect, it } from "vitest";
import {
  CARD_TEMPLATE_SAMPLE_VALUES,
  DEFAULT_DISCLAIMER_TEXT,
  normalizeCardTemplateDefinition,
} from "../../src/card-template/model";
import { buildCardTemplateHtml } from "../../src/services/card-template-render.service";

describe("normalizeCardTemplateDefinition", () => {
  it("falls back to defaults for garbage input", () => {
    const definition = normalizeCardTemplateDefinition("not-an-object");
    expect(definition.backgroundColor).toBe("#ffffff");
    expect(definition.slots).toEqual([]);
    expect(definition.disclaimerText).toBe(DEFAULT_DISCLAIMER_TEXT);
  });

  it("clamps slot geometry and drops invalid entries", () => {
    const definition = normalizeCardTemplateDefinition({
      backgroundColor: "javascript:alert(1)",
      slots: [
        { id: "a", binding: "name", x: -99999, y: 10, w: 99999, h: 60, fontSize: 5000, color: "red" },
        "junk",
        null,
      ],
      disclaimerText: "  测试声明  ",
    });
    expect(definition.backgroundColor).toBe("#ffffff");
    expect(definition.slots).toHaveLength(1);
    const [slot] = definition.slots;
    expect(slot?.x).toBeGreaterThanOrEqual(-900);
    expect(slot?.w).toBeLessThanOrEqual(1800);
    expect(slot?.fontSize).toBeLessThanOrEqual(200);
    expect(slot?.color).toBe("#111111");
    expect(definition.disclaimerText).toBe("测试声明");
  });

  it("forces image kind for photo bindings", () => {
    const definition = normalizeCardTemplateDefinition({
      slots: [{ id: "p", binding: "front_image", kind: "text", x: 0, y: 0, w: 100, h: 100 }],
    });
    expect(definition.slots[0]?.kind).toBe("image");
  });
});

describe("buildCardTemplateHtml", () => {
  it("always renders the disclaimer and never a removable one", () => {
    const html = buildCardTemplateHtml(normalizeCardTemplateDefinition({ slots: [] }), null, {
      values: { ...CARD_TEMPLATE_SAMPLE_VALUES },
    });
    expect(html).toContain(DEFAULT_DISCLAIMER_TEXT);
  });

  it("renders bound text values with escaping", () => {
    const html = buildCardTemplateHtml(
      normalizeCardTemplateDefinition({
        slots: [{ id: "t", binding: "name", x: 0, y: 0, w: 200, h: 50 }],
      }),
      null,
      { values: { name: "<script>alert(1)</script>" } },
    );
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert");
  });

  it("embeds the CJK font so server-side rendering shows Chinese text", () => {
    const html = buildCardTemplateHtml(normalizeCardTemplateDefinition({ slots: [] }), null, { values: {} });
    expect(html).toContain("@font-face");
    expect(html).toContain("CardSans");
  });

  it("renders a placeholder box when a photo is missing", () => {
    const html = buildCardTemplateHtml(
      normalizeCardTemplateDefinition({
        slots: [{ id: "p", binding: "front_image", x: 0, y: 0, w: 100, h: 100 }],
      }),
      null,
      { values: {} },
    );
    expect(html).toContain("dashed");
  });
});
