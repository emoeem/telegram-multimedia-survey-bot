import type {
  ShowcaseItem,
  ShowcaseItemKind,
  ShowcaseLink,
  ShowcasePerson,
  ShowcasePersonWithItems,
} from "../db/schema";

/**
 * Validation and public serialization for the Showcase (展示区).
 *
 * Everything an operator types goes through normalize* here: the admin form is
 * the only writer today, but a bad row is served to every visitor of a public,
 * unauthenticated page, so the boundary is enforced server-side rather than in
 * the form.
 */

export const SHOWCASE_ITEM_KINDS: ShowcaseItemKind[] = [
  "image",
  "article",
  "audio",
  "video",
  "project",
  "github",
  "website",
  "social",
  "survey",
  "other",
];

export const SHOWCASE_LINK_TYPES = ["github", "website", "social", "email", "telegram", "other"] as const;

export const SHOWCASE_LIMITS = {
  name: 40,
  subtitle: 60,
  description: 800,
  tag: 16,
  maxTags: 8,
  maxLinks: 8,
  url: 500,
  linkLabel: 24,
  itemTitle: 80,
  // 作品简介同时充当文字作品（文章/小说）的正文：400 字装不下一篇短文，前台也
  // 就没法"点开读"。上限放宽到 20000，但公开 feed 只发 SHOWCASE_ITEM_PREVIEW_CHARS
  // 的预览，全文走 /api/showcase/items/:id（见 toPublicShowcaseItem）。
  itemDescription: 20_000,
  maxItemsPerPerson: 24,
} as const;

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

function readNullableString(value: unknown, field: string, max: number): { value: string | null } | { error: string } {
  if (value === undefined || value === null) return { value: null };
  if (typeof value !== "string") return { error: `${field}必须是字符串` };
  const trimmed = value.trim();
  if (!trimmed) return { value: null };
  if (trimmed.length > max) return { error: `${field}长度不能超过 ${max} 个字符` };
  return { value: trimmed };
}

function readRequiredString(value: unknown, field: string, max: number): { value: string } | { error: string } {
  if (typeof value !== "string") return { error: `${field}必须是字符串` };
  const trimmed = value.trim();
  if (!trimmed) return { error: `${field}不能为空` };
  if (trimmed.length > max) return { error: `${field}长度不能超过 ${max} 个字符` };
  return { value: trimmed };
}

function readColor(value: unknown, field: string): { value: string | null } | { error: string } {
  const parsed = readNullableString(value, field, 32);
  if ("error" in parsed) return parsed;
  if (parsed.value === null) return { value: null };
  if (!HEX_COLOR.test(parsed.value)) return { error: `${field}必须是 #RGB 或 #RRGGBB 形式的颜色` };
  return { value: parsed.value.toLowerCase() };
}

/**
 * Only http(s) and mailto are accepted. The value ends up in an <a href> on a
 * public page, so `javascript:` and `data:` must never survive validation.
 */
export function normalizeShowcaseUrl(value: unknown, field: string): { value: string | null } | { error: string } {
  const parsed = readNullableString(value, field, SHOWCASE_LIMITS.url);
  if ("error" in parsed) return parsed;
  if (parsed.value === null) return { value: null };
  const url = parsed.value;
  if (url.startsWith("mailto:")) {
    const address = url.slice("mailto:".length);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return { error: `${field}的邮箱地址无效` };
    return { value: url };
  }
  if (url.startsWith("tg://")) return { value: url };
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return { error: `${field}必须是完整的 http(s) 链接` };
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return { error: `${field}只支持 http(s) 链接` };
  }
  return { value: parsedUrl.toString() };
}

function readOptionalId(value: unknown, field: string): { value: number | null } | { error: string } {
  if (value === undefined || value === null || value === "") return { value: null };
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return { error: `${field}必须是正整数` };
  return { value: parsed };
}

function readCount(value: unknown, field: string, max: number): { value: number } | { error: string } {
  if (value === undefined || value === null || value === "") return { value: 0 };
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > max) {
    return { error: `${field}必须是 0 到 ${max} 之间的整数` };
  }
  return { value: parsed };
}

