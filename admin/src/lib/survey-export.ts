/**
 * 问卷结构导出（HTML / Markdown / JSON）。
 *
 * PDF 不在这里生成：Worker 里没有浏览器，`pdf-lib` 这类纯 JS 方案又要先把
 * 中文字体嵌进去（一份思源黑体就是几 MB，塞进 Worker 不现实）。所以导出的
 * HTML 本身就是打印视图——`@page` + `page-break-after` 已经排好，浏览器
 * 的"打印 → 另存为 PDF"就是最终 PDF，中文和排版都由浏览器负责，零依赖。
 *
 * 这个模块是纯函数：不读 DOM、不碰网络，输出字符串，好让单测直接断言内容。
 */

export const QUESTION_TYPE_LABELS: Record<string, string> = {
  single: "单选",
  multiple: "多选",
  text: "单行文本",
  long_text: "多行文本",
  number: "数字",
  yes_no: "是否",
  rating: "评分",
  matrix: "矩阵",
  date: "日期",
  time: "时间",
  image: "图片",
  video: "视频",
  audio: "音频",
  file: "文件",
  note: "说明",
};

export interface ExportSurveyOption {
  id: number;
  label: string;
  order: number;
}

export interface ExportSurveyQuestion {
  id: number;
  type: string;
  title: string;
  description?: string | null;
  required?: boolean;
  order: number;
  /**
   * 所属分页 id（`null` = 未分页）。允许字符串：导入器产出的 survey.json 里
   * `page_id` 是 `"p1"` 这类字符串，而编辑器接口给的是数字。导出层两者都收，
   * 统一按 `String()` 比较，避免「字段名或类型对不上就整卷题目被丢掉」。
   */
  pageId?: number | string | null;
  columns?: string[] | null;
  validation?: Record<string, number | boolean> | null;
  options?: ExportSurveyOption[];
}

export interface ExportSurveyPage {
  id: number | string;
  title: string | null;
  description: string | null;
  order: number;
}

export interface ExportSurvey {
  id: number;
  title: string;
  description?: string | null;
  status?: string;
  questions: ExportSurveyQuestion[];
  pages?: ExportSurveyPage[];
}

export type ExportFormat = "html" | "markdown" | "json";

const STATUS_LABELS: Record<string, string> = {
  draft: "草稿",
  published: "已发布",
  paused: "已暂停",
  archived: "已归档",
};

/** HTML 文本转义。标题和选项是用户内容，直接拼进模板等于给自己开一个 XSS。 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function formatQuestionType(type: string): string {
  return QUESTION_TYPE_LABELS[type] ?? type;
}

/** 验证约束渲染成一条人话，比如 `最多 200 字 · 2–5 项`。 */
export function describeValidation(validation: Record<string, number | boolean> | null | undefined): string[] {
  if (!validation) return [];
  const parts: string[] = [];
  const min = typeof validation.min_length === "number" ? validation.min_length : undefined;
  const maxLength = typeof validation.max_length === "number" ? validation.max_length : undefined;
  const minSelections = typeof validation.min_selections === "number" ? validation.min_selections : undefined;
  const maxSelections = typeof validation.max_selections === "number" ? validation.max_selections : undefined;
  const minValue = typeof validation.min === "number" ? validation.min : undefined;
  const maxValue = typeof validation.max === "number" ? validation.max : undefined;

  if (min !== undefined || maxLength !== undefined) {
    parts.push(`${min ?? 0}–${maxLength ?? "不限"} 字`);
  }
  if (minSelections !== undefined || maxSelections !== undefined) {
    parts.push(`选 ${minSelections ?? 1}–${maxSelections ?? "不限"} 项`);
  }
  if (minValue !== undefined || maxValue !== undefined) {
    parts.push(`取值 ${minValue ?? "-∞"}–${maxValue ?? "+∞"}`);
  }
  const scaleMin = typeof validation.scale_min === "number" ? validation.scale_min : undefined;
  const scaleMax = typeof validation.scale_max === "number" ? validation.scale_max : undefined;
  if (scaleMin !== undefined || scaleMax !== undefined) {
    parts.push(`评分 ${scaleMin ?? 1}–${scaleMax ?? 5}`);
  }
  return parts;
}

function sortedQuestions(survey: ExportSurvey): ExportSurveyQuestion[] {
  return [...survey.questions].sort((a, b) => a.order - b.order);
}

