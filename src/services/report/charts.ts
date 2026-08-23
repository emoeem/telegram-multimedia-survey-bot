import * as echarts from "echarts/core";
import { BarChart, RadarChart } from "echarts/charts";
import { GridComponent, RadarComponent } from "echarts/components";
import { SVGRenderer } from "echarts/renderers";

echarts.use([BarChart, RadarChart, GridComponent, RadarComponent, SVGRenderer]);

export interface ChartColors {
  accent: string;
  text: string;
  muted: string;
  border: string;
}

const REPORT_FONT =
  "-apple-system, 'PingFang SC', 'Noto Sans CJK SC', 'Microsoft YaHei', sans-serif";

function withAlpha(hex: string, alpha: number): string {
  if (/^#[0-9a-fA-F]{6}$/.test(hex)) {
    return `${hex}${Math.round(alpha * 255).toString(16).padStart(2, "0")}`;
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
    grid: { left: 8, right: 28, top: 8, bottom: 8, containLabel: true },
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
