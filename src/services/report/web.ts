import type { ReportViewModel } from "./model";
import { renderRadarSvg } from "./blocks/radar";
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

function renderHero(view: ReportViewModel): string {
  const avatar = view.hero.avatar
    ? `<img class="avatar" src="${escapeHtml(view.hero.avatar)}" alt="" loading="lazy" onerror="this.remove()" />`
    : "";
  const tags = view.hero.tags.length
    ? `<div class="tags">${view.hero.tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}</div>`
    : "";
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

function renderScores(view: ReportViewModel): string {
  if (!view.scores.length) return "";
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

function renderRadar(view: ReportViewModel): string {
  if (view.charts.radar.length < 3) return "";
  return `<section class="report-section"><h2>维度画像</h2>
    ${renderRadarSvg(view.charts.radar, "var(--accent)", escapeHtml)}
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

function renderAnswers(view: ReportViewModel): string {
  if (!view.profile.length) return "";
  return `<section class="report-section"><h2>回答明细</h2>
    <dl class="answer-list">
      ${view.profile.map((item) => `
        <div class="answer-item"><dt>${escapeHtml(item.label)}</dt><dd>${escapeHtml(item.value)}</dd></div>`).join("")}
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
): string {
  switch (kind) {
    case "cover": return renderCover(view);
    case "hero": return renderHero(view);
    case "summary": return wrapSection("summary", sectionTitle("summary", section), renderSummary(view));
    case "scores": return wrapSection("scores", sectionTitle("scores", section), renderScores(view));
    case "radar": return wrapSection("radar", sectionTitle("radar", section), renderRadar(view));
    case "insights": return wrapSection("insights", sectionTitle("insights", section), renderInsights(view));
    case "quotes": return wrapSection("quotes", sectionTitle("quotes", section), renderInsights(view));
    case "answers": return wrapSection("answers", sectionTitle("answers", section), renderAnswers(view));
    case "gallery": return wrapSection("gallery", sectionTitle("gallery", section), renderGallery(view));
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
}

function baseCss(): string {
  return `*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.65 -apple-system,"PingFang SC","Noto Sans CJK SC","Microsoft YaHei",sans-serif}.wrap{max-width:720px;margin:0 auto;padding:0 16px 48px}header.hero{padding:32px 0 20px;display:grid;gap:14px}.hero-title{margin:0;font-size:26px;line-height:1.3}.hero-sub{margin:0;color:var(--muted);white-space:pre-wrap}.avatar{width:96px;height:96px;border-radius:50%;object-fit:cover;border:3px solid var(--accent)}.tags{display:flex;flex-wrap:wrap;gap:6px}.tags span{padding:3px 10px;border-radius:99px;background:var(--accent-soft);color:var(--accent);font-size:12px}.anchor-nav{display:flex;gap:12px;font-size:13px}.anchor-nav a{color:var(--accent);text-decoration:none}.report-section{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:18px;margin-top:16px}.report-section h2{margin:0 0 12px;font-size:16px}.report-cover{min-height:44vh;border-radius:14px;margin-top:16px;padding:34px 24px;background-color:var(--surface-elevated);background-size:cover;background-position:center;display:flex;flex-direction:column;justify-content:flex-end}.report-cover h1{margin:0;font-size:30px;line-height:1.25}.report-cover .cover-sub{margin:8px 0 0;color:var(--muted)}.score-grid{display:grid;gap:10px}.score-card{border:1px solid var(--border);border-radius:10px;padding:12px}.score-head{display:flex;justify-content:space-between;align-items:baseline}.score-head strong{font-size:20px;color:var(--accent)}.score-head small{color:var(--muted);font-size:12px}.score-card p{margin:6px 0 0;color:var(--muted);font-size:13px}.bar{height:7px;margin-top:8px;border-radius:99px;background:var(--border);overflow:hidden}.bar span{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,var(--accent),#22d3ee)}.radar{width:100%;max-width:320px;margin:0 auto;display:block;color:var(--muted)}.insight{border-top:1px solid var(--border);padding:12px 0}.insight:first-of-type{border-top:0;padding-top:0}.insight h3{margin:0 0 6px;font-size:15px}.insight p{margin:8px 0 0;white-space:pre-wrap}blockquote{margin:12px 0 0;padding:12px 14px;border-left:3px solid var(--accent);background:var(--accent-soft);border-radius:0 10px 10px 0}blockquote p{margin:0;white-space:pre-wrap}blockquote footer{margin-top:6px;color:var(--muted);font-size:12px}.answer-list{margin:0}.answer-item{display:grid;grid-template-columns:minmax(100px,34%) 1fr;gap:12px;padding:10px 0;border-top:1px solid var(--border)}.answer-item:first-child{border-top:0}dt{color:var(--muted);font-size:13px}dd{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}figure{margin:0}figure img{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:10px;background:var(--border)}figure.missing::after{content:"图片已归档";display:block;padding:26px 0;text-align:center;color:var(--muted);font-size:12px;background:var(--accent-soft);border-radius:10px}figure.missing img{display:none}figcaption{margin-top:4px;color:var(--muted);font-size:12px;overflow-wrap:anywhere}.summary p{margin:0;white-space:pre-wrap}footer.meta{margin-top:24px;color:var(--muted);font-size:12px;text-align:center}@media print{:root{--bg:#fff;--surface:#fff;--border:#d6dbe3;--accent-soft:#f1f3f9}body{background:#fff}.wrap{max-width:none;padding:0}.anchor-nav{display:none}.report-section{break-inside:avoid;margin-top:14px}.score-card,figure,blockquote{break-inside:avoid}.gallery{grid-template-columns:repeat(2,1fr)}.gallery figure img{aspect-ratio:auto;height:220px;object-fit:contain;background:#f4f6f9}header.hero{padding:12px 0 16px}.hero-title{font-size:22px}}`;
}

function themeAliasCss(): string {
  return `:root{--bg:var(--report-bg);--bg-secondary:var(--report-bg-secondary);--surface:var(--report-surface);--surface-elevated:var(--report-surface-elevated);--text:var(--report-text);--muted:var(--report-text-muted);--border:var(--report-border);--accent:var(--report-accent);--accent-soft:var(--report-surface-elevated)}`;
}

export function buildResponsiveReportHtml(
  view: ReportViewModel,
  meta: ResponsiveReportMeta = {},
  template: ReportTemplateSpec = DEFAULT_REPORT_TEMPLATE,
): string {
  const title = view.hero.title || meta.surveyTitle || "问卷结果报告";
  const theme = reportThemes[template.theme] ?? reportThemes["tokyo-night"];
  const hasHeroOrCover = template.sections.some(
    (section) => section.kind === "hero" || section.kind === "cover",
  );
  const nav = view.profile.length > 12
    ? `<nav class="anchor-nav"><a href="#answers">回答明细</a><a href="#gallery">图片</a></nav>`
    : "";
  const sections = template.sections
    .map((section) => renderReportSection(section.kind, view, section))
    .filter(Boolean)
    .join("");
  const footer = `<footer class="meta">${meta.surveyTitle ? `${escapeHtml(meta.surveyTitle)} · ` : ""}${escapeHtml(text(meta.completedAt))}${meta.reportId ? ` · 报告 ${escapeHtml(meta.reportId)}` : ""}</footer>`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="theme-color" content="#0f172a" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root{--bg:#f1f5f9;--surface:#fff;--text:#0f172a;--muted:#64748b;--border:#e2e8f0;--accent:#6366f1;--accent-soft:#eef2ff}
    @media (prefers-color-scheme: dark){:root{--bg:#0b1220;--surface:#131c2e;--text:#e2e8f0;--muted:#94a3b8;--border:#243349;--accent:#818cf8;--accent-soft:#1e2740}}
    ${baseCss()}
  </style>
  <style>${themeCss(theme)}${themeAliasCss()}${template.css ?? ""}</style>
</head>
<body>
  <main class="wrap">
    ${hasHeroOrCover ? "" : renderHero(view)}
    ${nav}
    ${sections}
    ${footer}
  </main>
</body>
</html>`;
}
