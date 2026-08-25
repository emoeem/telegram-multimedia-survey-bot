import type { ReportViewModel } from "./model";
import { buildResponsiveCompositionReport } from "../html-report-renderer.service";
import { renderRadarSvg } from "./blocks/radar";
import type { ChartColors } from "./charts";
import { reportThemes, themeCss } from "./themes";
import {
  DEFAULT_REPORT_TEMPLATE,
  type ReportSectionKind,
  type ReportTemplateSection,
  type ReportTemplateSpec,
} from "./template";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function text(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join("、");
  if (typeof value === "object") return "";
  return String(value);
}

function sectionTitle(kind: ReportSectionKind, section: ReportTemplateSection): string {
  if (section.title) return section.title;
  const labels: Partial<Record<ReportSectionKind, string>> = {
    summary: "总结",
    scores: "得分概览",
    radar: "维度画像",
    insights: "分析解读",
    quotes: "摘录",
    answers: "回答明细",
    gallery: "图片",
    verdict: "结论",
  };
  return labels[kind] ?? "";
}

function renderHero(view: ReportViewModel, section: ReportTemplateSection): string {
  const avatar = view.hero.avatar
    ? `<img class="avatar" src="${escapeHtml(view.hero.avatar)}" alt="" loading="lazy" onerror="this.remove()" />`
    : "";
  const tags = view.hero.tags.length
    ? `<div class="tags">${view.hero.tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}</div>`
    : "";
  if (section.presentation === "featured") {
    return `<header class="hero profile-hero">
      ${avatar}
      <div class="profile-meta">
        <h1 class="hero-title">${escapeHtml(view.hero.title)}</h1>
        ${view.hero.subtitle ? `<p class="hero-sub">${escapeHtml(view.hero.subtitle)}</p>` : ""}
        ${tags}
      </div>
    </header>`;
  }
  return `<header class="hero">
    ${avatar}
    <h1 class="hero-title">${escapeHtml(view.hero.title)}</h1>
    ${view.hero.subtitle ? `<p class="hero-sub">${escapeHtml(view.hero.subtitle)}</p>` : ""}
    ${tags}
  </header>`;
}

function renderCover(view: ReportViewModel): string {
  const background = view.hero.coverImage
    ? ` style="background-image:linear-gradient(180deg,#0000 0%,#000a 100%),url('${escapeHtml(view.hero.coverImage)}')"`
    : "";
  const tags = view.tags.length
    ? `<div class="tags">${view.tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}</div>`
    : "";
  return `<section class="report-cover"${background}>
    <h1>${escapeHtml(view.hero.title)}</h1>
    ${view.hero.subtitle ? `<p class="cover-sub">${escapeHtml(view.hero.subtitle)}</p>` : ""}
    ${tags}
  </section>`;
}

function renderSummary(view: ReportViewModel): string {
  if (!view.summary.trim()) return "";
  return `<section class="report-section summary"><h2>总结</h2><p>${escapeHtml(view.summary)}</p></section>`;
}

function renderScores(view: ReportViewModel, section: ReportTemplateSection): string {
  if (!view.scores.length) return "";
  if (section.presentation === "grid") {
    return `<div class="score-rings">
      ${view.scores.map((score) => `
        <article class="ring-card">
          <div class="ring" style="--pct:${Math.max(0, Math.min(100, score.percentage))}">
            <span class="ring-inner"><strong>${score.value}<small>/ ${score.max}</small></strong></span>
          </div>
          <span class="ring-label">${escapeHtml(score.label)}</span>
          <p>${escapeHtml(text(score.description))}</p>
        </article>`).join("")}
    </div>`;
  }
  return `<section class="report-section"><h2>得分概览</h2>
    <div class="score-grid">
      ${view.scores.map((score) => `
        <article class="score-card">
          <div class="score-head"><span>${escapeHtml(score.label)}</span><strong>${score.value}<small>/ ${score.max}</small></strong></div>
          <div class="bar"><span style="width:${Math.max(0, Math.min(100, score.percentage))}%"></span></div>
          <p>${escapeHtml(text(score.description))}</p>
        </article>`).join("")}
    </div>
  </section>`;
}

