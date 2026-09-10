import { useEffect, useMemo, useState } from "react";
import { Link, useBlocker, useNavigate, useParams } from "react-router";
import { ArrowLeft, ArrowRight, Eye, FilePlus2, Pencil, Redo2, Rocket, Save, Undo2 } from "lucide-react";
import { useApi } from "../hooks";
import { ApiError, apiSend, apiUpload, type EditorData, type PublishResult, type WriteResult } from "../api";
import { EmptyPanel, ErrorPanel, SkeletonPanel, StatusBadge } from "../components/ui";
import { QuestionCard, editableTypeList } from "../components/editor/QuestionCard";
import { StructureTree, type BuilderSelection } from "../components/editor/StructureTree";
import { LivePreview } from "../components/editor/LivePreview";
import { SurveyPreview } from "../components/editor/SurveyPreview";
import { useSurveyEditor, type SurveyMetaState } from "../editor/useSurveyEditor";
import { buildEditorPreviewFlow } from "../editor/previewModel";
import { useDialogs } from "../components/Dialogs";
import { formatDateTime, matrixColumns } from "../format";

// Phase 2.4: field edits commit on blur into a pending-op
// queue; 保存 flushes it sequentially (temp ids resolve to server ids).
// Dirty state protects browser and SPA navigation; stale writes require reload.
export function EditorPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, retry } = useApi<EditorData>(id ? `/api/admin/surveys/${id}/editor` : null);

  if (error) return <ErrorPanel error={error} onRetry={retry} />;
  if (!data) return <SkeletonPanel lines={6} />;
  if (!data.survey.editable) return <ReadOnlyEditor data={data} />;
  return <EditableEditor data={data} />;
}

