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

/** 举报会话里的单条消息（0094）：同一人对同一条消息服务端只计一次（UNIQUE 兜底），
 * 消息不设自动隐藏阈值，隐藏走管理端复核处置。限流 5 次/小时。 */
export function reportThreadMessage(
  threadId: number,
  messageId: number,
  reason: string,
): Promise<{ ok: true; reportCount: number }> {
  return request(`/api/note/threads/${threadId}/messages/${messageId}/report`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

/** 拉黑会话对方（入口是会话，服务端按会话解析对方 hash、双向生效）。
 * POST 语义：blockThread 幂等且恒返回 true（仅 not_participant 抛错），
 * 客户端成功即置本地 blocked 态，不依赖返回值。限流 5 次/小时。 */
export function blockThreadPartner(threadId: number): Promise<{ ok: true; blocked: boolean }> {
  return request(`/api/note/threads/${threadId}/block`, { method: "POST" });
}

/** 解除拉黑：DELETE 只删「我拉黑对方」那行，返回 blocked = !(变更数 > 0)
 * （本来没拉黑、或对方拉黑我的行不归我删时也为 true）——仅用于反馈文案，
 * 客户端成功即视为已解除并 reload 会话列表。限流 5 次/小时。 */
export function unblockThreadPartner(threadId: number): Promise<{ ok: true; blocked: boolean }> {
  return request(`/api/note/threads/${threadId}/block`, { method: "DELETE" });
}

export function uploadNoteImage(file: File): Promise<{ ok: true; assetId: number }> {
  const form = new FormData();
  form.append("file", file);
  return request("/api/note/media", { method: "POST", body: form });
}

export function noteImageUrl(assetId: number): string {
  return `/api/note/media/${assetId}`;
}