function renderRadar(view: ReportViewModel, colors: ChartColors): string {
  if (view.charts.radar.length < 3) return "";
  return `<section class="report-section"><h2>维度画像</h2>
    ${renderRadarSvg(view.charts.radar, colors)}
  </section>`;
}

function renderInsights(view: ReportViewModel): string {
  if (!view.insights.length && !view.quotes.length) return "";
  const items = view.insights.map((item) => `
    <article class="insight">
      <h3>${escapeHtml(item.title)}</h3>
      ${item.tags?.length ? `<div class="tags">${item.tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}</div>` : ""}
      <p>${escapeHtml(item.text)}</p>
    </article>`).join("");
  const quotes = view.quotes.map((item) => `
    <blockquote><p>${escapeHtml(item.text)}</p><footer>${escapeHtml(item.title)}</footer></blockquote>`).join("");
  return `<section class="report-section"><h2>分析解读</h2>${items}${quotes}</section>`;
}

function renderAnswers(view: ReportViewModel, section: ReportTemplateSection): string {
  if (!view.profile.length) return "";
  const renderValue = (item: ReportViewModel["profile"][number]): string => {
    if (item.options?.length) {
      const options = item.options
        .map(
          (option) =>
            `<div class="answer-option${option.selected ? " selected" : ""}">` +
            `<span class="option-mark">${option.selected ? "✓" : "○"}</span>` +
            `<span>${escapeHtml(option.label)}</span></div>`,
        )
        .join("");
      return `<div class="answer-options">${options}</div>${
        item.value ? `<div class="answer">${escapeHtml(item.value)}</div>` : ""
      }`;
    }
    return `<span>${escapeHtml(item.value)}</span>`;
  };
  if (section.presentation === "list") {
    return `<ul class="checklist">
      ${view.profile.map((item) => `
        <li><strong>${escapeHtml(item.label)}</strong>${renderValue(item)}</li>`).join("")}
    </ul>`;
  }
  return `<section class="report-section"><h2>回答明细</h2>
    <dl class="answer-list">
      ${view.profile.map((item) => `
        <div class="answer-item"><dt>${escapeHtml(item.label)}</dt><dd>${renderValue(item)}</dd></div>`).join("")}
    </dl>
  </section>`;
}

function renderGallery(view: ReportViewModel): string {
  const items = view.gallery.filter((item) => item.url !== view.hero.avatar);
  if (!items.length) return "";
  return `<section class="report-section"><h2>图片</h2>
    <div class="gallery">
      ${items.map((item) => `
        <figure>
          <img src="${escapeHtml(item.url)}" alt="${escapeHtml(item.caption ?? item.questionTitle ?? "图片")}" loading="lazy" onerror="this.closest('figure')?.classList.add('missing')" />
          ${item.caption ? `<figcaption>${escapeHtml(item.caption)}</figcaption>` : ""}
        </figure>`).join("")}
    </div>
  </section>`;
}

function renderVerdict(view: ReportViewModel): string {
  if (!view.summary.trim()) return "";
  return `<section class="report-section verdict"><h2>结论</h2><p>${escapeHtml(view.summary)}</p></section>`;
}

/** Renders one template section; empty sections render as empty strings. */
export function renderReportSection(
  kind: ReportSectionKind,
  view: ReportViewModel,
  section: ReportTemplateSection,
  colors: ChartColors,
): string {
  switch (kind) {
    case "cover": return renderCover(view);
    case "hero": return renderHero(view, section);
    case "summary": return wrapSection("summary", sectionTitle("summary", section), renderSummary(view));
    case "scores": return wrapSection("scores", sectionTitle("scores", section), renderScores(view, section));
    case "radar": return wrapSection("radar", sectionTitle("radar", section), renderRadar(view, colors));
    case "insights": return wrapSection("insights", sectionTitle("insights", section), renderInsights(view));
    case "quotes": return wrapSection("quotes", sectionTitle("quotes", section), renderInsights(view));
    case "answers": return wrapSection("answers", sectionTitle("answers", section), renderAnswers(view, section));
    case "gallery": return wrapSection("gallery", sectionTitle("gallery", section), renderGallery(view));
    case "divider": return `<hr class="report-divider" />`;
    case "verdict": return wrapSection("verdict", sectionTitle("verdict", section), renderVerdict(view));
  }
}

