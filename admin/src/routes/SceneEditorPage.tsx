import { useEffect, useMemo, useState } from "react";
import { useBlocker, useNavigate, useParams } from "react-router";
import { ArrowLeft, Eye, ImagePlus, Plus, Save } from "lucide-react";
import { ApiError, apiSend, apiUpload, type EditorData, type EditorMediaRef, type WriteResult } from "../api";
import { useApi } from "../hooks";
import { useDialogs } from "../components/Dialogs";
import { EmptyPanel, ErrorPanel, SkeletonPanel } from "../components/ui";
import type { SurveyQuestionDto } from "../survey/api";
import type { Hotspot, HotspotScene, HotspotSceneConfig } from "../../../src/survey/hotspot";
import { parseHotspotScene } from "../../../src/survey/hotspot";
import { prepareImageForPublish } from "../lib/image-publish";
import { MediaPicker } from "../scene-editor/MediaPicker";
import { PreviewOverlay } from "../scene-editor/PreviewOverlay";
import { SceneCanvas } from "../scene-editor/SceneCanvas";
import { SceneInspector, type InspectorTab, type QuestionDraft } from "../scene-editor/SceneInspector";
import {
  NUDGE_STEP,
  NUDGE_STEP_FAST,
  adminMediaUrl,
  createConfigWithScene,
  createEmptyScene,
  createHotspot,
  displayMediaUrl,
  nextHotspotId,
  nextHotspotMeta,
  nextSceneId,
  nudgeRect,
  publicMediaUrl,
  sceneReferences,
  transformConfigForPreview,
  validateDraft,
  type Rect,
} from "../scene-editor/model";

interface DraftState extends QuestionDraft {
  config: HotspotSceneConfig | null;
}

type PickerTarget = { kind: "scene"; sceneId: string } | { kind: "hotspot"; sceneId: string; hotspotId: string };

interface MediaUploadResult {
  mediaAssetId: number;
  mediaType: string;
  fileName?: string | null;
  mimeType?: string | null;
  updatedAt?: string;
}

/** 读图片自然尺寸：底图选中后写回 scene.width/height（配置校验要求正整数）。 */
function loadImageSize(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      if (image.naturalWidth > 0 && image.naturalHeight > 0) {
        resolve({ width: image.naturalWidth, height: image.naturalHeight });
      } else {
        reject(new Error("图片尺寸无效"));
      }
    };
    image.onerror = () => reject(new Error("图片加载失败"));
    image.src = url;
  });
}

/**
 * 互动场景编辑器（scene 题）。
 *
 * 独立路由而不是塞进 builder：useSurveyEditor 的 EditableQuestion 只保留
 * columns/speaker，diffOps 也只会发 {columns}，场景配置会被覆盖掉。
 * 这里直接读写题目 settings.scene，保存走既有 PATCH 端点（后端已白名单 scene）。
 *
 * 两种形态（P3）：独立路由页（旧壳与直达链接，useParams 取参）；编辑器壳内
 * 全屏浮层（新壳传 props——surveyId/sceneId/onExit，「选中即配置不跳页」）。
 */
