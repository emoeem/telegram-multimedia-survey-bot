import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Plus, Search } from "lucide-react";
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
      if (typeof result.id === "number") {
        navigate(`/surveys/${result.id}/editor`);
        return;
      }
      setCreateError("创建结果异常，请重试");
    } catch (requestError) {
      setCreateError(requestError instanceof Error ? requestError.message : "创建失败");
    } finally {
      setCreating(false);
    }
  };

  return (
    <section className="card">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative min-w-0 flex-1 sm:min-w-52">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-muted-soft)]" />
          <input
            type="text"
            className="input w-full pl-9"
            placeholder="搜索问卷…"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
          />
        </div>
        <select className="select" value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="">全部状态</option>
          {STATUS_OPTIONS.map((value) => (
            <option key={value} value={value}>
              {STATUS_LABELS[value]}
            </option>
          ))}
        </select>
        <button className="btn btn-primary" disabled={creating} onClick={createSurvey}>
          {creating ? (
            "创建中…"
          ) : (
            <>
              <Plus className="h-4 w-4" />
              新建问卷
            </>
          )}
        </button>
      </div>
      {createError ? <div className="mb-3 text-sm text-[var(--color-danger)]">新建失败：{createError}</div> : null}

      {error ? (
        <ErrorPanel error={error} onRetry={retry} />
      ) : !data ? (
        <SkeletonPanel lines={5} />
      ) : data.items.length ? (
        <>
          <div className="hidden overflow-x-auto sm:block">
            <table className="tbl">
              <thead>
                <tr>
                  <th className="text-sm font-semibold text-[var(--color-muted)]">标题</th>
                  <th className="text-sm font-semibold text-[var(--color-muted)]">状态</th>
                  <th className="text-sm font-semibold text-[var(--color-muted)]">题目</th>
                  <th className="text-sm font-semibold text-[var(--color-muted)]">答卷</th>
                  <th className="text-sm font-semibold text-[var(--color-muted)]">更新时间</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((item) => (
                  <tr
                    key={item.id}
                    className="cursor-pointer hover:bg-[var(--surface-hover)]"
                    onClick={() => navigate(`/surveys/${item.id}`)}
                  >
                    <td className="text-sm">
                      <Link to={`/surveys/${item.id}`} className="font-semibold text-inherit no-underline">
                        {item.title || "未命名问卷"}
                      </Link>
                    </td>
                    <td className="text-sm">
                      <StatusBadge status={item.status} />
                    </td>
                    <td className="text-sm">{item.questionCount} 题</td>
                    <td className="text-sm">{item.responseCount} 答卷</td>
                    <td className="text-sm">{formatDateTime(item.updatedAt)}</td>
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
                className="block rounded-lg border border-[var(--color-edge)] bg-[var(--surface)] p-4 no-underline active:bg-[var(--surface-muted)]"
              >
                <div className="flex items-center justify-between gap-2">
                  <strong>{item.title || "未命名问卷"}</strong>
                  <StatusBadge status={item.status} />
                </div>
                <div className="mt-2 text-sm text-[var(--color-muted)]">
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
