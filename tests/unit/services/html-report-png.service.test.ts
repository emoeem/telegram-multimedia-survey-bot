import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResultProfileSnapshot } from "../../../src/result/schema";

const { launch, page, browser } = vi.hoisted(() => {
  const page = {
    setViewport: vi.fn(async () => undefined),
    setContent: vi.fn(async () => undefined),
    evaluate: vi.fn(async () => undefined),
    screenshot: vi.fn(async () => new Uint8Array([137, 80, 78, 71])),
    pdf: vi.fn(async () => new Uint8Array([37, 80, 68, 70])),
  };
  const browser = { newPage: vi.fn(async () => page), close: vi.fn(async () => undefined) };
  return { launch: vi.fn(async () => browser), page, browser };
});

vi.mock("@cloudflare/puppeteer", () => ({ default: { launch } }));

import { renderHtmlReportArtifact, renderHtmlReportPng } from "../../../src/services/html-report-renderer.service";
import { DEFAULT_REPORT_SIZE_POLICY } from "../../../src/services/report/size-policy";

const profile: ResultProfileSnapshot = {
  resultType: "survey_result",
  title: "测试报告",
  subtitle: "稳定、清晰、具有选择性的表达",
  fields: {},
  stats: [],
  tags: [],
  images: {},
  metadata: {},
  schemaVersion: 1,
};

describe("HTML report PNG rendering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    page.screenshot.mockResolvedValue(new Uint8Array([137, 80, 78, 71]));
    page.pdf.mockResolvedValue(new Uint8Array([37, 80, 68, 70]));
  });
  it("renders a 3:4 mobile viewport at 2x PNG output", async () => {
    const png = await renderHtmlReportPng({} as never, profile, "Editorial + Nord", {}, { layout: "editorial", theme: "nord" });
    expect(png).toEqual(new Uint8Array([137, 80, 78, 71]));
    expect(page.setViewport).toHaveBeenCalledWith({ width: 900, height: 1200, deviceScaleFactor: 2 });
    expect(page.screenshot).toHaveBeenCalledWith({ type: "png", captureBeyondViewport: false });
    expect(page.setContent).toHaveBeenCalledWith(expect.stringContaining('data-report-layout="editorial"'), { waitUntil: "load" });
    expect(page.pdf).toHaveBeenCalledWith(expect.objectContaining({ format: "A4", printBackground: true }));
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it("rerenders an oversized page with the policy fallback DPR", async () => {
    page.screenshot
      .mockResolvedValueOnce(new Uint8Array(6 * 1024 * 1024))
      .mockResolvedValue(new Uint8Array([137, 80, 78, 71]));
    const artifact = await renderHtmlReportArtifact({} as never, profile, "Editorial + Nord", {}, { layout: "editorial", theme: "nord" });
    expect(artifact.pages.length).toBeGreaterThan(0);
    expect(page.setViewport).toHaveBeenCalledWith({ width: 900, height: 1200, deviceScaleFactor: 1.5 });
    expect(artifact.pages[0]?.size).toBe(4);
  });

  it("drops low-priority extension pages when the total byte policy is exceeded", async () => {
    const manyAnswers = {
      ...profile,
      metadata: { profile: Array.from({ length: 50 }, (_, index) => ({ label: `问题 ${index}`, value: `回答 ${index}` })) },
    };
    page.screenshot.mockResolvedValue(new Uint8Array(3 * 1024 * 1024));
    const artifact = await renderHtmlReportArtifact({} as never, manyAnswers, "Editorial + Nord", {}, {}, { ...DEFAULT_REPORT_SIZE_POLICY, targetPageBytes: 4 * 1024 * 1024, maxTotalBytes: 7 * 1024 * 1024 });
    expect(artifact.totalBytes).toBeLessThanOrEqual(7 * 1024 * 1024);
    expect(artifact.pages.some((entry) => entry.kind === "cover")).toBe(true);
    expect(artifact.pages.some((entry) => entry.kind === "verdict")).toBe(true);
    expect(artifact.failures.some((failure) => failure.message.includes("total report size policy"))).toBe(true);
  });

  it("keeps rendering later pages when one page fails twice", async () => {
    page.screenshot.mockRejectedValueOnce(new Error("page failed")).mockRejectedValueOnce(new Error("page failed again")).mockResolvedValue(new Uint8Array([1, 2, 3]));
    const multiPage = { ...profile, metadata: { profile: Array.from({ length: 50 }, (_, index) => ({ label: `问题 ${index}`, value: `回答 ${index}` })) } };
    const artifact = await renderHtmlReportArtifact({} as never, multiPage, "Editorial + Nord");
    expect(artifact.failures[0]?.pageId).toBe("page-01");
    expect(artifact.pages.length).toBeGreaterThan(0);
  });

  it("records page metrics and uses JPEG fallback for a photo-heavy oversized page", async () => {
    const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";
    const pictured = { ...profile, metadata: { gallery: [{}] } };
    page.screenshot.mockResolvedValueOnce(new Uint8Array(6 * 1024 * 1024)).mockResolvedValueOnce(new Uint8Array(6 * 1024 * 1024)).mockResolvedValueOnce(new Uint8Array(2 * 1024 * 1024));
    const artifact = await renderHtmlReportArtifact({} as never, pictured, "Gallery", { "result.images.1": image }, { layout: "gallery" });
    const gallery = artifact.pages.find((entry) => entry.containsImages);
    expect(gallery).toMatchObject({ format: "jpeg", type: "image/jpeg", dpr: 1.5, deliveryMode: "photo", optimizationAttempts: 2 });
    expect(gallery?.pixelCount).toBe(gallery!.width * gallery!.height);
    expect(gallery?.htmlByteSize).toBeGreaterThan(0);
  });

  it("classifies an over-budget page as a size-limit failure with all attempts", async () => {
    const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";
    page.screenshot.mockResolvedValueOnce(new Uint8Array(11 * 1024 * 1024)).mockResolvedValueOnce(new Uint8Array(11 * 1024 * 1024)).mockResolvedValueOnce(new Uint8Array(11 * 1024 * 1024)).mockResolvedValue(new Uint8Array([1, 2, 3]));
    const artifact = await renderHtmlReportArtifact({} as never, profile, "Gallery", { "result.images.1": image }, { layout: "gallery" });
    const failure = artifact.failures.find((entry) => entry.stage === "size_limit");
    expect(failure?.attempts?.length).toBeGreaterThanOrEqual(3);
    expect(failure?.message).toContain("exceeds");
  });
});