function EditableEditor({ data }: { data: EditorData }) {
  const editor = useSurveyEditor(data);
  const navigate = useNavigate();
  const [selection, setSelection] = useState<BuilderSelection>(() =>
    data.questions.length ? { kind: "question", id: data.questions[0]!.id } : { kind: "settings" },
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const { survey } = data;
  const { confirm } = useDialogs();

  useEffect(() => {
    // Autosave: flush pending edits after 2s of inactivity (unless saving or
    // an error needs attention).
    if (!editor.dirty || editor.saveState === "saving" || editor.saveState === "error") return;
    const timer = window.setTimeout(() => {
      void editor.save();
    }, 2000);
    return () => window.clearTimeout(timer);
  }, [editor]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      const key = event.key.toLowerCase();
      if (key === "z") {
        event.preventDefault();
        if (event.shiftKey) editor.redo();
        else editor.undo();
      } else if (key === "y") {
        event.preventDefault();
        editor.redo();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editor]);

  // Keep the selection valid as questions are added / removed / reloaded.
  useEffect(() => {
    if (selection.kind !== "question") return;
    if (!editor.questions.some((question) => question.id === selection.id)) {
      setSelection(editor.questions.length ? { kind: "question", id: editor.questions[0]!.id } : { kind: "settings" });
    }
  }, [editor.questions, selection]);

  const editingDisabled = editor.saveState === "saving" || Boolean(editor.saveError?.stale);
  const previewQuestions = useMemo(
    () => buildEditorPreviewFlow(survey.id, editor.questions),
    [editor.questions, survey.id],
  );
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) => editor.dirty && currentLocation.pathname !== nextLocation.pathname,
  );

  useEffect(() => {
    if (blocker.state !== "blocked") return;
    void (async () => {
      const ok = await confirm({ message: "有未保存的修改，确定离开？" });
      if (ok) blocker.proceed();
      else blocker.reset();
    })();
  }, [blocker, confirm]);

  const selectedQuestion =
    selection.kind === "question" ? (editor.questions.find((question) => question.id === selection.id) ?? null) : null;
  const questionIndex = selectedQuestion
    ? editor.questions.findIndex((question) => question.id === selectedQuestion.id)
    : -1;
  const previewIndex = selectedQuestion
    ? Math.max(
        0,
        previewQuestions.findIndex((question) => question.id === selectedQuestion.id),
      )
    : 0;

  const handleFieldCommit = (questionId: number, patch: Record<string, unknown>, label: string) => {
    if (Object.keys(patch).length) editor.queueQuestionPatch(questionId, patch, label);
  };

  const handleOptionRename = (questionId: number, optionId: number, label: string) => {
    editor.renameOption(questionId, optionId, label);
  };

  const backWithGuard = () => {
    navigate(`/surveys/${survey.id}`);
  };

  const addDefaultQuestion = (type: string) => {
    const defaults: Record<string, { title: string; options?: { label: string }[]; columns?: string[] }> = {
      single: { title: "新的单选题", options: [{ label: "选项 1" }, { label: "选项 2" }] },
      multiple: { title: "新的多选题", options: [{ label: "选项 1" }, { label: "选项 2" }] },
      yes_no: { title: "新的是非题", options: [{ label: "是" }, { label: "否" }] },
      rating: { title: "新的评分题", options: [{ label: "1 星" }, { label: "5 星" }] },
      matrix: { title: "新的矩阵题", options: [{ label: "行 1" }], columns: ["列 1", "列 2"] },
      text: { title: "新的文本题" },
      long_text: { title: "新的长文本题" },
      number: { title: "新的数字题" },
      date: { title: "新的日期题" },
      time: { title: "新的时间题" },
      image: { title: "上传照片（资料卡图片题）" },
      video: { title: "上传视频题" },
      audio: { title: "上传音频题" },
      file: { title: "上传文件题" },
    };
    const draft = defaults[type] ?? { title: "新题目" };
    const tempId = editor.addQuestion({ type, ...draft });
    setSelection({ kind: "question", id: tempId });
    setPickerOpen(false);
  };

  // Structural actions hit the server directly and then reload, so any
  // pending ops must be flushed first — silently reloading would drop them.
  const duplicateQuestion = async (questionId: number) => {
    if (editor.dirty && !(await editor.save())) return;
    try {
      await apiSend("POST", `/api/admin/surveys/${survey.id}/questions/${questionId}/duplicate`, {});
      editor.discardAndReload();
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : "复制题目失败");
    }
  };

  const duplicateOption = async (questionId: number, optionId: number) => {
    if (editor.dirty && !(await editor.save())) return;
    try {
      await apiSend("POST", `/api/admin/surveys/${survey.id}/options/${optionId}/duplicate`, {});
      editor.discardAndReload();
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : "复制选项失败");
    }
  };

  const flushDraft = async (): Promise<boolean> => {
    if (editor.dirty && !(await editor.save())) return false;
    return true;
  };

  const attachQuestionMedia = async (questionId: number, file: File): Promise<boolean> => {
    if (!(await flushDraft())) return false;
    try {
      await apiUpload(`/api/admin/surveys/${survey.id}/questions/${questionId}/media`, file);
      setPublishError(null);
      editor.discardAndReload();
      return true;
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : "上传题面附件失败");
      return false;
    }
  };

  const removeQuestionMedia = async (questionId: number, mediaAssetId: number): Promise<boolean> => {
    if (!(await flushDraft())) return false;
    try {
      await apiSend("DELETE", `/api/admin/surveys/${survey.id}/questions/${questionId}/media/${mediaAssetId}`);
      setPublishError(null);
      editor.discardAndReload();
      return true;
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : "移除题面附件失败");
      return false;
    }
  };

  const attachOptionMedia = async (optionId: number, file: File): Promise<boolean> => {
    if (!(await flushDraft())) return false;
    try {
      await apiUpload(`/api/admin/surveys/${survey.id}/options/${optionId}/media`, file);
      setPublishError(null);
      editor.discardAndReload();
      return true;
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : "上传选项媒体失败");
      return false;
    }
  };

  const removeOptionMedia = async (optionId: number, mediaAssetId: number): Promise<boolean> => {
    if (!(await flushDraft())) return false;
    try {
      await apiSend("DELETE", `/api/admin/surveys/${survey.id}/options/${optionId}/media/${mediaAssetId}`);
      setPublishError(null);
      editor.discardAndReload();
      return true;
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : "移除选项媒体失败");
      return false;
    }
  };

  const addPage = async () => {
    if (editor.dirty && !(await editor.save())) return;
    try {
      await apiSend("POST", `/api/admin/surveys/${survey.id}/pages`, {
        title: `第 ${data.pages.length + 1} 页`,
      });
      editor.discardAndReload();
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : "新建分页失败");
    }
  };

  const deletePage = async (pageId: number) => {
    if (!(await confirm({ message: "删除该分页？题目不会被删除，只会变为不分页。" }))) return;
    if (editor.dirty && !(await editor.save())) return;
    try {
      await apiSend("DELETE", `/api/admin/surveys/${survey.id}/pages/${pageId}`);
      editor.discardAndReload();
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : "删除分页失败");
    }
  };

  const moveQuestion = (questionId: number, direction: -1 | 1) => {
    const ids = editor.questions.map((question) => question.id);
    const index = ids.indexOf(questionId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= ids.length) return;
    const next = [...ids];
    const current = next[index]!;
    const swap = next[target]!;
    next[index] = swap;
    next[target] = current;
    editor.reorderQuestions(next);
  };

  const publish = async () => {
    if (editor.dirty || publishing) return;
    if (!(await confirm({ message: `确定发布“${editor.surveyMeta.title}”？发布后需复制为新草稿才能继续编辑。` }))) return;
    setPublishing(true);
    setPublishError(null);
    try {
      await apiSend<PublishResult>("POST", `/api/admin/surveys/${survey.id}/publish`, {
        baseUpdatedAt: editor.baseUpdatedAt,
      });
      window.location.reload();
    } catch (error) {
      setPublishError((error as ApiError).message);
      setPublishing(false);
    }
  };

  const saveStateLabel =
    editor.saveState === "saving"
      ? "保存中…"
      : editor.saveState === "error"
        ? "保存失败"
        : editor.saveState === "dirty"
          ? "有未保存的修改"
          : "已保存";
  const saveStateClass =
    editor.saveState === "saving"
      ? ""
      : editor.saveState === "error"
        ? "is-error"
        : editor.saveState === "dirty"
          ? "is-dirty"
          : "is-saved";

  const selectQuestion = (questionId: number) => setSelection({ kind: "question", id: questionId });
  const navigatePreview = (index: number) => {
    const question = previewQuestions[index];
    if (question) selectQuestion(question.id);
  };

  return (
    <div className="editor-page">
      <header className="editor-topbar">
        <div className="editor-topbar-main">
          <button className="btn btn-icon" title="返回详情（有未保存修改时会确认）" onClick={backWithGuard}>
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div className="editor-title">
            <div className="editor-title-name">
              <EditableTitle
                value={editor.surveyMeta.title || "未命名问卷"}
                disabled={editingDisabled}
                onCommit={(next) => {
                  if (next && next !== editor.surveyMeta.title) {
                    editor.updateSurveyMeta({ title: next });
                  }
                }}
              />
              <StatusBadge status={survey.status} />
            </div>
            <div className="editor-title-meta">
              {editor.questions.length} 题 · 最后保存于 {formatDateTime(editor.baseUpdatedAt)}
            </div>
          </div>
        </div>
        <div className="editor-actions">
          <span className={`editor-save-state ${saveStateClass}`}>{saveStateLabel}</span>
          <button
            className="btn btn-sm btn-quiet"
            disabled={!editor.canUndo}
            title="撤销（Ctrl+Z）"
            onClick={() => editor.undo()}
          >
            <Undo2 className="h-4 w-4" />
          </button>
          <button
            className="btn btn-sm btn-quiet"
            disabled={!editor.canRedo}
            title="重做（Ctrl+Shift+Z / Ctrl+Y）"
            onClick={() => editor.redo()}
          >
            <Redo2 className="h-4 w-4" />
          </button>
          <button className="btn btn-sm" disabled={editor.saveState === "saving"} onClick={() => editor.save()}>
            <Save className="h-4 w-4" />
            保存
          </button>
          <button className="btn btn-sm" disabled={editor.saveState === "saving"} onClick={() => setPreviewOpen(true)}>
            <Eye className="h-4 w-4" />
            预览
          </button>
          <button
            className="btn btn-sm btn-accent"
            disabled={editingDisabled || editor.dirty || publishing || editor.questions.length === 0}
            title={editor.dirty ? "请先保存修改" : "发布后问卷将进入只读状态"}
            onClick={publish}
          >
            {publishing ? (
              "发布中…"
            ) : (
              <>
                <Rocket className="h-4 w-4" />
                发布
              </>
            )}
          </button>
        </div>
      </header>

      {publishError ? <div className="alert alert-error">操作失败：{publishError}</div> : null}
      {editor.saveError ? (
        <div className="alert alert-error">
          <span>
            {editor.saveError.stale ? "检测到其他窗口的更新：" : "保存失败："}
            {editor.saveError.message}
          </span>
          {!editor.saveError.stale ? (
            <button className="btn btn-sm" onClick={() => editor.save()}>
              重试保存
            </button>
          ) : null}
          <button className="btn btn-sm" onClick={editor.discardAndReload}>
            {editor.saveError.stale ? "放弃本地修改并加载最新版" : "放弃修改并刷新"}
          </button>
        </div>
      ) : null}

      <div className="editor-body">
        <aside className="editor-structure editor-col">
          <StructureTree
            pages={data.pages.map((page) => ({ id: page.id, title: page.title, order: page.order }))}
            questions={editor.questions}
            selection={selection}
            onSelect={setSelection}
            editable={!editingDisabled}
            onAddPage={() => void addPage()}
            onDeletePage={(pageId) => void deletePage(pageId)}
            onMoveQuestion={moveQuestion}
          />
        </aside>

        <main className="editor-canvas editor-col">
          {selection.kind === "settings" ? (
            <SurveySettingsPanel
              meta={editor.surveyMeta}
              disabled={editingDisabled}
              onUpdate={(patch) => editor.updateSurveyMeta(patch)}
            />
          ) : selectedQuestion ? (
            <>
              <QuestionCard
                key={selectedQuestion.id}
                question={selectedQuestion}
                index={questionIndex}
                editable={!editingDisabled}
                onFieldCommit={handleFieldCommit}
                onLocalChange={editor.patchQuestionLocal}
                onOptionRename={handleOptionRename}
                onAddOption={editor.addOption}
                onDeleteOption={editor.deleteOption}
                onDelete={(questionId) => editor.deleteQuestion(questionId)}
                onDuplicateQuestion={(questionId) => void duplicateQuestion(questionId)}
                onDuplicateOption={(questionId, optionId) => void duplicateOption(questionId, optionId)}
                onAttachQuestionMedia={(questionId, file) => attachQuestionMedia(questionId, file)}
                onRemoveQuestionMedia={(questionId, mediaAssetId) => removeQuestionMedia(questionId, mediaAssetId)}
                onAttachOptionMedia={(optionId, file) => attachOptionMedia(optionId, file)}
                onRemoveOptionMedia={(optionId, mediaAssetId) => removeOptionMedia(optionId, mediaAssetId)}
                allQuestions={editor.questions}
                pages={data.pages.map((page) => ({ id: page.id, title: page.title, order: page.order }))}
              />
              <div className="q-nav">
                <button
                  className="btn btn-sm"
                  disabled={questionIndex <= 0}
                  onClick={() => questionIndex > 0 && selectQuestion(editor.questions[questionIndex - 1]!.id)}
                >
                  <ArrowLeft className="h-4 w-4" />
                  上一题
                </button>
                <span className="q-nav-position">
                  第 {questionIndex + 1} / {editor.questions.length} 题
                </span>
                <button
                  className="btn btn-sm"
                  disabled={questionIndex >= editor.questions.length - 1}
                  onClick={() =>
                    questionIndex < editor.questions.length - 1 &&
                    selectQuestion(editor.questions[questionIndex + 1]!.id)
                  }
                >
                  下一题
                  <ArrowRight className="h-4 w-4" />
                </button>
              </div>
            </>
          ) : (
            <EmptyPanel text="这份问卷还没有题目，点击下方「添加题目」开始" />
          )}
          <div className="add-question-wrap mt-3">
            <button className="btn w-full" disabled={editingDisabled} onClick={() => setPickerOpen((open) => !open)}>
              <FilePlus2 className="h-4 w-4" />
              添加题目
            </button>
            {pickerOpen ? (
              <div className="add-question-menu is-inline">
                <div className="add-question-menu-title">选择题型</div>
                <div className="grid grid-cols-2 gap-1">
                  {editableTypeList().map(({ type, label }) => (
                    <button
                      key={type}
                      className="add-question-item"
                      disabled={editingDisabled}
                      onClick={() => addDefaultQuestion(type)}
                    >
                      <span className="truncate">{label}</span>
                    </button>
                  ))}
                </div>
                <p className="px-2 pb-1 pt-2 text-[11px]" style={{ color: "var(--color-muted-soft)" }}>
                  图片 / 视频 / 音频 / 文件上传题由作答者上传对应媒体；题干与选项附件可在题卡内直接上传。
                </p>
              </div>
            ) : null}
          </div>
        </main>

        <aside className="editor-preview editor-col">
          <LivePreview
            title={editor.surveyMeta.title}
            description={editor.surveyMeta.description}
            questions={previewQuestions}
            currentIndex={Math.min(previewIndex, Math.max(0, previewQuestions.length - 1))}
            dirty={editor.dirty}
            onNavigate={navigatePreview}
            onOpenFull={() => setPreviewOpen(true)}
          />
        </aside>
      </div>

      {previewOpen ? (
        <SurveyPreview
          title={editor.surveyMeta.title}
          description={editor.surveyMeta.description}
          questions={previewQuestions}
          dirty={editor.dirty}
          onClose={() => setPreviewOpen(false)}
        />
      ) : null}
    </div>
  );
}