export interface NormalizedPersonInput {
  name: string;
  subtitle: string | null;
  description: string | null;
  accentColor: string | null;
  backgroundFrom: string | null;
  backgroundTo: string | null;
  backgroundMediaId: number | null;
  illustrationMediaId: number | null;
  avatarMediaId: number | null;
  backgroundUrl: string | null;
  illustrationUrl: string | null;
  tags: string[];
  links: ShowcaseLink[];
  surveyId: number | null;
  responseId: number | null;
  featureRank: number;
  published: boolean;
  sortOrder: number;
}

export function normalizeShowcaseTags(value: unknown): { value: string[] } | { error: string } {
  if (value === undefined || value === null) return { value: [] };
  if (!Array.isArray(value)) return { error: "标签必须是数组" };
  const tags: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return { error: "标签必须是字符串" };
    const trimmed = entry.trim();
    if (!trimmed) continue;
    if (trimmed.length > SHOWCASE_LIMITS.tag) {
      return { error: `单个标签不能超过 ${SHOWCASE_LIMITS.tag} 个字符` };
    }
    if (!tags.includes(trimmed)) tags.push(trimmed);
  }
  if (tags.length > SHOWCASE_LIMITS.maxTags) {
    return { error: `最多只能有 ${SHOWCASE_LIMITS.maxTags} 个标签` };
  }
  return { value: tags };
}

export function normalizeShowcaseLinks(value: unknown): { value: ShowcaseLink[] } | { error: string } {
  if (value === undefined || value === null) return { value: [] };
  if (!Array.isArray(value)) return { error: "社交链接必须是数组" };
  if (value.length > SHOWCASE_LIMITS.maxLinks) {
    return { error: `最多只能有 ${SHOWCASE_LIMITS.maxLinks} 个链接` };
  }
  const links: ShowcaseLink[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return { error: "每个链接必须是对象" };
    const record = entry as Record<string, unknown>;
    const url = normalizeShowcaseUrl(record.url, "链接地址");
    if ("error" in url) return { error: url.error };
    if (url.value === null) continue;
    const label = readNullableString(record.label, "链接名称", SHOWCASE_LIMITS.linkLabel);
    if ("error" in label) return { error: label.error };
    const type =
      typeof record.type === "string" && (SHOWCASE_LINK_TYPES as readonly string[]).includes(record.type)
        ? record.type
        : "other";
    links.push({ type, label: label.value ?? url.value, url: url.value });
  }
  return { value: links };
}

/**
 * Validates a person payload. `creating` requires the fields an entry cannot be
 * shown without (name); updates only touch the fields the caller sent, so the
 * admin form can PATCH a single toggle.
 */
export function normalizeShowcasePersonInput(
  body: Record<string, unknown>,
  options: { creating: boolean },
): { value: Partial<NormalizedPersonInput> } | { error: string } {
  const value: Partial<NormalizedPersonInput> = {};
  const has = (key: string) => Object.prototype.hasOwnProperty.call(body, key);

  if (options.creating || has("name")) {
    const name = readRequiredString(body.name, "昵称", SHOWCASE_LIMITS.name);
    if ("error" in name) return { error: name.error };
    value.name = name.value;
  }
  if (has("subtitle")) {
    const subtitle = readNullableString(body.subtitle, "副标题", SHOWCASE_LIMITS.subtitle);
    if ("error" in subtitle) return { error: subtitle.error };
    value.subtitle = subtitle.value;
  }
  if (has("description")) {
    const description = readNullableString(body.description, "简介", SHOWCASE_LIMITS.description);
    if ("error" in description) return { error: description.error };
    value.description = description.value;
  }
  for (const [field, key] of [
    ["accentColor", "主题色"],
    ["backgroundFrom", "背景起始色"],
    ["backgroundTo", "背景结束色"],
  ] as const) {
    if (!has(field)) continue;
    const color = readColor(body[field], key);
    if ("error" in color) return { error: color.error };
    value[field] = color.value;
  }
  for (const [field, key] of [
    ["backgroundMediaId", "背景图"],
    ["illustrationMediaId", "立绘"],
    ["avatarMediaId", "头像"],
    ["surveyId", "问卷编号"],
    ["responseId", "答卷编号"],
  ] as const) {
    if (!has(field)) continue;
    const id = readOptionalId(body[field], key);
    if ("error" in id) return { error: id.error };
    value[field] = id.value;
  }
  for (const [field, key] of [
    ["backgroundUrl", "背景图链接"],
    ["illustrationUrl", "立绘链接"],
  ] as const) {
    if (!has(field)) continue;
    const url = normalizeShowcaseUrl(body[field], key);
    if ("error" in url) return { error: url.error };
    value[field] = url.value;
  }
  if (has("tags")) {
    const tags = normalizeShowcaseTags(body.tags);
    if ("error" in tags) return { error: tags.error };
    value.tags = tags.value;
  }
  if (has("links")) {
    const links = normalizeShowcaseLinks(body.links);
    if ("error" in links) return { error: links.error };
    value.links = links.value;
  }
  if (has("published")) {
    if (typeof body.published !== "boolean") return { error: "published 必须是布尔值" };
    value.published = body.published;
  }
  if (has("featureRank")) {
    const rank = readCount(body.featureRank, "精选排序", 9999);
    if ("error" in rank) return { error: rank.error };
    value.featureRank = rank.value;
  }
  if (has("sortOrder")) {
    const order = readCount(body.sortOrder, "排序", 9999);
    if ("error" in order) return { error: order.error };
    value.sortOrder = order.value;
  }
  return { value };
}

