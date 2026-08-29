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

  const numericSection =
    report.numericStatistics.length > 0
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
    body { margin: 0; color: #172033; font: 14px/1.6 -apple-system, "PingFang SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    header { padding-bottom: 20px; border-bottom: 1px solid #e5e9f0; }
    .brand { display: inline-flex; align-items: center; gap: 10px; margin-bottom: 14px; }
    .brand-mark { width: 34px; height: 34px; border-radius: 10px; background: linear-gradient(135deg, #4f46e5, #7c3aed); }
    h1 { margin: 0; color: #0f172a; font-size: 26px; line-height: 1.3; letter-spacing: -0.01em; }
    .meta { margin-top: 8px; color: #64748b; font-size: 13px; }
    .overview { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin: 22px 0; }
    .metric { padding: 14px 16px; background: #ffffff; border: 1px solid #e5e9f0; border-radius: 12px; box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04); }
    .metric span { color: #64748b; font-size: 13px; }
    .metric strong { display: block; margin-top: 6px; color: #0f172a; font-size: 22px; letter-spacing: -0.01em; }
    .question { margin-top: 22px; break-inside: avoid; }
    h2 { margin: 0 0 10px; color: #0f172a; font-size: 16px; display: flex; align-items: center; gap: 8px; }
    h2::before { content: ""; width: 4px; height: 15px; border-radius: 3px; background: #4f46e5; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 9px 10px; text-align: left; border-bottom: 1px solid #eef1f6; overflow-wrap: anywhere; }
    th { color: #64748b; background: #f8fafc; font-weight: 600; font-size: 12px; letter-spacing: 0.02em; }
    td { color: #3c4a5f; }
    tr:last-child td { border-bottom: 0; }
    .bar { height: 7px; margin-top: 7px; background: #eef1f6; border-radius: 99px; overflow: hidden; }
    .bar span { display: block; height: 100%; background: linear-gradient(90deg, #4f46e5, #818cf8); border-radius: inherit; }
    footer { margin-top: 28px; padding-top: 16px; border-top: 1px dashed #dde3ea; color: #94a3b8; font-size: 12px; text-align: center; }
  </style>
</head>
<body>
  <header>
    <div class="brand"><span class="brand-mark"></span><span style="color:#4f46e5;font-weight:600;letter-spacing:.04em;">SURVEY REPORT</span></div>
    <h1>${escapeHtml(report.surveyTitle)}</h1>
    <div class="meta">问卷统计报告 · 内部编号 ${report.surveyId} · 生成时间 ${escapeHtml(report.generatedAt)}</div>
  </header>
  <section class="overview">
    <div class="metric"><span>开始填写</span><strong>${report.statistics.totalStarted}</strong></div>
    <div class="metric"><span>完成填写</span><strong>${report.statistics.totalCompleted}</strong></div>
    <div class="metric"><span>完成率</span><strong>${report.statistics.completionRate.toFixed(1)}%</strong></div>
  </section>
  ${optionSections || ""}
  ${numericSection}
  ${!optionSections && !numericSection ? '<section class="question">暂无可统计的选项、评分或数字答案。</section>' : ""}
  <footer>由问卷管理后台自动生成</footer>
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
