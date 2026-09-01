import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { PageHeader } from "../components/ui";
import { ApiError } from "../api";
import {
  CARD_SLOT_BINDING_LABELS,
  CARD_TEMPLATE_PRESETS,
  CARD_TEMPLATE_SAMPLE_TEXT,
  DEFAULT_DISCLAIMER,
  createCardTemplate,
  deleteCardTemplate,
  fetchCardTemplates,
  newSlotId,
  previewCardTemplate,
  updateCardTemplate,
  uploadCardTemplateBackground,
  type CardSlot,
  type CardTemplate,
  type CardTemplateDraft,
  type CardSlotBinding,
} from "../cardTemplates";

const CANVAS_W = 900;
const CANVAS_H = 1200;

const TEXT_BINDINGS: CardSlotBinding[] = [
  "name",
  "nickname",
  "age",
  "identity_label",
  "description",
  "card_id",
  "date",
  "custom",
];

function slotDisplayText(slot: CardSlot): string {
  if (slot.kind === "image") return CARD_SLOT_BINDING_LABELS[slot.binding];
  if (slot.binding === "custom") return slot.customText || "自定义文本";
  return CARD_TEMPLATE_SAMPLE_TEXT[slot.binding] ?? "";
}

type DragState = {
  slotId: string;
  mode: "move" | "resize";
  startX: number;
  startY: number;
  origX: number;
  origY: number;
  origW: number;
  origH: number;
} | null;

function emptyDraft(): CardTemplateDraft {
  return {
    name: "未命名卡面",
    backgroundAssetId: null,
    backgroundColor: "#ffffff",
    slots: [],
    disclaimerText: DEFAULT_DISCLAIMER,
    enabled: true,
  };
}