export interface NormalizedItemInput {
  title: string;
  description: string | null;
  kind: ShowcaseItemKind;
  coverMediaId: number | null;
  coverUrl: string | null;
  /** 内容文件：图片/音频/视频本体（与卡片缩略图 coverMediaId 区分）。 */
  mediaAssetId: number | null;
  url: string | null;
  featured: boolean;
  sortOrder: number;
}

export function normalizeShowcaseItemInput(
  body: Record<string, unknown>,
  options: { creating: boolean },
): { value: Partial<NormalizedItemInput> } | { error: string } {
  const value: Partial<NormalizedItemInput> = {};
  const has = (key: string) => Object.prototype.hasOwnProperty.call(body, key);

  if (options.creating || has("title")) {
    const title = readRequiredString(body.title, "作品标题", SHOWCASE_LIMITS.itemTitle);
    if ("error" in title) return { error: title.error };
    value.title = title.value;
  }
  if (has("description")) {
    const description = readNullableString(body.description, "作品简介", SHOWCASE_LIMITS.itemDescription);
    if ("error" in description) return { error: description.error };
    value.description = description.value;
  }
  if (has("kind")) {
    if (typeof body.kind !== "string" || !SHOWCASE_ITEM_KINDS.includes(body.kind as ShowcaseItemKind)) {
      return { error: `作品类型必须是以下之一：${SHOWCASE_ITEM_KINDS.join(", ")}` };
    }
    value.kind = body.kind as ShowcaseItemKind;
  }
  if (has("coverMediaId")) {
    const cover = readOptionalId(body.coverMediaId, "封面图");
    if ("error" in cover) return { error: cover.error };
    value.coverMediaId = cover.value;
  }
  if (has("coverUrl")) {
    const cover = normalizeShowcaseUrl(body.coverUrl, "封面图链接");
    if ("error" in cover) return { error: cover.error };
    value.coverUrl = cover.value;
  }
  if (has("mediaAssetId")) {
    const media = readOptionalId(body.mediaAssetId, "作品文件");
    if ("error" in media) return { error: media.error };
    value.mediaAssetId = media.value;
  }
  if (has("url")) {
    const url = normalizeShowcaseUrl(body.url, "作品链接");
    if ("error" in url) return { error: url.error };
    value.url = url.value;
  }
  if (has("featured")) {
    if (typeof body.featured !== "boolean") return { error: "featured 必须是布尔值" };
    value.featured = body.featured;
  }
  if (has("sortOrder")) {
    const order = readCount(body.sortOrder, "排序", 9999);
    if ("error" in order) return { error: order.error };
    value.sortOrder = order.value;
  }
  return { value };
}

function mediaUrl(path: "showcase" | "admin", mediaAssetId: number): string {
  return path === "showcase" ? `/api/showcase/media/${mediaAssetId}` : `/api/admin/media/${mediaAssetId}/image`;
}

/** Public shape served to /showcase. Never includes owner ids or audit fields. */
/** 公开 feed 里每条作品最多带多少字的预览；全文按需取。 */
export const SHOWCASE_ITEM_PREVIEW_CHARS = 280;

function previewDescription(value: string | null): { description: string | null; descriptionTruncated: boolean } {
  if (!value) return { description: null, descriptionTruncated: false };
  if (value.length <= SHOWCASE_ITEM_PREVIEW_CHARS) return { description: value, descriptionTruncated: false };
  return { description: `${value.slice(0, SHOWCASE_ITEM_PREVIEW_CHARS)}…`, descriptionTruncated: true };
}

