import { useMemo } from "react";
import ReactECharts from "echarts-for-react";
import { Link, useParams } from "react-router";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { donutOption, histogramOption, horizontalBarOption, pieOption, useChartColors } from "../charts";
import { useApi } from "../hooks";
import type { SurveyAnalyticsData } from "../api";
import { EmptyPanel, ErrorPanel, SkeletonPanel } from "../components/ui";

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  completed: { label: "已完成", color: "#16a34a" },
  in_progress: { label: "填写中", color: "#0284c7" },
  abandoned: { label: "已放弃", color: "#d97706" },
  cancelled: { label: "已取消", color: "#dc2626" },
  archived: { label: "已归档", color: "#64748b" },
};

export function AnalyticsPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, retry } = useApi<SurveyAnalyticsData>(id ? `/api/admin/surveys/${id}/analytics` : null);
  const colors = useChartColors();

  const optionGroups = useMemo(() => {
    const groups = new Map<number, SurveyAnalyticsData["optionStats"]>();
    for (const item of data?.optionStats ?? []) {
      const group = groups.get(item.questionId) ?? [];
      group.push(item);
      groups.set(item.questionId, group);
    }
    return [...groups.values()];
  }, [data]);

  if (error) return <ErrorPanel error={error} onRetry={retry} />;
  if (!data) return <SkeletonPanel lines={8} />;

  const statusDonut = donutOption(
    Object.entries(data.statusCounts)
      .filter(([, count]) => count > 0)
      .map(([status, count]) => ({
        name: STATUS_LABELS[status]?.label ?? status,
        value: count,
        color: STATUS_LABELS[status]?.color ?? "#64748b",
      })),
  );
  const numericBar = horizontalBarOption(
    data.numericStats.map((s) => ({
      label: s.questionTitle.slice(0, 12),
      value: s.average,
      rightFormatter: (v) => v.toFixed(2),
    })),
  );
  const timeline = histogramOption(data.completionTimeBuckets ?? [], colors.primary, colors.muted);

  const statusTotal = Object.values(data.statusCounts).reduce((sum, c) => sum + c, 0);
  const completedPct = data.overview.completionRate;

  const totalOptionStats = data.optionStats.length;
  const totalNumericStats = data.numericStats.length;

  return (
    <div>
      <section className="card">
        <div className="card-title">
          <div>
            <h2>{data.survey.title}</h2>
            <p className="card-sub">统计总览 · {totalOptionStats + totalNumericStats} 道题目</p>
          </div>
          <button className="btn btn-sm" onClick={retry} title="刷新数据">
            <RefreshCw className="h-3.5 w-3.5" />
            刷新
          </button>
        </div>

        <div className="mt-5 grid gap-5 lg:grid-cols-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="rounded-xl bg-[var(--surface-muted)] p-4">
              <div className="text-sm text-[var(--color-muted)]">开始填写</div>
              <div className="mt-1 text-2xl font-bold font-tabular-nums">{data.overview.totalStarted}</div>
            </div>
            <div className="rounded-xl bg-gradient-to-br from-[var(--color-primary)] to-[#7c3aed] p-4 text-white">
              <div className="text-sm opacity-80">完成率</div>
              <div className="mt-1 text-2xl font-bold font-tabular-nums">{completedPct.toFixed(1)}%</div>
            </div>
            <div className="rounded-xl bg-[var(--surface-muted)] p-4">
              <div className="text-sm text-[var(--color-muted)]">已完成</div>
              <div className="mt-1 text-2xl font-bold font-tabular-nums text-[var(--color-success)]">{data.overview.totalCompleted}</div>
            </div>
            <div className="rounded-xl bg-[var(--surface-muted)] p-4">
              <div className="text-sm text-[var(--color-muted)]">填写中</div>
              <div className="mt-1 text-2xl font-bold font-tabular-nums text-[var(--color-info)]">{data.statusCounts.in_progress}</div>
            </div>
          </div>

          <div className="rounded-xl border border-[var(--color-edge)] p-3">
            <div className="mb-2 text-sm font-medium text-[var(--color-muted)]">答卷状态分布</div>
            {statusDonut ? (
              <ReactECharts option={statusDonut} style={{ height: 180 }} opts={{ renderer: "svg" }} />
            ) : (
              <EmptyPanel text="暂无数据" />
            )}
          </div>
        </div>
      </section>

      {timeline ? (
        <section className="mt-5 card">
          <div className="card-title">
            <h2>答题时间分布</h2>
            <p className="card-sub">最近 {data.completionTimeBuckets?.length ?? 0} 天完成情况</p>
          </div>
          <ReactECharts option={timeline} style={{ height: 200, width: "100%" }} opts={{ renderer: "svg" }} />
        </section>
      ) : null}

      {optionGroups.length ? (
        <section className="mt-5 card">
          <div className="card-title">
            <h2>选择题分布</h2>
            <p className="card-sub">{optionGroups.length} 道题目 · 每题自动标出冠军选项</p>
          </div>
          <div className="space-y-6">
            {optionGroups.map((group) => {
              const first = group[0];
              if (!first) return null;
              const total = group.reduce((s, r) => s + r.count, 0);
              const championIdx = group.reduce((best, r, i, arr) => (r.count > (arr[best]?.count ?? 0) ? i : best), 0);
              const champion = group[championIdx];
              const pie = pieOption(group.map((r) => ({ name: r.optionLabel.slice(0, 14), value: r.count })));

              return (
                <div key={first.questionId} className="rounded-xl border border-[var(--color-edge)] p-4">
                  <div className="mb-3 flex items-center gap-3">
                    <span className="inline-flex items-center rounded-md bg-gradient-to-br from-[var(--color-primary)] to-[#7c3aed] px-2 py-0.5 text-xs font-bold text-white font-mono">Q{first.questionId}</span>
                    <h3 className="flex-1 font-medium">{first.questionTitle}</h3>
                    {total > 0 ? (
                      <span className="rounded-full border border-[#fde68a] bg-[#fef9e7] px-2 py-0.5 text-xs font-medium text-[#a16207]">
                        ★ {champion?.optionLabel} · {champion?.percentage.toFixed(1)}%
                      </span>
                    ) : null}
                  </div>
                  <div className="grid gap-4 md:grid-cols-[1fr_240px] items-center">
                    <div className="space-y-2">
                      {group.map((item, idx) => (
                        <div key={item.optionId}>
                          <div className="flex justify-between gap-3 text-sm">
                            <span className={idx === championIdx && total > 0 ? "font-semibold text-[#a16207]" : ""}>
                              {item.optionLabel}
                            </span>
                            <span className="text-[var(--color-muted)] font-tabular-nums">
                              {item.count} · {item.percentage.toFixed(1)}%
                            </span>
                          </div>
                          <div className="mt-1 h-2 overflow-hidden rounded-full bg-[var(--surface-muted)]">
                            <div
                              className="h-full rounded-full transition-all"
                              style={{
                                width: `${Math.min(100, item.percentage)}%`,
                                background: idx === championIdx && total > 0
                                  ? "linear-gradient(90deg, #f59e0b, #fbbf24)"
                                  : "linear-gradient(90deg, #4f46e5, #818cf8)",
                              }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                    {pie ? (
                      <div className="flex justify-center">
                        <ReactECharts option={pie} style={{ height: 200, width: "100%", maxWidth: 240 }} opts={{ renderer: "svg" }} />
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ) : (
        <section className="mt-5 card">
          <h2 className="text-lg font-semibold">选择题分布</h2>
          <EmptyPanel text="暂无选择题统计" />
        </section>
      )}

      <section className="mt-5 card">
        <div className="card-title">
          <h2>数字与评分统计</h2>
          <p className="card-sub">{data.numericStats.length} 道题目</p>
        </div>
        {data.numericStats.length ? (
          <div className="grid gap-5 md:grid-cols-[1fr_1fr] items-start">
            {numericBar ? (
              <div className="rounded-xl border border-[var(--color-edge)] p-2">
                <ReactECharts option={numericBar} style={{ height: Math.max(200, data.numericStats.length * 42), width: "100%" }} opts={{ renderer: "svg" }} />
              </div>
            ) : null}
            <div className="space-y-3">
              {data.numericStats.map((item) => (
                <article key={item.questionId} className="rounded-xl border border-[var(--color-edge)] p-4">
                  <h3 className="font-medium">{item.questionTitle}</h3>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-sm text-[var(--text-soft)]">
                    <span>样本：<strong>{item.count}</strong></span>
                    <span>平均值：<strong className="text-[var(--color-primary)]">{item.average ?? "—"}</strong></span>
                    <span>最小值：{item.min ?? "—"}</span>
                    <span>最大值：{item.max ?? "—"}</span>
                  </div>
                </article>
              ))}
            </div>
          </div>
        ) : (
          <EmptyPanel text="暂无数字或评分题统计" />
        )}
      </section>

      <div className="mt-5 flex flex-wrap gap-3">
        <Link className="btn" to={`/surveys/${data.survey.id}`}>
          <ArrowLeft className="h-4 w-4" />
          返回问卷
        </Link>
        <Link className="btn" to={`/surveys/${data.survey.id}/responses`}>
          查看答卷
        </Link>
      </div>
    </div>
  );
}
