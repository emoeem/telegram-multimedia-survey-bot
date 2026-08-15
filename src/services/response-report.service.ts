import puppeteer, { type BrowserWorker } from "@cloudflare/puppeteer";

export interface ResponseReportMedia {
  label: string;
  imageDataUrl?: string;
}

export interface ResponseReportItem {
  number: number;
  title: string;
  answer: string;
  media: ResponseReportMedia[];
}

export interface ResponseReport {
  surveyTitle: string;
  responseNumber: number;
  status: string;
  respondent: string;
  startedAt: string;
  completedAt: string;
  items: ResponseReportItem[];
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function buildResponseReportHtml(report: ResponseReport): string {
  const items = report.items
    .map((item) => {
      const media = item.media
        .map(
          (entry) => `
            <div class="media">
              ${
                entry.imageDataUrl
                  ? `<img src="${escapeHtml(entry.imageDataUrl)}" alt="${escapeHtml(entry.label)}">`
                  : ""
              }
              <div class="media-label">${escapeHtml(entry.label)}</div>
            </div>`,
        )
        .join("");
      return `
        <section class="answer">
          <div class="question-number">第 ${item.number} 题</div>
          <h2>${escapeHtml(item.title)}</h2>
          <div class="answer-value">${escapeHtml(item.answer)}</div>
          ${media ? `<div class="media-list">${media}</div>` : ""}
        </section>`;
    })
    .join("");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(report.surveyTitle)} - 第 ${report.responseNumber} 份答卷</title>
  <style>
    @page { size: A4; margin: 14mm; }
    * { box-sizing: border-box; }
    html { background: #eef1f4; }
    body {
      margin: 0;
      color: #17202a;
      background: #eef1f4;
      font-family: "Noto Sans CJK SC", "Microsoft YaHei", "PingFang SC", sans-serif;
      font-size: 15px;
      line-height: 1.65;
      letter-spacing: 0;
    }
    .report {
      width: min(920px, 100%);
      min-height: 100vh;
      margin: 0 auto;
      padding: 42px 48px 56px;
      background: #ffffff;
    }
    header {
      padding-bottom: 24px;
      border-bottom: 3px solid #2274a5;
    }
    h1 {
      margin: 0 0 8px;
      color: #102a43;
      font-size: 28px;
      line-height: 1.3;
      font-weight: 700;
    }
    .subtitle { color: #486581; font-size: 17px; }
    .meta {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px 24px;
      margin-top: 20px;
      color: #334e68;
      font-size: 14px;
    }
    .meta strong { color: #102a43; font-weight: 600; }
    .answer {
      padding: 24px 0;
      border-bottom: 1px solid #d9e2ec;
      break-inside: avoid;
    }
    .question-number {
      color: #2274a5;
      font-size: 13px;
      font-weight: 700;
    }
    h2 {
      margin: 4px 0 12px;
      color: #102a43;
      font-size: 18px;
      line-height: 1.45;
    }
    .answer-value {
      min-height: 28px;
      padding: 12px 14px;
      color: #243b53;
      background: #f5f7fa;
      border-left: 4px solid #f0a202;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .media-list { margin-top: 14px; }
    .media { margin-top: 10px; break-inside: avoid; }
    .media img {
      display: block;
      max-width: 100%;
      max-height: 680px;
      object-fit: contain;
      border: 1px solid #bcccdc;
    }
    .media-label { margin-top: 5px; color: #627d98; font-size: 13px; }
    @media print {
      html, body { background: #ffffff; }
      .report { width: 100%; min-height: 0; margin: 0; padding: 0; }
    }
  </style>
</head>
<body>
  <main class="report">
    <header>
      <h1>${escapeHtml(report.surveyTitle)}</h1>
      <div class="subtitle">第 ${report.responseNumber} 份答卷</div>
      <div class="meta">
        <div><strong>状态：</strong>${escapeHtml(report.status)}</div>
        <div><strong>填写者：</strong>${escapeHtml(report.respondent)}</div>
        <div><strong>开始时间：</strong>${escapeHtml(report.startedAt)}</div>
        <div><strong>完成时间：</strong>${escapeHtml(report.completedAt)}</div>
      </div>
    </header>
    ${items || '<section class="answer">没有已保存的答案。</section>'}
  </main>
</body>
</html>`;
}

export async function renderResponseReport(
  browserBinding: BrowserWorker,
  report: ResponseReport,
  format: "pdf" | "png",
): Promise<Uint8Array> {
  const browser = await puppeteer.launch(browserBinding);
  try {
    const page = await browser.newPage();
    await page.setViewport({
      width: 1040,
      height: 1400,
      deviceScaleFactor: format === "png" ? 1.5 : 1,
    });
    await page.setContent(buildResponseReportHtml(report), {
      waitUntil: "load",
    });

    if (format === "pdf") {
      const output = await page.pdf({
        format: "A4",
        printBackground: true,
        margin: {
          top: "14mm",
          right: "14mm",
          bottom: "14mm",
          left: "14mm",
        },
      });
      return new Uint8Array(output);
    }

    const output = await page.screenshot({
      type: "png",
      fullPage: true,
      captureBeyondViewport: true,
    });
    return new Uint8Array(output);
  } finally {
    await browser.close();
  }
}
