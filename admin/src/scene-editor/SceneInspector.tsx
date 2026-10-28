import { ImagePlus, Star, Trash2 } from "lucide-react";
import type { Hotspot, HotspotScene, HotspotSceneConfig } from "../../../src/survey/hotspot";
import { displayMediaUrl, issueAt, type DraftIssue } from "./model";

export type InspectorTab = "hotspot" | "scene" | "question";

export interface QuestionDraft {
  title: string;
  description: string;
  required: boolean;
}

interface SceneInspectorProps {
  tab: InspectorTab;
  onTabChange: (tab: InspectorTab) => void;
  draft: QuestionDraft;
  config: HotspotSceneConfig | null;
  scene: HotspotScene | null;
  hotspot: Hotspot | null;
  issues: DraftIssue[];
  readOnly: boolean;
  deleteSceneReason?: string;
  onQuestionChange: (patch: Partial<QuestionDraft>) => void;
  onSceneChange: (patch: Partial<HotspotScene>) => void;
  onHotspotChange: (patch: Partial<Hotspot>) => void;
  onPickSceneImage: () => void;
  onPickHotspotImage: () => void;
  onSetStart: () => void;
  onDeleteScene: () => void;
  onDeleteHotspot: () => void;
  onAddScene: () => void;
}

function FieldError({ message }: { message: string | undefined }) {
  if (!message) return null;
  return <p className="scene-editor-field-error">{message}</p>;
}

function ImageField({
  label,
  url,
  readOnly,
  error,
  onPick,
}: {
  label: string;
  url: string | null;
  readOnly: boolean;
  error?: string;
  onPick: () => void;
}) {
  return (
    <div className="settings-field">
      <span className="q-label">{label}</span>
      <div className="scene-editor-image-row">
        {url ? (
          <img src={displayMediaUrl(url)} alt="" />
        ) : (
          <span className="scene-editor-image-empty" aria-hidden="true">
            <ImagePlus className="h-4 w-4" />
          </span>
        )}
        <button type="button" className="btn btn-sm" disabled={readOnly} onClick={onPick}>
          {url ? "更换图片" : "选择图片"}
        </button>
      </div>
      <FieldError message={error} />
    </div>
  );
}

/**
 * 右侧检查器：热点 / 场景 / 题目三个面板。
 * 只负责渲染与字段校验提示；所有修改通过回调交给页面状态。
 */
