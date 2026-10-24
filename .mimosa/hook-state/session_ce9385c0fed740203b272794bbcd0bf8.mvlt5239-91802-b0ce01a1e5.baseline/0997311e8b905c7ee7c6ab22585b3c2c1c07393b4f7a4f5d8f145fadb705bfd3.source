import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EChart } from "../components/EChart";
import { Link, useSearchParams } from "react-router";
import { FilterX, RefreshCw } from "lucide-react";
import { donutOption } from "../charts";
import { apiSend, type ReportDeliveriesData, type ReportDeliveryItem } from "../api";
import { useApi } from "../hooks";
import { EmptyPanel, ErrorPanel, SkeletonPanel } from "../components/ui";
import { StatCard } from "../components/StatCard";
import { useDialogs } from "../components/Dialogs";
import { formatDateTime } from "../format";

type DeliveryStatus = "pending" | "delivering" | "delivered" | "failed";

const STATUS_OPTIONS: Array<{ value: "" | DeliveryStatus; label: string }> = [
  { value: "", label: "全部状态" },
  { value: "pending", label: "待处理" },
  { value: "delivering", label: "生成中" },
  { value: "delivered", label: "已归档" },
  { value: "failed", label: "失败" },
];

const STATUS_LABEL: Record<DeliveryStatus, string> = {
  pending: "待处理",
  delivering: "生成中",
  delivered: "已归档",
  failed: "失败",
};

const STATUS_META: Record<DeliveryStatus, { color: string; tint: string; icon: string }> = {
  pending: { color: "#94a3b8", tint: "bg-[var(--surface-muted)] text-[var(--color-muted)]", icon: "⏳" },
  delivering: {
    color: "#0284c7",
    tint: "bg-[color-mix(in_srgb,var(--app-info)_12%,var(--surface))] text-[var(--app-info)]",
    icon: "⚙️",
  },
  delivered: {
    color: "#16a34a",
    tint: "bg-[color-mix(in_srgb,var(--app-success)_12%,var(--surface))] text-[var(--app-success)]",
    icon: "✅",
  },
  failed: {
    color: "#dc2626",
    tint: "bg-[color-mix(in_srgb,var(--app-danger)_10%,var(--surface))] text-[var(--app-danger)]",
    icon: "⚠️",
  },
};

const ORDER: DeliveryStatus[] = ["pending", "delivering", "delivered", "failed"];

/** The worker reclaims a `delivering` row after this long (report-delivery.service). */
const STALE_MINUTES = 10;

function minutesSince(iso: string): number {
  const at = new Date(iso).getTime();
  if (!Number.isFinite(at)) return 0;
  // A negative value means the row's clock is ahead of ours; clamp instead of
  // rendering "-3 分钟".
  return Math.max(0, Math.round((Date.now() - at) / 60000));
}

