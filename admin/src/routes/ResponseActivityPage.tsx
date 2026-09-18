import { useState } from "react";
import { EChart } from "../components/EChart";
import { Link } from "react-router";
import { Search } from "lucide-react";
import { donutOption } from "../charts";
import { useApi } from "../hooks";
import type { ResponseActivityData, ResponseStatus } from "../api";
import { EmptyPanel, ErrorPanel, SkeletonPanel } from "../components/ui";
import { formatDateTime } from "../format";

const STATUS_ORDER: ResponseStatus[] = ["completed", "in_progress", "abandoned", "cancelled", "archived"];

const STATUS_OPTIONS: Array<{ value: "" | ResponseStatus; label: string }> = [
  { value: "", label: "全部状态" },
  { value: "completed", label: "已完成" },
  { value: "in_progress", label: "填写中" },
  { value: "abandoned", label: "已放弃" },
  { value: "cancelled", label: "已取消" },
  { value: "archived", label: "已归档" },
];

const STATUS_META: Record<ResponseStatus, { label: string; color: string }> = {
  completed: { label: "已完成", color: "#16a34a" },
  in_progress: { label: "填写中", color: "#0284c7" },
  abandoned: { label: "已放弃", color: "#d97706" },
  cancelled: { label: "已取消", color: "#dc2626" },
  archived: { label: "已归档", color: "#64748b" },
};

function displayRespondent(item: ResponseActivityData["items"][number]): string {
  if (!item.respondent) {
    return item.participantKey ? `网页参与 · ${item.participantKey}` : "网页参与（未登录）";
  }
  const respondent = item.respondent;
  const name = [respondent.firstName, respondent.lastName].filter(Boolean).join(" ");
  return name || (respondent.username ? `@${respondent.username}` : String(respondent.telegramUserId));
}

export function ResponseActivityPage() {
  const [status, setStatus] = useState<"" | ResponseStatus>("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [page, setPage] = useState(1);

  const query = new URLSearchParams({
    page: String(page),
    pageSize: "20",
    status,
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(appliedSearch.trim() ? { search: appliedSearch.trim() } : {}),
  });
  const { data, error, retry } = useApi<ResponseActivityData>(`/api/admin/responses?${query}`);

  if (error) return <ErrorPanel error={error} onRetry={retry} />;
  if (!data) return <SkeletonPanel lines={7} />;

  const summary = data.statusSummary ?? {};
  const summaryTotal = STATUS_ORDER.reduce((s, k) => s + (summary[k] ?? 0), 0);
  const summaryDonut = summaryTotal > 0 ? donutOption(
    STATUS_ORDER.filter((k) => (summary[k] ?? 0) > 0).map((k) => ({
      name: STATUS_META[k].label,
      value: summary[k] ?? 0,
      color: STATUS_META[k].color,
    })),
    { radius: ["48%", "72%"], center: ["35%", "50%"] },
  ) : null;

  return (
    <section className="card">
      <div className="mb-5 grid gap-4 lg:grid-cols-[1fr_220px] items-start">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {STATUS_ORDER.map((k) => {
            const count = summary[k] ?? 0;
            const meta = STATUS_META[k];
            const active = status === k;
            return (
              <button
                key={k}
                className={`rounded-xl border p-3 text-left transition hover:-translate-y-0.5 hover:shadow-md ${
                  active
                    ? "border-[var(--color-primary)] bg-[color-mix(in_srgb,var(--color-primary)_8%,var(--surface))]"
                    : "border-[var(--color-edge)] bg-[var(--surface)]"
                }`}
                onClick={() => setStatus(active ? "" : k)}
              >
                <div className="flex items-center gap-2 text-xs">
                  <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: meta.color }} />
                  <span className="text-[var(--color-muted)]">{meta.label}</span>
                </div>
                <div className="mt-1 text-2xl font-bold font-tabular-nums">{count}</div>
              </button>
            );
          })}
        </div>
        <div className="rounded-xl border border-[var(--color-edge)] p-2">
          {summaryDonut ? (
            <EChart option={summaryDonut} style={{ height: 150 }} opts={{ renderer: "svg" }} />
          ) : (
            <div className="grid h-[150px] place-items-center text-sm text-[var(--color-muted)]">暂无数据</div>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">答卷动态</h2>
          <p className="mt-1 text-sm text-[var(--color-muted)]">共 {data.total} 份答卷 · 按最近提交/更新时间排序</p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <select
            className="input w-auto"
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
          <label className="text-xs text-[var(--color-muted-soft)]">
            开始
            <input
              className="input mt-1 block w-full sm:w-36"
              type="date"
              value={from}
              onChange={(event) => {
                setFrom(event.target.value);
                setPage(1);
              }}
            />
          </label>
          <label className="text-xs text-[var(--color-muted-soft)]">
            结束
            <input
              className="input mt-1 block w-full sm:w-36"
              type="date"
              value={to}
              onChange={(event) => {
                setTo(event.target.value);
                setPage(1);
              }}
            />
          </label>
          <div className="flex gap-2">
            <input
              className="input w-full sm:w-auto sm:flex-1 min-w-0"
              placeholder="问卷 / 用户 / ID / 答卷编号"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  setAppliedSearch(search.trim());
                  setPage(1);
                }
              }}
            />
            <button
              className="btn btn-primary"
              onClick={() => {
                setAppliedSearch(search.trim());
                setPage(1);
              }}
            >
              <Search className="h-4 w-4" />
              搜索
            </button>
          </div>
        </div>
      </div>

      {data.items.length ? (
        <div className="mt-5 overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th className="text-sm text-[var(--color-muted)]">答卷</th>
                <th className="text-sm text-[var(--color-muted)]">问卷</th>
                <th className="text-sm text-[var(--color-muted)]">填写者</th>
                <th className="text-sm text-[var(--color-muted)]">状态</th>
                <th className="text-sm text-[var(--color-muted)]">时间</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((item) => (
                <tr key={item.id} className="hover:bg-[var(--surface-hover)]">
                  <td className="text-sm">
                    <Link
                      className="font-semibold text-[var(--color-info)]"
                      to={`/surveys/${item.surveyId}/responses/${item.id}`}
                    >
                      #{item.id}
                    </Link>
                  </td>
                  <td className="text-sm">{item.surveyTitle || `问卷 ${item.surveyId}`}</td>
                  <td className="text-sm">{displayRespondent(item)}</td>
                  <td className="text-sm">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${
                        item.status === "completed"
                          ? "bg-[color-mix(in_srgb,var(--color-success)_12%,var(--surface))] text-[var(--color-success)]"
                          : item.status === "in_progress"
                            ? "bg-[color-mix(in_srgb,var(--color-info)_12%,var(--surface))] text-[var(--color-info)]"
                            : item.status === "abandoned"
                              ? "bg-[color-mix(in_srgb,var(--color-warning)_12%,var(--surface))] text-[var(--color-warning)]"
                              : item.status === "cancelled"
                                ? "bg-[color-mix(in_srgb,var(--color-danger)_10%,var(--surface))] text-[var(--color-danger)]"
                                : "bg-[var(--surface-muted)] text-[var(--color-muted)]"
                      }`}
                    >
                      {item.statusLabel}
                    </span>
                  </td>
                  <td className="text-sm">{formatDateTime(item.completedAt ?? item.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyPanel text="没有符合条件的答卷" />
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
