import { useEffect, useState } from "react";
import { EChart } from "../components/EChart";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Plus, Search } from "lucide-react";
import { donutOption } from "../charts";
import { useApi } from "../hooks";
import { useDialogs } from "../components/Dialogs";
import {
  apiSend,
  bulkSetSurveyCategory,
  bulkSetSurveyRating,
  listSurveyCategories,
  setSurveyRating,
  type SurveyCategoryDto,
  type SurveyListData,
  type SurveyStatus,
  type WriteResult,
} from "../api";
import { EmptyPanel, ErrorPanel, SkeletonPanel, StatusBadge } from "../components/ui";
import { STATUS_LABELS, formatDateTime } from "../format";

const SEARCH_DEBOUNCE_MS = 300;
const STATUS_OPTIONS: SurveyStatus[] = ["draft", "published", "closed", "archived"];

const STATUS_META: Record<SurveyStatus, { label: string; color: string; tint: string }> = {
  draft: { label: "草稿", color: "#64748b", tint: "bg-[var(--surface-muted)] text-[var(--color-muted)]" },
  published: {
    label: "已发布",
    color: "#16a34a",
    tint: "bg-[color-mix(in_srgb,var(--app-success)_12%,var(--surface))] text-[var(--app-success)]",
  },
  closed: {
    label: "已关闭",
    color: "#d97706",
    tint: "bg-[color-mix(in_srgb,var(--app-warning)_12%,var(--surface))] text-[var(--app-warning)]",
  },
  archived: {
    label: "已归档",
    color: "#0284c7",
    tint: "bg-[color-mix(in_srgb,var(--app-info)_12%,var(--surface))] text-[var(--app-info)]",
  },
};

