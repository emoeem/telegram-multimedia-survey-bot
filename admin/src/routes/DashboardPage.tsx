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
    ["todayResponses", "今日答卷"],
  ];

  const deliveries = data.reportDeliveries;
  const deliveryItems: Array<[string, number]> = [
    ["待处理", deliveries.pending],
    ["生成中", deliveries.delivering],
    ["已归档", deliveries.delivered],
    ["失败", deliveries.failed],
  ];

  const actionLabels: Record<string, string> = {
    "survey.create": "创建问卷",
    "survey.publish": "发布问卷",
    "survey.close": "关闭问卷",
    "survey.archive": "归档问卷",
    "survey.reopen": "重新发布",
    "survey.delete": "删除问卷",
    "survey.duplicate": "复制问卷",
    "survey.import": "导入问卷",
  };

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
        <h2 className="mb-3 text-lg font-semibold">报告归档状态</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {deliveryItems.map(([label, value]) => (
            <Link
              key={label}
              to={`/reports?status=${label === "已归档" ? "delivered" : label === "失败" ? "failed" : label === "生成中" ? "delivering" : "pending"}`}
              className={`rounded-xl border p-4 ${
                label === "失败" && value > 0
                  ? "border-red-200 bg-red-50"
                  : "border-gray-200 bg-white"
              }`}
            >
              <div className="text-sm text-gray-500">{label}</div>
              <div className={`mt-1.5 text-2xl font-bold ${label === "失败" && value > 0 ? "text-red-600" : ""}`}>
                {value}
              </div>
            </Link>
          ))}
        </div>
      </section>
      {data.recentActions?.length ? (
        <section className="mt-6 rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
          <h2 className="mb-3 text-lg font-semibold">最近操作</h2>
          <ul className="divide-y divide-gray-100">
            {data.recentActions.map((action) => (
              <li key={action.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                <span>
                  {actionLabels[action.action] ?? action.action}
                  <span className="text-gray-400"> · {action.entityType} #{action.entityId ?? "-"}</span>
                </span>
                <span className="text-gray-400">{formatDateTime(action.createdAt)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
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
                  <tr
                    key={item.id}
                    className="cursor-pointer hover:bg-slate-50"
                    onClick={() => navigate(`/surveys/${item.surveyId}/responses/${item.id}`)}
                  >
                    <td className="border-b border-gray-100 px-2 py-3.5 text-sm">
                      <Link
                        to={`/surveys/${item.surveyId}/responses/${item.id}`}
                        className="font-semibold text-inherit no-underline"
                      >
                        {item.title || `问卷 ${item.surveyId}`}
                      </Link>
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
