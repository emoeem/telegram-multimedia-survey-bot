import { Suspense, lazy, type ComponentType, type CSSProperties } from "react";

/**
 * ECharts is the single heaviest client dependency (~600 kB minified) and only
 * six screens ever render a chart. Importing `echarts-for-react` at the top of
 * every route pulled it into the initial admin bundle, so the login page and
 * the survey list paid for it before showing anything.
 *
 * This wrapper defers the library to a dynamic import that runs the first time
 * a chart actually mounts. Combined with route-level lazy loading, the initial
 * bundle no longer contains ECharts at all; charts arrive as their own async
 * chunk.
 */
const ReactECharts = lazy(async () => {
  const mod = await import("echarts-for-react");
  return { default: mod.default as unknown as ComponentType<Record<string, unknown>> };
});

export interface EChartProps {
  option: unknown;
  style?: CSSProperties;
  className?: string;
  theme?: string | Record<string, unknown>;
  notMerge?: boolean;
  lazyUpdate?: boolean;
  showLoading?: boolean;
  loadingOption?: unknown;
  opts?: { renderer?: "canvas" | "svg"; width?: number | "auto"; height?: number | "auto" };
  onEvents?: Record<string, (params: unknown, chart: unknown) => void>;
}

/** Skeleton with the same height as the chart so the layout does not jump. */
function ChartFallback({ style }: { style?: CSSProperties }) {
  return (
    <div
      aria-hidden="true"
      className="animate-pulse rounded-lg bg-[var(--color-surface-2,rgba(127,127,127,0.12))]"
      style={{ height: 180, ...style }}
    />
  );
}

export function EChart(props: EChartProps) {
  return (
    <Suspense fallback={<ChartFallback style={props.style} />}>
      <ReactECharts {...(props as unknown as Record<string, unknown>)} />
    </Suspense>
  );
}

export default EChart;
