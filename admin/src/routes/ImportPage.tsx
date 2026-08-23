import { useRef, useState } from "react";
import { useNavigate } from "react-router";
import { apiSend, type ImportSummary } from "../api";

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
  const [validating, setValidating] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);

  const validate = async () => {
    if (validating || !content.trim()) return;
    setValidating(true);
    setError(null);
    setSummary(null);
    try {
      const result = await apiSend<ImportSummary>("POST", "/api/admin/imports/validate", { content });
      setSummary(result);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "校验失败");
    } finally {
      setValidating(false);
    }
  };

  const createDraft = async () => {
    if (creating || !summary) return;
    setCreating(true);
    setError(null);
    try {
      const result = await apiSend<{ id: number }>("POST", "/api/admin/imports", { content });
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
    try {
      setContent(await file.text());
      setSummary(null);
    } catch {
      setError("读取文件失败，请确认是 UTF-8 编码的 JSON 文件");
    }
  };

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
        <h2 className="text-lg font-semibold">导入问卷 JSON</h2>
        <p className="mt-1 text-sm text-gray-500">
          支持 PDF 转换器（scripts/forms_pdf_to_survey.py）输出的 survey.json，或任意符合统一结构的 JSON。
        </p>
        <textarea
          className="mt-4 min-h-64 w-full rounded-lg border border-gray-300 bg-white p-3 font-mono text-sm leading-relaxed"
          placeholder='{"schema_version":1,"survey":{"title":"问卷标题","questions":[...]}}'
          value={content}
          onChange={(event) => {
            setContent(event.target.value);
            setSummary(null);
          }}
        />
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button className="btn" disabled={validating || !content.trim()} onClick={() => void validate()}>
            {validating ? "校验中…" : "🔍 校验并预览"}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(event) => void pickFile(event.target.files?.[0])}
          />
          <button className="btn" onClick={() => fileInputRef.current?.click()}>
            📂 选择 JSON 文件
          </button>
        </div>
        {error ? <div className="mt-3 whitespace-pre-wrap text-sm text-red-600">{error}</div> : null}
      </section>

      {summary ? (
        <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-lg font-semibold">{summary.title || "未命名问卷"}</h3>
              {summary.description ? <p className="mt-1 text-sm text-gray-500">{summary.description}</p> : null}
            </div>
            <div className="flex flex-wrap gap-2 text-sm">
              <span className="rounded-full bg-indigo-50 px-3 py-1 font-medium text-indigo-700">{summary.questionCount} 题</span>
              <span className="rounded-full bg-slate-100 px-3 py-1 text-slate-700">{summary.optionCount} 选项</span>
              <span className="rounded-full bg-slate-100 px-3 py-1 text-slate-700">{summary.pageCount} 页</span>
              <span className="rounded-full bg-slate-100 px-3 py-1 text-slate-700">{summary.media.total} 媒体</span>
            </div>
          </div>

          {Object.keys(summary.typeCounts).length ? (
            <div className="mt-4">
              <div className="text-sm font-medium text-gray-500">题型分布</div>
              <div className="mt-2 flex flex-wrap gap-2 text-sm">
                {Object.entries(summary.typeCounts).map(([type, count]) => (
                  <span key={type} className="rounded-lg border border-gray-200 px-2.5 py-1">
                    {TYPE_LABELS[type] ?? type} <span className="font-semibold">×{count}</span>
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          {summary.media.total > 0 ? (
            <div className="mt-4 text-sm text-gray-500">
              问题媒体 {summary.media.question} · 选项媒体 {summary.media.option}
            </div>
          ) : null}

          {summary.warnings.length ? (
            <div className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
              <div className="font-medium">⚠ 自动修复警告</div>
              <ul className="mt-1 list-inside list-disc space-y-0.5">
                {summary.warnings.map((warning, index) => (
                  <li key={index}>{warning}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {summary.lowConfidence.length ? (
            <div className="mt-4 rounded-lg bg-rose-50 p-3 text-sm text-rose-800">
              <div className="font-medium">⚠ 建议重点检查 {summary.lowConfidence.length}+ 道题（低置信度或警告）</div>
              <ul className="mt-1 max-h-56 list-inside list-disc space-y-1 overflow-auto">
                {summary.lowConfidence.map((question) => (
                  <li key={question.order}>
                    第 {question.order} 题 · {question.title || "（无标题）"}
                    <span className="ml-1 text-rose-600">
                      （题型 {formatConfidence(question.confidence?.type)} · 必答 {formatConfidence(question.confidence?.required)}）
                    </span>
                    {question.warnings.length ? (
                      <ul className="ml-4 list-disc">
                        {question.warnings.map((warning, index) => (
                          <li key={index} className="text-rose-700">{warning}</li>
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
              {creating ? "创建中…" : "📝 创建草稿并进入编辑器"}
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
