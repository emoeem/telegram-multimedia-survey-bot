import { renderRadarChartSvg, type ChartColors } from "../charts";

/**
 * Radar chart rendered server-side as SVG via Apache ECharts SSR, so the
 * Web report, PDF and PNG output share one deterministic chart implementation.
 */
export function renderRadarSvg(scores: Array<{ label: string; value: number }>, colors: ChartColors): string {
  return renderRadarChartSvg(scores, colors);
}

export function renderRadarBlock(scores: Array<{ label: string; value: number }>, colors: ChartColors): string {
  const radar = renderRadarSvg(scores, colors);
  return radar
    ? `<section class="chart-section block block-radar"><div class="section-heading"><span>PROFILE MAP</span><h2>维度画像</h2></div>${radar}</section>`
    : "";
}
