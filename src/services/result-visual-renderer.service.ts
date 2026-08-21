import { Resvg, initWasm } from "@resvg/resvg-wasm";

import type { ResultField, ResultStat } from "../db/schema";
import type { ResultJsonValue, ResultProfileSnapshot } from "../result/schema";
import type { VisualReportLayout, VisualReportSection, VisualTemplateDefinition, VisualTemplateElement } from "../visual-template/schema";

export interface ResultVisualRendererOptions {
  wasmModule: WebAssembly.Module;
  fontBuffers: Uint8Array[];
  images?: Record<string, string>;
}

export const TEMPLATE_BACKGROUND_IMAGE_KEY = "template.background_asset";
export const MAX_RESULT_VISUAL_HEIGHT = 16_384;
export const MAX_RESULT_VISUAL_PIXELS = 24_000_000;

interface RenderContext {
  result: {
    title: string | null;
    subtitle: string | null;
    resultType: string;
    fields: Record<string, ResultJsonValue>;
    stats: ResultStat[];
    tags: string[];
    images: Record<string, ResultJsonValue>;
    metadata: Record<string, ResultJsonValue>;
  };
}

let wasmInitialization: Promise<void> | null = null;

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value: string): string {
  return escapeXml(value).replaceAll("\n", "&#10;").replaceAll("\r", "");
}

function buildContext(profile: ResultProfileSnapshot): RenderContext {
  const fields: Record<string, ResultJsonValue> = {};
  for (const [fieldId, field] of Object.entries(profile.fields)) {
    fields[fieldId] = field.value as ResultJsonValue;
  }
  return {
    result: {
      title: profile.title,
      subtitle: profile.subtitle,
      resultType: profile.resultType,
      fields,
      stats: profile.stats,
      tags: profile.tags,
      images: profile.images,
      metadata: profile.metadata,
    },
  };
}

function resolvePath(context: RenderContext, path: string): ResultJsonValue | undefined {
  const segments = path.split(".");
  let value: unknown = context;
  for (const segment of segments) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value as ResultJsonValue | undefined;
}

function formatValue(value: ResultJsonValue | undefined): string {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.map(formatValue).filter(Boolean).join(" · ");
  if (typeof value === "object") return "";
  return String(value);
}

function interpolate(value: string, context: RenderContext): string {
  return value.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_match, path: string) =>
    formatValue(resolvePath(context, path)),
  );
}

function numericValue(value: string | number | undefined, context: RenderContext): number | null {
  const resolved = typeof value === "string" && value.startsWith("{{")
    ? resolvePath(context, value.replace(/^\{\{\s*|\s*\}\}$/g, ""))
    : value;
  return typeof resolved === "number" && Number.isFinite(resolved) ? resolved : null;
}

function isVisible(element: VisualTemplateElement, context: RenderContext): boolean {
  const rule = element.visibleIf;
  if (!rule) return true;
  const actual = resolvePath(context, rule.path);
  const expected = rule.value;
  const equal = JSON.stringify(actual) === JSON.stringify(expected);
  switch (rule.operator) {
    case "exists": return actual !== null && actual !== undefined;
    case "not_exists": return actual === null || actual === undefined;
    case "equals": return equal;
    case "not_equals": return !equal;
    case "greater_than": return typeof actual === "number" && typeof expected === "number" && actual > expected;
    case "less_than": return typeof actual === "number" && typeof expected === "number" && actual < expected;
    case "greater_or_equal": return typeof actual === "number" && typeof expected === "number" && actual >= expected;
    case "less_or_equal": return typeof actual === "number" && typeof expected === "number" && actual <= expected;
    case "contains": return Array.isArray(actual) ? actual.includes(expected as never) : typeof actual === "string" && typeof expected === "string" && actual.includes(expected);
    case "not_contains": return Array.isArray(actual) ? !actual.includes(expected as never) : !(typeof actual === "string" && typeof expected === "string" && actual.includes(expected));
    case "in": return Array.isArray(expected) && expected.includes(actual as never);
    case "not_in": return Array.isArray(expected) && !expected.includes(actual as never);
  }
}

