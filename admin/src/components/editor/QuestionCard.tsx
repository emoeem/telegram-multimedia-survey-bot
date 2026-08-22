import { useState, type ReactNode } from "react";
import { QUESTION_TYPE_LABELS } from "../../format";
import type { EditableQuestion } from "../../editor/useSurveyEditor";

const EDITABLE_TYPES = new Set([
  "single",
  "multiple",
  "yes_no",
  "rating",
  "matrix",
  "text",
  "long_text",
  "number",
  "date",
  "time",
]);

const CHOICE_TYPES = new Set(["single", "multiple", "yes_no", "rating"]);
const MEDIA_TYPES = new Set(["image", "video", "audio", "file"]);

export function isEditableType(type: string): boolean {
  return EDITABLE_TYPES.has(type);
}

export function editableTypeList(): { type: string; label: string }[] {
  return [...EDITABLE_TYPES].map((type) => ({ type, label: QUESTION_TYPE_LABELS[type] ?? type }));
}

interface QuestionCardProps {
  question: EditableQuestion;
  index: number;
  editable: boolean;
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
}

function NumberField({
  label,
  value,
  onCommit,
  disabled,
}: {
  label: string;
  value: number | undefined;
  onCommit: (value: number | undefined) => void;
  disabled: boolean;
}) {
  const [draft, setDraft] = useState(value === undefined ? "" : String(value));
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-gray-500">{label}</span>
      <input
        type="number"
        min={0}
        className="input w-24"
        value={draft}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          const next = draft.trim() === "" ? undefined : Number(draft);
          if (next !== value && !(Number.isNaN(next!) && value === undefined)) onCommit(next);
        }}
      />
    </label>
  );
}

