import type { ReportScore, ReportTextItem } from "../model";

export interface ContentBlockContext { escape(value: string): string; limit(value: string, length: number): string; }

export function renderHeroBlock(input: { title: string; thesis: string; avatar?: string; tags: string[]; primaryScore?: ReportScore }, context: ContentBlockContext): string {
  const avatar = input.avatar ? `<img class="hero-avatar" src="${input.avatar}" alt="用户图片" onerror="this.style.display='none';this.nextElementSibling.style.display='grid'"><div class="media-fallback">图片暂时无法加载</div>` : "";
  const tags = input.tags.slice(0, 4).map((tag) => `<span class="tag">${context.escape(tag)}</span>`).join("");
  const score = input.primaryScore ? `<div class="hero-score"><strong>${context.escape(String(input.primaryScore.value))}</strong><span>${context.escape(input.primaryScore.label)}</span><small>PERSONALITY SCORE</small></div>` : "";
  return `<header class="hero block block-hero"><div class="hero-copy"><div class="eyebrow">PERSONAL ANALYSIS</div><h1>${context.escape(input.title)}</h1><div class="hero-thesis">${context.escape(context.limit(input.thesis, 220))}</div>${tags ? `<div class="hero-tags">${tags}</div>` : ""}</div>${score}${avatar}<div style="clear:both"></div></header>`;
}

export function renderFeaturedInsightBlock(item: ReportTextItem | undefined, context: ContentBlockContext): string {
  if (!item) return "";
  return `<section class="featured-insight block block-featured-insight"><div class="chapter-kicker">FEATURED INSIGHT</div><blockquote>“${context.escape(item.text)}”</blockquote><div class="featured-caption">${context.escape(item.title)}</div></section>`;
}

export function renderEditorialAnalysisBlock(items: ReportTextItem[], context: ContentBlockContext): string {
  if (!items.length) return "";
  const sections = items.map((item, index) => {
    const number = String(index + 1).padStart(2, "0");
    const long = item.text.length > 520;
    const emphasis = /Contradiction/i.test(item.title) ? " editorial-contradiction" : /Final Insight/i.test(item.title) ? " editorial-final" : "";
    return `<article class="editorial-section${long ? " editorial-long" : ""}${emphasis}"><div class="editorial-index">${number}</div><div class="editorial-copy"><div class="editorial-label">${context.escape(item.title.toUpperCase())}</div><h3>${context.escape(item.title)}</h3><p>${context.escape(item.text)}</p></div></article>`;
  }).join("");
  return `<section class="editorial-chapter block block-analysis"><header class="chapter-heading"><span>CORE ANALYSIS</span><h2>人格分析</h2></header>${sections}</section>`;
}

export function renderQuoteBlock(items: ReportTextItem[], context: ContentBlockContext): string {
  if (!items.length) return "";
  const body = items.map((item, index) => `<article class="selected-quote"><div class="response-index">QUOTE ${String(index + 1).padStart(2, "0")}</div><blockquote>“${context.escape(item.text)}”</blockquote><div class="quote-question">${context.escape(item.title)}</div></article>`).join("");
  return `<section class="quotes-composition block block-quotes"><header class="chapter-heading"><span>SELECTED QUOTES</span><h2>原话摘录</h2></header><div class="quote-list">${body}</div></section>`;
}
