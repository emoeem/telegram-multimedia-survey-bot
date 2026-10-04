/** Client for the public Showcase (展示区) API. */
export interface ShowcaseLink {
  type: string;
  label: string;
  url: string;
}

export type ShowcaseItemKind =
  "image" | "article" | "audio" | "video" | "project" | "github" | "website" | "social" | "survey" | "other";

export interface ShowcaseItem {
  id: number;
  title: string;
  /** feed 里是预览（可能被截断），阅读全文时由 fetchShowcaseItem 返回完整正文。 */
  description: string | null;
  /** true 表示正文比预览长，需要点击后取全文再展示。 */
  descriptionTruncated?: boolean;
  kind: ShowcaseItemKind;
  coverUrl: string | null;
  /** 作品本体（图片/音频/视频）的可播放/可查看地址；没有内容文件时为 null。 */
  mediaUrl: string | null;
  url: string | null;
  featured: boolean;
}

export interface ShowcaseItemDetail extends ShowcaseItem {
  personId: number;
}

export interface ShowcasePerson {
  id: number;
  name: string;
  subtitle: string | null;
  description: string | null;
  accentColor: string | null;
  background: { from: string | null; to: string | null; imageUrl: string | null };
  illustrationUrl: string | null;
  avatarUrl: string | null;
  tags: string[];
  links: ShowcaseLink[];
  surveyId: number | null;
  featured: boolean;
  items: ShowcaseItem[];
}

export interface ShowcaseFeed {
  items: ShowcasePerson[];
  total: number;
}

export const SHOWCASE_ITEM_KIND_LABELS: Record<ShowcaseItemKind, string> = {
  image: "图片",
  article: "文章",
  audio: "音频",
  video: "视频",
  project: "项目",
  github: "GitHub",
  website: "网站",
  social: "社交媒体",
  survey: "问卷",
  other: "其他",
};

/** 阅读全文：文字作品（文章/小说）的完整正文，仅在人物已公开时可读。 */
export async function fetchShowcaseItem(itemId: number): Promise<ShowcaseItemDetail> {
  const response = await fetch(`/api/showcase/items/${itemId}`, { headers: { Accept: "application/json" } });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(typeof body.message === "string" ? body.message : "正文加载失败");
  }
  return body.item as ShowcaseItemDetail;
}

export async function fetchShowcase(): Promise<ShowcaseFeed> {
  const response = await fetch("/api/showcase?limit=200", { headers: { Accept: "application/json" } });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(typeof body.message === "string" ? body.message : "展示区加载失败");
  }
  return {
    items: Array.isArray(body.items) ? (body.items as ShowcasePerson[]) : [],
    total: typeof body.total === "number" ? body.total : 0,
  };
}
