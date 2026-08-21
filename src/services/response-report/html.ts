import type { ReportFragment, ResponseReport, ResponseReportDensity, ResponseReportMedia, ResponseReportOption, ResponseReportPage } from "./model";
import { responseReportDensity } from "./pagination";

export function escapeResponseReportHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function control(selected: boolean, multiple: boolean): string {
  return `<span class="control ${multiple ? "checkbox" : "radio"}${selected ? " selected" : ""}" aria-label="${selected ? "已选择" : "未选择"}">${selected ? '<span class="control-dot"></span>' : ""}</span>`;
}

function mediaGrid(media: ResponseReportMedia[], heading: string): string {
  if (!media.length) return "";
  const columns = media.length === 1 ? 1 : media.length === 2 ? 2 : 3;
  return `<section class="media-section"><div class="section-label">${heading}</div><div class="media-grid columns-${columns}">${media.map((entry) => `<figure data-media-id="${entry.id ?? ""}" data-media-role="${entry.role}">${entry.imageDataUrl ? `<img src="${escapeResponseReportHtml(entry.imageDataUrl)}" alt="${escapeResponseReportHtml(entry.label)}">` : `<div class="file-placeholder">ATTACHMENT</div>`}<figcaption>${escapeResponseReportHtml(entry.label)}</figcaption></figure>`).join("")}</div></section>`;
}

function optionColumns(options: ResponseReportOption[]): number {
  const longest = Math.max(0, ...options.map((option) => Array.from(option.label).length));
  if (options.some((option) => option.media.length)) return options.length <= 2 ? 2 : 3;
  if (longest <= 16 && options.length >= 5) return 3;
  if (longest <= 36 && options.length >= 4) return 2;
  return 1;
}

function renderOptions(fragment: ReportFragment): string {
  const item = fragment.item;
  const options = item.options.slice(fragment.optionStart ?? 0, fragment.optionEnd ?? item.options.length).map((option) => ({ ...option, media: fragment.optionMediaById?.[String(option.id)] ?? option.media }));
  const columns = optionColumns(options);
  return `<section class="option-section"><div class="section-label">OPTIONS</div><div class="options columns-${columns}">${options.map((option, index) => `<div class="option" data-option-id="${option.id}" data-option-order="${(fragment.optionStart ?? 0) + index}" data-selected="${option.selected}">${control(option.selected, item.type === "multiple")}<div class="option-content"><div class="option-label">${escapeResponseReportHtml(option.label)}</div>${mediaGrid(option.media, "OPTION MEDIA")}</div></div>`).join("")}</div></section>`;
}

function renderRating(fragment: ReportFragment): string {
  const item = fragment.item;
  const options = item.options.slice(fragment.optionStart ?? 0, fragment.optionEnd ?? item.options.length);
  return `<section class="rating-section"><div class="section-label">RATING SCALE</div><div class="rating-scale">${options.map((option, index) => `<div class="rating-point" data-option-id="${option.id}" data-option-order="${(fragment.optionStart ?? 0) + index}" data-selected="${option.selected}"><span>${escapeResponseReportHtml(option.label)}</span>${control(option.selected, false)}</div>`).join("")}</div>${fragment.continuesAfter ? "" : `<div class="answer-summary" data-answer-question-id="${item.questionId}" ${item.answerId === null ? "" : `data-answer-id="${item.answerId}"`} data-answered="${item.answered}"><span>YOUR SELECTION</span><strong>${escapeResponseReportHtml(item.answered ? item.answer : "未作答")}</strong></div>`}</section>`;
}

function renderMatrix(fragment: ReportFragment): string {
  const item = fragment.item;
  const allColumns = item.matrixColumns ?? [];
  const columnStart = fragment.matrixColumnStart ?? 0;
  const columns = allColumns.slice(columnStart, fragment.matrixColumnEnd ?? allColumns.length);
  const rows = item.options.slice(fragment.optionStart ?? 0, fragment.optionEnd ?? item.options.length);
  return `<section class="matrix-section"><div class="section-label">MATRIX${allColumns.length > columns.length ? ` · COLUMNS ${columnStart + 1}–${columnStart + columns.length}` : ""}</div><div class="matrix" style="--matrix-columns:${columns.length}"><div class="matrix-row matrix-head"><span></span>${columns.map((column, index) => `<span data-column-order="${columnStart + index}">${escapeResponseReportHtml(column)}</span>`).join("")}</div>${rows.map((row, rowIndex) => `<div class="matrix-row" data-option-id="${row.id}" data-option-order="${(fragment.optionStart ?? 0) + rowIndex}"><strong>${escapeResponseReportHtml(row.label)}</strong>${columns.map((_, columnIndex) => `<span data-selected="${item.matrixSelections?.[String(row.id)] === columnStart + columnIndex}">${control(item.matrixSelections?.[String(row.id)] === columnStart + columnIndex, false)}</span>`).join("")}</div>`).join("")}</div>${fragment.continuesAfter ? "" : `<div class="answer-summary" data-answer-question-id="${item.questionId}" ${item.answerId === null ? "" : `data-answer-id="${item.answerId}"`} data-answered="${item.answered}"><span>RESPONSE STATUS</span><strong>${item.answered ? "已填写" : "未作答"}</strong></div>`}</section>`;
}

