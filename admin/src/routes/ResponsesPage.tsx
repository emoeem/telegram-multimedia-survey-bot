import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { ArrowLeft, FileText, Package, Send, Share2, X } from "lucide-react";
import { useApi } from "../hooks";
import { apiSend, type ReportTemplateOption, type ResponseListData, type ResponseStatus } from "../api";
import { EmptyPanel, ErrorPanel, SkeletonPanel } from "../components/ui";
import { formatDateTime } from "../format";
import { safeCopy } from "../survey/clipboard";

const STATUS_OPTIONS: Array<{ value: "" | ResponseStatus; label: string }> = [
  { value: "", label: "全部状态" },
  { value: "completed", label: "已完成" },
  { value: "in_progress", label: "填写中" },
  { value: "abandoned", label: "已放弃" },
  { value: "cancelled", label: "已取消" },
  { value: "archived", label: "已归档" },
];

function respondentName(item: ResponseListData["items"][number]): string {
  if (!item.respondent) {
    return item.participantKey ? `网页参与 · ${item.participantKey}` : "网页参与（未登录）";
  }
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
  const [exportProgress, setExportProgress] = useState<{ total: number; done: number; failed: number } | null>(null);
  const pollTimerRef = useRef<number | null>(null);
  const pollCancelledRef = useRef(false);
  const templates = useApi<{ templates: ReportTemplateOption[] }>("/api/admin/report-templates");

  useEffect(
    () => () => {
      pollCancelledRef.current = true;
      if (pollTimerRef.current !== null) window.clearTimeout(pollTimerRef.current);
    },
    [],
  );

  const query = new URLSearchParams({
    page: String(page),
    pageSize: "20",
    status,
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  });
  const { data, error, retry } = useApi<ResponseListData>(id ? `/api/admin/surveys/${id}/responses?${query}` : null);

  const reportUrlWithTemplate = (url: string): string => {
    const separator = url.includes("?") ? "&" : "?";
    return templateId ? `${url}${separator}template=${encodeURIComponent(templateId)}` : url;
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
      const ok = await safeCopy(`${window.location.origin}${result.reportUrl}`);
      if (!ok) {
        setActionError("复制失败，请手动选择并复制链接");
        return;
      }
      setMessage(`已复制答卷 #${responseId} 的分享链接（30 天内有效）`);
    } catch (requestError) {
      setActionError(requestError instanceof Error ? requestError.message : "复制链接失败");
    }
  };

  useEffect(() => {
    if (!previewResponseId || !id) return;
    let cancelled = false;
    void (async () => {
      try {
        const url = await loadReportUrl(previewResponseId);
        if (!cancelled) setPreviewUrl(url);
      } catch {
        // keep the previous preview URL
      }
    })();
    return () => {
      cancelled = true;
    };
    // This effect deliberately re-fires only when the user picks a different
    // template. `previewResponseId` / `id` are captured from the closure so
    // the current preview gets rebuilt against the latest template.
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
    const completedIds = data?.items.filter((item) => item.status === "completed").map((item) => item.id) ?? [];
    setSelected((current) => {
      const allSelected = completedIds.length > 0 && completedIds.every((responseId) => current.has(responseId));
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
      const result = await apiSend<{ queued: number }>("POST", `/api/admin/surveys/${id}/responses/batch-export`, {
        responseIds: [...selected],
      });
      setMessage(`已把 ${result.queued} 份答卷的报告加入导出队列，将按顺序发送到私人频道`);
      setSelected(new Set());
      setExportProgress({ total: result.queued, done: 0, failed: 0 });
      pollCancelledRef.current = false;
      pollExportStatus([...selected]);
    } catch (requestError) {
      setActionError(requestError instanceof Error ? requestError.message : "批量导出失败");
    } finally {
      setBusy(false);
    }
  };

  const sendSummaryToChannel = async () => {
    if (!id) return;
    if (!window.confirm("把该问卷全部答卷的汇总表（CSV）发送到报告归档频道？")) return;
    setBusy(true);
    setActionError(null);
    setMessage(null);
    try {
      const result = await apiSend<{ ok: true; rows: number; fileName: string }>(
        "POST",
        `/api/admin/surveys/${id}/responses/send-to-channel`,
        {},
      );
      setMessage(`已把 ${result.rows} 份答卷的汇总表（${result.fileName}）发送到报告频道`);
    } catch (requestError) {
      setActionError(requestError instanceof Error ? requestError.message : "发送汇总表失败");
    } finally {
      setBusy(false);
    }
  };

  const pollExportStatus = async (ids: number[], attempt = 0) => {
    if (!id || pollCancelledRef.current) return;
    if (attempt >= 40) {
      setExportProgress(null);
      setMessage("导出进度查询超时，请到「报告归档」页查看最终状态");
      return;
    }
    try {
      const result = await apiSend<{ counts: Record<string, number>; total: number }>(
        "POST",
        `/api/admin/surveys/${id}/responses/export-status`,
        { ids },
      );
      if (pollCancelledRef.current) return;
      const failed = result.counts.failed ?? 0;
      const done = (result.counts.delivered ?? 0) + failed;
      setExportProgress({ total: result.total, done, failed });
      if (done >= result.total) {
        setExportProgress(null);
        setMessage(
          failed > 0
            ? `批量导出完成：成功 ${result.total - failed} 份，失败 ${failed} 份（见报告归档）`
            : `批量导出完成：${result.total} 份报告已全部发送到私人频道`,
        );
        return;
      }
      pollTimerRef.current = window.setTimeout(() => void pollExportStatus(ids, attempt + 1), 3000);
    } catch {
      if (pollCancelledRef.current) return;
      pollTimerRef.current = window.setTimeout(() => void pollExportStatus(ids, attempt + 1), 3000);
    }
  };

  if (error) return <ErrorPanel error={error} onRetry={retry} />;
  if (!data) return <SkeletonPanel lines={7} />;

  const completedItems = data.items.filter((item) => item.status === "completed");

  return (
    <div className="gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,460px)] lg:items-start">
      <section className="card">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">{data.survey.title}</h2>
            <p className="mt-1 text-sm text-[var(--color-muted)]">
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
            <span className="text-sm text-[var(--color-muted-soft)]">至</span>
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
              className="select"
              value={status}
              onChange={(event) => {
                setStatus(event.target.value as "" | ResponseStatus);
                setPage(1);
              }}
            >
              {STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {message ? (
          <div className="mt-3 rounded-lg bg-[color-mix(in_srgb,var(--color-success)_12%,var(--surface))] p-3 text-sm text-[var(--color-success)]">
            {message}
          </div>
        ) : null}
        {exportProgress ? (
          <div className="mt-3 rounded-lg bg-[color-mix(in_srgb,var(--color-info)_12%,var(--surface))] p-3 text-sm text-[var(--color-info)]">
            导出中：{exportProgress.done}/{exportProgress.total} 份已发送
            {exportProgress.failed > 0 ? `（失败 ${exportProgress.failed}）` : ""}
          </div>
        ) : null}
        {actionError ? (
          <div className="mt-3 rounded-lg bg-[color-mix(in_srgb,var(--color-danger)_10%,var(--surface))] p-3 text-sm text-[var(--color-danger)]">
            {actionError}
          </div>
        ) : null}

        {data.items.length ? (
          <div className="mt-5 overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th className="text-sm text-[var(--color-muted)]">
                    {completedItems.length ? (
                      <input
                        type="checkbox"
                        className="h-4 w-4"
                        checked={completedItems.every((item) => selected.has(item.id))}
                        onChange={toggleSelectAllCompleted}
                      />
                    ) : null}
                  </th>
                  <th className="text-sm text-[var(--color-muted)]">编号</th>
                  <th className="text-sm text-[var(--color-muted)]">填写者</th>
                  <th className="text-sm text-[var(--color-muted)]">状态</th>
                  <th className="text-sm text-[var(--color-muted)]">完成时间</th>
                  <th className="text-sm text-[var(--color-muted)]">操作</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((item) => {
                  const completed = item.status === "completed";
                  return (
                    <tr key={item.id} className="hover:bg-[var(--surface-hover)]">
                      <td className="">
                        {completed ? (
                          <input
                            type="checkbox"
                            className="h-4 w-4"
                            checked={selected.has(item.id)}
                            onChange={() => toggleSelect(item.id)}
                          />
                        ) : null}
                      </td>
                      <td className="text-sm">
                        <Link
                          className="font-semibold text-[var(--color-info)]"
                          to={`/surveys/${data.survey.id}/responses/${item.id}`}
                        >
                          #{item.id}
                        </Link>
                      </td>
                      <td className="text-sm">
                        {item.respondent ? (
                          <Link
                            className="font-medium text-[var(--color-info)] hover:underline"
                            to={`/users?user=${item.respondent.userId}`}
                          >
                            {respondentName(item)}
                          </Link>
                        ) : (
                          respondentName(item)
                        )}
                      </td>
                      <td className="text-sm">{item.statusLabel}</td>
                      <td className="text-sm">{item.completedAt ? formatDateTime(item.completedAt) : "—"}</td>
                      <td className="">
                        <div className="flex flex-wrap gap-2">
                          {completed ? (
                            <>
                              <button
                                className="btn btn-sm hidden lg:inline-flex"
                                disabled={busy}
                                onClick={() => void openReport(item.id)}
                              >
                                <FileText className="h-4 w-4" />
                                报告
                              </button>
                              <button
                                className="btn btn-sm lg:hidden"
                                disabled={busy}
                                onClick={() => void openReportMobile(item.id)}
                              >
                                <FileText className="h-4 w-4" />
                                报告
                              </button>
                              <button className="btn btn-sm" onClick={() => void copyShare(item.id)}>
                                <Share2 className="h-4 w-4" />
                                分享
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
            <Link className="btn" to={`/surveys/${data.survey.id}`}>
              <ArrowLeft className="h-4 w-4" />
              返回问卷
            </Link>
            <button
              className="btn btn-primary"
              disabled={busy || selected.size === 0}
              onClick={() => void batchExport()}
            >
              {busy ? (
                "处理中…"
              ) : (
                <>
                  <Package className="h-4 w-4" />
                  导出到私人频道（{selected.size}）
                </>
              )}
            </button>
            <button className="btn" disabled={busy} onClick={() => void sendSummaryToChannel()}>
              <Send className="h-4 w-4" />
              汇总表发到频道
            </button>
          </div>
          <div className="flex items-center gap-2 text-sm text-[var(--color-muted)]">
            <button
              className="btn btn-sm"
              disabled={page <= 1}
              onClick={() => setPage((value) => Math.max(1, value - 1))}
            >
              上一页
            </button>
            <span>
              第 {data.page}/{Math.max(1, data.totalPages)} 页
            </span>
            <button
              className="btn btn-sm"
              disabled={page >= data.totalPages}
              onClick={() => setPage((value) => value + 1)}
            >
              下一页
            </button>
          </div>
        </div>
      </section>

      {previewUrl ? (
        <section className="hidden card lg:sticky lg:top-4 lg:block">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold">报告预览 #{previewResponseId}</h3>
            <div className="flex items-center gap-2">
              <select
                className="select w-40 text-xs"
                value={templateId}
                onChange={(event) => setTemplateId(event.target.value)}
              >
                <option value="">默认模板</option>
                {templates.data?.templates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}
                  </option>
                ))}
              </select>
              <button
                className="btn btn-sm"
                onClick={() => {
                  setPreviewUrl(null);
                  setPreviewResponseId(null);
                }}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
          <iframe
            title="报告预览"
            className="mt-3 h-[72vh] w-full rounded-lg border border-[var(--color-edge)]"
            src={previewUrl}
          />
        </section>
      ) : null}
    </div>
  );
}
