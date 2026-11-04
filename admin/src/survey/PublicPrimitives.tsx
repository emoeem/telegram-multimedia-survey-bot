import type { ReactNode } from "react";
import { AlertTriangle, ArrowRight, Compass, type LucideIcon } from "lucide-react";

/**
 * 公开页共用的小组件（2026-11）。
 *
 * 这些形状在 /me、/coins、/plaza、/notes、/series 里各写过一遍：11px 小节标题、
 * 纯文字空态、把 ErrorBox 当空态用、手写「图标 + 标题 + 副标题 + 箭头」行。
 * 统一到这里后，间距、圆角、颜色只走 --survey-* token。
 */

export function SectionHeader({
  icon: Icon,
  title,
  count,
  action,
}: {
  icon?: LucideIcon;
  title: string;
  count?: number;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <h2 className="flex min-w-0 items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.08em] text-[var(--survey-muted)]">
        {Icon ? <Icon className="h-3.5 w-3.5 shrink-0 text-[var(--survey-primary)]" aria-hidden="true" /> : null}
        <span className="truncate">{title}</span>
        {typeof count === "number" ? (
          <span className="shrink-0 rounded-full bg-[var(--survey-primary-soft)] px-1.5 py-0.5 text-[10px] font-bold text-[var(--survey-primary)] tabular-nums">
            {count}
          </span>
        ) : null}
      </h2>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function EmptyState({
  icon: Icon = Compass,
  title,
  description,
  action,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="survey-card flex flex-col items-center gap-3 px-5 py-10 text-center">
      <span className="grid h-12 w-12 place-items-center rounded-2xl bg-[var(--survey-primary-soft)] text-[var(--survey-primary)]">
        <Icon className="h-6 w-6" aria-hidden="true" />
      </span>
      <p className="text-sm font-semibold text-[var(--survey-heading)]">{title}</p>
      {description ? <p className="max-w-sm text-xs leading-5 text-[var(--survey-muted)]">{description}</p> : null}
      {action}
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
  retryLabel = "重试",
}: {
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div className="survey-card flex flex-col items-center gap-3 px-5 py-8 text-center">
      <span className="grid h-11 w-11 place-items-center rounded-2xl bg-[color-mix(in_srgb,var(--app-danger)_12%,transparent)] text-[var(--app-danger)]">
        <AlertTriangle className="h-5 w-5" aria-hidden="true" />
      </span>
      <p className="max-w-sm text-sm leading-6 text-[var(--survey-body)]">{message}</p>
      {onRetry ? (
        <button type="button" className="btn btn-primary btn-sm px-5" onClick={onRetry}>
          {retryLabel}
        </button>
      ) : null}
    </div>
  );
}

/** 列表骨架：默认三张卡，页面可按需传行数。 */
export function LoadingState({ label = "加载中…", rows = 3 }: { label?: string; rows?: number }) {
  return (
    <div className="space-y-3" aria-busy="true" aria-label={label}>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="survey-card p-4">
          <div className="mb-2 h-3.5 w-2/5 animate-pulse rounded-full bg-[var(--survey-primary-soft)]" />
          <div className="mb-1.5 h-3 w-4/5 animate-pulse rounded-full bg-[var(--survey-primary-soft)]" />
          <div className="h-3 w-3/5 animate-pulse rounded-full bg-[var(--survey-primary-soft)]" />
        </div>
      ))}
    </div>
  );
}

export function EntryRow({
  icon: Icon,
  title,
  subtitle,
  href,
  onClick,
  trailing,
  external = false,
}: {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
  href?: string;
  onClick?: () => void;
  trailing?: ReactNode;
  /** 外部链接（Telegram 群、投稿机器人）：新窗口打开并带 noreferrer。 */
  external?: boolean;
}) {
  const content = (
    <>
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-[var(--survey-primary-soft)] text-[var(--survey-primary)]">
        <Icon className="h-5 w-5" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-bold text-[var(--survey-heading)]">{title}</span>
        {subtitle ? <span className="mt-0.5 block truncate text-xs text-[var(--survey-muted)]">{subtitle}</span> : null}
      </span>
      {trailing ?? <ArrowRight className="h-4 w-4 shrink-0 text-[var(--survey-muted)]" aria-hidden="true" />}
    </>
  );
  const className =
    "survey-card group flex w-full items-center gap-3 px-4 py-3 text-left transition-[transform,box-shadow] duration-[var(--fx-dur)] ease-[var(--fx-ease)] hover:-translate-y-0.5 hover:shadow-[var(--fx-glow-md)]";
  if (href) {
    return (
      <a href={href} className={className} {...(external ? { target: "_blank", rel: "noreferrer" } : {})}>
        {content}
      </a>
    );
  }
  return (
    <button type="button" className={className} onClick={onClick}>
      {content}
    </button>
  );
}

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  className = "",
}: {
  value: T;
  options: ReadonlyArray<{ id: T; label: string; count?: number; disabled?: boolean }>;
  onChange: (id: T) => void;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <div
      className={`inline-flex items-center rounded-full border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] p-1 ${className}`}
      role="group"
      aria-label={ariaLabel}
    >
      {options.map((option) => {
        const active = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={active}
            disabled={option.disabled}
            onClick={() => onChange(option.id)}
            className={`rounded-full px-3.5 py-1.5 text-[13px] font-semibold transition-colors disabled:opacity-40 ${
              active
                ? "bg-[var(--survey-primary)] text-[var(--survey-primary-content)]"
                : "text-[var(--survey-muted)] hover:text-[var(--survey-heading)]"
            }`}
          >
            {option.label}
            {typeof option.count === "number" ? (
              <span className={`ml-1 text-[11px] ${active ? "opacity-80" : "opacity-60"}`}>{option.count}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
