export function renderRadarSvg(scores: Array<{ label: string; value: number }>, accent: string, escape: (value: string) => string): string {
  const points = scores.slice(0, 6);
  if (points.length < 3) return "";
  const center = 150; const radius = 108;
  const coords = points.map((score, index) => { const angle = -Math.PI / 2 + index * Math.PI * 2 / points.length; const ratio = Math.max(0, Math.min(1, score.value / 100)); return { x: center + Math.cos(angle) * radius * ratio, y: center + Math.sin(angle) * radius * ratio, gx: center + Math.cos(angle) * radius, gy: center + Math.sin(angle) * radius, label: score.label }; });
  const polygon = coords.map((point) => `${point.x},${point.y}`).join(" ");
  const grid = [0.33, 0.66, 1].map((ratio) => `<polygon points="${points.map((_, index) => { const angle = -Math.PI / 2 + index * Math.PI * 2 / points.length; return `${center + Math.cos(angle) * radius * ratio},${center + Math.sin(angle) * radius * ratio}`; }).join(" " )}" fill="none" stroke="${accent}" opacity=".25"/>`).join("");
  return `<svg class="radar" viewBox="0 0 300 300" role="img" aria-label="评分雷达图">${grid}<polygon points="${polygon}" fill="${accent}" opacity=".35" stroke="${accent}" stroke-width="3"/>${coords.map((point) => `<line x1="${center}" y1="${center}" x2="${point.gx}" y2="${point.gy}" stroke="${accent}" opacity=".3"/><text x="${point.gx}" y="${point.gy}" fill="currentColor" font-size="11" text-anchor="middle">${escape(point.label.slice(0, 8))}</text>`).join("")}</svg>`;
}

export function renderRadarBlock(scores: Array<{ label: string; value: number }>, accent: string, escape: (value: string) => string): string {
  const radar = renderRadarSvg(scores, accent, escape);
  return radar ? `<section class="chart-section block block-radar"><div class="section-heading"><span>PROFILE MAP</span><h2>维度画像</h2></div>${radar}</section>` : "";
}
