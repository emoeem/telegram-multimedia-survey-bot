import { useState } from "react";
import { useApi } from "../hooks";
import { EmptyPanel, ErrorPanel, SkeletonPanel } from "../components/ui";
import { formatDateTime } from "../format";

interface AuditItem {
  id: number;
  actorName: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  after: unknown;
  createdAt: string;
}

interface AuditListData {
  items: AuditItem[];
  page: number;
  total: number;
  totalPages: number;
}

function summarize(after: unknown): string {
  if (after === null || after === undefined) return "";
  if (typeof after === "string") return after;
  if (Array.isArray(after)) return after.join("、");
  if (typeof after === "object") {
    const record = after as Record<string, unknown>;
    const entries = Object.entries(record).filter(([, value]) => value !== null && value !== undefined);
    return entries
      .map(([key, value]) => `${key}: ${String(value)}`)
      .join(" · ")
      .slice(0, 80);
  }
  return String(after).slice(0, 80);
}

export function AuditPage() {
  const [page, setPage] = useState(1);
  const [entityType, setEntityType] = useState("");
  const query = new URLSearchParams({
    page: String(page),
    pageSize: "50",
    ...(entityType ? { entityType } : {}),
  });
  const { data, error, retry } = useApi<AuditListData>(`/api/admin/audit-logs?${query}`);

  if (error) return <ErrorPanel error={error} onRetry={retry} />;
  if (!data) return <SkeletonPanel lines={8} />;

  return (
    <section className="card">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">审计日志</h2>
          <p className="mt-1 text-sm text-[var(--color-muted)]">共 {data.total} 条操作记录</p>
        </div>
        <select
          className="select"
          value={entityType}
          onChange={(event) => {
            setEntityType(event.target.value);
            setPage(1);
          }}
        >
          <option value="">全部对象</option>
          {["survey", "response", "report_template", "report_delivery", "settings", "user", "media"].map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
      </div>

      {data.items.length ? (
        <div className="mt-5 overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th className="text-sm text-[var(--color-muted)]">时间</th>
                <th className="text-sm text-[var(--color-muted)]">执行者</th>
                <th className="text-sm text-[var(--color-muted)]">操作</th>
                <th className="text-sm text-[var(--color-muted)]">对象</th>
                <th className="text-sm text-[var(--color-muted)]">变更摘要</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((item) => (
                <tr key={item.id} className="hover:bg-[var(--surface-hover)]">
                  <td className="text-sm">{formatDateTime(item.createdAt)}</td>
                  <td className="text-sm">{item.actorName ?? "系统"}</td>
                  <td className="text-sm font-medium">{item.action}</td>
                  <td className="text-sm text-[var(--text-soft)]">
                    {item.entityType}
                    {item.entityId ? ` #${item.entityId}` : ""}
                  </td>
                  <td className="max-w-72 text-sm text-[var(--color-muted)]">{summarize(item.after) || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyPanel text="没有审计记录" />
      )}

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
  );
}