export function QuestionCard({
  question,
  index,
  editable,
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
}: QuestionCardProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [newOptionLabel, setNewOptionLabel] = useState("");
  const [newColumn, setNewColumn] = useState("");
  const editableNow = editable && isEditableType(question.type);
  const validation = question.validation ?? {};
  const commitValidation = (patch: Record<string, number | boolean>) => {
    const next = { ...validation, ...patch };
    for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
    onFieldCommit(question.id, { validation: Object.keys(next).length ? next : null }, "校验设置");
  };
  const commitColumns = (columns: string[]) => {
    onLocalChange(question.id, { columns });
    onFieldCommit(question.id, { settings: { columns } }, "矩阵列");
  };

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="flex flex-wrap items-center gap-2">
        {dragHandle}
        <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">
          第 {index + 1} 题
        </span>
        <span className="rounded bg-blue-50 px-2 py-0.5 text-xs font-semibold text-blue-700">
          {editableNow ? (
            <select
              className="bg-transparent font-semibold text-blue-700"
              value={question.type}
              onChange={(event) => {
                const next = event.target.value;
                onLocalChange(question.id, { type: next });
                onFieldCommit(question.id, { type: next }, "题型修改");
              }}
            >
              {editableTypeList().map(({ type, label }) => (
                <option key={type} value={type}>{label}</option>
              ))}
            </select>
          ) : (
            QUESTION_TYPE_LABELS[question.type] ?? question.type
          )}
        </span>
        {question.id < 0 ? (
          <span className="rounded bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-700">未保存</span>
        ) : null}
        {question.media.length ? (
          <span className="rounded bg-purple-50 px-2 py-0.5 text-xs font-semibold text-purple-700">
            📎 媒体 ×{question.media.length}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          <button
            className="btn btn-sm"
            disabled={!editable}
            onClick={() => onDuplicateQuestion(question.id)}
            title="复制这道题"
          >
            📋 复制
          </button>
          {confirmDelete ? (
            <span className="flex items-center gap-2 text-xs">
              <span className="text-red-600">确认删除？</span>
              <button className="btn btn-sm bg-red-50 text-red-700" onClick={() => onDelete(question.id)}>
                删除
              </button>
              <button className="btn btn-sm" onClick={() => setConfirmDelete(false)}>
                取消
              </button>
            </span>
          ) : (
            <button
              className="btn btn-sm text-red-600"
              disabled={!editable}
              onClick={() => setConfirmDelete(true)}
              title={editable ? "删除这道题" : "仅草稿可删除"}
            >
              🗑 删除
            </button>
          )}
        </div>
      </div>

      <div className="mt-3 grid gap-3">
        <label className="grid gap-1 text-sm">
          <span className="text-gray-500">题目标题</span>
          <input
            className="input"
            defaultValue={question.title}
            key={`title-${question.id}`}
            disabled={!editableNow}
            onBlur={(event) => {
              const next = event.target.value.trim();
              if (next && next !== question.title) {
                onLocalChange(question.id, { title: next });
                onFieldCommit(question.id, { title: next }, "题目标题");
              }
            }}
          />
        </label>

        <label className="grid gap-1 text-sm">
          <span className="text-gray-500">描述 / 帮助文本（可选）</span>
          <textarea
            className="input min-h-16"
            defaultValue={question.description ?? ""}
            key={`description-${question.id}`}
            disabled={!editableNow}
            onBlur={(event) => {
              const next = event.target.value.trim() || null;
              if (next !== question.description) {
                onLocalChange(question.id, { description: next });
                onFieldCommit(question.id, { description: next }, "题目描述");
              }
            }}
          />
        </label>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={question.required}
            disabled={!editableNow}
            onChange={(event) => {
              onLocalChange(question.id, { required: event.target.checked });
              onFieldCommit(question.id, { required: event.target.checked }, "必答设置");
            }}
          />
          <span className="text-gray-700">{question.required ? "必答" : "选答"}</span>
        </label>

        {pages?.length ? (
          <label className="grid gap-1 text-sm">
            <span className="text-gray-500">所属分页</span>
            <select
              className="input"
              value={question.pageId ?? ""}
              disabled={!editableNow}
              onChange={(event) => {
                const next = event.target.value === "" ? null : Number(event.target.value);
                onLocalChange(question.id, { pageId: next });
                onFieldCommit(question.id, { pageId: next }, "分页设置");
              }}
            >
              <option value="">不分页</option>
              {pages.map((page) => (
                <option key={page.id} value={page.id}>{page.title || `第 ${page.order + 1} 页`}</option>
              ))}
            </select>
          </label>
        ) : null}

        {(CHOICE_TYPES.has(question.type) || question.type === "matrix") && editableNow ? (
          <div className="grid gap-1.5 text-sm">
            <span className="text-gray-500">跳题规则（可选）</span>
            <div className="flex flex-wrap items-center gap-2">
              <select
                className="input flex-1"
                value=""
                onChange={(event) => {
                  const optionId = Number(event.target.value);
                  if (!optionId) return;
                  const target = Number(window.prompt("输入目标题目编号（每张卡片标题旁的「第 N 题」即是编号）") ?? "");
                  if (!allQuestions.some((item) => item.id === target)) {
                    window.alert("目标题目编号无效");
                    return;
                  }
                  const condition = { kind: "option_equals", rules: [{ optionId, targetQuestionId: target }] };
                  onLocalChange(question.id, { condition });
                  onFieldCommit(question.id, { condition }, "跳题规则");
                }}
              >
                <option value="">+ 选选项添加跳题…</option>
                {question.options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
              {question.condition ? (
                <button
                  className="btn btn-sm text-red-600"
                  onClick={() => {
                    onLocalChange(question.id, { condition: null });
                    onFieldCommit(question.id, { condition: null }, "清除跳题");
                  }}
                >
                  清除跳题
                </button>
              ) : null}
            </div>
            <p className="text-xs text-gray-400">
              已设置：{JSON.stringify((question.condition as { rules?: unknown } | null)?.rules ?? null)}
            </p>
          </div>
        ) : null}

        {CHOICE_TYPES.has(question.type) || question.type === "matrix" ? (
          <div className="grid gap-1.5">
            <span className="text-sm text-gray-500">
              {question.type === "matrix" ? "行选项" : "选项"}
              <span className="ml-1 text-xs text-gray-400">（修改文案不会影响已有答案关联）</span>
            </span>
            {question.options.map((option, optionIndex) => (
              <div key={option.id} className="flex items-center gap-2">
                <span className="w-5 text-right text-xs text-gray-400">{optionIndex + 1}</span>
                <input
                  className="input flex-1"
                  defaultValue={option.label}
                  key={`option-${option.id}`}
                  disabled={!editableNow}
                  onBlur={(event) => {
                    const next = event.target.value.trim();
                    if (next && next !== option.label) {
                      onOptionRename(question.id, option.id, next);
                    }
                  }}
                />
                <button
                  className="btn btn-sm text-red-600"
                  disabled={!editableNow}
                  onClick={() => onDeleteOption(question.id, option.id)}
                  title="删除选项"
                >
                  ✕
                </button>
              </div>
            ))}
            {editableNow ? (
              <div className="flex items-center gap-2">
                <span className="w-5" />
                <input
                  className="input flex-1"
                  placeholder="新选项文本…"
                  value={newOptionLabel}
                  onChange={(event) => setNewOptionLabel(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && newOptionLabel.trim()) {
                      onAddOption(question.id, newOptionLabel.trim());
                      setNewOptionLabel("");
                    }
                  }}
                />
                <button
                  className="btn btn-sm"
                  disabled={!newOptionLabel.trim()}
                  onClick={() => {
                    onAddOption(question.id, newOptionLabel.trim());
                    setNewOptionLabel("");
                  }}
                >
                  ＋ 添加
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        {question.type === "matrix" ? (
          <div className="grid gap-1.5">
            <span className="text-sm text-gray-500">列（至少 2 列）</span>
            <div className="flex flex-wrap gap-1.5">
              {question.columns.map((column, columnIndex) => (
                <span
                  key={`${column}-${columnIndex}`}
                  className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-0.5 text-xs text-amber-700"
                >
                  {column}
                  {editableNow ? (
                    <button
                      className="text-amber-900"
                      title="删除列"
                      onClick={() => commitColumns(question.columns.filter((_, i) => i !== columnIndex))}
                    >
                      ✕
                    </button>
                  ) : null}
                </span>
              ))}
            </div>
            {editableNow ? (
              <div className="flex items-center gap-2">
                <input
                  className="input max-w-48"
                  placeholder="新列名…"
                  value={newColumn}
                  onChange={(event) => setNewColumn(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && newColumn.trim()) {
                      commitColumns([...question.columns, newColumn.trim()]);
                      setNewColumn("");
                    }
                  }}
                />
                <button
                  className="btn btn-sm"
                  disabled={!newColumn.trim()}
                  onClick={() => {
                    commitColumns([...question.columns, newColumn.trim()]);
                    setNewColumn("");
                  }}
                >
                  ＋ 加列
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        {question.type === "text" || question.type === "long_text" ? (
          <div className="flex flex-wrap gap-4">
            <NumberField
              label="最小长度"
              value={validation.min_length as number | undefined}
              disabled={!editableNow}
              onCommit={(value) => commitValidation({ min_length: value! })}
            />
            <NumberField
              label="最大长度"
              value={validation.max_length as number | undefined}
              disabled={!editableNow}
              onCommit={(value) => commitValidation({ max_length: value! })}
            />
          </div>
        ) : null}

        {question.type === "number" ? (
          <div className="flex flex-wrap gap-4">
            <NumberField
              label="最小值"
              value={validation.min as number | undefined}
              disabled={!editableNow}
              onCommit={(value) => commitValidation({ min: value! })}
            />
            <NumberField
              label="最大值"
              value={validation.max as number | undefined}
              disabled={!editableNow}
              onCommit={(value) => commitValidation({ max: value! })}
            />
          </div>
        ) : null}

        {question.type === "multiple" ? (
          <div className="flex flex-wrap gap-4">
            <NumberField
              label="最少选择"
              value={validation.min_selections as number | undefined}
              disabled={!editableNow}
              onCommit={(value) => commitValidation({ min_selections: value! })}
            />
            <NumberField
              label="最多选择"
              value={validation.max_selections as number | undefined}
              disabled={!editableNow}
              onCommit={(value) => commitValidation({ max_selections: value! })}
            />
          </div>
        ) : null}

        {MEDIA_TYPES.has(question.type) ? (
          <div className="rounded-md bg-gray-50 p-3 text-xs text-gray-500">
            媒体题：附件{question.media.length ? "已配置" : "未配置"}。上传 / 更换附件请前往 Bot 内完成；
            此处编辑标题、描述与必答设置。
          </div>
        ) : null}
      </div>
    </div>
  );
}
