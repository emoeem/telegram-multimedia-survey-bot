import { ArrowDown, ArrowUp, ChevronDown, GitBranch } from "lucide-react";
import { QUESTION_TYPE_LABELS } from "../../format";
import type { EditableQuestion } from "../../editor/useSurveyEditor";

/** condition.rules 的条数（旧壳与新壳的摘要卡共用）。 */
export function branchCountOf(question: EditableQuestion): number {
  const rules = (question.condition as { rules?: unknown } | null)?.rules;
  return Array.isArray(rules) ? rules.length : 0;
}

/**
 * 画布摘要卡（S2 从 EditorPage 抽出，两套壳共用）：
 * 序号 / 标题 / 类型 / 必答·分支·附件·未保存 标签 + 上下移。
 */
export function QuestionSummaryRow({
  question,
  index,
  editable,
  active,
  onOpen,
  onMove,
}: {
  question: EditableQuestion;
  index: number;
  editable: boolean;
  active?: boolean;
  onOpen: () => void;
  onMove: (direction: -1 | 1) => void;
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
      style={active ? { outline: "2px solid var(--color-primary)", outlineOffset: "-2px" } : undefined}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
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
        <button
          type="button"
          className="row-action"
          title="上移"
          disabled={!editable}
          onClick={(event) => {
            event.stopPropagation();
            onMove(-1);
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
            onMove(1);
          }}
        >
          <ArrowDown className="h-3.5 w-3.5" />
        </button>
      </span>
      <ChevronDown className="q-row-chevron" />
    </div>
  );
}
