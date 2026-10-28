import { useMemo, useState } from "react";
import { api, type EditorData, type SurveyListData } from "../api";
import { useApi } from "../hooks";
import {
  buildExportContent,
  buildExportFileName,
  buildSurveyExportHtml,
  type ExportFormat,
  type ExportSurvey,
} from "../lib/survey-export";
import { CheckSquare, Download, FileJson, FileText, Loader2, Printer, Square } from "lucide-react";

const PAGE_SIZE = 200;

const FORMAT_OPTIONS: Array<{ value: ExportFormat; label: string; hint: string }> = [
  { value: "html", label: "HTML", hint: "打印视图，可直接印成 PDF" },
  { value: "markdown", label: "Markdown", hint: "贴进知识库或 GitHub" },
  { value: "json", label: "JSON", hint: "结构与导入器兼容，可再导回" },
];

/**
 * 把编辑器接口的问卷结构压成导出结构。
 *
 * `validation` 在编辑器里是 `Record<string, unknown>`（历史数据里可能混着
 * 字符串），这里只保留数字与布尔值，避免把脏数据带进导出文件。
 */
function toExportSurvey(data: EditorData): ExportSurvey {
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

export function ExportPage() {
  const { data, error, retry } = useApi<SurveyListData>(`/api/admin/surveys?page=1&pageSize=${PAGE_SIZE}`);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [format, setFormat] = useState<ExportFormat>("html");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const surveys = data?.items ?? [];
  const visible = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    if (!keyword) return surveys;
    return surveys.filter((survey) => survey.title.toLowerCase().includes(keyword));
  }, [surveys, search]);

  const toggle = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllVisible = () => setSelected(new Set(visible.map((survey) => survey.id)));
  const clearSelection = () => setSelected(new Set());

  /** 逐个拉详情：一次并发 N 个请求只会让 D1 排队，串行还能报进度。 */
  const loadSelected = async (): Promise<ExportSurvey[]> => {
    const ids = visible.filter((survey) => selected.has(survey.id)).map((survey) => survey.id);
    if (!ids.length) throw new Error("请先选择要导出的问卷");
    const result: ExportSurvey[] = [];
    setProgress({ done: 0, total: ids.length });
    for (let index = 0; index < ids.length; index += 1) {
      const detail = await api<EditorData>(`/api/admin/surveys/${ids[index]}`);
      result.push(toExportSurvey(detail));
      setProgress({ done: index + 1, total: ids.length });
    }
    return result;
  };

  const handleDownload = async () => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    setNotice(null);
    try {
      const collected = await loadSelected();
      const generatedAt = new Date();
      const { content, mime, extension } = buildExportContent(format, collected, { generatedAt });
      downloadBlob(content, mime, buildExportFileName(format, collected, generatedAt));
      setNotice(
        `已导出 ${collected.length} 份问卷（${extension.toUpperCase()}，${Math.round(content.length / 1024)} KB）`,
      );
    } catch (requestError) {
      setProblem(requestError instanceof Error ? requestError.message : "导出失败");
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  /**
   * 打印/另存为 PDF：先同步开窗（异步之后 `window.open` 会被拦截），再把同一份
   * HTML 写进去。PDF 由浏览器的打印引擎产出——中文与分页都由它负责，服务端
   * 不需要嵌字体。
   */
  const handlePrint = async () => {
    if (busy) return;
    const win = window.open("", "_blank");
    if (!win) {
      setProblem("浏览器拦截了新窗口，请允许本站弹窗后重试");
      return;
    }
    setBusy(true);
    setProblem(null);
    setNotice(null);
    try {
      const collected = await loadSelected();
      const html = buildSurveyExportHtml(collected, { generatedAt: new Date() });
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
      setNotice(`已在打印视图中打开 ${collected.length} 份问卷，选择「另存为 PDF」即可保存`);
    } catch (requestError) {
      win.close();
      setProblem(requestError instanceof Error ? requestError.message : "打开打印视图失败");
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const selectedCount = [...selected].filter((id) => visible.some((survey) => survey.id === id)).length;

  return (
    <div className="space-y-4">
      <section className="card">
        <h1 className="text-xl font-semibold">批量导出问卷</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          勾选问卷后导出为 HTML / Markdown / JSON。选 HTML 并点「打印 / 另存为
          PDF」，浏览器的打印对话框即可产出分页正确的 PDF（每份问卷单独起页）。
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <input
            className="min-w-0 flex-1 rounded-lg border border-[var(--control-border)] bg-[var(--surface)] px-3 py-2.5 text-sm"
            placeholder="按标题筛选"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <button className="btn btn-sm" onClick={selectAllVisible} disabled={!visible.length || busy}>
            <CheckSquare className="h-4 w-4" />
            全选当前 {visible.length} 份
          </button>
          <button className="btn btn-sm" onClick={clearSelection} disabled={!selected.size || busy}>
            <Square className="h-4 w-4" />
            清空
          </button>
        </div>

        {data && data.total > surveys.length ? (
          <p className="mt-2 text-sm text-[var(--app-warning)]">
            共 {data.total} 份，本页只加载了最近更新的 {surveys.length} 份；其余请到「问卷」页筛选后再来。
          </p>
        ) : null}

        {error ? (
          <div className="mt-3 flex items-center gap-2 text-sm text-[var(--app-danger)]">
            <span>{error.message}</span>
            <button className="btn btn-sm" onClick={retry}>
              重试
            </button>
          </div>
        ) : null}

        <ul className="mt-4 max-h-[26rem] divide-y divide-[var(--color-edge)] overflow-auto rounded-lg border border-[var(--color-edge)]">
          {visible.length === 0 ? (
            <li className="p-4 text-sm text-[var(--color-muted)]">{data ? "没有匹配的问卷" : "加载中…"}</li>
          ) : null}
          {visible.map((survey) => {
            const checked = selected.has(survey.id);
            return (
              <li key={survey.id}>
                <label className="flex cursor-pointer items-center gap-3 p-3 text-sm hover:bg-[var(--surface-muted)]">
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={checked}
                    onChange={() => toggle(survey.id)}
                    disabled={busy}
                  />
                  <span className="min-w-0 flex-1 truncate font-medium">{survey.title}</span>
                  <span className="shrink-0 text-xs text-[var(--color-muted)]">
                    #{survey.id} · {survey.questionCount} 题 · {survey.status}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="card">
        <h2 className="text-lg font-semibold">导出设置</h2>
        <div className="mt-3 flex flex-wrap gap-2">
          {FORMAT_OPTIONS.map((option) => (
            <button
              key={option.value}
              className={`rounded-lg border px-3 py-2 text-left text-sm transition ${
                format === option.value
                  ? "border-[var(--color-primary)] bg-[color-mix(in_srgb,var(--color-primary)_10%,var(--surface))]"
                  : "border-[var(--control-border)] bg-[var(--surface)]"
              }`}
              onClick={() => setFormat(option.value)}
              disabled={busy}
              aria-pressed={format === option.value}
            >
              <span className="block font-medium">{option.label}</span>
              <span className="block text-xs text-[var(--color-muted)]">{option.hint}</span>
            </button>
          ))}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button className="btn" disabled={busy || !selectedCount} onClick={() => void handleDownload()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            下载 {format === "json" ? <FileJson className="h-4 w-4" /> : <FileText className="h-4 w-4" />}（
            {selectedCount} 份）
          </button>
          <button className="btn" disabled={busy || !selectedCount} onClick={() => void handlePrint()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Printer className="h-4 w-4" />}
            打印 / 另存为 PDF
          </button>
          {progress ? (
            <span className="text-sm text-[var(--color-muted)]">
              正在读取 {progress.done}/{progress.total} 份…
            </span>
          ) : null}
        </div>

        {notice ? <p className="mt-3 text-sm text-[var(--app-success)]">{notice}</p> : null}
        {problem ? <p className="mt-3 text-sm text-[var(--app-danger)]">{problem}</p> : null}
      </section>
    </div>
  );
}
