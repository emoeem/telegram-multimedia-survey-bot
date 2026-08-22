import puppeteer, { type BrowserWorker } from "@cloudflare/puppeteer";
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
  return buildResponsiveReportHtml(viewModel, meta, template);
}

export async function renderReportPdf(
  browserBinding: BrowserWorker,
  profile: ResultProfileSnapshot,
  images: Record<string, string> = {},
  meta: ResponsiveReportMeta = {},
  options: ReportPdfOptions = {},
  template: ReportTemplateSpec = DEFAULT_REPORT_TEMPLATE,
): Promise<ReportPdfResult> {
  const browser = await puppeteer.launch(browserBinding);
  try {
    const page = await browser.newPage();
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
    await page.evaluate("Promise.all(Array.from(document.images).map((image) => image.complete ? Promise.resolve() : new Promise((resolve) => { image.addEventListener('load', resolve, { once: true }); image.addEventListener('error', resolve, { once: true }); })))");
    const bytes = new Uint8Array(await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "10mm", right: "10mm", bottom: "12mm", left: "10mm" },
    }));
    return { bytes, byteSize: bytes.byteLength };
  } finally {
    await browser.close();
  }
}
