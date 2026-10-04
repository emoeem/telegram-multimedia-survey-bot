import * as echarts from "echarts/core";
import { BarChart, RadarChart, PieChart } from "echarts/charts";
import { GridComponent, RadarComponent, LegendComponent, TooltipComponent, GraphicComponent } from "echarts/components";
import { SVGRenderer } from "echarts/renderers";

echarts.use([BarChart, RadarChart, PieChart, GridComponent, RadarComponent, LegendComponent, TooltipComponent, GraphicComponent, SVGRenderer]);

export interface ChartColors {
  accent: string;
  text: string;
  muted: string;
  border: string;
}

const REPORT_FONT = "-apple-system, 'PingFang SC', 'Noto Sans CJK SC', 'Microsoft YaHei', sans-serif";

function withAlpha(hex: string, alpha: number): string {
  if (/^#[0-9a-fA-F]{6}$/.test(hex)) {
    return `${hex}${Math.round(alpha * 255)
      .toString(16)
      .padStart(2, "0")}`;
  }
  return hex;
}

function svgWithClass(svg: string, className: string): string {
  return svg.replace(/^<svg/, `<svg class="${className}"`);
}

/** Radar chart rendered server-side to an SVG string (ECharts SSR). */
export function renderRadarChartSvg(
  scores: Array<{ label: string; value: number }>,
  colors: ChartColors,
  width = 420,
  height = 300,
): string {
  const points = scores.slice(0, 6);
  if (points.length < 3) return "";
  const chart = echarts.init(null, null, { renderer: "svg", ssr: true, width, height });
  chart.setOption({
    radar: {
      indicator: points.map((score) => ({ name: score.label.slice(0, 8), max: 100 })),
      radius: "64%",
      center: ["50%", "52%"],
      splitNumber: 4,
      axisName: { color: colors.muted, fontSize: 11, fontFamily: REPORT_FONT },
      splitLine: { lineStyle: { color: colors.border } },
      axisLine: { lineStyle: { color: colors.border } },
      splitArea: { show: false },
    },
    series: [
      {
        type: "radar",
        symbol: "none",
        lineStyle: { color: colors.accent, width: 2 },
        areaStyle: { color: withAlpha(colors.accent, 0.28) },
        data: [{ value: points.map((score) => Math.max(0, Math.min(100, score.value))), name: "画像" }],
      },
    ],
  });
  const svg = chart.renderToSVGString();
  chart.dispose();
  return svg ? svgWithClass(svg, "radar") : "";
}

