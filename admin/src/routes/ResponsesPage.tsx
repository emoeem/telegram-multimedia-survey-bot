import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { useApi } from "../hooks";
import {
  apiSend,
  type ReportTemplateOption,
  type ResponseListData,
  type ResponseStatus,
} from "../api";
import { EmptyPanel, ErrorPanel, SkeletonPanel } from "../components/ui";
import { formatDateTime } from "../format";

const STATUS_OPTIONS: Array<{ value: "" | ResponseStatus; label: string }> = [
  { value: "", label: "全部状态" },
  { value: "completed", label: "已完成" },
  { value: "in_progress", label: "填写中" },
  { value: "abandoned", label: "已放弃" },
  { value: "cancelled", label: "已取消" },
  { value: "archived", label: "已归档" },
];

function respondentName(item: ResponseListData["items"][number], anonymous: boolean): string {
  if (anonymous || !item.respondent) return "匿名用户";
  const name = [item.respondent.firstName, item.respondent.lastName].filter(Boolean).join(" ");
  return name || (item.respondent.username ? `@${item.respondent.username}` : String(item.respondent.telegramUserId));
}

export function ResponsesPage() {
  const { id } = useParams<{ id: string }>();
  const [status, setStatus] = useState<"" | ResponseStatus>("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [previewResponseId, setPreviewResponseId] = useState<number | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const templates = useApi<{ templates: ReportTemplateOption[] }>("/api/admin/report-templates");

  const query = new URLSearchParams({
    page: String(page),
    pageSize: "20",
    status,
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  });
  const { data, error, retry } = useApi<ResponseListData>(
    id ? `/api/admin/surveys/${id}/responses?${query}` : null,
  );

  const reportUrlWithTemplate = (url: string): string => {
    const separator = url.includes("?") ? "&" : "?";
    return templateId
      ? `${url}${separator}template=${encodeURIComponent(templateId)}`
      : url;
  };

  const loadReportUrl = async (responseId: number): Promise<string> => {
    const result = await apiSend<{ reportUrl: string }>(
      "POST",
      `/api/admin/surveys/${id}/responses/${responseId}/report-link`,
      {},
    );
    return reportUrlWithTemplate(result.reportUrl);
  };

  const openReport = async (responseId: number) => {
    setBusy(true);
    setActionError(null);
    try {
      const url = await loadReportUrl(responseId);
      setPreviewResponseId(responseId);
      setPreviewUrl(url);
    } catch (requestError) {
      setActionError(requestError instanceof Error ? requestError.message : "打开报告失败");
    } finally {
      setBusy(false);
    }
  };

  const openReportMobile = async (responseId: number) => {
    setActionError(null);
    try {
      window.open(await loadReportUrl(responseId), "_blank");
    } catch (requestError) {
      setActionError(requestError instanceof Error ? requestError.message : "打开报告失败");
    }
  };

  const copyShare = async (responseId: number) => {
    setActionError(null);
    try {
      const result = await apiSend<{ reportUrl: string }>(
        "POST",
        `/api/admin/surveys/${id}/responses/${responseId}/report-link`,
        {},
      );
      await navigator.clipboard.writeText(`${window.location.origin}${result.reportUrl}`);
      setMessage(`已复制答卷 #${responseId} 的分享链接（30 天内有效）`);
    } catch (requestError) {
      setActionError(requestError instanceof Error ? requestError.message : "复制链接失败");
    }
  };

  useEffect(() => {
    if (!previewResponseId || !id) return;
    void (async () => {
      try {
        setPreviewUrl(await loadReportUrl(previewResponseId));
      } catch {
        // keep the previous preview URL
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId]);

  const toggleSelect = (responseId: number) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(responseId)) next.delete(responseId);
      else next.add(responseId);
      return next;
    });
  };

  const toggleSelectAllCompleted = () => {
    const completedIds =
      data?.items.filter((item) => item.status === "completed").map((item) => item.id) ?? [];
    setSelected((current) => {
      const allSelected =
        completedIds.length > 0 && completedIds.every((responseId) => current.has(responseId));
      const next = new Set(current);
      if (allSelected) completedIds.forEach((responseId) => next.delete(responseId));
      else completedIds.forEach((responseId) => next.add(responseId));
      return next;
    });
  };

  const batchExport = async () => {
    if (!selected.size || !id) return;
    setBusy(true);
    setActionError(null);
    setMessage(null);
    try {
      const result = await apiSend<{ queued: number }>(
        "POST",
        `/api/admin/surveys/${id}/responses/batch-export`,
        { responseIds: [...selected] },
      );
      setMessage(`已把 ${result.queued} 份答卷的报告加入导出队列，将按顺序发送到私人频道`);
      setSelected(new Set());
    } catch (requestError) {
      setActionError(requestError instanceof Error ? requestError.message : "批量导出失败");
    } finally {
      setBusy(false);
    }
  };

  if (error) return <ErrorPanel error={error} onRetry={retry} />;
  if (!data) return <SkeletonPanel lines={7} />;

  const completedItems = data.items.filter((item) => item.status === "completed");

  return (
    <div className="gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,460px)] lg:items-start">
      <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">{data.survey.title}</h2>
            <p className="mt-1 text-sm text-gray-500">
              共 {data.total} 份答卷{data.survey.anonymous ? " · 匿名问卷" : ""}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              className="input"
              type="date"
              value={from}
              onChange={(event) => {
                setFrom(event.target.value);
                setPage(1);
              }}
            />
            <span className="text-sm text-gray-400">至</span>
            <input
              className="input"
              type="date"
              value={to}
              onChange={(event) => {
                setTo(event.target.value);
                setPage(1);
              }}
            />
            <select
              className="input"
              value={status}
              onChange={(event) => {
                setStatus(event.target.value as "" | ResponseStatus);
                setPage(1);
              }}
            >
              {STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>
        </div>

        {message ? <div className="mt-3 rounded-lg bg-green-50 p-3 text-sm text-green-700">{message}</div> : null}
        {actionError ? <div className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-700">{actionError}</div> : null}

        {data.items.length ? (
          <div className="mt-5 overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className="border-b border-gray-100 px-2 py-3 text-left text-sm text-gray-500">
                    {completedItems.length ? (
                      <input
                        type="checkbox"
                        className="h-4 w-4"
                        checked={completedItems.every((item) => selected.has(item.id))}
                        onChange={toggleSelectAllCompleted}
                      />
                    ) : null}
                  </th>
                  <th className="border-b border-gray-100 px-2 py-3 text-left text-sm text-gray-500">编号</th>
                  <th className="border-b border-gray-100 px-2 py-3 text-left text-sm text-gray-500">填写者</th>
                  <th className="border-b border-gray-100 px-2 py-3 text-left text-sm text-gray-500">状态</th>
                  <th className="border-b border-gray-100 px-2 py-3 text-left text-sm text-gray-500">完成时间</th>
                  <th className="border-b border-gray-100 px-2 py-3 text-left text-sm text-gray-500">操作</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((item) => {
                  const completed = item.status === "completed";
                  return (
                    <tr key={item.id} className="hover:bg-slate-50">
                      <td className="border-b border-gray-100 px-2 py-3.5">
                        {completed ? (
                          <input
                            type="checkbox"
                            className="h-4 w-4"
                            checked={selected.has(item.id)}
                            onChange={() => toggleSelect(item.id)}
                          />
                        ) : null}
                      </td>
                      <td className="border-b border-gray-100 px-2 py-3.5 text-sm">
                        <Link className="font-semibold text-blue-700" to={`/surveys/${data.survey.id}/responses/${item.id}`}>#{item.id}</Link>
                      </td>
                      <td className="border-b border-gray-100 px-2 py-3.5 text-sm">{respondentName(item, data.survey.anonymous)}</td>
                      <td className="border-b border-gray-100 px-2 py-3.5 text-sm">{item.statusLabel}</td>
                      <td className="border-b border-gray-100 px-2 py-3.5 text-sm">{item.completedAt ? formatDateTime(item.completedAt) : "—"}</td>
                      <td className="border-b border-gray-100 px-2 py-3.5">
                        <div className="flex flex-wrap gap-2">
                          {completed ? (
                            <>
                              <button
                                className="btn btn-sm hidden lg:inline-flex"
                                disabled={busy}
                                onClick={() => void openReport(item.id)}
                              >
                                📄 报告
                              </button>
                              <button
                                className="btn btn-sm lg:hidden"
                                disabled={busy}
                                onClick={() => void openReportMobile(item.id)}
                              >
                                📄 报告
                              </button>
                              <button className="btn btn-sm" onClick={() => void copyShare(item.id)}>
                                🔗 分享
                              </button>
                            </>
                          ) : null}
                          <Link className="btn btn-sm" to={`/surveys/${data.survey.id}/responses/${item.id}`}>
                            详情
                          </Link>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyPanel text={status ? "当前状态下没有答卷" : "还没有答卷"} />
        )}

        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Link className="btn" to={`/surveys/${data.survey.id}`}>← 返回问卷</Link>
            <button
              className="btn btn-primary"
              disabled={busy || selected.size === 0}
              onClick={() => void batchExport()}
            >
              {busy ? "处理中…" : `📦 导出到私人频道（${selected.size}）`}
            </button>
          </div>
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>上一页</button>
            <span>第 {data.page}/{Math.max(1, data.totalPages)} 页</span>
            <button className="btn btn-sm" disabled={page >= data.totalPages} onClick={() => setPage((value) => value + 1)}>下一页</button>
          </div>
        </div>
      </section>

      {previewUrl ? (
        <section className="hidden rounded-xl border border-gray-200 bg-white p-4 shadow-sm lg:sticky lg:top-4 lg:block">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold">报告预览 #{previewResponseId}</h3>
            <div className="flex items-center gap-2">
              <select
                className="input w-40 text-xs"
                value={templateId}
                onChange={(event) => setTemplateId(event.target.value)}
              >
                <option value="">默认模板</option>
                {templates.data?.templates.map((template) => (
                  <option key={template.id} value={template.id}>{template.name}</option>
                ))}
              </select>
              <button
                className="btn btn-sm"
                onClick={() => {
                  setPreviewUrl(null);
                  setPreviewResponseId(null);
                }}
              >
                ✕
              </button>
            </div>
          </div>
          <iframe
            title="报告预览"
            className="mt-3 h-[72vh] w-full rounded-lg border border-gray-200"
            src={previewUrl}
          />
        </section>
      ) : null}
    </div>
  );
}
