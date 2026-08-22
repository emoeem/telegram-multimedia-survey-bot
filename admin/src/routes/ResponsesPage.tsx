import { useState } from "react";
import { Link, useParams } from "react-router";
import { useApi } from "../hooks";
import type { ResponseListData, ResponseStatus } from "../api";
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

  if (error) return <ErrorPanel error={error} onRetry={retry} />;
  if (!data) return <SkeletonPanel lines={7} />;

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{data.survey.title}</h2>
          <p className="mt-1 text-sm text-gray-500">共 {data.total} 份答卷{data.survey.anonymous ? " · 匿名问卷" : ""}</p>
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
            {STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </div>
      </div>

      {data.items.length ? (
        <div className="mt-5 overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className="border-b border-gray-100 px-2 py-3 text-left text-sm text-gray-500">编号</th>
                <th className="border-b border-gray-100 px-2 py-3 text-left text-sm text-gray-500">填写者</th>
                <th className="border-b border-gray-100 px-2 py-3 text-left text-sm text-gray-500">状态</th>
                <th className="border-b border-gray-100 px-2 py-3 text-left text-sm text-gray-500">开始时间</th>
                <th className="border-b border-gray-100 px-2 py-3 text-left text-sm text-gray-500">完成时间</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((item) => (
                <tr key={item.id} className="hover:bg-slate-50">
                  <td className="border-b border-gray-100 px-2 py-3.5 text-sm">
                    <Link className="font-semibold text-blue-700" to={`/surveys/${data.survey.id}/responses/${item.id}`}>#{item.id}</Link>
                  </td>
                  <td className="border-b border-gray-100 px-2 py-3.5 text-sm">{respondentName(item, data.survey.anonymous)}</td>
                  <td className="border-b border-gray-100 px-2 py-3.5 text-sm">{item.statusLabel}</td>
                  <td className="border-b border-gray-100 px-2 py-3.5 text-sm">{formatDateTime(item.startedAt)}</td>
                  <td className="border-b border-gray-100 px-2 py-3.5 text-sm">{item.completedAt ? formatDateTime(item.completedAt) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyPanel text={status ? "当前状态下没有答卷" : "还没有答卷"} />
      )}

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <Link className="btn" to={`/surveys/${data.survey.id}`}>← 返回问卷</Link>
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>上一页</button>
          <span>第 {data.page}/{Math.max(1, data.totalPages)} 页</span>
          <button className="btn btn-sm" disabled={page >= data.totalPages} onClick={() => setPage((value) => value + 1)}>下一页</button>
        </div>
      </div>
    </section>
  );
}
