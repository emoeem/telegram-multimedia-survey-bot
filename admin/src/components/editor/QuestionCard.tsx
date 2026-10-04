import { useState, type ReactNode } from "react";
import { Copy, GitBranch, Paperclip, Plus, Trash2, Upload, X } from "lucide-react";
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
  "image",
  "video",
  "audio",
  "file",
  "note",
]);

const CHOICE_TYPES = new Set(["single", "multiple", "yes_no", "rating"]);
// 跳转只在"选一个"的题型上生效：引擎按选中项匹配规则，
// 多选/矩阵没有单一选中项，配了也不会触发。
const JUMPABLE_TYPES = new Set(["single", "yes_no", "rating"]);
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
  onAttachQuestionMedia: (questionId: number, file: File) => Promise<boolean>;
  onRemoveQuestionMedia: (questionId: number, mediaAssetId: number) => Promise<boolean>;
  onAttachOptionMedia: (optionId: number, file: File) => Promise<boolean>;
  onRemoveOptionMedia: (optionId: number, mediaAssetId: number) => Promise<boolean>;
}

interface AttachmentMedia {
  mediaAssetId: number;
  mediaType: string;
  fileName?: string | null;
  mimeType?: string | null;
}

const MEDIA_LABELS: Record<string, string> = {
  photo: "图片",
  video: "视频",
  audio: "音频",
  animation: "动画",
  gif: "GIF",
  sticker: "贴纸",
  document: "文件",
};

const MEDIA_FILE_ACCEPT = "image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.zip,.rtf,.txt,.csv";

function mediaUrl(mediaAssetId: number): string {
  return `/api/survey/media/${mediaAssetId}`;
}

function mediaLabel(media: AttachmentMedia): string {
  return (
    media.fileName ||
    (media.mimeType && media.mimeType !== "application/octet-stream" ? media.mimeType : null) ||
    MEDIA_LABELS[media.mediaType] ||
    media.mediaType
  );
}

