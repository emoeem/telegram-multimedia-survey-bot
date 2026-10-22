import { Suspense, lazy, useEffect, useState, type ComponentType, type CSSProperties } from "react";

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

/**
 * ECharts animates pie/donut slices in from zero over ~1s. For anyone who asked
 * the OS for reduced motion that is unwanted movement, and for anything that
 * samples the DOM mid-animation (a screenshot, a visual regression run) it reads
 * as "the chart is broken" — a half-drawn ring. Both are fixed by the same
 * switch, so the option is forced off rather than left to each caller.
 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true,
  );
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return undefined;
    const onChange = () => setReduced(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

export function EChart(props: EChartProps) {
  const reducedMotion = usePrefersReducedMotion();
  const base = props.option;
  const option =
    reducedMotion && base && typeof base === "object" && !Array.isArray(base)
      ? { ...(base as Record<string, unknown>), animation: false }
      : base;
  return (
    <Suspense fallback={<ChartFallback style={props.style} />}>
      <ReactECharts {...(props as unknown as Record<string, unknown>)} option={option} />
    </Suspense>
  );
}

export default EChart;