function wrapSection(kind: string, title: string, body: string): string {
  if (!body) return "";
  return `<section class="report-section section-${kind}"><h2>${escapeHtml(title)}</h2>${body}</section>`;
}

export interface ResponsiveReportMeta {
  surveyTitle?: string;
  completedAt?: string;
  reportId?: string;
  /** Footer watermark text; defaults to the platform promotion line. */
  watermark?: string;
}

function baseCss(): string {
  return `*{box-sizing:border-box;print-color-adjust:exact;-webkit-print-color-adjust:exact}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.65 -apple-system,"PingFang SC","Noto Sans CJK SC","Microsoft YaHei",sans-serif}
.wrap{max-width:760px;margin:0 auto;padding:0 20px 56px}
header.hero{padding:44px 0 26px;display:grid;gap:16px;border-bottom:1px solid var(--border)}
.hero-title{margin:0;font-size:32px;line-height:1.22;letter-spacing:-.02em}
.hero-sub{margin:0;color:var(--muted);white-space:pre-wrap}
.avatar{width:100px;height:100px;border-radius:50%;object-fit:cover;border:3px solid var(--accent);box-shadow:0 10px 28px -14px var(--accent)}
.tags{display:flex;flex-wrap:wrap;gap:8px}
.tags span{padding:4px 12px;border-radius:999px;background:var(--accent-soft);color:var(--accent);font-size:12px;font-weight:500;border:1px solid color-mix(in srgb,var(--accent) 20%,transparent)}
.anchor-nav{display:flex;gap:8px;font-size:13px;margin-top:16px}
.anchor-nav a{color:var(--accent);text-decoration:none;border:1px solid var(--border);border-radius:999px;padding:5px 14px;background:var(--surface)}
.report-section{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:22px;margin-top:16px;box-shadow:0 1px 2px rgba(15,23,42,.04),0 18px 44px -28px rgba(15,23,42,.35)}
.report-section h2{margin:0 0 14px;font-size:15px;display:flex;align-items:center;gap:9px;letter-spacing:.01em}
.report-section h2::before{content:"";width:4px;height:16px;border-radius:3px;background:var(--accent);flex:none}
.report-cover{min-height:46vh;border-radius:20px;margin-top:16px;padding:38px 28px;background-color:var(--surface-elevated);background-size:cover;background-position:center;display:flex;flex-direction:column;justify-content:flex-end;box-shadow:0 1px 2px rgba(15,23,42,.05),0 26px 60px -30px rgba(2,6,23,.5);overflow:hidden;position:relative}
.report-cover h1{margin:0;font-size:34px;line-height:1.2;letter-spacing:-.02em}
.report-cover .cover-sub{margin:10px 0 0;color:var(--muted);white-space:pre-wrap;font-size:14px}
.report-cover .tags{margin-top:16px}
.score-grid{display:grid;gap:12px}
.score-card{border:1px solid var(--border);border-radius:14px;padding:14px 16px;background:color-mix(in srgb,var(--surface) 82%,transparent)}
.score-head{display:flex;justify-content:space-between;align-items:baseline;gap:10px}
.score-head>span{font-weight:600;font-size:14px}
.score-head strong{font-size:22px;color:var(--accent)}
.score-head small{color:var(--muted);font-size:12px}
.score-card p{margin:8px 0 0;color:var(--muted);font-size:13px;line-height:1.55}
.bar{height:8px;margin-top:10px;border-radius:999px;background:var(--border);overflow:hidden}
.bar span{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,var(--accent),color-mix(in srgb,var(--accent) 50%,#22d3ee))}
.score-rings{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:16px;justify-items:center}
.ring-card{display:grid;justify-items:center;gap:7px;text-align:center;padding:16px 10px;border:1px solid var(--border);border-radius:16px;background:color-mix(in srgb,var(--surface) 72%,transparent)}
.ring{width:118px;height:118px;border-radius:50%;display:grid;place-items:center;background:conic-gradient(var(--accent) calc(var(--pct)*1%),var(--border) 0)}
.ring-inner{width:90px;height:90px;border-radius:50%;background:var(--bg);display:grid;place-items:center;box-shadow:inset 0 1px 3px rgba(15,23,42,.08)}
.ring-inner strong{font-size:22px;color:var(--accent)}
.ring-inner small{color:var(--muted);font-size:11px;font-weight:400}
.ring-label{font-size:13px;font-weight:600;color:var(--muted)}
.ring-card p{margin:0;color:var(--muted);font-size:12px;line-height:1.5}
.checklist{list-style:none;margin:0;padding:0}
.checklist li{display:grid;grid-template-columns:minmax(110px,34%) 1fr;gap:14px;padding:12px 0;border-top:1px solid var(--border);align-items:baseline}
.checklist li:first-child{border-top:0;padding-top:0}
.checklist strong{color:var(--muted);font-size:13px;font-weight:600}
.checklist span{white-space:pre-wrap;overflow-wrap:anywhere;font-weight:500}
.profile-hero{grid-template-columns:auto 1fr;align-items:center;gap:20px}
.profile-hero .avatar{width:88px;height:88px}
.profile-meta{min-width:0}
.report-divider{border:0;border-top:1px dashed var(--border);margin:28px 0}
.radar{width:100%;max-width:340px;margin:6px auto 0;display:block;color:var(--muted)}
.insight{border-top:1px solid var(--border);padding:14px 0}
.insight:first-of-type{border-top:0;padding-top:0}
.insight h3{margin:0 0 8px;font-size:15px}
.insight p{margin:8px 0 0;white-space:pre-wrap;color:var(--muted);line-height:1.65}
blockquote{margin:12px 0 0;padding:14px 18px;border-left:3px solid var(--accent);background:var(--accent-soft);border-radius:0 14px 14px 0}
blockquote p{margin:0;white-space:pre-wrap}
blockquote footer{margin-top:8px;color:var(--muted);font-size:12px}
.answer-list{margin:0}
.answer-item{display:grid;grid-template-columns:minmax(100px,34%) 1fr;gap:14px;padding:12px 0;border-top:1px solid var(--border)}
.answer-item:first-child{border-top:0;padding-top:0}
dt{color:var(--muted);font-size:13px;font-weight:600}
dd{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}
figure{margin:0}
figure img{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:14px;background:var(--border);box-shadow:0 1px 3px rgba(15,23,42,.08)}
figure.missing::after{content:"图片已归档";display:block;padding:28px 0;text-align:center;color:var(--muted);font-size:12px;background:var(--accent-soft);border-radius:14px}
figure.missing img{display:none}
figcaption{margin-top:6px;color:var(--muted);font-size:12px;overflow-wrap:anywhere}
.summary p{margin:0;white-space:pre-wrap;font-size:15px;line-height:1.75}
footer.meta{margin-top:36px;padding-top:20px;border-top:1px dashed var(--border);color:var(--muted);font-size:12px;text-align:center;letter-spacing:.03em}
.report-watermark{margin-top:22px;padding-top:16px;border-top:1px dashed var(--border);color:var(--muted);font-size:12px;text-align:center;letter-spacing:.02em;opacity:.9}
@media (max-width:639px){.answer-item,.checklist li{grid-template-columns:1fr;gap:3px;padding:11px 0}.answer-item dt,.checklist strong{margin-bottom:3px}.profile-hero{grid-template-columns:1fr;justify-items:start;gap:10px}.profile-hero .avatar{width:76px;height:76px}.hero-title{font-size:28px}.report-cover{min-height:38vh;padding:32px 22px}}
@media (min-width:640px){.gallery{grid-template-columns:repeat(auto-fill,minmax(180px,1fr))}.score-grid{grid-template-columns:repeat(2,1fr)}.score-rings{grid-template-columns:repeat(2,1fr)}.wrap{padding:0 28px 64px}}
@media (min-width:960px){.wrap{display:grid;grid-template-columns:repeat(12,1fr);gap:20px;max-width:1120px;padding:0 32px 64px}header.hero,.report-cover,.section-gallery,.report-divider{grid-column:1/-1}.report-section{margin-top:0}.section-summary{grid-column:span 5}.section-scores{grid-column:span 7}.section-radar{grid-column:span 6}.section-insights{grid-column:span 6}.section-quotes{grid-column:span 6}.section-answers{grid-column:span 6}.section-verdict{grid-column:span 12}.gallery{grid-template-columns:repeat(3,1fr)}.profile-hero .avatar{width:108px;height:108px}.hero-title{font-size:40px}header.hero{padding:52px 0 30px}.report-cover{min-height:50vh}}
@media print{:root{--bg:#fff;--surface:#fff;--border:#dde3ea;--accent-soft:#f1f4f9}body{background:#fff}.wrap{display:block;max-width:none;padding:0}.anchor-nav{display:none}.report-cover,header.hero,.report-section,.report-divider{grid-column:auto}.report-section{break-inside:avoid;margin-top:14px;box-shadow:none}.score-card,.ring-card,figure,blockquote{break-inside:avoid}.gallery{grid-template-columns:repeat(2,1fr)}.gallery figure img{aspect-ratio:auto;height:220px;object-fit:contain;background:#f4f6f9}header.hero{padding:12px 0 16px}.hero-title{font-size:24px}.report-cover{min-height:28vh;page-break-inside:avoid}}`;
}

