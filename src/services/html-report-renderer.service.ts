import puppeteer, { type BrowserWorker } from "@cloudflare/puppeteer";
import type { ResultProfileSnapshot } from "../result/schema";
import { RESULT_VISUAL_EMOJI_FONT, RESULT_VISUAL_FONT } from "./result-visual-font";
import { reportTokenCss } from "./report/tokens";
import { type ReportLayout } from "./report/layouts";
import { reportThemes, themeCss, type ReportTheme } from "./report/themes";
import { inspectReportImage, reportImageByteSize, reportImageHash } from "./report/image-metadata";
import type { PreparedReportContent, ReportAnswerItem, ReportArtifact, ReportGalleryItem, ReportPage, ReportPageBlock, ReportViewModel } from "./report/model";
import { prepareReportContent, normalizeReportText } from "./report/composition/content";
import { composeReport } from "./report/composition/compose";
import { planReportPages, selectGalleryForPolicy } from "./report/composition/page-planner";
import { DEFAULT_REPORT_SIZE_POLICY, type ReportSizePolicy } from "./report/size-policy";
import { renderGalleryBlock } from "./report/blocks/gallery";
import { renderFinalVerdictBlock } from "./report/blocks/summary";
import { renderEditorialAnalysisBlock, renderFeaturedInsightBlock, renderHeroBlock, renderQuoteBlock } from "./report/blocks/content";
import { renderBarsChart, renderMetricGridBlock, renderPrimaryScoreBlock } from "./report/blocks/data";
import { renderSelectedResponses } from "./report/blocks/answers";
import { renderRadarSvg } from "./report/blocks/radar";
import { renderMetadataBlock } from "./report/blocks/structural";
import type { ReportTemplateSpec } from "./report/template";

export type { ReportGalleryItem, ReportScore, ReportViewModel } from "./report/model";

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function text(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join("、");
  if (typeof value === "object") return "";
  return String(value);
}

function limitText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

export interface ReportLayoutOptions { layout?: ReportLayout; theme?: ReportTheme; }

const supportedLayouts = new Set<ReportLayout>(["editorial", "bento", "magazine", "data", "gallery", "profile"]);

function asReportLayout(value: unknown): ReportLayout | undefined {
  return typeof value === "string" && supportedLayouts.has(value as ReportLayout) ? value as ReportLayout : undefined;
}

function layoutHintFromTemplateName(name: string): ReportLayout | undefined {
  if (/gallery|相册|图片/i.test(name)) return "gallery";
  if (/magazine|杂志/i.test(name)) return "magazine";
  if (/editorial|编辑/i.test(name)) return "editorial";
  if (/data|数据/i.test(name)) return "data";
  if (/profile|画像/i.test(name)) return "profile";
  if (/bento|网格/i.test(name)) return "bento";
  return undefined;
}

function themeHintFromTemplateName(name: string): ReportTheme {
  if (/dracula|霓虹|赛博/i.test(name)) return "dracula";
  if (/nord/i.test(name)) return "nord";
  if (/catppuccin|mocha|玻璃/i.test(name)) return "catppuccin-mocha";
  if (/one.?dark/i.test(name)) return "one-dark";
  if (/night.?owl/i.test(name)) return "night-owl";
  if (/horizon/i.test(name)) return "horizon";
  if (/gruvbox|复古|deco/i.test(name)) return "gruvbox-dark";
  if (/solarized/i.test(name)) return "solarized-dark";
  return "tokyo-night";
}

export function selectReportLayout(view: ReportViewModel, options: ReportLayoutOptions = {}): ReportLayout {
  const explicit = asReportLayout(options.layout);
  if (explicit) return explicit;
  const metadataLayout = asReportLayout(view.meta.layout);
  if (metadataLayout) return metadataLayout;
  const uniqueText = new Map<string, number>();
  for (const value of [view.summary, ...view.insights.map((item) => item.text), ...view.quotes.map((item) => item.text)]) {
    const fingerprint = normalizeReportText(value);
    if (fingerprint) uniqueText.set(fingerprint, value.length);
  }
  const textVolume = [...uniqueText.values()].reduce((sum, length) => sum + length, 0);
  const scores = view.scores.length;
  const images = view.gallery.filter((item) => item.url !== view.hero.avatar).length;
  const longAnswers = view.profile.filter((item) => item.value.length > 180).length;
  const shortAnswers = view.profile.filter((item) => item.value.length <= 70).length;
  const weights: Record<ReportLayout, number> = {
    editorial: 10 + Math.min(42, Math.floor(textVolume / 220)) + longAnswers * 5,
    bento: 8 + Math.min(scores, 6) * 5 + Math.min(shortAnswers, 8) * 2,
    magazine: 8 + Math.min(view.insights.length, 5) * 4 + Math.min(images, 2) * 6,
    data: scores >= 4 ? 14 + scores * 5 : 0,
    gallery: images >= 2 ? images * 14 + 10 : images * 5,
    profile: 8 + Math.min(shortAnswers, 10) * 3 + (view.hero.avatar ? 12 : 0),
  };
  return (Object.entries(weights) as Array<[ReportLayout, number]>).sort((left, right) => right[1] - left[1])[0]?.[0] ?? "editorial";
}

function scoreLevel(percentage: number): string {
  if (percentage >= 80) return "HIGH";
  if (percentage >= 55) return "MEDIUM";
  return "LOW";
}

function scoreDescription(percentage: number): string {
  if (percentage >= 80) return "突出表现";
  if (percentage >= 55) return "稳定倾向";
  return "可继续探索";
}

