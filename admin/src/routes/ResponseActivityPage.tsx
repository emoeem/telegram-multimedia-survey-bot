import { useState } from "react";
import { Link } from "react-router";
import { Search } from "lucide-react";
import { useApi } from "../hooks";
import type { ResponseActivityData, ResponseStatus } from "../api";
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

  return (
    <section className="card">
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
              className="input mt-1 block w-36"
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
              className="input mt-1 block w-36"
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
              className="input w-52"
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
                  <td className="text-sm">
                    <Link className="hover:underline" to={`/surveys/${item.surveyId}`}>
                      {item.surveyTitle || `问卷 ${item.surveyId}`}
                    </Link>
                  </td>
                  <td className="text-sm">
                    {item.respondent ? (
                      <Link
                        className="font-medium text-[var(--color-info)] hover:underline"
                        to={`/users?user=${item.respondent.userId}`}
                      >
                        {displayRespondent(item)}
                      </Link>
                    ) : (
                      displayRespondent(item)
                    )}
                  </td>
                  <td className="text-sm">{item.statusLabel}</td>
                  <td className="text-sm">
                    {item.status === "completed" ? formatDateTime(item.completedAt) : formatDateTime(item.updatedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyPanel text="没有匹配的答卷" />
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