function themeAliasCss(): string {
  return `:root{--bg:var(--report-bg);--bg-secondary:var(--report-bg-secondary);--surface:var(--report-surface);--surface-elevated:var(--report-surface-elevated);--text:var(--report-text);--muted:var(--report-text-muted);--border:var(--report-border);--accent:var(--report-accent);--accent-soft:var(--report-surface-elevated);--radius:18px}`;
}

export function buildResponsiveReportHtml(
  view: ReportViewModel,
  meta: ResponsiveReportMeta = {},
  template: ReportTemplateSpec = DEFAULT_REPORT_TEMPLATE,
): string {
  const title = view.hero.title || meta.surveyTitle || "问卷结果报告";
  const theme = reportThemes[template.theme] ?? reportThemes["tokyo-night"];
  if (template.layout) {
    return buildResponsiveCompositionReport(view, meta, template);
  }
  const colors: ChartColors = {
    accent: theme.colors.accent,
    text: theme.colors.text,
    muted: theme.colors.muted,
    border: theme.colors.border,
  };
  const hasHeroOrCover = template.sections.some(
    (section) => section.kind === "hero" || section.kind === "cover",
  );
  const nav = view.profile.length > 12
    ? `<nav class="anchor-nav"><a href="#answers">回答明细</a><a href="#gallery">图片</a></nav>`
    : "";
  const sections = template.sections
    .map((section) => renderReportSection(section.kind, view, section, colors))
    .filter(Boolean)
    .join("");
  const footer = `<footer class="meta">${meta.surveyTitle ? `${escapeHtml(meta.surveyTitle)} · ` : ""}${escapeHtml(text(meta.completedAt))}${meta.reportId ? ` · 报告 ${escapeHtml(meta.reportId)}` : ""}</footer>`;
  const watermark = `<div class="report-watermark">${escapeHtml(meta.watermark ?? "更多问卷 @hnhgggfj_bot")}</div>`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="theme-color" content="#0f172a" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root{--bg:#f4f6fa;--surface:#fff;--text:#172033;--muted:#64748b;--border:#e5e9f0;--accent:#4f46e5;--accent-soft:#eef2ff;--radius:18px}
    @media (prefers-color-scheme: dark){:root{--bg:#0b1220;--surface:#131c2e;--text:#e2e8f0;--muted:#94a3b8;--border:#243349;--accent:#818cf8;--accent-soft:#1e2740;--radius:18px}}
    ${baseCss()}
  </style>
  <style>${themeCss(theme)}${themeAliasCss()}${template.css ?? ""}</style>
</head>
<body>
  <main class="wrap">
    ${hasHeroOrCover ? "" : renderHero(view, { kind: "hero" })}
    ${nav}
    ${sections}
    ${footer}
    ${watermark}
  </main>
</body>
</html>`;
}
