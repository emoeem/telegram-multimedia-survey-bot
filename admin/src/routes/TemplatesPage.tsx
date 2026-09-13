import { useEffect, useState } from "react";
import { useDialogs } from "../components/Dialogs";
import { Plus, X } from "lucide-react";
import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { api, apiSend, type ReportTemplateOption } from "../api";
import { SkeletonPanel } from "../components/ui";

interface SectionDraft {
  /** Stable identity for dnd-kit sorting; stripped before saving. */
  uid: string;
  kind: string;
  presentation?: string;
}

const newSectionUid = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `s-${Date.now()}-${Math.random().toString(36).slice(2)}`;

interface TemplateDraft {
  id: string;
  name: string;
  theme: string;
  layout?: string;
  sections: SectionDraft[];
  css: string;
  renderers: string[];
}

const SECTION_OPTIONS: Array<{ kind: string; label: string }> = [
  { kind: "cover", label: "封面（大图）" },
  { kind: "hero", label: "档案头（头像+标题）" },
  { kind: "summary", label: "总结" },
  { kind: "scores", label: "得分（条形）" },
  { kind: "radar", label: "雷达画像" },
  { kind: "insights", label: "分析解读" },
  { kind: "quotes", label: "摘录引文" },
  { kind: "answers", label: "回答明细" },
  { kind: "gallery", label: "影集" },
  { kind: "divider", label: "分隔线" },
  { kind: "verdict", label: "结论" },
];

const PRESENTATIONS = ["cards", "list", "grid", "featured", "full"];

const LAYOUT_OPTIONS: Array<{ id: string; name: string }> = [
  { id: "", name: "不启用（经典分区渲染）" },
  { id: "editorial", name: "编辑风 Editorial" },
  { id: "bento", name: "网格卡片 Bento" },
  { id: "magazine", name: "杂志 Magazine" },
  { id: "data", name: "数据看板 Data" },
  { id: "gallery", name: "影集 Gallery" },
  { id: "profile", name: "档案 Profile" },
];

const THEME_OPTIONS: Array<{ id: string; name: string }> = [
  { id: "daisy-light", name: "明亮（DaisyUI）" },
  { id: "daisy-dark", name: "暗色（DaisyUI）" },
  { id: "daisy-night", name: "深蓝夜（DaisyUI）" },
  { id: "daisy-luxury", name: "黑金奢华（DaisyUI）" },
  { id: "daisy-retro", name: "复古纸张（DaisyUI）" },
  { id: "daisy-cupcake", name: "粉彩（DaisyUI）" },
  { id: "daisy-synthwave", name: "霓虹（DaisyUI）" },
  { id: "daisy-black", name: "纯黑（DaisyUI）" },
  ...(
    [
      "catppuccin-latte",
      "catppuccin-frappe",
      "catppuccin-macchiato",
      "catppuccin-mocha",
      "tokyo-night",
      "dracula",
      "one-dark",
      "nord",
      "night-owl",
      "horizon",
      "cobalt2",
      "palenight",
      "solarized-dark",
      "gruvbox-dark",
      "monokai",
    ] as const
  ).map((id) => ({ id, name: id })),
];

const KIND_LABELS: Record<string, string> = Object.fromEntries(SECTION_OPTIONS.map((item) => [item.kind, item.label]));

function emptyDraft(): TemplateDraft {
  return {
    id: "",
    name: "",
    theme: "daisy-light",
    layout: "",
    sections: [
      { uid: newSectionUid(), kind: "hero" },
      { uid: newSectionUid(), kind: "summary" },
      { uid: newSectionUid(), kind: "scores", presentation: "grid" },
      { uid: newSectionUid(), kind: "answers" },
      { uid: newSectionUid(), kind: "verdict" },
    ],
    css: "",
    renderers: ["web", "pdf"],
  };
}

const FONT_OPTIONS = [
  { id: "default", label: "系统默认", css: "var(--font-sans)" },
  { id: "serif", label: "衬线（杂志感）", css: 'Georgia, "Noto Serif CJK SC", serif' },
  { id: "mono", label: "等宽（数据感）", css: 'ui-monospace, "SF Mono", Menlo, monospace' },
];

function visualCss(visual: { font: string; primary: string; accent: string }): string {
  const font = FONT_OPTIONS.find((item) => item.id === visual.font)?.css ?? FONT_OPTIONS[0]!.css;
  return `:root{--font-display:${font};--font-heading:${font};--report-primary:${visual.primary};--report-accent:${visual.accent}}`;
}

