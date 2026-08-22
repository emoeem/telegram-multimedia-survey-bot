import { Link, useNavigate } from "react-router";
import { useApi } from "../hooks";
import type { DashboardData } from "../api";
import { EmptyPanel, ErrorPanel, SkeletonPanel, StatusBadge } from "../components/ui";
import { formatDateTime } from "../format";

export function DashboardPage() {
  const navigate = useNavigate();
  const { data, error, retry } = useApi<DashboardData>("/api/admin/dashboard");

  if (error) return <ErrorPanel error={error} onRetry={retry} />;
  if (!data) return <SkeletonPanel lines={6} />;

  const metrics: [keyof DashboardData, string][] = [
    ["users", "用户数量"],
    ["surveys", "问卷数量"],
    ["publishedSurveys", "已发布问卷"],
    ["responses", "答卷数量"],
  ];

  return (
    <div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-4">
        {metrics.map(([key, label]) => (
          <div key={key} className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
            <div className="text-sm text-gray-500">{label}</div>
            <div className="mt-2 text-3xl font-bold">{Number(data[key] ?? 0)}</div>
          </div>
        ))}
      </div>
      <section className="mt-6 rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
        <h2 className="mb-3 text-lg font-semibold">最近问卷</h2>
        {data.recentSurveys?.length ? (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <tbody>
                {data.recentSurveys.map((item) => (
                  <tr
                    key={item.id}
                    className="cursor-pointer border-b border-gray-100 hover:bg-slate-50"
                    onClick={() => navigate(`/surveys/${item.id}`)}
                  >
                    <td className="border-b border-gray-100 px-2 py-3.5 text-sm">
                      <strong>{item.title || "未命名问卷"}</strong>
                    </td>
                    <td className="border-b border-gray-100 px-2 py-3.5 text-sm">
                      <StatusBadge status={item.status} />
                    </td>
                    <td className="border-b border-gray-100 px-2 py-3.5 text-sm">
                      {formatDateTime(item.updatedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyPanel text="还没有问卷" />
        )}
      </section>
      {data.recentResponses?.length ? (
        <section className="mt-6 rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
          <h2 className="mb-3 text-lg font-semibold">最近答卷</h2>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <tbody>
                {data.recentResponses.map((item) => (
                  <tr key={item.id} className="hover:bg-slate-50">
                    <td className="border-b border-gray-100 px-2 py-3.5 text-sm">
                      <strong>{item.title || `问卷 ${item.surveyId}`}</strong>
                    </td>
                    <td className="border-b border-gray-100 px-2 py-3.5 text-sm">{item.status || "-"}</td>
                    <td className="border-b border-gray-100 px-2 py-3.5 text-sm">
                      {formatDateTime(item.updatedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
      <div className="mt-6 text-center">
        <Link to="/surveys" className="btn inline-block">
          查看全部问卷 →
        </Link>
      </div>
    </div>
  );
}
