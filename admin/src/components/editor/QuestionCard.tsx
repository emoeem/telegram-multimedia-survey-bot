import { useState, type ReactNode } from "react";
import { Copy, MousePointerClick, Paperclip, Trash2 } from "lucide-react";
import { QUESTION_TYPE_LABELS } from "../../format";
import type { EditableQuestion } from "../../editor/useSurveyEditor";
import { CHOICE_TYPES, editableTypeList, isEditableType } from "./question-types";
import { QuestionForm } from "./QuestionForm";

// 题型集合已拆到 question-types.ts（S1）；这里保留导出，老引用方不受影响。
export { isEditableType, editableTypeList };

interface QuestionCardProps {
  question: EditableQuestion;
  index: number;
  editable: boolean;
  /** 基础/专业模式（S7）：透传给 QuestionForm 过滤高级区块；缺省 pro。 */
  editorMode?: "basic" | "pro";
  dragHandle?: ReactNode;
  onFieldCommit: (questionId: number, patch: Record<string, unknown>, label: string) => void;
  onLocalChange: (questionId: number, patch: Partial<EditableQuestion>) => void;
  onOptionRename: (questionId: number, optionId: number, label: string) => void;
  onAddOption: (questionId: number, label: string) => void;
  onDeleteOption: (questionId: number, optionId: number) => void;
  onDelete: (questionId: number) => void;
  onDuplicateQuestion: (questionId: number) => void;
  onDuplicateOption: (questionId: number, optionId: number) => void;
  allQuestions: EditableQuestion[];
  pages?: Array<{ id: number; title: string | null; order: number }>;
  onAttachQuestionMedia: (questionId: number, file: File) => Promise<boolean>;
  /** 从素材库选择已有素材挂到题目（不重传文件）。 */
  onAttachQuestionMediaFromLibrary?: (questionId: number, assetId: number) => Promise<boolean>;
  onRemoveQuestionMedia: (questionId: number, mediaAssetId: number) => Promise<boolean>;
  onAttachOptionMedia: (optionId: number, file: File) => Promise<boolean>;
  /** 从素材库为选项挂已有素材（不重传文件）。 */
  onAttachOptionMediaFromLibrary?: (optionId: number, assetId: number) => Promise<boolean>;
  onRemoveOptionMedia: (optionId: number, mediaAssetId: number) => Promise<boolean>;
  /** scene 题：打开独立的场景热点编辑器（标题/描述也在这里改）。 */
  onOpenSceneEditor?: (questionId: number) => void;
}

/**
 * 题目卡片 = 头部（题号 / 题型切换 / 场景提示 / 复制·删除）+ QuestionForm 表单体。
 * S1 起表单区块全部在 QuestionForm.tsx（新壳的属性面板直接复用它）；
 * DOM 类名与提交语义保持拆分前的样子，旧壳视觉零变化。
 */
