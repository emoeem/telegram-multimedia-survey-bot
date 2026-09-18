import { useState } from "react";
import { EChart } from "../components/EChart";
import { Link, useNavigate } from "react-router";
import { Activity, Archive, CheckCircle2, ClipboardList, Clock, FileText, Loader, Package, RefreshCw, Users, XCircle } from "lucide-react";
import { donutOption } from "../charts";
import { useApi } from "../hooks";
import type { DashboardData } from "../api";
import { EmptyPanel, ErrorPanel, SkeletonPanel, StatusBadge } from "../components/ui";
import { formatDateTime } from "../format";

const DELIVERY_COLORS = {
  pending: "#94a3b8",
  delivering: "#0284c7",
  delivered: "#16a34a",
  failed: "#dc2626",
};

const DELIVERY_LABELS: Record<string, string> = {
  pending: "待处理",
  delivering: "生成中",
  delivered: "已归档",
  failed: "失败",
};

export function DashboardPage() {
  const navigate = useNavigate();
  const [now, setNow] = useState(() => new Date().toISOString());
  const { data, error, retry } = useApi<DashboardData>("/api/admin/dashboard");

  const handleRefresh = () => {
    setNow(new Date().toISOString());
    retry();
  };

  if (error) return <ErrorPanel error={error} onRetry={handleRefresh} />;
  if (!data) return <SkeletonPanel lines={6} />;

  const deliveries = data.reportDeliveries;
  const deliveryTotal = deliveries.pending + deliveries.delivering + deliveries.delivered + deliveries.failed;
  const deliveryDonut = donutOption(
    Object.entries(deliveries)
      .filter(([, v]) => v > 0)
      .map(([key, value]) => ({
        name: DELIVERY_LABELS[key] ?? key,
        value,
        color: DELIVERY_COLORS[key as keyof typeof DELIVERY_COLORS] ?? "#64748b",
      })),
    { radius: ["50%", "75%"], center: ["35%", "50%"] },
  );

  const METRICS = [
    { key: "users", label: "用户数量", icon: Users, tint: "bg-[color-mix(in_srgb,var(--color-primary)_10%,var(--surface))] text-[var(--color-primary)]" },
    { key: "surveys", label: "问卷数量", icon: ClipboardList, tint: "bg-[color-mix(in_srgb,var(--color-info)_12%,var(--surface))] text-[var(--color-info)]" },
    { key: "publishedSurveys", label: "已发布问卷", icon: FileText, tint: "bg-[color-mix(in_srgb,var(--color-success)_12%,var(--surface))] text-[var(--color-success)]" },
    { key: "responses", label: "答卷数量", icon: Archive, tint: "bg-[color-mix(in_srgb,var(--color-primary)_10%,var(--surface))] text-[var(--color-primary)]" },
    { key: "todayResponses", label: "今日答卷", icon: Activity, tint: "bg-[color-mix(in_srgb,var(--color-warning)_12%,var(--surface))] text-[var(--color-warning)]" },
  ] as const;

  const deliveryItems: Array<{ label: string; value: number; status: string; icon: typeof Package; tint: string }> = [
    { label: "待处理", value: deliveries.pending, status: "pending", icon: Clock, tint: "bg-[var(--surface-muted)] text-[var(--color-muted)]" },
    { label: "生成中", value: deliveries.delivering, status: "delivering", icon: Loader, tint: "bg-[color-mix(in_srgb,var(--color-info)_12%,var(--surface))] text-[var(--color-info)]" },
    { label: "已归档", value: deliveries.delivered, status: "delivered", icon: CheckCircle2, tint: "bg-[color-mix(in_srgb,var(--color-success)_12%,var(--surface))] text-[var(--color-success)]" },
    { label: "失败", value: deliveries.failed, status: "failed", icon: XCircle, tint: "bg-[color-mix(in_srgb,var(--color-danger)_10%,var(--surface))] text-[var(--color-danger)]" },
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
    <div className="space-y-5">
      <div className="admin-page-intro"><div><h2>运营总览</h2><p>查看问卷、答卷与报告交付的实时状态</p></div></div>
      <section className="card">
        <div className="card-title">
          <div>
            <h2>数据总览</h2>
            <p className="card-sub">核心运营指标</p>
          </div>
          <button className="btn btn-sm" onClick={handleRefresh} title="刷新数据">
            <RefreshCw className="h-3.5 w-3.5" />
            刷新
          </button>
        </div>

        <div className="admin-stat-grid mt-5">
          {METRICS.map(({ key, label, icon: Icon, tint }) => (
            <div key={key} className="admin-stat">
              <div className="flex items-center gap-2 text-sm text-[var(--color-muted)]">
                <span className={`grid h-7 w-7 place-items-center rounded-lg ${tint}`}>
                  <Icon className="h-4 w-4" />
                </span>
                {label}
              </div>
              <div className="mt-2 text-2xl font-bold font-tabular-nums">{Number(data[key] ?? 0)}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-5 card">
        <div className="card-title">
          <div>
            <h2>报告交付队列</h2>
            <p className="card-sub">Telegram 频道自动归档 · 共 {deliveryTotal} 份</p>
          </div>
          <Link className="btn btn-sm" to="/reports">查看全部</Link>
        </div>
        <div className="mt-4 grid gap-5 lg:grid-cols-[1fr_260px] items-center">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
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
                <div className="flex items-center gap-2 text-sm">
                  <span className={`grid h-7 w-7 place-items-center rounded-lg ${tint}`}>
                    <Icon className="h-4 w-4" />
                  </span>
                  {label}
                </div>
                <div className={`mt-2 text-2xl font-bold font-tabular-nums ${label === "失败" && value > 0 ? "text-[var(--color-danger)]" : ""}`}>
                  {value}
                </div>
              </Link>
            ))}
          </div>
          <div className="rounded-xl border border-[var(--color-edge)] p-2">
            {deliveryTotal > 0 ? (
              <EChart option={deliveryDonut} style={{ height: 180 }} opts={{ renderer: "svg" }} />
            ) : (
              <EmptyPanel text="暂无报告" />
            )}
          </div>
        </div>
      </section>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        {data.recentSurveys?.length ? (
          <section className="card">
            <div className="card-title">
              <h2>最近问卷</h2>
              <Link className="btn btn-sm" to="/surveys">全部问卷</Link>
            </div>
            <div className="mt-3 overflow-x-auto">
              <table className="tbl">
                <tbody>
                  {data.recentSurveys.map((item) => (
                    <tr key={item.id} className="cursor-pointer" onClick={() => navigate(`/surveys/${item.id}`)}>
                      <td>
                        <strong>{item.title || "未命名问卷"}</strong>
                      </td>
                      <td className="text-right">
                        <StatusBadge status={item.status} />
                      </td>
                      <td className="muted text-right">{formatDateTime(item.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}

        {data.recentResponses?.length ? (
          <section className="card">
            <div className="card-title">
              <h2>最近答卷</h2>
              <Link className="btn btn-sm" to="/responses">全部答卷</Link>
            </div>
            <div className="mt-3 overflow-x-auto">
              <table className="tbl">
                <thead>
                  <tr>
                    <th className="text-sm text-[var(--color-muted)]">问卷</th>
                    <th className="text-sm text-[var(--color-muted)]">填写者</th>
                    <th className="text-sm text-[var(--color-muted)]">时间</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recentResponses.slice(0, 6).map((item) => {
                    const respondentText = item.respondent
                      ? [item.respondent.firstName, item.respondent.lastName].filter(Boolean).join(" ") ||
                        (item.respondent.username ? `@${item.respondent.username}` : String(item.respondent.telegramUserId))
                      : item.participantKey
                        ? `网页参与 · ${item.participantKey}`
                        : "匿名";
                    return (
                      <tr
                        key={item.id}
                        className="cursor-pointer"
                        onClick={() => navigate(`/surveys/${item.surveyId}/responses/${item.id}`)}
                      >
                        <td>
                          <strong>{item.title || `问卷 ${item.surveyId}`}</strong>
                        </td>
                        <td className="text-sm">{respondentText}</td>
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

      {data.recentActions?.length ? (
        <section className="mt-5 card">
          <h2 className="text-base font-semibold">最近操作</h2>
          <ul className="mt-3 divide-y divide-edge-soft">
            {data.recentActions.map((action) => (
              <li key={action.id} className="flex items-center justify-between gap-3 py-2.5 text-sm flex-wrap">
                <span className="min-w-0 flex-1 truncate">
                  {actionLabels[action.action] ?? action.action}
                  <span className="muted"> · {action.entityType} #{action.entityId ?? "-"}</span>
                </span>
                <span className="muted shrink-0">{formatDateTime(action.createdAt)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
