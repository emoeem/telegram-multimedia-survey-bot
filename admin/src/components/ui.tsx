import type { ReactNode } from "react";
import { ApiError } from "../api";
import { STATUS_LABELS } from "../format";
import type { SurveyStatus } from "../api";

const BADGE_CLASSES: Record<SurveyStatus, string> = {
  draft: "bg-gray-200 text-gray-700",
  published: "bg-green-100 text-green-800",
  closed: "bg-orange-100 text-orange-800",
  archived: "bg-red-100 text-red-800",
};

export function StatusBadge({ status }: { status: SurveyStatus }) {
  const known = status in STATUS_LABELS;
  return (
    <span className={`inline-block whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs ${known ? BADGE_CLASSES[status] : "bg-gray-200 text-gray-700"}`}>
      {known ? STATUS_LABELS[status] : (status || "-")}
    </span>
  );
}

export function SkeletonPanel({ lines = 4 }: { lines?: number }) {
  const widths = ["w-2/5", "w-11/12", "w-3/4", "w-5/6"];
  return (
    <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
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
    <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
      <h2 className="text-lg font-semibold">{title}</h2>
      {hint ? <p className="mt-1 text-sm text-gray-500">{hint}</p> : null}
      <div className="mt-4">
        <button className="btn" onClick={onRetry}>
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
}: {
  text: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="py-12 text-center text-gray-500">
      <div className="mb-2 text-3xl">📝</div>
      <div>{text}</div>
      {actionLabel && onAction ? (
        <div className="mt-4">
          <button className="btn" onClick={onAction}>
            {actionLabel}
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function PageHeader({ title, actions }: { title: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-7 flex items-center justify-between gap-3">
      <h1 className="text-xl font-bold sm:text-[28px]">{title}</h1>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}
