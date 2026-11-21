/**
 * 房间内聊天的纯逻辑层（批次：房间实时讨论）。
 *
 * 职责：频道的成员资格裁剪、内容大小/审核校验、滑动窗口速率、环形暂存的
 * 淘汰序号、即焚时机判定——全部纯函数，GameRoomDO 与 vitest 共用这一份。
 * 网络与 DO storage 的 IO 都在 game-room.ts；本文件只 import 协议类型与
 * 仓库现有的纯词表审核适配器（note-content-filter.service，无任何 IO）。
 *
 * 隐私纪律：校验与中继路径都只处理消息内容本身；IP/UA/凭证不进
 * GameChatMessage（协议形状上就不存在），语音/图片只做大小校验后原样
 * 转发、绝不暂存（即焚与存储成本的要求）。
 */
import type {
  GameChatChannel,
  GameChatMembership,
  GameChatMessage,
  GameChatVoicePayload,
  GameProtocolErrorCode,
  GameRoomStatus,
} from "./engine-types";
import {
  CHAT_BASE64_MAX_CHARS,
  CHAT_RATE_LIMIT,
  CHAT_RATE_WINDOW_MS,
  CHAT_TEXT_MAX_CHARS,
  CHAT_VOICE_DURATION_GUARD_MS,
} from "./engine-types";
import { isNoteContentAllowed } from "../../services/note-content-filter.service";

// ---------------------------------------------------------------------------
// 频道资格（发送与可见同权）
// ---------------------------------------------------------------------------

/** 单个参与者对三个频道的资格（true = 可发且可见）。 */
export interface ChatChannelAccess {
  all: boolean;
  wolves: boolean;
  dead: boolean;
}

export interface ChatMembershipInput {
  /** 在座且未离席的玩家。 */
  isActivePlayer: boolean;
  /** 观战者或已离席重入者（不在座；DO 侧 registerSocket 的 spectator 同集）。 */
  isSpectator: boolean;
  /** 引擎 chatMembership 钩子的返回（未实现该钩子的玩法为 null）。 */
  hook: GameChatMembership | null;
}

/**
 * 频道资格推导（纯函数，单测覆盖裁剪矩阵）：
 * - all：房间成员（在座玩家与观战）都可见可发；被引擎标记「出局」的玩家
 *   退到 dead 频道，不再出现在活人的讨论里（狼人杀语义）；
 * - wolves：仅引擎明确标记的狼人——观战者/普通玩家恒 false（私密不外泄）；
 * - dead：死亡玩家 + 观战/离席者。
 */
export function chatChannelAccess(input: ChatMembershipInput): ChatChannelAccess {
  const isWolf = input.hook?.isWolf === true;
  const isDead = input.hook?.isDead === true;
  return {
    all: !isDead,
    wolves: isWolf,
    dead: input.isSpectator || isDead,
  };
}

/** 频道裁剪的单点判定：消息能否发给该查看者 / 该查看者能否往该频道发。 */
export function canAccessChannel(access: ChatChannelAccess, channel: GameChatChannel): boolean {
  return access[channel] === true;
}

/** 历史按查看者频道裁剪（断线重连补发；语音/图片从不暂存，历史里只有文字）。 */
export function visibleChatHistory(messages: GameChatMessage[], access: ChatChannelAccess): GameChatMessage[] {
  return messages.filter((message) => canAccessChannel(access, message.channel));
}

// ---------------------------------------------------------------------------
// 内容校验（超限返回明确错误码；被拒内容绝不产生任何中继或暂存）
// ---------------------------------------------------------------------------

export type ChatValidationOk<T> = { ok: true; value: T };
export type ChatValidationFail = { ok: false; code: GameProtocolErrorCode; message: string };

/** 文字：非空、≤ CHAT_TEXT_MAX_CHARS、过仓库现有词表审核（note-content-filter）。 */
export function validateChatText(raw: unknown): ChatValidationOk<string> | ChatValidationFail {
  if (typeof raw !== "string") return { ok: false, code: "invalid_payload", message: "消息内容必须是字符串" };
  const text = raw.trim();
  if (!text) return { ok: false, code: "invalid_payload", message: "消息不能为空" };
  if (text.length > CHAT_TEXT_MAX_CHARS) {
    return { ok: false, code: "chat_too_long", message: `消息最长 ${CHAT_TEXT_MAX_CHARS} 字，请分几条发送` };
  }
  if (!isNoteContentAllowed(text)) {
    return { ok: false, code: "chat_content_rejected", message: "内容包含不允许的字词，请修改后再试" };
  }
  return { ok: true, value: text };
}