export function SurveysPage() {
  const navigate = useNavigate();
  const { toast, confirm } = useDialogs();
  const [searchParams, setSearchParams] = useSearchParams();
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<string>("");
  const [rating, setRating] = useState<string>("");
  // 分类筛选存在 URL 里：「分类」页点过来（/surveys?category=3）要能直接落在
  // 该分类上，刷新和分享链接也不丢。
  const category = searchParams.get("category") ?? "";
  const setCategory = (next: string) => {
    const params = new URLSearchParams(searchParams);
    if (next) params.set("category", next);
    else params.delete("category");
    setSearchParams(params, { replace: true });
  };
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<number[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    setPage(1);
    setSelected([]);
  }, [search, status, rating, category]);

  const query = new URLSearchParams({ search, status, rating, category, page: String(page), pageSize: "20" });
  const { data, error, retry } = useApi<SurveyListData>(`/api/admin/surveys?${query}`);
  // 分类清单很轻（几个抽屉），但和列表分开取：列表缓存/分页与分类字典的
  // 生命周期不同，捆在一起会让翻页时重建筛选条。
  const { data: categoryData } = useApi<{ items: SurveyCategoryDto[] }>("/api/admin/survey-categories");
  const categories = categoryData?.items ?? [];

  const hasFilters = searchInput.trim() !== "" || status !== "" || rating !== "" || category !== "";
  const clearFilters = () => {
    setSearchInput("");
    setStatus("");
    setRating("");
    setCategory("");
  };

  /** 单卷切换分级：r18→all 是放宽，二次确认避免误操作（0080 的管理端语义）。 */
  const toggleRating = async (surveyId: number, current: "all" | "r18" | undefined) => {
    const next = current === "r18" ? "all" : "r18";
    if (
      next === "all" &&
      !(await confirm({
        title: "改回「全年龄」？",
        message: "该问卷会立即使其在未确认年龄的访客目录中可见。",
        confirmLabel: "改回全年龄",
      }))
    ) {
      return;
    }
    try {
      await setSurveyRating(surveyId, next);
      retry();
    } catch {
      toast({ message: "分级切换失败，请重试", variant: "error" });
    }
  };

  const bulkRating = async (target: "all" | "r18") => {
    if (bulkBusy || !selected.length) return;
    if (target === "all") {
      const ok = await confirm({
        title: `把 ${selected.length} 份问卷改回「全年龄」？`,
        message: "选中的问卷会立即使其对未确认年龄的访客可见。",
        confirmLabel: "批量改回全年龄",
      });
      if (!ok) return;
    }
    setBulkBusy(true);
    try {
      await bulkSetSurveyRating(selected, target);
      setSelected([]);
      retry();
    } catch {
      toast({ message: "批量分级失败，请重试", variant: "error" });
    } finally {
      setBulkBusy(false);
    }
  };

  /** 批量归类：选中的问卷一起放进一个分类（或移出分类）。 */
  const bulkCategory = async (target: string) => {
    if (bulkBusy || !selected.length || !target) return;
    setBulkBusy(true);
    try {
      await bulkSetSurveyCategory(selected, target === "none" ? null : Number(target));
      const label = target === "none" ? "未分类" : (categories.find((c) => String(c.id) === target)?.name ?? "该分类");
      toast({ message: `已把 ${selected.length} 份问卷归到「${label}」`, variant: "success" });
      setSelected([]);
      retry();
    } catch (requestError) {
      toast({
        message: requestError instanceof Error ? requestError.message : "归类失败",
        variant: "error",
      });
    } finally {
      setBulkBusy(false);
    }
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
  const summaryDonut =
    summaryTotal > 0
      ? donutOption(
          STATUS_OPTIONS.map((s) => ({
            name: STATUS_META[s].label,
            value: summary[s],
            color: STATUS_META[s].color,
          })).filter((x) => x.value > 0),
          { radius: ["48%", "72%"], center: ["35%", "50%"] },
        )
      : null;

  return (
    <div className="space-y-5">
      <div className="admin-page-intro">
        <div>
          <h2>问卷</h2>
          <p>创建、发布和管理全部问卷内容</p>
        </div>
      </div>
      <section className="card">
        {data ? (
          <div className="mb-5 grid gap-4 lg:grid-cols-[1fr_240px] items-start">
            <div className="admin-stat-grid">
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
        {data?.ratingSummary ? (
          <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
            <span className="text-[var(--color-muted)]">内容分级：</span>
            {(
              [
                { key: "all", label: "全年龄" },
                { key: "r18", label: "18+" },
              ] as const
            ).map(({ key, label }) => {
              const active = rating === key;
              return (
                <button
                  key={key}
                  className={`rounded-full border px-3 py-1 transition ${
                    active
                      ? "border-[var(--color-primary)] bg-[color-mix(in_srgb,var(--color-primary)_10%,var(--surface))] font-semibold"
                      : "border-[var(--color-edge)] text-[var(--color-muted)]"
                  }`}
                  onClick={() => setRating(active ? "" : key)}
                >
                  {label} {data.ratingSummary![key]}
                </button>
              );
            })}
          </div>
        ) : null}

        <div className="mb-4 flex flex-wrap items-center gap-3">
          {/* 窄屏让搜索框独占一行：加了「分类」下拉之后这一排有四个控件，
              挤在一行会把输入框压到只能看见「搜索问…」。 */}
          <div className="relative min-w-0 flex-1 basis-full sm:basis-auto sm:min-w-52">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-muted-soft)]" />
            <input
              type="text"
              className="input w-full pl-9"
              placeholder="搜索问卷…"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
            />
          </div>
          <select
            aria-label="问卷状态筛选"
            className="select"
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
          <select
            aria-label="内容分级筛选"
            className="select"
            value={rating}
            onChange={(event) => setRating(event.target.value)}
          >
            <option value="">全部分级</option>
            <option value="all">全年龄</option>
            <option value="r18">18+</option>
          </select>
          <select
            aria-label="分类筛选"
            className="select"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
          >
            <option value="">全部分类</option>
            <option value="none">未分类</option>
            {categories.map((option) => (
              <option key={option.id} value={String(option.id)}>
                {option.name}（{option.count}）
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
        {createError ? <div className="mb-3 text-sm text-[var(--app-danger)]">新建失败：{createError}</div> : null}
        {data ? (
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-sm text-[var(--color-muted)]">
            <span>
              {hasFilters ? (
                <>
                  符合条件 {data.total} / 全部 {summaryTotal} 份
                </>
              ) : (
                <>共 {summaryTotal} 份问卷</>
              )}
            </span>
            {selected.length > 0 ? (
              <span className="flex items-center gap-2">
                <span className="font-semibold text-[var(--color-foreground)]">已选 {selected.length} 份</span>
                <select
                  aria-label="批量归类到"
                  className="select btn-sm"
                  value=""
                  disabled={bulkBusy}
                  onChange={(event) => {
                    const value = event.target.value;
                    event.target.value = "";
                    if (value) void bulkCategory(value);
                  }}
                >
                  <option value="">批量归类…</option>
                  <option value="none">移出分类</option>
                  {categories.map((option) => (
                    <option key={option.id} value={String(option.id)}>
                      {option.name}
                    </option>
                  ))}
                </select>
                <button className="btn btn-sm" disabled={bulkBusy} onClick={() => void bulkRating("r18")}>
                  标为 18+
                </button>
                <button className="btn btn-sm" disabled={bulkBusy} onClick={() => void bulkRating("all")}>
                  标为全年龄
                </button>
                <button className="btn btn-sm btn-quiet" onClick={() => setSelected([])}>
                  取消选择
                </button>
              </span>
            ) : null}
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
                    <th className="w-8">
                      <input
                        type="checkbox"
                        aria-label="全选本页"
                        checked={selected.length > 0 && selected.length === data.items.length}
                        onChange={(event) => setSelected(event.target.checked ? data.items.map((item) => item.id) : [])}
                      />
                    </th>
                    <th className="text-sm font-semibold text-[var(--color-muted)]">标题</th>
                    <th className="text-sm font-semibold text-[var(--color-muted)]">状态</th>
                    <th className="text-sm font-semibold text-[var(--color-muted)]">分级</th>
                    <th className="text-sm font-semibold text-[var(--color-muted)]">分类</th>
                    <th className="text-sm font-semibold text-[var(--color-muted)]">题目</th>
                    <th className="text-sm font-semibold text-[var(--color-muted)]">答卷</th>
                    <th className="text-sm font-semibold text-[var(--color-muted)]">更新时间</th>
                  </tr>
                </thead>
                <tbody>
                  {/* 整行点击只是鼠标便利，不声明交互语义。
                      这里刻意不用 role="button" + tabIndex：行内含复选框、标题链接
                      和分级按钮，任何 interactive 角色套在外层都会构成 axe 的
                      `nested-interactive`（button > checkbox/link）。键盘用户走标题
                      链接 —— 它本来就是本行唯一的目的地，语义已经完整。
                      1440×900 才暴露是因为移动端渲染的是卡片布局，不渲染这张表。 */}
                  {data.items.map((item) => (
                    <tr
                      key={item.id}
                      className="cursor-pointer hover:bg-[var(--surface-hover)]"
                      onClick={() => navigate(`/surveys/${item.id}`)}
                    >
                      <td
                        className="text-sm"
                        onClick={(event) => {
                          event.stopPropagation();
                          setSelected((current) =>
                            current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id],
                          );
                        }}
                      >
                        <input
                          type="checkbox"
                          aria-label={`选择 ${item.title || item.id}`}
                          checked={selected.includes(item.id)}
                          // 复选框自己处理 change（键盘空格可用）；td 的点击
                          // 只负责扩大热区，点在框上时不能重复切换。
                          onClick={(event) => event.stopPropagation()}
                          onChange={(event) =>
                            setSelected((current) =>
                              event.target.checked
                                ? [...new Set([...current, item.id])]
                                : current.filter((id) => id !== item.id),
                            )
                          }
                        />
                      </td>
                      <td className="text-sm">
                        <Link to={`/surveys/${item.id}`} className="font-semibold text-inherit no-underline">
                          {item.title || "未命名问卷"}
                        </Link>
                      </td>
                      <td className="text-sm">
                        <StatusBadge status={item.status} />
                      </td>
                      <td className="text-sm" onClick={(event) => event.stopPropagation()}>
                        <button
                          type="button"
                          className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold transition ${
                            item.contentRating === "r18"
                              ? "badge badge-red"
                              : "border-[var(--color-edge)] text-[var(--color-muted)]"
                          }`}
                          title="点击切换分级（18+ → 全年龄 需确认）"
                          onClick={() => void toggleRating(item.id, item.contentRating)}
                        >
                          {item.contentRating === "r18" ? "18+" : "全年龄"}
                        </button>
                      </td>
                      <td className="text-sm">
                        {item.categoryName ? (
                          <span className="rounded-full border border-[var(--color-edge)] px-2.5 py-0.5 text-xs">
                            {item.categoryName}
                          </span>
                        ) : (
                          <span className="text-xs text-[var(--color-muted-soft)]">未分类</span>
                        )}
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
                    <span className="flex min-w-0 items-center gap-2">
                      {/* 手机端也要能多选：批量归类/分级不能只在桌面可用。 */}
                      <input
                        type="checkbox"
                        aria-label={`选择 ${item.title || item.id}`}
                        checked={selected.includes(item.id)}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                        }}
                        onChange={(event) =>
                          setSelected((current) =>
                            event.target.checked
                              ? [...new Set([...current, item.id])]
                              : current.filter((id) => id !== item.id),
                          )
                        }
                      />
                      <strong className="truncate">{item.title || "未命名问卷"}</strong>
                    </span>
                    <span className="flex items-center gap-1.5">
                      <StatusBadge status={item.status} />
                      {item.contentRating === "r18" ? <span className="badge badge-red">18+</span> : null}
                    </span>
                  </div>
                  <div className="mt-2 text-sm text-[var(--color-muted)]">
                    {item.categoryName ?? "未分类"} · {item.questionCount} 题 · {item.responseCount} 答卷 ·{" "}
                    {formatDateTime(item.updatedAt)}
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
            <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
              上一页
            </button>
            <span className="text-[var(--color-muted)]">
              第 <span className="font-semibold text-[var(--color-foreground)]">{data.page}</span> / {data.totalPages}{" "}
              页 （共 {data.total} 份）
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
    </div>
  );
}
