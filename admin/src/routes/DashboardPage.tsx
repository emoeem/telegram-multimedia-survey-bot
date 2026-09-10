import { Link, useNavigate } from "react-router";
import {
  Activity,
  Archive,
  CheckCircle2,
  ClipboardList,
  Clock,
  FileText,
  Loader,
  Package,
  Users,
  XCircle,
} from "lucide-react";
import { useApi } from "../hooks";
import type { DashboardData } from "../api";
import { EmptyPanel, ErrorPanel, SkeletonPanel, StatusBadge } from "../components/ui";
import { formatDateTime } from "../format";

const METRICS: Array<{ key: keyof DashboardData; label: string; icon: typeof Users; tint: string }> = [
  {
    key: "users",
    label: "用户数量",
    icon: Users,
    tint: "bg-[color-mix(in_srgb,var(--color-primary)_10%,var(--surface))] text-[var(--color-primary)]",
  },
  {
    key: "surveys",
    label: "问卷数量",
    icon: ClipboardList,
    tint: "bg-[color-mix(in_srgb,var(--color-info)_12%,var(--surface))] text-[var(--color-info)]",
  },
  {
    key: "publishedSurveys",
    label: "已发布问卷",
    icon: FileText,
    tint: "bg-[color-mix(in_srgb,var(--color-success)_12%,var(--surface))] text-[var(--color-success)]",
  },
  {
    key: "responses",
    label: "答卷数量",
    icon: Archive,
    tint: "bg-[color-mix(in_srgb,var(--color-primary)_10%,var(--surface))] text-[var(--color-primary)]",
  },
  {
    key: "todayResponses",
    label: "今日答卷",
    icon: Activity,
    tint: "bg-[color-mix(in_srgb,var(--color-warning)_12%,var(--surface))] text-[var(--color-warning)]",
  },
];

export function DashboardPage() {
  const navigate = useNavigate();
  const { data, error, retry } = useApi<DashboardData>("/api/admin/dashboard");

  if (error) return <ErrorPanel error={error} onRetry={retry} />;
  if (!data) return <SkeletonPanel lines={6} />;

  const deliveries = data.reportDeliveries;
  const deliveryItems: Array<{
    label: string;
    value: number;
    status: string;
    icon: typeof Package;
    tint: string;
  }> = [
    {
      label: "待处理",
      value: deliveries.pending,
      status: "pending",
      icon: Clock,
      tint: "bg-[var(--surface-muted)] text-[var(--color-muted)]",
    },
    {
      label: "生成中",
      value: deliveries.delivering,
      status: "delivering",
      icon: Loader,
      tint: "bg-[color-mix(in_srgb,var(--color-info)_12%,var(--surface))] text-[var(--color-info)]",
    },
    {
      label: "已归档",
      value: deliveries.delivered,
      status: "delivered",
      icon: CheckCircle2,
      tint: "bg-[color-mix(in_srgb,var(--color-success)_12%,var(--surface))] text-[var(--color-success)]",
    },
    {
      label: "失败",
      value: deliveries.failed,
      status: "failed",
      icon: XCircle,
      tint: "bg-[color-mix(in_srgb,var(--color-danger)_10%,var(--surface))] text-[var(--color-danger)]",
    },
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
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-5">
        {METRICS.map(({ key, label, icon: Icon, tint }) => (
          <div key={key} className="stat">
            <div className="stat-label">
              <span className={`stat-icon ${tint}`}>
                <Icon className="h-[18px] w-[18px]" />
              </span>
              {label}
            </div>
            <div className="stat-value">{Number(data[key] ?? 0)}</div>
          </div>
        ))}
      </div>

      <section className="card mt-6">
        <div className="card-title">
          <div>
            <h2>报告归档状态</h2>
            <p className="card-sub">Telegram 私人频道交付队列</p>
          </div>
          <Link className="btn btn-sm" to="/reports">
            查看全部
          </Link>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {deliveryItems.map(({ label, value, status, icon: Icon, tint }) => (
            <Link
              key={label}
              to={`/reports?status=${status}`}
              className={`rounded-xl border p-4 transition hover:-translate-y-0.5 hover:shadow-md ${
                label === "失败" && value > 0
                  ? "border-[color-mix(in_srgb,var(--color-danger)_35%,var(--surface))] bg-[color-mix(in_srgb,var(--color-danger)_10%,var(--surface))]"
                  : "border-edge bg-[var(--surface)]"
              }`}
            >
              <div className="flex items-center gap-2 text-sm text-[var(--color-muted)]">
                <span className={`grid h-7 w-7 place-items-center rounded-lg ${tint}`}>
                  <Icon className="h-4 w-4" />
                </span>
                {label}
              </div>
              <div
                className={`mt-2 text-2xl font-bold ${label === "失败" && value > 0 ? "text-[var(--color-danger)]" : ""}`}
              >
                {value}
              </div>
            </Link>
          ))}
        </div>
      </section>

      {data.recentActions?.length ? (
        <section className="card mt-6">
          <h2 className="text-base font-semibold">最近操作</h2>
          <ul className="mt-3 divide-y divide-edge-soft">
            {data.recentActions.map((action) => (
              <li key={action.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                <span>
                  {actionLabels[action.action] ?? action.action}
                  <span className="muted">
                    {" "}
                    · {action.entityType} #{action.entityId ?? "-"}
                  </span>
                </span>
                <span className="muted">{formatDateTime(action.createdAt)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="card mt-6">
        <h2 className="text-base font-semibold">最近问卷</h2>
        {data.recentSurveys?.length ? (
          <div className="mt-3 overflow-x-auto">
            <table className="tbl">
              <tbody>
                {data.recentSurveys.map((item) => (
                  <tr key={item.id} className="cursor-pointer" onClick={() => navigate(`/surveys/${item.id}`)}>
                    <td>
                      <strong>{item.title || "未命名问卷"}</strong>
                    </td>
                    <td>
                      <StatusBadge status={item.status} />
                    </td>
                    <td className="muted">{formatDateTime(item.updatedAt)}</td>
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
        <section className="card mt-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-base font-semibold">最近答卷</h2>
            <Link className="btn btn-sm" to="/responses">
              查看全部
            </Link>
          </div>
          <div className="mt-3 overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th className="text-sm text-[var(--color-muted)]">问卷 / 答卷</th>
                  <th className="text-sm text-[var(--color-muted)]">填写者</th>
                  <th className="text-sm text-[var(--color-muted)]">状态</th>
                  <th className="text-sm text-[var(--color-muted)]">时间</th>
                </tr>
              </thead>
              <tbody>
                {data.recentResponses.map((item) => {
                  const respondentText = item.respondent
                    ? [item.respondent.firstName, item.respondent.lastName].filter(Boolean).join(" ") ||
                      (item.respondent.username
                        ? `@${item.respondent.username}`
                        : String(item.respondent.telegramUserId))
                    : item.participantKey
                      ? `网页参与 · ${item.participantKey}`
                      : "匿名 / 网页参与";
                  return (
                    <tr
                      key={item.id}
                      className="cursor-pointer"
                      onClick={() => navigate(`/surveys/${item.surveyId}/responses/${item.id}`)}
                    >
                      <td>
                        <strong>{item.title || `问卷 ${item.surveyId}`}</strong>
                        <span className="muted"> · #{item.id}</span>
                      </td>
                      <td className="text-sm">{respondentText}</td>
                      <td className="text-sm">{item.statusLabel}</td>
                      <td className="muted">{formatDateTime(item.updatedAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}