function wrapText(value: string, width: number, fontSize: number, maxLines?: number, overflow?: "clip" | "ellipsis"): string[] {
  const estimatedCharacters = Math.max(1, Math.floor(width / Math.max(fontSize * 0.92, 1)));
  const lines: string[] = [];
  for (const paragraph of value.split(/\r?\n/)) {
    for (let offset = 0; offset < paragraph.length; offset += estimatedCharacters) {
      lines.push(paragraph.slice(offset, offset + estimatedCharacters));
    }
    if (!paragraph) lines.push("");
  }
  const limited = maxLines ? lines.slice(0, maxLines) : lines;
  if (maxLines && lines.length > maxLines && overflow === "ellipsis" && limited.length > 0) {
    const lastIndex = limited.length - 1;
    const last = limited[lastIndex] ?? "";
    limited[lastIndex] = `${last.slice(0, Math.max(0, estimatedCharacters - 1))}…`;
  }
  return limited;
}

function elementPosition(element: VisualTemplateElement): { x: number; y: number; width: number; height: number } {
  return {
    x: element.x ?? 0,
    y: element.y ?? 0,
    width: element.width ?? 0,
    height: element.height ?? 0,
  };
}

function imageHref(source: string, context: RenderContext, images: Record<string, string>): string | null {
  const match = /^\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}$/.exec(source);
  if (!match?.[1]) return null;
  const supplied = images[match[1]];
  if (supplied?.startsWith("data:image/")) return supplied;
  const profileImage = resolvePath(context, match[1]);
  return typeof profileImage === "string" && profileImage.startsWith("data:image/") ? profileImage : null;
}

function renderText(element: VisualTemplateElement, context: RenderContext, report?: VisualReportLayout): string {
  const { x, y, width } = elementPosition(element);
  const fontSize = element.fontSize ?? 32;
  const lineHeight = element.lineHeight ?? 1.25;
  const anchor = element.align === "center" ? "middle" : element.align === "right" ? "end" : "start";
  const textX = element.align === "center" ? x + width / 2 : element.align === "right" ? x + width : x;
  const lines = wrapText(interpolate(element.value ?? "", context), width || 10_000, fontSize, element.maxLines, element.overflow);
  const color = report?.readability?.textColor ?? element.color ?? "#111827";
  return `<text x="${textX}" y="${y + fontSize}" text-anchor="${anchor}" fill="${escapeAttribute(color)}" font-family="${escapeAttribute(element.fontFamily ?? "ResultVisual")}" font-size="${fontSize}" font-weight="${escapeAttribute(String(element.fontWeight ?? 400))}" opacity="${element.opacity ?? 1}">${lines.map((line, index) => `<tspan x="${textX}" dy="${index === 0 ? 0 : fontSize * lineHeight}">${escapeXml(line)}</tspan>`).join("")}</text>`;
}

function renderRectangle(element: VisualTemplateElement): string {
  const { x, y, width, height } = elementPosition(element);
  const fill = element.fill ?? element.color ?? "transparent";
  const radius = element.type === "circle" ? Math.min(width, height) / 2 : element.radius ?? 0;
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" ry="${radius}" fill="${escapeAttribute(fill)}" stroke="${escapeAttribute(element.stroke ?? "none")}" stroke-width="${element.strokeWidth ?? 0}" opacity="${element.opacity ?? 1}"/>`;
}

function renderImage(element: VisualTemplateElement, context: RenderContext, images: Record<string, string>): string {
  const source = element.source ? imageHref(element.source, context, images) : null;
  if (!source) return "";
  const { x, y, width, height } = elementPosition(element);
  const clipId = `clip-${element.id}`;
  const shape = element.shape ?? "rectangle";
  const clip = shape === "circle"
    ? `<clipPath id="${clipId}"><circle cx="${x + width / 2}" cy="${y + height / 2}" r="${Math.min(width, height) / 2}"/></clipPath>`
    : shape === "rounded"
      ? `<clipPath id="${clipId}"><rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${element.radius ?? 24}"/></clipPath>`
      : "";
  return `${clip}<image href="${escapeAttribute(source)}" x="${x}" y="${y}" width="${width}" height="${height}" preserveAspectRatio="${element.fit === "contain" ? "xMidYMid meet" : element.fit === "stretch" ? "none" : "xMidYMid slice"}" opacity="${element.opacity ?? 1}"${clip ? ` clip-path="url(#${clipId})"` : ""}/>`;
}

