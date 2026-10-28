import { ArrowDown, ArrowUp, Copy, Trash2 } from "lucide-react";
import type { EditableQuestion } from "../../../editor/useSurveyEditor";

/**
 * 选中卡片的快捷条（S3）：复制 / 上移 / 下移 / 必答 / 删除，浮层挂在画布
 * 激活卡上方。删除走依赖感知级联（requestDeleteQuestion：有跳转指向时先列
 * 影响面确认，确认后清引用 + 删除在同一条待保存队列里，Ctrl+Z 可整体回退）；
 * 复制沿用「直连 API + 刷新」的既有语义。
 */
export function QuickBar({
  question,
  editable,
  onDuplicate,
  onDelete,
  onMove,
  onToggleRequired,
}: {
  question: EditableQuestion;
  editable: boolean;
  onDuplicate: () => void;
  onDelete: () => void;
  onMove: (direction: -1 | 1) => void;
  onToggleRequired: () => void;
}) {
  const isNote = question.type === "note";
  return (
    <div
      role="toolbar"
      aria-label={`第 ${question.title || "未命名"} 的快捷操作`}
      className="absolute right-2 z-10 flex items-center gap-0.5 rounded-full border px-1 py-0.5 shadow-sm"
      style={{ top: "-12px", borderColor: "var(--color-edge)", background: "var(--surface)" }}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className="row-action"
        title="复制这道题"
        aria-label="复制这道题"
        disabled={!editable}
        onClick={onDuplicate}
      >
        <Copy className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        className="row-action"
        title="上移"
        aria-label="上移"
        disabled={!editable}
        onClick={() => onMove(-1)}
      >
        <ArrowUp className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        className="row-action"
        title="下移"
        aria-label="下移"
        disabled={!editable}
        onClick={() => onMove(1)}
      >
        <ArrowDown className="h-3.5 w-3.5" />
      </button>
      {!isNote ? (
        <button
          type="button"
          role="switch"
          aria-checked={question.required}
          aria-label="必答"
          title={question.required ? "已必答（点击改为选答）" : "设为必答"}
          disabled={!editable}
          data-on={question.required}
          className="row-action text-[10px] font-semibold"
          style={{
            width: "auto",
            padding: "0 6px",
            color: question.required ? "var(--color-primary)" : "var(--color-muted)",
          }}
          onClick={onToggleRequired}
        >
          必答
        </button>
      ) : null}
      <button
        type="button"
        className="row-action"
        title="删除这道题（会先列出受影响的跳转）"
        aria-label="删除这道题"
        disabled={!editable}
        style={{ color: "var(--app-danger)" }}
        onClick={onDelete}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
