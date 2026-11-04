import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronRight, Info, Stethoscope, X } from "lucide-react";
import { trapFocusWithin } from "../../focus-trap";
import type { DiagnosticIssue, DiagnosticSeverity } from "../../../editor/diagnostics";

const SEVERITY_STYLE: Record<
  DiagnosticSeverity,
  { label: string; icon: typeof AlertTriangle; color: string; background: string }
> = {
  error: {
    label: "错误",
    icon: AlertTriangle,
    color: "var(--app-danger)",
    background: "color-mix(in srgb, var(--app-danger) 12%, transparent)",
  },
  warning: {
    label: "警告",
    icon: AlertTriangle,
    color: "var(--app-warning)",
    background: "color-mix(in srgb, var(--app-warning) 14%, transparent)",
  },
  info: {
    label: "提示",
    icon: Info,
    color: "var(--app-info)",
    background: "color-mix(in srgb, var(--app-info) 12%, transparent)",
  },
};

type Filter = "all" | "error" | "warning";

/**
 * 问卷体检面板（2026-11）。
 *
 * 只读视图：点一条问题只做「选中该题并关闭」，所有修复都走编辑器既有的
 * 本地 patch + 保存队列，因此可以整体 Ctrl+Z 回退。检查规则见
 * `admin/src/editor/diagnostics.ts`（与引擎的 forward-only 跳转语义对齐）。
 */
export function DiagnosticsPanel({
  open,
  issues,
  onClose,
  onSelectQuestion,
}: {
  open: boolean;
  issues: readonly DiagnosticIssue[];
  onClose: () => void;
  onSelectQuestion: (questionId: number) => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  useEffect(() => {
    if (!open) return undefined;
    // 每次打开都回到「全部」：上一次筛到「错误」、修完后重开会误以为没问题。
    setFilter("all");
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      restoreRef.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  const errors = issues.filter((issue) => issue.severity === "error").length;
  const warnings = issues.filter((issue) => issue.severity === "warning").length;
  const infoCount = issues.length - errors - warnings;
  const visible = filter === "all" ? issues : issues.filter((issue) => issue.severity === filter);

  return (
    <div
      className="fixed inset-0 z-[90] grid place-items-center bg-black/45 px-3 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="survey-diagnostics-title"
        className="survey-card flex max-h-[86dvh] w-full max-w-2xl flex-col overflow-hidden outline-none"
        onKeyDown={(event) => trapFocusWithin(panelRef.current, event.nativeEvent)}
      >
        <header className="flex items-start justify-between gap-3 border-b border-[var(--color-edge)] px-4 py-3.5">
          <div className="min-w-0">
            <h2
              id="survey-diagnostics-title"
              className="flex items-center gap-2 text-[15px] font-bold text-[var(--color-ink)]"
            >
              <Stethoscope className="h-4 w-4 text-[var(--color-primary)]" aria-hidden="true" />
              问卷体检
            </h2>
            <p className="mt-1 text-xs leading-5 text-[var(--color-muted)]">
              保存前先看一眼：以下问题会让引擎静默跳过规则，或让答题者卡住。
            </p>
          </div>
          <button type="button" className="btn btn-sm btn-quiet shrink-0" aria-label="关闭体检" onClick={onClose}>
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-edge)] px-4 py-2.5">
          {(
            [
              { id: "all", label: "全部", count: issues.length },
              { id: "error", label: "错误", count: errors },
              { id: "warning", label: "警告", count: warnings },
            ] as const
          ).map((entry) => (
            <button
              key={entry.id}
              type="button"
              aria-pressed={filter === entry.id}
              className={`rounded-full px-3 py-1 text-[12px] font-semibold transition-colors ${
                filter === entry.id
                  ? "bg-[var(--color-primary)] text-[var(--color-primary-content)]"
                  : "bg-[var(--surface-muted)] text-[var(--color-muted)]"
              }`}
              onClick={() => setFilter(entry.id)}
            >
              {entry.label}
              <span className="ml-1 text-[11px] opacity-75">{entry.count}</span>
            </button>
          ))}
          {infoCount > 0 ? (
            <span className="ml-auto text-[11px] text-[var(--color-muted)]">另有 {infoCount} 条提示</span>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {visible.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
              <span className="grid h-12 w-12 place-items-center rounded-2xl bg-[color-mix(in_srgb,var(--app-success)_14%,transparent)] text-[var(--app-success)]">
                <CheckCircle2 className="h-6 w-6" aria-hidden="true" />
              </span>
              <p className="text-sm font-semibold text-[var(--color-ink)]">
                {issues.length === 0 ? "没有发现结构问题" : "这一类没有问题"}
              </p>
              <p className="max-w-sm text-xs leading-5 text-[var(--color-muted)]">
                {issues.length === 0
                  ? "跳转、选项和 flag 都能对上；可以放心保存或发布。"
                  : "切换到「全部」查看其它级别的结果。"}
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-[var(--color-edge)]">
              {visible.map((issue) => {
                const style = SEVERITY_STYLE[issue.severity];
                const Icon = style.icon;
                const clickable = issue.questionId !== null;
                return (
                  <li key={issue.key}>
                    <button
                      type="button"
                      disabled={!clickable}
                      onClick={() => {
                        if (issue.questionId === null) return;
                        onSelectQuestion(issue.questionId);
                        onClose();
                      }}
                      className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--surface-hover)] disabled:cursor-default disabled:hover:bg-transparent"
                    >
                      <span
                        className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full"
                        style={{ background: style.background, color: style.color }}
                      >
                        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                          <span className="text-[13px] font-semibold text-[var(--color-ink)]">{issue.title}</span>
                          <span className="text-[11px] font-medium" style={{ color: style.color }}>
                            {style.label}
                          </span>
                          <span className="truncate text-[11px] text-[var(--color-muted)]">
                            · {issue.questionTitle}
                          </span>
                        </span>
                        <span className="mt-0.5 block text-xs leading-5 text-[var(--color-muted)]">{issue.detail}</span>
                      </span>
                      {clickable ? (
                        <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-[var(--color-muted-soft)]" />
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <footer className="border-t border-[var(--color-edge)] px-4 py-2.5 text-[11px] leading-5 text-[var(--color-muted)]">
          体检只读，不会自动改问卷；修完再点一次即可复查。所有修改仍可用 Ctrl+Z 回退。
        </footer>
      </div>
    </div>
  );
}
