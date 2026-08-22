import { useState } from "react";
import { Link, useParams } from "react-router";
import { apiSend } from "../api";
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
        <div className="mt-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
          <div><span className="text-gray-500">开始：</span>{formatDateTime(data.response.startedAt)}</div>
          <div><span className="text-gray-500">完成：</span>{data.response.completedAt ? formatDateTime(data.response.completedAt) : "—"}</div>
          <div><span className="text-gray-500">更新：</span>{formatDateTime(data.response.updatedAt)}</div>
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
        {data.response.status === "completed" ? (
          <button
            className="btn"
            disabled={busy}
            onClick={() => void runAction(`/api/admin/surveys/${data.survey.id}/responses/${data.response.id}/report`)}
          >
            🔄 重新生成报告
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
