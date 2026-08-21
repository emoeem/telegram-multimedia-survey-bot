import { describe, expect, it } from "vitest";
import type { ResultProfileSnapshot } from "../../../src/result/schema";
import { buildReportViewModel } from "../../../src/services/html-report-renderer.service";
import { prepareReportContent } from "../../../src/services/report/composition/content";
import { planReportPages } from "../../../src/services/report/composition/page-planner";
import { DEFAULT_REPORT_SIZE_POLICY } from "../../../src/services/report/size-policy";

function report(answerCount: number, imageCount = 0, longText = ""): { profile: ResultProfileSnapshot; images: Record<string, string> } {
  const profileItems = Array.from({ length: answerCount }, (_, index) => ({ label: `问题 ${index + 1}`, value: index === 0 && longText ? longText : `回答 ${index + 1}` }));
  const fields = Object.fromEntries(profileItems.map((item, index) => [`question_${index + 1}`, { id: `question_${index + 1}`, type: index === 0 && longText ? "long_text" as const : "text" as const, value: item.value }]));
  const images = Object.fromEntries(Array.from({ length: imageCount }, (_, index) => [`result.images.${index + 1}`, `data:image/png;base64,${String(index).padStart(4, "A")}`]));
  return {
    profile: { resultType: "survey_result", title: "规模测试", subtitle: "内容决定页面", fields, stats: [], tags: [], images: {}, metadata: { profile: profileItems, summary: "最终结论" }, schemaVersion: 1 },
    images,
  };
}

function pagesFor(answerCount: number, imageCount = 0, longText = "") {
  const source = report(answerCount, imageCount, longText);
  const view = buildReportViewModel(source.profile, source.images);
  const content = prepareReportContent(view);
  return { view, content, pages: planReportPages(view, content) };
}

describe("semantic report page planner", () => {
  it("keeps a 10-question report within one or two pages", () => {
    const result = pagesFor(10);
    expect(result.content.densityMode).toBe("compact");
    expect(result.pages.length).toBeGreaterThanOrEqual(1);
    expect(result.pages.length).toBeLessThanOrEqual(2);
    const verdictPage = result.pages.find((page) => page.blocks.some((block) => block.kind === "verdict"));
    expect(verdictPage?.blocks).toHaveLength(1);
    expect(verdictPage?.estimatedHeight).toBe(680);
  });

  it("keeps compact response evidence off the cover page", () => {
    const result = pagesFor(13);
    expect(result.pages[0]?.blocks.every((block) => block.kind === "hero" || block.kind === "overview")).toBe(true);
    expect(result.pages.some((page) => page.kind === "responses")).toBe(true);
    expect(result.pages.at(-1)?.kind).toBe("verdict");
  });

  it("paginates 50 questions and five images by semantic section", () => {
    const result = pagesFor(50, 5);
    expect(result.content.densityMode).toBe("standard");
    expect(result.pages.some((page) => page.kind === "gallery")).toBe(true);
    expect(result.pages.at(-1)?.kind).toBe("verdict");
  });

  it("keeps 100 questions and ten images under the page cap", () => {
    const result = pagesFor(100, 10);
    expect(result.content.densityMode).toBe("extended");
    expect(result.pages.length).toBeLessThanOrEqual(DEFAULT_REPORT_SIZE_POLICY.maxPages);
    expect(result.pages.every((page) => page.estimatedHeight <= DEFAULT_REPORT_SIZE_POLICY.maxPageHeight - DEFAULT_REPORT_SIZE_POLICY.pagePaddingY)).toBe(true);
  });

  it("enters large mode for 150 questions and paginates 30 images", () => {
    const result = pagesFor(150, 30);
    expect(result.content.densityMode).toBe("large");
    const galleryPages = result.pages.filter((page) => page.kind === "gallery");
    expect(galleryPages.length).toBeGreaterThan(1);
    expect(galleryPages.every((page) => page.blocks.every((block) => block.kind !== "gallery" || block.items.length <= DEFAULT_REPORT_SIZE_POLICY.maxImagesPerPage))).toBe(true);
  });

  it("splits a 10000-character editorial answer with continuation labels", () => {
    const result = pagesFor(10, 0, "超长人格分析。".repeat(1250));
    const analysis = result.pages.flatMap((page) => page.blocks).filter((block) => block.kind === "analysis");
    expect(analysis.length).toBeGreaterThan(5);
    expect(analysis.some((block) => block.items.some((item) => item.title.includes("continued")))).toBe(true);
    expect(result.pages.every((page) => page.estimatedHeight <= DEFAULT_REPORT_SIZE_POLICY.maxPageHeight - DEFAULT_REPORT_SIZE_POLICY.pagePaddingY)).toBe(true);
  });

  it("always preserves cover and final verdict when applying a strict page cap", () => {
    const source = report(150, 30, "核心内容。".repeat(1800));
    const view = buildReportViewModel(source.profile, source.images);
    const content = prepareReportContent(view);
    const pages = planReportPages(view, content, { ...DEFAULT_REPORT_SIZE_POLICY, maxPages: 4 });
    expect(pages).toHaveLength(4);
    expect(pages.some((page) => page.blocks.some((block) => block.kind === "hero"))).toBe(true);
    expect(pages.some((page) => page.blocks.some((block) => block.kind === "verdict"))).toBe(true);
  });
});
