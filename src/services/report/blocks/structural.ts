import type { ReportMediaMode } from "../model";

export interface StructuralBlockContext {
  escape(value: string): string;
  /** 渲染介质；缺省 print（分页 PNG/PDF 产物，行为与历史一致）。 */
  mediaMode?: ReportMediaMode;
}

export function renderFeaturedImageBlock(url: string | undefined, context: StructuralBlockContext): string {
  if (!url) return "";
  // 非首屏配图：web 模式挂静态 lazy（打印产物用 load 事件等图，静态 lazy
  // 会让视口外图片永不触发 load、PDF 生成挂起，故仅 web 挂）；decoding=
  // "async" 两种介质都挂，对产物像素零影响。
  const lazy = context.mediaMode === "web" ? ` loading="lazy"` : "";
  return `<section class="section block block-featured"><div class="section-heading"><span>FEATURED IMAGE</span><h2>代表性照片</h2></div><img class="featured-image" src="${url}" alt="用户图片"${lazy} decoding="async" onerror="this.style.display='none';this.nextElementSibling.style.display='grid'"><div class="media-fallback">图片暂时无法加载</div></section>`;
}

export function renderProfileBlock(
  items: Array<{ label: string; value: string }>,
  context: StructuralBlockContext,
): string {
  if (!items.length) return "";
  return `<section class="section block block-profile"><div class="section-heading"><span>PROFILE</span><h2>人物资料</h2></div><div class="profile-grid">${items.map((item) => `<div><span>${context.escape(item.label)}</span><b>${context.escape(item.value)}</b></div>`).join("")}</div></section>`;
}

export function renderMetadataBlock(values: string[], context: StructuralBlockContext): string {
  const text = values.filter(Boolean).map(context.escape).join(" · ");
  return text ? `<div class="report-metadata block block-metadata">${text}</div>` : "";
}

export function renderDividerBlock(): string {
  return `<div class="report-divider block block-divider" aria-hidden="true"></div>`;
}
