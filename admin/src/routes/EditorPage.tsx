import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { Link, useBlocker, useNavigate, useParams, useSearchParams } from "react-router";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  BookOpen,
  Eye,
  FilePlus2,
  MousePointerClick,
  Plus,
  Redo2,
  Rocket,
  Save,
  Sparkles,
  Undo2,
} from "lucide-react";
import { useApi } from "../hooks";
import { apiSend, type EditorData, type WriteResult } from "../api";
import { EmptyPanel, ErrorPanel, Modal, SkeletonPanel, StatusBadge } from "../components/ui";
import { QuestionCard } from "../components/editor/QuestionCard";
import { StructureTree, type BuilderSelection } from "../components/editor/StructureTree";
import { QuestionSummaryRow } from "../components/editor/QuestionSummaryRow";
import { TypePickerSheet } from "../components/editor/TypePickerSheet";
import { SurveySettingsPanel } from "../components/editor/SurveySettingsPanel";
import { EditableTitle } from "../components/editor/EditableTitle";
import { LivePreview } from "../components/editor/LivePreview";
import { TrialPlay } from "../components/editor/TrialPlay";
import { SurveyPreview } from "../components/editor/SurveyPreview";
import { useSurveyEditor } from "../editor/useSurveyEditor";
import { buildEditorPreviewFlow } from "../editor/previewModel";
import { useEditorActions } from "../editor/editor-actions";
import { TEMPLATE_OPTIONS } from "../editor/templates";
import { LogicPanel } from "../components/editor/LogicPanel";
import { useDialogs } from "../components/Dialogs";
import { formatDateTime, matrixColumns, QUESTION_TYPE_LABELS } from "../format";

// P2 新壳按需加载：只有 ?ui=next 时才拉取这份 chunk，旧壳路径的包体不变。
const EditorShellNext = lazy(() =>
  import("../components/editor/next/EditorShell").then((module) => ({ default: module.EditorShellNext })),
);