function renderQuestionHtml(question: ExportSurveyQuestion, index: number): string {
  const label = formatQuestionType(question.type);
  const required = question.required ? '<span class="req">*必答</span>' : "";
  const description = question.description?.trim()
    ? `<p class="q-desc">${escapeHtml(question.description.trim())}</p>`
    : "";
  const columns =
    question.type === "matrix" && question.columns?.length
      ? `<table class="matrix"><thead><tr><th></th>${question.columns
          .map((column) => `<th>${escapeHtml(column)}</th>`)
          .join("")}</tr></thead><tbody><tr><td class="matrix-row">（行）</td>${question.columns
          .map(() => '<td class="matrix-cell"></td>')
          .join("")}</tr></tbody></table>`
      : "";
  const options = question.options?.length
    ? `<ol class="options">${[...question.options]
        .sort((a, b) => a.order - b.order)
        .map((option) => `<li>${escapeHtml(option.label)}</li>`)
        .join("")}</ol>`
    : question.type === "text" || question.type === "long_text"
      ? '<div class="answer-line"></div>'
      : "";
  const constraints = describeValidation(question.validation);
  const constraintLine = constraints.length
    ? `<p class="constraints">限制：${escapeHtml(constraints.join(" · "))}</p>`
    : "";

  return `<section class="question">
  <header class="q-head">
    <span class="q-index">${index + 1}</span>
    <span class="q-type">${escapeHtml(label)}</span>
    ${required}
  </header>
  <h3 class="q-title">${escapeHtml(question.title || "（无标题）")}</h3>
  ${description}
  ${options}
  ${columns}
  ${constraintLine}
</section>`;
}