function renderProgress(element: VisualTemplateElement, context: RenderContext): string {
  const { x, y, width, height } = elementPosition(element);
  const value = numericValue(element.value ?? element.source, context) ?? 0;
  const max = numericValue(element.max, context) ?? 100;
  const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const radius = element.radius ?? height / 2;
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="${escapeAttribute(element.fill ?? "#e5e7eb")}"/><rect x="${x}" y="${y}" width="${width * ratio}" height="${height}" rx="${radius}" fill="${escapeAttribute(element.color ?? "#7c3aed")}"/>`;
}

function renderStatGroup(element: VisualTemplateElement, context: RenderContext): string {
  const { x, y, width, height } = elementPosition(element);
  const source = element.source ? /^\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}$/.exec(element.source)?.[1] : null;
  const stats = source ? resolvePath(context, source) : null;
  if (!Array.isArray(stats)) return "";
  const rowHeight = height / Math.max(stats.length, 1);
  return stats.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return "";
    const stat = entry as unknown as ResultStat;
    const value = Number.isFinite(stat.value) ? stat.value : 0;
    const max = Number.isFinite(stat.max) && stat.max > 0 ? stat.max : 100;
    const barX = x + width * 0.32;
    const barWidth = width * 0.68;
    const rowY = y + index * rowHeight;
    const fillWidth = Math.max(0, Math.min(barWidth, barWidth * value / max));
    return `<text x="${x}" y="${rowY + rowHeight * 0.62}" fill="${escapeAttribute(element.color ?? "#111827")}" font-family="ResultVisual" font-size="${Math.min(28, rowHeight * 0.45)}">${escapeXml(stat.label)} ${escapeXml(String(value))}</text><rect x="${barX}" y="${rowY + rowHeight * 0.3}" width="${barWidth}" height="${Math.max(8, rowHeight * 0.24)}" rx="99" fill="#e5e7eb"/><rect x="${barX}" y="${rowY + rowHeight * 0.3}" width="${fillWidth}" height="${Math.max(8, rowHeight * 0.24)}" rx="99" fill="${escapeAttribute(element.fill ?? "#7c3aed")}"/>`;
  }).join("");
}

function renderElement(element: VisualTemplateElement, context: RenderContext, images: Record<string, string>, report?: VisualReportLayout): string {
  if (!isVisible(element, context)) return "";
  if (element.type === "text" || element.type === "badge" || element.type === "tag" || element.type === "icon") return renderText(element, context, report);
  if (element.type === "image") return renderImage(element, context, images);
  if (["shape", "rectangle", "circle", "divider", "line"].includes(element.type)) return renderRectangle(element);
  if (["progress_bar", "rating", "stat"].includes(element.type)) return renderProgress(element, context);
  if (element.type === "stat_group") return renderStatGroup(element, context);
  return "";
}

function expressionPath(value: string | undefined): string | null {
  return value ? /^\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}$/.exec(value)?.[1] ?? null : null;
}

function sectionItems(section: VisualReportSection, context: RenderContext): ResultJsonValue[] {
  const path = expressionPath(section.source);
  const value = path ? resolvePath(context, path) : undefined;
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.entries(value).map(([key, entry]) => (
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? { name: key, ...(entry as Record<string, ResultJsonValue>) }
      : { name: key, value: entry }
  ));
  return [];
}

function objectValue(item: ResultJsonValue, key: string, fallback: ResultJsonValue = ""): ResultJsonValue {
  if (!item || typeof item !== "object" || Array.isArray(item)) return fallback;
  return (item as Record<string, ResultJsonValue>)[key] ?? fallback;
}

