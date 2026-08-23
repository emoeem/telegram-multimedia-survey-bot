import type { ReportTheme } from "./themes";
import { reportThemeIds } from "./theme-ids";

/**
 * Report Template System.
 *
 * A template decides WHAT is shown (ordered sections), HOW it is presented
 * (section presentation + layout) and WHAT THEME is used (built-in palette or
 * custom overrides). Every renderer — Web, PDF, Image — consumes the same
 * ReportViewModel plus one template, so a new visual style never touches the
 * data layer.
 */
export type ReportSectionKind =
  | "cover"
  | "hero"
  | "summary"
  | "scores"
  | "radar"
  | "insights"
  | "quotes"
  | "answers"
  | "gallery"
  | "divider"
  | "verdict";

export type ReportSectionPresentation =
  | "cards"
  | "list"
  | "grid"
  | "featured"
  | "full";

export type ReportRendererId = "web" | "pdf" | "image";

export interface ReportTemplateSection {
  kind: ReportSectionKind;
  /** Rendered heading override; falls back to the built-in label. */
  title?: string;
  presentation?: ReportSectionPresentation;
}

export interface ReportTemplateSpec {
  id: string;
  name: string;
  version: number;
  theme: ReportTheme;
  /** Ordered sections rendered top to bottom. */
  sections: ReportTemplateSection[];
  renderers: ReportRendererId[];
  /** Optional extra CSS appended to the report shell. */
  css?: string;
}

export const REPORT_TEMPLATE_SCHEMA_VERSION = 1;

export function isReportTheme(value: unknown): value is ReportTheme {
  return typeof value === "string" &&
    (reportThemeIds as readonly string[]).includes(value);
}

export function validateReportTemplateSpec(
  value: unknown,
): { template?: ReportTemplateSpec; error?: string } {
  if (!value || typeof value !== "object") {
    return { error: "template 必须是对象" };
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || !raw.id.trim()) {
    return { error: "template.id 必填" };
  }
  if (typeof raw.name !== "string" || !raw.name.trim()) {
    return { error: "template.name 必填" };
  }
  if (!isReportTheme(raw.theme)) {
    return { error: `template.theme 必须是已知主题之一` };
  }
  if (!Array.isArray(raw.sections) || raw.sections.length === 0) {
    return { error: "template.sections 必须是非空数组" };
  }
  const sections: ReportTemplateSection[] = [];
  for (const section of raw.sections) {
    if (!section || typeof section !== "object") {
      return { error: "sections 元素必须是对象" };
    }
    const item = section as Record<string, unknown>;
    if (typeof item.kind !== "string" ||
        !sectionKinds.has(item.kind as ReportSectionKind)) {
      return { error: `不支持的 section.kind：${String(item.kind)}` };
    }
    sections.push({
      kind: item.kind as ReportSectionKind,
      ...(typeof item.title === "string" && item.title.trim()
        ? { title: item.title.trim() }
        : {}),
      ...(typeof item.presentation === "string" &&
      sectionPresentations.has(item.presentation as ReportSectionPresentation)
        ? { presentation: item.presentation as ReportSectionPresentation }
        : {}),
    });
  }
  const renderers: ReportRendererId[] = Array.isArray(raw.renderers)
    ? raw.renderers.filter((item): item is ReportRendererId =>
        item === "web" || item === "pdf" || item === "image",
      )
    : ["web", "pdf"];
  return {
    template: {
      id: String(raw.id).trim(),
      name: String(raw.name).trim(),
      version:
        typeof raw.version === "number" && Number.isInteger(raw.version)
          ? raw.version
          : REPORT_TEMPLATE_SCHEMA_VERSION,
      theme: raw.theme as ReportTheme,
      sections,
      renderers: renderers.length > 0 ? renderers : ["web", "pdf"],
      ...(typeof raw.css === "string" && raw.css.trim() ? { css: raw.css } : {}),
    },
  };
}

const sectionKinds = new Set<ReportSectionKind>([
  "cover",
  "hero",
  "summary",
  "scores",
  "radar",
  "insights",
  "quotes",
  "answers",
  "gallery",
  "divider",
  "verdict",
]);

const sectionPresentations = new Set<ReportSectionPresentation>([
  "cards",
  "list",
  "grid",
  "featured",
  "full",
]);

/**
 * Built-in templates. The classic template reproduces the default mobile
 * report; the magazine-dark template demonstrates section reordering plus a
 * cover with a custom theme and styles.
 */
export const DEFAULT_REPORT_TEMPLATE: ReportTemplateSpec = {
  id: "classic",
  name: "经典报告",
  version: 1,
  theme: "catppuccin-latte",
  sections: [
    { kind: "hero" },
    { kind: "summary" },
    { kind: "scores" },
    { kind: "radar" },
    { kind: "insights" },
    { kind: "quotes" },
    { kind: "gallery" },
    { kind: "answers" },
  ],
  renderers: ["web", "pdf"],
};

export const MAGAZINE_DARK_TEMPLATE: ReportTemplateSpec = {
  id: "magazine-dark",
  name: "杂志暗色",
  version: 1,
  theme: "dracula",
  sections: [
    { kind: "cover", presentation: "full" },
    { kind: "summary", presentation: "featured" },
    { kind: "scores" },
    { kind: "insights", presentation: "featured" },
    { kind: "quotes" },
    { kind: "gallery", presentation: "grid" },
    { kind: "answers" },
  ],
  renderers: ["web", "pdf"],
  css: `.report-cover{min-height:52vh;border-radius:var(--radius);padding:38px 24px;background-size:cover;background-position:center;display:flex;flex-direction:column;justify-content:flex-end}.report-cover h1{font-size:34px;line-height:1.25;text-shadow:0 2px 18px #0009}.report-cover .cover-sub{margin-top:8px;color:var(--muted)}`,
};

