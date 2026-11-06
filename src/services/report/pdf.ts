import type { BrowserWorker } from "@cloudflare/puppeteer";
import { launchBrowser, newSandboxedPage } from "../browser-launch";
import type { ResultProfileSnapshot } from "../../result/schema";
import { buildReportViewModel, optimizeReportImagesInPage } from "../html-report-renderer.service";
import { buildResponsiveReportHtml, type ResponsiveReportMeta } from "./web";
import { DEFAULT_REPORT_TEMPLATE, type ReportTemplateSpec } from "./template";

export interface ReportPdfOptions {
  maxImageDimension?: number;
}

export interface ReportPdfResult {
  bytes: Uint8Array;
  byteSize: number;
}

/**
 * PDF shares the exact responsive Web Report template so the exported
 * document and the on-screen report stay content-identical.
 */
export function buildReportPdfDocument(
  profile: ResultProfileSnapshot,
  images: Record<string, string> = {},
  meta: ResponsiveReportMeta = {},
  template: ReportTemplateSpec = DEFAULT_REPORT_TEMPLATE,
): string {
  const viewModel = buildReportViewModel(profile, images);
  // print 模式：合成路径（声明 layout 的模板）不带静态 loading="lazy" 与弱网
  // 降级脚本——renderReportPdf 在 setContent 后用 document.images 的 load/
  // error 事件等待全部图片，静态 lazy 会让视口外图片永不触发 load、PDF 生成
  // 挂起（见 ResponsiveCompositionOptions 注释）。段式路径（无 layout 模板）
  // 的静态标记沿用 T6 交付，不随本参数变化。
  return buildResponsiveReportHtml(viewModel, meta, template, "print");
}

export async function renderReportPdf(
  browserBinding: BrowserWorker,
  profile: ResultProfileSnapshot,
  images: Record<string, string> = {},
  meta: ResponsiveReportMeta = {},
  options: ReportPdfOptions = {},
  template: ReportTemplateSpec = DEFAULT_REPORT_TEMPLATE,
): Promise<ReportPdfResult> {
  const browser = await launchBrowser(browserBinding, { kind: "report-pdf", responseId: meta.reportId });
  try {
    const page = await newSandboxedPage(browser);
    const maxImageDimension = options.maxImageDimension ?? 1200;
    const optimizedImages = await optimizeReportImagesInPage(page, images, {
      maxImageDimension: {
        thumbnail: 400,
        card: 800,
        gallery: maxImageDimension,
        featured: 1600,
        hero: 1600,
      },
    });
    const html = buildReportPdfDocument(profile, optimizedImages, meta, template);
    await page.setContent(html, { waitUntil: "load" });
    await page.evaluate("document.fonts ? document.fonts.ready : Promise.resolve()");
    await page.evaluate(
      "Promise.all(Array.from(document.images).map((image) => image.complete ? Promise.resolve() : new Promise((resolve) => { image.addEventListener('load', resolve, { once: true }); image.addEventListener('error', resolve, { once: true }); })))",
    );
    const bytes = new Uint8Array(
      await page.pdf({
        format: "A4",
        printBackground: true,
        margin: { top: "10mm", right: "10mm", bottom: "12mm", left: "10mm" },
      }),
    );
    return { bytes, byteSize: bytes.byteLength };
  } finally {
    await browser.close();
  }
}
