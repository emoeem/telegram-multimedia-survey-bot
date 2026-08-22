import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useApi } from "../hooks";
import { apiSend, type SurveyListData, type SurveyStatus, type WriteResult } from "../api";
import { EmptyPanel, ErrorPanel, SkeletonPanel, StatusBadge } from "../components/ui";
import { STATUS_LABELS, formatDateTime } from "../format";

const SEARCH_DEBOUNCE_MS = 300;
const STATUS_OPTIONS: SurveyStatus[] = ["draft", "published", "closed", "archived"];

export function SurveysPage() {
  const navigate = useNavigate();
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const query = new URLSearchParams({ search, status });
  const { data, error, retry } = useApi<SurveyListData>(`/api/admin/surveys?${query}`);

  const hasFilters = searchInput.trim() !== "" || status !== "";
  const clearFilters = () => {
    setSearchInput("");
    setStatus("");
  };

  const createSurvey = async () => {
    if (creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const result = await apiSend<WriteResult>("POST", "/api/admin/surveys", { title: "未命名问卷" });
      if (typeof result.id === "number") navigate(`/surveys/${result.id}/editor`);
    } catch (requestError) {
      setCreateError(requestError instanceof Error ? requestError.message : "创建失败");
      setCreating(false);
    }
  };

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
      <div className="mb-4 flex flex-wrap gap-3">
        <input
          type="text"
          className="w-full min-w-0 flex-1 rounded-lg border border-gray-300 bg-white px-3 py-2.5 sm:min-w-44"
          placeholder="搜索问卷…"
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
        />
        <select
          className="rounded-lg border border-gray-300 bg-white px-3 py-2.5 sm:flex-none"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          <option value="">全部状态</option>
          {STATUS_OPTIONS.map((value) => (
            <option key={value} value={value}>
              {STATUS_LABELS[value]}
            </option>
          ))}
        </select>
        <button className="btn sm:flex-none" disabled={creating} onClick={createSurvey}>
          {creating ? "创建中…" : "＋ 新建问卷"}
        </button>
      </div>
      {createError ? <div className="mb-3 text-sm text-red-600">新建失败：{createError}</div> : null}

      {error ? (
        <ErrorPanel error={error} onRetry={retry} />
      ) : !data ? (
        <SkeletonPanel lines={5} />
      ) : data.items.length ? (
        <>
          <div className="hidden overflow-x-auto sm:block">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className="border-b border-gray-100 px-2 py-3 text-left text-sm font-semibold text-gray-500">标题</th>
                  <th className="border-b border-gray-100 px-2 py-3 text-left text-sm font-semibold text-gray-500">状态</th>
                  <th className="border-b border-gray-100 px-2 py-3 text-left text-sm font-semibold text-gray-500">题目</th>
                  <th className="border-b border-gray-100 px-2 py-3 text-left text-sm font-semibold text-gray-500">答卷</th>
                  <th className="border-b border-gray-100 px-2 py-3 text-left text-sm font-semibold text-gray-500">更新时间</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((item) => (
                  <tr key={item.id} className="cursor-pointer hover:bg-slate-50" onClick={() => navigate(`/surveys/${item.id}`)}>
                    <td className="border-b border-gray-100 px-2 py-3.5 text-sm">
                      <Link to={`/surveys/${item.id}`} className="font-semibold text-inherit no-underline">
                        {item.title || "未命名问卷"}
                      </Link>
                    </td>
                    <td className="border-b border-gray-100 px-2 py-3.5 text-sm">
                      <StatusBadge status={item.status} />
                    </td>
                    <td className="border-b border-gray-100 px-2 py-3.5 text-sm">{item.questionCount} 题</td>
                    <td className="border-b border-gray-100 px-2 py-3.5 text-sm">{item.responseCount} 答卷</td>
                    <td className="border-b border-gray-100 px-2 py-3.5 text-sm">{formatDateTime(item.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="grid gap-3 sm:hidden">
            {data.items.map((item) => (
              <Link
                key={item.id}
                to={`/surveys/${item.id}`}
                className="block rounded-lg border border-gray-200 bg-white p-4 no-underline active:bg-slate-50"
              >
                <div className="flex items-center justify-between gap-2">
                  <strong>{item.title || "未命名问卷"}</strong>
                  <StatusBadge status={item.status} />
                </div>
                <div className="mt-2 text-sm text-gray-500">
                  {item.questionCount} 题 · {item.responseCount} 答卷 · {formatDateTime(item.updatedAt)}
                </div>
              </Link>
            ))}
          </div>
        </>
      ) : hasFilters ? (
        <EmptyPanel text="没有符合条件的问卷" actionLabel="清除筛选" onAction={clearFilters} />
      ) : (
        <EmptyPanel text="还没有问卷" />
      )}
    </section>
  );
}
