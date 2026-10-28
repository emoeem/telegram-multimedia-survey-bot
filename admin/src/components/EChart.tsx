import { Suspense, lazy, useEffect, useState, type ComponentType, type CSSProperties } from "react";
import type { EChartsReactProps } from "echarts-for-react/esm/types";

/**
 * ECharts is the single heaviest client dependency and only six screens ever
 * render a chart. Two layers of laziness apply here:
 *
 * 1. Route-level: this wrapper defers the library to a dynamic import that
 *    runs the first time a chart actually mounts, so the login page and the
 *    survey list never pay for it at all.
 * 2. On-demand registration (E2): the import goes through `echarts/core` and
 *    registers only what this app uses — Pie + Bar series, the axes/grid,
 *    tooltip and legend — instead of `echarts-for-react`'s default full-bundle
 *    import. The whole chart family (line/scatter/map/…) is tree-shaken away,
 *    which is what keeps the async chunk around a third of the full size.
 *
 * New chart types must be added to the `use([...])` list below, otherwise the
 * chart silently renders nothing. `AxisPointerComponent` backs the axis tooltip
 * trigger used by the bar charts.
 */
const ReactECharts = lazy(async () => {
  // Deep install-module imports, NOT the `echarts/charts` / `echarts/components`
  // barrels: echarts declares every `lib/chart/*.js` / `lib/component/*.js`
  // wrapper as side-effectful, so importing a barrel forces the bundler to keep
  // the whole family (maps, geo parsers and all). Each `install.js` is a pure
  // extension installer that `use` registers — nothing else comes along.
  const [
    { default: EChartsReactCore },
    echartsCore,
    barInstall,
    pieInstall,
    gridInstall,
    tooltipInstall,
    axisPointerInstall,
    legendInstall,
    canvasRendererInstall,
    svgRendererInstall,
  ] = await Promise.all([
    // The `esm/core` entry, not `lib/core`: the lib build is CJS with
    // `__esModule` set, and under rolldown's interop the dynamically imported
    // namespace's `default` can come back as the whole exports object instead
    // of the component class — which then crashes as React error #130
    // ("element type invalid: got object") the moment a chart mounts.
    import("echarts-for-react/esm/core"),
    import("echarts/core"),
    import("echarts/lib/chart/bar/install"),
    import("echarts/lib/chart/pie/install"),
    import("echarts/lib/component/grid/install"),
    import("echarts/lib/component/tooltip/install"),
    import("echarts/lib/component/axisPointer/install"),
    import("echarts/lib/component/legend/install"),
    import("echarts/lib/renderer/installCanvasRenderer"),
    import("echarts/lib/renderer/installSVGRenderer"),
  ]);
  echartsCore.use([
    barInstall.install,
    pieInstall.install,
    gridInstall.install,
    tooltipInstall.install,
    axisPointerInstall.install,
    legendInstall.install,
    canvasRendererInstall.install,
    svgRendererInstall.install,
  ]);
  // The `/esm/core` entry takes the echarts namespace as a prop (the default
  // entry binds the full bundle itself). Handing it `echarts/core` — with our
  // registrations applied — is what makes the on-demand build actually draw.
  const BoundCore = (props: EChartsReactProps) => <EChartsReactCore {...props} echarts={echartsCore} />;
  return { default: BoundCore as unknown as ComponentType<Record<string, unknown>> };
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
