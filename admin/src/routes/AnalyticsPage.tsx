import { useMemo } from "react";
import { Link, useParams } from "react-router";
import { useApi } from "../hooks";
import type { SurveyAnalyticsData } from "../api";
import { EmptyPanel, ErrorPanel, SkeletonPanel } from "../components/ui";

export function AnalyticsPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, retry } = useApi<SurveyAnalyticsData>(
    id ? `/api/admin/surveys/${id}/analytics` : null,
  );
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

  const metrics = [
    ["开始填写", data.overview.totalStarted],
    ["完成答卷", data.overview.totalCompleted],
    ["完成率", `${data.overview.completionRate.toFixed(1)}%`],
    ["填写中", data.statusCounts.in_progress],
  ] as const;

  return (
    <div>
      <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
        <h2 className="text-lg font-semibold">{data.survey.title}</h2>
        <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {metrics.map(([label, value]) => (
            <div key={label} className="rounded-xl bg-slate-50 p-4">
              <div className="text-sm text-gray-500">{label}</div>
              <div className="mt-1 text-2xl font-bold">{value}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-5 rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
        <h2 className="text-lg font-semibold">选择题分布</h2>
        {optionGroups.length ? optionGroups.map((group) => (
          <div key={group[0]?.questionId} className="mt-5 border-t border-gray-100 pt-4 first:border-0 first:pt-0">
            <h3 className="font-medium">{group[0]?.questionTitle}</h3>
            <div className="mt-3 space-y-3">
              {group.map((item) => (
                <div key={item.optionId}>
                  <div className="flex justify-between gap-3 text-sm">
                    <span>{item.optionLabel}</span>
                    <span className="text-gray-500">{item.count} · {item.percentage.toFixed(1)}%</span>
                  </div>
                  <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-slate-100">
                    <div className="h-full rounded-full bg-blue-500" style={{ width: `${Math.min(100, item.percentage)}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )) : <EmptyPanel text="暂无选择题统计" />}
      </section>

      <section className="mt-5 rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
        <h2 className="text-lg font-semibold">数字与评分统计</h2>
        {data.numericStats.length ? (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {data.numericStats.map((item) => (
              <article key={item.questionId} className="rounded-xl border border-gray-200 p-4">
                <h3 className="font-medium">{item.questionTitle}</h3>
                <div className="mt-3 grid grid-cols-2 gap-2 text-sm text-gray-600">
                  <span>平均值：{item.average ?? "—"}</span>
                  <span>样本数：{item.count}</span>
                  <span>最小值：{item.min ?? "—"}</span>
                  <span>最大值：{item.max ?? "—"}</span>
                </div>
              </article>
            ))}
          </div>
        ) : <EmptyPanel text="暂无数字或评分题统计" />}
      </section>

      <div className="mt-5 flex flex-wrap gap-3">
        <Link className="btn" to={`/surveys/${data.survey.id}`}>← 返回问卷</Link>
        <Link className="btn" to={`/surveys/${data.survey.id}/responses`}>查看答卷</Link>
      </div>
    </div>
  );
}
