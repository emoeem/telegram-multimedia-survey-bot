import type { ReportGalleryItem, ReportMediaMode } from "../model";

export interface GalleryBlockContext {
  escape(value: string): string;
  heroUrl?: string | undefined;
  /** 渲染介质；缺省 print（分页 PNG/PDF 产物，行为与历史一致）。 */
  mediaMode?: ReportMediaMode;
}

export function renderGalleryBlock(items: ReportGalleryItem[], context: GalleryBlockContext): string {
  const source = items.filter((item) => item.url !== context.heroUrl);
  if (!source.length) return "";
  // Gallery URLs are either inline data URLs or same-origin media links. The
  // attribute is escaped AND the value must match the known-safe shapes;
  // anything else renders as an empty src so the existing onerror fallback
  // takes over instead of a renderer-crafted URL reaching the browser.
  const safeImageSrc = (url: string): string =>
    /^data:image\//i.test(url) || url.startsWith("/api/") ? context.escape(url) : "";
  // 图集总在报告尾部（非首屏）：web 模式挂静态 lazy——首屏渲染不与图集抢链路
  // （对齐 report/web.ts renderGallery 的 T6 处理）；打印产物用 document.images
  // 的 load/error 事件等待全部图片，静态 lazy 会让视口外图片永不触发 load、
  // PDF 生成挂起，故仅 web 挂。decoding="async" 两种介质都挂。
  const lazy = context.mediaMode === "web" ? ` loading="lazy"` : "";
  const mode =
    source.length <= 1
      ? "single"
      : source.length === 2
        ? "duo"
        : source.length === 3
          ? "feature-triple"
          : source.length === 4
            ? "quad"
            : "grid";
  const rendered = source
    .map(
      (item) =>
        `<figure class="gallery-item gallery-item-${item.orientation ?? "unknown"}"><img src="${safeImageSrc(item.url)}" alt=""${lazy} decoding="async" onerror="this.style.display='none';this.nextElementSibling.style.display='grid'"><div class="media-fallback">图片暂时无法加载</div>${item.questionTitle || item.caption ? `<figcaption>${context.escape(item.questionTitle ?? item.caption ?? "用户上传图片")}</figcaption>` : ""}</figure>`,
    )
    .join("");
  return `<section class="gallery-composition block block-gallery"><header class="chapter-heading"><span>USER GALLERY</span><h2>视觉记录</h2></header><div class="gallery gallery-${mode}" data-image-count="${source.length}">${rendered}</div></section>`;
}