export function SceneInspector({
  tab,
  onTabChange,
  draft,
  config,
  scene,
  hotspot,
  issues,
  readOnly,
  deleteSceneReason,
  onQuestionChange,
  onSceneChange,
  onHotspotChange,
  onPickSceneImage,
  onPickHotspotImage,
  onSetStart,
  onDeleteScene,
  onDeleteHotspot,
  onAddScene,
}: SceneInspectorProps) {
  return (
    <div className="scene-editor-inspector">
      <div className="scene-editor-tabs" role="group" aria-label="编辑对象">
        <button
          type="button"
          className={tab === "hotspot" ? "is-active" : undefined}
          aria-pressed={tab === "hotspot"}
          disabled={!hotspot}
          onClick={() => onTabChange("hotspot")}
        >
          热点
        </button>
        <button
          type="button"
          className={tab === "scene" ? "is-active" : undefined}
          aria-pressed={tab === "scene"}
          disabled={!scene}
          onClick={() => onTabChange("scene")}
        >
          场景
        </button>
        <button
          type="button"
          className={tab === "question" ? "is-active" : undefined}
          aria-pressed={tab === "question"}
          onClick={() => onTabChange("question")}
        >
          题目
        </button>
      </div>

      <div className="scene-editor-panel">
        {tab === "hotspot" ? (
          !hotspot || !scene ? (
            <p className="scene-editor-hint">
              在画布空白处拖拽创建热点，或从左侧列表选择一个热点。方向键可微调选中热点，Delete 删除。
            </p>
          ) : (
            <HotspotPanel
              scene={scene}
              config={config}
              hotspot={hotspot}
              issues={issues}
              readOnly={readOnly}
              onChange={onHotspotChange}
              onPickImage={onPickHotspotImage}
              onDelete={onDeleteHotspot}
            />
          )
        ) : tab === "scene" ? (
          !scene ? (
            <div className="scene-editor-empty-panel">
              <p className="scene-editor-hint">还没有场景。先添加一个场景，再选择或上传底图。</p>
              <button type="button" className="btn btn-primary" disabled={readOnly} onClick={onAddScene}>
                添加场景
              </button>
            </div>
          ) : (
            <>
              <div className="scene-editor-panel-head">
                <div className="min-w-0">
                  <h2 className="truncate">{scene.title || "未命名场景"}</h2>
                  <p className="scene-editor-code">id: {scene.id}</p>
                </div>
                <button
                  type="button"
                  className="btn btn-sm btn-danger-hover"
                  disabled={readOnly || Boolean(deleteSceneReason)}
                  title={deleteSceneReason ?? "删除场景"}
                  onClick={onDeleteScene}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  删除
                </button>
              </div>
              {deleteSceneReason ? <p className="scene-editor-hint">{deleteSceneReason}</p> : null}

              <label className="settings-field">
                <span className="q-label">场景标题</span>
                <input
                  className="settings-input"
                  maxLength={80}
                  value={scene.title}
                  disabled={readOnly}
                  onChange={(event) => onSceneChange({ title: event.target.value })}
                />
                <FieldError message={issueAt(issues, `scenes.${scene.id}.title`)} />
              </label>

              <label className="settings-field">
                <span className="q-label">引导语</span>
                <textarea
                  className="settings-input"
                  rows={2}
                  maxLength={400}
                  value={scene.intro ?? ""}
                  disabled={readOnly}
                  placeholder="切到这个场景时显示的一行提示（可选）"
                  onChange={(event) => onSceneChange({ intro: event.target.value })}
                />
              </label>

              <ImageField
                label="底图"
                url={scene.image || null}
                readOnly={readOnly}
                error={issueAt(issues, `scenes.${scene.id}.image`)}
                onPick={onPickSceneImage}
              />
              <p className="scene-editor-meta-line">
                {scene.width} × {scene.height} px
                {config?.start === scene.id ? " · 起始场景" : ""}
              </p>
              <FieldError message={issueAt(issues, `scenes.${scene.id}.size`)} />

              <label className="settings-field">
                <span className="q-label">替代文本（alt）</span>
                <textarea
                  className="settings-input"
                  rows={2}
                  maxLength={400}
                  value={scene.alt ?? ""}
                  disabled={readOnly}
                  placeholder="为读屏和图片加载失败写的场景描述（可选）"
                  onChange={(event) => onSceneChange({ alt: event.target.value })}
                />
              </label>

              <div className="scene-editor-row-actions">
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={readOnly || config?.start === scene.id}
                  onClick={onSetStart}
                >
                  <Star className="h-3.5 w-3.5" />
                  {config?.start === scene.id ? "起始场景" : "设为起始场景"}
                </button>
              </div>
              <FieldError message={issueAt(issues, `scenes.${scene.id}.hotspots`)} />
            </>
          )
        ) : (
          <QuestionPanel draft={draft} readOnly={readOnly} onChange={onQuestionChange} />
        )}
      </div>
    </div>
  );
}

