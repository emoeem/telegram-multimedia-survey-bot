import { Link, useParams } from "react-router";
import { useApi } from "../hooks";
import type { SurveyDetailData } from "../api";
import { ErrorPanel, SkeletonPanel, StatusBadge } from "../components/ui";
import { formatDateTime } from "../format";

export function SurveyDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, retry } = useApi<SurveyDetailData>(
    id ? `/api/admin/surveys/${id}` : null,
  );

  if (error) return <ErrorPanel error={error} onRetry={retry} />;
  if (!data) return <SkeletonPanel lines={6} />;

  const owner = data.firstName || data.username || data.owner_id || "-";
  const fields: [string, string | number | undefined][] = [
    ["状态", data.status],
    ["创建者", owner],
    ["题目数量", `${data.questionCount} 题`],
    ["答卷数量", `${data.responseCount} 答卷（完成 ${data.completedCount} 份）`],
    ["创建时间", formatDateTime(data.created_at)],
    ["更新时间", formatDateTime(data.updated_at)],
    ["公开状态", data.status === "published" ? "公开" : "未公开"],
    ["密码保护", data.access_code ? "已启用" : "未启用"],
  ];

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{data.title || "未命名问卷"}</h2>
        <StatusBadge status={data.status} />
      </div>
      {data.description ? <p className="mt-1 text-sm text-gray-500">{data.description}</p> : null}
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-4">
        {fields.map(([label, value]) => (
          <div key={label} className="rounded-xl border border-gray-200 bg-white p-4">
            <div className="text-sm text-gray-500">{label}</div>
            <div className="mt-1.5 font-semibold">
              {label === "状态" ? <StatusBadge status={data.status} /> : String(value ?? "-")}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-6 flex flex-wrap gap-3">
        <Link to="/surveys" className="btn">
          ← 返回问卷
        </Link>
        <Link to={`/surveys/${data.id}/editor`} className="btn">
          ✏️ 打开编辑器
        </Link>
      </div>
    </section>
  );
}