/** 数据分析型：浅色数据看板，量化指标优先。 */
export const DATA_REPORT_TEMPLATE: ReportTemplateSpec = {
  id: "data",
  name: "数据分析",
  version: 1,
  theme: "daisy-light",
  sections: [
    { kind: "hero" },
    { kind: "summary", presentation: "featured" },
    { kind: "scores", presentation: "grid" },
    { kind: "radar" },
    { kind: "insights" },
    { kind: "answers", presentation: "list" },
    { kind: "gallery" },
  ],
  renderers: ["web", "pdf"],
  css: `.report-section.summary{background:linear-gradient(135deg,var(--report-accent),var(--report-primary));color:#fff}.report-section.summary h2{color:rgba(255,255,255,.85)}.report-section.summary p{font-size:17px;line-height:1.7}`,
};

/** 身份档案型：黑金档案袋风格，适合人物/身份类问卷。 */
export const IDENTITY_REPORT_TEMPLATE: ReportTemplateSpec = {
  id: "identity",
  name: "身份档案",
  version: 1,
  theme: "daisy-luxury",
  sections: [
    { kind: "cover", presentation: "full" },
    { kind: "hero", presentation: "featured" },
    { kind: "scores", presentation: "grid" },
    { kind: "answers", presentation: "list" },
    { kind: "verdict" },
  ],
  renderers: ["web", "pdf"],
  css: `.report-cover{border:1px solid var(--report-border);border-radius:var(--radius);min-height:42vh;padding:36px 26px;background-size:cover;background-position:center;display:flex;flex-direction:column;justify-content:flex-end}.report-cover h1{font-size:32px;letter-spacing:.06em}.report-cover .cover-sub{color:var(--report-text-muted)}.report-section{border-left:4px solid var(--report-accent)}.checklist strong::before{content:"◆ ";color:var(--report-accent)}.ring-card .ring{border:2px solid var(--report-border)}`,
};

/** 杂志亮色：复古纸张编辑风。 */
export const MAGAZINE_REPORT_TEMPLATE: ReportTemplateSpec = {
  id: "magazine",
  name: "杂志",
  version: 1,
  theme: "daisy-retro",
  sections: [
    { kind: "cover", presentation: "full" },
    { kind: "quotes" },
    { kind: "gallery", presentation: "grid" },
    { kind: "answers" },
    { kind: "verdict" },
  ],
  renderers: ["web", "pdf"],
  css: `.report-cover{min-height:46vh;padding:38px 26px;background-size:cover;background-position:center;display:flex;flex-direction:column;justify-content:flex-end;border:1px solid var(--report-border)}.report-cover h1{font-size:36px;font-family:Georgia,"Noto Serif CJK SC",serif;letter-spacing:.04em}.report-cover .cover-sub{margin-top:8px;color:var(--report-text-muted)}blockquote{border-left:4px double var(--report-accent);font-style:italic}`,
};

/** 极简报告：白底黑字，只有内容。 */
export const MINIMAL_REPORT_TEMPLATE: ReportTemplateSpec = {
  id: "minimal",
  name: "极简",
  version: 1,
  theme: "daisy-light",
  sections: [
    { kind: "hero" },
    { kind: "summary" },
    { kind: "answers" },
  ],
  renderers: ["web", "pdf"],
  css: `.wrap{max-width:620px}.report-section{background:transparent;border:0;border-bottom:1px solid var(--report-border);border-radius:0;padding:18px 2px;margin-top:8px}.report-section h2{font-size:13px;letter-spacing:.18em;text-transform:uppercase;color:var(--report-text-muted)}.hero-title{font-size:30px}`,
};

/** 影集型：深色沉浸式大图叙事。 */
export const GALLERY_REPORT_TEMPLATE: ReportTemplateSpec = {
  id: "gallery",
  name: "影集",
  version: 1,
  theme: "daisy-black",
  sections: [
    { kind: "cover", presentation: "full" },
    { kind: "gallery", presentation: "featured" },
    { kind: "verdict" },
  ],
  renderers: ["web", "pdf"],
  css: `.report-cover{min-height:62vh;padding:40px 26px;background-size:cover;background-position:center;display:flex;flex-direction:column;justify-content:flex-end}.report-cover h1{font-size:38px;letter-spacing:.08em}.report-section{background:rgba(255,255,255,.04);border:1px solid var(--report-border);backdrop-filter:blur(8px)}.gallery{grid-template-columns:1fr}figure img{aspect-ratio:16/10}`,
};

export const REPORT_TEMPLATES: Record<string, ReportTemplateSpec> = {
  [DEFAULT_REPORT_TEMPLATE.id]: DEFAULT_REPORT_TEMPLATE,
  [MAGAZINE_DARK_TEMPLATE.id]: MAGAZINE_DARK_TEMPLATE,
  [DATA_REPORT_TEMPLATE.id]: DATA_REPORT_TEMPLATE,
  [IDENTITY_REPORT_TEMPLATE.id]: IDENTITY_REPORT_TEMPLATE,
  [MAGAZINE_REPORT_TEMPLATE.id]: MAGAZINE_REPORT_TEMPLATE,
  [MINIMAL_REPORT_TEMPLATE.id]: MINIMAL_REPORT_TEMPLATE,
  [GALLERY_REPORT_TEMPLATE.id]: GALLERY_REPORT_TEMPLATE,
};
