import { useCallback, useEffect, useRef, useState } from "react";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useDroppable } from "@dnd-kit/core";
import { FilePlus2, GripVertical, MousePointerClick, Settings2 } from "lucide-react";
import type { EditableQuestion } from "../../../editor/useSurveyEditor";
import type { BuilderSelection } from "../StructureTree";
import { EmptyPanel } from "../../ui";
import { QuestionSummaryRow } from "../QuestionSummaryRow";
import { QuickBar } from "./QuickBar";
import { LogicLayer } from "./LogicLayer";

/**
 * P2 画布（中栏）：题目摘要卡列表 + 选中高亮 + 快捷条 + S4 拖拽。
 * 编辑发生在右栏属性面板（选中即配置）。
 *
 * DndContext 在 EditorShell（包住物料区+画布两栏，useDraggable 靠 React
 * Context 感知宿主）；这里只负责排序上下文与落点。拖拽语义（交接文档 S4）：
 * drop 才产生命令——排序走 reorderQuestions（幂等合并，只发一次），
 * 物料拖入走 addQuestion（追加到末尾）；取消/落点非法零网络请求。
 */
export function Canvas({
  questions,
  selection,
  editable,
  onOpenPicker,
  onAddScene,
  sceneBusy,
  draggingType,
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
  /** 当前被拖拽的物料题型（仅左栏物料拖入时有值，用于空态提示）。 */
  draggingType: string | null;
  onSelect: (selection: BuilderSelection) => void;
  onMove: (questionId: number, direction: -1 | 1) => void;
  onDuplicate: (questionId: number) => void;
  onDelete: (questionId: number) => void;
  onToggleRequired: (questionId: number) => void;
}) {
  const activeId = selection.kind === "question" ? selection.id : null;
  // 稳定身份：QuestionSummaryRow 是 memo 组件，行内闭包会让 memo 全部失效。
  // onSelect 来自壳的 setState（本身稳定），这里 useCallback 包一层即可。
  const onSelectQuestion = useCallback(
    (questionId: number) => onSelect({ kind: "question", id: questionId }),
    [onSelect],
  );
  // S6 连线层：坐标基准是画布内容区（CanvasDropArea 的 relative 包裹）。
  const baseRef = useRef<HTMLDivElement>(null);
  const [edgeBase, setEdgeBase] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setEdgeBase(baseRef.current);
  }, []);
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

      <CanvasDropArea baseRef={baseRef}>
        <div className="p-3">
          {selection.kind === "settings" ? (
            <p
              className="mb-3 rounded-lg border border-[var(--color-edge)] px-3 py-2 text-xs"
              style={{ color: "var(--color-muted)" }}
            >
              正在编辑问卷设置（右侧属性面板）。
            </p>
          ) : null}
          <SortableContext items={questions.map((question) => question.id)} strategy={verticalListSortingStrategy}>
            <div className="block-list">
              {questions.map((question, index) => {
                const active = activeId === question.id;
                return (
                  <SortableBlock key={question.id} id={question.id} disabled={!editable}>
                    <div
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
                        onOpen={onSelectQuestion}
                        onMove={onMove}
                      />
                    </div>
                  </SortableBlock>
                );
              })}
            </div>
          </SortableContext>
          {questions.length === 0 ? (
            <EmptyPanel
              text={draggingType ? "松手即把该题型加到问卷末尾" : "这份问卷还没有内容，从左侧物料区拖入或点选一个题型"}
            />
          ) : null}
          {edgeBase ? (
            <LogicLayer questions={questions} selectedId={activeId} base={edgeBase} onSelect={onSelectQuestion} />
          ) : null}
        </div>
      </CanvasDropArea>

      <div className="add-block-bar">
        <button className="btn" disabled={!editable} onClick={onOpenPicker}>
          <FilePlus2 className="h-4 w-4" />
          添加题目
        </button>
        <button
          className="btn"
          disabled={!editable || sceneBusy}
          onClick={onAddScene}
          title="新建一道互动场景题，并打开场景编辑器"
        >
          <MousePointerClick className="h-4 w-4" />
          添加互动场景
        </button>
      </div>
    </div>
  );
}

/** 画布内容区是物料拖入的落点 + 连线层坐标基准；排序落点由摘要卡行决定。 */
function CanvasDropArea({
  baseRef,
  children,
}: {
  baseRef: React.RefObject<HTMLDivElement | null>;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: "canvas-drop" });
  return (
    <div
      ref={(node) => {
        setNodeRef(node);
        baseRef.current = node;
      }}
      className="relative"
      style={isOver ? { outline: "2px dashed var(--color-primary)", outlineOffset: "-2px" } : undefined}
    >
      {children}
    </div>
  );
}

/** 摘要卡的 sortable 包装：拖拽柄在卡片左侧，整行点击仍是选中。 */
function SortableBlock({ id, disabled, children }: { id: number; disabled: boolean; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled,
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={isDragging ? "opacity-60" : undefined}
    >
      <div className="flex items-stretch">
        <button
          type="button"
          className="grid w-5 cursor-grab touch-none place-items-center rounded text-[var(--color-muted-soft)] hover:text-[var(--color-primary)] disabled:opacity-30"
          aria-label="拖动排序"
          title="拖动排序"
          disabled={disabled}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="h-3.5 w-3.5" />
        </button>
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
