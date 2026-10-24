import puppeteer, { type BrowserWorker } from "@cloudflare/puppeteer";
import type {
  CompletionTimeBucket,
  NumericStat,
  OptionStat,
  SurveyStatistics,
} from "./statistics.service";
import {
  renderPieChartSvg,
  renderDonutChartSvg,
  renderProgressDonutSvg,
  renderSurveyBarChartSvg,
  renderHistogramSvg,
  renderQuickSnapshotSvg,
  type ChartColors,
} from "./report/charts";

export interface SurveySummaryReport {
  surveyTitle: string;
  surveyId: number;
  generatedAt: string;
  statistics: SurveyStatistics;
  optionStatistics: OptionStat[];
  numericStatistics: NumericStat[];
  completionTimeBuckets?: CompletionTimeBucket[];
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

const REPORT_COLORS: ChartColors = {
  accent: "#4f46e5",
  text: "#0f172a",
  muted: "#64748b",
  border: "#e5e9f0",
};

function groupByQuestion(options: OptionStat[]): Map<number, OptionStat[]> {
  const grouped = new Map<number, OptionStat[]>();
  for (const stat of options) {
    const rows = grouped.get(stat.questionId) ?? [];
    rows.push(stat);
    grouped.set(stat.questionId, rows);
  }
  return grouped;
}

function renderMetricCard(label: string, value: string, accent = false): string {
  return `<div class="metric${accent ? " metric-accent" : ""}">
    <div class="metric-label">${escapeHtml(label)}</div>
    <div class="metric-value">${escapeHtml(value)}</div>
  </div>`;
}

function renderOptionQuestionSection(rows: OptionStat[]): string {
  const first = rows[0];
  if (!first) return "";
  const total = rows.reduce((sum, r) => sum + r.count, 0);

  const slices = rows.map((r) => ({ label: r.optionLabel, value: r.count }));
  const pieSvg = renderPieChartSvg(slices, REPORT_COLORS, 240, 200);

  const championIdx = rows.reduce((best, r, i, arr) => (r.count > arr[best]!.count ? i : best), 0);
  const champion = rows[championIdx]!;
  const championPct = champion.percentage;

  const tableRows = rows
    .map((row, idx) => {
      const isChampion = idx === championIdx && total > 0;
      return `
      <tr class="${isChampion ? "row-champion" : ""}">
        <td class="opt-label">
          ${escapeHtml(row.optionLabel)}
          ${isChampion ? `<span class="champion-badge" title="最多人选择">★ ${championPct.toFixed(0)}%</span>` : ""}
        </td>
        <td class="opt-bar-cell">
          <div class="opt-bar"><span style="width:${Math.min(100, row.percentage)}%"></span></div>
        </td>
        <td class="opt-count">${row.count}</td>
        <td class="opt-pct">${row.percentage.toFixed(1)}%</td>
      </tr>`;
    })
    .join("");

  return `
    <section class="question-block">
      <div class="question-header">
        <div class="question-index">Q${first.questionId}</div>
        <h3>${escapeHtml(first.questionTitle)}</h3>
        <span class="question-type">${questionTypeLabel(first.questionType)}</span>
        <span class="question-champ" title="最高票选项">冠军 ${escapeHtml(champion.optionLabel)} · ${championPct.toFixed(1)}%</span>
      </div>
      <div class="question-body">
        <div class="question-table-wrap">
          <table class="option-table">
            <thead>
              <tr><th>选项</th><th>分布</th><th class="num">人数</th><th class="num">占比</th></tr>
            </thead>
            <tbody>${tableRows}</tbody>
            <tfoot>
              <tr><td colspan="2" class="opt-total">有效样本</td><td class="num opt-total">${total}</td><td class="num opt-total">100%</td></tr>
            </tfoot>
          </table>
        </div>
        ${pieSvg ? `<div class="question-chart">${pieSvg}</div>` : ""}
      </div>
    </section>`;
}

function questionTypeLabel(type: string): string {
  const map: Record<string, string> = {
    single: "单选",
    multiple: "多选",
    yes_no: "是/否",
    rating: "评分",
  };
  return map[type] ?? type;
}

function renderNumericSection(numericStats: NumericStat[]): string {
  if (!numericStats.length) return "";

  const barData = numericStats.map((s) => ({
    label: s.questionTitle,
    value: s.average ?? 0,
  }));
  const barSvg = renderSurveyBarChartSvg(barData, REPORT_COLORS, 420, Math.max(240, numericStats.length * 46));

  const tableRows = numericStats
    .map(
      (stat) => `
      <tr>
        <td class="num-question">${escapeHtml(stat.questionTitle)}</td>
        <td class="num">${stat.count}</td>
        <td class="num num-strong">${formatNumber(stat.average)}</td>
        <td class="num">${formatNumber(stat.min)}</td>
        <td class="num">${formatNumber(stat.max)}</td>
      </tr>`,
    )
    .join("");

  const snapshotRows = numericStats
    .filter((s) => s.average !== null)
    .slice(0, 8)
    .map((s) => ({
      label: s.questionTitle,
      value: Math.round((s.average ?? 0) * 10),
      max: 50,
    }));
  const snapshotSvg = snapshotRows.length >= 2
    ? renderQuickSnapshotSvg(snapshotRows, REPORT_COLORS, 260, 24)
    : "";

  return `
    <section class="numeric-block">
      <div class="section-heading">
        <span class="section-number">01</span>
        <div class="section-title-group">
          <h2>评分与数字题</h2>
          <span class="section-caption">各题平均值对比 · 共 ${numericStats.length} 道</span>
        </div>
        <span class="section-count">${numericStats.length} 道</span>
      </div>
      <div class="numeric-body">
        <div class="numeric-table-wrap">
          <table class="numeric-table">
            <thead>
              <tr><th>题目</th><th class="num">样本</th><th class="num">平均值</th><th class="num">最小</th><th class="num">最大</th></tr>
            </thead>
            <tbody>${tableRows}</tbody>
          </table>
          ${snapshotSvg ? `<div class="snapshot-wrap"><div class="snapshot-label">快速快照（标准化 0–5）</div>${snapshotSvg}</div>` : ""}
        </div>
        <div class="numeric-chart">
          <div class="chart-caption">各题平均值横向对比</div>
          ${barSvg}
        </div>
      </div>
    </section>`;
}

function renderTimelineSection(buckets: CompletionTimeBucket[]): string {
  if (buckets.length < 2) return "";

  const histogramSvg = renderHistogramSvg(buckets, REPORT_COLORS, 520, 200);
  const total = buckets.reduce((s, b) => s + b.count, 0);

  let peak = buckets[0]!;
  for (const b of buckets) if (b.count > peak.count) peak = b;

  const first = buckets[0]!;
  const last = buckets[buckets.length - 1]!;
  const trendIcon = last.count >= first.count ? "↗" : "↘";
  const trendLabel = last.count >= first.count ? "上升趋势" : "下降趋势";

  return `
    <section class="timeline-block">
      <div class="section-heading">
        <span class="section-number">02</span>
        <div class="section-title-group">
          <h2>答题时间分布</h2>
          <span class="section-caption">最近 ${buckets.length} 天完成情况</span>
        </div>
        <span class="section-count">${total} 份</span>
      </div>
      <div class="timeline-body">
        <div class="timeline-chart-wrap">
          ${histogramSvg}
        </div>
        <div class="timeline-insights">
          <div class="insight-card">
            <div class="insight-kicker">PEAK DAY</div>
            <div class="insight-value">${peak.count}<small>份</small></div>
            <div class="insight-label">高峰日 ${escapeHtml(peak.label)}</div>
          </div>
          <div class="insight-card">
            <div class="insight-kicker">TREND</div>
            <div class="insight-value">${trendIcon}</div>
            <div class="insight-label">${trendLabel}</div>
          </div>
          <div class="insight-card">
            <div class="insight-kicker">DAILY AVG</div>
            <div class="insight-value">${(total / buckets.length).toFixed(1)}</div>
            <div class="insight-label">日均完成</div>
          </div>
        </div>
      </div>
    </section>`;
}

function renderOverviewSection(report: SurveySummaryReport): string {
  const { statistics } = report;
  const { totalStarted, totalCompleted, completionRate } = statistics;
  const inProgress = totalStarted - totalCompleted;

  const progressDonut = renderProgressDonutSvg(
    totalCompleted,
    totalStarted,
    REPORT_COLORS,
    140,
    140,
  );

  const statusSlices = [
    { label: "已完成", value: totalCompleted },
    { label: "进行中", value: Math.max(0, inProgress) },
  ];
  const statusDonut = renderDonutChartSvg(statusSlices, REPORT_COLORS, 150, 150, "份答卷");

  return `
    <section class="overview-block">
      <div class="overview-left">
        <div class="donut-wrap">
          ${progressDonut}
        </div>
        <div class="overview-title">
          <div class="overview-kicker">SURVEY OVERVIEW</div>
          <div class="overview-completed">
            <span class="big-number">${totalCompleted}</span>
            <span class="big-label">已完成</span>
          </div>
          <div class="overview-sub">共 ${totalStarted} 份答卷 · 完成率 ${completionRate.toFixed(1)}%</div>
        </div>
      </div>
      <div class="overview-right">
        <div class="metric-stack">
          ${renderMetricCard("开始填写", String(totalStarted))}
          ${renderMetricCard("完成填写", String(totalCompleted), true)}
          ${renderMetricCard("进行中", String(Math.max(0, inProgress)))}
          ${renderMetricCard("完成率", `${completionRate.toFixed(1)}%`, true)}
        </div>
        ${statusDonut ? `<div class="status-donut">${statusDonut}</div>` : ""}
      </div>
    </section>`;
}

function renderOptionSection(options: OptionStat[]): string {
  if (!options.length) return "";

  const grouped = groupByQuestion(options);
  const questionCount = grouped.size;

  const questionSections = [...grouped.values()]
    .map((rows) => renderOptionQuestionSection(rows))
    .join("");

  return `
    <section class="option-block">
      <div class="section-heading">
        <span class="section-number">03</span>
        <div class="section-title-group">
          <h2>选项类题目</h2>
          <span class="section-caption">各题选项分布 · 每题标出冠军选项</span>
        </div>
        <span class="section-count">${questionCount} 道</span>
      </div>
      ${questionSections}
    </section>`;
}

export function buildSurveySummaryReportHtml(report: SurveySummaryReport): string {
  const hasOptions = report.optionStatistics.length > 0;
  const hasNumeric = report.numericStatistics.length > 0;
  const hasTimeline = (report.completionTimeBuckets?.length ?? 0) >= 2;

  const overviewHtml = renderOverviewSection(report);
  const numericHtml = hasNumeric ? renderNumericSection(report.numericStatistics) : "";
  const timelineHtml = hasTimeline ? renderTimelineSection(report.completionTimeBuckets!) : "";
  const optionHtml = hasOptions ? renderOptionSection(report.optionStatistics) : "";

  const emptyState = !hasOptions && !hasNumeric && !hasTimeline
    ? `<div class="empty-state">暂无可统计的选项、评分或数字答案。</div>`
    : "";

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(report.surveyTitle)} - 统计报告</title>
  <style>
    @page { size: A4; margin: 14mm; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #f4f6fa; color: #0f172a; font: 14px/1.6 -apple-system, "PingFang SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }

    .page { max-width: 960px; margin: 0 auto; background: #fff; box-shadow: 0 0 30px rgba(15, 23, 42, 0.08); }

    /* Header */
    .report-header { padding: 44px 56px 32px; position: relative; background: linear-gradient(180deg, #fafbff 0%, #fff 100%); border-bottom: 1px solid #eef1f6; }
    .report-header::after { content: ""; position: absolute; bottom: -1px; left: 0; right: 0; height: 3px; background: linear-gradient(90deg, #4f46e5, #7c3aed, #ec4899); }
    .brand { display: inline-flex; align-items: center; gap: 10px; margin-bottom: 16px; }
    .brand-mark { width: 34px; height: 34px; border-radius: 10px; background: linear-gradient(135deg, #4f46e5, #7c3aed); box-shadow: 0 4px 12px -4px rgba(79, 70, 229, 0.6); }
    .brand-text { color: #4f46e5; font-weight: 600; letter-spacing: .06em; font-size: 12px; text-transform: uppercase; }
    h1 { margin: 0; color: #0f172a; font-size: 30px; line-height: 1.25; letter-spacing: -0.01em; }
    .meta-row { margin-top: 12px; color: #64748b; font-size: 13px; display: flex; gap: 0; flex-wrap: wrap; }
    .meta-row span { margin-right: 18px; }
    .meta-row span::before { content: "·"; margin-right: 10px; color: #cbd5e1; }
    .meta-row span:first-child::before { display: none; }

    /* Overview */
    .overview-block { display: grid; grid-template-columns: 1fr 1fr; gap: 32px; padding: 36px 56px; background: #fff; border-bottom: 1px solid #eef1f6; }
    .overview-left { display: flex; align-items: center; gap: 28px; }
    .donut-wrap { flex-shrink: 0; }
    .overview-title { min-width: 0; }
    .overview-kicker { font-size: 11px; letter-spacing: .18em; color: #4f46e5; font-weight: 700; margin-bottom: 10px; }
    .overview-completed { display: flex; align-items: baseline; gap: 10px; margin-bottom: 4px; }
    .big-number { font-size: 52px; font-weight: 700; color: #0f172a; line-height: 1; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
    .big-label { font-size: 13px; color: #64748b; }
    .overview-sub { font-size: 13px; color: #94a3b8; }
    .overview-right { display: flex; gap: 20px; align-items: center; justify-content: flex-end; }
    .metric-stack { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
    .metric { padding: 12px 16px; background: #f8fafc; border: 1px solid #eef1f6; border-radius: 10px; min-width: 108px; }
    .metric-accent { background: linear-gradient(135deg, #4f46e5, #7c3aed); border-color: transparent; color: #fff; box-shadow: 0 4px 12px -4px rgba(79, 70, 229, 0.5); }
    .metric-accent .metric-label, .metric-accent .metric-value { color: #fff; }
    .metric-label { font-size: 11px; color: #94a3b8; letter-spacing: .03em; }
    .metric-value { font-size: 20px; font-weight: 700; color: #0f172a; margin-top: 2px; font-variant-numeric: tabular-nums; }
    .status-donut { flex-shrink: 0; }

    /* Section heading — 统一风格 */
    .section-heading { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 18px; margin-bottom: 24px; padding-bottom: 14px; border-bottom: 1px solid #e5e9f0; }
    .section-number { font-size: 40px; font-weight: 800; color: #f1f5f9; letter-spacing: -0.03em; font-variant-numeric: tabular-nums; line-height: 1; }
    .section-title-group { display: flex; flex-direction: column; gap: 2px; }
    .section-title-group h2 { margin: 0; font-size: 18px; color: #0f172a; font-weight: 700; letter-spacing: -0.01em; }
    .section-caption { font-size: 12px; color: #94a3b8; }
    .section-count { font-size: 12px; color: #64748b; background: #f1f5f9; padding: 4px 12px; border-radius: 999px; font-weight: 500; }

    /* Question blocks */
    .question-block { margin-bottom: 22px; break-inside: avoid; }
    .question-header { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
    .question-index { font-size: 11px; font-weight: 700; color: #fff; background: linear-gradient(135deg, #4f46e5, #7c3aed); padding: 4px 10px; border-radius: 6px; letter-spacing: .03em; font-family: "SF Mono", ui-monospace, monospace; }
    .question-header h3 { margin: 0; font-size: 15px; color: #0f172a; font-weight: 600; flex: 1; min-width: 0; }
    .question-type { font-size: 11px; color: #64748b; background: #f1f5f9; padding: 3px 9px; border-radius: 4px; }
    .question-champ { font-size: 11px; color: #a16207; background: #fef9e7; padding: 4px 10px; border-radius: 999px; font-weight: 500; border: 1px solid #fde68a; }
    .question-body { display: grid; grid-template-columns: 1fr 260px; gap: 20px; align-items: start; }
    .question-table-wrap { min-width: 0; }
    .question-chart { background: linear-gradient(180deg, #fafbff 0%, #f8faff 100%); border: 1px solid #eef1f6; border-radius: 12px; padding: 12px; display: flex; justify-content: center; }

    /* Option table */
    .option-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .option-table th, .option-table td { padding: 9px 12px; text-align: left; border-bottom: 1px solid #eef1f6; }
    .option-table th { color: #64748b; background: #f8fafc; font-weight: 600; font-size: 11px; letter-spacing: .02em; text-transform: uppercase; }
    .option-table td { color: #334155; }
    .option-table tbody tr:hover { background: #fafbff; }
    .option-table tr.row-champion td { background: linear-gradient(90deg, #fef9e7 0%, #fff 100%); }
    .opt-label { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: flex; align-items: center; gap: 6px; }
    .champion-badge { margin-left: auto; font-size: 10px; color: #a16207; background: #fde68a; padding: 2px 7px; border-radius: 4px; font-weight: 700; letter-spacing: .02em; flex-shrink: 0; }
    .opt-bar-cell { width: 35%; min-width: 100px; }
    .opt-bar { height: 8px; background: #eef1f6; border-radius: 99px; overflow: hidden; }
    .opt-bar span { display: block; height: 100%; background: linear-gradient(90deg, #4f46e5, #818cf8); border-radius: inherit; }
    .row-champion .opt-bar span { background: linear-gradient(90deg, #f59e0b, #fbbf24); }
    .opt-count { font-variant-numeric: tabular-nums; text-align: right; width: 60px; }
    .opt-pct { font-variant-numeric: tabular-nums; text-align: right; color: #64748b; width: 70px; font-weight: 500; }
    .opt-total { font-weight: 600; color: #334155; background: #f8fafc; }
    .opt-total.num { color: #0f172a; }

    .num { text-align: right; font-variant-numeric: tabular-nums; }
    .num-strong { color: #4f46e5; font-weight: 700; }
    .num-question { max-width: 280px; }

    /* Numeric block */
    .numeric-block { padding: 28px 56px; border-bottom: 1px solid #eef1f6; background: #fff; }
    .numeric-body { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; align-items: start; }
    .numeric-table-wrap { min-width: 0; display: flex; flex-direction: column; gap: 16px; }
    .numeric-chart { background: linear-gradient(180deg, #fafbff 0%, #f8faff 100%); border: 1px solid #eef1f6; border-radius: 12px; padding: 16px; }
    .chart-caption { font-size: 12px; color: #94a3b8; margin-bottom: 10px; letter-spacing: .02em; }
    .numeric-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .numeric-table th, .numeric-table td { padding: 9px 12px; text-align: left; border-bottom: 1px solid #eef1f6; }
    .numeric-table th { color: #64748b; background: #f8fafc; font-weight: 600; font-size: 11px; letter-spacing: .02em; text-transform: uppercase; }
    .numeric-table td { color: #334155; }
    .snapshot-wrap { background: #fafbff; border: 1px dashed #e5e9f0; border-radius: 10px; padding: 14px; }
    .snapshot-label { font-size: 11px; color: #94a3b8; letter-spacing: .04em; margin-bottom: 8px; font-weight: 600; }

    /* Timeline block */
    .timeline-block { padding: 28px 56px; border-bottom: 1px solid #eef1f6; background: #fff; }
    .timeline-body { display: grid; grid-template-columns: 1fr 280px; gap: 24px; align-items: start; }
    .timeline-chart-wrap { background: linear-gradient(180deg, #fafbff 0%, #f8faff 100%); border: 1px solid #eef1f6; border-radius: 12px; padding: 16px; }
    .timeline-insights { display: flex; flex-direction: column; gap: 12px; }
    .insight-card { padding: 14px 16px; background: linear-gradient(135deg, #fafbff 0%, #fff 100%); border: 1px solid #eef1f6; border-radius: 10px; }
    .insight-kicker { font-size: 10px; letter-spacing: .14em; color: #4f46e5; font-weight: 700; margin-bottom: 6px; }
    .insight-value { font-size: 26px; font-weight: 700; color: #0f172a; font-variant-numeric: tabular-nums; line-height: 1; }
    .insight-value small { font-size: 12px; color: #94a3b8; font-weight: 400; margin-left: 4px; }
    .insight-label { font-size: 12px; color: #64748b; margin-top: 4px; }

    /* Option block */
    .option-block { padding: 28px 56px; border-bottom: 1px solid #eef1f6; background: #fff; }

    /* Footer */
    .report-footer { padding: 22px 56px; color: #94a3b8; font-size: 12px; text-align: center; letter-spacing: .03em; background: #fafbfc; }

    /* Empty state */
    .empty-state { padding: 60px 56px; text-align: center; color: #94a3b8; font-size: 14px; }

    /* Responsive */
    @media (max-width: 760px) {
      .page { box-shadow: none; }
      .report-header { padding: 28px 24px 20px; }
      .overview-block { grid-template-columns: 1fr; padding: 28px 24px; gap: 24px; }
      .overview-right { justify-content: flex-start; }
      .numeric-block, .option-block, .timeline-block { padding: 24px; }
      .numeric-body, .timeline-body { grid-template-columns: 1fr; }
      .question-body { grid-template-columns: 1fr; }
      .question-chart, .numeric-chart, .timeline-chart-wrap, .snapshot-wrap { max-width: 360px; margin: 0 auto; }
      h1 { font-size: 22px; }
      .big-number { font-size: 40px; }
      .section-heading { grid-template-columns: auto 1fr; gap: 10px; }
      .section-count { grid-column: 1/-1; justify-self: start; }
      .insight-card { padding: 12px 14px; }
    }

    /* Print */
    @media print {
      body { background: #fff; }
      .page { box-shadow: none; max-width: none; }
      .question-chart svg, .numeric-chart svg, .status-donut svg, .donut-wrap svg, .timeline-chart-wrap svg, .snapshot-wrap svg { max-width: 100%; }
    }
  </style>
</head>
<body>
  <div class="page">
    <header class="report-header">
      <div class="brand">
        <span class="brand-mark"></span>
        <span class="brand-text">SURVEY ANALYSIS REPORT</span>
      </div>
      <h1>${escapeHtml(report.surveyTitle)}</h1>
      <div class="meta-row">
        <span>内部编号 #${report.surveyId}</span>
        <span>生成时间 ${escapeHtml(report.generatedAt)}</span>
        <span>共 ${report.statistics.totalStarted} 份答卷</span>
      </div>
    </header>

    ${overviewHtml}
    ${numericHtml}
    ${timelineHtml}
    ${optionHtml}
    ${emptyState}

    <footer class="report-footer">由问卷管理后台自动生成 · 数据截止 ${escapeHtml(report.generatedAt)}</footer>
  </div>
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
