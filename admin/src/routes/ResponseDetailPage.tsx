import { useState } from "react";
import { Link, useParams } from "react-router";
import { apiPostBlob, apiSend, type ReportTemplateOption } from "../api";
import { useApi } from "../hooks";
import type { ResponseDetailData } from "../api";
import { ErrorPanel, SkeletonPanel } from "../components/ui";
import { formatDateTime } from "../format";
import { ResponseMediaPreview } from "../components/ResponseMediaPreview";

function respondentName(data: ResponseDetailData): string {
  if (data.survey.anonymous || !data.response.respondent) return "匿名用户";
  const respondent = data.response.respondent;
  const name = [respondent.firstName, respondent.lastName].filter(Boolean).join(" ");
  return name || (respondent.username ? `@${respondent.username}` : String(respondent.telegramUserId));
}

export function ResponseDetailPage() {
  const { id, responseId } = useParams<{ id: string; responseId: string }>();
  const { data, error, retry } = useApi<ResponseDetailData>(
    id && responseId ? `/api/admin/surveys/${id}/responses/${responseId}` : null,
  );
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [rawOpen, setRawOpen] = useState<number | null>(null);
  const [previewTemplateId, setPreviewTemplateId] = useState("");
  const templates = useApi<{ templates: ReportTemplateOption[] }>("/api/admin/report-templates");

  const runAction = async (path: string, confirmText?: string) => {
    if (!id || !responseId) return;
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    setActionError(null);
    try {
      const result = await apiSend<{ reportUrl?: string }>("POST", path, {});
      if (result.reportUrl) {
        window.open(result.reportUrl, "_blank");
      } else {
        retry();
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };

  const downloadPdf = async () => {
    if (!id || !responseId) return;
    setBusy(true);
    setActionError(null);
    try {
      const blob = await apiPostBlob(`/api/admin/surveys/${id}/responses/${responseId}/pdf`);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `report-${responseId}.pdf`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "PDF 下载失败");
    } finally {
      setBusy(false);
    }
  };

  const previewWithTemplate = async () => {
    if (!id || !responseId) return;
    setBusy(true);
    setActionError(null);
    try {
      const result = await apiSend<{ reportUrl: string }>(
        "POST",
        `/api/admin/surveys/${id}/responses/${responseId}/report-link`,
        {},
      );
      const separator = result.reportUrl.includes("?") ? "&" : "?";
      const url = previewTemplateId
        ? `${result.reportUrl}${separator}template=${encodeURIComponent(previewTemplateId)}`
        : result.reportUrl;
      window.open(url, "_blank");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "预览失败");
    } finally {
      setBusy(false);
    }
  };

  if (error) return <ErrorPanel error={error} onRetry={retry} />;
  if (!data) return <SkeletonPanel lines={8} />;

  return (
    <div>
      <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">答卷 #{data.response.id}</h2>
            <p className="mt-1 text-sm text-gray-500">{data.survey.title} · {respondentName(data)}</p>
          </div>
          <span className="rounded-full bg-slate-100 px-3 py-1 text-sm text-slate-700">{data.response.statusLabel}</span>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div><span className="text-gray-500">开始：</span>{formatDateTime(data.response.startedAt)}</div>
          <div><span className="text-gray-500">完成：</span>{data.response.completedAt ? formatDateTime(data.response.completedAt) : "—"}</div>
          <div><span className="text-gray-500">更新：</span>{formatDateTime(data.response.updatedAt)}</div>
          <div>
            <span className="text-gray-500">问卷版本：</span>
            <Link className="text-indigo-600 hover:underline" to="../../versions">
              v{data.response.version}
            </Link>
          </div>
        </div>
      </section>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          className="btn"
          disabled={busy}
          onClick={() => void runAction(`/api/admin/surveys/${data.survey.id}/responses/${data.response.id}/report-link`)}
        >
          🌐 打开 Web 报告
        </button>
        <select
          className="input sm:w-44"
          value={previewTemplateId}
          onChange={(event) => setPreviewTemplateId(event.target.value)}
        >
          <option value="">报告模板：默认</option>
          {templates.data?.templates.map((template) => (
            <option key={template.id} value={template.id}>{template.name}</option>
          ))}
        </select>
        <button className="btn" disabled={busy} onClick={() => void previewWithTemplate()}>
          🎨 用所选模板预览
        </button>
        {data.response.status === "completed" ? (
          <button
            className="btn"
            disabled={busy}
            onClick={() => void runAction(`/api/admin/surveys/${data.survey.id}/responses/${data.response.id}/report`)}
          >
            🔄 重新生成报告
          </button>
        ) : null}
        {data.response.status === "completed" ? (
          <button className="btn" disabled={busy} onClick={() => void downloadPdf()}>
            📄 下载 PDF
          </button>
        ) : null}
        {data.response.status === "completed" ? (
          <button
            className="btn"
            disabled={busy}
            onClick={() => void runAction(`/api/admin/surveys/${data.survey.id}/responses/${data.response.id}/resend`)}
          >
            📤 重新发送 Telegram
          </button>
        ) : null}
        {data.response.status !== "archived" ? (
          <button
            className="btn"
            disabled={busy}
            onClick={() => void runAction(
              `/api/admin/surveys/${data.survey.id}/responses/${data.response.id}/archive`,
              "确定归档该答卷？",
            )}
          >
            🗄 归档
          </button>
        ) : null}
        <button
          className="btn text-red-600"
          disabled={busy || data.response.status === "completed"}
          title={data.response.status === "completed" ? "已完成答卷是永久数据，禁止删除" : undefined}
          onClick={() => void runAction(
            `/api/admin/surveys/${data.survey.id}/responses/${data.response.id}/delete`,
            "确定删除该答卷？此操作不可恢复。",
          )}
        >
          🗑 删除
        </button>
        {actionError ? <span className="text-sm text-red-600">{actionError}</span> : null}
      </div>

      <section className="mt-5 space-y-3">
        {data.answers.map((answer) => (
          <article key={answer.questionId} className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
            <div className="text-xs font-medium text-gray-400">第 {answer.order + 1} 题 · {answer.questionType}</div>
            <h3 className="mt-1 font-semibold">{answer.questionTitle}</h3>
            <div className={`mt-3 whitespace-pre-wrap text-sm ${answer.answered ? "text-gray-800" : "text-gray-400"}`}>
              {answer.answered ? answer.value || "已作答" : "未作答"}
            </div>
            {answer.raw && answer.answered ? (
              <button
                className="mt-2 text-xs text-indigo-600 hover:underline"
                onClick={() => setRawOpen(rawOpen === answer.questionId ? null : answer.questionId)}
              >
                {rawOpen === answer.questionId ? "收起原始数据" : "查看原始数据"}
              </button>
            ) : null}
            {rawOpen === answer.questionId && answer.raw ? (
              <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-slate-50 p-3 text-xs text-slate-700">
                {JSON.stringify(answer.raw, null, 2)}
              </pre>
            ) : null}
            {answer.media.length ? (
              <div className="mt-3 grid gap-3">
                {answer.media.map((media) => (
                  <ResponseMediaPreview
                    key={media.mediaAssetId}
                    surveyId={data.survey.id}
                    responseId={data.response.id}
                    media={media}
                  />
                ))}
              </div>
            ) : null}
          </article>
        ))}
      </section>

      <div className="mt-5">
        <Link className="btn inline-block" to={`/surveys/${data.survey.id}/responses`}>← 返回答卷列表</Link>
      </div>
    </div>
  );
}