export function buildReportViewModel(profile: ResultProfileSnapshot, images: Record<string, string> = {}): ReportViewModel {
  const metadata = profile.metadata as Record<string, unknown>;
  const rawProfile = Array.isArray(metadata.profile) ? metadata.profile as Array<Record<string, unknown>> : [];
  const profileItems = rawProfile.map((item, index) => {
    const label = limitText(text(item.label), 120);
    const value = limitText(text(item.value), 20_000);
    const matchingField = Object.entries(profile.fields).find(([, field]) => text(field.value).trim() === value.trim());
    const options = Array.isArray(item.options)
      ? (item.options as Array<Record<string, unknown>>)
          .map((option) => ({
            label: text(option.label),
            selected: option.selected === true,
          }))
          .filter((option) => option.label)
      : undefined;
    return {
      id: `answer-${index}`,
      sourceId: matchingField?.[0] ?? `profile-${index}`,
      label,
      value,
      ...(typeof item.type === "string" ? { type: item.type } : {}),
      ...(options?.length ? { options } : {}),
    };
  }).filter((item) => item.label && item.value).slice(0, 250);
  const scores = profile.stats.filter((stat) => Number.isFinite(stat.value) && Number.isFinite(stat.max) && Number(stat.max) > 0).slice(0, 12).map((stat) => {
    const max = stat.max!;
    const percentage = Math.max(0, Math.min(100, stat.value / max * 100));
    return { key: stat.id, label: limitText(stat.label, 80), value: stat.value, max, percentage, level: scoreLevel(percentage), description: scoreDescription(percentage) };
  });
  const longTexts = Object.entries(profile.fields)
    .filter(([, field]) => field.type === "long_text" && typeof field.value === "string" && field.value.trim())
    .map(([id, field], index) => {
      const value = String(field.value).trim();
      const matchingProfile = profileItems.find((item) => item.sourceId === id || item.value === value);
      return { id: `text-${index}`, sourceId: id, title: matchingProfile?.label || `回答 ${id.replace(/^question_/, "#")}`, text: value };
    });
  const semanticTitles = ["Core Personality", "Behavior Pattern", "Relationship Pattern", "Contradiction", "Final Insight"];
  const insights = longTexts.slice(0, 5).map((item, index) => ({
    ...item, title: semanticTitles[index] ?? item.title, text: limitText(item.text, 20_000),
    ...(index === 0 && profile.tags.length ? { tags: profile.tags.slice(0, 3) } : {}),
  }));
  const quotes = longTexts.slice(5, 11).map((item) => ({ ...item, text: limitText(item.text, 1800) }));
  const metadataGallery = Array.isArray(metadata.gallery) ? metadata.gallery : [];
  const gallery: ReportGalleryItem[] = Object.entries(images)
    .filter(([key, value]) =>
      !key.startsWith("template.background") &&
      (value.startsWith("data:image/") || value.startsWith("/api/")),
    )
    .slice(0, 60)
    .map(([, url], index) => {
      const source = metadataGallery[index];
      const sourceRecord = source && typeof source === "object" && !Array.isArray(source) ? source as Record<string, unknown> : {};
      return {
        ...inspectReportImage(url), url, byteSize: reportImageByteSize(url), sourceHash: reportImageHash(url),
        ...(text(sourceRecord.caption) ? { caption: limitText(text(sourceRecord.caption), 180) } : {}),
        ...(text(sourceRecord.questionTitle) ? { questionTitle: limitText(text(sourceRecord.questionTitle), 180) } : {}),
      };
    });
  const avatar = ["result.images.avatar", "result.images.portrait", "result.images.profilePhoto", "result.images.front_image"]
    .map((key) => images[key]).find((value) => value?.startsWith("data:image/") || value?.startsWith("/api/")) ?? gallery[0]?.url;
  const requestedLayout = asReportLayout(metadata.layout ?? metadata.reportLayout);
  const requestedTheme = typeof metadata.theme === "string" && metadata.theme in reportThemes ? metadata.theme as ReportTheme : undefined;
  return {
    hero: { title: limitText(profile.title ?? "问卷结果报告", 160), subtitle: limitText(profile.subtitle ?? "根据本次问卷回答生成", 300), tags: profile.tags.slice(0, 20), ...(avatar ? { avatar, coverImage: avatar } : {}) },
    scores, charts: { radar: scores.slice(0, 6).map((score) => ({ label: score.label, value: score.percentage })), bars: scores.slice(0, 8) },
    tags: profile.tags.slice(0, 20), insights, quotes, gallery, summary: limitText(text(metadata.summary), 8000), profile: profileItems,
    contentStats: { answerCount: rawProfile.length, imageCount: Object.keys(images).filter((key) => !key.startsWith("template.background")).length, longTextCount: longTexts.length, scoreCount: scores.length },
    meta: {
      ...(text(metadata.surveyTitle) ? { surveyTitle: limitText(text(metadata.surveyTitle), 160) } : {}),
      ...(text(metadata.submittedAt) ? { submittedAt: limitText(text(metadata.submittedAt), 80) } : {}),
      ...(text(metadata.reportId) ? { reportId: limitText(text(metadata.reportId), 80) } : {}),
      ...(requestedLayout ? { layout: requestedLayout } : {}), ...(requestedTheme ? { theme: requestedTheme } : {}),
    },
  };
}

function bytesToDataUrl(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return `data:font/ttf;base64,${btoa(binary)}`;
}

const reportFontCss = `@font-face{font-family:ReportSans;src:url(${bytesToDataUrl(RESULT_VISUAL_FONT)}) format('truetype');font-weight:400;font-style:normal;font-display:block}@font-face{font-family:ReportEmoji;src:url(${bytesToDataUrl(RESULT_VISUAL_EMOJI_FONT)}) format('truetype');font-weight:400;font-style:normal;font-display:block;unicode-range:U+1F000-1FAFF,U+2600-27BF}`;

