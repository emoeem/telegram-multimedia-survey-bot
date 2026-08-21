import puppeteer, { type BrowserWorker } from "@cloudflare/puppeteer";
import { buildResponseReportHtmlDocument } from "./response-report/html";
import type { ResponseReport, ResponseReportRenderResult, ResponseReportRenderedPage } from "./response-report/model";
import { planResponseReportPages } from "./response-report/pagination";

export type { ReportFragment, ResponseReport, ResponseReportDensity, ResponseReportItem, ResponseReportMedia, ResponseReportOption, ResponseReportPage, ResponseReportRenderResult } from "./response-report/model";
export { planResponseReportPages, responseReportDensity } from "./response-report/pagination";
export { validateResponseReportPages, validateResponseReportSource as validateResponseReport } from "./response-report/validation";

const TARGET_PAGE_BYTES = 5 * 1024 * 1024;
const HARD_MAX_PAGE_BYTES = 10 * 1024 * 1024;
const TARGET_TOTAL_BYTES = 40 * 1024 * 1024;

async function waitForResponseReportAssets(page: Awaited<ReturnType<Awaited<ReturnType<typeof puppeteer.launch>>["newPage"]>>): Promise<void> {
  await page.evaluate("document.fonts ? document.fonts.ready : Promise.resolve()");
  await page.evaluate("Promise.all(Array.from(document.images).map((image) => image.complete ? Promise.resolve() : new Promise((resolve) => { image.addEventListener('load', resolve, { once: true }); image.addEventListener('error', resolve, { once: true }); })))");
}

export function buildResponseReportHtml(report: ResponseReport): string {
  return buildResponseReportHtmlDocument(report, planResponseReportPages(report));
}

async function assertNoVisualOverflow(page: Awaited<ReturnType<Awaited<ReturnType<typeof puppeteer.launch>>["newPage"]>>): Promise<void> {
  const overflowPage = await page.evaluate("(()=>{for(const page of document.querySelectorAll('.page')){const content=page.querySelector('.page-content');if(content&&content.scrollHeight>content.clientHeight+1)return page.getAttribute('data-page')}return null})()");
  if (overflowPage) throw new Error(`Page split validation failed: rendered page ${overflowPage} overflows its fixed canvas`);
}

async function repaginateRenderedReport(page: Awaited<ReturnType<Awaited<ReturnType<typeof puppeteer.launch>>["newPage"]>>): Promise<number> {
  const pageCount = await page.evaluate(`(()=>{
    const isOverflowing=(element)=>element.scrollHeight>element.clientHeight+1;
    const blocked=new WeakSet();
    let passes=0;
    while(passes++<500){
      const pages=Array.from(document.querySelectorAll('.page'));
      let changed=false;
      for(let index=0;index<pages.length;index+=1){
        const current=pages[index];
        const content=current.querySelector('.page-content');
        if(!content||blocked.has(content)||!isOverflowing(content))continue;
        const fragment=content.querySelector('.question-block:last-of-type');
        if(!fragment)continue;
        const questionBlocks=content.querySelectorAll(':scope > .question-block');
        if(questionBlocks.length===1&&content.children.length===1){
          const ratio=Math.max(.55,Math.min(.98,content.clientHeight/content.scrollHeight*.96));
          fragment.style.setProperty('zoom',String(ratio));
          if(isOverflowing(content))blocked.add(content);
          changed=true;
          break;
        }
        let next=pages[index+1];
        if(!next){
          next=current.cloneNode(true);
          next.querySelector('.page-content').replaceChildren();
          current.after(next);
        }
        next.querySelector('.page-content').prepend(fragment);
        changed=true;
        break;
      }
      if(!changed)break;
    }
    const pages=Array.from(document.querySelectorAll('.page'));
    const total=pages.length;
    pages.forEach((element,index)=>{
      const number=index+1;
      element.setAttribute('data-page',String(number));
      const header=element.querySelector('.page-header span:last-child');
      const footer=element.querySelector('.page-footer span:last-child');
      const pageLabel=String(number).padStart(2,'0')+' / '+String(total).padStart(2,'0');
      if(header){const marker=header.textContent.lastIndexOf('PAGE ');if(marker>=0)header.textContent=header.textContent.slice(0,marker)+'PAGE '+pageLabel;}
      if(footer)footer.textContent=pageLabel;
    });
    return total;
  })()`);
  if (typeof pageCount !== "number") throw new Error("Page split validation failed: rendered page count is unavailable");
  return pageCount;
}

async function capturePngPages(page: Awaited<ReturnType<Awaited<ReturnType<typeof puppeteer.launch>>["newPage"]>>, pageCount: number, startNumber: number): Promise<ResponseReportRenderedPage[]> {
  const pages: ResponseReportRenderedPage[] = [];
  for (let localPageNumber = 1; localPageNumber <= pageCount; localPageNumber += 1) {
    const bytes = new Uint8Array(await page.screenshot({
      type: "png",
      clip: { x: 0, y: (localPageNumber - 1) * 1200, width: 900, height: 1200 },
      captureBeyondViewport: true,
    }));
    const pageNumber = startNumber + localPageNumber - 1;
    if (bytes.byteLength > HARD_MAX_PAGE_BYTES) throw new Error(`PNG page ${pageNumber} exceeds the 10 MB hard limit after image optimization`);
    pages.push({ number: pageNumber, bytes, byteSize: bytes.byteLength, dpr: 1, width: 900, height: 1200, overTargetSize: bytes.byteLength > TARGET_PAGE_BYTES });
  }
  return pages;
}

async function renderPngReport(
  page: Awaited<ReturnType<Awaited<ReturnType<typeof puppeteer.launch>>["newPage"]>>,
  report: ResponseReport,
  plannedPages: ReturnType<typeof planResponseReportPages>,
): Promise<ResponseReportRenderResult> {
  const pages: ResponseReportRenderedPage[] = [];
  for (const plannedPage of plannedPages) {
    await page.setViewport({ width: 900, height: 1200, deviceScaleFactor: 1 });
    await page.setContent(buildResponseReportHtmlDocument(report, [plannedPage]), { waitUntil: "load" });
    await waitForResponseReportAssets(page);
    const pageCount = await repaginateRenderedReport(page);
    await assertNoVisualOverflow(page);
    pages.push(...await capturePngPages(page, pageCount, pages.length + 1));
  }
  const totalBytes = pages.reduce((sum, item) => sum + item.byteSize, 0);
  return { format: "png", pages, totalBytes, targetTotalBytesExceeded: totalBytes > TARGET_TOTAL_BYTES };
}

export async function renderResponseReport(browserBinding: BrowserWorker, sourceReport: ResponseReport, format: "pdf" | "png"): Promise<ResponseReportRenderResult> {
  const browser = await puppeteer.launch(browserBinding);
  try {
    const page = await browser.newPage();
    try {
      const pages = planResponseReportPages(sourceReport);
      if (format === "png") return renderPngReport(page, sourceReport, pages);
      await page.setViewport({ width: 900, height: 1200, deviceScaleFactor: 1 });
      await page.setContent(buildResponseReportHtmlDocument(sourceReport, pages), { waitUntil: "load" });
      await waitForResponseReportAssets(page);
      const pageCount = await repaginateRenderedReport(page);
      await assertNoVisualOverflow(page);
      const bytes = new Uint8Array(await page.pdf({ format: "A4", printBackground: true, margin: { top: "0", right: "0", bottom: "0", left: "0" } }));
      return { format: "pdf", bytes, byteSize: bytes.byteLength, pageCount };
    } finally {
      await page.close();
    }
  } finally {
    await browser.close();
  }
}
