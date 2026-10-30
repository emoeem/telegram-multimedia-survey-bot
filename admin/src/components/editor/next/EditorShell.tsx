import { useCallback, useEffect, useMemo, useState } from "react";
import { useBlocker, useNavigate } from "react-router";
import { ArrowLeft, Eye, Plus, Redo2, Rocket, Save, Undo2 } from "lucide-react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import type { EditorData } from "../../../api";
import { StatusBadge } from "../../ui";
import { DevicePreview } from "../DevicePreview";
import { TypePickerSheet } from "../TypePickerSheet";
import { EditableTitle } from "../EditableTitle";
import type { BuilderSelection } from "../StructureTree";
import { useSurveyEditor } from "../../../editor/useSurveyEditor";
import { buildEditorPreviewFlow } from "../../../editor/previewModel";
import { useEditorActions } from "../../../editor/editor-actions";
import { useDialogs } from "../../Dialogs";
import { formatDateTime } from "../../../format";
import { MaterialPanel } from "./MaterialPanel";
import { Canvas } from "./Canvas";
import { FlowCanvas } from "./flow/FlowCanvas";
import { connectCommand, disconnectCommand, type ConditionCommand } from "../../../editor/node-graph/commands";
import { surveyToGraph } from "../../../editor/node-graph/to-graph";
import type { CanvasViewMode } from "../../../editor/node-graph/types";
import type { Connection, Edge } from "@xyflow/react";
import { PropertiesPanel } from "./PropertiesPanel";
import { SceneEditorPage } from "../../../routes/SceneEditorPage";
import { X } from "lucide-react";

/**
 * P2 三栏画布外壳（S2）：左物料 / 中画布 / 右属性。只在 /surveys/:id/editor?ui=next
 * 时渲染，旧壳保持默认——视觉基线与既有行为都不受影响。
 *
 * 状态与动作与旧壳完全共用：useSurveyEditor（待保存队列 + 快照撤销）与
 * useEditorActions（结构/媒体/发布动作）。本轮不引入命令日志（S5）。
 */
