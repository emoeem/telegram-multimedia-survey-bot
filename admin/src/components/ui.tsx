import type { ReactNode } from "react";
import { AlertTriangle, Inbox, RotateCw } from "lucide-react";
import { ApiError } from "../api";
import { STATUS_LABELS } from "../format";
import type { SurveyStatus } from "../api";

const BADGE_CLASSES: Record<SurveyStatus, string> = {
  draft: "badge-gray badge-dot",
  published: "badge-green badge-dot",
  closed: "badge-amber badge-dot",
  archived: "badge-red badge-dot",
};

export function StatusBadge({ status }: { status: SurveyStatus }) {
  const known = status in STATUS_LABELS;
  return (
    <span className={`badge ${known ? BADGE_CLASSES[status] : "badge-gray"}`}>
      {known ? STATUS_LABELS[status] : status || "-"}
    </span>
  );
}

export function SkeletonPanel({ lines = 4 }: { lines?: number }) {
  const widths = ["w-2/5", "w-11/12", "w-3/4", "w-5/6"];
  return (
    <section className="card">
      <div className="skeleton mb-4 h-5 w-2/5" />
      {Array.from({ length: lines }, (_, index) => (
        <div key={index} className={`skeleton my-3 h-3.5 ${widths[index % widths.length]}`} />
      ))}
    </section>
  );
}

export function ErrorPanel({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
  const title =
    error.status === 401
      ? "请通过 Telegram 打开管理后台"
      : error.status === 403
        ? "403 无权访问"
        : error.status === 404
          ? "数据不存在"
          : "加载失败";
  const hint =
    error.status === 401
      ? "管理后台需要通过 Telegram 身份验证后访问。"
      : error.message && error.message !== title
        ? error.message
        : "";
  return (
    <section className="card">
      <div className="flex flex-col items-center gap-3 py-6 text-center">
        <span className="empty-icon">
          <AlertTriangle className="h-6 w-6" />
        </span>
        <div>
          <h2 className="text-base font-semibold">{title}</h2>
          {hint ? <p className="mt-1 text-sm text-[var(--color-muted)]">{hint}</p> : null}
        </div>
        <button className="btn" onClick={onRetry}>
          <RotateCw className="h-4 w-4" />
          重试
        </button>
      </div>
    </section>
  );
}

export function EmptyPanel({
  text,
  actionLabel,
  onAction,
  icon,
}: {
  text: string;
  actionLabel?: string;
  onAction?: () => void;
  icon?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-icon">{icon ?? <Inbox className="h-6 w-6" />}</span>
      <div>{text}</div>
      {actionLabel && onAction ? (
        <button className="btn mt-1" onClick={onAction}>
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}

export function PageHeader({ title, actions }: { title: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-7 flex items-center justify-between gap-3">
      <h1 className="text-xl font-bold tracking-tight sm:text-[26px]">{title}</h1>
      {actions ? <div className="toolbar">{actions}</div> : null}
    </header>
  );
}
