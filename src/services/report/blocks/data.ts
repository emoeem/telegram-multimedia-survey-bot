import type { ReportScore } from "../model";

export interface DataBlockContext { accent: string; escape(value: string): string; }

export function renderProgressBlock(score: ReportScore, context: DataBlockContext): string {
  return `<article class="metric"><div class="metric-top"><div><span class="metric-label">${context.escape(score.label)}</span><strong>${context.escape(String(score.value))}</strong></div><div class="ring" style="background:conic-gradient(${context.accent} ${score.percentage}%, ${context.accent}22 0)"><div><strong>${context.escape(String(score.value))}</strong><small>${context.escape(score.level)}</small></div></div></div><div class="metric-level">${context.escape(score.level)} · ${context.escape(score.description ?? "")}</div><div class="meter"><i style="width:${score.percentage}%"></i></div></article>`;
}

export function renderMetricGridBlock(scores: ReportScore[], context: DataBlockContext): string {
  return scores.slice(0, 4).map((score) => renderProgressBlock(score, context)).join("");
}

export function renderProgressBars(scores: ReportScore[], context: DataBlockContext): string {
  return scores.map((score) => `<div class="bar-row"><span>${context.escape(score.label)}</span><div class="bar-track"><i style="width:${score.percentage}%"></i></div><b>${context.escape(String(score.value))}</b></div>`).join("");
}

export function renderPrimaryScoreBlock(score: ReportScore | undefined, context: DataBlockContext): string {
  if (!score) return "";
  return `<article class="bento-tile bento-primary"><span>PRIMARY SCORE</span><strong>${context.escape(String(score.value))}</strong><h3>${context.escape(score.label)}</h3><div class="meter"><i style="width:${score.percentage}%"></i></div></article>`;
}
