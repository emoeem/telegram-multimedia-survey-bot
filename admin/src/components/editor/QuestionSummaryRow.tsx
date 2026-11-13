import { memo } from "react";
import { ArrowDown, ArrowUp, ChevronDown, GitBranch, Plus } from "lucide-react";
import { QUESTION_TYPE_LABELS } from "../../format";
import type { EditableQuestion } from "../../editor/useSurveyEditor";

/** condition.rules 的条数（旧壳与新壳的摘要卡共用）。 */
export function branchCountOf(question: EditableQuestion): number {
  const rules = (question.condition as { rules?: unknown } | null)?.rules;
  return Array.isArray(rules) ? rules.length : 0;
}

/**
 * 画布摘要卡（S2 从 EditorPage 抽出，两套壳共用）：
 * 序号 / 标题 / 类型 / 必答·分支·附件·未保存 标签 + 上移/下移/在此后插入。
 *
 * memo（E4）：打字热路径上壳每键击重渲染，未受影响的行靠 memo 跳过。
 * 生效前提是回调按 id 派发（见下）且调用方传稳定函数——useEditorActions
 * 已把动作身份钉死，Canvas 侧的选择回调也做了 useCallback。
 */
function QuestionSummaryRowImpl({
  question,
  index,
  editable,
  active,
  checked,
  onOpen,
  onMove,
  onInsertAfter,
  onToggleChecked,
}: {
  question: EditableQuestion;
  index: number;
  editable: boolean;
  active?: boolean;
  /** 批量多选（G7b）中是否勾选；undefined = 批量多选未启用。 */
  checked?: boolean;
  /** 按题目 id 派发：闭包不捕获单题，调用方才能传同一个稳定函数。
   *  第二参带原始事件，壳侧据此处理 ctrl/⌘/shift 多选修饰键（G7b）。 */
  onOpen: (questionId: number, event?: React.MouseEvent) => void;
  onMove: (questionId: number, direction: -1 | 1) => void;
  /** 在这道题后插入新题（G7a，hover 工具条入口）。 */
  onInsertAfter: (questionId: number) => void;
  /** 勾选/取消批量多选（G7b，hover 工具条入口）。 */
  onToggleChecked?: (questionId: number) => void;
}) {
  const isNote = question.type === "note";
  const branches = branchCountOf(question);
  // 外层不用 role="button"：内部还有上移/下移按钮，交互 role 嵌套会触发
  // axe nested-interactive（serious）。保留 tabIndex + 键盘激活的等价行为。
  return (
    <div
      className="q-row cursor-pointer"
      tabIndex={0}
      aria-current={active ? "true" : undefined}
      aria-label={`${index + 1}. ${question.title || (isNote ? "未命名剧情" : "未命名题目")}`}
      style={
        active
          ? { outline: "2px solid var(--color-primary)", outlineOffset: "-2px" }
          : checked
            ? { outline: "2px dashed var(--color-primary)", outlineOffset: "-2px" }
            : undefined
      }
      onClick={(event) => onOpen(question.id, event)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen(question.id);
        }
      }}
    >
      <span className={`q-row-index ${isNote ? "is-note" : ""}`}>{isNote ? "📖" : index + 1}</span>
      <span className="q-row-main">
        <span className="q-row-title">{question.title || (isNote ? "未命名剧情" : "未命名题目")}</span>
        <span className="q-row-meta">
          <span className="q-row-type">{QUESTION_TYPE_LABELS[question.type] ?? question.type}</span>
          {question.required && !isNote ? <span className="q-row-tag is-req">必答</span> : null}
          {branches > 0 ? (
            <span className="q-row-tag is-branch">
              <GitBranch className="h-3 w-3" />
              {branches} 分支
            </span>
          ) : null}
          {question.media.length ? <span className="q-row-tag">附件 ×{question.media.length}</span> : null}
          {question.id < 0 ? <span className="q-row-tag is-unsaved">未保存</span> : null}
        </span>
      </span>
      <span className="row-actions">
        {onToggleChecked ? (
          <input
            type="checkbox"
            className="row-check"
            aria-label={`把第 ${index + 1} 题加入批量选择`}
            title="加入批量选择"
            checked={checked ?? false}
            disabled={!editable}
            data-testid={`select-question-${question.id}`}
            onClick={(event) => event.stopPropagation()}
            onChange={() => onToggleChecked(question.id)}
          />
        ) : null}
        <button
          type="button"
          className="row-action"
          title="在这道题后插入新题"
          aria-label="在这道题后插入新题"
          disabled={!editable}
          data-testid={`insert-after-${question.id}`}
          onClick={(event) => {
            event.stopPropagation();
            onInsertAfter(question.id);
          }}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className="row-action"
          title="上移"
          disabled={!editable}
          onClick={(event) => {
            event.stopPropagation();
            onMove(question.id, -1);
          }}
        >
          <ArrowUp className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className="row-action"
          title="下移"
          disabled={!editable}
          onClick={(event) => {
            event.stopPropagation();
            onMove(question.id, 1);
          }}
        >
          <ArrowDown className="h-3.5 w-3.5" />
        </button>
      </span>
      <ChevronDown className="q-row-chevron" />
    </div>
  );
}

export const QuestionSummaryRow = memo(QuestionSummaryRowImpl);