/**
 * One work, in the shape the public page renders.
 *
 * `full: false`（feed 默认）只给预览：一场展览可能有几十篇文字作品，把正文全塞进
 * 列表响应会白白撑大移动端首屏；`full: true` 供 /api/showcase/items/:id 阅读全文用。
 */
export function toPublicShowcaseItem(
  item: ShowcaseItem,
  options: { full?: boolean; admin?: boolean } = {},
) {
  const description = options.full
    ? { description: item.description, descriptionTruncated: false }
    : previewDescription(item.description);
  const route = options.admin ? "admin" : "showcase";
  return {
    id: item.id,
    title: item.title,
    kind: item.kind,
    coverUrl: item.coverMediaId ? mediaUrl(route, item.coverMediaId) : item.coverUrl,
    // 内容文件：图片放大、音频播放、视频播放都用它（admin 视图走高权限路由，
    // 草稿的媒体才不会 404）。
    mediaUrl: item.mediaAssetId ? mediaUrl(route, item.mediaAssetId) : null,
    url: item.url,
    featured: item.featured,
    ...description,
  };
}

export function toPublicShowcasePerson(person: ShowcasePersonWithItems) {
  return {
    id: person.id,
    name: person.name,
    subtitle: person.subtitle,
    description: person.description,
    accentColor: person.accentColor,
    background: {
      from: person.backgroundFrom,
      to: person.backgroundTo,
      imageUrl: person.backgroundMediaId ? mediaUrl("showcase", person.backgroundMediaId) : person.backgroundUrl,
    },
    illustrationUrl: person.illustrationMediaId
      ? mediaUrl("showcase", person.illustrationMediaId)
      : person.illustrationUrl,
    avatarUrl: person.avatarMediaId ? mediaUrl("showcase", person.avatarMediaId) : null,
    tags: person.tags,
    links: person.links,
    surveyId: person.surveyId,
    featured: person.featureRank > 0,
    items: person.items.map((item) => toPublicShowcaseItem(item)),
  };
}

/** Admin shape: adds the media ids the edit form needs to re-select an upload. */
export function toAdminShowcasePerson(person: ShowcasePersonWithItems) {
  const publicView = toPublicShowcasePerson(person);
  return {
    ...publicView,
    // Editor previews load through the ADMIN media route: the public route only
    // serves assets referenced by a PUBLISHED person, so a draft's artwork would
    // 404 in the form. The raw *_url columns stay untouched for the form round-trip.
    background: {
      ...publicView.background,
      imageUrl: person.backgroundMediaId ? mediaUrl("admin", person.backgroundMediaId) : person.backgroundUrl,
    },
    illustrationUrl: person.illustrationMediaId ? mediaUrl("admin", person.illustrationMediaId) : person.illustrationUrl,
    avatarUrl: person.avatarMediaId ? mediaUrl("admin", person.avatarMediaId) : null,
    backgroundMediaId: person.backgroundMediaId,
    illustrationMediaId: person.illustrationMediaId,
    avatarMediaId: person.avatarMediaId,
    backgroundUrl: person.backgroundUrl,
    backgroundFrom: person.backgroundFrom,
    backgroundTo: person.backgroundTo,
    responseId: person.responseId,
    ownerUserId: person.ownerUserId,
    featureRank: person.featureRank,
    published: person.published,
    sortOrder: person.sortOrder,
    items: person.items.map((item: ShowcaseItem) => ({
      id: item.id,
      title: item.title,
      description: item.description,
      kind: item.kind,
      coverMediaId: item.coverMediaId,
      coverUrl: item.coverMediaId ? mediaUrl("admin", item.coverMediaId) : item.coverUrl,
      mediaAssetId: item.mediaAssetId,
      mediaUrl: item.mediaAssetId ? mediaUrl("admin", item.mediaAssetId) : null,
      url: item.url,
      featured: item.featured,
      sortOrder: item.sortOrder,
    })),
  };
}

/** The kind list the admin form renders; kept next to the validator. */
export function showcaseItemKindLabel(kind: ShowcaseItemKind): string {
  const labels: Record<ShowcaseItemKind, string> = {
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
  return labels[kind];
}

export type { ShowcasePerson, ShowcasePersonWithItems };