/** Horizontal bar chart for score dimensions (ECharts SSR). */
export function renderBarChartSvg(
  scores: Array<{ label: string; value: number; max: number }>,
  colors: ChartColors,
  width = 460,
  height = 300,
): string {
  if (!scores.length) return "";
  const chart = echarts.init(null, null, { renderer: "svg", ssr: true, width, height });
  chart.setOption({
    grid: { left: 100, right: 40, top: 12, bottom: 12 },
    xAxis: {
      type: "value",
      max: 100,
      splitLine: { lineStyle: { color: colors.border } },
      axisLabel: { color: colors.muted, fontSize: 11, fontFamily: REPORT_FONT },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    yAxis: {
      type: "category",
      inverse: true,
      data: scores.map((score) => score.label.slice(0, 10)),
      axisLabel: { color: colors.text, fontSize: 12, fontFamily: REPORT_FONT },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    series: [
      {
        type: "bar",
        data: scores.map((score) => Math.max(0, Math.min(100, (score.value / Math.max(1, score.max)) * 100))),
        barWidth: "55%",
        itemStyle: { color: colors.accent, borderRadius: [0, 6, 6, 0] },
        label: { show: true, position: "right", color: colors.muted, fontSize: 11, fontFamily: REPORT_FONT },
      },
    ],
  });
  const svg = chart.renderToSVGString();
  chart.dispose();
  return svg ? svgWithClass(svg, "bar-chart") : "";
}

const PIE_PALETTE = [
  "#6366f1", "#ec4899", "#14b8a6", "#f59e0b", "#ef4444",
  "#8b5cf6", "#06b6d4", "#84cc16", "#f97316", "#a855f7",
];

export function renderPieChartSvg(
  slices: Array<{ label: string; value: number }>,
  colors: ChartColors,
  width = 260,
  height = 220,
): string {
  const valid = slices.filter((s) => s.value > 0);
  if (valid.length < 2) return "";
  const chart = echarts.init(null, null, { renderer: "svg", ssr: true, width, height });
  chart.setOption({
    color: PIE_PALETTE,
    tooltip: { show: false },
    series: [
      {
        type: "pie",
        radius: ["40%", "68%"],
        center: ["38%", "52%"],
        avoidLabelOverlap: true,
        itemStyle: { borderColor: "#fff", borderWidth: 2, borderRadius: 3 },
        label: {
          show: true,
          position: "right",
          formatter: "{b}\n{d}%",
          color: colors.muted,
          fontSize: 11,
          fontFamily: REPORT_FONT,
          lineHeight: 14,
        },
        labelLine: { length: 8, length2: 6, lineStyle: { color: colors.border } },
        data: valid.map((s) => ({ name: s.label.slice(0, 14), value: s.value })),
      },
    ],
  });
  const svg = chart.renderToSVGString();
  chart.dispose();
  return svg ? svgWithClass(svg, "pie-chart") : "";
}

export function renderDonutChartSvg(
  slices: Array<{ label: string; value: number }>,
  colors: ChartColors,
  width = 200,
  height = 200,
  centerLabel?: string,
): string {
  const valid = slices.filter((s) => s.value > 0);
  if (valid.length < 1) return "";
  const total = valid.reduce((acc, s) => acc + s.value, 0);
  const chart = echarts.init(null, null, { renderer: "svg", ssr: true, width, height });
  chart.setOption({
    color: PIE_PALETTE,
    tooltip: { show: false },
    graphic: total > 0 && centerLabel
      ? [
          {
            type: "text",
            left: "center",
            top: "42%",
            style: {
              text: total.toString(),
              fontSize: 26,
              fontWeight: 700,
              fill: colors.accent,
              fontFamily: REPORT_FONT,
              textAlign: "center",
            },
          },
          {
            type: "text",
            left: "center",
            top: "62%",
            style: {
              text: centerLabel,
              fontSize: 11,
              fill: colors.muted,
              fontFamily: REPORT_FONT,
              textAlign: "center",
            },
          },
        ]
      : [],
    series: [
      {
        type: "pie",
        radius: ["62%", "82%"],
        center: ["50%", "50%"],
        avoidLabelOverlap: true,
        itemStyle: { borderColor: "#fff", borderWidth: 2, borderRadius: 4 },
        label: {
          show: true,
          position: "center",
          formatter: "",
        },
        labelLine: { show: false },
        data: valid.map((s) => ({ name: s.label.slice(0, 12), value: s.value })),
      },
    ],
  });
  const svg = chart.renderToSVGString();
  chart.dispose();
  return svg ? svgWithClass(svg, "donut-chart") : "";
}

export function renderProgressDonutSvg(
  value: number,
  max: number,
  colors: ChartColors,
  width = 120,
  height = 120,
): string {
  const pct = Math.max(0, Math.min(100, max === 0 ? 0 : (value / max) * 100));
  const chart = echarts.init(null, null, { renderer: "svg", ssr: true, width, height });
  chart.setOption({
    series: [
      {
        type: "pie",
        radius: ["70%", "88%"],
        center: ["50%", "50%"],
        silent: true,
        itemStyle: { borderWidth: 0 },
        label: { show: false },
        labelLine: { show: false },
        startAngle: 90,
        data: [
          {
            value: pct,
            name: "value",
            itemStyle: { color: colors.accent, borderRadius: 4 },
          },
          {
            value: 100 - pct,
            name: "rest",
            itemStyle: { color: colors.border },
          },
        ],
      },
    ],
    graphic: [
      {
        type: "text",
        left: "center",
        top: "44%",
        style: {
          text: `${pct.toFixed(0)}%`,
          fontSize: 18,
          fontWeight: 700,
          fill: colors.accent,
          fontFamily: REPORT_FONT,
          textAlign: "center",
        },
      },
      {
        type: "text",
        left: "center",
        top: "66%",
        style: {
          text: "完成率",
          fontSize: 9,
          fill: colors.muted,
          fontFamily: REPORT_FONT,
          textAlign: "center",
        },
      },
    ],
  });
  const svg = chart.renderToSVGString();
  chart.dispose();
  return svg ? svgWithClass(svg, "progress-donut") : "";
}

export function renderSurveyBarChartSvg(
  data: Array<{ label: string; value: number }>,
  colors: ChartColors,
  width = 420,
  height = 280,
): string {
  if (!data.length) return "";
  const max = Math.max(...data.map((d) => d.value), 1);
  const chart = echarts.init(null, null, { renderer: "svg", ssr: true, width, height });
  chart.setOption({
    grid: { left: 130, right: 40, top: 12, bottom: 12 },
    xAxis: {
      type: "value",
      max,
      splitLine: { lineStyle: { color: colors.border, type: "dashed" } },
      axisLabel: { color: colors.muted, fontSize: 10, fontFamily: REPORT_FONT },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    yAxis: {
      type: "category",
      inverse: true,
      data: data.map((d) => d.label.slice(0, 14)),
      axisLabel: { color: colors.text, fontSize: 12, fontFamily: REPORT_FONT },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    series: [
      {
        type: "bar",
        data: data.map((d) => ({
          value: d.value,
          itemStyle: {
            color: {
              type: "linear",
              x: 0, y: 0, x2: 1, y2: 0,
              colorStops: [
                { offset: 0, color: colors.accent },
                { offset: 1, color: withAlpha(colors.accent, 0.55) },
              ],
            },
            borderRadius: [0, 5, 5, 0],
          },
        })),
        barWidth: "52%",
        label: {
          show: true,
          position: "right",
          color: colors.muted,
          fontSize: 11,
          fontFamily: REPORT_FONT,
        },
      },
    ],
  });
  const svg = chart.renderToSVGString();
  chart.dispose();
  return svg ? svgWithClass(svg, "survey-bar") : "";
}

export function renderHistogramSvg(
  buckets: Array<{ label: string; count: number }>,
  colors: ChartColors,
  width = 520,
  height = 200,
): string {
  if (!buckets.length) return "";
  const chart = echarts.init(null, null, { renderer: "svg", ssr: true, width, height });
  chart.setOption({
    grid: { left: 36, right: 16, top: 20, bottom: 30 },
    xAxis: {
      type: "category",
      data: buckets.map((b) => b.label),
      axisLabel: { color: colors.muted, fontSize: 10, fontFamily: REPORT_FONT, interval: 0, rotate: buckets.length > 7 ? 30 : 0 },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    yAxis: {
      type: "value",
      splitLine: { lineStyle: { color: colors.border, type: "dashed" } },
      axisLabel: { color: colors.muted, fontSize: 10, fontFamily: REPORT_FONT },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    series: [
      {
        type: "bar",
        data: buckets.map((b) => ({
          value: b.count,
          itemStyle: {
            color: {
              type: "linear",
              x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: colors.accent },
                { offset: 1, color: withAlpha(colors.accent, 0.35) },
              ],
            },
            borderRadius: [5, 5, 0, 0],
          },
        })),
        barWidth: buckets.length > 14 ? "60%" : "68%",
        label: {
          show: true,
          position: "top",
          color: colors.muted,
          fontSize: 10,
          fontFamily: REPORT_FONT,
        },
      },
    ],
  });
  const svg = chart.renderToSVGString();
  chart.dispose();
  return svg ? svgWithClass(svg, "histogram") : "";
}

export function renderQuickSnapshotSvg(
  rows: Array<{ label: string; value: number; max: number }>,
  colors: ChartColors,
  width = 260,
  rowHeight = 22,
): string {
  if (!rows.length) return "";
  const height = Math.max(rows.length * rowHeight + 20, 80);
  const chart = echarts.init(null, null, { renderer: "svg", ssr: true, width, height });
  chart.setOption({
    grid: { left: 80, right: 40, top: 8, bottom: 8 },
    xAxis: {
      type: "value",
      max: 100,
      show: false,
    },
    yAxis: {
      type: "category",
      inverse: true,
      data: rows.map((r) => r.label.slice(0, 10)),
      axisLabel: { color: colors.text, fontSize: 11, fontFamily: REPORT_FONT },
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { show: false },
    },
    series: [
      {
        type: "bar",
        data: rows.map((r) => ({
          value: Math.max(0, Math.min(100, (r.value / Math.max(1, r.max)) * 100)),
          itemStyle: {
            color: colors.accent,
            borderRadius: [0, 4, 4, 0],
          },
        })),
        barWidth: "65%",
        label: {
          show: true,
          position: "right",
          formatter: (params: { dataIndex: number }) => {
            const row = rows[params.dataIndex];
            return row ? `${row.value}/${row.max}` : "";
          },
          color: colors.muted,
          fontSize: 10,
          fontFamily: REPORT_FONT,
        },
      },
    ],
  });
  const svg = chart.renderToSVGString();
  chart.dispose();
  return svg ? svgWithClass(svg, "quick-snapshot") : "";
}

