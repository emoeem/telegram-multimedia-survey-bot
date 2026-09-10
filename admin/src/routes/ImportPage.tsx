import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { ApiError, api, apiSend, type ImportIssue, type ImportSummary, type ReportTemplateOption } from "../api";
import { AlertTriangle, FilePlus2, FileSearch, FolderOpen, Link2 } from "lucide-react";

const TYPE_LABELS: Record<string, string> = {
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
};

function formatConfidence(value: number | undefined): string {
  return value === undefined ? "—" : `${Math.round(value * 100)}%`;
}

export function ImportPage() {
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [content, setContent] = useState("");
  const [urlInput, setUrlInput] = useState("");
  const [importingUrl, setImportingUrl] = useState(false);
  const [validating, setValidating] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<ImportIssue[]>([]);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [templates, setTemplates] = useState<ReportTemplateOption[]>([]);
  const [templateId, setTemplateId] = useState("");

  useEffect(() => {
    api<{ templates: ReportTemplateOption[] }>("/api/admin/report-templates")
      .then((data) => setTemplates(data.templates ?? []))
      .catch(() => setTemplates([]));
  }, []);

  const validate = async (overrideContent?: string) => {
    const source = overrideContent ?? content;
    if (validating || !source.trim()) return;
    setValidating(true);
    setError(null);
    setIssues([]);
    setSummary(null);
    try {
      const result = await apiSend<ImportSummary>("POST", "/api/admin/imports/validate", {
        content: source,
        ...(templateId ? { reportTemplateId: templateId } : {}),
      });
      setSummary(result);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "校验失败");
      if (requestError instanceof ApiError && Array.isArray(requestError.data?.issues)) {
        setIssues(requestError.data.issues as ImportIssue[]);
      }
    } finally {
      setValidating(false);
    }
  };

  const importFromUrl = async () => {
    if (importingUrl || !urlInput.trim()) return;
    setImportingUrl(true);
    setError(null);
    setIssues([]);
    setSummary(null);
    try {
      const result = await apiSend<{ content: string; title: string }>("POST", "/api/admin/imports/from-url", {
        url: urlInput.trim(),
      });
      setContent(result.content);
      setUrlInput("");
      await validate(result.content);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "从 URL 导入失败");
      if (requestError instanceof ApiError && Array.isArray(requestError.data?.issues)) {
        setIssues(requestError.data.issues as ImportIssue[]);
      }
    } finally {
      setImportingUrl(false);
    }
  };

  const createDraft = async () => {
    if (creating || !summary) return;
    setCreating(true);
    setError(null);
    setIssues([]);
    try {
      const result = await apiSend<{ id: number }>("POST", "/api/admin/imports", {
        content,
        ...(templateId ? { reportTemplateId: templateId } : {}),
      });
      navigate(`/surveys/${result.id}/editor`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "创建草稿失败");
      setCreating(false);
    }
  };

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 40 * 1024 * 1024) {
      setError("导入文件不能超过 40MB");
      return;
    }
    setError(null);
    setIssues([]);
    try {
      setContent(await file.text());
      setSummary(null);
    } catch {
      setError("读取文件失败，请确认是 UTF-8 编码的 JSON 文件");
    }
  };

  return (
    <div className="space-y-4">
      <section className="card">
        <h2 className="text-lg font-semibold">从 Microsoft / Zoho URL 导入</h2>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          输入公开的 Microsoft Forms 或 Zoho Forms 问卷链接，自动转换为标准问卷 JSON。PDF 与 Office 文档请在本地运行
          <code className="mx-1 rounded bg-[var(--surface-muted)] px-1.5 py-0.5 font-mono text-xs">
            uv run python scripts/import_survey_from_url.py
          </code>
          后把生成的 survey.json 粘贴到下方。
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <input
            type="url"
            className="min-w-64 flex-1 rounded-lg border border-[var(--control-border)] bg-[var(--surface)] px-3 py-2.5 text-sm"
            placeholder="https://forms.office.com/r/… 或 forms.zohopublic.com/…"
            value={urlInput}
            onChange={(event) => {
              setUrlInput(event.target.value);
              setIssues([]);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") void importFromUrl();
            }}
          />
          <button className="btn" disabled={importingUrl || !urlInput.trim()} onClick={() => void importFromUrl()}>
            {importingUrl ? (
              "导入中…"
            ) : (
              <>
                <Link2 className="h-4 w-4" />从 URL 导入
              </>
            )}
          </button>
        </div>
      </section>

      <section className="card">
        <h2 className="text-lg font-semibold">导入问卷 JSON</h2>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          支持 PDF 转换器（scripts/forms_pdf_to_survey.py）输出的 survey.json，或任意符合统一结构的 JSON。
        </p>
        <textarea
          className="mt-4 min-h-64 w-full rounded-lg border border-[var(--control-border)] bg-[var(--surface)] p-3 font-mono text-sm leading-relaxed"
          placeholder='{"schema_version":1,"survey":{"title":"问卷标题","questions":[...]}}'
          value={content}
          onChange={(event) => {
            setContent(event.target.value);
            setIssues([]);
            setSummary(null);
          }}
        />
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button className="btn" disabled={validating || !content.trim()} onClick={() => void validate()}>
            {validating ? (
              "校验中…"
            ) : (
              <>
                <FileSearch className="h-4 w-4" />
                校验并预览
              </>
            )}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(event) => void pickFile(event.target.files?.[0])}
          />
          <button className="btn" onClick={() => fileInputRef.current?.click()}>
            <FolderOpen className="h-4 w-4" />
            选择 JSON 文件
          </button>
          <select
            className="rounded-lg border border-[var(--control-border)] bg-[var(--surface)] px-3 py-2.5 text-sm sm:flex-none"
            value={templateId}
            onChange={(event) => setTemplateId(event.target.value)}
          >
            <option value="">报告模板：平台默认</option>
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
              </option>
            ))}
          </select>
        </div>
        {error ? <div className="mt-3 whitespace-pre-wrap text-sm text-[var(--color-danger)]">{error}</div> : null}
        {issues.length ? (
          <div className="mt-3 rounded-lg bg-[color-mix(in_srgb,var(--color-danger)_10%,var(--surface))] p-3 text-sm text-[var(--color-danger)]">
            <div className="font-medium">导入校验失败（{issues.length} 处）</div>
            <ul className="mt-1 max-h-72 list-inside list-disc space-y-1 overflow-auto">
              {issues.map((issue, index) => (
                <li key={index}>
                  {issue.questionNumber ? (
                    <>
                      第 {issue.questionNumber} 题{issue.questionTitle ? `「${issue.questionTitle}」` : ""}
                      {issue.field && issue.field !== "question" ? ` · ${issue.field}` : ""}：
                    </>
                  ) : null}
                  {issue.message}
                  <span className="ml-1 font-mono text-xs text-[var(--color-danger)]">{issue.path}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      {summary ? (
        <section className="card">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-lg font-semibold">{summary.title || "未命名问卷"}</h3>
              {summary.description ? (
                <p className="mt-1 text-sm text-[var(--color-muted)]">{summary.description}</p>
              ) : null}
              {summary.cover ? (
                <img
                  src={summary.cover.url}
                  alt="问卷封面"
                  className="mt-3 aspect-[16/7] w-full max-w-md rounded-xl object-cover"
                />
              ) : null}
              {summary.reportTemplateId ? (
                <p className="mt-1 text-sm text-[var(--color-primary)]">
                  报告模板：{summary.reportTemplateName ?? summary.reportTemplateId}
                </p>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2 text-sm">
              <span className="rounded-full bg-[color-mix(in_srgb,var(--color-primary)_10%,var(--surface))] px-3 py-1 font-medium text-[var(--color-primary)]">
                {summary.questionCount} 题
              </span>
              <span className="rounded-full bg-[var(--surface-muted)] px-3 py-1 text-[var(--text-soft)]">
                {summary.optionCount} 选项
              </span>
              <span className="rounded-full bg-[var(--surface-muted)] px-3 py-1 text-[var(--text-soft)]">
                {summary.pageCount} 页
              </span>
              <span className="rounded-full bg-[var(--surface-muted)] px-3 py-1 text-[var(--text-soft)]">
                {summary.media.total} 媒体
              </span>
            </div>
          </div>

          {Object.keys(summary.typeCounts).length ? (
            <div className="mt-4">
              <div className="text-sm font-medium text-[var(--color-muted)]">题型分布</div>
              <div className="mt-2 flex flex-wrap gap-2 text-sm">
                {Object.entries(summary.typeCounts).map(([type, count]) => (
                  <span key={type} className="rounded-lg border border-[var(--color-edge)] px-2.5 py-1">
                    {TYPE_LABELS[type] ?? type} <span className="font-semibold">×{count}</span>
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          {summary.media.total > 0 ? (
            <div className="mt-4 text-sm text-[var(--color-muted)]">
              问题媒体 {summary.media.question} · 选项媒体 {summary.media.option}
            </div>
          ) : null}

          {summary.warnings.length ? (
            <div className="mt-4 rounded-lg bg-[color-mix(in_srgb,var(--color-warning)_12%,var(--surface))] p-3 text-sm text-[var(--color-warning)]">
              <div className="flex items-center gap-1.5 font-medium">
                <AlertTriangle className="h-4 w-4" />
                自动修复警告
              </div>
              <ul className="mt-1 list-inside list-disc space-y-0.5">
                {summary.warnings.map((warning, index) => (
                  <li key={index}>{warning}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {summary.lowConfidence.length ? (
            <div className="mt-4 rounded-lg bg-[color-mix(in_srgb,var(--color-danger)_10%,var(--surface))] p-3 text-sm text-[var(--color-danger)]">
              <div className="flex items-center gap-1.5 font-medium">
                <AlertTriangle className="h-4 w-4" />
                建议重点检查 {summary.lowConfidence.length}+ 道题（低置信度或警告）
              </div>
              <ul className="mt-1 max-h-56 list-inside list-disc space-y-1 overflow-auto">
                {summary.lowConfidence.map((question) => (
                  <li key={question.order}>
                    第 {question.order} 题 · {question.title || "（无标题）"}
                    <span className="ml-1 text-[var(--color-danger)]">
                      （题型 {formatConfidence(question.confidence?.type)} · 必答{" "}
                      {formatConfidence(question.confidence?.required)}）
                    </span>
                    {question.warnings.length ? (
                      <ul className="ml-4 list-disc">
                        {question.warnings.map((warning, index) => (
                          <li key={index} className="text-[var(--color-danger)]">
                            {warning}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="mt-5 flex flex-wrap gap-3">
            <button className="btn" disabled={creating} onClick={() => void createDraft()}>
              {creating ? (
                "创建中…"
              ) : (
                <>
                  <FilePlus2 className="h-4 w-4" />
                  创建草稿并进入编辑器
                </>
              )}
            </button>
            <button className="btn" disabled={creating} onClick={() => setSummary(null)}>
              返回修改
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
