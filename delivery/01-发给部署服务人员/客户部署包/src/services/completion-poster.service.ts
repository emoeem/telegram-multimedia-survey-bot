import puppeteer, { type BrowserWorker } from "@cloudflare/puppeteer";
import type { CompletionPosterStyle } from "../db/repositories/completion-poster.repository";

export interface CompletionPosterData {
  surveyTitle: string;
  completedAt: string;
  style: CompletionPosterStyle;
  imageDataUrl?: string;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export function buildCompletionPosterHtml(data: CompletionPosterData): string {
  const themes = {
    clean: ["#f6f8fb", "#153b5b", "#2e9b83"],
    cute: ["#fff4fa", "#743258", "#eb6f92"],
    editorial: ["#f1f2ed", "#252525", "#d26435"],
    bold: ["#16191d", "#ffffff", "#f3cb3f"],
  } as const;
  const [background, foreground, accent] = themes[data.style];
  const image = data.imageDataUrl ? `<img src="${data.imageDataUrl}" alt="">` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box} body{margin:0;width:1080px;height:1350px;background:${background};color:${foreground};font-family:"Noto Sans CJK SC","Microsoft YaHei",sans-serif;letter-spacing:0}.poster{height:100%;padding:86px;display:flex;flex-direction:column;justify-content:space-between}.image{height:500px;background:${accent};overflow:hidden}.image img{width:100%;height:100%;object-fit:cover}.tag{font-size:30px;font-weight:700;color:${accent}}h1{font-size:76px;line-height:1.15;margin:22px 0 0;overflow-wrap:anywhere}.done{font-size:46px;font-weight:700;margin:0}.date{font-size:25px;opacity:.8;margin:14px 0 0}.bar{height:14px;width:180px;background:${accent};margin-top:46px}
  </style></head><body><main class="poster"><div><div class="tag">SURVEY COMPLETE</div><h1>${escapeHtml(data.surveyTitle)}</h1><div class="bar"></div></div><div class="image">${image}</div><div><p class="done">已完成，感谢参与</p><p class="date">${escapeHtml(data.completedAt)}</p></div></main></body></html>`;
}

export async function renderCompletionPoster(browserBinding: BrowserWorker, data: CompletionPosterData): Promise<Uint8Array> {
  const browser = await puppeteer.launch(browserBinding);
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1080, height: 1350, deviceScaleFactor: 1 });
    await page.setContent(buildCompletionPosterHtml(data), { waitUntil: "load" });
    return new Uint8Array(await page.screenshot({ type: "png" }));
  } finally { await browser.close(); }
}
