import { useEffect, useState } from "react";
import { EChart } from "../components/EChart";
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
  RefreshCw,
  Users,
  XCircle,
} from "lucide-react";
import { donutOption } from "../charts";
import { useApi } from "../hooks";
import type { DashboardData } from "../api";
import { EmptyPanel, ErrorPanel, SkeletonPanel, StatusBadge } from "../components/ui";
import { StatCard } from "../components/StatCard";
import { formatDateTime } from "../format";
import { fetchDeploymentInfo, type DeploymentInfo, type PlanCapabilities } from "../api";

const PLAN_TIER_LABELS: Record<NonNullable<PlanCapabilities["tier"]>, string> = {
  free: "Free 部署",
  paid: "Paid 部署",
  pro: "Pro 部署",
};

const PLAN_TIER_TINTS: Record<NonNullable<PlanCapabilities["tier"]>, string> = {
  free: "bg-[var(--surface-muted)] text-[var(--color-muted)]",
  paid: "bg-[color-mix(in_srgb,var(--app-info)_12%,var(--surface))] text-[var(--app-info)]",
  pro: "bg-[color-mix(in_srgb,var(--app-success)_12%,var(--surface))] text-[var(--app-success)]",
};

const PLAN_CAPABILITY_LABELS: Record<keyof Omit<PlanCapabilities, "tier">, string> = {
  r2Media: "R2 媒体存储",
  streamVideo: "Stream 视频托管",
  imagesPipeline: "Images 图片管线",
  browserRender: "PDF/分享图渲染",
  asyncQueue: "异步任务队列",
  rateLimitDO: "原子限流",
};

