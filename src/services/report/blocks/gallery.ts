import type { ReportGalleryItem } from "../model";

export interface GalleryBlockContext { escape(value: string): string; heroUrl?: string | undefined; }

export function renderGalleryBlock(items: ReportGalleryItem[], context: GalleryBlockContext): string {
  const source = items.filter((item) => item.url !== context.heroUrl);
  if (!source.length) return "";
  const mode = source.length <= 1 ? "single" : source.length === 2 ? "duo" : source.length === 3 ? "feature-triple" : source.length === 4 ? "quad" : "grid";
  const rendered = source.map((item) => `<figure class="gallery-item gallery-item-${item.orientation ?? "unknown"}"><img src="${item.url}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='grid'"><div class="media-fallback">图片暂时无法加载</div>${item.questionTitle || item.caption ? `<figcaption>${context.escape(item.questionTitle ?? item.caption ?? "用户上传图片")}</figcaption>` : ""}</figure>`).join("");
  return `<section class="gallery-composition block block-gallery"><header class="chapter-heading"><span>USER GALLERY</span><h2>视觉记录</h2></header><div class="gallery gallery-${mode}" data-image-count="${source.length}">${rendered}</div></section>`;
}
