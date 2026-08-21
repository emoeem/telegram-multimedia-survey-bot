import { describe, expect, it } from "vitest";

import { applyReportPresentation } from "../../../src/services/report-presentation.service";
import { renderResultVisualSvg, TEMPLATE_BACKGROUND_IMAGE_KEY } from "../../../src/services/result-visual-renderer.service";
import type { ResultProfileSnapshot } from "../../../src/result/schema";
import { visualReportExampleTemplate } from "../../../src/visual-template/examples";

const profile: ResultProfileSnapshot = {
  resultType: "report_generator",
  title: "测试报告",
  subtitle: null,
  fields: {},
  stats: [],
  tags: [],
  images: {},
  metadata: { profile: [{ label: "昵称", value: "测试用户" }] },
  schemaVersion: 1,
};

describe("report presentation", () => {
  it("uses a Telegram background with a readable light content card", () => {
    const definition = applyReportPresentation(visualReportExampleTemplate, 42, "auto");
    expect(definition.background).toEqual({ type: "telegram_asset", assetId: 42, fit: "cover" });
    expect(definition.report?.readability).toMatchObject({
      textColor: "#172033",
      card: { color: "#ffffff", opacity: 0.9 },
    });

    const svg = renderResultVisualSvg(definition, profile, {
      [TEMPLATE_BACKGROUND_IMAGE_KEY]: "data:image/png;base64,BACKGROUND",
    });
    expect(svg).toContain("data:image/png;base64,BACKGROUND");
    expect(svg).toContain('fill="#ffffff" opacity="0.9"');
    expect(svg).toContain('fill="#172033"');
    expect(svg.indexOf("data:image/png;base64,BACKGROUND")).toBeLessThan(svg.indexOf("测试报告"));
  });

  it("switches to a dark card and light text when requested", () => {
    const definition = applyReportPresentation(visualReportExampleTemplate, 42, "dark");
    const svg = renderResultVisualSvg(definition, profile, {
      [TEMPLATE_BACKGROUND_IMAGE_KEY]: "data:image/png;base64,BACKGROUND",
    });
    expect(svg).toContain('fill="#0f172a" opacity="0.9"');
    expect(svg).toContain('fill="#f8fafc"');
  });
});
