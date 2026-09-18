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
  anonymous: boolean;
  status: "published" | "removed";
  createdAt: string;
  commentCount: number;
  owner: { username: string | null; firstName: string; telegramUserId: number } | null;
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
  owner: { username: string | null; firstName: string | null; telegramUserId: number } | null;
}

interface FeedResponse<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
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
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
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

export function fetchPlazaPosts(offset: number, limit = 10): Promise<FeedResponse<PlazaPostItem>> {
  return plazaRequest(`/api/plaza/posts?offset=${offset}&limit=${limit}`);
}

export function createPlazaPost(content: string, anonymous: boolean): Promise<{ post: { id: number } }> {
  return plazaRequest("/api/plaza/posts", {
    method: "POST",
    body: JSON.stringify({ content, anonymous }),
  });
}

export function fetchPlazaComments(postId: number): Promise<{ items: PlazaCommentItem[]; total: number }> {
  return plazaRequest(`/api/plaza/posts/${postId}/comments?limit=50&offset=0`);
}

export function createPlazaComment(postId: number, content: string): Promise<{ comment: PlazaCommentItem }> {
  return plazaRequest(`/api/plaza/posts/${postId}/comments`, {
    method: "POST",
    body: JSON.stringify({ content }),
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
