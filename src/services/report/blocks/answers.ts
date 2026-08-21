import type { PreparedReportContent, ReportAnswerItem } from "../model";

export interface AnswerBlockContext { escape(value: string): string; }

function answer(item: ReportAnswerItem, index: number, className: string, context: AnswerBlockContext): string {
  return `<article class="${className}"><div class="response-index">QUESTION ${String(index + 1).padStart(2, "0")}</div><div class="question">${context.escape(item.label)}</div><div class="answer">${context.escape(item.value)}</div></article>`;
}

export function renderSelectedResponses(content: PreparedReportContent, context: AnswerBlockContext): string {
  if (!content.featuredAnswer && !content.editorialAnswers.length && !content.compactAnswers.length) return "";
  let index = 0;
  const featured = content.featuredAnswer ? answer(content.featuredAnswer, index++, "featured-question", context) : "";
  const editorial = content.editorialAnswers.map((item) => answer(item, index++, "editorial-answer", context)).join("");
  const compact = content.compactAnswers.map((item) => answer(item, index++, "compact-answer", context)).join("");
  return `<section class="responses-composition block block-responses"><header class="chapter-heading"><span>SELECTED RESPONSES</span><h2>回答选编</h2></header>${featured}${editorial ? `<div class="editorial-answer-grid">${editorial}</div>` : ""}${compact ? `<div class="compact-answer-grid">${compact}</div>` : ""}</section>`;
}
