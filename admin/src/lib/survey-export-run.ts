/**
 * 问卷导出的「动作层」：拉详情 → 拼内容 → 下载 / 唤起打印。
 *
 * `survey-export.ts` 只负责把结构渲染成字符串（纯函数，好测）；这里负责
 * 把它跑起来。两者分开是因为动作层必须碰 DOM（Blob、`window.open`），
 * 一碰就没法在 node 里断言了。
 *
 * 导出入口有两处，共用这一份实现：
 *   1. 问卷列表页的批量操作栏（主要入口——导出属于「管理问卷」的动作，
 *      不该单开一个导航位）；
 *   2. `/admin/exports` 这个 URL 仍然可达，重定向到问卷页并带上选中的 id。
 */

import { api, type EditorData } from "../api";
import {
  buildExportContent,
  buildExportFileName,
  buildSurveyExportHtml,
  type ExportFormat,
  type ExportSurvey,
} from "./survey-export";

export type ExportProgress = (done: number, total: number) => void;

/**
 * 把编辑器接口的问卷结构压成导出结构。
 *
 * `validation` 在编辑器里是 `Record<string, unknown>`（历史数据里可能混着
 * 字符串），这里只保留数字与布尔值，避免把脏数据带进导出文件。
 */
export function toExportSurvey(data: EditorData): ExportSurvey {
  const validation = (raw: Record<string, unknown> | null, question: EditorData["questions"][number]) => {
    const merged: Record<string, number | boolean> = {};
    if (question.type === "matrix") {
      const columns = question.settings?.columns;
      if (Array.isArray(columns)) merged.matrix_columns = columns.length;
    }
    if (!raw) return merged;
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === "number" || typeof value === "boolean") merged[key] = value;
    }
    return merged;
  };

  return {
    id: data.survey.id,
    title: data.survey.title,
    description: data.survey.description,
    status: data.survey.status,
    pages: data.pages,
    questions: data.questions.map((question) => ({
      id: question.id,
      type: question.type,
      title: question.title,
      description: question.description,
      required: question.required,
      order: question.order,
      pageId: question.pageId,
      columns: Array.isArray(question.settings?.columns)
        ? (question.settings!.columns as unknown[]).filter((column): column is string => typeof column === "string")
        : [],
      validation: validation(question.validation, question),
      options: question.options.map((option) => ({ id: option.id, label: option.label, order: option.order })),
    })),
  };
}

/** 逐个拉详情：并发只会让 D1 排队，串行还能报进度。 */
export async function fetchExportSurveys(ids: number[], onProgress?: ExportProgress): Promise<ExportSurvey[]> {
  if (!ids.length) throw new Error("请先选择要导出的问卷");
  const result: ExportSurvey[] = [];
  onProgress?.(0, ids.length);
  for (let index = 0; index < ids.length; index += 1) {
    const detail = await api<EditorData>(`/api/admin/surveys/${ids[index]}`);
    result.push(toExportSurvey(detail));
    onProgress?.(index + 1, ids.length);
  }
  return result;
}

function downloadBlob(content: string, mime: string, fileName: string) {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // 立刻 revoke 在部分浏览器上会让下载中断，留一拍再释放。
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

export interface ExportOutcome {
  /** 给用户看的一句话结果（成功时）。 */
  notice: string;
  count: number;
  bytes: number;
}

/** 下载文件（HTML / Markdown / JSON）。 */
export async function downloadSurveyExport(
  ids: number[],
  format: ExportFormat,
  onProgress?: ExportProgress,
): Promise<ExportOutcome> {
  const surveys = await fetchExportSurveys(ids, onProgress);
  const generatedAt = new Date();
  const { content, mime, extension } = buildExportContent(format, surveys, { generatedAt });
  downloadBlob(content, mime, buildExportFileName(format, surveys, generatedAt));
  return {
    notice: `已导出 ${surveys.length} 份问卷（${extension.toUpperCase()}，${Math.round(content.length / 1024)} KB）`,
    count: surveys.length,
    bytes: content.length,
  };
}

/**
 * 打印 / 另存为 PDF。
 *
 * 先同步开窗（异步之后 `window.open` 会被拦截），再把同一份 HTML 写进去。
 * PDF 由浏览器的打印引擎产出——中文与分页都由它负责，服务端不需要嵌字体。
 */
export async function printSurveyExport(ids: number[], onProgress?: ExportProgress): Promise<ExportOutcome> {
  const win = window.open("", "_blank");
  if (!win) throw new Error("浏览器拦截了新窗口，请允许本站弹窗后重试");
  try {
    const surveys = await fetchExportSurveys(ids, onProgress);
    const html = buildSurveyExportHtml(surveys, { generatedAt: new Date() });
    win.document.open();
    win.document.write(html);
    win.document.close();
    win.focus();
    // 等排版与字体就绪再唤起打印对话框；过早调用会印出空白页。
    setTimeout(() => {
      try {
        win.print();
      } catch {
        /* 用户可能已经关掉了窗口 */
      }
    }, 600);
    return {
      notice: `已在打印视图中打开 ${surveys.length} 份问卷，选择「另存为 PDF」即可保存`,
      count: surveys.length,
      bytes: html.length,
    };
  } catch (error) {
    win.close();
    throw error;
  }
}
