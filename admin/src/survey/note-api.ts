import { getParticipantKey } from "./api";
import { safeGet } from "./storage";
import { getTelegramInitData } from "../telegram";

/**
 * 纸条聊天 · 客户端 API。
 *
 * 身份头与 survey api.ts 同一套优先级（TG init-data → 邮箱会话 → 参与者
 * token → 浏览器 key），这里不复用那个模块的私有 request，是因为纸条的
 * 错误处理要看服务端的 code（need_own_note / insufficient_balance /
 * thread_closed…）直接驱动 UI 分支，而不是笼统的「请求失败」。
 */

export interface NoteCardDto {
  id: number;
  gender: string;
  ageBand: string;
  region: string;
  content: string;
  imageAssetId: number | null;
  createdAt: string;
  expiresAt: string;
}

export interface NoteThreadDto {
  id: number;
  noteId: number;
  role: "drawer" | "owner";
  peerNote: {
    id: number;
    gender: string;
    ageBand: string;
    region: string;
    content: string;
    imageAssetId: number | null;
  } | null;
  noteStatus: string;
  lastBody: string | null;
  lastMessageAt: string | null;
  unread: number;
  messageCount: number;
}

export interface NoteMessageDto {
  id: number;
  mine: boolean;
  body: string;
  imageAssetId: number | null;
  createdAt: string;
}

export interface NoteMeDto {
  ok: true;
  note: NoteCardDto | null;
  balance: number;
  freeDrawsPerDay: number;
  drawCostCoins: number;
  reportHideThreshold: number;
}

export interface DrawResultDto {
  ok: true;
  empty: boolean;
  kind?: "free" | "coin";
  balance?: number;
  freeLeft?: number;
  threadId?: number;
  note?: NoteCardDto;
}

export class NoteApiError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const initData = getTelegramInitData();
  const emailSession = safeGet("emailSessionToken");
  const headers: Record<string, string> = {
    ...(init?.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
    ...(initData
      ? { "x-telegram-init-data": encodeURIComponent(initData) }
      : emailSession
        ? { "x-email-session": emailSession }
        : { "x-participant-key": getParticipantKey() }),
  };
  const response = await fetch(path, { ...init, headers });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new NoteApiError(
      String(body.code ?? "http_error"),
      String(body.message ?? `请求失败（HTTP ${response.status}）`),
    );
  }
  return body as T;
}

function uuid(): string {
  return crypto.randomUUID ? crypto.randomUUID() : `n${Date.now()}${Math.random().toString(36).slice(2, 10)}`;
}

export function fetchNoteMe(): Promise<NoteMeDto> {
  return request<NoteMeDto>("/api/note/me");
}

export function putNote(draft: {
  gender: string;
  ageBand: string;
  region: string;
  content: string;
  imageAssetId: number | null;
}): Promise<{ ok: true; note: NoteCardDto }> {
  return request("/api/note", { method: "POST", body: JSON.stringify(draft) });
}

export function withdrawMyNote(): Promise<{ ok: true; withdrawn: boolean }> {
  return request("/api/note/me", { method: "DELETE" });
}

export function drawNote(): Promise<DrawResultDto> {
  return request("/api/note/draw", { method: "POST", body: JSON.stringify({ idempotencyKey: `note:${uuid()}` }) });
}

export function fetchNoteThreads(): Promise<{ ok: true; threads: NoteThreadDto[] }> {
  return request("/api/note/threads");
}

export function fetchNoteMessages(
  threadId: number,
  after: number,
): Promise<{ ok: true; messages: NoteMessageDto[]; peerGone: boolean }> {
  return request(`/api/note/threads/${threadId}/messages?after=${after}`);
}

export function sendNoteMessage(
  threadId: number,
  payload: { body: string; imageAssetId: number | null },
): Promise<{ ok: true; message: NoteMessageDto }> {
  return request(`/api/note/threads/${threadId}/messages`, { method: "POST", body: JSON.stringify(payload) });
}

export function reportNote(
  noteId: number,
  reason: string,
): Promise<{ ok: true; hidden: boolean; reportCount: number }> {
  return request(`/api/note/${noteId}/report`, { method: "POST", body: JSON.stringify({ reason }) });
}

export function uploadNoteImage(file: File): Promise<{ ok: true; assetId: number }> {
  const form = new FormData();
  form.append("file", file);
  return request("/api/note/media", { method: "POST", body: form });
}

export function noteImageUrl(assetId: number): string {
  return `/api/note/media/${assetId}`;
}