function EditableTitle({
  value,
  disabled,
  onCommit,
}: {
  value: string;
  disabled: boolean;
  onCommit: (next: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  if (!editing) {
    return (
      <button
        type="button"
        className="editor-title-edit"
        disabled={disabled}
        title={disabled ? undefined : "点击修改问卷标题"}
        onClick={() => {
          setDraft(value);
          setEditing(true);
        }}
      >
        <span className="truncate">{value}</span>
        {!disabled ? <Pencil className="editor-title-edit-icon h-3.5 w-3.5" /> : null}
      </button>
    );
  }

  return (
    <input
      autoFocus
      className="editor-title-input"
      value={draft}
      maxLength={200}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        setEditing(false);
        const next = draft.trim();
        if (next) onCommit(next);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          (event.target as HTMLInputElement).blur();
        } else if (event.key === "Escape") {
          setEditing(false);
        }
      }}
    />
  );
}

function SurveySettingsPanel({
  meta,
  disabled,
  onUpdate,
}: {
  meta: SurveyMetaState;
  disabled: boolean;
  onUpdate: (patch: Partial<SurveyMetaState>) => void;
}) {
  return (
    <div className="settings-panel">
      <div>
        <div className="settings-panel-title">问卷设置</div>
        <div className="settings-panel-sub">标题、描述与填写规则会应用到整个问卷</div>
      </div>

      <label className="settings-field">
        <span className="q-label">标题</span>
        <input
          className="settings-input"
          value={meta.title}
          disabled={disabled}
          placeholder="问卷标题"
          onChange={(event) => {
            const next = event.target.value;
            if (next !== meta.title) onUpdate({ title: next });
          }}
        />
      </label>

      <label className="settings-field">
        <span className="q-label">描述</span>
        <input
          className="settings-input"
          value={meta.description}
          disabled={disabled}
          placeholder="给答题者的整体说明（可选）"
          onChange={(event) => {
            const next = event.target.value;
            if (next !== meta.description) onUpdate({ description: next });
          }}
        />
      </label>

      <div className="settings-check">
        <div>
          <div className="q-label">匿名填写</div>
          <div className="q-help">开启后不记录答题者的 Telegram 身份</div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={meta.anonymous}
          className="switch"
          data-on={meta.anonymous}
          disabled={disabled}
          onClick={() => onUpdate({ anonymous: !meta.anonymous })}
        />
      </div>

      <div className="settings-check">
        <div>
          <div className="q-label">允许重复填写</div>
          <div className="q-help">同一用户可多次提交本问卷</div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={meta.allowMultipleResponses}
          className="switch"
          data-on={meta.allowMultipleResponses}
          disabled={disabled}
          onClick={() => onUpdate({ allowMultipleResponses: !meta.allowMultipleResponses })}
        />
      </div>

      {meta.allowMultipleResponses ? (
        <label className="settings-field">
          <span className="q-label">每人填写上限（0 = 不限）</span>
          <input
            type="number"
            min={0}
            max={999}
            className="settings-input"
            defaultValue={meta.maxResponsesPerUser}
            disabled={disabled}
            onBlur={(event) => {
              const next = Number(event.target.value);
              if (Number.isInteger(next) && next !== meta.maxResponsesPerUser) {
                onUpdate({ maxResponsesPerUser: next });
              }
            }}
          />
        </label>
      ) : null}
    </div>
  );
}