function renderAnswer(fragment: ReportFragment): string {
  const value = fragment.answer ?? fragment.item.answer;
  const answerIdentity = fragment.answerStart === false ? "" : ` data-answer-question-id="${fragment.item.questionId}"${fragment.item.answerId === null ? "" : ` data-answer-id="${fragment.item.answerId}"`}`;
  return `<section class="answer-section"${answerIdentity} data-answered="${fragment.item.answered}"><div class="section-label">YOUR ANSWER</div><div class="answer-text">${escapeResponseReportHtml(value)}</div></section>`;
}

function renderQuestionBody(fragment: ReportFragment): string {
  const item = fragment.item;
  const visibleOptionCount = (fragment.optionEnd ?? item.options.length) - (fragment.optionStart ?? 0);
  if (item.options.length && visibleOptionCount === 0) return fragment.continuesAfter ? "" : renderAnswer(fragment);
  if (item.type === "matrix") return renderMatrix(fragment);
  if (item.type === "rating") return renderRating(fragment);
  if (item.options.length) return `${renderOptions(fragment)}${fragment.continuesAfter ? "" : renderAnswer(fragment)}`;
  return renderAnswer(fragment);
}

function renderFragment(fragment: ReportFragment): string {
  const item = fragment.item;
  return `<article class="question-block${fragment.continuation ? " continued" : ""}" data-question-id="${item.questionId}" data-question-order="${item.number - 1}">
    <div class="question-heading"><div class="question-number">${String(item.number).padStart(2, "0")}</div><div><div class="question-kicker">${fragment.continuation ? "← CONTINUED · QUESTION" : "QUESTION"} <span class="requirement">${item.required ? "REQUIRED" : "OPTIONAL"}</span></div>${fragment.title !== "" ? `<h2>${escapeResponseReportHtml(fragment.title ?? item.title)}</h2>` : ""}${fragment.description ? `<p class="description">${escapeResponseReportHtml(fragment.description)}</p>` : ""}</div></div>
    ${mediaGrid(fragment.questionMedia ?? [], "QUESTION MEDIA")}
    ${renderQuestionBody(fragment)}
    ${mediaGrid(fragment.answerMedia ?? [], "YOUR UPLOAD")}
    ${fragment.continuesAfter ? '<div class="continue-after">CONTINUED →</div>' : ""}
  </article>`;
}

function pageHeader(report: ResponseReport, page: ResponseReportPage): string {
  return `<header class="page-header"><span>SURVEY RESPONSE</span><span>${escapeResponseReportHtml(report.surveyTitle)} · PAGE ${String(page.number).padStart(2, "0")} / ${String(page.total).padStart(2, "0")}</span></header>`;
}

function documentMeta(report: ResponseReport): string {
  return `<section class="document-meta"><div><div class="eyebrow">COMPLETE RESPONSE ARCHIVE</div><h1>${escapeResponseReportHtml(report.surveyTitle)}</h1></div><div class="meta-grid"><span>RESPONSE <strong>#${report.responseNumber}</strong></span><span>RESPONDENT <strong>${escapeResponseReportHtml(report.respondent)}</strong></span><span>STATUS <strong>${escapeResponseReportHtml(report.status)}</strong></span><span>COMPLETED <strong>${escapeResponseReportHtml(report.completedAt)}</strong></span><span>QUESTIONS <strong>${report.items.length}</strong></span></div></section>`;
}

export function buildResponseReportHtmlDocument(report: ResponseReport, pages: ResponseReportPage[]): string {
  const density: ResponseReportDensity = responseReportDensity(report);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeResponseReportHtml(report.surveyTitle)}</title><style>