function reportCss(): string {
  return `${reportFontCss}${reportTokenCss()}
*{box-sizing:border-box}html,body{margin:0;padding:0;background:var(--report-bg);color:var(--report-text);font-family:var(--font-body);font-variant-numeric:tabular-nums lining-nums}body{width:900px}.page{width:900px;padding:54px;display:flex;flex-direction:column}.composition-region{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:var(--report-grid-gap);margin-top:var(--report-section-gap)}.composition-region:first-child{margin-top:0}.composition-block{grid-column:span 12;min-width:0}.chapter-heading{display:flex;align-items:baseline;justify-content:space-between;gap:24px;margin-bottom:40px}.chapter-heading span,.chapter-kicker,.eyebrow,.verdict-eyebrow,.response-index,.editorial-label{font-size:var(--type-label);letter-spacing:.14em;color:var(--report-accent);font-weight:700}.chapter-heading h2{font-size:var(--type-h2);margin:0}.tag{padding:8px 13px;border-radius:var(--report-radius-pill);background:var(--report-surface);border:1px solid var(--report-border);font-size:13px}.media-fallback{display:none;place-items:center;background:var(--report-surface);color:var(--report-text-muted)}
.hero{min-height:440px;display:grid;grid-template-columns:minmax(0,1fr) 220px;gap:36px 48px;padding:56px 0 64px;border-top:1px solid var(--report-border);border-bottom:1px solid var(--report-border);position:relative}.hero-copy{align-self:center}.hero h1{font-size:var(--type-display);line-height:1.08;letter-spacing:-.035em;margin:22px 0 18px;max-width:780px}.hero-thesis{font-size:26px;line-height:1.5;color:var(--report-text-muted);max-width:760px}.hero-tags{display:flex;gap:10px;flex-wrap:wrap;margin-top:28px}.hero-score{align-self:center;text-align:right;border-left:1px solid var(--report-border);padding-left:36px}.hero-score strong{display:block;font-size:92px;line-height:.9;color:var(--report-accent)}.hero-score span{display:block;font-size:16px;margin-top:16px}.hero-score small{display:block;font-size:10px;letter-spacing:.13em;color:var(--report-text-muted);margin-top:6px}.hero-avatar{position:absolute;right:0;bottom:24px;width:132px;height:132px;object-fit:cover;border-radius:50%;border:4px solid var(--report-bg);box-shadow:0 0 0 1px var(--report-border)}
.bento-overview{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));grid-auto-rows:minmax(150px,auto);gap:18px}.bento-tile{background:var(--report-surface);border:1px solid var(--report-border);border-radius:var(--report-radius-lg);padding:26px;break-inside:avoid}.bento-primary{grid-column:span 7;grid-row:span 2;padding:38px;display:flex;flex-direction:column;justify-content:flex-end}.bento-primary>span,.bento-radar>span,.bento-bars>span,.bento-tags>span{font-size:11px;letter-spacing:.13em;color:var(--report-accent)}.bento-primary strong{font-size:88px;line-height:1;margin-top:24px}.bento-primary h3{font-size:22px;margin:8px 0 24px}.bento-metrics{grid-column:span 5;display:grid;grid-template-columns:repeat(2,1fr);gap:18px}.metric{background:var(--report-surface);border:1px solid var(--report-border);border-radius:var(--report-radius-md);padding:18px;break-inside:avoid}.metric-top{display:flex;justify-content:space-between;gap:8px}.metric-label{font-size:15px;color:var(--report-text-muted)}.metric strong{font-size:34px;display:block;margin-top:8px}.ring{display:none}.metric-level{font-size:11px;color:var(--report-accent);margin:10px 0}.meter,.bar-track{height:7px;border-radius:99px;background:var(--report-border);overflow:hidden}.meter i,.bar-track i{display:block;height:100%;background:var(--report-accent);border-radius:99px}.bento-radar{grid-column:span 5;min-height:360px}.radar{width:100%;height:310px;display:block;margin:12px auto 0}.bento-bars{grid-column:span 7}.bars{display:flex;flex-direction:column;gap:17px;margin-top:28px}.bar-row{display:grid;grid-template-columns:170px 1fr 50px;align-items:center;gap:14px;font-size:16px}.bar-row b{text-align:right}.bars-chart svg{width:100%;height:300px;display:block}.bento-tags{grid-column:span 12;display:flex;align-items:center;gap:12px;flex-wrap:wrap;min-height:100px}
.featured-insight{max-width:1000px;margin:40px auto 10px;padding:80px 48px;text-align:center;border-top:1px solid var(--report-border);border-bottom:1px solid var(--report-border);break-inside:avoid}.featured-insight blockquote{font-size:44px;line-height:1.45;letter-spacing:-.02em;margin:26px 0}.featured-caption{color:var(--report-text-muted);font-size:14px}
.editorial-chapter{padding:56px 0}.editorial-section{display:grid;grid-template-columns:100px minmax(0,1fr);gap:30px;padding:54px 0;border-top:1px solid var(--report-border);break-inside:auto}.editorial-index{font-size:42px;color:var(--report-accent);line-height:1}.editorial-copy{max-width:860px}.editorial-copy h3{font-size:30px;margin:10px 0 20px}.editorial-copy p{font-size:16px;line-height:1.8;margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.editorial-section:not(.editorial-long):nth-of-type(3),.editorial-section:not(.editorial-long):nth-of-type(4){display:inline-grid;width:calc(50% - 12px);vertical-align:top;grid-template-columns:70px minmax(0,1fr);padding-right:24px}.editorial-contradiction,.editorial-final{width:100%!important;display:grid!important}.editorial-contradiction .editorial-copy{max-width:980px}.editorial-contradiction p{font-size:28px;line-height:1.6}.editorial-final .editorial-copy{margin-left:auto;max-width:760px}
.quotes-composition,.responses-composition,.gallery-composition{padding:54px 0;border-top:1px solid var(--report-border)}.quote-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:28px}.selected-quote{padding:32px 0;border-top:3px solid var(--report-accent);break-inside:avoid}.selected-quote:first-child:last-child{grid-column:1/-1;max-width:880px}.selected-quote blockquote{font-size:28px;line-height:1.65;margin:20px 0}.quote-question{font-size:13px;color:var(--report-text-muted)}.featured-question{padding:48px 0 56px;max-width:900px;border-bottom:1px solid var(--report-border);break-inside:auto}.featured-question .question{font-size:28px}.featured-question .answer{font-size:24px}.editorial-answer-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:48px;margin-top:48px}.editorial-answer{padding-top:24px;border-top:1px solid var(--report-border);break-inside:auto}.question{font-size:17px;color:var(--report-text-muted);line-height:1.5;margin:12px 0 18px}.answer{font-size:17px;line-height:1.75;white-space:pre-wrap}.compact-answer-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin-top:48px}.compact-answer{padding:20px;background:var(--report-surface);border:1px solid var(--report-border);border-radius:var(--report-radius-md);break-inside:avoid}.compact-answer .question{font-size:13px;margin-bottom:10px}.compact-answer .answer{font-size:15px;line-height:1.55}
.gallery{display:grid;gap:18px}.gallery-item{margin:0;break-inside:avoid}.gallery-item img{display:block;width:100%;height:340px;object-fit:cover;border-radius:var(--report-radius-md)}.gallery-item figcaption{font-size:13px;color:var(--report-text-muted);padding-top:10px}.gallery-single{grid-template-columns:1fr}.gallery-single .gallery-item img{height:620px}.gallery-duo,.gallery-quad{grid-template-columns:repeat(2,1fr)}.gallery-duo .gallery-item img{height:500px}.gallery-feature-triple{grid-template-columns:1.6fr 1fr}.gallery-feature-triple .gallery-item:first-child{grid-row:span 2}.gallery-feature-triple .gallery-item:first-child img{height:698px}.gallery-grid{grid-template-columns:repeat(3,1fr)}.gallery-grid .gallery-item img{height:290px}
.final-verdict{margin-top:64px;padding:110px 0 96px;border-top:2px solid var(--report-accent);min-height:680px;break-inside:auto}.final-verdict h2{font-size:68px;line-height:1.18;letter-spacing:-.04em;max-width:1000px;margin:30px 0 50px}.verdict-main{display:grid;grid-template-columns:220px minmax(0,720px);gap:48px;align-items:center}.verdict-main p{font-size:21px;line-height:1.7;margin:0}.verdict-main>p:first-child:last-child{grid-column:1/-1;max-width:860px}.verdict-score strong{display:block;font-size:78px;color:var(--report-accent);line-height:1}.verdict-score span{display:block;font-size:13px;color:var(--report-text-muted);margin-top:10px}.verdict-pillars{display:grid;grid-template-columns:repeat(3,1fr);gap:30px;margin-top:70px}.verdict-pillar{padding-top:20px;border-top:1px solid var(--report-border)}.verdict-pillar span{font-size:10px;letter-spacing:.12em;color:var(--report-accent)}.verdict-pillar b{display:block;font-size:16px;line-height:1.55;margin-top:12px}.closing-statement{text-align:right;margin-top:80px;font-size:18px;color:var(--report-text-muted)}.report-metadata{font-size:11px;color:var(--report-text-muted);text-align:center;padding:30px 0}
.report-layout-magazine .featured-insight{text-align:left;margin-left:0}.report-layout-magazine .gallery-feature-triple{grid-template-columns:1.8fr 1fr}.report-layout-data .composition-region-analysis .editorial-chapter{padding-top:20px}.report-layout-gallery .hero{min-height:360px}.report-layout-profile .hero{grid-template-columns:minmax(0,1fr) 220px}.density-airy .composition-region{margin-top:64px}.density-compact .composition-region{margin-top:32px}.report-page-shell,.report-page-shell body{width:900px;height:1200px;overflow:hidden}.report-page-shell .page{height:1200px;padding:48px 54px;overflow:hidden}.report-page-shell .composition-region{margin-top:24px}.report-page-shell .hero{min-height:360px;padding:40px 0;grid-template-columns:minmax(0,1fr) 170px;gap:28px}.report-page-shell .hero h1{font-size:50px}.report-page-shell .hero-thesis{font-size:21px}.report-page-shell .hero-score{padding-left:24px}.report-page-shell .hero-score strong{font-size:68px}.report-page-shell .bento-overview{grid-auto-rows:minmax(90px,auto);gap:14px}.report-page-shell .bento-primary{grid-column:span 12;padding:24px}.report-page-shell .bento-primary strong{font-size:64px;margin-top:12px}.report-page-shell .bento-metrics{grid-column:span 12;gap:12px}.report-page-shell .metric{padding:12px}.report-page-shell .metric strong{font-size:26px}.report-page-shell .bento-radar,.report-page-shell .bento-bars{grid-column:span 12}.report-page-shell .bento-radar{min-height:210px;padding:16px}.report-page-shell .radar{height:190px}.report-page-shell .bento-bars{padding:18px}.report-page-shell .bars{gap:10px;margin-top:14px}.report-page-shell .bento-tags{min-height:64px;padding:14px}.report-page-shell .featured-insight{padding:54px 24px;margin:0 auto}.report-page-shell .featured-insight blockquote{font-size:34px}.report-page-shell .editorial-chapter,.report-page-shell .quotes-composition,.report-page-shell .responses-composition,.report-page-shell .gallery-composition{padding:20px 0}.report-page-shell .chapter-heading{margin-bottom:22px}.report-page-shell .editorial-section{grid-template-columns:72px minmax(0,1fr);padding:24px 0}.report-page-shell .editorial-copy p{font-size:18px;line-height:1.7}.report-page-shell .quote-list,.report-page-shell .editorial-answer-grid{grid-template-columns:1fr}.report-page-shell .compact-answer-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.report-page-shell .selected-quote{padding:18px 0}.report-page-shell .selected-quote blockquote{font-size:24px}.report-page-shell .question,.report-page-shell .answer{font-size:18px}.report-page-shell .gallery-grid{grid-template-columns:repeat(2,1fr)}.report-page-shell .gallery-item img{height:300px}.report-page-shell .gallery-single .gallery-item img{height:820px}.report-page-shell .gallery-duo .gallery-item img{height:720px}.report-page-shell .gallery-feature-triple .gallery-item:first-child img{height:760px}.report-page-shell .final-verdict{min-height:0;margin-top:0;padding:64px 0}.report-page-shell .final-verdict h2{font-size:52px;margin:22px 0 34px}.report-page-shell .verdict-main{grid-template-columns:180px minmax(0,1fr);gap:32px}.report-page-shell .verdict-pillars{margin-top:42px}.report-page-shell .closing-statement{margin-top:48px}.page-folio{position:absolute;right:54px;bottom:24px;font-size:10px;letter-spacing:.14em;color:var(--report-text-muted)}@media print{.editorial-section,.featured-question,.editorial-answer,.final-verdict{break-inside:auto}.bento-tile,.metric,.selected-quote,.compact-answer,.gallery-item{break-inside:avoid}}`;
}