function AttachmentChip({
  media,
  removable,
  onRemove,
}: {
  media: AttachmentMedia;
  removable: boolean;
  onRemove: () => void;
}) {
  const url = mediaUrl(media.mediaAssetId);
  return (
    <span
      className="flex items-center gap-2 rounded-lg border px-2 py-1 text-xs"
      style={{ borderColor: "var(--color-edge)", background: "var(--surface-muted)" }}
      title={mediaLabel(media)}
    >
      {media.mediaType === "photo" ? (
        <a href={url} target="_blank" rel="noreferrer" className="block">
          <img src={url} alt={mediaLabel(media)} className="h-9 w-9 rounded object-cover" />
        </a>
      ) : (
        <Paperclip className="h-3.5 w-3.5 shrink-0" />
      )}
      <span className="max-w-40 truncate">
        {MEDIA_LABELS[media.mediaType] ?? media.mediaType}
        {media.mediaType !== "photo" ? ` · ${mediaLabel(media)}` : ""}
      </span>
      {removable ? (
        <button type="button" className="q-option-del" title="移除附件" onClick={onRemove}>
          <X className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </span>
  );
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
      <span style={{ color: "var(--color-muted)" }}>{label}</span>
      <input
        type="number"
        min={0}
        className="q-option-input w-24"
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
  onAttachQuestionMedia,
  onRemoveQuestionMedia,
  onAttachOptionMedia,
  onRemoveOptionMedia,
}: QuestionCardProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [newOptionLabel, setNewOptionLabel] = useState("");
  const [newColumn, setNewColumn] = useState("");
  const [mediaBusy, setMediaBusy] = useState<string | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const editableNow = editable && isEditableType(question.type);
  const isNote = question.type === "note";
  const jumpable = JUMPABLE_TYPES.has(question.type) && editableNow;
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
  // 每个选项的跳转目标存在 condition.rules 里（optionId → targetQuestionId）。
  // UI 按"选项 → 下拉选目标"呈现：未设置 = 顺序继续。
  const branchByOption = (() => {
    const map = new Map<number, number>();
    const savedRules = (question.condition as { rules?: unknown } | null)?.rules;
    if (Array.isArray(savedRules)) {
      for (const rule of savedRules) {
        if (!rule || typeof rule !== "object") continue;
        const item = rule as Record<string, unknown>;
        const optionId = Number(item.optionId);
        const target = Number(item.targetQuestionId);
        if (optionId > 0 && target > 0) map.set(optionId, target);
      }
    }
    return map;
  })();
  const commitBranch = (optionId: number, targetQuestionId: number | null) => {
    const next = new Map(branchByOption);
    if (targetQuestionId === null) next.delete(optionId);
    else next.set(optionId, targetQuestionId);
    const rules = question.options
      .filter((option) => next.has(option.id))
      .map((option) => ({ optionId: option.id, targetQuestionId: next.get(option.id)! }));
    const condition = rules.length ? { kind: "option_equals", rules } : null;
    onLocalChange(question.id, { condition });
    onFieldCommit(question.id, { condition }, "跳转规则");
  };
  const availableTargets = allQuestions.filter((item) => item.id !== question.id && item.order > question.order);
  const runMediaAction = async (key: string, action: () => Promise<boolean>) => {
    setMediaBusy(key);
    setMediaError(null);
    const ok = await action();
    if (!ok) setMediaError("操作失败，请查看页面顶部的错误提示");
    setMediaBusy(null);
  };

  return (
    <div className="q-editor">
      <div className="q-editor-head">
        <div className="q-badges">
          {dragHandle}
          <span className="q-index">第 {index + 1} 题</span>
          {editableNow ? (
            <select
              className="q-type-select"
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
                    settings: next === "matrix" ? { columns: question.columns } : null,
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
          {question.media.length ? (
            <span className="q-chip q-chip-media">
              <Paperclip className="h-3.5 w-3.5" />
              媒体 ×{question.media.length}
            </span>
          ) : null}
        </div>
        <div className="q-head-actions">
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
            <span className="flex items-center gap-2 text-xs" style={{ color: "var(--color-danger)" }}>
              <span>确认删除？</span>
              <button
                className="btn btn-sm"
                style={{
                  background: "color-mix(in srgb, var(--color-danger) 14%, var(--surface))",
                  color: "var(--color-danger)",
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

      <div className="q-body">
        <label className="q-field">
          <span className="q-label">{isNote ? "段落标题（显示为小标题，可留空）" : "题目标题"}</span>
          <input
            className="q-title-input"
            defaultValue={question.title}
            key={`title-${question.id}-${question.title}`}
            disabled={!editableNow}
            placeholder={isNote ? "如：序章 · 深夜来信" : "输入题目标题"}
            onBlur={(event) => {
              const next = event.target.value.trim();
              if (next && next !== question.title) {
                onLocalChange(question.id, { title: next });
                onFieldCommit(question.id, { title: next }, "题目标题");
              }
            }}
          />
        </label>

        <label className="q-field">
          <span className="q-label">{isNote ? "剧情正文（支持换行分段）" : "描述 / 帮助文本（可选）"}</span>
          <textarea
            className={`q-desc-input ${isNote ? "is-note-body" : ""}`}
            defaultValue={question.description ?? ""}
            key={`description-${question.id}-${question.description ?? ""}`}
            disabled={!editableNow}
            placeholder={
              isNote
                ? "在这里写剧情…\n\n空行分段，答题者会先读到这段内容，再继续后面的题目或分支。"
                : "给答题者的一段说明（可选）"
            }
            onBlur={(event) => {
              const next = event.target.value.trim() || null;
              if (next !== question.description) {
                onLocalChange(question.id, { description: next });
                onFieldCommit(question.id, { description: next }, isNote ? "剧情正文" : "题目描述");
              }
            }}
          />
          {isNote ? (
            <span className="q-help">剧情文段不收集答案；可上传插图作配图，之后的题目选项可把答题者跳转到不同文段。</span>
          ) : null}
        </label>

        {!isNote ? (
          <div className="q-switch-row">
            <div>
              <div className="q-label">必答</div>
              <div className="q-help">开启后，答题者必须回答此题才能继续</div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={question.required}
              className="switch"
              data-on={question.required}
              disabled={!editableNow}
              onClick={() => {
                const next = !question.required;
                onLocalChange(question.id, { required: next });
                onFieldCommit(question.id, { required: next }, "必答设置");
              }}
            />
          </div>
        ) : null}

        <div className="q-field">
          <span className="q-label">{isNote ? "剧情配图 / 附件（可选）" : "题面附件（图片 / 视频 / 音频 / 文件，可选）"}</span>
          {question.media.length ? (
            <div className="flex flex-wrap items-center gap-2">
              {question.media.map((media) => (
                <AttachmentChip
                  key={media.mediaAssetId}
                  media={media}
                  removable={editableNow}
                  onRemove={() => {
                    void runMediaAction(`question-remove-${media.mediaAssetId}`, () =>
                      onRemoveQuestionMedia(question.id, media.mediaAssetId),
                    );
                  }}
                />
              ))}
            </div>
          ) : null}
          {editableNow && question.id >= 0 ? (
            <label
              className="inline-flex cursor-pointer items-center gap-2"
              style={{ color: mediaBusy ? "var(--color-muted-soft)" : "var(--color-primary)" }}
            >
              <input
                type="file"
                className="hidden"
                accept={MEDIA_FILE_ACCEPT}
                disabled={mediaBusy !== null}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  event.target.value = "";
                  void runMediaAction("question-upload", () => onAttachQuestionMedia(question.id, file));
                }}
              />
              <Upload className="h-4 w-4" />
              <span className="text-sm font-medium">
                {mediaBusy === "question-upload" ? "上传中…" : "上传题面附件"}
              </span>
            </label>
          ) : editableNow ? (
            <p className="q-help">新题目保存到服务器后即可添加附件（标题修改后约 2 秒自动保存）。</p>
          ) : null}
          <p className="q-help">附件会在答题页展示给填写者；单选/多选等题型的选项也可以单独配媒体。</p>
          {mediaError ? (
            <p className="q-help" style={{ color: "var(--color-danger)" }}>
              {mediaError}
            </p>
          ) : null}
        </div>

        {pages?.length ? (
          <label className="q-field">
            <span className="q-label">所属分页</span>
            <select
              className="q-select"
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
                <option key={page.id} value={page.id}>
                  {page.title || `第 ${page.order + 1} 页`}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {CHOICE_TYPES.has(question.type) || question.type === "matrix" ? (
          <div className="q-field">
            <span className="q-label">
              {question.type === "matrix" ? "行选项" : "选项"}
              <span className="ml-1 q-help">（修改文案不会影响已有答案关联）</span>
            </span>
            {jumpable ? (
              <span className="q-help">
                每个选项可设置「选择后跳转」：选它的人会直接跳到目标题目或剧情文段，实现不同答案不同剧情。
              </span>
            ) : null}
            {question.options.map((option) => (
              <div key={option.id}>
                <div className="q-option-row">
                  <span
                    aria-hidden="true"
                    className={`q-option-glyph ${question.type === "multiple" ? "square" : "round"}`}
                  >
                    {question.type === "multiple" ? "✓" : "•"}
                  </span>
                  <input
                    className="q-option-input"
                    defaultValue={option.label}
                    key={`option-${option.id}-${option.label}`}
                    disabled={!editableNow}
                    onBlur={(event) => {
                      const next = event.target.value.trim();
                      if (next && next !== option.label) {
                        onOptionRename(question.id, option.id, next);
                      }
                    }}
                  />
                  <button
                    className="q-option-del"
                    disabled={!editableNow}
                    onClick={() => onDeleteOption(question.id, option.id)}
                    title="删除选项"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                {CHOICE_TYPES.has(question.type) ? (
                  <div className="flex flex-wrap items-center gap-2 pb-1 pl-9">
                    {option.media.map((media) => (
                      <AttachmentChip
                        key={media.mediaAssetId}
                        media={media}
                        removable={editableNow}
                        onRemove={() => {
                          void runMediaAction(`option-remove-${option.id}-${media.mediaAssetId}`, () =>
                            onRemoveOptionMedia(option.id, media.mediaAssetId),
                          );
                        }}
                      />
                    ))}
                    {editableNow && question.id >= 0 && option.id >= 0 ? (
                      <label
                        className="inline-flex cursor-pointer items-center gap-1 text-xs"
                        style={{ color: mediaBusy ? "var(--color-muted-soft)" : "var(--color-primary)" }}
                        title="为这个选项上传图片 / 视频 / 音频 / 文件"
                      >
                        <input
                          type="file"
                          className="hidden"
                          accept={MEDIA_FILE_ACCEPT}
                          disabled={mediaBusy !== null}
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            if (!file) return;
                            event.target.value = "";
                            void runMediaAction(`option-upload-${option.id}`, () =>
                              onAttachOptionMedia(option.id, file),
                            );
                          }}
                        />
                        <Upload className="h-3.5 w-3.5" />
                        <span>{mediaBusy === `option-upload-${option.id}` ? "上传中…" : "选项媒体"}</span>
                      </label>
                    ) : null}
                  </div>
                ) : null}
                {jumpable ? (
                  <div className="q-branch-row">
                    <GitBranch className="h-3.5 w-3.5 shrink-0" />
                    <span className="q-branch-label">选择后</span>
                    <select
                      className="q-branch-select"
                      value={branchByOption.get(option.id) ?? ""}
                      disabled={!editableNow}
                      onChange={(event) =>
                        commitBranch(option.id, event.target.value === "" ? null : Number(event.target.value))
                      }
                    >
                      <option value="">按顺序继续</option>
                      {availableTargets.map((target) => (
                        <option key={target.id} value={target.id}>
                          {target.type === "note" ? "📖 " : ""}
                          {allQuestions.indexOf(target) + 1}. {target.title || "未命名"}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}
              </div>
            ))}
            {editableNow ? (
              <div className="q-option-row">
                <span
                  aria-hidden="true"
                  className={`q-option-glyph ${question.type === "multiple" ? "square" : "round"}`}
                />
                <input
                  className="q-option-input"
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
                  <Plus className="h-4 w-4" />
                  添加
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        {question.type === "matrix" ? (
          <div className="q-field">
            <span className="q-label">列（至少 2 列）</span>
            <div className="flex flex-wrap gap-1.5">
              {question.columns.map((column, columnIndex) => (
                <span key={`${column}-${columnIndex}`} className="q-column-chip">
                  {column}
                  {editableNow ? (
                    <button
                      title="删除列"
                      onClick={() => commitColumns(question.columns.filter((_, i) => i !== columnIndex))}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  ) : null}
                </span>
              ))}
            </div>
            {editableNow ? (
              <div className="flex items-center gap-2">
                <input
                  className="q-option-input max-w-48"
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
                  <Plus className="h-4 w-4" />
                  加列
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
          <div className="q-note">
            该题型由作答者上传对应的图片 / 视频 / 音频 / 文件；如需要在题干展示示例媒体， 请使用上方「题面附件」。
          </div>
        ) : null}
      </div>
    </div>
  );
}
