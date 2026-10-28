import { useEffect, useState } from "react";
import { GitBranch, Images, Paperclip, Plus, Sparkles, Upload, X } from "lucide-react";
import { fetchAdminTaskPacks, fetchAdminMediaLibrary, type AdminMediaLibraryItem, type AdminTaskPack } from "../../api";
import type { EditableQuestion } from "../../editor/useSurveyEditor";
import { CHOICE_TYPES, isEditableType, JUMPABLE_TYPES, MEDIA_TYPES } from "./question-types";

/**
 * 题目表单体（S1 从 QuestionCard 拆出，纯搬运）：标题/描述/小游戏包/必答/
 * 附件/分页/选项（媒体·跳转·Flag）/矩阵列/Flag 跳转/校验。
 * 卡片头部（题型切换、编辑场景、复制、删除）仍在 QuestionCard。
 * DOM 结构与提交语义保持与拆分前一致——旧壳视觉零变化是本步的硬约束。
 */

interface QuestionFormProps {
  question: EditableQuestion;
  index: number;
  editable: boolean;
  /**
   * 基础/专业模式（S7 能力矩阵）：基础模式只留 标题/描述/必答/附件/选项/
   * 分页/小游戏包，隐藏 校验、命中 Flag、剧情 Flag 跳转。缺省 pro（旧壳与
   * 直接使用方行为不变）。
   */
  editorMode?: "basic" | "pro";
  onFieldCommit: (questionId: number, patch: Record<string, unknown>, label: string) => void;
  onLocalChange: (questionId: number, patch: Partial<EditableQuestion>) => void;
  onOptionRename: (questionId: number, optionId: number, label: string) => void;
  onAddOption: (questionId: number, label: string) => void;
  onDeleteOption: (questionId: number, optionId: number) => void;
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

/** 素材库选择器：列出最近 24 个素材，点图即挂到题目（不重传文件）。 */
export function LibraryPicker({ busy, onPick }: { busy: boolean; onPick: (assetId: number) => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<AdminMediaLibraryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open || items !== null) return;
    let cancelled = false;
    void fetchAdminMediaLibrary({ limit: 24, offset: 0 })
      .then((response) => {
        if (!cancelled) setItems(response.items);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "素材库加载失败");
      });
    return () => {
      cancelled = true;
    };
  }, [open, items]);
  return (
    <span className="relative inline-flex">
      <button
        type="button"
        className="inline-flex items-center gap-1.5 text-sm font-medium"
        style={{ color: "var(--color-primary)" }}
        disabled={busy}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <Images className="h-4 w-4" />
        从素材库选择
      </button>
      {open ? (
        <div className="absolute left-0 top-full z-20 mt-1 w-80 rounded-xl border border-[var(--color-edge)] bg-[var(--surface)] p-2 shadow-lg">
          {error ? (
            <p className="p-2 text-xs text-[var(--app-danger)]">{error}</p>
          ) : items === null ? (
            <p className="p-2 text-xs text-[var(--color-muted-soft)]">加载中…</p>
          ) : items.length === 0 ? (
            <p className="p-2 text-xs text-[var(--color-muted-soft)]">
              素材库还是空的，先去「素材库」上传。
            </p>
          ) : (
            <div className="grid max-h-64 grid-cols-4 gap-1.5 overflow-y-auto">
              {items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  title={item.fileName ?? `素材 #${item.id}`}
                  disabled={busy}
                  className="aspect-square overflow-hidden rounded-md border border-[var(--color-edge)] transition hover:border-[var(--color-primary)]"
                  onClick={() => {
                    setOpen(false);
                    void onPick(item.id);
                  }}
                >
                  {item.mimeType?.startsWith("image/") ? (
                    <img
                      src={mediaUrl(item.id)}
                      alt={item.fileName ?? `素材 ${item.id}`}
                      className="h-full w-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <span className="grid h-full w-full place-items-center bg-[var(--surface-muted)] text-[10px] text-[var(--color-muted-soft)]">
                      {(item.mimeType ?? item.mediaType).split("/").pop()}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </span>
  );
}

function mediaUrl(mediaAssetId: number): string {
  return `/api/survey/media/${mediaAssetId}`;
}

/** 小游戏题的挑战包下拉：拉取小游戏管理里的全部包（含停用，便于回显）。
 *  选中时连同玩法类型一起写进 settings，答题端据此决定用哪个渲染器。 */
export function GamePackField({
  value,
  disabled,
  onChange,
}: {
  value: number | null;
  disabled: boolean;
  onChange: (packId: number | null, gameType: string | null) => void;
}) {
  const [packs, setPacks] = useState<AdminTaskPack[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetchAdminTaskPacks()
      .then((response) => {
        if (!cancelled) setPacks(response.packs);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "小游戏包加载失败");
      });
    return () => {
      cancelled = true;
    };
  }, []);
  if (error) return <p className="q-help">{error}</p>;
  if (packs === null) return <p className="q-help">小游戏包加载中…</p>;
  if (packs.length === 0) {
    return <p className="q-help">还没有可用的小游戏包——先去「小游戏管理」创建一个。</p>;
  }
  return (
    <select
      className="settings-input"
      value={value ?? ""}
      disabled={disabled}
      onChange={(event) => {
        const packId = event.target.value ? Number(event.target.value) : null;
        const pack = packs.find((item) => item.id === packId) ?? null;
        onChange(packId, pack?.gameType ?? null);
      }}
    >
      <option value="">选择小游戏包…</option>
      {packs.map((pack) => (
        <option key={pack.id} value={pack.id}>
          {pack.name}（{pack.gameType ?? "tower"}）
          {pack.enabled ? "" : " · 已停用"}
        </option>
      ))}
    </select>
  );
}

function mediaLabel(media: AttachmentMedia): string {
  return (
    media.fileName ||
    (media.mimeType && media.mimeType !== "application/octet-stream" ? media.mimeType : null) ||
    MEDIA_LABELS[media.mediaType] ||
    media.mediaType
  );
}

export function AttachmentChip({
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

export function NumberField({
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

export function QuestionForm({
  question,
  index,
  editable,
  editorMode = "pro",
  onFieldCommit,
  onLocalChange,
  onOptionRename,
  onAddOption,
  onDeleteOption,
  allQuestions,
  pages,
  onAttachQuestionMedia,
  onAttachQuestionMediaFromLibrary,
  onRemoveQuestionMedia,
  onAttachOptionMedia,
  onAttachOptionMediaFromLibrary,
  onRemoveOptionMedia,
}: QuestionFormProps) {
  const [newOptionLabel, setNewOptionLabel] = useState("");
  const [newColumn, setNewColumn] = useState("");
  const [mediaBusy, setMediaBusy] = useState<string | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const editableNow = editable && isEditableType(question.type);
  const isNote = question.type === "note";
  // S7 能力矩阵：基础模式隐藏校验 / Flag 类高级配置；专业模式全量。
  const proOnly = editorMode === "pro";
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
  // 剧情说话人（VN 名牌，仅 note 题）：settings.speaker。
  const commitSpeaker = (speaker: string) => {
    onLocalChange(question.id, { speaker: speaker.trim() || null });
    onFieldCommit(question.id, { settings: speaker.trim() ? { speaker: speaker.trim() } : null }, "说话人");
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
    commitCondition({ rules });
  };
  // 条件集中构建（P2 flags）：四个区段（选项跳转 / answerRules / flagRules /
  // flagJumps）互不覆盖——任一区段提交时都从 question.condition 读回其余区段。
  const commitCondition = (parts: {
    rules?: Array<{ optionId: number; targetQuestionId: number }>;
    flagRules?: Array<{ questionId: number; equals: number; flag: string; score: number }>;
    flagJumps?: Array<{ flag: string; gte: number; targetQuestionId: number }>;
  }) => {
    const saved = (question.condition ?? {}) as Record<string, unknown>;
    const savedAnswerRules = Array.isArray(saved.answerRules) ? saved.answerRules : undefined;
    const hasAny =
      Boolean(parts.rules?.length) ||
      Boolean(parts.flagRules?.length) ||
      Boolean(parts.flagJumps?.length) ||
      Boolean(savedAnswerRules?.length);
    const condition = hasAny
      ? {
          kind: "option_equals",
          ...(parts.rules?.length ? { rules: parts.rules } : {}),
          ...(savedAnswerRules?.length ? { answerRules: savedAnswerRules } : {}),
          ...(parts.flagRules?.length ? { flagRules: parts.flagRules } : {}),
          ...(parts.flagJumps?.length ? { flagJumps: parts.flagJumps } : {}),
        }
      : null;
    onLocalChange(question.id, { condition });
    onFieldCommit(question.id, { condition }, "跳转 / 剧情规则");
  };

  // ---- 剧情 flags（P2）----
  // 本题的 flagRules（questionId 指向自身的那些）：选项命中 → flag 累计分。
  const ownFlagRules = (() => {
    const map = new Map<number, { flag: string; score: number }>();
    const saved = (question.condition as { flagRules?: unknown } | null)?.flagRules;
    if (Array.isArray(saved)) {
      for (const rule of saved as Array<Record<string, unknown>>) {
        if (Number(rule.questionId) !== question.id) continue;
        const equals = Number(rule.equals);
        const flag = typeof rule.flag === "string" ? rule.flag : "";
        if (!flag || !Number.isFinite(equals)) continue;
        map.set(equals, { flag, score: Number(rule.score ?? 1) || 1 });
      }
    }
    return map;
  })();
  const commitFlagRule = (optionId: number, flag: string, score: number) => {
    const next = new Map(ownFlagRules);
    if (!flag.trim()) next.delete(optionId);
    else next.set(optionId, { flag: flag.trim(), score: Math.max(1, Math.floor(score) || 1) });
    // 其他题目引用的 flagRules 保留在条件里。
    const saved = ((question.condition as { flagRules?: unknown } | null)?.flagRules ?? []) as Array<
      Record<string, unknown>
    >;
    const others = saved
      .filter((rule) => Number(rule.questionId) !== question.id)
      .map((rule) => ({
        questionId: Number(rule.questionId),
        equals: Number(rule.equals),
        flag: String(rule.flag),
        score: Number(rule.score ?? 1),
      }));
    const own = [...next.entries()].map(([equals, value]) => ({
      questionId: question.id,
      equals,
      flag: value.flag,
      score: value.score,
    }));
    commitCondition({ flagRules: [...others, ...own] });
  };
  const flagJumps = (() => {
    const saved = (question.condition as { flagJumps?: unknown } | null)?.flagJumps;
    if (!Array.isArray(saved)) return [] as Array<{ flag: string; gte: number; targetQuestionId: number }>;
    return (saved as Array<Record<string, unknown>>)
      .filter(
        (jump) =>
          typeof jump.flag === "string" && Number.isFinite(Number(jump.gte)) && Number(jump.targetQuestionId) > 0,
      )
      .map((jump) => ({
        flag: String(jump.flag),
        gte: Number(jump.gte),
        targetQuestionId: Number(jump.targetQuestionId),
      }));
  })();
  // 未完成的行只存在于本地草稿（条件里只存完整行，避免发布图谱校验报错）。
  const [jumpDrafts, setJumpDrafts] = useState(flagJumps);
  useEffect(() => {
    setJumpDrafts(flagJumps);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [question.id, question.condition]);
  const commitFlagJumps = (list: Array<{ flag: string; gte: number; targetQuestionId: number }>) => {
    commitCondition({
      flagJumps: list.filter((jump) => jump.flag.trim() && jump.gte > 0 && jump.targetQuestionId > 0),
    });
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
        {isNote && editableNow ? (
          <label className="mt-1 block">
            <span className="q-label">
              说话人
              <span className="ml-1 q-help">（VN 模式下显示为名牌，留空 = 旁白）</span>
            </span>
            <input
              className="settings-input"
              defaultValue={question.speaker ?? ""}
              key={`speaker-${question.id}-${question.speaker ?? ""}`}
              disabled={!editableNow}
              onBlur={(event) => {
                if (event.target.value.trim() !== (question.speaker ?? "")) {
                  commitSpeaker(event.target.value);
                }
              }}
            />
          </label>
        ) : null}
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
          <span className="q-help">
            剧情文段不收集答案；可上传插图作配图，之后的题目选项可把答题者跳转到不同文段。
          </span>
        ) : null}
      </label>

      {question.type === "game" ? (
        <div className="q-field">
          <span className="q-label">小游戏包</span>
          <GamePackField
            value={question.gamePackId}
            disabled={!editableNow}
            onChange={(packId, gameType) => {
              onLocalChange(question.id, { gamePackId: packId });
              // gameType 一并落库：答题端靠它选渲染器（tower 走内置组件，
              // 其余走插件），服务端仍以 task_packs.game_type 为准。
              onFieldCommit(
                question.id,
                { settings: packId ? { game: { packId, ...(gameType ? { gameType } : {}) } } : null },
                "小游戏包",
              );
            }}
          />
          <span className="q-help">
            答题者在网页端完成该包的小游戏挑战，成绩记入答卷；配合剧情规则的 flagJumps（flag =
            game_passed_题目ID）即可实现"通关才能继续"。
          </span>
        </div>
      ) : null}

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
            aria-label="必答"
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
        <span className="q-label">
          {isNote ? "剧情配图 / 附件（可选）" : "题面附件（图片 / 视频 / 音频 / 文件，可选）"}
        </span>
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
          <div className="flex flex-wrap items-center gap-3">
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
            {onAttachQuestionMediaFromLibrary ? (
              <LibraryPicker
                busy={mediaBusy !== null}
                onPick={(assetId) =>
                  runMediaAction(`question-library-${assetId}`, () =>
                    onAttachQuestionMediaFromLibrary(question.id, assetId),
                  )
                }
              />
            ) : null}
          </div>
        ) : editableNow ? (
          <p className="q-help">新题目保存到服务器后即可添加附件（标题修改后约 2 秒自动保存）。</p>
        ) : null}
        <p className="q-help">附件会在答题页展示给填写者；单选/多选等题型的选项也可以单独配媒体。</p>
        {mediaError ? (
          <p className="q-help" style={{ color: "var(--app-danger)" }}>
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
                  aria-label={`第 ${index + 1} 题选项 ${option.label || option.id}`}
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
                    <span className="inline-flex items-center gap-2">
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
                      {onAttachOptionMediaFromLibrary ? (
                        <LibraryPicker
                          busy={mediaBusy !== null}
                          onPick={(assetId) =>
                            runMediaAction(`option-library-${option.id}-${assetId}`, () =>
                              onAttachOptionMediaFromLibrary(option.id, assetId),
                            )
                          }
                        />
                      ) : null}
                    </span>
                  ) : null}
                </div>
              ) : null}
              {jumpable ? (
                <div className="q-branch-row">
                  <GitBranch className="h-3.5 w-3.5 shrink-0" />
                  <span className="q-branch-label">选择后</span>
                  <select
                    className="q-branch-select"
                    aria-label={`选项 ${option.label || option.id} 的跳转目标`}
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
              {question.type === "single" && editableNow && proOnly ? (
                <div className="q-branch-row">
                  <Sparkles className="h-3.5 w-3.5 shrink-0" />
                  <span className="q-branch-label">命中 Flag</span>
                  <input
                    className="q-branch-select"
                    style={{ maxWidth: "9rem" }}
                    placeholder="flag 名，如 好感"
                    aria-label={`选项 ${option.label || option.id} 的 flag 名`}
                    defaultValue={ownFlagRules.get(option.id)?.flag ?? ""}
                    key={`flag-${option.id}-${ownFlagRules.get(option.id)?.flag ?? ""}`}
                    disabled={!editableNow}
                    onBlur={(event) =>
                      commitFlagRule(option.id, event.target.value, ownFlagRules.get(option.id)?.score ?? 1)
                    }
                  />
                  <input
                    type="number"
                    className="q-branch-select"
                    style={{ maxWidth: "4.5rem" }}
                    placeholder="分"
                    aria-label={`选项 ${option.label || option.id} 的 flag 分值`}
                    defaultValue={ownFlagRules.get(option.id)?.score ?? 1}
                    key={`flag-score-${option.id}-${ownFlagRules.get(option.id)?.score ?? 1}`}
                    disabled={!editableNow}
                    min={1}
                    onBlur={(event) =>
                      commitFlagRule(
                        option.id,
                        ownFlagRules.get(option.id)?.flag ?? "",
                        Number(event.target.value) || 1,
                      )
                    }
                  />
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

      {editableNow && proOnly ? (
        <div className="q-field">
          <span className="q-label">
            剧情 Flag 跳转
            <span className="ml-1 q-help">
              前面题目用「命中 Flag」累计的值达到门槛时，答题者直接跳到目标题——用于好感路线 /
              真结局锁定。删光所有行即回到线性顺序。
            </span>
          </span>
          {jumpDrafts.map((jump, jumpIndex) => (
            <div key={`flag-jump-${jumpIndex}`} className="q-branch-row flex-wrap">
              <Sparkles className="h-3.5 w-3.5 shrink-0" />
              <span className="q-branch-label">Flag</span>
              <input
                className="q-branch-select"
                style={{ maxWidth: "8rem" }}
                placeholder="flag 名"
                aria-label={`Flag 跳转 ${jumpIndex + 1} 的 flag 名`}
                defaultValue={jump.flag}
                disabled={!editableNow}
                onBlur={(event) => {
                  const next = [...jumpDrafts];
                  next[jumpIndex] = { ...jump, flag: event.target.value };
                  setJumpDrafts(next);
                  commitFlagJumps(next);
                }}
              />
              <span className="q-branch-label">≥</span>
              <input
                type="number"
                className="q-branch-select"
                style={{ maxWidth: "4.5rem" }}
                aria-label={`Flag 跳转 ${jumpIndex + 1} 的门槛`}
                defaultValue={jump.gte}
                min={1}
                disabled={!editableNow}
                onBlur={(event) => {
                  const next = [...jumpDrafts];
                  next[jumpIndex] = { ...jump, gte: Number(event.target.value) || 1 };
                  setJumpDrafts(next);
                  commitFlagJumps(next);
                }}
              />
              <span className="q-branch-label">→</span>
              <select
                className="q-branch-select"
                aria-label={`Flag 跳转 ${jumpIndex + 1} 的目标题目`}
                value={jump.targetQuestionId || ""}
                disabled={!editableNow}
                onChange={(event) => {
                  const next = [...jumpDrafts];
                  next[jumpIndex] = { ...jump, targetQuestionId: Number(event.target.value) };
                  setJumpDrafts(next);
                  commitFlagJumps(next);
                }}
              >
                <option value="">选择目标…</option>
                {allQuestions
                  .filter((item) => item.order > question.order)
                  .map((target) => (
                    <option key={target.id} value={target.id}>
                      {target.type === "note" ? "📖 " : ""}
                      {allQuestions.indexOf(target) + 1}. {target.title || "未命名"}
                    </option>
                  ))}
              </select>
              <button
                className="q-option-del"
                disabled={!editableNow}
                title="删除这条 Flag 跳转"
                onClick={() => {
                  const next = jumpDrafts.filter((_, index) => index !== jumpIndex);
                  setJumpDrafts(next);
                  commitFlagJumps(next);
                }}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ))}
          <div>
            <button
              type="button"
              className="btn btn-sm"
              disabled={!editableNow}
              onClick={() => setJumpDrafts([...jumpDrafts, { flag: "", gte: 1, targetQuestionId: 0 }])}
            >
              <Plus className="h-4 w-4" />
              添加 Flag 跳转
            </button>
          </div>
        </div>
      ) : null}

      {proOnly && (question.type === "text" || question.type === "long_text") ? (
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

      {proOnly && question.type === "number" ? (
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

      {proOnly && question.type === "multiple" ? (
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
  );
}
