import type { ReportFragment, ResponseReport, ResponseReportDensity, ResponseReportItem, ResponseReportMedia, ResponseReportPage } from "./model";
import { validateResponseReportPages, validateResponseReportSource } from "./validation";

const PAGE_CONTENT_HEIGHT = 742;

export function responseReportDensity(report: ResponseReport): ResponseReportDensity {
  if (report.density) return report.density;
  if (report.items.length >= 100) return "compact";
  return "standard";
}

function splitTextLossless(value: string, maxCharacters: number): string[] {
  if (value.length <= maxCharacters) return [value];
  const parts: string[] = [];
  let start = 0;
  while (start < value.length) {
    let end = Math.min(value.length, start + maxCharacters);
    if (end < value.length) {
      const window = value.slice(start, end);
      const boundary = Math.max(window.lastIndexOf("\n"), window.lastIndexOf("。") + 1, window.lastIndexOf("！") + 1, window.lastIndexOf("？") + 1);
      if (boundary > maxCharacters * 0.55) end = start + boundary;
    }
    parts.push(value.slice(start, end));
    start = end;
  }
  return parts;
}

function mediaChunks(media: ResponseReportMedia[], size: number): ResponseReportMedia[][] {
  const chunks: ResponseReportMedia[][] = [];
  for (let index = 0; index < media.length; index += size) chunks.push(media.slice(index, index + size));
  return chunks;
}

function optionChunkSize(item: ResponseReportItem): number {
  if (item.type === "matrix") return Math.max(4, Math.min(9, Math.floor(45 / Math.max(5, item.matrixColumns?.length ?? 5)) + 2));
  if (item.options.some((option) => option.media.length > 0)) return 3;
  const longest = Math.max(0, ...item.options.map((option) => Array.from(option.label).length));
  return longest <= 24 ? 12 : longest <= 70 ? 8 : 4;
}

function splitItem(item: ResponseReportItem): ReportFragment[] {
  const fragments: ReportFragment[] = [];
  const titleParts = splitTextLossless(item.title, 420);
  const descriptionParts = item.description ? splitTextLossless(item.description, 760) : [];
  const questionMediaChunks = mediaChunks(item.questionMedia, 2);
  if (item.options.length) {
    if (item.type === "matrix") {
      const rowChunkSize = optionChunkSize(item);
      const columnCount = item.matrixColumns?.length ?? 0;
      for (let columnStart = 0; columnStart < columnCount; columnStart += 10) {
        for (let rowStart = 0; rowStart < item.options.length; rowStart += rowChunkSize) fragments.push({ item, continuation: fragments.length > 0, continuesAfter: true, title: fragments.length ? "" : item.title, description: "", questionMedia: [], answerMedia: [], optionStart: rowStart, optionEnd: Math.min(item.options.length, rowStart + rowChunkSize), matrixColumnStart: columnStart, matrixColumnEnd: Math.min(columnCount, columnStart + 10) });
      }
    } else if (item.options.some((option) => option.media.length > 3)) {
      for (let optionIndex = 0; optionIndex < item.options.length; optionIndex += 1) {
        const option = item.options[optionIndex]!;
        const chunks = mediaChunks(option.media, 3);
        for (const chunk of chunks.length ? chunks : [[]]) fragments.push({ item, continuation: fragments.length > 0, continuesAfter: true, title: fragments.length ? "" : item.title, description: "", questionMedia: [], answerMedia: [], optionStart: optionIndex, optionEnd: optionIndex + 1, optionMediaById: { [String(option.id)]: chunk } });
      }
    } else {
      const chunkSize = optionChunkSize(item);
      for (let start = 0; start < item.options.length; start += chunkSize) fragments.push({ item, continuation: fragments.length > 0, continuesAfter: true, title: fragments.length ? "" : item.title, description: "", questionMedia: [], answerMedia: [], optionStart: start, optionEnd: Math.min(item.options.length, start + chunkSize) });
    }
  } else {
    for (const answer of splitTextLossless(item.answer, 920)) fragments.push({ item, continuation: fragments.length > 0, continuesAfter: true, title: fragments.length ? "" : item.title, description: "", answer, answerStart: fragments.length === 0, questionMedia: [], answerMedia: [] });
  }
  const headingTitle = titleParts.shift() ?? item.title;
  const headingDescription = descriptionParts.shift() ?? item.description ?? "";
  if (questionMediaChunks.length) {
    const mediaFragments = questionMediaChunks.map((chunk, index) => ({ item, continuation: index > 0, continuesAfter: true, title: index ? "" : headingTitle, description: index ? "" : headingDescription, questionMedia: chunk, answerMedia: [], optionStart: 0, optionEnd: 0 } satisfies ReportFragment));
    for (const fragment of fragments) { fragment.continuation = true; fragment.title = ""; fragment.description = ""; }
    fragments.unshift(...mediaFragments);
  } else {
    const first = fragments[0]!;
    first.title = headingTitle;
    first.description = headingDescription;
  }
  const headingContinuations: ReportFragment[] = [
    ...titleParts.map((title) => ({ item, continuation: true, continuesAfter: true, title, description: "", questionMedia: [], answerMedia: [], optionStart: 0, optionEnd: 0 })),
    ...descriptionParts.map((description) => ({ item, continuation: true, continuesAfter: true, title: "", description, questionMedia: [], answerMedia: [], optionStart: 0, optionEnd: 0 })),
  ];
  if (!questionMediaChunks.length && headingContinuations.length) {
    fragments[0]!.title = "";
    fragments[0]!.description = "";
    fragments[0]!.continuation = true;
    fragments.unshift({ item, continuation: false, continuesAfter: true, title: headingTitle, description: headingDescription, questionMedia: [], answerMedia: [], optionStart: 0, optionEnd: 0 });
  }
  fragments.splice(1, 0, ...headingContinuations);
  for (const chunk of mediaChunks(item.answerMedia, 3)) fragments.push({ item, continuation: fragments.length > 0, continuesAfter: true, title: fragments.length ? "" : item.title, description: "", questionMedia: [], answerMedia: chunk, optionStart: item.options.length, optionEnd: item.options.length });
  if (!fragments.length) fragments.push({ item, continuation: false, continuesAfter: false, questionMedia: [], answerMedia: [] });
  fragments[fragments.length - 1]!.continuesAfter = false;
  return fragments;
}

