import { useEffect, useMemo, useRef } from "react";
import { ChevronRight, Flag, GitBranch, Gamepad2, X } from "lucide-react";
import { trapFocusWithin } from "../../focus-trap";
import { collectFlagOverview, type FlagEntry, type FlagUsage } from "../../../editor/flag-overview";

const KIND_META: Record<FlagUsage["kind"], { label: string; icon: typeof Flag; color: string }> = {
  // 产出点（计分规则挂在题的 condition 里）用主色，消费点（跳题）用信息色，
  // 游戏题的自动 flag 用中性暖色——三类一眼可分。
  scoring: { label: "计分规则", icon: Flag, color: "var(--color-primary)" },
  jump: { label: "跳题规则", icon: GitBranch, color: "var(--app-info)" },
  game: { label: "游戏通关", icon: Gamepad2, color: "var(--app-warning)" },
};

function UsageRow({
  usage,
  onSelectQuestion,
  onClose,
}: {
  usage: FlagUsage;
  onSelectQuestion: (questionId: number) => void;
  onClose: () => void;
}) {
  const meta = KIND_META[usage.kind];
  const Icon = meta.icon;
  return (
    <button
      type="button"
      className="flex w-full items-start gap-3 px-4 py-2.5 text-left transition-colors hover:bg-[var(--surface-hover)]"
      data-testid={`flag-usage-${usage.questionId}`}
      onClick={() => {
        onSelectQuestion(usage.questionId);
        onClose();
      }}
    >
      <span
        className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full"
        style={{ background: "var(--surface-muted)", color: meta.color }}
      >
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-[12px] font-semibold" style={{ color: meta.color }}>
            {meta.label}
          </span>
          <span className="truncate text-[11px] text-[var(--color-muted)]">· {usage.questionTitle}</span>
        </span>
        <span className="mt-0.5 block text-xs leading-5 text-[var(--color-muted)]">{usage.detail}</span>
      </span>
      <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-[var(--color-muted-soft)]" />
    </button>
  );
}

/**
 * flag/变量总览（G7c）：一屏列出当前问卷全部 flag 与使用点（题面计分规则 /
 * 跳题规则 / 游戏题自动 flag），点使用点定位到对应题目（选中并关闭）。
 * 数据由 collectFlagOverview 纯函数派生（与引擎语义对齐），面板只读不改数据。
 */
export function FlagOverviewPanel({
  open,
  questions,
  onClose,
  onSelectQuestion,
}: {
  open: boolean;
  questions: ReadonlyArray<{ id: number; type: string; title: string; condition: Record<string, unknown> | null }>;
  onClose: () => void;
  onSelectQuestion: (questionId: number) => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const entries = useMemo<FlagEntry[]>(() => (open ? collectFlagOverview(questions) : []), [open, questions]);

  useEffect(() => {
    if (!open) return undefined;
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
        aria-labelledby="flag-overview-title"
        className="survey-card flex max-h-[86dvh] w-full max-w-2xl flex-col overflow-hidden outline-none"
        onKeyDown={(event) => trapFocusWithin(panelRef.current, event.nativeEvent)}
        data-testid="flag-overview-panel"
      >
        <header className="flex items-start justify-between gap-3 border-b border-[var(--color-edge)] px-4 py-3.5">
          <div className="min-w-0">
            <h2
              id="flag-overview-title"
              className="flex items-center gap-2 text-[15px] font-bold text-[var(--color-ink)]"
            >
              <Flag className="h-4 w-4 text-[var(--color-primary)]" aria-hidden="true" />
              flag / 变量总览
            </h2>
            <p className="mt-1 text-xs leading-5 text-[var(--color-muted)]">
              全卷 {entries.length} 个 flag。点任意使用点可跳到对应的题目去改规则。
            </p>
          </div>
          <button type="button" className="btn btn-sm btn-quiet shrink-0" aria-label="关闭 flag 总览" onClick={onClose}>
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {entries.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
              <span className="grid h-12 w-12 place-items-center rounded-2xl bg-[var(--surface-muted)] text-[var(--color-muted)]">
                <Flag className="h-6 w-6" aria-hidden="true" />
              </span>
              <p className="text-sm font-semibold text-[var(--color-ink)]">这份问卷还没有 flag</p>
              <p className="max-w-sm text-xs leading-5 text-[var(--color-muted)]">
                在题目的「计分规则」里按答案置 flag，再在「跳题规则」里按 flag 门槛向前跳。
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-[var(--color-edge)]">
              {entries.map((entry) => {
                const produced = entry.usages.some((usage) => usage.kind !== "jump");
                const jumps = entry.usages.filter((usage) => usage.kind === "jump").length;
                return (
                  <li key={entry.flag}>
                    <div className="flex items-center gap-2 px-4 pb-1 pt-3">
                      <code
                        className="rounded-md bg-[var(--surface-muted)] px-1.5 py-0.5 text-[12px] font-semibold text-[var(--color-ink)]"
                        data-testid={`flag-entry-${entry.flag}`}
                      >
                        {entry.flag}
                      </code>
                      <span className="text-[11px] text-[var(--color-muted)]">{entry.usages.length} 个使用点</span>
                      {!produced ? (
                        <span className="text-[11px] font-semibold" style={{ color: "var(--app-warning)" }}>
                          没有产出点，门槛永不触发
                        </span>
                      ) : jumps === 0 ? (
                        <span className="text-[11px] text-[var(--color-muted)]">尚未被任何跳题使用</span>
                      ) : null}
                    </div>
                    {entry.usages.map((usage, index) => (
                      <UsageRow
                        key={`${usage.questionId}-${usage.kind}-${index}`}
                        usage={usage}
                        onSelectQuestion={onSelectQuestion}
                        onClose={onClose}
                      />
                    ))}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <footer className="border-t border-[var(--color-edge)] px-4 py-2.5 text-[11px] leading-5 text-[var(--color-muted)]">
          总览只读。结果规则（结局卡）按答案取值、不走 flag，因此不在此列；flag
          门槛与产出点的对齐情况可另见「问卷体检」。
        </footer>
      </div>
    </div>
  );
}