function ReadOnlyEditor({ data }: { data: EditorData }) {
  const { survey, questions } = data;
  const navigate = useNavigate();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [duplicateError, setDuplicateError] = useState<string | null>(null);
  const previewQuestions = useMemo(
    () =>
      buildEditorPreviewFlow(
        survey.id,
        questions.map((question) => ({
          ...question,
          columns: matrixColumns(question.settings),
        })),
      ),
    [questions, survey.id],
  );
  const duplicateAsDraft = async () => {
    if (duplicating) return;
    setDuplicating(true);
    setDuplicateError(null);
    try {
      const duplicate = await apiSend<WriteResult>("POST", `/api/admin/surveys/${survey.id}/duplicate`, {
        baseUpdatedAt: survey.updatedAt,
      });
      if (typeof duplicate.id !== "number") throw new Error("复制成功，但未返回新问卷编号");
      navigate(`/surveys/${duplicate.id}/editor`);
    } catch (error) {
      setDuplicateError(error instanceof Error ? error.message : "复制失败");
      setDuplicating(false);
    }
  };
  return (
    <div className="editor-page">
      <header className="editor-topbar">
        <div className="editor-topbar-main">
          <Link to={`/surveys/${survey.id}`} className="btn btn-icon" title="返回详情">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div className="editor-title">
            <div className="editor-title-name">
              <span className="truncate">{survey.title || "未命名问卷"}</span>
              <StatusBadge status={survey.status} />
            </div>
            <div className="editor-title-meta">
              {survey.questionCount} 题 · 更新于 {formatDateTime(survey.updatedAt)}
            </div>
          </div>
        </div>
        <div className="editor-actions">
          <button className="btn btn-sm" onClick={() => setPreviewOpen(true)}>
            <Eye className="h-4 w-4" />
            预览
          </button>
          <button className="btn btn-sm btn-accent" disabled={duplicating} onClick={duplicateAsDraft}>
            {duplicating ? "复制中…" : "复制为新草稿"}
          </button>
        </div>
      </header>

      <div className="alert alert-warning">
        该问卷当前不可编辑（{survey.status !== "draft" ? "非草稿状态" : `已有 ${survey.responseCount} 份答卷`}）。
        复制为新草稿后编辑的入口将在后续批次提供；当前为只读视图。
      </div>
      {duplicateError ? <div className="alert alert-error">复制失败：{duplicateError}</div> : null}

      <div className="editor-body">
        <aside className="editor-structure editor-col">
          <ReadOnlyTree questions={questions} />
        </aside>
        <main className="editor-canvas editor-col">
          <div className="settings-panel">
            <div>
              <div className="settings-panel-title">题目列表（只读）</div>
              <div className="settings-panel-sub">共 {questions.length} 题</div>
            </div>
            {questions.length ? (
              <div className="grid gap-3">
                {questions.map((question, index) => (
                  <ReadOnlyQuestion key={question.id} question={question} index={index} />
                ))}
              </div>
            ) : (
              <EmptyPanel text="这份问卷还没有题目" />
            )}
          </div>
        </main>
      </div>

      {previewOpen ? (
        <SurveyPreview
          title={survey.title}
          description={survey.description ?? ""}
          questions={previewQuestions}
          dirty={false}
          onClose={() => setPreviewOpen(false)}
        />
      ) : null}
    </div>
  );
}

