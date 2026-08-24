import { useState } from "react";
import { ArrowDown, ArrowUp, ChevronRight, FilePlus2, Settings2, Trash2 } from "lucide-react";
import type { EditableQuestion } from "../../editor/useSurveyEditor";

export type BuilderSelection = { kind: "settings" } | { kind: "question"; id: number };

interface StructureTreeProps {
  pages: Array<{ id: number; title: string | null; order: number }>;
  questions: EditableQuestion[];
  selection: BuilderSelection;
  onSelect: (selection: BuilderSelection) => void;
  editable: boolean;
  onAddPage: () => void;
  onDeletePage: (pageId: number) => void;
  onMoveQuestion: (questionId: number, direction: -1 | 1) => void;
}

export function StructureTree({
  pages,
  questions,
  selection,
  onSelect,
  editable,
  onAddPage,
  onDeletePage,
  onMoveQuestion,
}: StructureTreeProps) {
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set());
  const togglePage = (pageId: number) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(pageId)) next.delete(pageId);
      else next.add(pageId);
      return next;
    });
  };

  const numberById = new Map<number, number>();
  questions.forEach((question, index) => numberById.set(question.id, index + 1));

  const pageGroups = [...pages]
    .sort((a, b) => a.order - b.order)
    .map((page) => ({
      page,
      items: questions.filter((question) => question.pageId === page.id),
    }));
  const unassigned = questions.filter((question) => question.pageId === null);
  const showUnassigned = unassigned.length > 0;

  return (
    <div className="structure-panel">
      <div className="structure-head">
        <span>问卷结构</span>
        <button className="row-action" title="新增分页" disabled={!editable} onClick={onAddPage}>
          <FilePlus2 className="h-4 w-4" />
        </button>
      </div>
      <div className="structure-tree">
        <button
          type="button"
          className={`tree-root-item ${selection.kind === "settings" ? "active" : ""}`}
          onClick={() => onSelect({ kind: "settings" })}
        >
          <Settings2 className="h-4 w-4" />
          <span>问卷设置</span>
        </button>
        <div className="tree-divider" />

        {pageGroups.length ? (
          pageGroups.map(({ page, items }) => {
            const isCollapsed = collapsed.has(page.id);
            const active =
              selection.kind === "question" &&
              items.some((question) => question.id === selection.id);
            return (
              <div key={page.id}>
                <div
                  className={`tree-page-head ${active ? "active" : ""}`}
                  onClick={() => togglePage(page.id)}
                >
                  <span className={`tree-chevron ${isCollapsed ? "" : "is-open"}`}>
                    <ChevronRight className="h-3.5 w-3.5" />
                  </span>
                  <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                    {page.title || `第 ${page.order + 1} 页`}
                  </span>
                  <span className="tree-page-count">{items.length} 题</span>
                  <span className="row-actions">
                    <button
                      type="button"
                      className="row-action danger"
                      title="删除分页"
                      disabled={!editable}
                      onClick={(event) => {
                        event.stopPropagation();
                        onDeletePage(page.id);
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </span>
                </div>
                {!isCollapsed
                  ? items.map((question) => (
                      <div
                        key={question.id}
                        className={`tree-question ${selection.kind === "question" && selection.id === question.id ? "active" : ""}`}
                        onClick={() => onSelect({ kind: "question", id: question.id })}
                      >
                        <span className="tree-question-index">{numberById.get(question.id)}</span>
                        <span className="tree-question-title">{question.title || "未命名题目"}</span>
                        <span className="row-actions">
                          <button
                            type="button"
                            className="row-action"
                            title="上移"
                            disabled={!editable || questions.length < 2}
                            onClick={(event) => {
                              event.stopPropagation();
                              onMoveQuestion(question.id, -1);
                            }}
                          >
                            <ArrowUp className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            className="row-action"
                            title="下移"
                            disabled={!editable || questions.length < 2}
                            onClick={(event) => {
                              event.stopPropagation();
                              onMoveQuestion(question.id, 1);
                            }}
                          >
                            <ArrowDown className="h-3.5 w-3.5" />
                          </button>
                        </span>
                      </div>
                    ))
                  : null}
              </div>
            );
          })
        ) : (
          <div className="px-3 py-2 text-xs" style={{ color: "var(--color-muted-soft)" }}>
            还没有分页，可点击右上角“＋”新建。
          </div>
        )}

        {showUnassigned ? (
          <div>
            <div className="tree-page-head">
              <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">未分页</span>
              <span className="tree-page-count">{unassigned.length} 题</span>
            </div>
            {unassigned.map((question) => (
              <div
                key={question.id}
                className={`tree-question ${selection.kind === "question" && selection.id === question.id ? "active" : ""}`}
                onClick={() => onSelect({ kind: "question", id: question.id })}
              >
                <span className="tree-question-index">{numberById.get(question.id)}</span>
                <span className="tree-question-title">{question.title || "未命名题目"}</span>
                <span className="row-actions">
                  <button
                    type="button"
                    className="row-action"
                    title="上移"
                    disabled={!editable || questions.length < 2}
                    onClick={(event) => {
                      event.stopPropagation();
                      onMoveQuestion(question.id, -1);
                    }}
                  >
                    <ArrowUp className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    className="row-action"
                    title="下移"
                    disabled={!editable || questions.length < 2}
                    onClick={(event) => {
                      event.stopPropagation();
                      onMoveQuestion(question.id, 1);
                    }}
                  >
                    <ArrowDown className="h-3.5 w-3.5" />
                  </button>
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      <div className="p-2 pt-0">
        <button className="btn btn-sm w-full" disabled={!editable} onClick={onAddPage}>
          <FilePlus2 className="h-4 w-4" />新分页
        </button>
      </div>
    </div>
  );
}