function lines(value: string, charsPerLine: number): number {
  return value.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(Array.from(line).length / charsPerLine)), 0);
}

export function estimateResponseFragmentHeight(fragment: ReportFragment, density: ResponseReportDensity): number {
  const spacing = density === "compact" ? 0.86 : density === "comfortable" ? 1.14 : 1;
  const item = fragment.item;
  const options = item.options.slice(fragment.optionStart ?? 0, fragment.optionEnd ?? item.options.length);
  let height = 70 + lines(fragment.title ?? item.title, 62) * 25 + (fragment.description ? lines(fragment.description, 74) * 21 : 0);
  height += (fragment.questionMedia?.length ?? 0) * 190;
  if (fragment.answer !== undefined) height += 42 + lines(fragment.answer, 76) * 23;
  if (item.type === "matrix" && options.length) height += 56 + options.reduce((sum, option) => sum + Math.max(42, lines(option.label, 22) * 20 + 18), 0);
  else height += options.reduce((sum, option) => sum + Math.max(38, lines(option.label, 46) * 20 + 14) + (fragment.optionMediaById?.[String(option.id)] ?? option.media).length * 160, 0);
  height += (fragment.answerMedia?.length ?? 0) * 190;
  return Math.ceil(height * spacing);
}

export function planResponseReportPages(report: ResponseReport): ResponseReportPage[] {
  validateResponseReportSource(report);
  const density = responseReportDensity(report);
  const pages: Array<{ fragments: ReportFragment[]; estimatedHeight: number }> = [];
  for (const item of report.items) for (const fragment of splitItem(item)) {
    const height = estimateResponseFragmentHeight(fragment, density);
    if (height > PAGE_CONTENT_HEIGHT) throw new Error(`Page split validation failed: question ${item.questionId} fragment still exceeds page budget`);
    let page = pages.at(-1);
    const pageBudget = pages.length <= 1 ? PAGE_CONTENT_HEIGHT - 120 : PAGE_CONTENT_HEIGHT;
    if (!page || page.estimatedHeight + height > pageBudget) { page = { fragments: [], estimatedHeight: 0 }; pages.push(page); }
    page.fragments.push(fragment);
    page.estimatedHeight += height;
  }
  if (!pages.length) pages.push({ fragments: [], estimatedHeight: 0 });
  const planned = pages.map((page, index) => ({ number: index + 1, total: pages.length, fragments: page.fragments, estimatedHeight: page.estimatedHeight }));
  validateResponseReportPages(report, planned);
  return planned;
}