function itemText(template: string | undefined, item: ResultJsonValue, context: RenderContext, fallbackKey: string): string {
  const value = template ?? `{{${fallbackKey}}}`;
  return value.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_match, path: string) => {
    if (path.startsWith("result.")) return formatValue(resolvePath(context, path));
    return formatValue(objectValue(item, path));
  });
}

function reportTitle(section: VisualReportSection, context: RenderContext, x: number, y: number, width: number, color: string): string {
  if (!section.title) return "";
  return `<text x="${x}" y="${y + 36}" fill="${escapeAttribute(color)}" font-family="ResultVisual" font-size="32" font-weight="700">${escapeXml(interpolate(section.title, context))}</text><line x1="${x}" y1="${y + 52}" x2="${x + width}" y2="${y + 52}" stroke="${escapeAttribute(section.fill ?? "#d1d5db")}" stroke-width="2"/>`;
}

function renderReportSection(
  section: VisualReportSection,
  context: RenderContext,
  images: Record<string, string>,
  x: number,
  y: number,
  width: number,
  layout: VisualReportLayout,
): { markup: string; height: number } {
  if (section.visibleIf && !isVisible(section as unknown as VisualTemplateElement, context)) return { markup: "", height: 0 };
  const titleHeight = section.title ? 76 : 0;
  const gap = section.gap ?? 20;
  const columns = section.columns ?? (section.type === "metrics" ? 2 : section.type === "status_grid" ? 3 : 1);
  const itemWidth = (width - gap * (columns - 1)) / columns;
  const color = layout.readability?.textColor ?? section.color ?? "#1f2937";
  const fill = section.fill ?? "#ec4899";
  const background = layout.readability?.itemBackground ?? section.background ?? "#ffffff";
  const fontSize = section.fontSize ?? 28;
  const items = sectionItems(section, context);
  if (["table", "gallery", "status_grid", "metrics"].includes(section.type) && items.length === 0) {
    return { markup: "", height: 0 };
  }
  let markup = reportTitle(section, context, x, y, width, color);
  const contentY = y + titleHeight;

  if (section.type === "section") return { markup, height: titleHeight || 24 };
  if (section.type === "summary") {
    const path = expressionPath(section.source);
    const value = path ? formatValue(resolvePath(context, path)) : "";
    if (!value) return { markup: "", height: 0 };
    const lines = wrapText(value, width, fontSize, undefined, "clip");
    const lineHeight = fontSize * 1.5;
    markup += `<text x="${x}" y="${contentY + fontSize}" fill="${escapeAttribute(color)}" font-family="ResultVisual" font-size="${fontSize}">${lines.map((line, index) => `<tspan x="${x}" dy="${index === 0 ? 0 : lineHeight}">${escapeXml(line)}</tspan>`).join("")}</text>`;
    return { markup, height: titleHeight + Math.max(lineHeight, lines.length * lineHeight) };
  }
  if (section.type === "gallery") {
    const imageHeight = section.imageHeight ?? 260;
    const rows = Math.ceil(items.length / columns);
    const path = expressionPath(section.source) ?? "";
    items.forEach((item, index) => {
      const col = index % columns;
      const row = Math.floor(index / columns);
      const image = images[`${path}.${index}`] ?? (typeof item === "string" && item.startsWith("data:image/") ? item : null);
      if (!image) return;
      const left = x + col * (itemWidth + gap);
      const top = contentY + row * (imageHeight + gap);
      const clipId = `gallery-${section.id}-${index}`;
      markup += `<clipPath id="${clipId}"><rect x="${left}" y="${top}" width="${itemWidth}" height="${imageHeight}" rx="${section.radius ?? 18}"/></clipPath><image href="${escapeAttribute(image)}" x="${left}" y="${top}" width="${itemWidth}" height="${imageHeight}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${clipId})"/>`;
    });
    return { markup, height: titleHeight + Math.max(0, rows * imageHeight + Math.max(0, rows - 1) * gap) };
  }
  const rowHeight = section.itemHeight ?? (section.type === "metrics" ? 92 : section.type === "status_grid" ? 62 : 58);
  const rows = Math.ceil(items.length / columns);
  items.forEach((item, index) => {
    const col = index % columns;
    const row = Math.floor(index / columns);
    const left = x + col * (itemWidth + gap);
    const top = contentY + row * (rowHeight + gap);
    if (section.type === "metrics") {
      const score = Number(objectValue(item, "score", objectValue(item, "value", 0))) || 0;
      const max = Number(section.max === undefined ? objectValue(item, "max", 10) : typeof section.max === "number" ? section.max : resolvePath(context, expressionPath(section.max) ?? "")) || 10;
      const barX = left;
      const barY = top + rowHeight - 18;
      const barWidth = itemWidth - 82;
      const ratio = Math.max(0, Math.min(1, score / max));
      markup += `<text x="${left}" y="${top + fontSize}" fill="${escapeAttribute(color)}" font-family="ResultVisual" font-size="${fontSize}">${escapeXml(itemText(section.label, item, context, "name"))}</text><text x="${left + itemWidth}" y="${top + fontSize}" text-anchor="end" fill="${escapeAttribute(color)}" font-family="ResultVisual" font-size="${Math.max(20, fontSize - 4)}">${escapeXml(`${score}/${max}`)}</text><rect x="${barX}" y="${barY}" width="${barWidth}" height="10" rx="5" fill="#e5e7eb"/><rect x="${barX}" y="${barY}" width="${barWidth * ratio}" height="10" rx="5" fill="${escapeAttribute(fill)}"/>`;
    } else if (section.type === "status_grid") {
      const passed = Boolean(objectValue(item, "passed", objectValue(item, "value", false)));
      markup += `<rect x="${left}" y="${top}" width="${itemWidth}" height="${rowHeight}" rx="${section.radius ?? 12}" fill="${escapeAttribute(background)}"/><text x="${left + 14}" y="${top + rowHeight * 0.64}" fill="${escapeAttribute(color)}" font-family="ResultVisual" font-size="${fontSize}">${escapeXml(itemText(section.label, item, context, "name"))}</text><text x="${left + itemWidth - 16}" y="${top + rowHeight * 0.66}" text-anchor="end" fill="${passed ? "#16a34a" : "#dc2626"}" font-family="ResultVisual" font-size="${fontSize + 8}">${passed ? "✓" : "×"}</text>`;
    } else {
      markup += `<text x="${left}" y="${top + fontSize}" fill="${escapeAttribute(color)}" font-family="ResultVisual" font-size="${fontSize}">${escapeXml(itemText(section.label, item, context, "label"))}</text><text x="${left + itemWidth}" y="${top + fontSize}" text-anchor="end" fill="${escapeAttribute(color)}" font-family="ResultVisual" font-size="${fontSize}">${escapeXml(itemText(section.value, item, context, "value"))}</text>`;
    }
  });
  return { markup, height: titleHeight + Math.max(0, rows * rowHeight + Math.max(0, rows - 1) * gap) };
}

