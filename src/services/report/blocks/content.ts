import type { ReportMediaMode, ReportScore, ReportTextItem } from "../model";

export interface ContentBlockContext {
  escape(value: string): string;
  limit(value: string, length: number): string;
  /** 渲染介质；缺省 print（分页 PNG/PDF 产物，行为与历史一致）。 */
  mediaMode?: ReportMediaMode;
}

export function renderHeroBlock(
  input: { title: string; thesis: string; avatar?: string; tags: string[]; primaryScore?: ReportScore },
  context: ContentBlockContext,
): string {
  // Same safe-shape rule as the gallery block: hero avatars may only be
  // inline data URLs or same-origin media links, escaped at the attribute.
  const safeAvatarSrc =
    input.avatar && (/^data:image\//i.test(input.avatar) || input.avatar.startsWith("/api/"))
      ? context.escape(input.avatar)
      : "";
  // 首屏主视觉（往往是 LCP 元素）保持 eager 即时加载，两种介质都不挂
  // loading="lazy"（理由同 report/web.ts renderHero 的注释）；弱网/省流量
  // 的降级由 web 壳尾的 weakNetworkDegradeScript 兜底。decoding="async"
  // 对打印产物零行为影响（PDF 侧按 load 事件等图，与解码调度无关）。
  const avatar = safeAvatarSrc
    ? `<img class="hero-avatar" src="${safeAvatarSrc}" alt="用户图片" decoding="async" onerror="this.style.display='none';this.nextElementSibling.style.display='grid'"><div class="media-fallback">图片暂时无法加载</div>`
    : "";
  const tags = input.tags
    .slice(0, 4)
    .map((tag) => `<span class="tag">${context.escape(tag)}</span>`)
    .join("");
  const score = input.primaryScore
    ? `<div class="hero-score"><strong>${context.escape(String(input.primaryScore.value))}</strong><span>${context.escape(input.primaryScore.label)}</span><small>PERSONALITY SCORE</small></div>`
    : "";
  return `<header class="hero block block-hero"><div class="hero-copy"><div class="eyebrow">PERSONAL ANALYSIS</div><h1>${context.escape(input.title)}</h1><div class="hero-thesis">${context.escape(context.limit(input.thesis, 220))}</div>${tags ? `<div class="hero-tags">${tags}</div>` : ""}</div>${score}${avatar}<div style="clear:both"></div></header>`;
}

export function renderFeaturedInsightBlock(item: ReportTextItem | undefined, context: ContentBlockContext): string {
  if (!item) return "";
  return `<section class="featured-insight block block-featured-insight"><div class="chapter-kicker">FEATURED INSIGHT</div><blockquote>“${context.escape(item.text)}”</blockquote><div class="featured-caption">${context.escape(item.title)}</div></section>`;
}

export function renderEditorialAnalysisBlock(items: ReportTextItem[], context: ContentBlockContext): string {
  if (!items.length) return "";
  const sections = items
    .map((item, index) => {
      const number = String(index + 1).padStart(2, "0");
      const long = item.text.length > 520;
      const emphasis = /Contradiction/i.test(item.title)
        ? " editorial-contradiction"
        : /Final Insight/i.test(item.title)
          ? " editorial-final"
          : "";
      return `<article class="editorial-section${long ? " editorial-long" : ""}${emphasis}"><div class="editorial-index">${number}</div><div class="editorial-copy"><div class="editorial-label">${context.escape(item.title.toUpperCase())}</div><h3>${context.escape(item.title)}</h3><p>${context.escape(item.text)}</p></div></article>`;
    })
    .join("");
  return `<section class="editorial-chapter block block-analysis"><header class="chapter-heading"><span>CORE ANALYSIS</span><h2>人格分析</h2></header>${sections}</section>`;
}

export function renderQuoteBlock(items: ReportTextItem[], context: ContentBlockContext): string {
  if (!items.length) return "";
  const body = items
    .map(
      (item, index) =>
        `<article class="selected-quote"><div class="response-index">QUOTE ${String(index + 1).padStart(2, "0")}</div><blockquote>“${context.escape(item.text)}”</blockquote><div class="quote-question">${context.escape(item.title)}</div></article>`,
    )
    .join("");
  return `<section class="quotes-composition block block-quotes"><header class="chapter-heading"><span>SELECTED QUOTES</span><h2>原话摘录</h2></header><div class="quote-list">${body}</div></section>`;
}
