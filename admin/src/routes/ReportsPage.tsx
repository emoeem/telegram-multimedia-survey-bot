import { useState } from "react";
import { Link } from "react-router";
import { apiSend, type ReportDeliveriesData } from "../api";
import { useApi } from "../hooks";
import { EmptyPanel, ErrorPanel, SkeletonPanel } from "../components/ui";
import { formatDateTime } from "../format";

const STATUS_OPTIONS: Array<{ value: "" | "pending" | "delivering" | "delivered" | "failed"; label: string }> = [
  { value: "", label: "全部状态" },
  { value: "pending", label: "待处理" },
  { value: "delivering", label: "生成中" },
  { value: "delivered", label: "已归档" },
  { value: "failed", label: "失败" },
];

const STATUS_LABEL: Record<string, string> = {
  pending: "待处理",
  delivering: "生成中",
  delivered: "已归档",
  failed: "失败",
};

export function ReportsPage() {
  const [status, setStatus] = useState<"" | "pending" | "delivering" | "delivered" | "failed">("");
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

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">报告归档</h2>
          <p className="mt-1 text-sm text-gray-500">共 {data.total} 个归档任务 · Telegram 私人频道交付状态</p>
        </div>
        <select
          className="input"
          value={status}
          onChange={(event) => {
            setStatus(event.target.value as typeof status);
            setPage(1);
          }}
        >
          {STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </div>

      {data.items.length ? (
        <div className="mt-5 overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className="border-b border-gray-100 px-2 py-3 text-left text-sm text-gray-500">问卷</th>
                <th className="border-b border-gray-100 px-2 py-3 text-left text-sm text-gray-500">答卷</th>
                <th className="border-b border-gray-100 px-2 py-3 text-left text-sm text-gray-500">状态</th>
                <th className="border-b border-gray-100 px-2 py-3 text-left text-sm text-gray-500">尝试</th>
                <th className="border-b border-gray-100 px-2 py-3 text-left text-sm text-gray-500">错误 / 完成时间</th>
                <th className="border-b border-gray-100 px-2 py-3 text-left text-sm text-gray-500">操作</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((item) => (
                <tr key={item.id} className="hover:bg-slate-50">
                  <td className="border-b border-gray-100 px-2 py-3.5 text-sm">
                    <Link className="text-blue-700" to={`/surveys/${item.surveyId}`}>{item.surveyTitle || `问卷 ${item.surveyId}`}</Link>
                  </td>
                  <td className="border-b border-gray-100 px-2 py-3.5 text-sm">
                    <Link className="text-blue-700" to={`/surveys/${item.surveyId}/responses/${item.responseId}`}>#{item.responseId}</Link>
                  </td>
                  <td className="border-b border-gray-100 px-2 py-3.5 text-sm">
                    <span className={`rounded-full px-2 py-0.5 text-xs ${
                      item.status === "delivered"
                        ? "bg-green-50 text-green-700"
                        : item.status === "failed"
                          ? "bg-red-50 text-red-600"
                          : "bg-amber-50 text-amber-700"
                    }`}>
                      {STATUS_LABEL[item.status] ?? item.status}
                    </span>
                  </td>
                  <td className="border-b border-gray-100 px-2 py-3.5 text-sm">{item.attempts}</td>
                  <td className="border-b border-gray-100 px-2 py-3.5 text-sm">
                    {item.status === "failed"
                      ? <span className="text-red-600" title={item.lastError ?? ""}>{item.lastError?.slice(0, 80) ?? "未知错误"}</span>
                      : item.deliveredAt ? formatDateTime(item.deliveredAt) : "—"}
                  </td>
                  <td className="border-b border-gray-100 px-2 py-3.5 text-sm">
                    {item.status === "failed" || item.status === "pending" ? (
                      <button className="btn btn-sm" disabled={busyId === item.id} onClick={() => void retryDelivery(item.id)}>
                        {busyId === item.id ? "重试中…" : "重试"}
                      </button>
                    ) : (
                      <span className="text-gray-300">—</span>
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

      {actionError ? <p className="mt-3 text-sm text-red-600">{actionError}</p> : null}

      <div className="mt-5 flex items-center justify-end gap-2 text-sm text-gray-500">
        <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>上一页</button>
        <span>第 {data.page}/{Math.max(1, data.totalPages)} 页</span>
        <button className="btn btn-sm" disabled={page >= data.totalPages} onClick={() => setPage((value) => value + 1)}>下一页</button>
      </div>
    </section>
  );
}
