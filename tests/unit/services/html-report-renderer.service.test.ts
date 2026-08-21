import { describe, expect, it } from "vitest";
import type { ResultProfileSnapshot } from "../../../src/result/schema";
import { buildHtmlReport, buildReportViewModel, selectReportLayout } from "../../../src/services/html-report-renderer.service";
import { prepareReportContent } from "../../../src/services/report/composition/content";

const profile: ResultProfileSnapshot = {
  resultType: "survey_result",
  title: "独立思考型探索者",
  subtitle: "中文与 emoji 😀 ✨",
  fields: {
    name: { id: "name", type: "text", value: "小明 & <测试>" },
    answer: { id: "answer", type: "long_text", value: "这是很长的一段回答。\n包含换行、中文和 emoji 🚀，用于验证自动排版。" },
  },
  stats: [
    { id: "logic", label: "逻辑性", value: 92, max: 100 },
    { id: "independence", label: "独立性", value: 88, max: 100 },
    { id: "curiosity", label: "探索欲", value: 81, max: 100 },
  ],
  tags: ["理性", "独立", "探索"],
  images: {},
  metadata: {
    profile: [{ label: "姓名", value: "小明 & <测试>" }],
    summary: "一段总结文本。",
  },
  schemaVersion: 1,
};

describe("HTML report renderer", () => {
  it("builds a semantic view model from ResultProfile", () => {
    const view = buildReportViewModel(profile);
    expect(view.hero.title).toBe("独立思考型探索者");
    expect(view.scores).toHaveLength(3);
    expect(view.scores[0]?.percentage).toBe(92);
    expect(view.scores[0]?.level).toBe("HIGH");
    expect(view.insights[0]?.text).toContain("很长的一段回答");
    expect(view.tags).toEqual(["理性", "独立", "探索"]);
  });

  it("promotes resolved user images to the hero and gallery data", () => {
    const image = "data:image/png;base64,AAAA";
    const view = buildReportViewModel(profile, {
      "result.images.avatar": image,
      "result.metadata.gallery.1": "data:image/jpeg;base64,BBBB",
    });
    expect(view.hero.avatar).toBe(image);
    expect(view.gallery).toHaveLength(2);
    expect(buildHtmlReport(profile, "个人报告 · 玻璃极简", { "result.images.avatar": image })).toContain("object-fit:cover");
  });

  it("escapes user text and renders the radar only with three dimensions", () => {
    const html = buildHtmlReport(profile, "个人报告 · 玻璃极简");
    expect(html).toContain("小明 &amp; &lt;测试&gt;");
    expect(html).toContain("😀");
    expect(html).toContain('class="radar"');
    expect(html).toContain("bento-overview");
    expect(html).toContain("repeat(12,minmax(0,1fr))");
    expect(html).toContain("@font-face");
    expect(html).toContain("--font-display:ReportSans");
    expect(html).toContain("--font-data:var(--font-display)");
    expect(html).toContain("font-variant-numeric:tabular-nums");
    expect(html).not.toContain("<测试>");
    expect(html).toContain("final-verdict");
    expect(html).toContain("compact-answer-grid");
  });

  it("maps legacy template names to independent theme tokens", () => {
    const glass = buildHtmlReport(profile, "个人报告 · 玻璃极简");
    const cyber = buildHtmlReport(profile, "个人报告 · 霓虹赛博档案");
    const deco = buildHtmlReport(profile, "个人报告 · Art Deco 复古");
    expect(glass).toContain('data-report-theme="catppuccin-mocha"');
    expect(cyber).toContain('data-report-theme="dracula"');
    expect(deco).toContain('data-report-theme="gruvbox-dark"');
    for (const html of [glass, cyber, deco]) {
      expect(html).toContain("font-family:ReportSans");
      expect(html).toContain("Microsoft YaHei");
      expect(html).toContain("font-display:block");
    }
  });

  it("omits empty score and gallery sections", () => {
    const empty: ResultProfileSnapshot = { ...profile, stats: [], metadata: {}, fields: {} };
    const html = buildHtmlReport(empty, "个人报告 · 玻璃极简");
    expect(html).not.toContain("量化指标");
    expect(html).not.toContain("图片记录");
    expect(html).not.toContain('class="radar"');
  });

  it("selects a layout from report content and allows explicit overrides", () => {
    const view = buildReportViewModel(profile);
    expect(selectReportLayout(view)).toBe("bento");
    expect(selectReportLayout(view, { layout: "magazine" })).toBe("magazine");
    expect(buildHtmlReport(profile, "个人报告 · Magazine", {}, { layout: "magazine" })).toContain("report-layout-magazine");
  });

  it("uses a gallery layout when the report contains many images", () => {
    const image = "data:image/png;base64,AAAA";
    const imageTwo = "data:image/png;base64,BBBB";
    const imageThree = "data:image/png;base64,CCCC";
    const view = buildReportViewModel(profile, {
      "result.images.1": image,
      "result.images.2": imageTwo,
      "result.images.3": imageThree,
    });
    expect(selectReportLayout(view)).toBe("gallery");
    expect(buildHtmlReport(profile, "个人报告 · 图片 Gallery", {
      "result.images.1": image,
      "result.images.2": imageTwo,
      "result.images.3": imageThree,
    })).toContain("block-gallery");
  });

  it("composes layouts with independent mature themes", () => {
    const html = buildHtmlReport(profile, "任意模板", {}, { layout: "bento", theme: "nord" });
    expect(html).toContain('data-report-layout="bento"');
    expect(html).toContain('data-report-theme="nord"');
    expect(html).toContain("--report-bg:#2e3440");
    expect(html).toContain("--report-space-8:72px");
    expect(html).toContain("--chart-6:#bf616a");
  });

  it("uses metadata themes and image-count-specific gallery compositions", () => {
    const themed = { ...profile, metadata: { ...profile.metadata, theme: "dracula" } };
    const html = buildHtmlReport(themed, "任意模板", {
      "result.images.1": "data:image/png;base64,AAAA",
      "result.images.2": "data:image/png;base64,BBBB",
      "result.images.3": "data:image/png;base64,CCCC",
      "result.images.4": "data:image/png;base64,DDDD",
    });
    expect(html).toContain('data-report-theme="dracula"');
    expect(html).toContain('class="gallery gallery-feature-triple"');
    expect(html).toContain('data-image-count="3"');
  });

  it("scores content signals for automatic layout selection", () => {
    const textHeavy = { ...profile, stats: [], metadata: { ...profile.metadata, summary: "x".repeat(5000) } };
    expect(selectReportLayout(buildReportViewModel(textHeavy))).toBe("editorial");
    expect(selectReportLayout(buildReportViewModel(textHeavy), { layout: "data" })).toBe("data");
  });

  it("renders the supported layout and theme matrix deterministically", () => {
    const layouts = ["editorial", "bento", "magazine", "data", "gallery", "profile"] as const;
    const themes = ["catppuccin-mocha", "dracula", "tokyo-night", "nord"] as const;
    for (const layout of layouts) for (const theme of themes) {
      const html = buildHtmlReport(profile, "matrix", {}, { layout, theme });
      expect(html).toContain(`data-report-layout="${layout}"`);
      expect(html).toContain(`data-report-theme="${theme}"`);
      expect(html).toContain("--report-bg:");
    }
  });

  it("uses a 3:4 mobile viewport and readable content canvas", () => {
    const html = buildHtmlReport(profile, "report");
    expect(html).toContain("body{width:900px}");
    expect(html).toContain("--report-content-width:792px");
    expect(html).toContain("--report-reading-width:720px");
  });

  it("keeps editorial analysis outside the shared card model", () => {
    const long = "长篇分析".repeat(180);
    const rich = { ...profile, fields: { ...profile.fields, answer: { id: "answer", type: "long_text" as const, value: long } } };
    const html = buildHtmlReport(rich, "report", {}, { layout: "editorial" });
    expect(html).toContain('class="editorial-chapter block block-analysis"');
    expect(html).toContain('class="editorial-section editorial-long"');
    expect(html).not.toContain('class="section block block-analysis"');
    expect(html).toContain(".editorial-copy{max-width:860px}");
  });

  it("does not create score or radar UI without source statistics", () => {
    const noScores = { ...profile, stats: [] };
    const html = buildHtmlReport(noScores, "report");
    expect(html).not.toContain('<div class="hero-score">');
    expect(html).not.toContain("PRIMARY SCORE");
    expect(html).not.toContain('<svg class="radar"');
  });

  it("does not render an empty gallery and composes a resolved gallery by count", () => {
    expect(buildHtmlReport(profile, "report")).not.toContain("block-gallery");
    const images = {
      "result.images.1": "data:image/png;base64,AAAA",
      "result.images.2": "data:image/png;base64,BBBB",
      "result.images.3": "data:image/png;base64,CCCC",
      "result.images.4": "data:image/png;base64,DDDD",
    };
    const html = buildHtmlReport(profile, "report", images, { layout: "gallery" });
    expect(html).toContain("gallery-feature-triple");
    expect(html).toContain('data-image-count="3"');
  });

  it("deduplicates long answers across analysis quotes and responses", () => {
    const fields = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`long_${index}`, { id: `long_${index}`, type: "long_text" as const, value: `唯一回答 ${index} ${"内容".repeat(50)}` }]));
    const metadataProfile = Object.values(fields).map((field, index) => ({ label: `问题 ${index}`, value: field.value }));
    const rich = { ...profile, fields, metadata: { profile: metadataProfile, summary: "独立总结" } };
    const view = buildReportViewModel(rich);
    const content = prepareReportContent(view);
    const analysisSources = new Set(content.analysis.map((item) => item.sourceId));
    expect(content.quotes.every((item) => !analysisSources.has(item.sourceId))).toBe(true);
    expect(content.featuredAnswer).toBeUndefined();
    expect(content.editorialAnswers).toHaveLength(0);
    expect(content.compactAnswers).toHaveLength(0);
  });

  it("uses full-width featured and finale blocks with natural editorial breaking", () => {
    const html = buildHtmlReport(profile, "report", {}, { layout: "editorial" });
    expect(html).toContain('data-block="featured"');
    expect(html).toContain('reading-wide emphasis-featured');
    expect(html).toContain('data-block="verdict"');
    expect(html).toContain('reading-full emphasis-primary');
    expect(html).toContain(".editorial-section{display:grid");
    expect(html).toContain("break-inside:auto");
    expect(html).not.toContain(".block{break-inside:avoid}");
  });

  it("changes region order by layout without changing report data", () => {
    const view = buildReportViewModel(profile);
    const snapshot = JSON.stringify(view);
    const magazine = buildHtmlReport(profile, "report", {}, { layout: "magazine", theme: "nord" });
    const data = buildHtmlReport(profile, "report", {}, { layout: "data", theme: "nord" });
    expect(magazine.indexOf('data-region="featured"')).toBeLessThan(magazine.indexOf('data-region="overview"'));
    expect(data.indexOf('data-region="overview"')).toBeLessThan(data.indexOf('data-region="featured"'));
    expect(JSON.stringify(view)).toBe(snapshot);
  });

  it("changes theme tokens without changing composition order", () => {
    const nord = buildHtmlReport(profile, "report", {}, { layout: "editorial", theme: "nord" });
    const dracula = buildHtmlReport(profile, "report", {}, { layout: "editorial", theme: "dracula" });
    const order = (html: string) => [...html.matchAll(/data-region="([^"]+)"/g)].map((match) => match[1]);
    expect(order(nord)).toEqual(order(dracula));
    expect(nord).toContain("--report-bg:#2e3440");
    expect(dracula).toContain("--report-bg:#282a36");
  });

  it("uses unequal spans in the true bento overview", () => {
    const html = buildHtmlReport(profile, "report", {}, { layout: "bento" });
    expect(html).toContain(".bento-primary{grid-column:span 7;grid-row:span 2");
    expect(html).toContain(".bento-radar{grid-column:span 5");
    expect(html).toContain(".bento-bars{grid-column:span 7");
    expect(html).toContain(".bento-tags{grid-column:span 12");
  });
});