function renderReportSections(template: VisualTemplateDefinition, context: RenderContext, images: Record<string, string>): { markup: string; height: number } {
  const layout = template.report ?? {};
  const paddingX = layout.paddingX ?? 64;
  const sectionGap = layout.sectionGap ?? 52;
  let cursor = layout.paddingTop ?? 64;
  let markup = "";
  for (const section of template.sections ?? []) {
    const rendered = renderReportSection(section, context, images, paddingX, cursor, template.width - paddingX * 2, layout);
    markup += rendered.markup;
    cursor += rendered.height + sectionGap;
  }
  return { markup, height: Math.max(cursor - sectionGap + (layout.paddingBottom ?? 80), layout.paddingTop ?? 64) };
}

function renderBackground(template: VisualTemplateDefinition, context: RenderContext, images: Record<string, string>, height: number): { defs: string; markup: string } {
  const { background, width } = template;
  const readability = template.report?.readability;
  const overlay = readability?.overlay
    ? `<rect width="${width}" height="${height}" fill="${escapeAttribute(readability.overlay.color)}" opacity="${readability.overlay.opacity}"/>`
    : "";
  const card = readability?.card
    ? `<rect x="${readability.card.inset ?? 28}" y="${readability.card.inset ?? 28}" width="${Math.max(0, width - (readability.card.inset ?? 28) * 2)}" height="${Math.max(0, height - (readability.card.inset ?? 28) * 2)}" rx="${readability.card.radius ?? 32}" fill="${escapeAttribute(readability.card.color)}" opacity="${readability.card.opacity}"/>`
    : "";
  if (background.type === "solid") return { defs: "", markup: `<rect width="${width}" height="${height}" fill="${escapeAttribute(interpolate(background.color, context))}"/>${overlay}${card}` };
  if (background.type === "gradient") {
    return {
      defs: `<linearGradient id="background-gradient" gradientTransform="rotate(${background.angle ?? 0})"><stop offset="0%" stop-color="${escapeAttribute(interpolate(background.from, context))}"/><stop offset="100%" stop-color="${escapeAttribute(interpolate(background.to, context))}"/></linearGradient>`,
      markup: `<rect width="${width}" height="${height}" fill="url(#background-gradient)"/>${overlay}${card}`,
    };
  }
  const source = background.type === "telegram_asset"
    ? images[TEMPLATE_BACKGROUND_IMAGE_KEY] ?? null
    : imageHref(background.source, context, images);
  return source
    ? { defs: "", markup: `<image href="${escapeAttribute(source)}" width="${width}" height="${height}" preserveAspectRatio="${background.fit === "contain" ? "xMidYMid meet" : background.fit === "stretch" ? "none" : "xMidYMid slice"}" opacity="${background.opacity ?? 1}"/>${overlay}${card}` }
    : { defs: "", markup: `${overlay}${card}` };
}