export function CardTemplatesPage() {
  const [templates, setTemplates] = useState<CardTemplate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState<CardTemplateDraft | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.5);
  const dragRef = useRef<DragState>(null);

  const load = async () => {
    try {
      const data = await fetchCardTemplates();
      setTemplates(data.templates);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "加载失败");
    }
  };

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    const el = canvasWrapRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setScale(el.clientWidth / CANVAS_W));
    observer.observe(el);
    return () => observer.disconnect();
  }, [draft]);

  const startEdit = (template: CardTemplate) => {
    setEditingId(template.id);
    setDraft({
      name: template.name,
      backgroundAssetId: template.backgroundAssetId,
      backgroundColor: template.backgroundColor,
      slots: template.slots.map((slot) => ({ ...slot })),
      disclaimerText: template.disclaimerText,
      enabled: template.enabled,
    });
    setSelectedSlot(null);
    setNotice(null);
  };

  const startCreate = (preset?: (typeof CARD_TEMPLATE_PRESETS)[number]) => {
    setEditingId(null);
    setDraft(preset ? structuredClone(preset.draft) : emptyDraft());
    setSelectedSlot(null);
    setNotice(null);
  };

  const patchDraft = (patch: Partial<CardTemplateDraft>) => {
    setDraft((current) => (current ? { ...current, ...patch } : current));
  };

  const patchSlot = (slotId: string, patch: Partial<CardSlot>) => {
    setDraft((current) =>
      current
        ? { ...current, slots: current.slots.map((slot) => (slot.id === slotId ? { ...slot, ...patch } : slot)) }
        : current,
    );
  };

  const addSlot = (kind: "text" | "image") => {
    if (!draft) return;
    const slot: CardSlot =
      kind === "image"
        ? { id: newSlotId(), kind, binding: "front_image", x: 300, y: 500, w: 300, h: 300, radius: 0 }
        : { id: newSlotId(), kind, binding: "name", x: 250, y: 560, w: 400, h: 60, fontSize: 32, color: "#111111" };
    patchDraft({ slots: [...draft.slots, slot] });
    setSelectedSlot(slot.id);
  };

  const onSlotPointerDown = (event: ReactPointerEvent, slot: CardSlot, mode: "move" | "resize") => {
    event.preventDefault();
    event.stopPropagation();
    setSelectedSlot(slot.id);
    dragRef.current = {
      slotId: slot.id,
      mode,
      startX: event.clientX,
      startY: event.clientY,
      origX: slot.x,
      origY: slot.y,
      origW: slot.w,
      origH: slot.h,
    };
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
  };

  const onSlotPointerMove = (event: ReactPointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = (event.clientX - drag.startX) / scale;
    const dy = (event.clientY - drag.startY) / scale;
    if (drag.mode === "move") {
      patchSlot(drag.slotId, { x: Math.round(drag.origX + dx), y: Math.round(drag.origY + dy) });
    } else {
      patchSlot(drag.slotId, {
        w: Math.max(20, Math.round(drag.origW + dx)),
        h: Math.max(16, Math.round(drag.origH + dy)),
      });
    }
  };

  const onSlotPointerUp = () => {
    dragRef.current = null;
  };

  const onUploadBackground = async (file: File | undefined) => {
    if (!file || !draft) return;
    try {
      setNotice("上传背景中…");
      const assetId = await uploadCardTemplateBackground(file);
      patchDraft({ backgroundAssetId: assetId });
      setNotice("背景已上传");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "上传失败");
    }
  };

  const onSave = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      if (editingId) {
        const result = await updateCardTemplate(editingId, draft);
        setTemplates((list) => list?.map((item) => (item.id === editingId ? result.template : item)) ?? null);
      } else {
        const result = await createCardTemplate(draft);
        setEditingId(result.template.id);
        setTemplates((list) => [...(list ?? []), result.template]);
      }
      setNotice("已保存");
      setError(null);
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const onDelete = async (template: CardTemplate) => {
    if (!window.confirm(`确定删除卡面模板「${template.name}」吗？`)) return;
    try {
      await deleteCardTemplate(template.id);
      setTemplates((list) => list?.filter((item) => item.id !== template.id) ?? null);
      if (editingId === template.id) {
        setDraft(null);
        setEditingId(null);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "删除失败");
    }
  };

  const onPreview = async () => {
    if (!draft) return;
    setPreviewing(true);
    try {
      const blob = await previewCardTemplate(draft);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(URL.createObjectURL(blob));
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "预览失败");
    } finally {
      setPreviewing(false);
    }
  };

  const selected = draft?.slots.find((slot) => slot.id === selectedSlot) ?? null;

  return (
    <div className="mx-auto w-full max-w-6xl">
      <PageHeader
        title="卡面模板"
        actions={
          <div className="flex flex-wrap gap-2">
            <div className="dropdown dropdown-end">
              <button type="button" tabIndex={0} className="btn btn-sm">
                从预设新建
              </button>
              <ul tabIndex={0} className="dropdown-content menu bg-base-100 rounded-box z-10 w-64 p-2 shadow">
                {CARD_TEMPLATE_PRESETS.map((preset) => (
                  <li key={preset.key}>
                    <button type="button" onClick={() => startCreate(preset)}>
                      <span>
                        {preset.label}
                        <span className="block text-xs opacity-60">{preset.description}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => startCreate()}>
              空白模板
            </button>
          </div>
        }
      />
      {error ? <div className="alert alert-error mb-4">{error}</div> : null}

      <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
        <div className="flex flex-col gap-2">
          {(templates ?? []).map((template) => (
            <div
              key={template.id}
              className={`card bg-base-100 shadow-sm cursor-pointer border ${draft && editingId === template.id ? "border-primary" : "border-transparent"}`}
              onClick={() => startEdit(template)}
            >
              <div className="card-body p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{template.name}</span>
                  <span className={`badge badge-sm ${template.enabled ? "badge-success" : "badge-ghost"}`}>
                    {template.enabled ? "启用" : "停用"}
                  </span>
                </div>
                <div className="text-xs opacity-60">
                  {template.slots.length} 个槽位 · {template.backgroundAssetId ? "有背景图" : "纯色背景"}
                </div>
                <div className="mt-1 flex gap-2">
                  <button
                    type="button"
                    className="btn btn-xs"
                    onClick={(event) => {
                      event.stopPropagation();
                      void updateCardTemplate(template.id, { enabled: !template.enabled }).then(load);
                    }}
                  >
                    {template.enabled ? "停用" : "启用"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-xs btn-error btn-outline"
                    onClick={(event) => {
                      event.stopPropagation();
                      void onDelete(template);
                    }}
                  >
                    删除
                  </button>
                </div>
              </div>
            </div>
          ))}
          {templates && templates.length === 0 ? (
            <div className="text-sm opacity-60">还没有卡面模板，从预设新建一个吧。</div>
          ) : null}
        </div>

        {draft ? (
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
            <div>
              <div ref={canvasWrapRef} className="relative mx-auto w-full max-w-[460px]" style={{ aspectRatio: "3/4" }}>
                <div
                  className="absolute left-0 top-0 overflow-hidden shadow-lg"
                  style={{
                    width: CANVAS_W,
                    height: CANVAS_H,
                    transform: `scale(${scale})`,
                    transformOrigin: "0 0",
                    background: draft.backgroundColor,
                  }}
                  onPointerDown={() => setSelectedSlot(null)}
                >
                  {draft.backgroundAssetId ? (
                    <img
                      src={`/api/admin/media/${draft.backgroundAssetId}/image`}
                      alt=""
                      className="absolute inset-0 h-full w-full object-cover"
                      draggable={false}
                    />
                  ) : null}
                  {draft.slots.map((slot) => (
                    <div
                      key={slot.id}
                      onPointerDown={(event) => onSlotPointerDown(event, slot, "move")}
                      onPointerMove={onSlotPointerMove}
                      onPointerUp={onSlotPointerUp}
                      className={`absolute touch-none select-none ${selectedSlot === slot.id ? "outline outline-2 outline-primary" : "outline outline-1 outline-dashed outline-base-content/30"}`}
                      style={{
                        left: slot.x,
                        top: slot.y,
                        width: slot.w,
                        height: slot.h,
                        opacity: slot.opacity ?? 1,
                        transform: slot.rotate ? `rotate(${slot.rotate}deg)` : undefined,
                        cursor: "move",
                        overflow: "hidden",
                        borderRadius: slot.kind === "image" ? (slot.radius ?? 0) : 0,
                        display: "flex",
                        flexDirection: "column",
                        justifyContent: "center",
                        alignItems:
                          slot.align === "center" ? "center" : slot.align === "right" ? "flex-end" : "flex-start",
                        fontSize: slot.fontSize ?? 28,
                        fontWeight: slot.fontWeight ?? 400,
                        fontFamily: slot.fontFamily === "serif" ? "Georgia, serif" : "inherit",
                        color: slot.color ?? "#111111",
                        textAlign: slot.align ?? "left",
                        lineHeight: slot.lineHeight ?? 1.4,
                        background: slot.kind === "image" ? "rgba(128,128,128,.15)" : "transparent",
                      }}
                    >
                      {slot.kind === "image" ? (
                        <span className="m-auto text-xs opacity-60">{slotDisplayText(slot)}</span>
                      ) : (
                        <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{slotDisplayText(slot)}</div>
                      )}
                      {selectedSlot === slot.id ? (
                        <div
                          onPointerDown={(event) => onSlotPointerDown(event, slot, "resize")}
                          onPointerMove={onSlotPointerMove}
                          onPointerUp={onSlotPointerUp}
                          className="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize bg-primary"
                          style={{ touchAction: "none" }}
                        />
                      ) : null}
                    </div>
                  ))}
                  <div className="absolute bottom-2.5 right-3 rounded-full bg-black/40 px-2.5 py-1 text-[15px] text-white">
                    {draft.disclaimerText}
                  </div>
                </div>
              </div>
              {previewUrl ? (
                <div className="mt-4">
                  <div className="mb-1 text-sm opacity-70">服务端渲染预览（与生成效果一致）：</div>
                  <img src={previewUrl} alt="预览" className="mx-auto w-full max-w-[460px] shadow-lg" />
                </div>
              ) : null}
            </div>

            <div className="flex flex-col gap-3">
              <label className="form-control">
                <span className="label-text mb-1">模板名称</span>
                <input
                  className="input input-bordered input-sm"
                  value={draft.name}
                  onChange={(event) => patchDraft({ name: event.target.value })}
                />
              </label>
              <label className="form-control">
                <span className="label-text mb-1">背景色</span>
                <input
                  type="color"
                  className="input input-bordered input-sm h-10 w-full p-1"
                  value={draft.backgroundColor}
                  onChange={(event) => patchDraft({ backgroundColor: event.target.value })}
                />
              </label>
              <div className="form-control">
                <span className="label-text mb-1">背景图（朋友圈截图、封面等）</span>
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className="file-input file-input-bordered file-input-sm"
                  onChange={(event) => void onUploadBackground(event.target.files?.[0])}
                />
                {draft.backgroundAssetId ? (
                  <button
                    type="button"
                    className="btn btn-xs mt-1 w-fit"
                    onClick={() => patchDraft({ backgroundAssetId: null })}
                  >
                    移除背景图
                  </button>
                ) : null}
              </div>
              <label className="form-control">
                <span className="label-text mb-1">虚构声明（固定在右下角）</span>
                <input
                  className="input input-bordered input-sm"
                  value={draft.disclaimerText}
                  maxLength={40}
                  onChange={(event) => patchDraft({ disclaimerText: event.target.value })}
                />
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="toggle toggle-sm"
                  checked={draft.enabled}
                  onChange={(event) => patchDraft({ enabled: event.target.checked })}
                />
                启用后用户可在机器人里选择
              </label>

              <div className="divider my-1">槽位</div>
              <div className="flex gap-2">
                <button type="button" className="btn btn-xs" onClick={() => addSlot("text")}>
                  + 文本
                </button>
                <button type="button" className="btn btn-xs" onClick={() => addSlot("image")}>
                  + 图片
                </button>
              </div>

              {selected ? (
                <div className="rounded-box border border-base-300 p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-sm font-medium">{selected.kind === "image" ? "图片槽位" : "文本槽位"}</span>
                    <button
                      type="button"
                      className="btn btn-xs btn-error btn-outline"
                      onClick={() => {
                        patchDraft({ slots: draft.slots.filter((slot) => slot.id !== selected.id) });
                        setSelectedSlot(null);
                      }}
                    >
                      删除槽位
                    </button>
                  </div>
                  <label className="form-control mb-2">
                    <span className="label-text mb-1">绑定内容</span>
                    <select
                      className="select select-bordered select-sm"
                      value={selected.binding}
                      onChange={(event) => {
                        const binding = event.target.value as CardSlotBinding;
                        patchSlot(selected.id, {
                          binding,
                          kind: binding === "front_image" || binding === "back_image" ? "image" : "text",
                        });
                      }}
                    >
                      {(selected.kind === "image" ? (["front_image", "back_image"] as const) : TEXT_BINDINGS).map(
                        (binding) => (
                          <option key={binding} value={binding}>
                            {CARD_SLOT_BINDING_LABELS[binding]}
                          </option>
                        ),
                      )}
                    </select>
                  </label>
                  {selected.kind === "text" && selected.binding === "custom" ? (
                    <label className="form-control mb-2">
                      <span className="label-text mb-1">自定义文本</span>
                      <textarea
                        className="textarea textarea-bordered textarea-sm"
                        value={selected.customText ?? ""}
                        onChange={(event) => patchSlot(selected.id, { customText: event.target.value })}
                      />
                    </label>
                  ) : null}
                  {selected.kind === "text" ? (
                    <>
                      <div className="grid grid-cols-2 gap-2">
                        <label className="form-control">
                          <span className="label-text mb-1">字号</span>
                          <input
                            type="number"
                            className="input input-bordered input-sm"
                            value={selected.fontSize ?? 28}
                            onChange={(event) => patchSlot(selected.id, { fontSize: Number(event.target.value) || 28 })}
                          />
                        </label>
                        <label className="form-control">
                          <span className="label-text mb-1">字重</span>
                          <select
                            className="select select-bordered select-sm"
                            value={selected.fontWeight ?? 400}
                            onChange={(event) => patchSlot(selected.id, { fontWeight: Number(event.target.value) })}
                          >
                            {[300, 400, 500, 600, 700, 800].map((weight) => (
                              <option key={weight} value={weight}>
                                {weight}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="form-control">
                          <span className="label-text mb-1">颜色</span>
                          <input
                            type="color"
                            className="input input-bordered input-sm h-9 w-full p-1"
                            value={selected.color ?? "#111111"}
                            onChange={(event) => patchSlot(selected.id, { color: event.target.value })}
                          />
                        </label>
                        <label className="form-control">
                          <span className="label-text mb-1">对齐</span>
                          <select
                            className="select select-bordered select-sm"
                            value={selected.align ?? "left"}
                            onChange={(event) =>
                              patchSlot(selected.id, { align: event.target.value as CardSlot["align"] })
                            }
                          >
                            <option value="left">左对齐</option>
                            <option value="center">居中</option>
                            <option value="right">右对齐</option>
                          </select>
                        </label>
                        <label className="form-control">
                          <span className="label-text mb-1">字体</span>
                          <select
                            className="select select-bordered select-sm"
                            value={selected.fontFamily ?? "sans"}
                            onChange={(event) =>
                              patchSlot(selected.id, { fontFamily: event.target.value as CardSlot["fontFamily"] })
                            }
                          >
                            <option value="sans">黑体</option>
                            <option value="serif">宋体/衬线</option>
                          </select>
                        </label>
                        <label className="form-control">
                          <span className="label-text mb-1">行高</span>
                          <input
                            type="number"
                            step="0.1"
                            className="input input-bordered input-sm"
                            value={selected.lineHeight ?? 1.4}
                            onChange={(event) =>
                              patchSlot(selected.id, { lineHeight: Number(event.target.value) || 1.4 })
                            }
                          />
                        </label>
                      </div>
                    </>
                  ) : (
                    <div className="grid grid-cols-2 gap-2">
                      <label className="form-control">
                        <span className="label-text mb-1">填充方式</span>
                        <select
                          className="select select-bordered select-sm"
                          value={selected.fit ?? "cover"}
                          onChange={(event) => patchSlot(selected.id, { fit: event.target.value as CardSlot["fit"] })}
                        >
                          <option value="cover">裁剪填满</option>
                          <option value="contain">完整显示</option>
                        </select>
                      </label>
                      <label className="form-control">
                        <span className="label-text mb-1">圆角</span>
                        <input
                          type="number"
                          className="input input-bordered input-sm"
                          value={selected.radius ?? 0}
                          onChange={(event) => patchSlot(selected.id, { radius: Number(event.target.value) || 0 })}
                        />
                      </label>
                    </div>
                  )}
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <label className="form-control">
                      <span className="label-text mb-1">不透明度</span>
                      <input
                        type="number"
                        step="0.05"
                        min="0.05"
                        max="1"
                        className="input input-bordered input-sm"
                        value={selected.opacity ?? 1}
                        onChange={(event) => patchSlot(selected.id, { opacity: Number(event.target.value) || 1 })}
                      />
                    </label>
                    <label className="form-control">
                      <span className="label-text mb-1">旋转角度</span>
                      <input
                        type="number"
                        className="input input-bordered input-sm"
                        value={selected.rotate ?? 0}
                        onChange={(event) => patchSlot(selected.id, { rotate: Number(event.target.value) || 0 })}
                      />
                    </label>
                  </div>
                  <div className="mt-2 text-xs opacity-50">
                    位置 {selected.x},{selected.y} · 尺寸 {selected.w}×{selected.h}
                  </div>
                </div>
              ) : (
                <div className="text-xs opacity-60">点击画布中的槽位进行编辑，拖动移动，右下角手柄缩放。</div>
              )}

              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={saving}
                  onClick={() => void onSave()}
                >
                  {saving ? "保存中…" : editingId ? "保存" : "创建"}
                </button>
                <button type="button" className="btn btn-sm" disabled={previewing} onClick={() => void onPreview()}>
                  {previewing ? "渲染中…" : "渲染预览"}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    setDraft(null);
                    setEditingId(null);
                    setPreviewUrl(null);
                  }}
                >
                  关闭
                </button>
              </div>
              {notice ? <div className="text-sm opacity-70">{notice}</div> : null}
            </div>
          </div>
        ) : (
          <div className="text-sm opacity-60">选择左侧模板进行编辑，或新建一个模板。</div>
        )}
      </div>
    </div>
  );
}