function themeChartColors(themeId: ReportTheme): { accent: string; text: string; muted: string; border: string } {
  const theme = reportThemes[themeId];
  return {
    accent: theme.colors.accent,
    text: theme.colors.text,
    muted: theme.colors.muted,
    border: theme.colors.border,
  };
}

function renderOverview(
  view: ReportViewModel,
  colors: { accent: string; text: string; muted: string; border: string },
): string {
  if (!view.scores.length && !view.tags.length) return "";
  const context = { accent: "var(--report-accent)", escape: escapeHtml };
  const primary = renderPrimaryScoreBlock(view.scores[0], context);
  const metrics = renderMetricGridBlock(view.scores.slice(1, 5), context);
  const radar = renderRadarSvg(view.charts.radar, colors);
  const bars = renderBarsChart(view.charts.bars.slice(0, 6), colors);
  const tags = view.tags.slice(0, 8).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("");
  return `<section class="bento-overview block block-overview">${primary}${metrics ? `<div class="bento-metrics">${metrics}</div>` : ""}${radar ? `<article class="bento-tile bento-radar"><span>PROFILE MAP</span>${radar}</article>` : ""}${bars ? `<article class="bento-tile bento-bars"><span>CORE DIMENSIONS</span><div class="bars">${bars}</div></article>` : ""}${tags ? `<article class="bento-tile bento-tags"><span>PROFILE SNAPSHOT</span>${tags}</article>` : ""}</section>`;
}

function renderComposition(
  view: ReportViewModel,
  layout: ReportLayout,
  colors: { accent: string; text: string; muted: string; border: string },
  templateBlocks?: ReportTemplateSpec["blocks"],
): { html: string; density: string } {
  const content = prepareReportContent(view);
  const composition = composeReport(view, content, layout, templateBlocks);
  const primaryScore = view.scores[0];
  const thesis = /问卷完成|自动整理|根据本次问卷/.test(view.hero.subtitle)
    ? content.featuredInsight?.text ?? view.hero.title
    : view.hero.subtitle;
  const blocks: Record<string, string> = {
    cover: renderCoverComposition(view),
    hero: renderHeroBlock({ title: view.hero.title, thesis, tags: view.hero.tags, ...(view.hero.avatar ? { avatar: view.hero.avatar } : {}), ...(primaryScore ? { primaryScore } : {}) }, { escape: escapeHtml, limit: limitText }),
    overview: renderOverview(view, colors), featured: renderFeaturedInsightBlock(content.featuredInsight, { escape: escapeHtml, limit: limitText }),
    analysis: renderEditorialAnalysisBlock(content.analysis, { escape: escapeHtml, limit: limitText }), quotes: renderQuoteBlock(content.quotes, { escape: escapeHtml, limit: limitText }),
    responses: renderSelectedResponses(content, { escape: escapeHtml }), gallery: renderGalleryBlock(view.gallery, { heroUrl: view.hero.avatar, escape: escapeHtml }),
    transcript: renderFullTranscript(view, { escape: escapeHtml }),
    verdict: renderFinalVerdictBlock(content.verdict, primaryScore, { escape: escapeHtml, limit: limitText }),
  };
  const html = composition.regions.map((region) => `<div class="composition-region composition-region-${region.role}" data-region="${region.id}">${region.blocks.map((spec) => {
    const markup = blocks[spec.kind] ?? "";
    return markup ? `<div class="composition-block presentation-${spec.presentation} reading-${spec.readingWidth} emphasis-${spec.emphasis}" data-block="${spec.kind}">${markup}</div>` : "";
  }).join("")}</div>`).join("");
  return { html, density: composition.density };
}

export function buildHtmlReport(profile: ResultProfileSnapshot, templateName: string, images: Record<string, string> = {}, options: ReportLayoutOptions = {}): string {
  const view = buildReportViewModel(profile, images);
  const layout = options.layout ?? view.meta.layout ?? layoutHintFromTemplateName(templateName) ?? selectReportLayout(view, options);
  const themeId = options.theme ?? view.meta.theme ?? themeHintFromTemplateName(templateName);
  const theme = reportThemes[themeId];
  const composition = renderComposition(view, layout, themeChartColors(themeId));
  const meta = [view.meta.surveyTitle, view.meta.submittedAt, view.meta.reportId].filter(Boolean).map((value) => escapeHtml(value!)).join(" · ");
  return `<!doctype html><html><head><meta charset="utf-8"><style>${themeCss(theme)}${reportCss()}</style></head><body><div class="report-layout-${layout} density-${composition.density}" data-report-layout="${layout}" data-report-theme="${theme.id}"><main class="page">${composition.html}${renderMetadataBlock([meta], { escape: escapeHtml }) || `<footer class="report-metadata">本报告由问卷回答自动整理生成</footer>`}</main></div></body></html>`;
}

