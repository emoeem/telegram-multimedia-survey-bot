import puppeteer, { type BrowserWorker } from "@cloudflare/puppeteer";
import type { NumericStat, OptionStat, SurveyStatistics } from "./statistics.service";

export interface SurveySummaryReport {
  surveyTitle: string;
  surveyId: number;
  generatedAt: string;
  statistics: SurveyStatistics;
  optionStatistics: OptionStat[];
  numericStatistics: NumericStat[];
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatNumber(value: number | null): string {
  return value === null ? "-" : Number.isInteger(value) ? String(value) : value.toFixed(2);
}

export function buildSurveySummaryReportHtml(report: SurveySummaryReport): string {
  const groupedOptions = new Map<number, OptionStat[]>();
  for (const stat of report.optionStatistics) {
    const rows = groupedOptions.get(stat.questionId) ?? [];
    rows.push(stat);
    groupedOptions.set(stat.questionId, rows);
  }

  const optionSections = [...groupedOptions.values()]
    .map((rows) => {
      const first = rows[0];
      if (!first) return "";
      return `
        <section class="question">
          <h2>${escapeHtml(first.questionTitle)}</h2>
          <table>
            <thead><tr><th>选项</th><th>人数</th><th>占比</th></tr></thead>
            <tbody>${rows.map((row) => `<tr><td>${escapeHtml(row.optionLabel)}<div class="bar"><span style="width:${Math.min(100, row.percentage)}%"></span></div></td><td>${row.count}</td><td>${row.percentage.toFixed(1)}%</td></tr>`).join("")}</tbody>
          </table>
        </section>`;
    })
    .join("");

  const numericSection = report.numericStatistics.length > 0
    ? `<section class="question"><h2>评分与数字题</h2><table><thead><tr><th>题目</th><th>样本数</th><th>平均值</th><th>最小值</th><th>最大值</th></tr></thead><tbody>${report.numericStatistics.map((stat) => `<tr><td>${escapeHtml(stat.questionTitle)}</td><td>${stat.count}</td><td>${formatNumber(stat.average)}</td><td>${formatNumber(stat.min)}</td><td>${formatNumber(stat.max)}</td></tr>`).join("")}</tbody></table></section>`
    : "";

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(report.surveyTitle)} - 统计报告</title>
  <style>
    @page { size: A4; margin: 14mm; }
    * { box-sizing: border-box; }
    body { margin: 0; color: #17202a; font: 14px/1.55 "Noto Sans CJK SC", "Microsoft YaHei", sans-serif; letter-spacing: 0; }
    header { padding-bottom: 18px; border-bottom: 3px solid #2274a5; }
    h1 { margin: 0; color: #102a43; font-size: 26px; line-height: 1.3; }
    .meta { margin-top: 8px; color: #486581; }
    .overview { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin: 20px 0; }
    .metric { padding: 12px; background: #f5f7fa; border-left: 4px solid #f0a202; }
    .metric strong { display: block; color: #102a43; font-size: 20px; }
    .question { margin-top: 20px; break-inside: avoid; }
    h2 { margin: 0 0 8px; color: #102a43; font-size: 17px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 8px; text-align: left; border-bottom: 1px solid #d9e2ec; overflow-wrap: anywhere; }
    th { color: #334e68; background: #f5f7fa; font-weight: 600; }
    .bar { height: 6px; margin-top: 5px; background: #d9e2ec; border-radius: 99px; overflow: hidden; }
    .bar span { display: block; height: 100%; background: #2274a5; border-radius: inherit; }
  </style>
</head>
<body>
  <header>
    <h1>${escapeHtml(report.surveyTitle)}</h1>
    <div class="meta">问卷统计报告 · 内部编号 ${report.surveyId} · 生成时间 ${escapeHtml(report.generatedAt)}</div>
  </header>
  <section class="overview">
    <div class="metric">开始填写<strong>${report.statistics.totalStarted}</strong></div>
    <div class="metric">完成填写<strong>${report.statistics.totalCompleted}</strong></div>
    <div class="metric">完成率<strong>${report.statistics.completionRate.toFixed(1)}%</strong></div>
  </section>
  ${optionSections || ""}
  ${numericSection}
  ${!optionSections && !numericSection ? '<section class="question">暂无可统计的选项、评分或数字答案。</section>' : ""}
</body>
</html>`;
}

export async function renderSurveySummaryReport(
  browserBinding: BrowserWorker,
  report: SurveySummaryReport,
): Promise<Uint8Array> {
  const browser = await puppeteer.launch(browserBinding);
  try {
    const page = await browser.newPage();
    await page.setContent(buildSurveySummaryReportHtml(report), { waitUntil: "load" });
    const output = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "14mm", right: "14mm", bottom: "14mm", left: "14mm" },
    });
    return new Uint8Array(output);
  } finally {
    await browser.close();
  }
}