/** 语音：base64 ≤ CHAT_BASE64_MAX_CHARS、时长在卫生区间内；mime 收敛为 audio/*。 */
export function validateChatVoice(
  audioBase64: unknown,
  durationMs: unknown,
  mimeType: unknown,
): ChatValidationOk<GameChatVoicePayload> | ChatValidationFail {
  if (typeof audioBase64 !== "string" || !audioBase64) {
    return { ok: false, code: "invalid_payload", message: "语音载荷缺失" };
  }
  if (audioBase64.length > CHAT_BASE64_MAX_CHARS) {
    return { ok: false, code: "chat_payload_too_large", message: "语音超过 300KB 上限，请缩短时长后重录" };
  }
  if (
    typeof durationMs !== "number" ||
    !Number.isFinite(durationMs) ||
    durationMs <= 0 ||
    durationMs > CHAT_VOICE_DURATION_GUARD_MS
  ) {
    return { ok: false, code: "invalid_payload", message: "语音时长不合法" };
  }
  const mimeTypeSafe = typeof mimeType === "string" && mimeType.startsWith("audio/") ? mimeType : "audio/webm";
  return { ok: true, value: { audioBase64, durationMs: Math.round(durationMs), mimeType: mimeTypeSafe } };
}

/** 图片：必须是 data:image/* 的 data URL 且 ≤ CHAT_BASE64_MAX_CHARS。 */
export function validateChatImage(dataUrl: unknown): ChatValidationOk<string> | ChatValidationFail {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) {
    return { ok: false, code: "invalid_payload", message: "图片必须是 data:image/ 形式" };
  }
  if (dataUrl.length > CHAT_BASE64_MAX_CHARS) {
    return { ok: false, code: "chat_payload_too_large", message: "图片超过 300KB 上限，压缩后再发" };
  }
  return { ok: true, value: dataUrl };
}

// ---------------------------------------------------------------------------
// 速率（每参与者，房内滑动窗口；状态在 DO storage，休眠不丢）
// ---------------------------------------------------------------------------

export interface ChatRateDecision {
  allowed: boolean;
  /** 允许时回写的新窗口（含本次）；拒绝时原样返回——被拒的尝试不占窗口。 */
  next: number[];
  /** 拒绝时建议的等待毫秒数（>0），用于拼中文提示。 */
  retryAfterMs: number;
}

/** 滑动窗口计数：windowMs 内已有 limit 条则拒绝。文字/语音/图片合并计数。 */
export function chatRateFilter(
  timestamps: number[],
  now: number,
  limit: number = CHAT_RATE_LIMIT,
  windowMs: number = CHAT_RATE_WINDOW_MS,
): ChatRateDecision {
  const fresh = timestamps.filter((at) => now - at < windowMs);
  if (fresh.length >= limit) {
    const oldest = Math.min(...fresh);
    return { allowed: false, next: fresh, retryAfterMs: Math.max(1, oldest + windowMs - now) };
  }
  return { allowed: true, next: [...fresh, now], retryAfterMs: 0 };
}

// ---------------------------------------------------------------------------
// 环形暂存（仅文字；键按零填充序号保证字典序 = 数值序）
// ---------------------------------------------------------------------------

/** 第 seq 条文字消息的暂存键（12 位零填充，storage.list 前缀读出即时间序）。 */
export function chatSeqKey(seq: number): string {
  return `chat:m:${String(seq).padStart(12, "0")}`;
}

/**
 * 追加第 latestSeq 条后应淘汰的文字序号（环形上限 cap）：超出的最旧一条被
 * 删除，暂存里恒保最近 cap 条。返回 null 表示无需淘汰。
 */
export function chatRingEvictionSeq(latestSeq: number, cap: number): number | null {
  const evict = latestSeq - cap;
  return evict >= 1 ? evict : null;
}

// ---------------------------------------------------------------------------
// 即焚
// ---------------------------------------------------------------------------

/**
 * 即焚时机：结算/关闭的房间立刻清空聊天暂存（环形文字 + 速率窗口 + 序号）。
 * 空房回收路径由 alarm 的 storage.deleteAll 兜底（同样不残留），但即焚不必
 * 等回收 TTL——对局一结束聊天就该消失。
 */
export function chatPurgeRequired(status: GameRoomStatus): boolean {
  return status === "settled" || status === "closed";
}