export function SceneEditorPage(props?: {
  surveyId?: number;
  sceneId?: number;
  /** 浮层形态的退出回调；缺省（独立路由）为导航回编辑器。 */
  onExit?: () => void;
}) {
  const params = useParams();
  const navigate = useNavigate();
  const surveyId = props?.surveyId ?? Number(params.id);
  const questionId = props?.sceneId ?? Number(params.qid);
  const exitEditor = props?.onExit ?? (() => navigate(`/surveys/${surveyId}/editor`));
  const { confirm, toast } = useDialogs();

  const path =
    Number.isInteger(surveyId) && surveyId > 0 && Number.isInteger(questionId) && questionId > 0
      ? `/api/admin/surveys/${surveyId}/editor`
      : null;
  const { data, error, retry } = useApi<EditorData>(path);

  const [draft, setDraft] = useState<DraftState | null>(null);
  const [baseline, setBaseline] = useState("");
  const [media, setMedia] = useState<EditorMediaRef[]>([]);
  const [baseUpdatedAt, setBaseUpdatedAt] = useState("");
  const [selectedSceneId, setSelectedSceneId] = useState("");
  const [selectedHotspotId, setSelectedHotspotId] = useState<string | null>(null);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("scene");
  const [picker, setPicker] = useState<PickerTarget | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const question = data?.questions.find((item) => item.id === questionId) ?? null;
  const readOnly = !data?.survey.editable;

  useEffect(() => {
    if (!data) return;
    const target = data.questions.find((item) => item.id === questionId);
    if (!target || target.type !== "scene") return;
    const config = parseHotspotScene(target.settings);
    const nextDraft: DraftState = {
      title: target.title,
      description: target.description ?? "",
      required: target.required,
      config,
    };
    setDraft(nextDraft);
    setBaseline(JSON.stringify(nextDraft));
    setMedia(target.media);
    setBaseUpdatedAt(data.survey.updatedAt);
    setSelectedSceneId(config?.start ?? "");
    setSelectedHotspotId(null);
    setInspectorTab(config ? "scene" : "question");
    setSaveError(null);
    setPreviewOpen(false);
  }, [data, questionId]);

  const config = draft?.config ?? null;
  const dirty = draft ? JSON.stringify(draft) !== baseline : false;

  const selectedScene = useMemo(() => {
    if (!config) return null;
    return config.scenes[selectedSceneId] ?? config.scenes[config.start] ?? null;
  }, [config, selectedSceneId]);

  const selectedHotspot = selectedScene?.hotspots.find((hotspot) => hotspot.id === selectedHotspotId) ?? null;

  useEffect(() => {
    if (!config) return;
    if (!selectedSceneId || !config.scenes[selectedSceneId]) {
      setSelectedSceneId(config.start);
    }
    if (selectedHotspotId && !selectedScene?.hotspots.some((item) => item.id === selectedHotspotId)) {
      setSelectedHotspotId(null);
    }
  }, [config, selectedSceneId, selectedHotspotId, selectedScene]);

  const issues = useMemo(
    () => validateDraft(config, { required: draft?.required ?? false }),
    [config, draft?.required],
  );
  const canPreview = Boolean(config) && issues.length === 0;

  const deleteSceneReason = useMemo(() => {
    if (!config || !selectedScene) return undefined;
    if (config.start === selectedScene.id) return "起始场景不能删除，请先把其他场景设为起始。";
    if (sceneReferences(config, selectedScene.id) > 0) return "还有热点跳转到这个场景，请先修改那些热点。";
    return undefined;
  }, [config, selectedScene]);

  const sceneImageUrl = selectedScene?.image ? displayMediaUrl(selectedScene.image) : null;

  const pickerCurrentUrl = useMemo(() => {
    if (!picker || !config) return null;
    if (picker.kind === "scene") return config.scenes[picker.sceneId]?.image || null;
    const action = config.scenes[picker.sceneId]?.hotspots.find((item) => item.id === picker.hotspotId)?.action;
    return action?.kind === "image" ? action.src || null : null;
  }, [picker, config]);

  const patchQuestion = (patch: Partial<QuestionDraft>) => {
    setSaveError(null);
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
  };

  const updateConfig = (next: HotspotSceneConfig | null) => {
    setSaveError(null);
    setDraft((prev) => (prev ? { ...prev, config: next } : prev));
  };

  const updateScene = (sceneId: string, patch: Partial<HotspotScene>) => {
    if (!config) return;
    const next = JSON.parse(JSON.stringify(config)) as HotspotSceneConfig;
    const scene = next.scenes[sceneId];
    if (!scene) return;
    Object.assign(scene, patch);
    updateConfig(next);
  };

  const updateHotspot = (sceneId: string, hotspotId: string, patch: Partial<Hotspot>) => {
    if (!config) return;
    const next = JSON.parse(JSON.stringify(config)) as HotspotSceneConfig;
    const scene = next.scenes[sceneId];
    const hotspot = scene?.hotspots.find((item) => item.id === hotspotId);
    if (!scene || !hotspot) return;
    Object.assign(hotspot, patch);
    updateConfig(next);
  };

  const updateHotspotRect = (sceneId: string, hotspotId: string, rect: Rect) => {
    updateHotspot(sceneId, hotspotId, { x: rect.x, y: rect.y, w: rect.w, h: rect.h });
  };

  const addScene = () => {
    const sceneId = nextSceneId(config);
    const index = config ? Object.keys(config.scenes).length + 1 : 1;
    const scene = createEmptyScene(sceneId, `场景 ${index}`);
    const next = config ? { ...config, scenes: { ...config.scenes, [sceneId]: scene } } : createConfigWithScene(scene);
    updateConfig(next);
    setSelectedSceneId(sceneId);
    setSelectedHotspotId(null);
    setInspectorTab("scene");
  };

  const addHotspot = (rect: Rect) => {
    if (!config) return;
    const sceneId = config.scenes[selectedSceneId] ? selectedSceneId : config.start;
    const scene = config.scenes[sceneId];
    if (!scene) return;
    const next = JSON.parse(JSON.stringify(config)) as HotspotSceneConfig;
    const targetScene = next.scenes[sceneId]!;
    const hotspot = createHotspot(nextHotspotId(next), nextHotspotMeta(targetScene), rect);
    targetScene.hotspots.push(hotspot);
    updateConfig(next);
    setSelectedSceneId(sceneId);
    setSelectedHotspotId(hotspot.id);
    setInspectorTab("hotspot");
  };

  const setStartScene = (sceneId: string) => {
    if (!config || config.start === sceneId) return;
    updateConfig({ ...config, start: sceneId });
    toast({ message: "已设为起始场景。", variant: "success" });
  };

  const deleteScene = async (sceneId: string) => {
    if (!config) return;
    if (config.start === sceneId) {
      toast({ message: "起始场景不能删除，请先把其他场景设为起始。", variant: "error" });
      return;
    }
    if (sceneReferences(config, sceneId) > 0) {
      toast({ message: "还有热点跳转到这个场景，请先修改那些热点。", variant: "error" });
      return;
    }
    const ok = await confirm({
      title: "删除场景",
      message: "这个场景和它的热点会一起移除，确定删除？",
      confirmLabel: "删除",
      cancelLabel: "取消",
      variant: "danger",
    });
    if (!ok) return;
    const next = JSON.parse(JSON.stringify(config)) as HotspotSceneConfig;
    delete next.scenes[sceneId];
    const remaining = Object.keys(next.scenes);
    if (remaining.length === 0) {
      updateConfig(null);
      setSelectedSceneId("");
      setSelectedHotspotId(null);
      setInspectorTab("question");
      return;
    }
    if (!next.scenes[next.start]) next.start = remaining[0]!;
    updateConfig(next);
    setSelectedSceneId(next.start);
    setSelectedHotspotId(null);
    setInspectorTab("scene");
  };

  const deleteHotspot = async (sceneId: string, hotspotId: string) => {
    const hotspot = config?.scenes[sceneId]?.hotspots.find((item) => item.id === hotspotId);
    if (!config || !hotspot) return;
    const ok = await confirm({
      title: "删除热点",
      message: `删除「${hotspot.label || hotspot.id}」？`,
      confirmLabel: "删除",
      cancelLabel: "取消",
      variant: "danger",
    });
    if (!ok) return;
    const next = JSON.parse(JSON.stringify(config)) as HotspotSceneConfig;
    const scene = next.scenes[sceneId];
    if (!scene) return;
    scene.hotspots = scene.hotspots.filter((item) => item.id !== hotspotId);
    updateConfig(next);
    setSelectedHotspotId(null);
    setInspectorTab("scene");
  };

  const nudgeHotspot = (sceneId: string, hotspotId: string, dx: number, dy: number) => {
    const hotspot = config?.scenes[sceneId]?.hotspots.find((item) => item.id === hotspotId);
    if (!hotspot) return;
    updateHotspotRect(
      sceneId,
      hotspotId,
      nudgeRect({ x: hotspot.x, y: hotspot.y, w: hotspot.w, h: hotspot.h }, dx, dy),
    );
  };

  const handlePickMedia = async (mediaAssetId: number) => {
    if (!picker) return;
    const url = publicMediaUrl(mediaAssetId);
    if (picker.kind === "scene") {
      try {
        const size = await loadImageSize(adminMediaUrl(mediaAssetId));
        updateScene(picker.sceneId, { image: url, width: size.width, height: size.height });
        setPicker(null);
        toast({ message: "底图已更新，热点坐标按比例保留。", variant: "success" });
      } catch {
        toast({ message: "底图加载失败，请换一张图片。", variant: "error" });
      }
      return;
    }
    const source = config?.scenes[picker.sceneId]?.hotspots.find((item) => item.id === picker.hotspotId);
    const previous = source?.action.kind === "image" ? source.action : null;
    const action: Hotspot["action"] = {
      kind: "image",
      src: url,
      title: previous?.title || source?.label || "查看",
      ...(previous?.caption ? { caption: previous.caption } : {}),
      ...(previous?.note ? { note: previous.note } : {}),
    };
    updateHotspot(picker.sceneId, picker.hotspotId, { action });
    setPicker(null);
  };

  const handleUpload = async (file: File) => {
    if (readOnly || !picker) return;
    if (!file.type.startsWith("image/")) {
      toast({ message: "只能上传图片。", variant: "error" });
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      toast({ message: "图片不能超过 20MB。", variant: "error" });
      return;
    }
    setUploading(true);
    try {
      const prepared = await prepareImageForPublish(file, { maxEdge: 2000, quality: 0.86 });
      const result = await apiUpload<MediaUploadResult>(
        `/api/admin/surveys/${surveyId}/questions/${questionId}/media`,
        prepared,
      );
      const entry: EditorMediaRef = {
        mediaAssetId: result.mediaAssetId,
        mediaType: result.mediaType,
        fileName: result.fileName ?? prepared.name,
        mimeType: result.mimeType ?? prepared.type,
      };
      setMedia((prev) => (prev.some((item) => item.mediaAssetId === entry.mediaAssetId) ? prev : [...prev, entry]));
      // 上传会 touch 问卷；不刷新 baseUpdatedAt 的话，下一次 PATCH 会 409。
      if (result.updatedAt) setBaseUpdatedAt(result.updatedAt);
      await handlePickMedia(result.mediaAssetId);
      toast({ message: "图片已上传并选中。", variant: "success" });
    } catch (err) {
      toast({ message: err instanceof Error ? err.message : "上传失败", variant: "error" });
    } finally {
      setUploading(false);
    }
  };

  const save = async () => {
    if (!draft?.config) {
      setSaveError("请先添加场景和热点。");
      return;
    }
    if (!draft.title.trim()) {
      setSaveError("题目标题不能为空。");
      return;
    }
    const blocking = validateDraft(draft.config, { required: draft.required });
    if (blocking.length > 0) {
      setSaveError(blocking[0]!.message);
      return;
    }
    if (!parseHotspotScene({ scene: draft.config })) {
      setSaveError("场景配置不完整，请检查热点和场景引用。");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const result = await apiSend<WriteResult>("PATCH", `/api/admin/surveys/${surveyId}/questions/${questionId}`, {
        title: draft.title.trim(),
        description: draft.description.trim() || null,
        required: draft.required,
        settings: { scene: draft.config },
        baseUpdatedAt,
      });
      if (result.updatedAt) setBaseUpdatedAt(result.updatedAt);
      setBaseline(JSON.stringify(draft));
      toast({ message: "场景已保存。", variant: "success" });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const ok = await confirm({
          title: "内容已被其他页面修改",
          message: "重新加载会丢弃当前未保存的修改。要继续吗？",
          confirmLabel: "重新加载",
          cancelLabel: "留在这里",
          variant: "danger",
        });
        if (ok) retry();
        return;
      }
      const message = err instanceof Error ? err.message : "保存失败";
      setSaveError(message);
      toast({ message, variant: "error" });
    } finally {
      setSaving(false);
    }
  };

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname,
  );
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    void (async () => {
      const ok = await confirm({
        title: "有未保存的修改",
        message: "场景还没保存，离开后这些修改会丢失。",
        confirmLabel: "离开",
        cancelLabel: "留下修改",
        variant: "danger",
      });
      if (ok) blocker.proceed();
      else blocker.reset();
    })();
  }, [blocker, confirm]);

  useEffect(() => {
    if (!dirty) return undefined;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const previewQuestion = useMemo(() => {
    if (!question || !draft?.config) return null;
    const previewConfig = transformConfigForPreview(draft.config);
    return {
      ...question,
      title: draft.title,
      description: draft.description,
      required: draft.required,
      settings: { scene: previewConfig },
      media: media.map((item) => ({ url: adminMediaUrl(item.mediaAssetId) })),
    } as unknown as SurveyQuestionDto;
  }, [question, draft, media]);

  if (error) return <ErrorPanel error={error} onRetry={retry} />;
  if (!data || !draft) {
    return (
      <div className="scene-editor">
        <SkeletonPanel lines={6} />
      </div>
    );
  }
  if (!question || question.type !== "scene") {
    return (
      <div className="scene-editor">
        <EmptyPanel
          text="这道题不是互动场景，或已经被删除。"
          actionLabel="返回问卷编辑器"
          onAction={exitEditor}
        />
      </div>
    );
  }

  const readOnlyReason =
    data.survey.status !== "draft"
      ? "这份问卷不是草稿（已发布 / 已关闭 / 已归档），题目编辑已锁定。复制一份草稿后即可编辑场景。"
      : data.survey.responseCount > 0
        ? `这份问卷已有 ${data.survey.responseCount} 份答卷，题目结构已锁定。`
        : "当前账号没有编辑权限。";

  return (
    <div className="scene-editor">
      <div className="scene-editor-topbar">
        <div className="scene-editor-topbar-main">
          <button type="button" className="btn btn-sm" onClick={exitEditor}>
            <ArrowLeft className="h-4 w-4" />
            返回编辑器
          </button>
          <div className="scene-editor-heading">
            <p>
              {data.survey.title} · 第 {question.order + 1} 题
            </p>
            <h1>{draft.title || "互动场景"}</h1>
          </div>
        </div>
        <div className="scene-editor-topbar-actions">
          {dirty ? <span className="scene-editor-dirty">未保存</span> : null}
          <button
            type="button"
            className="btn"
            disabled={!canPreview}
            title={canPreview ? "预览场景" : "先补全场景配置再预览"}
            onClick={() => setPreviewOpen(true)}
          >
            <Eye className="h-4 w-4" />
            预览
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={readOnly || saving || !dirty || !draft.config}
            onClick={() => void save()}
          >
            <Save className="h-4 w-4" />
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>

      {readOnly ? (
        <div className="scene-editor-banner" role="status">
          {readOnlyReason}
        </div>
      ) : null}
      {saveError ? (
        <p className="scene-editor-error" role="alert">
          {saveError}
        </p>
      ) : null}

      <div className="scene-editor-body">
        <aside className="scene-editor-sidebar">
          <section className="scene-editor-section">
            <div className="scene-editor-section-head">
              <h2>场景</h2>
              <button type="button" className="btn btn-sm" disabled={readOnly} onClick={addScene}>
                <Plus className="h-3.5 w-3.5" />
                新增
              </button>
            </div>
            <div className="scene-editor-scene-list">
              {config ? (
                Object.values(config.scenes).map((scene) => {
                  const active = scene.id === selectedScene?.id;
                  return (
                    <button
                      key={scene.id}
                      type="button"
                      className={`scene-editor-scene${active ? " is-active" : ""}`}
                      aria-pressed={active}
                      onClick={() => {
                        setSelectedSceneId(scene.id);
                        setSelectedHotspotId(null);
                        setInspectorTab("scene");
                      }}
                    >
                      <span className="scene-editor-scene-title">{scene.title || "未命名场景"}</span>
                      <span className="scene-editor-scene-meta">
                        {scene.id === config.start ? "起始 · " : ""}
                        {scene.hotspots.length} 个热点
                      </span>
                    </button>
                  );
                })
              ) : (
                <p className="scene-editor-hint">还没有场景。</p>
              )}
            </div>
          </section>

          <section className="scene-editor-section">
            <div className="scene-editor-section-head">
              <h2>热点</h2>
              <span>{selectedScene?.hotspots.length ?? 0}</span>
            </div>
            <div className="scene-editor-hotspot-list">
              {selectedScene?.hotspots.map((hotspot) => {
                const active = hotspot.id === selectedHotspotId;
                return (
                  <button
                    key={hotspot.id}
                    type="button"
                    className={`scene-editor-hotspot${active ? " is-active" : ""}`}
                    aria-pressed={active}
                    onClick={() => {
                      setSelectedHotspotId(hotspot.id);
                      setInspectorTab("hotspot");
                    }}
                    onFocus={() => {
                      setSelectedHotspotId(hotspot.id);
                      setInspectorTab("hotspot");
                    }}
                    onKeyDown={(event) => {
                      if (readOnly) return;
                      const step = event.shiftKey ? NUDGE_STEP_FAST : NUDGE_STEP;
                      if (event.key === "ArrowLeft") {
                        event.preventDefault();
                        nudgeHotspot(selectedScene.id, hotspot.id, -step, 0);
                      } else if (event.key === "ArrowRight") {
                        event.preventDefault();
                        nudgeHotspot(selectedScene.id, hotspot.id, step, 0);
                      } else if (event.key === "ArrowUp") {
                        event.preventDefault();
                        nudgeHotspot(selectedScene.id, hotspot.id, 0, -step);
                      } else if (event.key === "ArrowDown") {
                        event.preventDefault();
                        nudgeHotspot(selectedScene.id, hotspot.id, 0, step);
                      } else if (event.key === "Delete" || event.key === "Backspace") {
                        event.preventDefault();
                        void deleteHotspot(selectedScene.id, hotspot.id);
                      }
                    }}
                  >
                    <span className="scene-editor-hotspot-title">
                      {hotspot.meta ? `${hotspot.meta} ` : ""}
                      {hotspot.label || "未命名"}
                    </span>
                    <span className="scene-editor-hotspot-meta">
                      {hotspot.action.kind === "scene" ? "进入场景" : "查看图片"}
                    </span>
                  </button>
                );
              })}
              {selectedScene && selectedScene.hotspots.length === 0 ? (
                <p className="scene-editor-hint">在画布空白处拖拽，创建第一个热点。</p>
              ) : null}
            </div>
          </section>
        </aside>

        <main className="scene-editor-main">
          {selectedScene ? (
            <SceneCanvas
              scene={selectedScene}
              imageUrl={sceneImageUrl}
              selectedHotspotId={selectedHotspotId}
              readOnly={readOnly}
              onSelect={(hotspotId) => {
                setSelectedHotspotId(hotspotId);
                if (hotspotId) setInspectorTab("hotspot");
              }}
              onCreate={addHotspot}
              onChange={(hotspotId, rect) => updateHotspotRect(selectedScene.id, hotspotId, rect)}
              onRequestImage={() => setPicker({ kind: "scene", sceneId: selectedScene.id })}
            />
          ) : (
            <div className="scene-editor-empty">
              <span className="scene-editor-empty-icon">
                <ImagePlus className="h-6 w-6" />
              </span>
              <h2>还没有场景</h2>
              <p>先添加一个场景，再选择或上传底图，然后在画布上拖拽热点。</p>
              <button type="button" className="btn btn-primary" disabled={readOnly} onClick={addScene}>
                <Plus className="h-4 w-4" />
                添加场景
              </button>
            </div>
          )}
          <p className="scene-editor-canvas-hint">在空白处拖拽新建热点 · 拖动热点移动 · 拖动角柄缩放 · 方向键微调</p>
        </main>

        <aside className="scene-editor-inspector-col">
          <SceneInspector
            tab={inspectorTab}
            onTabChange={setInspectorTab}
            draft={{ title: draft.title, description: draft.description, required: draft.required }}
            config={config}
            scene={selectedScene}
            hotspot={selectedHotspot}
            issues={issues}
            readOnly={readOnly}
            deleteSceneReason={deleteSceneReason}
            onQuestionChange={patchQuestion}
            onSceneChange={(patch) => selectedScene && updateScene(selectedScene.id, patch)}
            onHotspotChange={(patch) =>
              selectedScene && selectedHotspot && updateHotspot(selectedScene.id, selectedHotspot.id, patch)
            }
            onPickSceneImage={() => selectedScene && setPicker({ kind: "scene", sceneId: selectedScene.id })}
            onPickHotspotImage={() =>
              selectedScene &&
              selectedHotspot &&
              setPicker({
                kind: "hotspot",
                sceneId: selectedScene.id,
                hotspotId: selectedHotspot.id,
              })
            }
            onSetStart={() => selectedScene && setStartScene(selectedScene.id)}
            onDeleteScene={() => selectedScene && void deleteScene(selectedScene.id)}
            onDeleteHotspot={() =>
              selectedScene && selectedHotspot && void deleteHotspot(selectedScene.id, selectedHotspot.id)
            }
            onAddScene={addScene}
          />
        </aside>
      </div>

      {picker ? (
        <MediaPicker
          title={picker.kind === "scene" ? "选择场景底图" : "选择热点图片"}
          media={media}
          currentUrl={pickerCurrentUrl}
          uploading={uploading}
          readOnly={readOnly}
          onClose={() => setPicker(null)}
          onSelect={(mediaAssetId) => void handlePickMedia(mediaAssetId)}
          onUpload={(file) => void handleUpload(file)}
        />
      ) : null}

      {previewOpen && previewQuestion ? (
        <PreviewOverlay question={previewQuestion} onClose={() => setPreviewOpen(false)} />
      ) : null}
    </div>
  );
}
