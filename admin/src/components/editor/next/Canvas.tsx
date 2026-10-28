import { FilePlus2, MousePointerClick, Settings2 } from "lucide-react";
import type { EditableQuestion } from "../../../editor/useSurveyEditor";
import type { BuilderSelection } from "../StructureTree";
import { EmptyPanel } from "../../ui";
import { QuestionSummaryRow } from "../QuestionSummaryRow";
import { QuickBar } from "./QuickBar";

/**
 * P2 画布（中栏）：题目摘要卡列表 + 选中高亮 + 快捷条。编辑发生在右栏属性面板
 * （选中即配置），画布承载导航与排序（S4 拖拽、S6 连线逐层加上）。
 * 模板入口常驻左栏物料区，这里不再重复。
 */
export function Canvas({
  questions,
  selection,
  editable,
  onOpenPicker,
  onAddScene,
  sceneBusy,
  onSelect,
  onMove,
  onDuplicate,
  onDelete,
  onToggleRequired,
}: {
  questions: EditableQuestion[];
  selection: BuilderSelection;
  editable: boolean;
  onOpenPicker: () => void;
  onAddScene: () => void;
  sceneBusy: boolean;
  onSelect: (selection: BuilderSelection) => void;
  onMove: (questionId: number, direction: -1 | 1) => void;
  onDuplicate: (questionId: number) => void;
  onDelete: (questionId: number) => void;
  onToggleRequired: (questionId: number) => void;
}) {
  const activeId = selection.kind === "question" ? selection.id : null;
  // 不自建滚动容器：.editor-canvas 列本身就是滚动层（.editor-col overflow-y:auto），
  // 与旧壳同构，editor-layout 的几何断言（栏内滚动）才能同时约束两套壳。
  return (
    <div>
      <div className="flex items-center justify-between gap-2 border-b border-[var(--color-edge)] px-3 py-2">
        <button
          type="button"
          className="flex items-center gap-1.5 text-xs font-semibold"
          style={{ color: selection.kind === "settings" ? "var(--color-primary)" : "var(--color-muted)" }}
          aria-pressed={selection.kind === "settings"}
          onClick={() => onSelect({ kind: "settings" })}
        >
          <Settings2 className="h-3.5 w-3.5" />
          问卷设置
        </button>
        <span className="text-[11px]" style={{ color: "var(--color-muted)" }}>
          {questions.length} 题
        </span>
      </div>

      <div className="p-3">
        {selection.kind === "settings" ? (
          <p className="mb-3 rounded-lg border border-[var(--color-edge)] px-3 py-2 text-xs" style={{ color: "var(--color-muted)" }}>
            正在编辑问卷设置（右侧属性面板）。
          </p>
        ) : null}
        <div className="block-list">
          {questions.map((question, index) => {
            const active = activeId === question.id;
            return (
              <div
                key={question.id}
                data-block-id={question.id}
                className="block-item"
                style={active ? { position: "relative" } : undefined}
              >
                {active ? (
                  <QuickBar
                    question={question}
                    editable={editable}
                    onDuplicate={() => onDuplicate(question.id)}
                    onDelete={() => onDelete(question.id)}
                    onMove={(direction) => onMove(question.id, direction)}
                    onToggleRequired={() => onToggleRequired(question.id)}
                  />
                ) : null}
                <QuestionSummaryRow
                  question={question}
                  index={index}
                  editable={editable}
                  active={active}
                  onOpen={() => onSelect({ kind: "question", id: question.id })}
                  onMove={(direction) => onMove(question.id, direction)}
                />
              </div>
            );
          })}
        </div>
        {questions.length === 0 ? (
          <EmptyPanel text="这份问卷还没有内容，从左侧物料区点一个题型开始" />
        ) : null}
      </div>

      <div className="add-block-bar">
        <button className="btn" disabled={!editable} onClick={onOpenPicker}>
          <FilePlus2 className="h-4 w-4" />
          添加题目
        </button>
        <button className="btn" disabled={!editable || sceneBusy} onClick={onAddScene} title="新建一道互动场景题，并打开场景编辑器">
          <MousePointerClick className="h-4 w-4" />
          添加互动场景
        </button>
      </div>
    </div>
  );
}
