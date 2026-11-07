/**
 * 投稿墙的取数 —— GET /api/submit/gallery 的客户端（纯 fetch，无状态）。
 *
 * 与 plaza-api.ts 的 plazaRequest 同一风格：后端已经按 showcaseEnabled /
 * showcaseFields 双闸投影好了字段，这里不做第二次过滤——前端再过滤只会
 * 掩盖后端漏闸的事故，并把「墙该显示什么」的知识复制出第二份。
 *
 * 附件 URL 也在服务端给的是裸 asset id；public 端点无鉴权头，<img src> 直连。
 */

export interface GalleryWallItem {
  id: number;
  /** 匿名/null 时前端渲染「匿名」。 */
  nickname: string | null;
  /** unix 秒（web_submissions.created_at，INTEGER）。 */
  createdAt: number;
  /** 白名单命中的字段值，键是表单 step id，标签从 /api/submit/form 的 steps 查。 */
  fields: Record<string, string>;
  mediaAssetIds: number[];
}

export async function fetchGalleryWall(): Promise<GalleryWallItem[]> {
  const response = await fetch("/api/submit/gallery");
  const body = (await response.json().catch(() => ({}))) as { ok?: boolean; items?: GalleryWallItem[] };
  if (!response.ok || !body.ok || !Array.isArray(body.items)) throw new Error("投稿墙加载失败");
  return body.items;
}

export function galleryMediaUrl(assetId: number): string {
  return `/api/submit/gallery/media/${assetId}`;
}
