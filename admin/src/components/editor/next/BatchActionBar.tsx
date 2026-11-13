import { useState } from "react";
import { ListChecks, X } from "lucide-react";

/**
 * 批量操作条（G7b）：结构树勾选 ≥1 题后出现在画布列表底部。
 * 只做批量必答/选填与批量移动分页，动作全部走 editor-actions 的
 * applyBatchQuestionUpdates 更新路径（一次批量 = 一步撤销）。
 */
export function BatchActionBar({
  count,
  pages,
  disabled,
  onSetRequired,
  onMoveToPage,
  onClear,
}: {
  count: number;
  pages: Array<{ id: number; title: string | null; order: number }>;
  disabled: boolean;
  onSetRequired: (required: boolean) => void;
  onMoveToPage: (pageId: number | null) => void;
  onClear: () => void;
}) {
  // 分页下拉用占位值承载「未选择」：真实动作只在选定具体分页/不分页时发出。
  const [pageChoice, setPageChoice] = useState("");
  const moveToPage = (value: string) => {
    setPageChoice("");
    if (value === "none") onMoveToPage(null);
    else if (value) onMoveToPage(Number(value));
  };
  return (
    <div
      className="batch-bar flex flex-wrap items-center gap-2 rounded-lg border px-2.5 py-2 text-xs"
      style={{ borderColor: "var(--color-edge)", background: "var(--surface)" }}
      role="toolbar"
      aria-label="批量操作"
      data-testid="batch-bar"
    >
      <span className="inline-flex items-center gap-1.5 font-semibold text-[var(--color-ink)]">
        <ListChecks className="h-3.5 w-3.5 text-[var(--color-primary)]" aria-hidden="true" />
        已选 {count} 题
      </span>
      <button
        type="button"
        className="rounded-md border border-[var(--color-edge)] px-2 py-1 font-semibold transition hover:border-[var(--color-primary)] disabled:opacity-50"
        disabled={disabled || count === 0}
        data-testid="batch-required"
        onClick={() => onSetRequired(true)}
      >
        设为必答
      </button>
      <button
        type="button"
        className="rounded-md border border-[var(--color-edge)] px-2 py-1 font-semibold transition hover:border-[var(--color-primary)] disabled:opacity-50"
        disabled={disabled || count === 0}
        data-testid="batch-optional"
        onClick={() => onSetRequired(false)}
      >
        设为选填
      </button>
      <select
        aria-label="批量移动到分页"
        className="rounded-md border border-[var(--color-edge)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--color-ink)] disabled:opacity-50"
        style={{ color: pageChoice ? undefined : "var(--color-muted)" }}
        value={pageChoice}
        disabled={disabled || count === 0}
        data-testid="batch-page-select"
        onChange={(event) => moveToPage(event.target.value)}
      >
        <option value="">移动到分页…</option>
        {pages.map((page) => (
          <option key={page.id} value={page.id}>
            {page.title || `第 ${page.order + 1} 页`}
          </option>
        ))}
        <option value="none">不分页</option>
      </select>
      <button
        type="button"
        className="ml-auto inline-flex items-center gap-1 text-[var(--color-muted)] transition hover:text-[var(--color-ink)]"
        onClick={onClear}
        data-testid="batch-clear"
      >
        <X className="h-3.5 w-3.5" />
        清除选择
      </button>
    </div>
  );
}