function HotspotPanel({
  scene,
  config,
  hotspot,
  issues,
  readOnly,
  onChange,
  onPickImage,
  onDelete,
}: {
  scene: HotspotScene;
  config: HotspotSceneConfig | null;
  hotspot: Hotspot;
  issues: DraftIssue[];
  readOnly: boolean;
  onChange: (patch: Partial<Hotspot>) => void;
  onPickImage: () => void;
  onDelete: () => void;
}) {
  const base = `scenes.${scene.id}.hotspots.${hotspot.id}`;
  const sceneOptions = Object.values(config?.scenes ?? {}).filter((item) => item.id !== scene.id);
  // 提前收窄，供各 onChange 闭包安全 spread：闭包里读 hotspot.action 会丢失判别联合。
  const imageAction = hotspot.action.kind === "image" ? hotspot.action : null;
  const sceneAction = hotspot.action.kind === "scene" ? hotspot.action : null;

  const switchAction = (kind: "image" | "scene") => {
    if (kind === "scene") {
      onChange({ action: { kind: "scene", sceneId: sceneOptions[0]?.id ?? "" } });
    } else {
      onChange({ action: { kind: "image", src: "", title: hotspot.label || "查看" } });
    }
  };

  return (
    <>
      <div className="scene-editor-panel-head">
        <div className="min-w-0">
          <h2 className="truncate">{hotspot.label || "未命名热点"}</h2>
          <p className="scene-editor-code">id: {hotspot.id}（不可修改，答案按 id 记录）</p>
        </div>
        <button type="button" className="btn btn-sm btn-danger-hover" disabled={readOnly} onClick={onDelete}>
          <Trash2 className="h-3.5 w-3.5" />
          删除
        </button>
      </div>

      <label className="settings-field">
        <span className="q-label">名称</span>
        <input
          className="settings-input"
          maxLength={40}
          value={hotspot.label}
          disabled={readOnly}
          onChange={(event) => onChange({ label: event.target.value })}
        />
        <FieldError message={issueAt(issues, `${base}.label`)} />
      </label>

      <label className="settings-field">
        <span className="q-label">编号</span>
        <input
          className="settings-input"
          maxLength={8}
          value={hotspot.meta ?? ""}
          disabled={readOnly}
          placeholder="如 01"
          onChange={(event) => onChange({ meta: event.target.value })}
        />
      </label>

      <label className="settings-field">
        <span className="q-label">点击后</span>
        <select
          className="settings-input"
          value={hotspot.action.kind}
          disabled={readOnly}
          onChange={(event) => switchAction(event.target.value === "scene" ? "scene" : "image")}
        >
          <option value="image">展开一张图片</option>
          <option value="scene">进入另一个场景</option>
        </select>
      </label>

      {imageAction ? (
        <>
          <ImageField
            label="展示图片"
            url={imageAction.src || null}
            readOnly={readOnly}
            error={issueAt(issues, `${base}.src`)}
            onPick={onPickImage}
          />
          <label className="settings-field">
            <span className="q-label">弹层标题</span>
            <input
              className="settings-input"
              maxLength={40}
              value={imageAction.title}
              disabled={readOnly}
              onChange={(event) => onChange({ action: { ...imageAction, kind: "image", title: event.target.value } })}
            />
            <FieldError message={issueAt(issues, `${base}.title`)} />
          </label>
          <label className="settings-field">
            <span className="q-label">正文</span>
            <textarea
              className="settings-input"
              rows={3}
              maxLength={400}
              value={imageAction.caption ?? ""}
              disabled={readOnly}
              onChange={(event) =>
                onChange({
                  action: { ...imageAction, kind: "image", caption: event.target.value },
                })
              }
            />
          </label>
          <label className="settings-field">
            <span className="q-label">引文</span>
            <textarea
              className="settings-input"
              rows={2}
              maxLength={400}
              value={imageAction.note ?? ""}
              disabled={readOnly}
              onChange={(event) =>
                onChange({
                  action: { ...imageAction, kind: "image", note: event.target.value },
                })
              }
            />
          </label>
        </>
      ) : (
        <>
          <label className="settings-field">
            <span className="q-label">目标场景</span>
            <select
              className="settings-input"
              value={sceneAction?.sceneId ?? ""}
              disabled={readOnly}
              onChange={(event) => onChange({ action: { kind: "scene", sceneId: event.target.value } })}
            >
              <option value="">选择场景</option>
              {sceneOptions.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title || item.id}
                </option>
              ))}
            </select>
            <FieldError message={issueAt(issues, `${base}.sceneId`)} />
          </label>
          {sceneOptions.length === 0 ? (
            <p className="scene-editor-hint">只有一个场景，先在左侧新增一个场景才能做场景跳转。</p>
          ) : null}
        </>
      )}
    </>
  );
}

function QuestionPanel({
  draft,
  readOnly,
  onChange,
}: {
  draft: QuestionDraft;
  readOnly: boolean;
  onChange: (patch: Partial<QuestionDraft>) => void;
}) {
  return (
    <>
      <div className="scene-editor-panel-head">
        <div>
          <h2>题目信息</h2>
          <p className="scene-editor-code">与场景配置一起保存</p>
        </div>
      </div>
      <label className="settings-field">
        <span className="q-label">标题</span>
        <input
          className="settings-input"
          maxLength={200}
          value={draft.title}
          disabled={readOnly}
          onChange={(event) => onChange({ title: event.target.value })}
        />
      </label>
      <label className="settings-field">
        <span className="q-label">描述</span>
        <textarea
          className="settings-input"
          rows={4}
          maxLength={1000}
          value={draft.description}
          disabled={readOnly}
          placeholder="给参与者的探索提示（可选）"
          onChange={(event) => onChange({ description: event.target.value })}
        />
      </label>
      <label className="settings-check">
        <input
          type="checkbox"
          checked={draft.required}
          disabled={readOnly}
          onChange={(event) => onChange({ required: event.target.checked })}
        />
        必答（至少探索一处热点）
      </label>
    </>
  );
}
