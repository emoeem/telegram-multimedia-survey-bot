/**
 * ECharts option builders — pure functions, no React and no DOM.
 *
 * Split out of `charts.ts` so the option shapes can be unit-tested in the
 * worker's Node environment (the root tsconfig has no DOM lib); `charts.ts`
 * keeps the theme-aware `useChartColors()` hook and re-exports this module.
 */

export const PIE_PALETTE = ["#4f46e5", "#ec4899", "#14b8a6", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4", "#84cc16"];

export interface DonutSlice {
  name: string;
  value: number;
  color?: string;
}

export interface DonutOptions {
  radius?: [number | string, number | string];
  center?: [number | string, number | string];
  showLegend?: boolean;
  legendRight?: number;
  legendTop?: number | string;
}

/**
 * `opts.center` values are percentages; a bare number is treated as one so a
 * caller that forgets the "%" still lands on the donut instead of the origin.
 */
function percentPosition(value: number | string): string {
  if (typeof value === "number") return `${value}%`;
  return value;
}

export function donutOption(slices: DonutSlice[], opts: DonutOptions = {}) {
  const data = slices.filter((s) => s.value > 0).map((s) => ({
    name: s.name,
    value: s.value,
    itemStyle: s.color ? { color: s.color } : undefined,
  }));
  if (!data.length) return null;
  const total = data.reduce((sum, d) => sum + d.value, 0);
  const [centerX, centerY] = opts.center ?? ["38%", "50%"];
  return {
    tooltip: { trigger: "item", formatter: "{b}: {c} ({d}%)" },
    legend: opts.showLegend === false
      ? undefined
      : {
          orient: "vertical" as const,
          right: opts.legendRight ?? 0,
          top: opts.legendTop ?? "middle",
          itemWidth: 12,
          itemHeight: 12,
          itemGap: 10,
          textStyle: { fontSize: 13, color: "currentColor" },
          // Pinned to the real slices: ECharts otherwise derives legend items
          // from every series, which would add a blank row for the invisible
          // centre-label series below.
          data: data.map((d) => d.name),
        },
    series: [
      {
        type: "pie" as const,
        radius: opts.radius ?? ["42%", "78%"],
        center: [percentPosition(centerX), percentPosition(centerY)],
        itemStyle: { borderColor: "#fff", borderWidth: 3, borderRadius: 4 },
        label: {
          show: true,
          position: "outside" as const,
          formatter: "{d}%",
          fontSize: 11,
          color: "currentColor",
        },
        labelLine: { length: 6, length2: 4 },
        data,
      },
      // Centre total. Drawn as a zero-radius pie rather than a `graphic` text
      // because only the series layout puts a label exactly on `center` for both
      // axes: `graphic`/`title` treat `left`/`top` percentages as edge anchors
      // and ignore textAlign/verticalAlign, which is what pulled the number off
      // the hole and stacked it onto the topmost slice label. Keep in sync with
      // the `legend.data` pin above — a data item here would otherwise leak a
      // blank legend row.
      ...(total > 0
        ? [
            {
              type: "pie" as const,
              radius: ["0%", "0%"],
              center: [percentPosition(centerX), percentPosition(centerY)],
              silent: true,
              z: 10,
              label: {
                show: true,
                position: "center" as const,
                formatter: `{total|${total}}\n{caption|总计}`,
                rich: {
                  total: {
                    fontSize: 24,
                    fontWeight: 700,
                    lineHeight: 26,
                    color: "currentColor",
                    fontFamily: "ui-sans-serif, system-ui, sans-serif",
                  },
                  caption: {
                    fontSize: 11,
                    lineHeight: 14,
                    color: "currentColor",
                    fontFamily: "ui-sans-serif, system-ui, sans-serif",
                  },
                },
              },
              labelLine: { show: false },
              data: [{ name: "", value: 1 }],
            },
          ]
        : []),
    ],
  };
}

export interface PieSlice {
  name: string;
  value: number;
}

export function pieOption(slices: PieSlice[]) {
  const data = slices.filter((s) => s.value > 0);
  if (!data.length) return null;
  return {
    tooltip: { trigger: "item", formatter: "{b}: {c} ({d}%)" },
    color: PIE_PALETTE,
    series: [
      {
        type: "pie" as const,
        radius: ["42%", "68%"],
        center: ["50%", "50%"],
        avoidLabelOverlap: true,
        itemStyle: { borderColor: "#fff", borderWidth: 2, borderRadius: 3 },
        label: { show: true, fontSize: 11, formatter: "{d}%" },
        labelLine: { length: 8, length2: 6 },
        data,
      },
    ],
  };
}

export interface HistogramBucket {
  label: string;
  count: number;
}

export function histogramOption(buckets: HistogramBucket[], primary = "#4f46e5", muted = "#64748b") {
  if (buckets.length < 2) return null;
  return {
    tooltip: { trigger: "axis" as const },
    grid: { left: 36, right: 16, top: 20, bottom: 30 },
    xAxis: {
      type: "category" as const,
      data: buckets.map((b) => b.label),
      axisLabel: { fontSize: 10, rotate: buckets.length > 7 ? 30 : 0, color: muted },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    yAxis: {
      type: "value" as const,
      splitLine: { lineStyle: { color: "#eef1f6", type: "dashed" as const } },
      axisLabel: { fontSize: 10, color: muted },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    series: [
      {
        type: "bar" as const,
        data: buckets.map((b) => ({
          value: b.count,
          itemStyle: {
            color: {
              type: "linear" as const,
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: primary },
                { offset: 1, color: withAlpha(primary, 0.35) },
              ],
            },
            borderRadius: [4, 4, 0, 0],
          },
        })),
        barWidth: buckets.length > 14 ? "60%" : "68%",
        label: { show: true, position: "top" as const, fontSize: 10, color: muted },
      },
    ],
  };
}

export interface HorizontalBarItem {
  label: string;
  value: number | null;
  rightFormatter?: (v: number) => string;
}

export function horizontalBarOption(items: HorizontalBarItem[], primary = "#4f46e5") {
  const valid = items.filter((i) => i.value !== null) as Array<HorizontalBarItem & { value: number }>;
  if (!valid.length) return null;
  return {
    tooltip: { trigger: "axis" as const },
    grid: { left: 120, right: 40, top: 10, bottom: 10 },
    xAxis: {
      type: "value" as const,
      splitLine: { lineStyle: { color: "#eef1f6", type: "dashed" as const } },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    yAxis: {
      type: "category" as const,
      inverse: true,
      data: valid.map((s) => s.label),
      axisLine: { show: false },
      axisTick: { show: false },
    },
    series: [
      {
        type: "bar" as const,
        data: valid.map((s) => ({
          value: s.value,
          itemStyle: {
            color: {
              type: "linear" as const,
              x: 0,
              y: 0,
              x2: 1,
              y2: 0,
              colorStops: [
                { offset: 0, color: primary },
                { offset: 1, color: withAlpha(primary, 0.5) },
              ],
            },
            borderRadius: [0, 4, 4, 0],
          },
        })),
        barWidth: "55%",
        label: {
          show: true,
          position: "right" as const,
          fontSize: 11,
          formatter: (p: { value: number | null }) => {
            if (p.value === null) return "";
            const item = valid.find((v) => v.value === p.value);
            return item?.rightFormatter ? item.rightFormatter(p.value) : String(p.value);
          },
        },
      },
    ],
  };
}

function withAlpha(hex: string, alpha: number): string {
  const m = /^#?([a-f\d]{6})$/i.exec(hex);
  if (!m) return hex;
  const r = Number.parseInt(m[1]!.slice(0, 2), 16);
  const g = Number.parseInt(m[1]!.slice(2, 4), 16);
  const b = Number.parseInt(m[1]!.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