export function renderResultVisualSvg(
  template: VisualTemplateDefinition,
  profile: ResultProfileSnapshot,
  images: Record<string, string> = {},
): string {
  const context = buildContext(profile);
  const report = renderReportSections(template, context, images);
  const height = template.height === "auto" ? Math.min(MAX_RESULT_VISUAL_HEIGHT, Math.max(1, Math.ceil(report.height))) : template.height;
  if (template.width * height > MAX_RESULT_VISUAL_PIXELS) {
    throw new Error(`结果报告尺寸过大（${template.width} × ${height}），请减少内容或缩小模板画布`);
  }
  const background = renderBackground(template, context, images, height);
  const elements = [...template.elements]
    .sort((left, right) => (left.zIndex ?? 0) - (right.zIndex ?? 0))
    .map((element) => renderElement(element, context, images, template.report))
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${template.width}" height="${height}" viewBox="0 0 ${template.width} ${height}"><defs>${background.defs}</defs>${background.markup}${elements}${report.markup}</svg>`;
}

export async function initializeResultVisualRenderer(wasmModule: WebAssembly.Module): Promise<void> {
  wasmInitialization ??= initWasm(wasmModule);
  await wasmInitialization;
}

export async function renderResultVisualPng(
  template: VisualTemplateDefinition,
  profile: ResultProfileSnapshot,
  options: ResultVisualRendererOptions,
): Promise<Uint8Array> {
  if (options.fontBuffers.length === 0) {
    throw new Error("Result visual rendering requires a configured Chinese-capable font");
  }
  await initializeResultVisualRenderer(options.wasmModule);
  const svg = renderResultVisualSvg(template, profile, options.images ?? {});
  const rendered = new Resvg(svg, {
    font: {
      loadSystemFonts: false,
      fontBuffers: options.fontBuffers,
      defaultFontFamily: "ResultVisual",
    },
  }).render();
  try {
    return rendered.asPng();
  } finally {
    rendered.free();
  }
}
