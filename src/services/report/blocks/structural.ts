export interface StructuralBlockContext { escape(value: string): string; }

export function renderFeaturedImageBlock(url: string | undefined, context: StructuralBlockContext): string {
  if (!url) return "";
  return `<section class="section block block-featured"><div class="section-heading"><span>FEATURED IMAGE</span><h2>代表性照片</h2></div><img class="featured-image" src="${url}" alt="用户图片" onerror="this.style.display='none';this.nextElementSibling.style.display='grid'"><div class="media-fallback">图片暂时无法加载</div></section>`;
}

export function renderProfileBlock(items: Array<{ label: string; value: string }>, context: StructuralBlockContext): string {
  if (!items.length) return "";
  return `<section class="section block block-profile"><div class="section-heading"><span>PROFILE</span><h2>人物资料</h2></div><div class="profile-grid">${items.map((item) => `<div><span>${context.escape(item.label)}</span><b>${context.escape(item.value)}</b></div>`).join("")}</div></section>`;
}

export function renderMetadataBlock(values: string[], context: StructuralBlockContext): string {
  const text = values.filter(Boolean).map(context.escape).join(" · ");
  return text ? `<div class="report-metadata block block-metadata">${text}</div>` : "";
}

export function renderDividerBlock(): string { return `<div class="report-divider block block-divider" aria-hidden="true"></div>`; }