function renderSurveyHtml(survey: ExportSurvey): string {
  const questions = sortedQuestions(survey);
  const status = survey.status ? (STATUS_LABELS[survey.status] ?? survey.status) : "";
  const pageCount = survey.pages?.length ?? 0;
  const meta = [`${questions.length} 题`, pageCount ? `${pageCount} 页` : "", status].filter(Boolean).join(" · ");

  // 按页分组：有 pages 时用页面标题当小标题；没有页码信息就整卷一节。
  // 分页分组：id 统一按字符串比较，且**落不进任何一页的题目也必须渲染**。
  // 静默丢题比排版难看严重得多——导入器给的 `page_id` 是 "p1" 这类字符串，
  // 编辑器接口给的是数字，把类型当身份用就会丢掉整卷题目。
  const pageKeys = new Set(pageCount ? survey.pages!.map((page) => String(page.id)) : []);
  const byPage = new Map<string | null, ExportSurveyQuestion[]>();
  for (const question of questions) {
    const raw = question.pageId;
    const key = raw === null || raw === undefined ? null : String(raw);
    const bucketKey = key !== null && pageKeys.has(key) ? key : null;
    const bucket = byPage.get(bucketKey) ?? [];
    bucket.push(question);
    byPage.set(bucketKey, bucket);
  }

  const pageBlocks = pageCount
    ? survey
        .pages!.slice()
        .sort((a, b) => a.order - b.order)
        .map((page) => {
          const bucket = byPage.get(String(page.id)) ?? [];
          if (!bucket.length) return "";
          return `<div class="page-block">
  <h2 class="page-title">${escapeHtml(page.title || "未命名分页")}</h2>
  ${page.description?.trim() ? `<p class="page-desc">${escapeHtml(page.description.trim())}</p>` : ""}
  ${bucket.map((question, index) => renderQuestionHtml(question, index)).join("\n")}
</div>`;
        })
        .filter(Boolean)
    : [];

  const orphans = byPage.get(null) ?? [];
  const orphanBlock = orphans.length
    ? `<div class="page-block">
  <h2 class="page-title">${pageCount ? "未分页题目" : "题目"}</h2>
  ${orphans.map((question, index) => renderQuestionHtml(question, index)).join("\n")}
</div>`
    : "";

  const body = pageCount
    ? [...pageBlocks, orphanBlock].filter(Boolean).join("\n")
    : questions.map((question, index) => renderQuestionHtml(question, index)).join("\n");

  return `<article class="survey">
  <header class="survey-head">
    <h1>${escapeHtml(survey.title || `问卷 #${survey.id}`)}</h1>
    <p class="survey-meta">${escapeHtml(meta)} · 编号 #${survey.id}</p>
    ${survey.description?.trim() ? `<p class="survey-desc">${escapeHtml(survey.description.trim())}</p>` : ""}
  </header>
  ${body || '<p class="empty">这份问卷还没有题目。</p>'}
</article>`;
}

const EXPORT_CSS = `
*{box-sizing:border-box}
body{margin:0;padding:0;font-family:system-ui,-apple-system,"Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif;color:#111;background:#fff;line-height:1.6}
.survey{padding:0 0 24pt;page-break-after:always;break-after:page}
.survey:last-child{page-break-after:auto;break-after:auto}
.survey-head{border-bottom:2pt solid #111;padding-bottom:8pt;margin-bottom:16pt}
h1{font-size:20pt;margin:0 0 4pt}
.survey-meta{font-size:9pt;color:#555;margin:0}
.survey-desc{font-size:10.5pt;color:#333;margin:8pt 0 0;white-space:pre-wrap}
.page-title{font-size:13pt;margin:18pt 0 6pt;padding-bottom:3pt;border-bottom:1pt solid #ccc}
.page-desc{font-size:10pt;color:#555;margin:0 0 8pt;white-space:pre-wrap}
.question{margin:0 0 14pt;page-break-inside:avoid;break-inside:avoid}
.q-head{display:flex;align-items:center;gap:6pt;font-size:8.5pt}
.q-index{display:inline-flex;align-items:center;justify-content:center;min-width:16pt;height:16pt;border-radius:8pt;background:#111;color:#fff;font-weight:600}
.q-type{color:#444;border:1pt solid #bbb;border-radius:3pt;padding:0 4pt}
.req{color:#b91c1c;font-weight:600}
.q-title{font-size:11.5pt;margin:4pt 0 4pt;font-weight:600}
.q-desc{font-size:10pt;color:#444;margin:0 0 4pt;white-space:pre-wrap}
.options{margin:4pt 0 0;padding-left:20pt;font-size:10.5pt}
.options li{margin:1pt 0}
.answer-line{border-bottom:1pt dashed #999;height:18pt;margin:6pt 0}
.matrix{border-collapse:collapse;margin-top:6pt;font-size:9.5pt;width:100%}
.matrix th,.matrix td{border:0.75pt solid #bbb;padding:3pt 6pt}
.matrix-row{color:#666}
.matrix-cell{height:14pt}
.constraints{font-size:9pt;color:#666;margin:4pt 0 0}
.empty{color:#666;font-style:italic}
@media print{
  @page{size:A4;margin:16mm}
  body{font-size:10.5pt}
  .toolbar{display:none}
}
@media screen{
  body{max-width:820px;margin:0 auto;padding:32px 24px;background:#f5f5f5}
  .survey{background:#fff;padding:28px 32px;margin-bottom:24px;border-radius:8px;box-shadow:0 1px 4px rgba(0,0,0,.12)}
  .toolbar{position:sticky;top:0;z-index:10;display:flex;gap:12px;justify-content:center;align-items:center;padding:12px;margin:-32px -24px 24px;background:#1f2937;color:#fff;font-size:14px}
  .toolbar button{padding:6px 14px;border:0;border-radius:6px;background:#fff;color:#111;font-weight:600;cursor:pointer}
}
`;

/**
 * 生成可直接打印的 HTML 文档。
 *
 * 屏幕下带一条工具栏（打印按钮），打印时由 `@media print` 隐藏——所以下载下来
 * 的同一份文件既能当网页分享，也能直接印成 PDF，不需要导出两次。
 */
export function buildSurveyExportHtml(
  surveys: ExportSurvey[],
  options: { generatedAt?: Date; title?: string } = {},
): string {
  const generatedAt = options.generatedAt ?? new Date();
  const documentTitle = options.title?.trim() || "问卷导出";
  const stamp = generatedAt.toLocaleString("zh-CN", { hour12: false });
  const body = surveys.length ? surveys.map(renderSurveyHtml).join("\n") : '<p class="empty">没有选中任何问卷。</p>';

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(documentTitle)}</title>
<style>${EXPORT_CSS}</style>
</head>
<body>
<div class="toolbar">
  <span>${escapeHtml(documentTitle)} · ${surveys.length} 份 · ${escapeHtml(stamp)}</span>
  <button type="button" onclick="window.print()">打印 / 另存为 PDF</button>
</div>
${body}
</body>
</html>`;
}

/** Markdown 导出：适合进知识库、贴进 GitHub issue、或再做二次处理。 */
export function buildSurveyExportMarkdown(surveys: ExportSurvey[], options: { generatedAt?: Date } = {}): string {
  const generatedAt = options.generatedAt ?? new Date();
  const blocks = surveys.map((survey) => {
    const questions = sortedQuestions(survey);
    const lines: string[] = [];
    lines.push(`# ${survey.title || `问卷 #${survey.id}`}`);
    lines.push("");
    lines.push(
      `> 编号 #${survey.id} · ${questions.length} 题${survey.status ? ` · ${STATUS_LABELS[survey.status] ?? survey.status}` : ""}`,
    );
    if (survey.description?.trim()) {
      lines.push("");
      lines.push(survey.description.trim());
    }
    lines.push("");
    questions.forEach((question, index) => {
      const required = question.required ? " **（必答）**" : "";
      lines.push(`## ${index + 1}. ${question.title || "（无标题）"}${required}`);
      lines.push("");
      lines.push(`- 类型：${formatQuestionType(question.type)}`);
      const constraints = describeValidation(question.validation);
      if (constraints.length) lines.push(`- 限制：${constraints.join(" · ")}`);
      if (question.description?.trim()) lines.push(`- 说明：${question.description.trim()}`);
      if (question.options?.length) {
        lines.push("");
        for (const option of [...question.options].sort((a, b) => a.order - b.order)) {
          lines.push(`${question.type === "multiple" ? "- [ ]" : "-"} ${option.label}`);
        }
      }
      if (question.type === "matrix" && question.columns?.length) {
        lines.push("");
        lines.push(`|  | ${question.columns.map(escapeMarkdownCell).join(" | ")} |`);
        lines.push(`| --- | ${question.columns.map(() => "---").join(" | ")} |`);
      }
      lines.push("");
    });
    return lines.join("\n").trimEnd();
  });

  return [`<!-- 导出于 ${generatedAt.toISOString()} -->`, "", ...blocks].join("\n\n") + "\n";
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** JSON 导出：保持与导入器兼容的结构，方便再导回。 */
export function buildSurveyExportJson(surveys: ExportSurvey[], options: { generatedAt?: Date } = {}): string {
  const generatedAt = options.generatedAt ?? new Date();
  return JSON.stringify(
    {
      exported_at: generatedAt.toISOString(),
      count: surveys.length,
      surveys: surveys.map((survey) => ({
        id: survey.id,
        title: survey.title,
        description: survey.description ?? null,
        status: survey.status ?? null,
        pages: survey.pages ?? [],
        questions: sortedQuestions(survey).map((question) => ({
          id: question.id,
          type: question.type,
          title: question.title,
          description: question.description ?? null,
          required: Boolean(question.required),
          order: question.order,
          columns: question.columns ?? [],
          validation: question.validation ?? null,
          options: [...(question.options ?? [])].sort((a, b) => a.order - b.order),
        })),
      })),
    },
    null,
    2,
  );
}

export function buildExportContent(
  format: ExportFormat,
  surveys: ExportSurvey[],
  options: { generatedAt?: Date } = {},
): { content: string; mime: string; extension: string } {
  if (format === "json") {
    return { content: buildSurveyExportJson(surveys, options), mime: "application/json", extension: "json" };
  }
  if (format === "markdown") {
    return { content: buildSurveyExportMarkdown(surveys, options), mime: "text/markdown", extension: "md" };
  }
  return { content: buildSurveyExportHtml(surveys, options), mime: "text/html", extension: "html" };
}

/** 文件名：批量导出用日期 + 份数，单手导出带上问卷标题（去掉路径分隔符）。 */
export function buildExportFileName(
  format: ExportFormat,
  surveys: ExportSurvey[],
  generatedAt: Date = new Date(),
): string {
  const stamp = [
    generatedAt.getFullYear(),
    String(generatedAt.getMonth() + 1).padStart(2, "0"),
    String(generatedAt.getDate()).padStart(2, "0"),
  ].join("");
  const safeTitle = (value: string) =>
    value
      .replace(/[\\/:*?"<>|\s]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  const base =
    surveys.length === 1
      ? safeTitle(surveys[0]?.title || `survey-${surveys[0]?.id}`) || "survey"
      : `surveys-${surveys.length}`;
  return `${base}-${stamp}.${format === "json" ? "json" : format === "markdown" ? "md" : "html"}`;
}