function SortableSectionRow({
  section,
  index,
  onUpdate,
  onRemove,
}: {
  section: SectionDraft;
  index: number;
  onUpdate: (index: number, section: SectionDraft) => void;
  onRemove: (index: number) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: section.uid,
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex items-center gap-2 rounded-lg border border-[var(--color-edge)] bg-[var(--surface-muted)] p-2 ${isDragging ? "opacity-50" : ""}`}
    >
      <button
        type="button"
        className="cursor-grab touch-none px-1 text-[var(--color-muted-soft)]"
        aria-label="拖动排序"
        {...attributes}
        {...listeners}
      >
        ⋮⋮
      </button>
      <select
        className="select flex-1"
        value={section.kind}
        onChange={(event) => onUpdate(index, { ...section, kind: event.target.value })}
      >
        {SECTION_OPTIONS.map((option) => (
          <option key={option.kind} value={option.kind}>
            {option.label}
          </option>
        ))}
      </select>
      <select
        className="select w-full sm:w-auto"
        value={section.presentation ?? ""}
        onChange={(event) => onUpdate(index, { ...section, presentation: event.target.value || undefined })}
      >
        <option value="">默认</option>
        {PRESENTATIONS.map((presentation) => (
          <option key={presentation} value={presentation}>
            {presentation}
          </option>
        ))}
      </select>
      <button type="button" className="btn btn-sm text-[var(--color-danger)]" onClick={() => onRemove(index)}>
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

export function TemplatesPage() {
  const [templates, setTemplates] = useState<ReportTemplateOption[] | null>(null);
  const { confirm } = useDialogs();
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<TemplateDraft | null>(null);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewWidth, setPreviewWidth] = useState(390);
  const [busy, setBusy] = useState(false);
  const [visual, setVisual] = useState({ font: "default", primary: "#4f46e5", accent: "#0ea5e9" });
  const [cssExtra, setCssExtra] = useState("");
  const sensors = useSensors(
    useSensor(MouseSensor),
    useSensor(TouchSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const combinedCss = [visualCss(visual), cssExtra].filter(Boolean).join("\n");

  const reload = async () => {
    try {
      setTemplates((await api<{ templates: ReportTemplateOption[] }>("/api/admin/report-templates")).templates);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "加载失败");
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  const openTemplate = async (id: string, copy: boolean) => {
    setError(null);
    setPreviewHtml(null);
    try {
      const data = await api<{ template: TemplateDraft & { isCustom?: boolean } }>(
        `/api/admin/report-templates/${encodeURIComponent(id)}`,
      );
      setDraft({
        ...data.template,
        id: copy ? `${id}-copy` : data.template.id,
        css: data.template.css ?? "",
        sections: (data.template.sections ?? []).map((section) => ({
          ...section,
          uid: newSectionUid(),
        })),
      });
      setCssExtra(data.template.css ?? "");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "加载模板失败");
    }
  };

  const refreshPreview = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const result = await apiSend<{ html: string }>("POST", "/api/admin/report-templates/preview", {
        ...draft,
        css: combinedCss,
      } as unknown as Record<string, unknown>);
      setPreviewHtml(result.html);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "预览失败");
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!draft) return;
    if (!draft.id.trim() || !draft.name.trim()) {
      setError("模板 id 与名称必填");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiSend("POST", "/api/admin/report-templates", {
        ...draft,
        sections: draft.sections.map(({ uid: _uid, kind, presentation }) => ({
          kind,
          ...(presentation ? { presentation } : {}),
        })),
        css: combinedCss,
      } as unknown as Record<string, unknown>);
      setDraft(null);
      setPreviewHtml(null);
      await reload();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };

  const removeTemplate = async (id: string) => {
    if (!(await confirm({ message: `确定删除自定义模板「${id}」？`, variant: "danger" }))) return;
    try {
      await apiSend("DELETE", `/api/admin/report-templates/${encodeURIComponent(id)}`);
      await reload();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "删除失败");
    }
  };

  const updateSection = (index: number, next: SectionDraft) => {
    if (!draft) return;
    setDraft({
      ...draft,
      sections: draft.sections.map((section, itemIndex) => (itemIndex === index ? next : section)),
    });
  };

  const removeSection = (index: number) => {
    if (!draft) return;
    setDraft({ ...draft, sections: draft.sections.filter((_, itemIndex) => itemIndex !== index) });
  };

  const onSectionsDragEnd = (event: DragEndEvent) => {
    if (!draft) return;
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = draft.sections.findIndex((section) => section.uid === active.id);
    const to = draft.sections.findIndex((section) => section.uid === over.id);
    if (from < 0 || to < 0) return;
    setDraft({ ...draft, sections: arrayMove(draft.sections, from, to) });
  };

  if (error && !draft) {
    return (
      <section className="card">
        <p className="text-sm text-[var(--color-danger)]">{error}</p>
        <button
          className="btn mt-3"
          onClick={() => {
            setError(null);
            void reload();
          }}
        >
          重试
        </button>
      </section>
    );
  }

  return (
    <div className="space-y-4">
      <section className="card">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">报告模板库</h2>
          <button
            className="btn btn-primary"
            onClick={() => {
              setError(null);
              setPreviewHtml(null);
              setDraft(emptyDraft());
            }}
          >
            <Plus className="h-4 w-4" />
            新建模板
          </button>
        </div>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          系统模板只读，可复制后编辑；自定义模板保存后即可在问卷详情中选用。
        </p>
        {templates ? (
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {templates.map((template) => (
              <div key={template.id} className="rounded-xl border border-[var(--color-edge)] bg-[var(--surface)] p-4">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <strong className="truncate">{template.name}</strong>
                  <span className="flex shrink-0 items-center gap-1.5">
                    {template.layout ? (
                      <span className="rounded-full bg-[color-mix(in_srgb,var(--color-primary)_10%,var(--surface))] px-2 py-0.5 text-xs text-[var(--color-primary)]">
                        {LAYOUT_OPTIONS.find((item) => item.id === template.layout)?.name ?? template.layout}
                      </span>
                    ) : null}
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${template.isCustom ? "bg-[color-mix(in_srgb,var(--color-primary)_10%,var(--surface))] text-[var(--color-primary)]" : "bg-[var(--surface-muted)] text-[var(--text-soft)]"}`}
                    >
                      {template.isCustom ? "自定义" : "系统"}
                    </span>
                  </span>
                </div>
                <div className="mt-1 font-mono text-xs text-[var(--color-muted-soft)]">{template.id}</div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    className="btn btn-sm"
                    onClick={() => void openTemplate(template.id, Boolean(template.isCustom) ? false : true)}
                  >
                    {template.isCustom ? "编辑" : "复制编辑"}
                  </button>
                  {template.isCustom ? (
                    <button
                      className="btn btn-sm text-[var(--color-danger)]"
                      onClick={() => void removeTemplate(template.id)}
                    >
                      删除
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <SkeletonPanel lines={4} />
        )}
      </section>

      {draft ? (
        <section className="card">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-lg font-semibold">{draft.id ? `编辑模板：${draft.id}` : "新建模板"}</h3>
            <div className="flex gap-2">
              <button
                className="btn"
                onClick={() => {
                  setDraft(null);
                  setPreviewHtml(null);
                  setError(null);
                }}
              >
                返回列表
              </button>
              <button className="btn btn-primary" disabled={busy} onClick={() => void save()}>
                {busy ? "保存中…" : "保存模板"}
              </button>
            </div>
          </div>
          {error ? <p className="mt-2 text-sm text-[var(--color-danger)]">{error}</p> : null}

          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="space-y-3">
              <div>
                <label className="text-sm text-[var(--text-soft)]">模板 id（小写字母/数字/连字符）</label>
                <input
                  className="input mt-1 w-full font-mono"
                  value={draft.id}
                  disabled={Boolean(draft.id && draft.id.endsWith("-copy") === false)}
                  onChange={(event) => setDraft({ ...draft, id: event.target.value.trim() })}
                  placeholder="my-template"
                />
              </div>
              <div>
                <label className="text-sm text-[var(--text-soft)]">模板名称</label>
                <input
                  className="input mt-1 w-full"
                  value={draft.name}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  placeholder="我的报告模板"
                />
              </div>
              <div>
                <label className="text-sm text-[var(--text-soft)]">主题</label>
                <select
                  className="select mt-1 w-full"
                  value={draft.theme}
                  onChange={(event) => setDraft({ ...draft, theme: event.target.value })}
                >
                  {THEME_OPTIONS.map((theme) => (
                    <option key={theme.id} value={theme.id}>
                      {theme.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-sm text-[var(--text-soft)]">版式（启用后使用真版式引擎渲染）</label>
                <select
                  className="select mt-1 w-full"
                  value={draft.layout ?? ""}
                  onChange={(event) => setDraft({ ...draft, layout: event.target.value || undefined })}
                >
                  {LAYOUT_OPTIONS.map((layout) => (
                    <option key={layout.id} value={layout.id}>
                      {layout.name}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-[var(--color-muted-soft)]">
                  版式引擎提供编辑风 / 网格 / 杂志 / 数据 / 影集 / 档案六种真正的布局差异；不启用时使用经典分区渲染。
                </p>
              </div>
              <div>
                <label className="text-sm text-[var(--text-soft)]">内容块（自上而下渲染）</label>
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onSectionsDragEnd}>
                  <SortableContext
                    items={draft.sections.map((section) => section.uid)}
                    strategy={verticalListSortingStrategy}
                  >
                    <div className="mt-1 space-y-2">
                      {draft.sections.map((section, index) => (
                        <SortableSectionRow
                          key={section.uid}
                          section={section}
                          index={index}
                          onUpdate={updateSection}
                          onRemove={removeSection}
                        />
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>
                <button
                  className="btn btn-sm mt-2"
                  onClick={() =>
                    setDraft({ ...draft, sections: [...draft.sections, { uid: newSectionUid(), kind: "answers" }] })
                  }
                >
                  <Plus className="h-4 w-4" />
                  添加块
                </button>
              </div>
              <div>
                <label className="text-sm text-[var(--text-soft)]">字体与配色（可视化）</label>
                <div className="mt-1 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <label className="text-xs text-[var(--color-muted)]">
                    字体
                    <select
                      className="select mt-1 w-full"
                      value={visual.font}
                      onChange={(event) => setVisual({ ...visual, font: event.target.value })}
                    >
                      {FONT_OPTIONS.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-xs text-[var(--color-muted)]">
                    主色
                    <input
                      type="color"
                      className="input mt-1 h-9 w-full p-1"
                      value={visual.primary}
                      onChange={(event) => setVisual({ ...visual, primary: event.target.value })}
                    />
                  </label>
                  <label className="text-xs text-[var(--color-muted)]">
                    强调色
                    <input
                      type="color"
                      className="input mt-1 h-9 w-full p-1"
                      value={visual.accent}
                      onChange={(event) => setVisual({ ...visual, accent: event.target.value })}
                    />
                  </label>
                </div>
              </div>
              <div>
                <label className="text-sm text-[var(--text-soft)]">额外 CSS（可选，追加到模板样式）</label>
                <textarea
                  className="input mt-1 min-h-24 w-full font-mono text-xs"
                  value={cssExtra}
                  onChange={(event) => setCssExtra(event.target.value)}
                  placeholder=".report-section { ... }"
                />
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="text-sm text-[var(--text-soft)]">实时预览</span>
                <div className="flex gap-2">
                  <button
                    className={`btn btn-sm ${previewWidth === 390 ? "btn-primary" : ""}`}
                    onClick={() => setPreviewWidth(390)}
                  >
                    手机
                  </button>
                  <button
                    className={`btn btn-sm ${previewWidth === 1100 ? "btn-primary" : ""}`}
                    onClick={() => setPreviewWidth(1100)}
                  >
                    桌面
                  </button>
                  <button className="btn btn-sm" disabled={busy} onClick={() => void refreshPreview()}>
                    {busy ? "渲染中…" : "刷新预览"}
                  </button>
                </div>
              </div>
              <div className="mt-2 flex justify-center overflow-x-auto rounded-xl border border-[var(--color-edge)] bg-[var(--surface-muted)] p-3">
                {previewHtml ? (
                  <iframe
                    title="报告模板预览"
                    className="h-[70vh] rounded-lg border border-[var(--control-border)] bg-[var(--surface)] transition-all"
                    style={{ width: previewWidth, maxWidth: "100%" }}
                    srcDoc={previewHtml}
                  />
                ) : (
                  <div className="py-16 text-center text-sm text-[var(--color-muted-soft)]">
                    点击「刷新预览」渲染当前模板
                  </div>
                )}
              </div>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}
