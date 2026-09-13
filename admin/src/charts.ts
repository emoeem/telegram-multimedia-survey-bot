import { useMemo } from "react";

export const PIE_PALETTE = ["#4f46e5", "#ec4899", "#14b8a6", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4", "#84cc16"];

export function useChartColors() {
  return useMemo(() => {
    const style = getComputedStyle(document.documentElement);
    const read = (name: string) => style.getPropertyValue(name).trim() || "";
    return {
      primary: read("--color-primary") || "#4f46e5",
      text: read("--color-ink") || "#0f172a",
      muted: read("--color-muted") || "#64748b",
      border: read("--color-edge") || "#e5e9f0",
      success: "#16a34a",
      info: "#0284c7",
      warning: "#d97706",
      danger: "#dc2626",
    };
  }, []);
}

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

export function donutOption(slices: DonutSlice[], opts: DonutOptions = {}) {
  const data = slices.filter((s) => s.value > 0).map((s) => ({
    name: s.name,
    value: s.value,
    itemStyle: s.color ? { color: s.color } : undefined,
  }));
  if (!data.length) return null;
  const total = data.reduce((sum, d) => sum + d.value, 0);
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
        },
    graphic: total > 0
      ? [
          {
            type: "text",
            left: opts.center ? `${opts.center[0]}` : "38%",
            top: opts.center ? `calc(${opts.center[1]} - 10px)` : "calc(50% - 10px)",
            style: {
              text: String(total),
              textAlign: "center",
              fontSize: 24,
              fontWeight: 700,
              fill: "currentColor",
              fontFamily: "ui-sans-serif, system-ui, sans-serif",
            },
          },
          {
            type: "text",
            left: opts.center ? `${opts.center[0]}` : "38%",
            top: opts.center ? `calc(${opts.center[1]} + 14px)` : "calc(50% + 14px)",
            style: {
              text: "总计",
              textAlign: "center",
              fontSize: 11,
              fill: "currentColor",
              opacity: 0.6,
              fontFamily: "ui-sans-serif, system-ui, sans-serif",
            },
          },
        ]
      : undefined,
    series: [
      {
        type: "pie" as const,
        radius: opts.radius ?? ["42%", "78%"],
        center: opts.center ?? ["38%", "50%"],
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