/** Responsive stylesheet for the composition engine on the open Web (and A4 print). */
function responsiveCompositionCss(): string {
  const base = reportCss()
    .replace("body{width:900px}", "")
    .replace(
      ".page{width:900px;padding:54px;display:flex;flex-direction:column}",
      ".page{width:auto;max-width:1120px;margin:0 auto;padding:36px 24px 72px;display:flex;flex-direction:column}",
    );
  return `${base}
@media (max-width:960px){.composition-region{grid-template-columns:1fr}.composition-block{grid-column:auto}.bento-overview{grid-template-columns:1fr}.bento-primary,.bento-metrics,.bento-radar,.bento-bars,.bento-tags{grid-column:auto;grid-row:auto}.hero{grid-template-columns:1fr;gap:24px;padding:40px 0 48px}.hero h1{font-size:42px}.hero-thesis{font-size:20px}.hero-score{text-align:left;border-left:0;border-top:1px solid var(--report-border);padding:22px 0 0;margin-top:6px}.hero-score strong{font-size:54px}.hero-avatar{position:static;width:108px;height:108px;margin-top:22px}.quote-list,.editorial-answer-grid{grid-template-columns:1fr}.compact-answer-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.gallery-grid{grid-template-columns:repeat(2,1fr)}.gallery-feature-triple{grid-template-columns:1fr}.gallery-feature-triple .gallery-item:first-child{grid-row:auto}.gallery-feature-triple .gallery-item:first-child img{height:340px}.gallery-item img{height:280px}.gallery-single .gallery-item img{height:420px}.gallery-duo .gallery-item img{height:300px}.editorial-section{grid-template-columns:56px minmax(0,1fr);gap:20px;padding:34px 0}.editorial-section:not(.editorial-long):nth-of-type(3),.editorial-section:not(.editorial-long):nth-of-type(4){display:grid;width:100%;grid-template-columns:56px minmax(0,1fr)}.editorial-copy h3{font-size:24px}.featured-insight{padding:54px 24px}.featured-insight blockquote{font-size:30px}.selected-quote{padding:24px 0}.selected-quote blockquote{font-size:22px}.featured-question{padding:32px 0 40px}.featured-question .question{font-size:22px}.featured-question .answer{font-size:19px}.chapter-heading{flex-direction:column;align-items:flex-start;gap:8px;margin-bottom:28px}.chapter-heading h2{font-size:26px}.final-verdict{padding:64px 0}.final-verdict h2{font-size:40px}.verdict-main{grid-template-columns:1fr;gap:24px}.verdict-pillars{grid-template-columns:1fr;gap:22px;margin-top:44px}.closing-statement{margin-top:48px}.radar,.bars-chart svg{width:100%!important;height:280px}}
@media (max-width:480px){.hero h1{font-size:32px}.hero-thesis{font-size:17px}.metric{padding:14px}.compact-answer-grid{grid-template-columns:1fr}.gallery-grid,.gallery-duo{grid-template-columns:1fr}.gallery-grid .gallery-item img{height:260px}.editorial-index{font-size:30px}.chapter-heading h2{font-size:22px}.page{padding:24px 16px 56px}}
@media print{:root{--report-bg:#fff;--report-surface:#fff;--report-border:#dde3ea}body{background:#fff}.page{max-width:none;padding:0}.composition-region,.bento-overview{grid-template-columns:1fr}.bento-primary,.bento-metrics,.bento-radar,.bento-bars,.bento-tags,.featured-insight,.final-verdict{grid-column:auto;grid-row:auto}.hero,.bento-tile,.metric,.selected-quote,.compact-answer,.gallery-item,.editorial-section,.featured-question,.transcript-item{break-inside:avoid}.hero{grid-template-columns:1fr}.hero h1{font-size:34px}.hero-score strong{font-size:44px}.gallery-grid{grid-template-columns:1fr}.compact-answer-grid{grid-template-columns:repeat(2,1fr)}}
.transcript-list{max-width:760px;margin:0 auto}.transcript-item{padding:26px 0;border-top:1px solid var(--report-border)}.transcript-item:first-of-type{border-top:0}.transcript-item .question{font-size:16px;font-weight:650;color:var(--report-text);line-height:1.5}.transcript-item .answer{margin-top:8px;font-size:15px;color:var(--report-text);white-space:pre-wrap;overflow-wrap:anywhere}.answer-options{margin-top:10px;display:grid;gap:6px}.answer-option{display:flex;align-items:center;gap:8px;font-size:14px;color:var(--report-text-muted)}.answer-option.selected{color:var(--report-accent);font-weight:600}.option-mark{width:16px;flex:none;text-align:center}@media (max-width:480px){.transcript-item{padding:20px 0}}
.report-cover{min-height:72vh;display:flex;align-items:center;justify-content:center;text-align:center;position:relative;border-top:1px solid var(--report-border);border-bottom:1px solid var(--report-border);padding:64px 0;overflow:hidden}.report-cover .cover-inner{max-width:920px}.report-cover .cover-kicker{font-size:var(--type-label);letter-spacing:.24em;color:var(--report-accent);font-weight:700}.report-cover h1{font-size:62px;line-height:1.05;letter-spacing:-.02em;margin:24px 0 18px}.report-cover .cover-subtitle{font-size:22px;color:var(--report-text-muted);max-width:720px;margin:0 auto}.report-cover .cover-tags{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:28px}.report-cover .cover-meta{margin-top:36px;font-size:13px;letter-spacing:.06em;color:var(--report-text-muted)}
html .report-layout-data{--report-accent:#2563eb;--report-bg:#f3f7fd;--report-surface:#ffffff;--report-border:#dbe4f0}.report-layout-data .page{background:linear-gradient(rgba(37,99,235,.04) 1px,transparent 1px),linear-gradient(90deg,rgba(37,99,235,.04) 1px,transparent 1px);background-size:36px 36px}.report-layout-data .hero{min-height:0;grid-template-columns:minmax(0,1fr) 240px;padding:34px 0 40px}.report-layout-data .hero h1{font-size:46px}.report-layout-data .hero-score strong{font-size:76px}.report-layout-data .bento-overview{grid-template-columns:repeat(12,minmax(0,1fr));gap:14px}.report-layout-data .bento-primary{grid-column:span 4;grid-row:span 2;border-radius:16px;background:linear-gradient(135deg,var(--report-accent),color-mix(in srgb,var(--report-accent) 55%,#1e3a8a))}.report-layout-data .bento-primary>span,.report-layout-data .bento-primary h3{color:rgba(255,255,255,.86)}.report-layout-data .bento-primary strong{color:#fff;font-size:76px}.report-layout-data .bento-metrics{grid-column:span 8;grid-template-columns:repeat(4,1fr);gap:14px}.report-layout-data .metric{border-radius:14px;padding:16px}.report-layout-data .metric strong{font-size:30px;color:var(--report-accent)}.report-layout-data .bento-radar{grid-column:span 5}.report-layout-data .bento-bars{grid-column:span 7}.report-layout-data .bar-row{grid-template-columns:150px 1fr 46px}.report-layout-data .featured-insight{border-left:4px solid var(--report-accent);border-top:1px solid var(--report-border);border-bottom:1px solid var(--report-border);text-align:left;padding:36px 40px}.report-layout-data .featured-insight blockquote{font-size:30px}.report-layout-data .final-verdict{min-height:0;padding:64px 0}.report-layout-data .final-verdict h2{font-size:44px}
html .report-layout-magazine{--report-accent:#9a3412;--report-bg:#faf6ee;--report-surface:#fffdf7;--report-border:#e7dcc8}.report-layout-magazine h1,.report-layout-magazine h2,.report-layout-magazine h3{font-family:Georgia,"Noto Serif CJK SC",serif}.report-layout-magazine .hero{min-height:0;text-align:center;display:block;padding:64px 0 56px;border-top:4px double var(--report-accent);border-bottom:4px double var(--report-accent)}.report-layout-magazine .hero h1{font-size:58px;letter-spacing:.01em;line-height:1.05;text-transform:uppercase}.report-layout-magazine .hero-thesis{font-style:italic;max-width:640px;margin:0 auto}.report-layout-magazine .hero-score{border-left:0;text-align:center;padding:0;margin-top:28px}.report-layout-magazine .hero-score strong{font-size:56px}.report-layout-magazine .hero-avatar{position:static;width:120px;height:120px;margin:28px auto 0;display:block}.report-layout-magazine .featured-insight{margin:56px auto 20px;padding:56px 48px;border:0;border-top:1px solid var(--report-border);border-bottom:1px solid var(--report-border)}.report-layout-magazine .featured-insight blockquote{font-family:Georgia,"Noto Serif CJK SC",serif;font-style:italic;font-size:36px}.report-layout-magazine .quote-list{grid-template-columns:1fr;max-width:820px;margin:0 auto}.report-layout-magazine .selected-quote{border-top:1px solid var(--report-border)}.report-layout-magazine .selected-quote blockquote{font-family:Georgia,"Noto Serif CJK SC",serif;font-size:26px;font-style:italic}.report-layout-magazine .editorial-section{grid-template-columns:72px minmax(0,1fr);border-top:1px solid var(--report-border)}.report-layout-magazine .editorial-copy h3{font-size:28px}.report-layout-magazine .final-verdict{min-height:0;padding:72px 0;border-top:3px double var(--report-accent)}.report-layout-magazine .final-verdict h2{font-family:Georgia,"Noto Serif CJK SC",serif;font-size:48px}.report-layout-magazine .report-cover{border-top:4px double var(--report-accent);border-bottom:4px double var(--report-accent)}.report-layout-magazine .report-cover h1{font-family:Georgia,"Noto Serif CJK SC",serif;text-transform:uppercase;font-size:66px}@media (min-width:961px){.report-layout-magazine .editorial-section:not(.editorial-long):not(.editorial-contradiction):not(.editorial-final){display:grid;grid-template-columns:64px minmax(0,1fr);width:auto;vertical-align:top;padding-right:24px}}
.report-layout-bento .composition-region{gap:18px}.report-layout-bento .featured-insight{border:1px solid var(--report-border);border-radius:18px;background:var(--report-surface);margin:36px 0 8px;padding:48px 40px}.report-layout-bento .quote-list{grid-template-columns:1fr}.report-layout-bento .selected-quote{padding:24px 0;border-top:1px solid var(--report-border)}.report-layout-bento .transcript-item,.report-layout-bento .editorial-answer{border-top:1px solid var(--report-border)}
html .report-layout-gallery{--report-bg:#0a0a0c;--report-surface:#141417;--report-border:#26262b}.report-layout-gallery .hero{min-height:0;display:block;text-align:center;padding:56px 0 48px;border:0}.report-layout-gallery .hero h1{font-size:44px;letter-spacing:.04em}.report-layout-gallery .hero-score{border-left:0;text-align:center;padding:0;margin-top:24px}.report-layout-gallery .hero-score strong{font-size:64px}.report-layout-gallery .report-cover{min-height:58vh;border:0}.report-layout-gallery .gallery-item img{border-radius:6px}.report-layout-gallery .gallery-item figcaption{text-align:center;font-size:13px;letter-spacing:.06em}.report-layout-gallery .final-verdict{min-height:0;padding:64px 0;border-top:1px solid var(--report-border)}.report-layout-gallery .final-verdict h2{font-size:40px}
.report-layout-profile .hero{min-height:0;grid-template-columns:200px minmax(0,1fr) 200px;align-items:center;gap:34px;padding:44px 0;border-top:2px solid var(--report-accent);border-bottom:2px solid var(--report-accent)}.report-layout-profile .hero-avatar{position:static;width:160px;height:160px;border-radius:10px;border:2px solid var(--report-accent)}.report-layout-profile .hero h1{font-family:Georgia,"Noto Serif CJK SC",serif;letter-spacing:.04em;font-size:34px}.report-layout-profile .hero-score{border-left:2px solid var(--report-accent);padding-left:26px;text-align:left}.report-layout-profile .report-cover{min-height:56vh;border-top:2px solid var(--report-accent);border-bottom:2px solid var(--report-accent)}`;
}

