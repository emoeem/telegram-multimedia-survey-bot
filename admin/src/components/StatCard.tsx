import type { ReactNode } from "react";
import { Link } from "react-router";

/**
 * One metric card, shared by 运营总览 and 报告归档.
 *
 * Before this the two screens grew two different cards for the same job: the
 * dashboard used `.admin-stat` (16px radius, 112px minimum height, a 5% glow
 * and a `clamp(24px, 3vw, 32px)` number) while 报告归档 hand-rolled a
 * `<button className="rounded-xl border p-4 …">` with a 24px number and a
 * 12px radius. Next to each other they read as two products.
 *
 * The visual definition lives in CSS (`.admin-stat*`) rather than in Tailwind
 * strings here, so a filter card, a link card and a plain card cannot drift
 * apart again.
 */
export interface StatCardProps {
  label: string;
  value: ReactNode;
  /** Rendered at 16px inside the tinted chip. */
  icon?: ReactNode;
  /** Tailwind colour utilities for the chip, e.g. "bg-[…] text-[…]". */
  tint?: string;
  /** Small caption under the number (e.g. "已卡 12 分钟"). */
  hint?: string;
  tone?: "default" | "danger";
  /** Renders as a filter button and exposes `aria-pressed`. */
  onClick?: () => void;
  /** Renders as a link. */
  to?: string;
  active?: boolean;
  /** Overrides the accessible name; defaults to label + value. */
  ariaLabel?: string;
}

export function StatCard({
  label,
  value,
  icon,
  tint,
  hint,
  tone = "default",
  onClick,
  to,
  active = false,
  ariaLabel,
}: StatCardProps) {
  const className = ["admin-stat", active ? "is-active" : "", tone === "danger" ? "is-danger" : ""]
    .filter(Boolean)
    .join(" ");

  const body = (
    <>
      <div className="admin-stat-label">
        {icon ? <span className={`admin-stat-icon ${tint ?? ""}`}>{icon}</span> : null}
        <span>{label}</span>
      </div>
      <div className={`admin-stat-value ${tone === "danger" ? "is-danger" : ""}`}>{value}</div>
      {hint ? <div className="admin-stat-hint">{hint}</div> : null}
      {active ? <span className="sr-only">（当前筛选）</span> : null}
    </>
  );

  const accessibleName = ariaLabel ?? `${label} ${value}`;

  if (to) {
    return (
      <Link to={to} className={className} aria-label={accessibleName}>
        {body}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button type="button" className={className} onClick={onClick} aria-pressed={active} aria-label={accessibleName}>
        {body}
      </button>
    );
  }
  return <div className={className}>{body}</div>;
}