function ReadOnlyTree({ questions }: { questions: EditorData["questions"] }) {
  return (
    <div className="structure-panel">
      <div className="structure-head">
        <span>问卷结构</span>
      </div>
      <div className="structure-tree">
        {questions.map((question, index) => (
          <div key={question.id} className="tree-question">
            <span className="tree-question-index">{index + 1}</span>
            <span className="tree-question-title">{question.title || "未命名题目"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ReadOnlyQuestion({ question, index }: { question: EditorData["questions"][number]; index: number }) {
  return (
    <div className="q-editor">
      <div className="q-editor-head">
        <div className="q-badges">
          <span className="q-index">第 {index + 1} 题</span>
          <span
            className="q-chip"
            style={{
              background: "color-mix(in srgb, var(--color-primary) 13%, var(--surface))",
              color: "var(--color-primary)",
            }}
          >
            {question.type}
          </span>
          <span
            className="q-chip"
            style={{
              background: question.required
                ? "color-mix(in srgb, var(--color-danger) 12%, var(--surface))"
                : "var(--surface-muted)",
              color: question.required ? "var(--color-danger)" : "var(--color-muted)",
            }}
          >
            {question.required ? "必答" : "选答"}
          </span>
        </div>
      </div>
      <div className="q-body">
        <div className="q-title-input" style={{ background: "var(--surface-input)", padding: "11px 13px" }}>
          {question.title || "未填写题目标题"}
        </div>
        {question.description ? <div className="q-help">{question.description}</div> : null}
        {question.options.length ? (
          <div className="grid gap-1.5">
            {question.options.map((option, optionIndex) => (
              <div key={option.id} className="q-option-row">
                <span className="q-option-glyph round">•</span>
                <span className="q-option-input" style={{ padding: "8px 11px" }}>
                  {optionIndex + 1}. {option.label}
                </span>
              </div>
            ))}
          </div>
        ) : null}
        {matrixColumns(question.settings).length ? (
          <div className="flex flex-wrap gap-1.5">
            {matrixColumns(question.settings).map((column) => (
              <span key={column} className="q-column-chip">
                列：{column}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
