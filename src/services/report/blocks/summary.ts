import type { PreparedReportContent, ReportScore } from "../model";

export interface SummaryBlockContext { escape(value: string): string; limit(value: string, length: number): string; }

export function renderFinalVerdictBlock(verdict: PreparedReportContent["verdict"], primaryScore: ReportScore | undefined, context: SummaryBlockContext): string {
  const score = primaryScore ? `<div class="verdict-score"><strong>${context.escape(String(primaryScore.value))}</strong><span>${context.escape(primaryScore.label)}</span></div>` : "";
  const pillars = verdict.pillars.map((item) => `<div class="verdict-pillar"><span>${context.escape(item.label)}</span><b>${context.escape(item.value)}</b></div>`).join("");
  return `<section class="final-verdict block block-verdict"><div class="verdict-eyebrow">PERSONALITY VERDICT</div><h2>${context.escape(verdict.title)}</h2><div class="verdict-main">${score}<p>${context.escape(verdict.summary)}</p></div><div class="verdict-pillars">${pillars}</div><div class="closing-statement">${context.escape(verdict.closing)}</div></section>`;
}
