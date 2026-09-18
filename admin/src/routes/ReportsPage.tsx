import { useState } from "react";
import { EChart } from "../components/EChart";
import { Link } from "react-router";
import { RefreshCw } from "lucide-react";
import { donutOption } from "../charts";
import { apiSend, type ReportDeliveriesData } from "../api";
import { useApi } from "../hooks";
import { EmptyPanel, ErrorPanel, SkeletonPanel } from "../components/ui";
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
  delivering: { color: "#0284c7", tint: "bg-[color-mix(in_srgb,var(--color-info)_12%,var(--surface))] text-[var(--color-info)]", icon: "⚙️" },
  delivered: { color: "#16a34a", tint: "bg-[color-mix(in_srgb,var(--color-success)_12%,var(--surface))] text-[var(--color-success)]", icon: "✅" },
  failed: { color: "#dc2626", tint: "bg-[color-mix(in_srgb,var(--color-danger)_10%,var(--surface))] text-[var(--color-danger)]", icon: "⚠️" },
};

const ORDER: DeliveryStatus[] = ["pending", "delivering", "delivered", "failed"];

export function ReportsPage() {
  const [status, setStatus] = useState<"" | DeliveryStatus>("");
  const [page, setPage] = useState(1);
  const query = new URLSearchParams({ page: String(page), pageSize: "20", ...(status ? { status } : {}) });
  const { data, error, retry } = useApi<ReportDeliveriesData>(`/api/admin/report-deliveries?${query}`);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const retryDelivery = async (id: number) => {
    setBusyId(id);
    setActionError(null);
    try {
      await apiSend("POST", `/api/admin/report-deliveries/${id}/retry`, {});
      retry();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "重试失败");
    } finally {
      setBusyId(null);
    }
  };

  if (error) return <ErrorPanel error={error} onRetry={retry} />;
  if (!data) return <SkeletonPanel lines={7} />;

  const summary = data.statusSummary;
  const summaryTotal = ORDER.reduce((s, k) => s + summary[k], 0);
  const summaryDonut = summaryTotal > 0 ? donutOption(
    ORDER.filter((k) => summary[k] > 0).map((k) => ({
      name: STATUS_LABEL[k],
      value: summary[k],
      color: STATUS_META[k].color,
    })),
    { radius: ["50%", "75%"], center: ["35%", "50%"] },
  ) : null;

  return (
    <div className="space-y-5">
      <div className="admin-page-intro"><div><h2>报告中心</h2><p>跟踪报告生成、归档与失败任务</p></div></div>
      <section className="card">
      <div className="mb-5 grid gap-4 lg:grid-cols-[1fr_260px] items-start">
        <div className="admin-stat-grid">
          {ORDER.map((k) => {
            const count = summary[k];
            const meta = STATUS_META[k];
            const active = status === k;
            const danger = k === "failed" && count > 0;
            return (
              <button
                key={k}
                className={`rounded-xl border p-4 text-left transition hover:-translate-y-0.5 hover:shadow-md ${
                  active
                    ? "border-[var(--color-primary)] bg-[color-mix(in_srgb,var(--color-primary)_8%,var(--surface))]"
                    : danger
                      ? "border-[color-mix(in_srgb,var(--color-danger)_35%,var(--surface))] bg-[color-mix(in_srgb,var(--color-danger)_10%,var(--surface))]"
                      : "border-[var(--color-edge)] bg-[var(--surface)]"
                }`}
                onClick={() => setStatus(active ? "" : k)}
              >
                <div className="flex items-center gap-2 text-xs">
                  <span className={`grid h-6 w-6 place-items-center rounded-md ${meta.tint}`}>{meta.icon}</span>
                  <span className="text-[var(--color-muted)]">{STATUS_LABEL[k]}</span>
                </div>
                <div className={`mt-1 text-2xl font-bold font-tabular-nums ${danger ? "text-[var(--color-danger)]" : ""}`}>
                  {count}
                </div>
              </button>
            );
          })}
        </div>
        <div className="rounded-xl border border-[var(--color-edge)] p-2">
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
            className="select"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value as typeof status);
              setPage(1);
            }}
          >
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <button className="btn btn-sm" onClick={retry} title="刷新">
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {data.items.length ? (
        <div className="mt-5 overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th className="text-sm text-[var(--color-muted)]">问卷</th>
                <th className="text-sm text-[var(--color-muted)]">答卷</th>
                <th className="text-sm text-[var(--color-muted)]">状态</th>
                <th className="text-sm text-[var(--color-muted)]">尝试</th>
                <th className="text-sm text-[var(--color-muted)]">错误 / 完成时间</th>
                <th className="text-sm text-[var(--color-muted)]">操作</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((item) => (
                <tr key={item.id} className="hover:bg-[var(--surface-hover)]">
                  <td className="text-sm">
                    <Link className="text-[var(--color-info)]" to={`/surveys/${item.surveyId}`}>
                      {item.surveyTitle || `问卷 ${item.surveyId}`}
                    </Link>
                  </td>
                  <td className="text-sm">
                    <Link
                      className="text-[var(--color-info)]"
                      to={`/surveys/${item.surveyId}/responses/${item.responseId}`}
                    >
                      #{item.responseId}
                    </Link>
                  </td>
                  <td className="text-sm">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${
                        item.status === "delivered"
                          ? "bg-[color-mix(in_srgb,var(--color-success)_12%,var(--surface))] text-[var(--color-success)]"
                          : item.status === "failed"
                            ? "bg-[color-mix(in_srgb,var(--color-danger)_10%,var(--surface))] text-[var(--color-danger)]"
                            : "bg-[color-mix(in_srgb,var(--color-warning)_12%,var(--surface))] text-[var(--color-warning)]"
                      }`}
                    >
                      {STATUS_LABEL[item.status as DeliveryStatus] ?? item.status}
                    </span>
                  </td>
                  <td className="text-sm">{item.attempts}</td>
                  <td className="text-sm">
                    {item.status === "failed" ? (
                      <span className="text-[var(--color-danger)]" title={item.lastError ?? ""}>
                        {item.lastError?.slice(0, 80) ?? "未知错误"}
                      </span>
                    ) : item.deliveredAt ? (
                      formatDateTime(item.deliveredAt)
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="text-sm">
                    {item.status === "failed" || item.status === "pending" ? (
                      <button
                        className="btn btn-sm"
                        disabled={busyId === item.id}
                        onClick={() => void retryDelivery(item.id)}
                      >
                        {busyId === item.id ? "重试中…" : "重试"}
                      </button>
                    ) : (
                      <span className="text-[var(--color-muted-soft)]">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyPanel text="没有报告任务" />
      )}

      {actionError ? <p className="mt-3 text-sm text-[var(--color-danger)]">{actionError}</p> : null}

      <div className="mt-5 flex items-center justify-end gap-2 text-sm text-[var(--color-muted)]">
        <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>
          上一页
        </button>
        <span>
          第 {data.page}/{Math.max(1, data.totalPages)} 页
        </span>
        <button className="btn btn-sm" disabled={page >= data.totalPages} onClick={() => setPage((value) => value + 1)}>
          下一页
        </button>
      </div>
    </section>
    </div>
  );
}