// Phase 2.4: field edits commit on blur into a pending-op
// queue; 保存 flushes it sequentially (temp ids resolve to server ids).
// Dirty state protects browser and SPA navigation; stale writes require reload.
export function EditorPage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const { data, error, retry } = useApi<EditorData>(id ? `/api/admin/surveys/${id}/editor` : null);

  if (error) return <ErrorPanel error={error} onRetry={retry} />;
  if (!data) return <SkeletonPanel lines={6} />;
  if (!data.survey.editable) return <ReadOnlyEditor data={data} />;
  // P2 三栏外壳并行验证：默认仍走旧壳，?ui=next 才进新壳（交接文档 S0）。
  if (searchParams.get("ui") === "next") {
    return (
      <Suspense fallback={<SkeletonPanel lines={6} />}>
        <EditorShellNext data={data} />
      </Suspense>
    );
  }
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
  const [trialFrom, setTrialFrom] = useState<number | null>(null);
  /**
   * 基础 / 专业模式。基础模式隐藏高级配置（结果规则、逻辑面板）并给引导，
   * 专业模式开放全量。只影响可见性，不重建文档，所以切换天然不丢进度。
   */
  const [editorMode, setEditorMode] = useState<"basic" | "pro">(() => {
    try {
      return window.localStorage.getItem("admin:editor-mode") === "pro" ? "pro" : "basic";
    } catch {
      return "basic";
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem("admin:editor-mode", editorMode);
    } catch {
      // 隐私模式写不进去不影响本次编辑
    }
  }, [editorMode]);
  /** 右栏页签：预览 / 逻辑（逻辑仅专业模式可见）。 */
  const [rightTab, setRightTab] = useState<"preview" | "logic">("preview");
  useEffect(() => {
    if (editorMode === "basic" && rightTab === "logic") setRightTab("preview");
  }, [editorMode, rightTab]);
  const { survey } = data;
  const { confirm } = useDialogs();

  // 结构/媒体/发布等动作与 P2 新壳共用同一份实现（editor-actions）。
  const {
    publishing,
    publishError,
    sceneBusy,
    duplicateQuestion,
    duplicateOption,
    openSceneEditor,
    addSceneQuestion,
    requestDeleteQuestion,
    applyTemplate,
    addQuestionOfType,
    attachQuestionMedia,
    attachQuestionMediaFromLibrary,
    removeQuestionMedia,
    attachOptionMedia,
    attachOptionMediaFromLibrary,
    removeOptionMedia,
    addPage,
    deletePage,
    moveQuestion,
    publish,
  } = useEditorActions(data, editor);

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
    const tempId = addQuestionOfType(type);
    applySelection({ kind: "question", id: tempId });
    setPickerOpen(false);
  };

  /** 模板选择弹层。 */
  const [templateOpen, setTemplateOpen] = useState(false);

  // 选中即展开对应卡片；切换后滚到可视区，手机上尤其需要（列表就是导航）。
  const applySelection = (next: BuilderSelection) => {
    setSelection(next);
    requestAnimationFrame(() => {
      if (next.kind === "question") {
        document
          .querySelector(`[data-block-id="${next.id}"]`)
          ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      } else {
        document.querySelector(".editor-canvas")?.scrollTo({ top: 0, behavior: "smooth" });
      }
    });
  };
  const selectQuestion = (questionId: number) => applySelection({ kind: "question", id: questionId });
  const navigatePreview = (index: number) => {
    const question = previewQuestions[index];
    if (question) selectQuestion(question.id);
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
          {/* 基础 / 专业模式：只改可见性，不动文档——切换不丢进度。 */}
          <div className="flex overflow-hidden rounded-full border border-[var(--color-edge)]" role="group" aria-label="编辑模式">
            {(["basic", "pro"] as const).map((value) => (
              <button
                key={value}
                type="button"
                className={`px-2.5 py-1 text-[11px] font-semibold ${
                  editorMode === value
                    ? "bg-[var(--color-primary)] text-[var(--color-primary-contrast,#fff)]"
                    : "text-[var(--color-muted)]"
                }`}
                aria-pressed={editorMode === value}
                onClick={() => setEditorMode(value)}
              >
                {value === "basic" ? "基础" : "专业"}
              </button>
            ))}
          </div>
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
          <button
            className="btn btn-sm editor-desktop-action"
            disabled={editor.saveState === "saving"}
            onClick={() => editor.save()}
          >
            <Save className="h-4 w-4" />
            保存
          </button>
          <button
            className="btn btn-sm editor-desktop-action"
            disabled={editor.saveState === "saving"}
            onClick={() => setPreviewOpen(true)}
          >
            <Eye className="h-4 w-4" />
            预览
          </button>
          <button
            className="btn btn-sm btn-accent editor-desktop-action"
            disabled={editingDisabled || editor.dirty || publishing || editor.questions.length === 0}
            title={editor.dirty ? "请先保存修改" : "发布后问卷将进入只读状态"}
            onClick={() => void publish()}
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
            onSelect={applySelection}
            editable={!editingDisabled}
            onAddPage={() => void addPage()}
            onDeletePage={(pageId) => void deletePage(pageId)}
            onMoveQuestion={moveQuestion}
            onBatchRequired={(questionIds, required) => {
              for (const questionId of questionIds) {
                // Single-question edits update local state and enqueue; the
                // batch path only enqueued, so the switches and the live
                // preview kept the old value until the next reload — and a
                // follow-up manual toggle then wrote the stale one back.
                editor.patchQuestionLocal(questionId, { required });
                editor.queueQuestionPatch(questionId, { required }, required ? "批量设为必答" : "批量设为选填");
              }
            }}
          />
        </aside>

        <main className="editor-canvas editor-col">
          {selection.kind === "settings" ? (
            <div className="block-item">
              <SurveySettingsPanel
                surveyId={survey.id}
                questions={editor.questions}
                meta={editor.surveyMeta}
                disabled={editingDisabled}
                coinAccess={data.coinAccess ?? { enabled: false, autoPrice: true, basePrice: 0, fixedPrice: null }}
                onUpdate={(patch) => editor.updateSurveyMeta(patch)}
              />
            </div>
          ) : null}
          <div className="block-list">
            {editor.questions.map((question, index) => {
              const active = selection.kind === "question" && selection.id === question.id;
              if (active) {
                return (
                  <div key={question.id} data-block-id={question.id} className="block-item is-active">
                    <QuestionCard
                      question={question}
                      index={index}
                      editable={!editingDisabled}
                      dragHandle={
                        <span className="q-move">
                          <button
                            type="button"
                            className="row-action"
                            title="上移"
                            disabled={!editingDisabled ? undefined : true}
                            onClick={(event) => {
                              event.stopPropagation();
                              moveQuestion(question.id, -1);
                            }}
                          >
                            <ArrowUp className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            className="row-action"
                            title="下移"
                            onClick={(event) => {
                              event.stopPropagation();
                              moveQuestion(question.id, 1);
                            }}
                          >
                            <ArrowDown className="h-3.5 w-3.5" />
                          </button>
                        </span>
                      }
                      onFieldCommit={handleFieldCommit}
                      onLocalChange={editor.patchQuestionLocal}
                      onOptionRename={handleOptionRename}
                      onAddOption={editor.addOption}
                      onDeleteOption={editor.deleteOption}
                      onDelete={(questionId) => void requestDeleteQuestion(questionId)}
                      onDuplicateQuestion={(questionId) => void duplicateQuestion(questionId)}
                      onDuplicateOption={(questionId, optionId) => void duplicateOption(questionId, optionId)}
                      onAttachQuestionMedia={(questionId, file) => attachQuestionMedia(questionId, file)}
                      onAttachQuestionMediaFromLibrary={(questionId, assetId) =>
                        attachQuestionMediaFromLibrary(questionId, assetId)
                      }
                      onRemoveQuestionMedia={(questionId, mediaAssetId) =>
                        removeQuestionMedia(questionId, mediaAssetId)
                      }
                      onAttachOptionMedia={(optionId, file) => attachOptionMedia(optionId, file)}
                      onAttachOptionMediaFromLibrary={(optionId, assetId) =>
                        attachOptionMediaFromLibrary(optionId, assetId)
                      }
                      onRemoveOptionMedia={(optionId, mediaAssetId) => removeOptionMedia(optionId, mediaAssetId)}
                      onOpenSceneEditor={(questionId) => void openSceneEditor(questionId)}
                      allQuestions={editor.questions}
                      pages={data.pages.map((page) => ({ id: page.id, title: page.title, order: page.order }))}
                    />
                  </div>
                );
              }
              return (
                <div key={question.id} data-block-id={question.id} className="block-item">
                  <QuestionSummaryRow
                    question={question}
                    index={index}
                    editable={!editingDisabled}
                    onOpen={() => selectQuestion(question.id)}
                    onMove={(direction) => moveQuestion(question.id, direction)}
                  />
                </div>
              );
            })}
          </div>
          {editor.questions.length === 0 ? (
            <EmptyPanel text="这份问卷还没有内容，点击下方「添加题目 / 剧情文段」开始" />
          ) : null}
          <div className="add-block-bar">
            <button className="btn" disabled={editingDisabled} onClick={() => setPickerOpen(true)}>
              <FilePlus2 className="h-4 w-4" />
              添加题目
            </button>
            <button
              className="btn add-block-note-btn"
              disabled={editingDisabled}
              onClick={() => addDefaultQuestion("note")}
            >
              <BookOpen className="h-4 w-4" />
              添加剧情文段
            </button>
            <button
              className="btn"
              disabled={editingDisabled || sceneBusy}
              onClick={() => void addSceneQuestion(selectedQuestion?.pageId ?? null)}
              title="新建一道互动场景题，并打开场景编辑器"
            >
              <MousePointerClick className="h-4 w-4" />
              添加互动场景
            </button>
            <button
              className="btn"
              disabled={editingDisabled}
              onClick={() => setTemplateOpen(true)}
              title="用模板快速搭出结构（可撤销）"
            >
              <Sparkles className="h-4 w-4" />
              从模板开始
            </button>
          </div>
        </main>

        <aside className="editor-preview editor-col">
          {editorMode === "pro" ? (
            <div className="flex gap-1 border-b border-[var(--color-edge)] px-2 pt-2">
              {(
                [
                  { id: "preview", label: "预览" },
                  { id: "logic", label: "逻辑" },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  className={`rounded-t-lg px-3 py-1.5 text-[11px] font-semibold ${
                    rightTab === tab.id
                      ? "bg-[var(--surface)] text-[var(--color-ink)]"
                      : "text-[var(--color-muted)]"
                  }`}
                  aria-pressed={rightTab === tab.id}
                  onClick={() => setRightTab(tab.id)}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          ) : null}
          {editorMode === "pro" && rightTab === "logic" ? (
            <LogicPanel
              questions={editor.questions.map((question) => ({
                id: question.id,
                title: question.title,
                condition: question.condition,
              }))}
              selectedId={selection.kind === "question" ? selection.id : null}
              onSelect={selectQuestion}
            />
          ) : trialFrom !== null ? (
            <TrialPlay
              title={editor.surveyMeta.title}
              questions={previewQuestions}
              startIndex={trialFrom}
              onExit={() => setTrialFrom(null)}
              preset={data.survey.theme?.preset ?? null}
            />
          ) : (
            <LivePreview
              title={editor.surveyMeta.title}
              description={editor.surveyMeta.description}
              questions={previewQuestions}
              currentIndex={Math.min(previewIndex, Math.max(0, previewQuestions.length - 1))}
              dirty={editor.dirty}
              onNavigate={navigatePreview}
              onOpenFull={() => setPreviewOpen(true)}
              preset={data.survey.theme?.preset ?? null}
              onTrialFrom={() => setTrialFrom(Math.min(previewIndex, Math.max(0, previewQuestions.length - 1)))}
            />
          )}
        </aside>
      </div>

      {previewOpen ? (
        <SurveyPreview
          title={editor.surveyMeta.title}
          description={editor.surveyMeta.description}
          questions={previewQuestions}
          dirty={editor.dirty}
          onClose={() => setPreviewOpen(false)}
          preset={data.survey.theme?.preset ?? null}
        />
      ) : null}

      {pickerOpen ? (
        <TypePickerSheet
          disabled={editingDisabled}
          onClose={() => setPickerOpen(false)}
          onPick={(type) => addDefaultQuestion(type)}
          onScene={() => {
            setPickerOpen(false);
            void addSceneQuestion(selectedQuestion?.pageId ?? null);
          }}
        />
      ) : null}

      {templateOpen ? (
        <Modal open title="从模板开始" onClose={() => setTemplateOpen(false)}>
          <p className="text-xs text-[var(--color-muted)]">
            模板会按顺序插入组件（可撤销、可再改）。插在当前问卷末尾。
          </p>
          <div className="mt-3 flex flex-col gap-2">
            {TEMPLATE_OPTIONS.map((template) => (
              <button
                key={template.id}
                type="button"
                className="rounded-xl border border-[var(--color-edge)] p-3 text-left hover:border-[var(--color-primary)]"
                onClick={() => {
                  applyTemplate(template.id);
                  setTemplateOpen(false);
                }}
              >
                <span className="block text-sm font-semibold text-[var(--color-ink)]">{template.title}</span>
                <span className="mt-0.5 block text-xs text-[var(--color-muted)]">{template.desc}</span>
              </button>
            ))}
          </div>
        </Modal>
      ) : null}

      {/* 手机端底部操作栏：桌面端按钮在窄屏下藏进这里 */}
      <nav className="editor-mobile-bar" aria-label="编辑器操作">
        <button className="editor-mobile-btn is-add" disabled={editingDisabled} onClick={() => setPickerOpen(true)}>
          <Plus className="h-5 w-5" />
          添加
        </button>
        <button
          className="editor-mobile-btn"
          disabled={editor.saveState === "saving"}
          onClick={() => void editor.save()}
        >
          <Save className="h-5 w-5" />
          保存
        </button>
        <button className="editor-mobile-btn" onClick={() => setPreviewOpen(true)}>
          <Eye className="h-5 w-5" />
          预览
        </button>
        <button
          className="editor-mobile-btn is-publish"
          disabled={editingDisabled || editor.dirty || publishing || editor.questions.length === 0}
          onClick={() => void publish()}
        >
          <Rocket className="h-5 w-5" />
          发布
        </button>
      </nav>
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
          preset={data.survey.theme?.preset ?? null}
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
            {QUESTION_TYPE_LABELS[question.type] ?? question.type}
          </span>
          <span
            className="q-chip"
            style={{
              background: question.required
                ? "color-mix(in srgb, var(--app-danger) 12%, var(--surface))"
                : "var(--surface-muted)",
              color: question.required ? "var(--app-danger)" : "var(--color-muted)",
            }}
          >
            {question.type === "note" ? "非题目" : question.required ? "必答" : "选答"}
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