/**
 * Renders a template with a real layout through the composition engine for
 * the open Web (responsive) and the A4 PDF archive. Used by
 * buildResponsiveReportHtml when a template declares a layout.
 */
export function buildResponsiveCompositionReport(
  view: ReportViewModel,
  meta: { surveyTitle?: string; completedAt?: string; reportId?: string; watermark?: string },
  template: ReportTemplateSpec,
): string {
  const layout = template.layout ?? selectReportLayout(view, template.layout ? { layout: template.layout } : {});
  const theme = reportThemes[template.theme];
  const composition = renderComposition(view, layout, themeChartColors(template.theme), template.blocks);
  const title = view.hero.title || meta.surveyTitle || "问卷结果报告";
  const metaLine = [meta.surveyTitle, meta.completedAt, meta.reportId].filter(Boolean).map((value) => escapeHtml(text(value))).join(" · ");
  const watermark = `<div class="report-watermark">${escapeHtml(meta.watermark ?? "更多问卷 @hnhgggfj_bot")}</div>`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root{--report-bg:#f4f6fa;--report-surface:#fff;--report-border:#e5e9f0}
    @media (prefers-color-scheme: dark){:root{--report-bg:#0f172a;--report-surface:#131c2e;--report-border:#26334d}}
    ${responsiveCompositionCss()}
    .report-watermark{margin-top:18px;padding-top:16px;border-top:1px dashed var(--report-border);font-size:12px;color:var(--report-text-muted);text-align:center;letter-spacing:.02em;opacity:.9}
  </style>
  <style>${themeCss(theme)}${template.css ?? ""}</style>
</head>
<body>
  <div class="report-layout-${layout} density-${composition.density}" data-report-layout="${layout}" data-report-theme="${theme.id}">
    <main class="page">
      ${composition.html}
      <footer class="report-metadata">${metaLine || "本报告由问卷回答自动整理生成"}</footer>
      ${watermark}
    </main>
  </div>
</body>
</html>`;
}

function partialResponses(content: PreparedReportContent, block: Extract<ReportPageBlock, { kind: "responses" }>): PreparedReportContent {
  const { featuredAnswer: _featuredAnswer, ...base } = content;
  return {
    ...base,
    ...(block.featured ? { featuredAnswer: block.featured } : {}),
    editorialAnswers: block.editorial,
    compactAnswers: block.compact,
  };
}

function renderAnswerValue(
  item: ReportAnswerItem,
  context: { escape(value: string): string },
): string {
  if (item.options?.length) {
    const options = item.options
      .map(
        (option) =>
          `<div class="answer-option${option.selected ? " selected" : ""}">` +
          `<span class="option-mark">${option.selected ? "✓" : "○"}</span>` +
          `<span>${context.escape(option.label)}</span></div>`,
      )
      .join("");
    return `<div class="answer-options">${options}</div>${
      item.value ? `<div class="answer">${context.escape(item.value)}</div>` : ""
    }`;
  }
  return item.value ? `<div class="answer">${context.escape(item.value)}</div>` : "";
}

/** Full Q&A transcript: every answered question with options and selection. */
function renderFullTranscript(
  view: ReportViewModel,
  context: { escape(value: string): string },
): string {
  if (!view.profile.length) return "";
  return `<section class="responses-composition block block-responses block-transcript">
    <header class="chapter-heading"><span>FULL TRANSCRIPT</span><h2>完整问答</h2></header>
    <div class="transcript-list">
      ${view.profile
        .map(
          (item, index) =>
            `<article class="transcript-item"><div class="response-index">Q${String(index + 1).padStart(2, "0")}</div>` +
            `<div class="question">${context.escape(item.label)}</div>` +
            `${renderAnswerValue(item, context)}</article>`,
        )
        .join("")}
    </div>
  </section>`;
}

function renderCoverComposition(view: ReportViewModel): string {
  const meta = [view.meta.surveyTitle, view.meta.submittedAt, view.meta.reportId]
    .filter(Boolean)
    .map((value) => escapeHtml(text(value)))
    .join(" · ");
  return `<section class="report-cover block block-cover">
    <div class="cover-inner">
      <p class="cover-kicker">RESULT REPORT</p>
      <h1>${escapeHtml(text(view.hero.title))}</h1>
      ${view.hero.subtitle ? `<p class="cover-subtitle">${escapeHtml(text(view.hero.subtitle))}</p>` : ""}
      ${view.hero.tags.length ? `<div class="cover-tags">${view.hero.tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}</div>` : ""}
      ${meta ? `<div class="cover-meta">${meta}</div>` : ""}
    </div>
  </section>`;
}

function renderPlannedBlock(
  block: ReportPageBlock,
  view: ReportViewModel,
  content: PreparedReportContent,
  colors: { accent: string; text: string; muted: string; border: string },
): string {
  const primaryScore = view.scores[0];
  const context = { escape: escapeHtml, limit: limitText };
  switch (block.kind) {
    case "hero": {
      const thesis = /问卷完成|自动整理|根据本次问卷/.test(view.hero.subtitle) ? content.featuredInsight?.text ?? view.hero.title : view.hero.subtitle;
      return renderHeroBlock({ title: view.hero.title, thesis, tags: view.hero.tags, ...(view.hero.avatar ? { avatar: view.hero.avatar } : {}), ...(primaryScore ? { primaryScore } : {}) }, context);
    }
    case "overview": return renderOverview(view, colors);
    case "featured": return renderFeaturedInsightBlock(block.item, context);
    case "analysis": return renderEditorialAnalysisBlock(block.items, context);
    case "quotes": return renderQuoteBlock(block.items, context);
    case "responses": return renderSelectedResponses(partialResponses(content, block), { escape: escapeHtml });
    case "gallery": return renderGalleryBlock(block.items, { escape: escapeHtml });
    case "verdict": return renderFinalVerdictBlock(content.verdict, primaryScore, context);
  }
}

function htmlShell(body: string, layout: ReportLayout, themeId: ReportTheme, density: string, page?: ReportPage, totalPages?: number): string {
  const theme = reportThemes[themeId];
  const pageClass = page ? " class=\"report-page-shell\"" : "";
  const folio = page ? `<div class="page-folio">${escapeHtml(page.id.toUpperCase())} / ${String(totalPages ?? 1).padStart(2, "0")}</div>` : "";
  return `<!doctype html><html${pageClass}><head><meta charset="utf-8"><style>${themeCss(theme)}${reportCss()}</style></head><body><div class="report-layout-${layout} density-${density}" data-report-layout="${layout}" data-report-theme="${theme.id}"${page ? ` data-report-page="${page.id}" data-page-kind="${page.kind}"` : ""}><main class="page">${body}${folio}</main></div></body></html>`;
}

export interface PlannedHtmlReport {
  view: ReportViewModel;
  content: PreparedReportContent;
  layout: ReportLayout;
  theme: ReportTheme;
  pages: Array<{ page: ReportPage; html: string }>;
}

export function buildHtmlReportPages(
  profile: ResultProfileSnapshot,
  templateName: string,
  images: Record<string, string> = {},
  options: ReportLayoutOptions = {},
  policy: ReportSizePolicy = DEFAULT_REPORT_SIZE_POLICY,
): PlannedHtmlReport {
  const view = buildReportViewModel(profile, images);
  const layout = options.layout ?? view.meta.layout ?? layoutHintFromTemplateName(templateName) ?? selectReportLayout(view, options);
  const theme = options.theme ?? view.meta.theme ?? themeHintFromTemplateName(templateName);
  const content = prepareReportContent(view);
  view.gallery = selectGalleryForPolicy(view.gallery, content.densityMode);
  const planned = planReportPages(view, content, policy);
  const pages = planned.map((page) => ({
    page,
    html: htmlShell(page.blocks.map((block) => `<div class="composition-region composition-region-${block.kind}"><div class="composition-block" data-block="${block.kind}">${renderPlannedBlock(block, view, content, themeChartColors(theme))}</div></div>`).join(""), layout, theme, content.densityMode, page, planned.length),
  }));
  return { view, content, layout, theme, pages };
}

export async function optimizeReportImagesInPage(
  page: Awaited<ReturnType<Awaited<ReturnType<typeof puppeteer.launch>>["newPage"]>>,
  images: Record<string, string>,
  policy: Pick<ReportSizePolicy, "maxImageDimension">,
): Promise<Record<string, string>> {
  if (!Object.keys(images).length) return images;
  try {
    const payload = JSON.stringify({ images, galleryMax: policy.maxImageDimension.gallery, heroMax: policy.maxImageDimension.hero }).replaceAll("<", "\\u003c");
    const optimized = await page.evaluate(`(async()=>{const payload=${payload};const output={};const cache=new Map();for(const [key,source] of Object.entries(payload.images)){if(!source.startsWith("data:image/")){output[key]=source;continue}const max=/avatar|portrait|profilePhoto|front_image/.test(key)?payload.heroMax:payload.galleryMax;const cacheKey=max+":"+source;if(cache.has(cacheKey)){output[key]=cache.get(cacheKey);continue}const image=new Image();await new Promise(resolve=>{image.onload=resolve;image.onerror=resolve;image.src=source});if(!image.naturalWidth||!image.naturalHeight){output[key]=source;cache.set(cacheKey,source);continue}const scale=Math.min(1,max/Math.max(image.naturalWidth,image.naturalHeight));const canvas=document.createElement("canvas");canvas.width=Math.max(1,Math.round(image.naturalWidth*scale));canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));canvas.getContext("2d")?.drawImage(image,0,0,canvas.width,canvas.height);const result=canvas.toDataURL("image/webp",.84);output[key]=result;cache.set(cacheKey,result)}return output})()`);
    return optimized && typeof optimized === "object" ? optimized as Record<string, string> : images;
  } catch (error) {
    console.warn("Report image optimization skipped", { error });
    return images;
  }
}

export async function renderHtmlReportArtifact(
  browserBinding: BrowserWorker,
  profile: ResultProfileSnapshot,
  templateName: string,
  images: Record<string, string> = {},
  options: ReportLayoutOptions = {},
  policy: ReportSizePolicy = DEFAULT_REPORT_SIZE_POLICY,
): Promise<ReportArtifact> {
  const browser = await puppeteer.launch(browserBinding);
  const failures: ReportArtifact["failures"] = [];
  try {
    const optimizerPage = await browser.newPage();
    const optimizedImages = await optimizeReportImagesInPage(optimizerPage, images, policy);
    const report = buildHtmlReportPages(profile, templateName, optimizedImages, options, policy);
    const pages: ReportArtifact["pages"] = [];
    for (const planned of report.pages) {
      let rendered: Uint8Array | undefined;
      let renderedDpr = policy.preferredDpr;
      let lastError: unknown;
      const attempts: Array<{ dpr: number; format: "png" | "jpeg"; byteSize?: number; message?: string }> = [];
      let renderedFormat: "png" | "jpeg" = "png";
      let rawByteSize = 0;
      const imageItems = planned.page.blocks.flatMap((block) => block.kind === "gallery" ? block.items : []);
      const imageCount = imageItems.length + (planned.page.blocks.some((block) => block.kind === "hero") && report.view.hero.avatar ? 1 : 0);
      const embeddedImageBytes = imageItems.reduce((sum, item) => sum + (item.byteSize ?? reportImageByteSize(item.url)), 0) + (planned.page.blocks.some((block) => block.kind === "hero") && report.view.hero.avatar ? reportImageByteSize(report.view.hero.avatar) : 0);
      const htmlByteSize = new TextEncoder().encode(planned.html).byteLength;
      const maxAttempts = imageCount > 0 ? 3 : 2;
      for (let attempt = 0; attempt < maxAttempts && !rendered; attempt += 1) {
        const dpr = attempt === 0 ? policy.preferredDpr : policy.fallbackDpr;
        const format: "png" | "jpeg" = attempt === 2 || imageCount >= 3 ? "jpeg" : "png";
        try {
          const page = await browser.newPage();
          if (htmlByteSize > policy.maxHtmlBytesPerPage) throw new Error(`page HTML exceeds ${policy.maxHtmlBytesPerPage} bytes`);
          if (embeddedImageBytes > policy.maxEmbeddedImageBytesPerPage) throw new Error(`embedded images exceed ${policy.maxEmbeddedImageBytesPerPage} bytes`);
          await page.setViewport({ width: policy.pageWidth, height: policy.maxPageHeight, deviceScaleFactor: dpr });
          await page.setContent(planned.html, { waitUntil: "load" });
          await page.evaluate("document.fonts ? document.fonts.ready : Promise.resolve()");
          await page.evaluate("Promise.all(Array.from(document.images).map((image) => image.complete ? Promise.resolve() : new Promise((resolve) => { image.addEventListener('load', resolve, { once: true }); image.addEventListener('error', resolve, { once: true }); })))");
          const overflow = await page.evaluate("(()=>{const page=document.querySelector('.page');return page ? page.scrollHeight > page.clientHeight : true})()");
          if (overflow) {
            await page.evaluate("document.querySelectorAll('.composition-region').forEach((node)=>node.style.setProperty('margin-top','12px','important'));document.querySelectorAll('.editorial-section').forEach((node)=>node.style.setProperty('padding-top','14px','important'));document.querySelectorAll('.editorial-copy p,.answer').forEach((node)=>node.style.setProperty('font-size','15px','important'));");
            const compactOverflow = await page.evaluate("(()=>{const page=document.querySelector('.page');return page ? page.scrollHeight > page.clientHeight : true})()");
            if (compactOverflow) throw new Error(`planned page exceeds ${policy.maxPageHeight}px after compact render`);
          }
          const candidate = new Uint8Array(await page.screenshot(format === "jpeg" ? { type: "jpeg", quality: 88, captureBeyondViewport: false } : { type: "png", captureBeyondViewport: false }));
          attempts.push({ dpr, format, byteSize: candidate.byteLength });
          if (!rawByteSize) rawByteSize = candidate.byteLength;
          if (candidate.byteLength > policy.targetPageBytes && (attempt === 0 || imageCount > 0 && format === "png")) continue;
          if (candidate.byteLength > policy.hardMaxPageBytes) throw new Error(`page image exceeds ${policy.hardMaxPageBytes} bytes`);
          rendered = candidate;
          renderedDpr = dpr;
          renderedFormat = format;
        } catch (error) { lastError = error; attempts.push({ dpr, format, message: error instanceof Error ? error.message : String(error) }); }
      }
      if (!rendered) {
        const message = lastError instanceof Error ? lastError.message : String(lastError ?? "page rendering failed");
        const stage = /exceeds/.test(message) ? "size_limit" : /memory/i.test(message) ? "browser_memory" : /screenshot/i.test(message) ? "browser_screenshot" : "render";
        failures.push({ pageId: planned.page.id, stage, message, attempts });
        console.error("[ReportPage] render failed", { page: planned.page.id, type: planned.page.kind, htmlBytes: htmlByteSize, imageCount, embeddedImageBytes, width: policy.pageWidth, height: policy.maxPageHeight, attempts, error: message });
        continue;
      }
      const width = Math.round(policy.pageWidth * renderedDpr); const height = Math.round(policy.maxPageHeight * renderedDpr);
      pages.push({ id: planned.page.id, kind: planned.page.kind, bytes: rendered, size: rendered.byteLength, width, height, pixelCount: width * height, dpr: renderedDpr, format: renderedFormat, type: renderedFormat === "jpeg" ? "image/jpeg" : "image/png", rawByteSize, optimizedByteSize: rendered.byteLength, ...(renderedFormat === "jpeg" ? { compressionLevel: 88 } : {}), containsImages: imageCount > 0, imageCount, embeddedImageBytes, htmlByteSize, estimatedComplexity: planned.page.estimatedHeight + imageCount * 200, deliveryMode: rendered.byteLength <= policy.targetPageBytes ? "photo" : "document", optimizationAttempts: attempts.length - 1, finalStatus: "ready" });
    }
    if (!pages.length) throw new Error(`all report pages failed: ${failures.map((failure) => `${failure.pageId}: ${failure.message}`).join("; ")}`);
    let selectedPages = pages;
    let totalBytes = selectedPages.reduce((sum, page) => sum + page.size, 0);
    if (totalBytes > policy.maxTotalBytes) {
      const priority = new Map(report.pages.map((entry) => [entry.page.id, entry.page.priority]));
      const essentialPageIds = new Set(report.pages.filter((entry) => entry.page.blocks.some((block) => block.kind === "hero" || block.kind === "verdict")).map((entry) => entry.page.id));
      const removable = selectedPages.filter((page) => !essentialPageIds.has(page.id)).sort((left, right) => (priority.get(left.id) ?? 0) - (priority.get(right.id) ?? 0));
      const removed = new Set<string>();
      for (const page of removable) {
        if (totalBytes <= policy.maxTotalBytes) break;
        removed.add(page.id);
        totalBytes -= page.size;
        failures.push({ pageId: page.id, stage: "size_limit", message: "omitted by total report size policy" });
      }
      selectedPages = selectedPages.filter((page) => !removed.has(page.id));
    }
    let archivePdf: Uint8Array | undefined;
    try {
      const pdfPage = await browser.newPage();
      await pdfPage.setViewport({ width: policy.pageWidth, height: policy.maxPageHeight, deviceScaleFactor: 1 });
      await pdfPage.setContent(buildHtmlReport(profile, templateName, optimizedImages, options), { waitUntil: "load" });
      await pdfPage.evaluate("document.fonts ? document.fonts.ready : Promise.resolve()");
      await pdfPage.evaluate("Promise.all(Array.from(document.images).map((image) => image.complete ? Promise.resolve() : new Promise((resolve) => { image.addEventListener('load', resolve, { once: true }); image.addEventListener('error', resolve, { once: true }); })))");
      archivePdf = new Uint8Array(await pdfPage.pdf({ format: "A4", printBackground: true, margin: { top: "10mm", right: "10mm", bottom: "10mm", left: "10mm" } }));
    } catch (error) {
      console.error("[ReportPDF] archive rendering failed", { error });
    }
    const deliveryMode = selectedPages.length === 1 ? "single" : selectedPages.length > 10 ? "split" : selectedPages.every((page) => page.deliveryMode === "photo") ? "album" : "multi_document";
    return { pages: selectedPages, ...(archivePdf ? { archivePdf, archivePdfSize: archivePdf.byteLength } : {}), totalPages: report.pages.length, totalBytes, deliveryMode, failures };
  } finally { await browser.close(); }
}

export async function renderHtmlReportPng(browserBinding: BrowserWorker, profile: ResultProfileSnapshot, templateName: string, images: Record<string, string> = {}, options: ReportLayoutOptions = {}): Promise<Uint8Array> {
  const artifact = await renderHtmlReportArtifact(browserBinding, profile, templateName, images, options);
  return artifact.pages[0]!.bytes;
}

export async function renderHtmlReportPdf(browserBinding: BrowserWorker, profile: ResultProfileSnapshot, templateName: string, images: Record<string, string> = {}, options: ReportLayoutOptions = {}): Promise<Uint8Array> {
  const browser = await puppeteer.launch(browserBinding);
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
    await page.setContent(buildHtmlReport(profile, templateName, images, options), { waitUntil: "load" });
    await page.evaluate("document.fonts ? document.fonts.ready : Promise.resolve()");
    await page.evaluate("Promise.all(Array.from(document.images).map((image) => image.complete ? Promise.resolve() : new Promise((resolve) => { image.addEventListener('load', resolve, { once: true }); image.addEventListener('error', resolve, { once: true }); })))");
    return new Uint8Array(await page.pdf({ format: "A4", printBackground: true, margin: { top: "10mm", right: "10mm", bottom: "10mm", left: "10mm" } }));
  } finally { await browser.close(); }
}
