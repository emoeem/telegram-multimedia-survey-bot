import { identityHeaders } from "./api";

export interface PlazaProfileField {
  questionId: number;
  title: string;
  value: string;
}

export interface PlazaProfileImage {
  mediaAssetId: number;
  url: string;
}

export interface PlazaProfileItem {
  id: number;
  surveyId: number;
  owner: { username: string | null; firstName: string | null } | null;
  publishedAt: string | null;
  createdAt: string;
  images: PlazaProfileImage[];
  fields: PlazaProfileField[];
}

export interface PlazaPostItem {
  id: number;
  content: string;
  kind: "text" | "trial";
  payload: TrialSharePayload | null;
  /** 配图（0068）：只在帖子发布中时可读，下架即 404。 */
  imageUrl: string | null;
  /** #话题#：由正文解析或投稿时显式填写。 */
  topic: string | null;
  anonymous: boolean;
  status: "published" | "removed";
  createdAt: string;
  commentCount: number;
  owner: { username: string | null; firstName: string | null } | null;
}

export interface TrialSharePayload {
  runId: number;
  packId: number;
  packName: string;
  persona: "male" | "female";
  mode: "normal" | "hell";
  grade: "S" | "A" | "B" | "C";
  gradeTitle: string;
  gradeText: string;
  score: number;
  completedTasks: number;
  skippedTasks: number;
  floors: number;
}

export interface PlazaCommentItem {
  id: number;
  postId: number;
  content: string;
  createdAt: string;
  /** null for an anonymous comment — the API never returns an identity then. */
  owner: { username: string | null; firstName: string | null } | null;
}

interface FeedResponse<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface PlazaFeedData extends FeedResponse<PlazaPostItem> {
  /** 服务端归一化后的话题（非法值会被忽略）。 */
  topic?: string | null;
}

export interface PlazaTopic {
  topic: string;
  count: number;
}

export interface PlazaProfilesData extends FeedResponse<PlazaProfileItem> {
  surveyId: number | null;
  communityGroupUrl: string | null;
  submissionBotUrl: string | null;
}

async function plazaRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      // FormData 必须让浏览器自己带 boundary；只有 JSON 请求体才写 Content-Type。
      ...(init?.body && !(init.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
      ...identityHeaders(),
      ...init?.headers,
    },
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(typeof body.message === "string" ? body.message : "请求失败");
  }
  return body as T;
}

export function fetchPlazaProfiles(offset: number, limit = 10): Promise<PlazaProfilesData> {
  return plazaRequest(`/api/plaza/profiles?offset=${offset}&limit=${limit}`);
}

export function fetchPlazaPosts(offset: number, limit = 10, topic?: string | null): Promise<PlazaFeedData> {
  const topicParam = topic ? `&topic=${encodeURIComponent(topic)}` : "";
  return plazaRequest(`/api/plaza/posts?offset=${offset}&limit=${limit}${topicParam}`);
}

export function fetchPlazaTopics(): Promise<{ topics: PlazaTopic[] }> {
  return plazaRequest("/api/plaza/topics");
}

export function createPlazaPost(
  content: string,
  anonymous: boolean,
  options: { imageAssetId?: number | null; topic?: string | null } = {},
): Promise<{ post: { id: number; imageUrl?: string | null; topic?: string | null } }> {
  return plazaRequest("/api/plaza/posts", {
    method: "POST",
    body: JSON.stringify({
      content,
      anonymous,
      imageAssetId: options.imageAssetId ?? null,
      topic: options.topic ?? null,
    }),
  });
}

/** 上传树洞配图；返回的 mediaAssetId 随后随投稿一起提交。 */
export function uploadPlazaImage(file: File): Promise<{ mediaAssetId: number; url: string }> {
  const form = new FormData();
  form.append("file", file);
  return plazaRequest<{ mediaAssetId: number; url: string }>("/api/plaza/posts/media", {
    method: "POST",
    body: form,
  });
}

export function fetchPlazaComments(postId: number, offset = 0): Promise<{ items: PlazaCommentItem[]; total: number }> {
  // Server clamps limit to 30 — page through with offset instead of over-fetching.
  return plazaRequest(`/api/plaza/posts/${postId}/comments?limit=30&offset=${offset}`);
}

export function createPlazaComment(
  postId: number,
  content: string,
  anonymous = true,
): Promise<{ comment: PlazaCommentItem }> {
  return plazaRequest(`/api/plaza/posts/${postId}/comments`, {
    method: "POST",
    body: JSON.stringify({ content, anonymous }),
  });
}

export function createTrialShare(runId: number): Promise<{ post: { id: number; kind: string; createdAt: string } }> {
  return plazaRequest("/api/plaza/trial-shares", {
    method: "POST",
    body: JSON.stringify({ runId, anonymous: true }),
  });
}

export function ownerDisplayName(owner: { username: string | null; firstName?: string | null } | null): string {
  if (!owner) return "匿名";
  return owner.username ? `@${owner.username}` : owner.firstName || "用户";
}

/** 从 t.me 链接解析 bot handle，供文案展示；解析不出时退回中性文案。 */
export function botHandleFromUrl(url: string | null): string {
  if (!url) return "投稿机器人";
  const match = url.match(/t\.me\/([A-Za-z0-9_]+)/);
  return match ? `@${match[1]}` : "投稿机器人";
}

export function fetchPlazaProfile(id: number): Promise<{ profile: PlazaProfileItem }> {
  return plazaRequest(`/api/plaza/profiles/${id}`);
}
