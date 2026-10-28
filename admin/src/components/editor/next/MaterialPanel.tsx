import { useDraggable } from "@dnd-kit/core";
import { GripVertical, MousePointerClick, Plus, Sparkles, Trash2 } from "lucide-react";
import { QUESTION_TYPE_LABELS } from "../../../format";
import { TYPE_GROUPS } from "../TypePickerSheet";
import { TEMPLATE_OPTIONS } from "../../../editor/templates";

/** 物料区题型条目：点击加到末尾，拖到画布也是加到末尾（drop 才产生命令）。 */
function MaterialChip({ type, label, desc, disabled, onAdd }: { type: string; label: string; desc: string; disabled: boolean; onAdd: () => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `material:${type}`, disabled });
  return (
    <span
      ref={setNodeRef}
      className={`inline-flex items-stretch overflow-hidden rounded-lg border transition ${
        isDragging ? "opacity-40" : ""
      } ${disabled ? "opacity-50" : "border-[var(--color-edge)]"}`}
      title={desc}
    >
      <button
        type="button"
        className="grid w-4 cursor-grab touch-none place-items-center text-[var(--color-muted-soft)] hover:text-[var(--color-primary)]"
        aria-label={`拖动 ${label} 到画布`}
        disabled={disabled}
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-3 w-3" />
      </button>
      <button
        type="button"
        className="px-2 py-1 text-xs hover:text-[var(--color-primary)] disabled:opacity-50"
        disabled={disabled}
        onClick={onAdd}
      >
        {type === "note" ? "📖 " : ""}
        {label}
      </button>
    </span>
  );
}

/**
 * P2 物料区（左栏）：题目类型、互动场景、分页、模板。
 * 点击即插入（走 editor.addQuestion 的同一条待保存队列，可撤销）；
 * 拖拽定位是 S4，本轮先「点一下加到末尾」。
 */
export function MaterialPanel({
  disabled,
  sceneBusy,
  pages,
  onAddQuestion,
  onAddScene,
  onApplyTemplate,
  onAddPage,
  onDeletePage,
}: {
  disabled: boolean;
  sceneBusy: boolean;
  pages: Array<{ id: number; title: string | null; order: number }>;
  onAddQuestion: (type: string) => void;
  onAddScene: () => void;
  onApplyTemplate: (id: "survey" | "single-game" | "mixed") => void;
  onAddPage: () => void;
  onDeletePage: (pageId: number) => void;
}) {
  return (
    // 不自建滚动容器：.editor-structure 列本身就是滚动层（.editor-col）。
    <div className="flex flex-col gap-4 p-3">
      <section>
        <div className="mb-2 text-[11px] font-semibold tracking-wide" style={{ color: "var(--color-muted)" }}>
          题目
        </div>
        <div className="flex flex-col gap-2.5">
          {TYPE_GROUPS.map((group) => (
            <div key={group.title}>
              <div className="mb-1 text-[11px]" style={{ color: "var(--color-muted)" }} title={group.hint}>
                {group.title}
              </div>
              <div className="flex flex-wrap gap-1">
                {group.types.map(({ type, desc }) => (
                  <MaterialChip
                    key={type}
                    type={type}
                    label={`${type === "note" ? "📖 " : ""}${QUESTION_TYPE_LABELS[type] ?? type}`}
                    desc={desc}
                    disabled={disabled}
                    onAdd={() => onAddQuestion(type)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <div className="mb-2 text-[11px] font-semibold tracking-wide" style={{ color: "var(--color-muted)" }}>
          互动
        </div>
        <button
          type="button"
          disabled={disabled || sceneBusy}
          title="新建一道互动场景题，并打开场景编辑器"
          className="flex w-full items-center gap-1.5 rounded-lg border border-[var(--color-edge)] px-2 py-1.5 text-xs transition hover:border-[var(--color-primary)] disabled:opacity-50"
          onClick={onAddScene}
        >
          <MousePointerClick className="h-3.5 w-3.5" />
          互动场景（热点图）
        </button>
      </section>

      <section>
        <div className="mb-2 text-[11px] font-semibold tracking-wide" style={{ color: "var(--color-muted)" }}>
          分页
        </div>
        <div className="flex flex-col gap-1">
          {pages.map((page) => (
            <div
              key={page.id}
              className="flex items-center justify-between rounded-lg border border-[var(--color-edge)] px-2 py-1 text-xs"
            >
              <span className="truncate">{page.title || `第 ${page.order + 1} 页`}</span>
              <button
                type="button"
                className="row-action"
                title="删除分页（题目不会被删除）"
                disabled={disabled}
                onClick={() => onDeletePage(page.id)}
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))}
          <button
            type="button"
            disabled={disabled}
            className="flex items-center justify-center gap-1 rounded-lg border border-dashed border-[var(--color-edge)] px-2 py-1 text-xs text-[var(--color-muted)] transition hover:border-[var(--color-primary)] disabled:opacity-50"
            onClick={onAddPage}
          >
            <Plus className="h-3 w-3" />
            新建分页
          </button>
        </div>
      </section>

      <section>
        <div className="mb-2 flex items-center gap-1 text-[11px] font-semibold tracking-wide" style={{ color: "var(--color-muted)" }}>
          <Sparkles className="h-3 w-3" />
          模板
        </div>
        <div className="flex flex-col gap-1.5">
          {TEMPLATE_OPTIONS.map((template) => (
            <button
              key={template.id}
              type="button"
              disabled={disabled}
              title={template.desc}
              className="rounded-lg border border-[var(--color-edge)] px-2 py-1.5 text-left text-xs transition hover:border-[var(--color-primary)] disabled:opacity-50"
              onClick={() => onApplyTemplate(template.id)}
            >
              <span className="block font-semibold text-[var(--color-ink)]">{template.title}</span>
              <span className="block text-[10px] text-[var(--color-muted)]">{template.desc}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
