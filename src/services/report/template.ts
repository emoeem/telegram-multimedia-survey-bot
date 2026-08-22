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

export const REPORT_TEMPLATES: Record<string, ReportTemplateSpec> = {
  [DEFAULT_REPORT_TEMPLATE.id]: DEFAULT_REPORT_TEMPLATE,
  [MAGAZINE_DARK_TEMPLATE.id]: MAGAZINE_DARK_TEMPLATE,
};