export function EditorShellNext({ data }: { data: EditorData }) {
  const editor = useSurveyEditor(data);
  const navigate = useNavigate();
  const { confirm } = useDialogs();
  const actions = useEditorActions(data, editor);
  const { survey } = data;
  const [selection, setSelection] = useState<BuilderSelection>(() =>
    data.questions.length ? { kind: "question", id: data.questions[0]!.id } : { kind: "settings" },
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  // P3：scene 编辑从「页面跳转」改为壳内全屏浮层——选中即配置、不出现页面跳转。
  const [sceneOverlayId, setSceneOverlayId] = useState<number | null>(null);
  /**
   * 中栏画布形态（A4，2026-10-30）：list=现有卡片流（默认），graph=统一节点图。
   * 铁律「新旧并存、验收前不切默认」：localStorage 记忆 + URL ?canvas=graph
   * 可直达，默认保持 list 不动。
   */
  const [canvasView, setCanvasView] = useState<CanvasViewMode>(() => {
    try {
      if (new URLSearchParams(window.location.search).get("canvas") === "graph") return "graph";
      return window.localStorage.getItem("admin:editor-canvas") === "graph" ? "graph" : "list";
    } catch {
      return "list";
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem("admin:editor-canvas", canvasView);
    } catch {
      // 隐私模式写不进去不影响本次编辑
    }
  }, [canvasView]);
  /**
   * A3 移动端降级（2026-10-30）：节点图需要确定高度的画布视口，而编辑器
   * 三栏在 <1000px 折叠为纵向流（.editor-canvas overflow: visible），
   * 结构上放不下固定视口画布。窄屏强制列表形态（拖入自动接链尾、上下
   * 排序、点卡片编辑内容），节点图按钮禁用并说明原因——与编辑器既有的
   * 窄屏断点一致，而非另立一套。
   */
  const [graphAllowed, setGraphAllowed] = useState(() =>
    typeof window !== "undefined" ? (window.matchMedia?.("(min-width: 1000px)").matches ?? true) : true,
  );
  useEffect(() => {
    const query = window.matchMedia("(min-width: 1000px)");
    const sync = () => setGraphAllowed(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  const effectiveCanvasView: CanvasViewMode = graphAllowed ? canvasView : "list";

  /**
   * 基础 / 专业模式与旧壳共用同一个 localStorage 键：两个壳看到的模式一致，
   * 切换只改可见性，不动文档。
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

  useEffect(() => {
    // Autosave：与旧壳同一节奏——2 秒无操作后落库（保存中或出错时让位）。
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
  // 节点图视图数据（只读派生，见 node-graph/to-graph.ts）。
  const nodeGraph = useMemo(
    () =>
      surveyToGraph({
        questions: editor.questions.map((question) => ({
          id: question.id,
          type: question.type,
          title: question.title,
          required: question.required,
          order: question.order,
          pageId: question.pageId,
          condition: question.condition,
          options: question.options,
          speaker: question.speaker,
          gamePackId: question.gamePackId,
        })),
        pages: data.pages.map((page) => ({ id: page.id, title: page.title, order: page.order })),
      }),
    [editor.questions, data.pages],
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

  const addDefaultQuestion = (type: string) => {
    const tempId = actions.addQuestionOfType(type);
    setSelection({ kind: "question", id: tempId });
    setPickerOpen(false);
  };

  // ---- 节点图的写路径（批3）：连线 = 默认跳转补丁，删边 = 移除跳转。
  // 命令层见 node-graph/commands.ts（纯函数）；这里只做本地生效 + 入队，
  // 与必答开关同一条「本地 patchQuestionLocal + queueQuestionPatch」语义。
  const applyConditionCommand = useCallback(
    (command: ConditionCommand | null) => {
      if (!command || editingDisabled) return;
      editor.patchQuestionLocal(command.questionId, { condition: command.nextCondition });
      editor.queueQuestionPatch(command.questionId, { condition: command.nextCondition }, command.label);
    },
    [editor, editingDisabled],
  );
  const handleConnectEdge = useCallback(
    (connection: Connection) => {
      applyConditionCommand(connectCommand(connection, editor.questions));
    },
    [applyConditionCommand, editor.questions],
  );
  const handleEdgesDelete = useCallback(
    (edges: Edge[]) => {
      for (const edge of edges) {
        // 顺序流边（sequence）不产生命令：删除顺序 = 列表模式排序，画布不碰 order。
        applyConditionCommand(disconnectCommand(edge, editor.questions));
      }
    },
    [applyConditionCommand, editor.questions],
  );
  // 从端口拖到空白处松手 = 一步建分支（A2）：弹题型选择，创建后把
  // source 的默认跳转指向新题（tempId 由保存管线 remap 成真实 id，
  // 见 useSurveyEditor.resolveOpReferences 的 condition 重映射）。
  const [branchSource, setBranchSource] = useState<number | null>(null);
  const handleConnectEnd = useCallback(
    (event: { source: string }) => {
      if (editingDisabled) return;
      const sourceId = Number(event.source.slice(1));
      if (!Number.isInteger(sourceId) || sourceId <= 0) return;
      setBranchSource(sourceId);
      setPickerOpen(true);
    },
    [editingDisabled],
  );
  // 分支角标菜单的「移除」：等价于删边（同一条 disconnectCommand 映射）。
  const handleRemoveBranch = useCallback(
    (questionId: number, targetId: number) => {
      applyConditionCommand(disconnectCommand({ source: `q${questionId}`, target: `q${targetId}` }, editor.questions));
    },
    [applyConditionCommand, editor.questions],
  );
  /** 分支挂起时选题型：创建新题并接上 source 的默认跳转；普通选型走原路径。 */
  const addQuestionAndBranch = (type: string) => {
    if (branchSource === null) {
      addDefaultQuestion(type);
      return;
    }
    const tempId = actions.addQuestionOfType(type);
    applyConditionCommand(connectCommand({ source: `q${branchSource}`, target: `q${tempId}` }, editor.questions));
    setSelection({ kind: "question", id: tempId });
    setBranchSource(null);
    setPickerOpen(false);
  };
  // 稳定身份：下游 QuestionSummaryRow / PropertiesPanel 是 memo 组件。
  const selectQuestion = useCallback((questionId: number) => setSelection({ kind: "question", id: questionId }), []);
  const openSceneOverlay = useCallback((questionId: number) => setSceneOverlayId(questionId), []);

  // 必答开关：本地立即生效 + 入队待保存（与旧壳批量必答同一条语义）。
  const toggleRequired = (questionId: number) => {
    const question = editor.questions.find((item) => item.id === questionId);
    if (!question) return;
    const next = !question.required;
    editor.patchQuestionLocal(questionId, { required: next });
    editor.queueQuestionPatch(questionId, { required: next }, next ? "设为必答" : "设为选答");
  };

  // ---- S4 拖拽：DndContext 必须包住物料区与画布两栏（useDraggable 靠
  // React Context 感知宿主；放在 Canvas 里会让 MaterialPanel 的拖柄失效）。
  // drop 才产生命令：排序走 reorderQuestions（幂等合并只发一次），
  // 物料拖入走 addQuestion（追加末尾）；取消/非法落点零网络请求。
  const [draggingType, setDraggingType] = useState<string | null>(null);
  const dndSensors = useSensors(
    // 6px 激活阈值：按下小位移仍是点击，避免把选中误判成拖拽。
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );
  const handleDragStart = (event: DragStartEvent) => {
    if (String(event.active.id).startsWith("material:")) {
      setDraggingType(String(event.active.id).slice("material:".length));
    }
  };
  const handleDragEnd = (event: DragEndEvent) => {
    setDraggingType(null);
    const { active, over } = event;
    if (!over || editingDisabled) return;
    if (String(active.id).startsWith("material:")) {
      // 落点是画布（canvas-drop）或任何摘要卡行都算命中——closestCenter
      // 可能返回更近的行 droppable。追加到末尾；插入到指定间隙等 S5
      // 命令日志统一 insertBlock 语义。
      if (over.id === "canvas-drop" || editor.questions.some((question) => question.id === over.id)) {
        addDefaultQuestion(String(active.id).slice("material:".length));
      }
      return;
    }
    if (over.id === "canvas-drop" || active.id === over.id) return;
    const from = editor.questions.findIndex((question) => question.id === active.id);
    const to = editor.questions.findIndex((question) => question.id === over.id);
    if (from < 0 || to < 0) return;
    editor.reorderQuestions(
      arrayMove(
        editor.questions.map((question) => question.id),
        from,
        to,
      ),
    );
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
          <button
            className="btn btn-icon"
            title="返回详情（有未保存修改时会确认）"
            onClick={() => navigate(`/surveys/${survey.id}`)}
          >
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
          <div
            className="flex overflow-hidden rounded-full border border-[var(--color-edge)]"
            role="group"
            aria-label="编辑模式"
          >
            {(["basic", "pro"] as const).map((value) => (
              <button
                key={value}
                type="button"
                className={`px-2.5 py-1 text-[11px] font-semibold ${
                  editorMode === value
                    ? // 同旧壳：primary-content 随主题保证对比度（axe color-contrast）。
                      "bg-[var(--color-primary)] text-[var(--color-primary-content)]"
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
            disabled={editingDisabled || editor.dirty || actions.publishing || editor.questions.length === 0}
            title={editor.dirty ? "请先保存修改" : "发布后问卷将进入只读状态"}
            onClick={() => void actions.publish()}
          >
            {actions.publishing ? (
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

      {actions.publishError ? <div className="alert alert-error">操作失败：{actions.publishError}</div> : null}
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
        <DndContext
          sensors={dndSensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setDraggingType(null)}
        >
          <aside className="editor-structure editor-col" aria-label="物料区">
            <MaterialPanel
              disabled={editingDisabled}
              sceneBusy={actions.sceneBusy}
              pages={data.pages.map((page) => ({ id: page.id, title: page.title, order: page.order }))}
              onAddQuestion={addDefaultQuestion}
              onAddScene={() => void actions.addSceneQuestion(selectedQuestion?.pageId ?? null, setSceneOverlayId)}
              onApplyTemplate={(templateId) => actions.applyTemplate(templateId)}
              onAddPage={() => void actions.addPage()}
              onDeletePage={(pageId) => void actions.deletePage(pageId)}
            />
          </aside>

          <main
            className={`editor-canvas editor-col${canvasView === "graph" ? " is-graph-mode" : ""}`}
            aria-label="画布"
          >
            <div className="flow-view-toggle" role="group" aria-label="画布形态">
              {(
                [
                  ["list", "列表"],
                  ["graph", "节点图"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={`px-2.5 py-1 text-[11px] font-semibold ${
                    effectiveCanvasView === value
                      ? "bg-[var(--color-primary)] text-[var(--color-primary-content)]"
                      : "text-[var(--color-muted)]"
                  }`}
                  aria-pressed={effectiveCanvasView === value}
                  disabled={value === "graph" && !graphAllowed}
                  title={
                    value === "graph" && !graphAllowed
                      ? "节点图需要桌面端宽度（≥1000px）；窄屏请使用列表编辑"
                      : undefined
                  }
                  onClick={() => setCanvasView(value)}
                >
                  {label}
                </button>
              ))}
              {!graphAllowed ? (
                <span className="text-[11px]" style={{ color: "var(--color-muted)" }}>
                  节点图需要桌面端宽度
                </span>
              ) : null}
            </div>
            {effectiveCanvasView === "graph" ? (
              <FlowCanvas
                graph={nodeGraph}
                viewMode="graph"
                selection={selection}
                onSelect={setSelection}
                onConnectEdge={handleConnectEdge}
                onEdgesDelete={handleEdgesDelete}
                onConnectEnd={handleConnectEnd}
                onRemoveBranch={handleRemoveBranch}
              />
            ) : (
              <Canvas
                questions={editor.questions}
                selection={selection}
                editable={!editingDisabled}
                sceneBusy={actions.sceneBusy}
                draggingType={draggingType}
                onOpenPicker={() => setPickerOpen(true)}
                onAddScene={() => void actions.addSceneQuestion(selectedQuestion?.pageId ?? null, setSceneOverlayId)}
                onSelect={setSelection}
                onMove={actions.moveQuestion}
                onDuplicate={(questionId) => void actions.duplicateQuestion(questionId)}
                onDelete={(questionId) => void actions.requestDeleteQuestion(questionId)}
                onToggleRequired={toggleRequired}
              />
            )}
          </main>

          <aside className="editor-preview editor-col" aria-label="属性区">
            <PropertiesPanel
              data={data}
              editor={editor}
              actions={actions}
              selection={selection}
              editable={!editingDisabled}
              editorMode={editorMode}
              onSelect={selectQuestion}
              onOpenScene={openSceneOverlay}
            />
          </aside>
        </DndContext>
      </div>

      {sceneOverlayId !== null ? (
        <div
          className="fixed inset-0 z-50 flex flex-col"
          style={{ background: "var(--color-page)" }}
          role="dialog"
          aria-label="互动场景编辑器"
        >
          <div className="flex items-center justify-between border-b border-[var(--color-edge)] px-3 py-2">
            <span className="text-xs font-semibold text-[var(--color-muted)]">编辑互动场景（关闭返回编辑器）</span>
            <button
              type="button"
              className="btn btn-sm"
              aria-label="关闭场景编辑器"
              onClick={() => setSceneOverlayId(null)}
            >
              <X className="h-4 w-4" />
              关闭
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            <SceneEditorPage surveyId={survey.id} sceneId={sceneOverlayId} onExit={() => setSceneOverlayId(null)} />
          </div>
        </div>
      ) : null}

      {previewOpen ? (
        // 全屏预览 = 真实页面的设备预览（含场景题、跟随显示模式）。
        // 未保存修改的近似预览在右栏 LivePreview，两者分工见 DevicePreview 注释。
        <DevicePreview
          surveyId={survey.id}
          title={editor.surveyMeta.title}
          display={data.survey.display ?? "auto"}
          onClose={() => setPreviewOpen(false)}
        />
      ) : null}

      {pickerOpen ? (
        <TypePickerSheet
          disabled={editingDisabled}
          onClose={() => setPickerOpen(false)}
          onPick={(type) => addQuestionAndBranch(type)}
          onScene={() => {
            setPickerOpen(false);
            setBranchSource(null);
            void actions.addSceneQuestion(selectedQuestion?.pageId ?? null, setSceneOverlayId);
          }}
        />
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
          disabled={editingDisabled || editor.dirty || actions.publishing || editor.questions.length === 0}
          onClick={() => void actions.publish()}
        >
          <Rocket className="h-5 w-5" />
          发布
        </button>
      </nav>
    </div>
  );
}