/** 部署能力面板：当前档位 + 每项付费能力，附 Free 部署的降级说明。 */
function PlanCapabilityCard() {
  const [info, setInfo] = useState<DeploymentInfo | null>(null);
  useEffect(() => {
    void fetchDeploymentInfo().then(setInfo);
  }, []);
  if (!info?.plan) return null;
  const { plan, planFallbacks } = info;
  const capabilities = Object.entries(PLAN_CAPABILITY_LABELS) as Array<[keyof Omit<PlanCapabilities, "tier">, string]>;
  return (
    <section className="mt-5 card">
      <div className="card-title">
        <div>
          <h2>部署能力</h2>
          <p className="card-sub">按部署绑定的付费资源自动探测 · 免费部署自动降级，功能不缺失</p>
        </div>
        <span className={`rounded-full px-3 py-1 text-xs font-semibold ${PLAN_TIER_TINTS[plan.tier]}`}>
          {PLAN_TIER_LABELS[plan.tier]}
        </span>
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {capabilities.map(([key, label]) => {
          const on = plan[key];
          const fallback = planFallbacks?.[key];
          return (
            <div
              key={key}
              className="flex items-start gap-2.5 rounded-xl border border-[var(--border)] px-3 py-2.5"
              title={on ? `${label} 已启用` : `${label} 未启用：${fallback ?? "走免费路径"}`}
            >
              {on ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[var(--app-success)]" />
              ) : (
                <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-muted)]" />
              )}
              <div className="min-w-0">
                <p className="text-sm font-medium">{label}</p>
                {!on && fallback ? <p className="mt-0.5 text-xs text-[var(--color-muted)]">{fallback}</p> : null}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

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
  // Rendered in the header: it was tracked but never displayed, so "刷新" gave
  // no indication that anything had been refetched.
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
      tint: "bg-[color-mix(in_srgb,var(--app-info)_12%,var(--surface))] text-[var(--app-info)]",
    },
    {
      key: "publishedSurveys",
      label: "已发布问卷",
      icon: FileText,
      tint: "bg-[color-mix(in_srgb,var(--app-success)_12%,var(--surface))] text-[var(--app-success)]",
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
      tint: "bg-[color-mix(in_srgb,var(--app-warning)_12%,var(--surface))] text-[var(--app-warning)]",
    },
  ] as const;

  const deliveryItems: Array<{ label: string; value: number; status: string; icon: typeof Package; tint: string }> = [
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
      tint: "bg-[color-mix(in_srgb,var(--app-info)_12%,var(--surface))] text-[var(--app-info)]",
    },
    {
      label: "已归档",
      value: deliveries.delivered,
      status: "delivered",
      icon: CheckCircle2,
      tint: "bg-[color-mix(in_srgb,var(--app-success)_12%,var(--surface))] text-[var(--app-success)]",
    },
    {
      label: "失败",
      value: deliveries.failed,
      status: "failed",
      icon: XCircle,
      tint: "bg-[color-mix(in_srgb,var(--app-danger)_10%,var(--surface))] text-[var(--app-danger)]",
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
    <div className="space-y-5">
      <div className="admin-page-intro">
        <div>
          <h2>运营总览</h2>
          <p>查看问卷、答卷与报告交付的实时状态</p>
        </div>
      </div>
      <section className="card">
        <div className="card-title">
          <div>
            <h2>数据总览</h2>
            <p className="card-sub">
              核心运营指标 · 更新于 {new Date(now).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}
            </p>
          </div>
          <button className="btn btn-sm" onClick={handleRefresh} title="刷新数据">
            <RefreshCw className="h-3.5 w-3.5" />
            刷新
          </button>
        </div>

        <div className="admin-stat-grid mt-5">
          {METRICS.map(({ key, label, icon: Icon, tint }) => (
            <StatCard
              key={key}
              label={label}
              value={Number(data[key] ?? 0)}
              icon={<Icon className="h-4 w-4" />}
              tint={tint}
            />
          ))}
        </div>
      </section>

      <section className="mt-5 card">
        <div className="card-title">
          <div>
            <h2>报告交付队列</h2>
            <p className="card-sub">Telegram 频道自动归档 · 共 {deliveryTotal} 份</p>
          </div>
          <Link className="btn btn-sm" to="/reports">
            查看全部
          </Link>
        </div>
        <div className="mt-4 grid gap-5 lg:grid-cols-[1fr_260px] items-center">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {deliveryItems.map(({ label, value, status, icon: Icon, tint }) => (
              <StatCard
                key={label}
                label={label}
                value={value}
                icon={<Icon className="h-4 w-4" />}
                tint={tint}
                tone={label === "失败" && value > 0 ? "danger" : "default"}
                to={`/reports?status=${status}`}
                ariaLabel={`${label} ${value}，查看报告归档`}
              />
            ))}
          </div>
          <div className="rounded-surface border border-[var(--color-edge)] p-2">
            {deliveryTotal > 0 ? (
              <EChart option={deliveryDonut} style={{ height: 180 }} opts={{ renderer: "svg" }} />
            ) : (
              <EmptyPanel text="暂无报告" />
            )}
          </div>
        </div>
      </section>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        {
          <section className="card">
            <div className="card-title">
              <h2>最近问卷</h2>
              <Link className="btn btn-sm" to="/surveys">
                全部问卷
              </Link>
            </div>
            {(data.recentSurveys ?? []).length ? (
              <div className="mt-3 overflow-x-auto" tabIndex={0} aria-label="最近问卷列表">
                <table className="tbl">
                  <tbody>
                  {(data.recentSurveys ?? []).slice(0, 6).map((item) => (
                    <tr
                      key={item.id}
                      className="cursor-pointer"
                      role="button"
                      tabIndex={0}
                      onClick={() => navigate(`/surveys/${item.id}`)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          navigate(`/surveys/${item.id}`);
                        }
                      }}
                    >
                      <td data-label="问卷">
                        <strong>{item.title || "未命名问卷"}</strong>
                      </td>
                      <td className="text-right" data-label="状态">
                        <StatusBadge status={item.status} />
                      </td>
                      <td className="muted text-right" data-label="更新时间">
                        {formatDateTime(item.updatedAt)}
                      </td>
                    </tr>
                  ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="mt-3">
                {/* 空态整块消失会被误读成加载失败——区块常驻，只换内容。 */}
                <EmptyPanel text="还没有问卷。创建第一份问卷后，这里会显示最近编辑的问卷。" />
              </div>
            )}
          </section>
        }

        {
          <section className="card">
            <div className="card-title">
              <h2>最近答卷</h2>
              <Link className="btn btn-sm" to="/responses">
                全部答卷
              </Link>
            </div>
            {(data.recentResponses ?? []).length ? (
              <div className="mt-3 overflow-x-auto" tabIndex={0} aria-label="最近答卷列表">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th className="text-sm text-[var(--color-muted)]">问卷</th>
                      <th className="text-sm text-[var(--color-muted)]">填写者</th>
                      <th className="text-sm text-[var(--color-muted)]">时间</th>
                    </tr>
                  </thead>
                  <tbody>
                  {(data.recentResponses ?? []).slice(0, 6).map((item) => {
                    const respondentText = item.respondent
                      ? [item.respondent.firstName, item.respondent.lastName].filter(Boolean).join(" ") ||
                        (item.respondent.username
                          ? `@${item.respondent.username}`
                          : String(item.respondent.telegramUserId))
                      : item.participantKey
                        ? `网页参与 · ${item.participantKey}`
                        : "匿名";
                    return (
                      <tr
                        key={item.id}
                        className="cursor-pointer"
                        role="button"
                        tabIndex={0}
                        onClick={() => navigate(`/surveys/${item.surveyId}/responses/${item.id}`)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            navigate(`/surveys/${item.surveyId}/responses/${item.id}`);
                          }
                        }}
                      >
                        <td data-label="问卷">
                          <strong>{item.title || `问卷 ${item.surveyId}`}</strong>
                        </td>
                        <td className="text-sm" data-label="填写者">
                          {respondentText}
                        </td>
                        <td className="muted" data-label="时间">
                          {formatDateTime(item.updatedAt)}
                        </td>
                      </tr>
                    );
                  })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="mt-3">
                <EmptyPanel text="还没有答卷。问卷收到提交后，这里会显示最近的答卷。" />
              </div>
            )}
          </section>
        }
      </div>

      {data.recentActions?.length ? (
        <section className="mt-5 card">
          <h2 className="text-base font-semibold">最近操作</h2>
          <ul className="mt-3 divide-y divide-edge-soft">
            {data.recentActions.map((action) => (
              <li key={action.id} className="flex items-center justify-between gap-3 py-2.5 text-sm flex-wrap">
                <span className="min-w-0 flex-1 truncate">
                  {actionLabels[action.action] ?? action.action}
                  <span className="muted">
                    {" "}
                    · {action.entityType} #{action.entityId ?? "-"}
                  </span>
                </span>
                <span className="muted shrink-0">{formatDateTime(action.createdAt)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <PlanCapabilityCard />
    </div>
  );
}
