import type { ReportTheme } from "./themes";
import { reportThemeIds } from "./theme-ids";
import type { ReportLayout } from "./layouts";
import type { ReportCompositionBlockKind } from "./model";

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

export type ReportSectionPresentation = "cards" | "list" | "grid" | "featured" | "full";

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
  /** Real layout engine hint; when set, the composition renderer is used. */
  layout?: ReportLayout;
  /**
   * Ordered composition blocks for layout templates. When omitted the engine
   * auto-composes every available block in the layout's default order.
   */
  blocks?: ReportCompositionBlockKind[];
  /** Ordered sections rendered top to bottom. */
  sections: ReportTemplateSection[];
  renderers: ReportRendererId[];
  /** Optional extra CSS appended to the report shell. */
  css?: string;
}

export const REPORT_TEMPLATE_SCHEMA_VERSION = 1;

const compositionBlockKinds = new Set<ReportCompositionBlockKind>([
  "cover",
  "hero",
  "overview",
  "featured",
  "analysis",
  "quotes",
  "responses",
  "transcript",
  "gallery",
  "verdict",
]);

export function isReportTheme(value: unknown): value is ReportTheme {
  return typeof value === "string" && (reportThemeIds as readonly string[]).includes(value);
}

export function validateReportTemplateSpec(value: unknown): { template?: ReportTemplateSpec; error?: string } {
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
    if (typeof item.kind !== "string" || !sectionKinds.has(item.kind as ReportSectionKind)) {
      return { error: `不支持的 section.kind：${String(item.kind)}` };
    }
    sections.push({
      kind: item.kind as ReportSectionKind,
      ...(typeof item.title === "string" && item.title.trim() ? { title: item.title.trim() } : {}),
      ...(typeof item.presentation === "string" &&
      sectionPresentations.has(item.presentation as ReportSectionPresentation)
        ? { presentation: item.presentation as ReportSectionPresentation }
        : {}),
    });
  }
  const renderers: ReportRendererId[] = Array.isArray(raw.renderers)
    ? raw.renderers.filter((item): item is ReportRendererId => item === "web" || item === "pdf" || item === "image")
    : ["web", "pdf"];
  return {
    template: {
      id: String(raw.id).trim(),
      name: String(raw.name).trim(),
      version:
        typeof raw.version === "number" && Number.isInteger(raw.version) ? raw.version : REPORT_TEMPLATE_SCHEMA_VERSION,
      theme: raw.theme as ReportTheme,
      ...(typeof raw.layout === "string" && reportLayoutIds.has(raw.layout as ReportLayout)
        ? { layout: raw.layout as ReportLayout }
        : {}),
      ...(Array.isArray(raw.blocks) && raw.blocks.length > 0
        ? {
            blocks: raw.blocks.filter(
              (item): item is ReportCompositionBlockKind =>
                typeof item === "string" && compositionBlockKinds.has(item as ReportCompositionBlockKind),
            ),
          }
        : {}),
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

const sectionPresentations = new Set<ReportSectionPresentation>(["cards", "list", "grid", "featured", "full"]);

const reportLayoutIds = new Set<ReportLayout>(["editorial", "bento", "magazine", "data", "gallery", "profile"]);

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
  layout: "editorial",
  blocks: ["hero", "overview", "featured", "quotes", "transcript", "gallery", "verdict"],
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
  css: `[data-report-mode="light"].report-layout-editorial{--report-bg:#f8fafc;--report-surface:#ffffff;--report-border:#dbe3ec;--report-accent:#2563eb}[data-report-mode="dark"].report-layout-editorial{--report-bg:#111827;--report-surface:#172033;--report-border:#334155;--report-accent:#93c5fd}.report-layout-editorial .page{max-width:820px}.report-layout-editorial .hero{min-height:320px;padding:64px 0 52px;border-bottom:1px solid var(--report-border)}.report-layout-editorial .hero h1{font-size:48px;max-width:680px}.report-layout-editorial .report-section,.report-layout-editorial .responses-composition,.report-layout-editorial .gallery-composition{background:transparent;border:0;border-radius:0;box-shadow:none;padding:34px 0;border-top:1px solid var(--report-border)}.report-layout-editorial .report-section h2,.report-layout-editorial .chapter-heading h2{font-size:24px}.report-layout-editorial .score-card,.report-layout-editorial .compact-answer{background:transparent;border:0;border-top:1px solid var(--report-border);border-radius:0;padding:18px 0}.report-layout-editorial .gallery{grid-template-columns:repeat(2,1fr)}.report-layout-editorial .gallery-item img{border-radius:0;height:300px}@media(max-width:480px){.report-layout-editorial .hero h1{font-size:36px}.report-layout-editorial .gallery{grid-template-columns:1fr}}`,
};

/** 完整问答：以原始 Q&A 明细为主体的浅色报告。 */
export const TRANSCRIPT_REPORT_TEMPLATE: ReportTemplateSpec = {
  id: "transcript",
  name: "完整问答",
  version: 1,
  theme: "daisy-light",
  layout: "editorial",
  blocks: ["hero", "transcript", "gallery", "verdict"],
  sections: [{ kind: "hero" }, { kind: "answers" }, { kind: "gallery" }, { kind: "verdict" }],
  renderers: ["web", "pdf"],
  css: `[data-report-mode="light"].report-layout-editorial{--report-accent:#475569;--report-bg:#fbfbfc;--report-border:#e4e7ec}[data-report-mode="dark"].report-layout-editorial{--report-accent:#94a3b8;--report-bg:#0e1013;--report-border:#262b33}.report-layout-editorial .hero{min-height:0;padding:40px 0 44px}.report-layout-editorial .transcript-list{max-width:760px}.report-layout-editorial .transcript-item{padding:26px 0;border-top:1px solid var(--report-border)}.report-layout-editorial .transcript-item:first-of-type{border-top:0}.report-layout-editorial .transcript-item .question{font-size:16px;font-weight:650;color:var(--report-text)}.report-layout-editorial .transcript-item .answer{margin-top:8px;font-size:15px;color:var(--report-text);white-space:pre-wrap}.report-layout-editorial .answer-options{margin-top:10px;display:grid;gap:6px}.report-layout-editorial .answer-option{display:flex;align-items:center;gap:8px;font-size:14px;color:var(--report-text-muted)}.report-layout-editorial .answer-option.selected{color:var(--report-accent);font-weight:600}`,
};

export const MAGAZINE_DARK_TEMPLATE: ReportTemplateSpec = {
  id: "magazine-dark",
  name: "杂志暗色",
  version: 1,
  theme: "dracula",
  layout: "bento",
  blocks: ["hero", "overview", "featured", "quotes", "responses", "gallery", "verdict"],
  sections: [
    { kind: "hero" },
    { kind: "summary" },
    { kind: "scores", presentation: "grid" },
    { kind: "insights" },
    { kind: "quotes" },
    { kind: "gallery" },
  ],
  renderers: ["web", "pdf"],
  css: `.report-layout-bento .hero{border-top:0}.report-layout-bento .hero h1{letter-spacing:.01em}.report-layout-bento .bento-primary{background:var(--report-surface);border:1px solid var(--report-border);border-radius:20px}.report-layout-bento .bento-primary strong{color:var(--report-accent)}.report-layout-bento .bento-primary h3,.report-layout-bento .bento-primary>span{color:var(--report-text-muted)}.report-layout-bento .bento-tile,.report-layout-bento .metric{background:var(--report-surface);border:1px solid var(--report-border);border-radius:16px;box-shadow:none}.report-layout-bento .featured-insight{background:transparent;border-top:1px solid var(--report-border);border-bottom:1px solid var(--report-border);border-radius:0;margin:48px auto 8px;padding:56px 24px}.report-layout-bento .featured-insight blockquote{font-size:34px;color:var(--report-accent)}.report-layout-bento .editorial-answer{border-top:1px solid var(--report-border);padding:26px 0}.report-layout-bento .gallery-item img{border-radius:14px;height:420px}.report-layout-bento .final-verdict h2{font-size:52px}@media (min-width:961px){.report-layout-bento .hero{min-height:360px;padding:52px 0;grid-template-columns:minmax(0,1fr) 220px;gap:40px}.report-layout-bento .hero h1{font-size:56px}.report-layout-bento .hero-score strong{font-size:92px}.report-layout-bento .responses-composition .editorial-answer-grid{grid-template-columns:1fr 1fr;gap:40px}}`,
};

/** 数据分析型：浅色数据看板，量化指标优先。 */
export const DATA_REPORT_TEMPLATE: ReportTemplateSpec = {
  id: "data",
  name: "数据分析",
  version: 1,
  theme: "daisy-light",
  layout: "data",
  blocks: ["hero", "overview", "analysis", "verdict"],
  sections: [
    { kind: "hero" },
    { kind: "summary", presentation: "featured" },
    { kind: "insights" },
    { kind: "verdict" },
  ],
  renderers: ["web", "pdf"],
  css: `.report-layout-data .hero{border-top:0}.report-layout-data .metric{border-radius:14px;padding:16px}.report-layout-data .metric strong{font-size:30px;color:var(--report-accent)}.report-layout-data .bar-row{font-size:14px}.report-layout-data .editorial-section{padding:36px 0}.report-layout-data .editorial-index{font-size:30px}.report-layout-data .final-verdict{margin-top:48px;padding:72px 0;border-top:3px solid var(--report-accent)}.report-layout-data .final-verdict h2{font-size:48px}@media (min-width:961px){.report-layout-data .hero{min-height:300px;grid-template-columns:minmax(0,1fr) 260px;padding:44px 0}.report-layout-data .hero-score{border-left:2px solid var(--report-accent);padding-left:30px}.report-layout-data .hero-score strong{font-size:84px}.report-layout-data .bento-overview{grid-auto-rows:auto}.report-layout-data .bento-primary{grid-column:span 4;grid-row:span 2;border-radius:20px;background:linear-gradient(135deg,var(--report-accent),color-mix(in srgb,var(--report-accent) 55%,#1e3a8a))}.report-layout-data .bento-primary strong{font-size:70px}.report-layout-data .bento-metrics{grid-column:span 8;grid-template-columns:repeat(4,1fr);gap:14px}.report-layout-data .bento-radar{grid-column:span 5}.report-layout-data .bento-bars{grid-column:span 7}.report-layout-data .bar-row{grid-template-columns:150px 1fr 46px}.report-layout-data .editorial-chapter{padding:40px 0}.report-layout-data .editorial-section{grid-template-columns:72px minmax(0,1fr)}}`,
};

/** 身份档案型：黑金档案袋风格，适合人物/身份类问卷。 */
export const IDENTITY_REPORT_TEMPLATE: ReportTemplateSpec = {
  id: "identity",
  name: "身份档案",
  version: 1,
  theme: "daisy-luxury",
  layout: "profile",
  blocks: ["cover", "overview", "responses", "verdict"],
  sections: [
    { kind: "cover" },
    { kind: "scores", presentation: "grid" },
    { kind: "answers", presentation: "list" },
    { kind: "verdict" },
  ],
  renderers: ["web", "pdf"],
  css: `.report-layout-profile .hero{border-top:2px solid var(--report-accent);border-bottom:2px solid var(--report-accent)}.report-layout-profile .hero h1{font-family:Georgia,"Noto Serif CJK SC",serif;letter-spacing:.04em;font-size:34px}.report-layout-profile .hero-avatar{border-radius:8px;border:2px solid var(--report-accent);box-shadow:0 0 0 5px color-mix(in srgb,var(--report-accent) 12%,transparent)}.report-layout-profile .bento-metrics{grid-template-columns:repeat(2,1fr);gap:12px}.report-layout-profile .metric{border-left:4px solid var(--report-accent);border-radius:0 12px 12px 0;padding:14px 18px}.report-layout-profile .metric strong{font-family:Georgia,"Noto Serif CJK SC",serif;font-size:32px}.report-layout-profile .responses-composition .compact-answer-grid{grid-template-columns:repeat(2,1fr);gap:16px}.report-layout-profile .compact-answer{border-left:4px solid var(--report-accent);border-radius:0 14px 14px 0;padding:20px 22px}.report-layout-profile .final-verdict{position:relative;border-top:3px double var(--report-accent)}.report-layout-profile .final-verdict::after{content:"ARCHIVE";position:absolute;right:16px;top:-22px;font-size:13px;letter-spacing:.3em;color:var(--report-accent);border:2px solid var(--report-accent);padding:6px 14px;transform:rotate(-4deg);background:var(--report-bg)}@media (min-width:961px){.report-layout-profile .hero{min-height:auto;grid-template-columns:180px minmax(0,1fr) 220px;align-items:center;gap:34px;padding:44px 0}.report-layout-profile .hero-avatar{position:static;width:150px;height:150px}.report-layout-profile .hero h1{font-size:38px}.report-layout-profile .hero-score{border-left:2px solid var(--report-accent);padding-left:26px}}`,
};

/** 艺术档案型：纸张档案、重点指标与图片叙事，适配通用问卷结果。 */
export const ART_ARCHIVE_REPORT_TEMPLATE: ReportTemplateSpec = {
  id: "art-archive",
  name: "艺术档案",
  version: 1,
  theme: "daisy-retro",
  layout: "profile",
  blocks: ["cover", "overview", "featured", "responses", "gallery", "verdict"],
  sections: [
    { kind: "cover", presentation: "full" },
    { kind: "hero", presentation: "featured" },
    { kind: "scores", presentation: "grid" },
    { kind: "answers", presentation: "list" },
    { kind: "gallery", presentation: "grid" },
    { kind: "verdict", presentation: "featured" },
  ],
  renderers: ["web", "pdf", "image"],
  css: `[data-report-mode="light"].report-layout-profile{--report-bg:#f3eee2;--report-surface:#fbf8f0;--report-border:#c9bea9;--report-accent:#263b35;--report-text:#29251f;--report-text-muted:#746b5f;background-image:linear-gradient(90deg,rgba(38,59,53,.035) 1px,transparent 1px),linear-gradient(rgba(38,59,53,.035) 1px,transparent 1px);background-size:28px 28px}[data-report-mode="dark"].report-layout-profile{--report-bg:#18221f;--report-surface:#202d28;--report-border:#496359;--report-accent:#d4b878;--report-text:#f2eadb;--report-text-muted:#b8b0a2}.report-layout-profile .page{max-width:1080px;padding:28px 42px 88px}.report-layout-profile .composition-region{margin-top:42px}.report-layout-profile .report-cover{min-height:430px;border:0;border-top:8px solid var(--report-accent);border-bottom:1px solid var(--report-accent);border-radius:0;background-color:var(--report-surface);box-shadow:12px 12px 0 color-mix(in srgb,var(--report-accent) 14%,transparent);background-position:center}.report-layout-profile .report-cover::before{content:"PERSONAL ARCHIVE / FIELD RECORD";position:absolute;top:22px;left:28px;font-size:10px;letter-spacing:.2em;color:var(--report-accent);font-weight:700}.report-layout-profile .report-cover h1,.report-layout-profile .hero h1,.report-layout-profile .final-verdict h2{font-family:Georgia,"Noto Serif CJK SC",serif}.report-layout-profile .report-cover h1{font-size:72px;letter-spacing:.02em;text-transform:none}.report-layout-profile .report-cover .cover-subtitle{max-width:560px;font-size:18px}.report-layout-profile .bento-overview{display:grid;grid-template-columns:2fr 1fr;gap:0;border-top:1px solid var(--report-accent);border-bottom:1px solid var(--report-accent);background:var(--report-surface)}.report-layout-profile .bento-tile{border:0;border-radius:0;box-shadow:none;background:transparent;padding:30px}.report-layout-profile .bento-primary{border-right:1px solid var(--report-border)}.report-layout-profile .bento-primary strong{font-family:Georgia,"Noto Serif CJK SC",serif;font-size:78px}.report-layout-profile .bento-tags{align-content:center}.report-layout-profile .metric{border:0;border-top:1px solid var(--report-border);border-radius:0;background:transparent;padding:16px 0}.report-layout-profile .metric:first-child{border-top:0}.report-layout-profile .responses-composition,.report-layout-profile .gallery-composition{border-top:1px solid var(--report-accent);padding:28px 0 0}.report-layout-profile .chapter-heading{margin-bottom:22px;border-bottom:1px solid var(--report-border);padding-bottom:14px}.report-layout-profile .compact-answer-grid{grid-template-columns:repeat(2,1fr);gap:0 34px;margin-top:0}.report-layout-profile .compact-answer{border:0;border-bottom:1px solid var(--report-border);border-radius:0;background:transparent;padding:22px 0;min-height:126px}.report-layout-profile .compact-answer .response-index{font-size:10px;letter-spacing:.16em}.report-layout-profile .compact-answer .question{font-family:Georgia,"Noto Serif CJK SC",serif;font-size:18px;color:var(--report-text)}.report-layout-profile .compact-answer .answer{font-size:14px;color:var(--report-text-muted)}.report-layout-profile .gallery{grid-template-columns:repeat(12,1fr);gap:12px}.report-layout-profile .gallery-item{grid-column:span 4}.report-layout-profile .gallery-item:nth-child(1){grid-column:span 8;grid-row:span 2}.report-layout-profile .gallery-item img,.report-layout-profile .gallery-item:first-child img{height:260px;border-radius:0;filter:sepia(.12) saturate(.88)}.report-layout-profile .gallery-item:first-child img{height:532px}.report-layout-profile .final-verdict{margin-top:18px;padding:74px 0 46px;border-top:8px double var(--report-accent);min-height:0}.report-layout-profile .final-verdict::after{content:"ARCHIVE COPY";position:absolute;right:18px;top:28px;border:1px solid var(--report-accent);padding:7px 12px;font-size:10px;letter-spacing:.16em;transform:rotate(-3deg);color:var(--report-accent)}.report-layout-profile .final-verdict h2{font-size:52px;max-width:760px}.report-layout-profile .verdict-pillars{border-top:1px solid var(--report-border);padding-top:24px}.report-layout-profile .verdict-pillar{border-top:0;border-left:1px solid var(--report-border);padding:0 0 0 18px}.report-layout-profile .report-watermark{font-family:monospace;letter-spacing:.08em}@media(max-width:960px){.report-layout-profile .page{padding:20px 18px 64px}.report-layout-profile .report-cover{min-height:360px}.report-layout-profile .report-cover h1{font-size:48px}.report-layout-profile .bento-overview{grid-template-columns:1fr}.report-layout-profile .bento-primary{border-right:0;border-bottom:1px solid var(--report-border)}.report-layout-profile .compact-answer-grid{grid-template-columns:1fr}.report-layout-profile .gallery{grid-template-columns:1fr 1fr}.report-layout-profile .gallery-item,.report-layout-profile .gallery-item:nth-child(1){grid-column:span 1;grid-row:auto}.report-layout-profile .gallery-item:first-child,.report-layout-profile .gallery-item:first-child img{height:300px}}`,
};

/** 杂志亮色：复古纸张编辑风。 */
export const MAGAZINE_REPORT_TEMPLATE: ReportTemplateSpec = {
  id: "magazine",
  name: "杂志",
  version: 1,
  theme: "daisy-retro",
  layout: "magazine",
  blocks: ["cover", "featured", "gallery", "analysis", "verdict"],
  sections: [{ kind: "cover" }, { kind: "quotes" }, { kind: "gallery" }, { kind: "insights" }, { kind: "verdict" }],
  renderers: ["web", "pdf"],
  css: `.report-layout-magazine .hero{border-top:0;border-bottom:4px double var(--report-accent)}.report-layout-magazine .hero h1{font-family:Georgia,"Noto Serif CJK SC",serif;letter-spacing:.01em;line-height:1.05;text-transform:uppercase}.report-layout-magazine .hero-thesis{font-style:italic}.report-layout-magazine .featured-insight{margin:56px auto 20px;padding:64px 48px;border-top:4px double var(--report-accent);border-bottom:4px double var(--report-accent)}.report-layout-magazine .featured-insight blockquote{font-family:Georgia,"Noto Serif CJK SC",serif;font-size:32px;line-height:1.4}.report-layout-magazine .gallery-composition{padding:56px 0}.report-layout-magazine .gallery-item img{border-radius:0;height:420px}.report-layout-magazine .editorial-section{padding:48px 0;border-top:1px solid var(--report-border)}.report-layout-magazine .editorial-index{font-family:Georgia,"Noto Serif CJK SC",serif;font-size:44px}.report-layout-magazine .editorial-copy h3{font-family:Georgia,"Noto Serif CJK SC",serif;font-size:28px}.report-layout-magazine .editorial-copy p{line-height:1.9}.report-layout-magazine .final-verdict{min-height:480px;padding:80px 0;border-top:2px solid var(--report-accent)}.report-layout-magazine .final-verdict h2{font-family:Georgia,"Noto Serif CJK SC",serif;font-size:44px}@media (min-width:961px){.report-layout-magazine .hero{min-height:420px;grid-template-columns:minmax(0,1fr) 260px;padding:64px 0}.report-layout-magazine .hero h1{font-size:60px}.report-layout-magazine .hero-thesis{font-size:22px}.report-layout-magazine .featured-insight blockquote{font-size:38px}.report-layout-magazine .gallery{grid-template-columns:1.4fr 1fr}.report-layout-magazine .gallery-item img{height:480px}.report-layout-magazine .editorial-section{grid-template-columns:110px minmax(0,1fr)}.report-layout-magazine .editorial-index{font-size:52px}.report-layout-magazine .editorial-copy h3{font-size:32px}.report-layout-magazine .editorial-copy p{font-size:17px}.report-layout-magazine .final-verdict h2{font-size:54px}}`,
};

/** 极简报告：白底黑字，只有内容。 */
export const MINIMAL_REPORT_TEMPLATE: ReportTemplateSpec = {
  id: "minimal",
  name: "极简",
  version: 1,
  theme: "daisy-light",
  sections: [{ kind: "hero" }, { kind: "summary" }, { kind: "answers" }],
  renderers: ["web", "pdf"],
  css: `.wrap{max-width:620px}.report-section{background:transparent;border:0;border-bottom:1px solid var(--report-border);border-radius:0;padding:18px 2px;margin-top:8px}.report-section h2{font-size:13px;letter-spacing:.18em;text-transform:uppercase;color:var(--report-text-muted)}.hero-title{font-size:30px}`,
};

/** 影集型：深色沉浸式大图叙事。 */
export const GALLERY_REPORT_TEMPLATE: ReportTemplateSpec = {
  id: "gallery",
  name: "影集",
  version: 1,
  theme: "daisy-black",
  layout: "gallery",
  blocks: ["cover", "gallery", "featured", "analysis", "responses", "verdict"],
  sections: [
    { kind: "cover" },
    { kind: "gallery" },
    { kind: "quotes" },
    { kind: "insights" },
    { kind: "answers" },
    { kind: "verdict" },
  ],
  renderers: ["web", "pdf"],
  css: `.report-layout-gallery .hero{border-top:0;border-bottom:1px solid var(--report-border)}.report-layout-gallery .hero h1{font-size:38px;letter-spacing:.06em}.report-layout-gallery .gallery-composition{padding:56px 0}.report-layout-gallery .gallery{grid-template-columns:1fr;gap:40px}.report-layout-gallery .gallery-item img{height:460px;border-radius:4px}.report-layout-gallery .gallery-item figcaption{font-size:14px;letter-spacing:.04em;padding-top:12px;text-align:center}.report-layout-gallery .final-verdict{margin-top:56px;padding:80px 0;min-height:420px;border-top:1px solid var(--report-border)}.report-layout-gallery .final-verdict h2{font-size:40px}.report-layout-gallery .closing-statement{font-style:italic;font-size:20px}@media (min-width:961px){.report-layout-gallery .hero{min-height:300px;padding:48px 0}.report-layout-gallery .hero h1{font-size:44px}.report-layout-gallery .gallery-item img{height:720px}.report-layout-gallery .final-verdict{padding:96px 0;min-height:480px}.report-layout-gallery .final-verdict h2{font-size:44px}}`,
};

export const REPORT_TEMPLATES: Record<string, ReportTemplateSpec> = {
  [DEFAULT_REPORT_TEMPLATE.id]: DEFAULT_REPORT_TEMPLATE,
  [TRANSCRIPT_REPORT_TEMPLATE.id]: TRANSCRIPT_REPORT_TEMPLATE,
  [MAGAZINE_DARK_TEMPLATE.id]: MAGAZINE_DARK_TEMPLATE,
  [DATA_REPORT_TEMPLATE.id]: DATA_REPORT_TEMPLATE,
  [IDENTITY_REPORT_TEMPLATE.id]: IDENTITY_REPORT_TEMPLATE,
  [ART_ARCHIVE_REPORT_TEMPLATE.id]: ART_ARCHIVE_REPORT_TEMPLATE,
  [MAGAZINE_REPORT_TEMPLATE.id]: MAGAZINE_REPORT_TEMPLATE,
  [MINIMAL_REPORT_TEMPLATE.id]: MINIMAL_REPORT_TEMPLATE,
  [GALLERY_REPORT_TEMPLATE.id]: GALLERY_REPORT_TEMPLATE,
};