@page{size:A4 portrait;margin:0}*{box-sizing:border-box}html,body{margin:0;background:#dfe4e8;color:#17212b;font-family:"Noto Sans CJK SC","Microsoft YaHei","PingFang SC",sans-serif}.page{--space:${density === "compact" ? "14px" : density === "comfortable" ? "22px" : "18px"};width:900px;height:1200px;padding:28px 48px 30px;background:#fbfbfa;display:flex;flex-direction:column;break-after:page;overflow:hidden}.page-header{height:36px;padding-bottom:12px;border-bottom:1px solid #9ca8ae;display:flex;justify-content:space-between;color:#52616a;font-size:12px;font-weight:700;letter-spacing:1.25px}.page-content{height:1058px;padding-top:12px;overflow:hidden}.document-meta{display:grid;grid-template-columns:1fr;gap:16px;padding:16px 0 20px;border-bottom:2px solid #244d53}.eyebrow,.section-label,.question-kicker{color:#456b70;font-size:11px;font-weight:800;letter-spacing:1.45px}.document-meta h1{font-size:30px;line-height:1.25;margin:5px 0 0}.meta-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 22px;align-content:center;color:#6a747a;font-size:11px;letter-spacing:.7px}.meta-grid strong{display:block;margin-top:3px;color:#202b32;font-size:14px;letter-spacing:0;overflow-wrap:anywhere}.question-block{padding:var(--space) 0;border-bottom:1px solid #cfd6d9;break-inside:avoid}.question-heading{display:grid;grid-template-columns:48px 1fr;gap:14px}.question-number{color:#244d53;font-family:Georgia,serif;font-size:27px;line-height:1}.requirement{margin-left:8px;color:#7b858a;font-weight:600;letter-spacing:.8px}.question-block h2{max-width:700px;margin:5px 0 0;font-size:${density === "compact" ? "18px" : "20px"};line-height:1.5;font-weight:650;white-space:pre-wrap;overflow-wrap:anywhere}.description{max-width:690px;margin:7px 0 0;color:#59676e;font-size:15px;line-height:1.6;white-space:pre-wrap}.option-section,.rating-section,.matrix-section,.answer-section,.media-section{margin:12px 0 0 62px}.options{display:grid;gap:7px 12px;margin-top:7px}.columns-1{grid-template-columns:1fr}.columns-2,.options.columns-3{grid-template-columns:repeat(2,minmax(0,1fr))}.media-grid.columns-3{grid-template-columns:repeat(2,minmax(0,1fr))}.option{min-width:0;display:grid;grid-template-columns:22px 1fr;gap:9px;align-items:start;padding:9px 11px;background:#f0f3f2;border-top:1px solid #d9dfdf}.option[data-selected="true"]{background:#e4eeec;border-color:#76999a}.option-label{font-size:15px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere}.control{width:17px;height:17px;margin-top:2px;display:inline-grid;place-items:center;border:1.5px solid #738188;background:#fff}.radio{border-radius:50%}.checkbox{border-radius:2px}.control.selected{border-color:#245e62}.radio .control-dot{width:8px;height:8px;border-radius:50%;background:#245e62}.checkbox .control-dot{width:8px;height:5px;border-left:2px solid #245e62;border-bottom:2px solid #245e62;transform:rotate(-45deg) translateY(-1px)}.answer-section{max-width:690px}.answer-text{margin-top:6px;padding:10px 13px;background:#f4f1e9;border-left:3px solid #a67b32;font-size:16px;line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere}.answer-section[data-answered="false"] .answer-text{color:#7a6660;font-style:italic}.answer-summary{display:flex;gap:12px;margin-top:10px;color:#647177;font-size:12px}.answer-summary strong{color:#244d53;font-size:15px}.rating-scale{display:flex;max-width:690px;margin-top:9px;border-top:1px solid #9ba7ab}.rating-point{flex:1;display:grid;justify-items:center;gap:7px;padding-top:8px;font-size:13px}.matrix{margin-top:8px;overflow:hidden;border-top:1px solid #98a5aa;border-left:1px solid #d6dcde}.matrix-row{display:grid;grid-template-columns:minmax(150px,2fr) repeat(var(--matrix-columns),minmax(58px,1fr));align-items:stretch}.matrix-row>*{min-width:0;padding:7px 5px;border-right:1px solid #d6dcde;border-bottom:1px solid #d6dcde;text-align:center;font-size:12px;overflow-wrap:anywhere}.matrix-row strong{text-align:left;background:#f0f3f2;font-size:13px}.matrix-head{color:#526168;background:#e9eeee;font-weight:650}.media-grid{display:grid;gap:10px;margin-top:7px}.media-grid figure{min-width:0;margin:0}.media-grid img,.file-placeholder{display:block;width:100%;height:210px;object-fit:contain;background:#eef1f1;border:1px solid #c9d1d3}.columns-1 img,.columns-1 .file-placeholder{height:300px}.file-placeholder{display:grid;place-items:center;color:#6c797f;font-size:12px;letter-spacing:1px}.media-grid figcaption{margin-top:4px;color:#68757b;font-size:11px;overflow-wrap:anywhere}.option .media-section{margin-left:0}.option .media-grid img,.option .file-placeholder{height:160px}.continue-after{margin:11px 0 0 62px;color:#456b70;font-size:11px;font-weight:800;letter-spacing:1.2px;text-align:right}.page-footer{height:36px;margin-top:auto;padding-top:12px;border-top:1px solid #9ca8ae;display:flex;justify-content:space-between;color:#657278;font-size:11px;letter-spacing:.8px}@media print{html,body{background:#fff}}
</style></head><body>${pages.map((page) => `<section class="page" data-page="${page.number}" data-estimated-height="${page.estimatedHeight}">${pageHeader(report, page)}<main class="page-content">${page.number === 1 ? documentMeta(report) : ""}${page.fragments.map(renderFragment).join("")}</main><footer class="page-footer"><span>${escapeResponseReportHtml(report.surveyTitle)} · RESPONSE #${report.responseNumber}</span><span>${String(page.number).padStart(2, "0")} / ${String(page.total).padStart(2, "0")}</span></footer></section>`).join("")}</body></html>`;
}