export function ReportsPage() {
  const { confirm, toast } = useDialogs();
  const [searchParams, setSearchParams] = useSearchParams();
  const rawStatus = searchParams.get("status");
  const statusParam: "" | DeliveryStatus =
    rawStatus === "pending" || rawStatus === "delivering" || rawStatus === "delivered" || rawStatus === "failed"
      ? rawStatus
      : "";
  const [status, setStatus] = useState<"" | DeliveryStatus>(statusParam);
  const [page, setPage] = useState(1);

  /* The dashboard links here with `?status=`, so the URL is an input. It also
     has to stay an output: clearing a filter used to change the list while the
     address bar kept `?status=failed`, so a refresh silently restored the
     filter and the URL no longer described what was on screen. */
  useEffect(() => {
    setStatus(statusParam);
    setPage(1);
  }, [statusParam]);

  const applyStatus = useCallback(
    (next: "" | DeliveryStatus) => {
      setStatus(next);
      setPage(1);
      setSearchParams(next ? { status: next } : {}, { replace: true });
    },
    [setSearchParams],
  );
  const query = new URLSearchParams({ page: String(page), pageSize: "20", ...(status ? { status } : {}) });
  const { data, error, retry } = useApi<ReportDeliveriesData>(`/api/admin/report-deliveries?${query}`);
  const [busyIds, setBusyIds] = useState<Set<number>>(() => new Set());
  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const selectAllRef = useRef<HTMLInputElement>(null);

  const pageIds = useMemo(() => (data ? data.items.map((item) => item.id) : []), [data]);
  const allSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const someSelected = selected.size > 0 && !allSelected;

  // Selection is per page: keeping ids across pages would let "批量重试" hit
  // rows the user can no longer see. Reset whenever the visible window changes.
  useEffect(() => {
    setSelected(new Set());
  }, [page, status]);

  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someSelected;
  }, [someSelected]);

  const markBusy = useCallback((id: number, busy: boolean) => {
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  /**
   * Retries run one at a time on purpose. The endpoint enqueues a Telegram
   * delivery per call, and 20 concurrent hits would trade a slow list for a
   * burst of FLOOD_WAITs. Per-row progress is shown instead.
   */
  const retryMany = useCallback(
    async (ids: number[]) => {
      if (!ids.length) return;
      setBatch({ done: 0, total: ids.length });
      const failures: string[] = [];
      for (const [index, id] of ids.entries()) {
        markBusy(id, true);
        try {
          await apiSend("POST", `/api/admin/report-deliveries/${id}/retry`, {});
        } catch (err) {
          failures.push(`#${id} ${err instanceof Error ? err.message : "重试失败"}`);
        } finally {
          markBusy(id, false);
        }
        setBatch({ done: index + 1, total: ids.length });
      }
      setBatch(null);
      setSelected(new Set());
      retry();
      const ok = ids.length - failures.length;
      if (failures.length) {
        toast({
          variant: "error",
          message: `${ok} 个已提交重试，${failures.length} 个失败：${failures[0]}`,
          durationMs: 6000,
        });
      } else {
        toast({ variant: "success", message: `已提交 ${ok} 个任务重试` });
      }
    },
    [markBusy, retry, toast],
  );

  /** A `delivering` row may still be running, so forcing it asks first. */
  const forceRetry = useCallback(
    async (item: ReportDeliveryItem) => {
      const waited = minutesSince(item.updatedAt);
      const definitelyStuck = waited >= STALE_MINUTES;
      const ok = await confirm({
        title: "强制重试生成中的任务？",
        message: definitelyStuck
          ? `该任务已停留在「生成中」${waited} 分钟，服务端会在 10 分钟后自动回收。现在强制重试会立即重新排队，可能产生重复的归档消息。`
          : `该任务进入「生成中」仅 ${waited} 分钟，可能仍在生成。强制重试会立即重新排队，可能产生重复的归档消息。`,
        confirmLabel: "强制重试",
        cancelLabel: "再等等",
        variant: "danger",
      });
      if (!ok) return;
      await retryMany([item.id]);
    },
    [confirm, retryMany],
  );

  if (error) return <ErrorPanel error={error} onRetry={retry} />;
  if (!data) return <SkeletonPanel lines={7} />;

  const summary = data.statusSummary;
  const summaryTotal = ORDER.reduce((s, k) => s + summary[k], 0);
  const summaryDonut =
    summaryTotal > 0
      ? donutOption(
          ORDER.filter((k) => summary[k] > 0).map((k) => ({
            name: STATUS_LABEL[k],
            value: summary[k],
            color: STATUS_META[k].color,
          })),
          { radius: ["50%", "75%"], center: ["35%", "50%"] },
        )
      : null;

  const toggleOne = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected((prev) => {
      if (pageIds.every((id) => prev.has(id))) return new Set();
      return new Set(pageIds);
    });
  };

  const retryableIds = data.items
    .filter((item) => item.status === "failed" || item.status === "pending")
    .map((item) => item.id);

  return (
    <div className="report-page space-y-5">
      <div className="admin-page-intro">
        <div>
          <h2>报告中心</h2>
          <p>跟踪报告生成、归档与失败任务</p>
        </div>
      </div>
      <section className="card">
        <div className="mb-5 grid gap-4 lg:grid-cols-[1fr_260px] items-start">
          <div className="admin-stat-grid" data-cols="4">
            {ORDER.map((k) => {
              const count = summary[k];
              const meta = STATUS_META[k];
              const active = status === k;
              return (
                <StatCard
                  key={k}
                  label={STATUS_LABEL[k]}
                  value={count}
                  icon={<span className="text-sm leading-none">{meta.icon}</span>}
                  tint={meta.tint}
                  tone={k === "failed" && count > 0 ? "danger" : "default"}
                  active={active}
                  onClick={() => applyStatus(active ? "" : k)}
                  ariaLabel={`筛选 ${STATUS_LABEL[k]}，共 ${count} 个`}
                />
              );
            })}
          </div>
          <div className="rounded-surface border border-[var(--color-edge)] p-2">
            {summaryDonut ? (
              <EChart option={summaryDonut} style={{ height: 180 }} opts={{ renderer: "svg" }} />
            ) : (
              <div className="grid h-[180px] place-items-center text-sm text-[var(--color-muted)]">暂无报告</div>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">报告归档</h2>
            <p className="mt-1 text-sm text-[var(--color-muted)]">
              共 {data.total} 个归档任务 · Telegram 私人频道交付状态
            </p>
          </div>
          <div className="flex items-center gap-2">
            <select
              aria-label="报告状态筛选"
              className="select select-sm"
              value={status}
              onChange={(event) => applyStatus(event.target.value as typeof status)}
            >
              {STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <button className="btn btn-sm" onClick={retry} title="刷新列表" aria-label="刷新列表">
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
            {/* The select-all checkbox lives in `<thead>`, which the card layout
                hides below 640px — so on a phone there was no way to select the
                page at all. This is the same action, in reach. */}
            <button className="btn btn-sm sm:hidden" onClick={toggleAll}>
              {allSelected ? "取消全选" : "全选本页"}
            </button>
          </div>
        </div>

        {selected.size > 0 ? (
          <div className="mt-4 flex flex-wrap items-center gap-2 rounded-control border border-[color-mix(in_srgb,var(--color-primary)_30%,var(--color-edge))] bg-[color-mix(in_srgb,var(--color-primary)_6%,var(--surface))] px-3 py-2">
            <span className="text-sm font-semibold">已选 {selected.size} 项</span>
            <button
              className="btn btn-sm btn-primary"
              disabled={batch !== null}
              onClick={() => void retryMany([...selected])}
            >
              {batch ? `重试中 ${batch.done}/${batch.total}` : "批量重试"}
            </button>
            <button className="btn btn-sm btn-ghost" disabled={batch !== null} onClick={() => setSelected(new Set())}>
              取消选择
            </button>
          </div>
        ) : null}

        {data.items.length ? (
          <div className="mt-5 overflow-x-auto" tabIndex={0} aria-label="报告归档列表">
            <table className="tbl">
              <thead>
                <tr>
                  <th className="w-10">
                    <label className="hit-target" title="选择本页全部">
                      <input
                        ref={selectAllRef}
                        type="checkbox"
                        className="row-check"
                        checked={allSelected}
                        onChange={toggleAll}
                        aria-label={allSelected ? "取消选择本页全部任务" : "选择本页全部任务"}
                      />
                    </label>
                  </th>
                  <th className="text-sm text-[var(--color-muted)]">问卷</th>
                  <th className="text-sm text-[var(--color-muted)]">答卷</th>
                  <th className="text-sm text-[var(--color-muted)]">状态</th>
                  <th className="text-sm text-[var(--color-muted)]">尝试</th>
                  <th className="text-sm text-[var(--color-muted)]">错误 / 完成时间</th>
                  <th className="text-sm text-[var(--color-muted)]">操作</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((item) => {
                  const busy = busyIds.has(item.id);
                  const waited = item.status === "delivering" ? minutesSince(item.updatedAt) : 0;
                  return (
                    <tr key={item.id} className="hover:bg-[var(--surface-hover)]">
                      <td className="w-10" data-label="">
                        <label className="hit-target" title="选择该任务">
                          <input
                            type="checkbox"
                            className="row-check"
                            checked={selected.has(item.id)}
                            onChange={() => toggleOne(item.id)}
                            aria-label={`选择任务 ${item.deliveryId}`}
                          />
                        </label>
                      </td>
                      <td className="text-sm" data-label="问卷">
                        <Link className="text-[var(--app-info)]" to={`/surveys/${item.surveyId}`}>
                          {item.surveyTitle || `问卷 ${item.surveyId}`}
                        </Link>
                      </td>
                      <td className="text-sm" data-label="答卷">
                        <Link
                          className="text-[var(--app-info)]"
                          to={`/surveys/${item.surveyId}/responses/${item.responseId}`}
                        >
                          #{item.responseId}
                        </Link>
                      </td>
                      <td className="text-sm" data-label="状态">
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs ${
                            item.status === "delivered"
                              ? "bg-[color-mix(in_srgb,var(--app-success)_12%,var(--surface))] text-[var(--app-success)]"
                              : item.status === "failed"
                                ? "bg-[color-mix(in_srgb,var(--app-danger)_10%,var(--surface))] text-[var(--app-danger)]"
                                : "bg-[color-mix(in_srgb,var(--app-warning)_12%,var(--surface))] text-[var(--app-warning)]"
                          }`}
                        >
                          {STATUS_LABEL[item.status] ?? item.status}
                        </span>
                        {item.status === "delivering" ? (
                          <span
                            className={`ml-2 text-xs ${
                              waited >= STALE_MINUTES ? "text-[var(--app-warning)]" : "text-[var(--color-muted)]"
                            }`}
                          >
                            {waited >= STALE_MINUTES ? `已卡 ${waited} 分钟` : `已 ${waited} 分钟`}
                          </span>
                        ) : null}
                      </td>
                      <td className="text-sm" data-label="尝试">
                        {item.attempts}
                      </td>
                      <td className="text-sm" data-label="错误 / 完成时间">
                        {item.status === "failed" ? (
                          <span className="text-[var(--app-danger)]" title={item.lastError ?? ""}>
                            {item.lastError?.slice(0, 80) ?? "未知错误"}
                          </span>
                        ) : item.deliveredAt ? (
                          formatDateTime(item.deliveredAt)
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="text-sm" data-label="操作">
                        {item.status === "failed" || item.status === "pending" ? (
                          <button className="btn btn-sm" disabled={busy} onClick={() => void retryMany([item.id])}>
                            {busy ? "重试中…" : "重试"}
                          </button>
                        ) : item.status === "delivering" ? (
                          <button
                            className="btn btn-sm btn-danger"
                            disabled={busy}
                            onClick={() => void forceRetry(item)}
                          >
                            {busy ? "重试中…" : "强制重试"}
                          </button>
                        ) : (
                          <span className="text-[var(--color-muted-soft)]">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : status ? (
          <div className="mt-5">
            <EmptyPanel
              icon={<FilterX className="h-6 w-6" />}
              text={`当前筛选「${STATUS_LABEL[status]}」下没有任务`}
              actionLabel="清除筛选"
              onAction={() => applyStatus("")}
            />
          </div>
        ) : (
          <div className="mt-5">
            <EmptyPanel text="还没有报告任务。发布问卷并收到答卷后，这里会出现归档任务。" />
          </div>
        )}

        {data.items.length && retryableIds.length > 1 ? (
          <p className="mt-3 text-xs text-[var(--color-muted)]">
            本页有 {retryableIds.length} 个待处理或失败任务，可勾选后批量重试。
          </p>
        ) : null}

        <div className="mt-5 flex items-center justify-end gap-2 text-sm text-[var(--color-muted)]">
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
      </section>
    </div>
  );
}
