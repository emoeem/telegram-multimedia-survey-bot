import { identityHeaders } from "./api";

export interface PlazaCardItem {
  id: number;
  name: string;
  identityLabel: string | null;
  nickname: string | null;
  imageUrl: string;
  publishedAt: string;
  owner: { username: string | null; firstName: string | null } | null;
}

export interface PlazaPostItem {
  id: number;
  content: string;
  anonymous: boolean;
  status: "published" | "removed";
  createdAt: string;
  owner: { username: string | null; firstName: string; telegramUserId: number } | null;
}

interface FeedResponse<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
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

export function fetchPlazaCards(offset: number, limit = 10): Promise<FeedResponse<PlazaCardItem>> {
  return plazaRequest(`/api/plaza/cards?offset=${offset}&limit=${limit}`);
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

export function ownerDisplayName(owner: { username: string | null; firstName?: string | null } | null): string {
  if (!owner) return "匿名";
  return owner.username ? `@${owner.username}` : owner.firstName || "用户";
}