export function QuestionCard({
  question,
  index,
  editable,
  editorMode = "pro",
  dragHandle,
  onFieldCommit,
  onLocalChange,
  onOptionRename,
  onAddOption,
  onDeleteOption,
  onDelete,
  onDuplicateQuestion,
  onDuplicateOption,
  allQuestions,
  pages,
  onAttachQuestionMedia,
  onAttachQuestionMediaFromLibrary,
  onRemoveQuestionMedia,
  onAttachOptionMedia,
  onAttachOptionMediaFromLibrary,
  onRemoveOptionMedia,
  onOpenSceneEditor,
}: QuestionCardProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const editableNow = editable && isEditableType(question.type);

  return (
    <div className="q-editor">
      <div className="q-editor-head">
        <div className="q-badges">
          {dragHandle}
          <span className="q-index">第 {index + 1} 题</span>
          {editableNow ? (
            <select
              className="q-type-select"
              aria-label={`第 ${index + 1} 题类型`}
              value={question.type}
              disabled={!editable}
              onChange={(event) => {
                const next = event.target.value;
                const patch: Partial<EditableQuestion> = {
                  type: next,
                  options: CHOICE_TYPES.has(next) ? question.options : [],
                  columns: next === "matrix" ? question.columns : [],
                };
                onLocalChange(question.id, patch);
                onFieldCommit(
                  question.id,
                  {
                    type: next,
                    options: patch.options,
                    settings:
                      next === "matrix"
                        ? { columns: question.columns }
                        : next === "game" && question.gamePackId
                          ? { game: { packId: question.gamePackId } }
                          : null,
                  },
                  "题型修改",
                );
              }}
            >
              {editableTypeList().map(({ type, label }) => (
                <option key={type} value={type}>
                  {label}
                </option>
              ))}
            </select>
          ) : (
            <span
              className="q-index"
              style={{
                background: "color-mix(in srgb, var(--color-primary) 13%, var(--surface))",
                color: "var(--color-primary)",
              }}
            >
              {QUESTION_TYPE_LABELS[question.type] ?? question.type}
            </span>
          )}
          {question.id < 0 ? <span className="q-chip q-chip-unsaved">未保存</span> : null}
          {question.type === "scene" ? (
            <span className="q-chip" title="场景热点、标题与描述在「编辑场景」中维护。">
              互动场景 · 用「编辑场景」配置
            </span>
          ) : null}
          {question.media.length ? (
            <span className="q-chip q-chip-media">
              <Paperclip className="h-3.5 w-3.5" />
              媒体 ×{question.media.length}
            </span>
          ) : null}
        </div>
        <div className="q-head-actions">
          {question.type === "scene" ? (
            <button
              className="btn btn-sm btn-quiet"
              disabled={!editable || question.id < 0}
              onClick={() => onOpenSceneEditor?.(question.id)}
              title={question.id < 0 ? "先保存问卷再编辑场景" : "编辑场景热点、标题与描述"}
            >
              <MousePointerClick className="h-3.5 w-3.5" />
              编辑场景
            </button>
          ) : null}
          <button
            className="btn btn-sm btn-quiet"
            disabled={!editable}
            onClick={() => onDuplicateQuestion(question.id)}
            title="复制这道题"
          >
            <Copy className="h-3.5 w-3.5" />
            复制
          </button>
          {confirmDelete ? (
            <span className="flex items-center gap-2 text-xs" style={{ color: "var(--app-danger)" }}>
              <span>确认删除？</span>
              <button
                className="btn btn-sm"
                style={{
                  background: "color-mix(in srgb, var(--app-danger) 14%, var(--surface))",
                  color: "var(--app-danger)",
                }}
                onClick={() => onDelete(question.id)}
              >
                删除
              </button>
              <button className="btn btn-sm" onClick={() => setConfirmDelete(false)}>
                取消
              </button>
            </span>
          ) : (
            <button
              className="btn btn-sm btn-danger-hover"
              disabled={!editable}
              onClick={() => setConfirmDelete(true)}
              title={editable ? "删除这道题" : "仅草稿可删除"}
            >
              <Trash2 className="h-3.5 w-3.5" />
              删除
            </button>
          )}
        </div>
      </div>

      <QuestionForm
        question={question}
        index={index}
        editable={editable}
        editorMode={editorMode}
        onFieldCommit={onFieldCommit}
        onLocalChange={onLocalChange}
        onOptionRename={onOptionRename}
        onAddOption={onAddOption}
        onDeleteOption={onDeleteOption}
        allQuestions={allQuestions}
        pages={pages}
        onAttachQuestionMedia={onAttachQuestionMedia}
        onAttachQuestionMediaFromLibrary={onAttachQuestionMediaFromLibrary}
        onRemoveQuestionMedia={onRemoveQuestionMedia}
        onAttachOptionMedia={onAttachOptionMedia}
        onAttachOptionMediaFromLibrary={onAttachOptionMediaFromLibrary}
        onRemoveOptionMedia={onRemoveOptionMedia}
      />
    </div>
  );
}
