import { useEffect, useState } from "react";
import { EChart } from "../components/EChart";
import { Link, useNavigate } from "react-router";
import { Plus, Search } from "lucide-react";
import { donutOption } from "../charts";
import { useApi } from "../hooks";
import { apiSend, type SurveyListData, type SurveyStatus, type WriteResult } from "../api";
import { EmptyPanel, ErrorPanel, SkeletonPanel, StatusBadge } from "../components/ui";
import { STATUS_LABELS, formatDateTime } from "../format";

const SEARCH_DEBOUNCE_MS = 300;
const STATUS_OPTIONS: SurveyStatus[] = ["draft", "published", "closed", "archived"];

const STATUS_META: Record<SurveyStatus, { label: string; color: string; tint: string }> = {
  draft: { label: "草稿", color: "#64748b", tint: "bg-[var(--surface-muted)] text-[var(--color-muted)]" },
  published: { label: "已发布", color: "#16a34a", tint: "bg-[color-mix(in_srgb,var(--color-success)_12%,var(--surface))] text-[var(--color-success)]" },
  closed: { label: "已关闭", color: "#d97706", tint: "bg-[color-mix(in_srgb,var(--color-warning)_12%,var(--surface))] text-[var(--color-warning)]" },
  archived: { label: "已归档", color: "#0284c7", tint: "bg-[color-mix(in_srgb,var(--color-info)_12%,var(--surface))] text-[var(--color-info)]" },
};

export function SurveysPage() {
  const navigate = useNavigate();
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<string>("");
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    setPage(1);
  }, [search, status]);

  const query = new URLSearchParams({ search, status, page: String(page), pageSize: "20" });
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

  const summary = data?.statusSummary ?? { draft: 0, published: 0, closed: 0, archived: 0 };
  const summaryTotal = summary.draft + summary.published + summary.closed + summary.archived;
  const summaryDonut = summaryTotal > 0 ? donutOption(
    STATUS_OPTIONS.map((s) => ({
      name: STATUS_META[s].label,
      value: summary[s],
      color: STATUS_META[s].color,
    })).filter((x) => x.value > 0),
    { radius: ["48%", "72%"], center: ["35%", "50%"] },
  ) : null;

  return (
    <section className="card">
      {data ? (
        <div className="mb-5 grid gap-4 lg:grid-cols-[1fr_220px] items-start">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {STATUS_OPTIONS.map((s) => {
              const count = summary[s];
              const meta = STATUS_META[s];
              const active = status === s;
              return (
                <button
                  key={s}
                  className={`rounded-xl border p-4 text-left transition hover:-translate-y-0.5 hover:shadow-md ${
                    active
                      ? "border-[var(--color-primary)] bg-[color-mix(in_srgb,var(--color-primary)_8%,var(--surface))]"
                      : "border-[var(--color-edge)] bg-[var(--surface)]"
                  }`}
                  onClick={() => setStatus(active ? "" : s)}
                >
                  <div className="flex items-center gap-2 text-xs">
                    <span className={`inline-block h-2 w-2 rounded-full`} style={{ backgroundColor: meta.color }} />
                    <span className="text-[var(--color-muted)]">{meta.label}</span>
                  </div>
                  <div className="mt-1 text-2xl font-bold font-tabular-nums">{count}</div>
                </button>
              );
            })}
          </div>
          <div className="rounded-xl border border-[var(--color-edge)] p-2">
            {summaryDonut ? (
              <EChart option={summaryDonut} style={{ height: 180 }} opts={{ renderer: "svg" }} />
            ) : (
              <div className="grid h-[180px] place-items-center text-sm text-[var(--color-muted)]">暂无数据</div>
            )}
          </div>
        </div>
      ) : null}

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
      {data ? (
        <div className="mb-3 text-sm text-[var(--color-muted)]">
          {hasFilters ? (
            <>符合条件 {data.total} / 全部 {summaryTotal} 份</>
          ) : (
            <>共 {summaryTotal} 份问卷</>
          )}
        </div>
      ) : null}

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
                <div className="flex items-center justify-between flex-wrap gap-2">
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

      {data && data.totalPages > 1 ? (
        <div className="mt-4 flex items-center justify-center gap-2 text-sm">
          <button
            className="btn btn-sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            上一页
          </button>
          <span className="text-[var(--color-muted)]">
            第 <span className="font-semibold text-[var(--color-foreground)]">{data.page}</span> / {data.totalPages} 页
            （共 {data.total} 份）
          </span>
          <button
            className="btn btn-sm"
            disabled={page >= data.totalPages}
            onClick={() => setPage((p) => Math.min(data.totalPages, p + 1))}
          >
            下一页
          </button>
        </div>
      ) : null}
    </section>
  );
}
