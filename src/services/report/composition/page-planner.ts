import type { PreparedReportContent, ReportAnswerItem, ReportGalleryItem, ReportPage, ReportPageBlock, ReportPageKind, ReportTextItem, ReportViewModel } from "../model";
import { DEFAULT_REPORT_SIZE_POLICY, type ReportSizePolicy } from "../size-policy";

const lineHeight = 29;
const charactersPerLine = 52;

export function reportDensityMode(answerCount: number): PreparedReportContent["densityMode"] {
  if (answerCount < 30) return "compact";
  if (answerCount < 80) return "standard";
  if (answerCount < 150) return "extended";
  return "large";
}

function textHeight(value: string, base = 110): number {
  return base + Math.ceil(value.length / charactersPerLine) * lineHeight;
}

export function estimateReportBlockHeight(block: ReportPageBlock): number {
  return block.estimatedHeight;
}

function splitText(value: string, maxCharacters: number): string[] {
  if (value.length <= maxCharacters) return [value];
  const chunks: string[] = [];
  let remaining = value.trim();
  while (remaining.length > maxCharacters) {
    const window = remaining.slice(0, maxCharacters + 1);
    const candidates = [window.lastIndexOf("。"), window.lastIndexOf("！"), window.lastIndexOf("？"), window.lastIndexOf("\n")];
    const boundary = Math.max(...candidates);
    const splitAt = boundary > maxCharacters * .55 ? boundary + 1 : maxCharacters;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function splitEditorialItem(item: ReportTextItem, maxCharacters = 980): ReportTextItem[] {
  return splitText(item.text, maxCharacters).map((part, index, all) => {
    const { tags, ...base } = item;
    return {
      ...base,
      id: `${item.id}-part-${index + 1}`,
      title: index === 0 ? item.title : `${item.title} · continued`,
      text: part,
      sourceId: item.sourceId,
      ...(all.length === 1 && tags ? { tags } : {}),
    };
  });
}

function responseHeight(featured: ReportAnswerItem | undefined, editorial: ReportAnswerItem[], compact: ReportAnswerItem[]): number {
  return 95 + (featured ? textHeight(featured.value, 100) : 0) + (editorial.length ? Math.max(...editorial.map((item) => textHeight(item.value, 90))) : 0) + (compact.length ? 170 * Math.ceil(compact.length / 4) : 0);
}

function pageKind(block: ReportPageBlock): ReportPageKind {
  if (block.kind === "hero") return "cover";
  if (block.kind === "featured" || block.kind === "analysis") return "analysis";
  if (block.kind === "quotes" || block.kind === "responses") return "responses";
  return block.kind;
}

export function planReportPages(
  view: ReportViewModel,
  content: PreparedReportContent,
  policy: ReportSizePolicy = DEFAULT_REPORT_SIZE_POLICY,
): ReportPage[] {
  const budget = policy.maxPageHeight - policy.pagePaddingY;
  const candidates: ReportPageBlock[] = [];
  candidates.push({ id: "hero", kind: "hero", priority: 100, estimatedHeight: 320 });
  if (view.scores.length || view.tags.length) candidates.push({ id: "overview", kind: "overview", priority: 90, estimatedHeight: view.scores.length >= 3 ? 430 : 260 });
  if (content.featuredInsight) candidates.push({ id: "featured", kind: "featured", priority: 90, estimatedHeight: Math.min(330, textHeight(content.featuredInsight.text, 170)), item: content.featuredInsight });
  for (const item of content.analysis.flatMap((entry) => splitEditorialItem(entry))) {
    candidates.push({ id: `analysis-${item.id}`, kind: "analysis", priority: /Core Personality/i.test(item.title) ? 95 : /Contradiction/i.test(item.title) ? 90 : 85, estimatedHeight: Math.min(budget, textHeight(item.text, 170)), items: [item] });
  }
  if (content.quotes.length) candidates.push({ id: "quotes", kind: "quotes", priority: 80, estimatedHeight: Math.min(520, 120 + Math.max(...content.quotes.map((item) => textHeight(item.text, 80)))), items: content.quotes });
  if (content.featuredAnswer) {
    candidates.push({ id: "featured-response", kind: "responses", priority: 75, estimatedHeight: responseHeight(content.featuredAnswer, [], []), featured: content.featuredAnswer, editorial: [], compact: [] });
  }
  if (content.editorialAnswers.length) {
    candidates.push({ id: "editorial-responses", kind: "responses", priority: 70, estimatedHeight: responseHeight(undefined, content.editorialAnswers, []), editorial: content.editorialAnswers, compact: [] });
  }
  const compactAnswers = view.contentStats.answerCount <= 10 ? [] : content.compactAnswers;
  for (let offset = 0; offset < compactAnswers.length; offset += 8) {
    const compact = compactAnswers.slice(offset, offset + 8);
    candidates.push({ id: `compact-responses-${offset / 8 + 1}`, kind: "responses", priority: 55, estimatedHeight: responseHeight(undefined, [], compact), editorial: [], compact });
  }
  const galleryItems = view.gallery.filter((item) => item.url !== view.hero.avatar);
  for (let offset = 0; offset < galleryItems.length; offset += policy.maxImagesPerPage) {
    const items = galleryItems.slice(offset, offset + policy.maxImagesPerPage);
    const rows = Math.ceil(items.length / (items.length <= 2 ? 2 : 3));
    candidates.push({ id: `gallery-${offset / policy.maxImagesPerPage + 1}`, kind: "gallery", priority: offset === 0 ? 75 : 50, estimatedHeight: 110 + rows * 300, items });
  }
  candidates.push({ id: "verdict", kind: "verdict", priority: 100, estimatedHeight: 680 });

  const pages: ReportPage[] = [];
  let current: ReportPage | undefined;
  const startPage = (block: ReportPageBlock): ReportPage => ({ id: `page-${String(pages.length + 1).padStart(2, "0")}`, kind: pageKind(block), blocks: [], estimatedHeight: 0, priority: block.priority });
  for (const block of candidates) {
    const leavingCover = current?.kind === "cover" && !["overview", "verdict"].includes(block.kind);
    const semanticBreak = block.kind === "gallery" || block.kind === "verdict" || leavingCover;
    if (!current || semanticBreak || current.estimatedHeight + block.estimatedHeight > budget) {
      if (current?.blocks.length) pages.push(current);
      current = startPage(block);
    }
    current.blocks.push(block);
    current.estimatedHeight += block.estimatedHeight;
    current.priority = Math.max(current.priority, block.priority);
    if (current.blocks.some((entry) => pageKind(entry) !== current!.kind) && !(current.kind === "cover" && current.blocks.every((entry) => entry.kind === "hero" || entry.kind === "overview"))) current.kind = "mixed";
  }
  if (current?.blocks.length) pages.push(current);

  if (pages.length <= policy.maxPages) return pages;
  const essential = pages.filter((page) => page.blocks.some((block) => block.kind === "hero" || block.kind === "verdict"));
  const essentialIds = new Set(essential.map((page) => page.id));
  const selected = pages.filter((page) => !essentialIds.has(page.id)).sort((left, right) => right.priority - left.priority).slice(0, Math.max(0, policy.maxPages - essential.length));
  return [...essential, ...selected]
    .sort((left, right) => Number(left.id.slice(5)) - Number(right.id.slice(5)))
    .map((page, index) => ({ ...page, id: `page-${String(index + 1).padStart(2, "0")}` }));
}

export function selectGalleryForPolicy(items: ReportGalleryItem[], mode: PreparedReportContent["densityMode"]): ReportGalleryItem[] {
  const limits = { compact: 18, standard: 15, extended: 12, large: 12 };
  return items.slice(0, limits[mode]);
}
