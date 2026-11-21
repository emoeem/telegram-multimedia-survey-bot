/**
 * 五子棋联机对局的客户端通道（批次 W3）。
 *
 * 与服务端的契约（先读后写，两处都是既有实现、只消费不改动语义）：
 * - REST：POST /api/game/rooms（创建）、POST /api/game/rooms/:id/join、
 *   GET /api/game/rooms/:id/state、POST /api/game/rooms/:id/close
 *   （src/http/game-api.ts，响应 { ok, roomRef, view, role }，错误统一
 *   { ok:false, code, message }）。
 * - WS：GET /api/game/rooms/:id/ws 升级，消息形状见
 *   src/game/multiplayer/engine-types.ts 的 GameServerMessage/GameClientMessage
 *   （type-only import，不把 Worker 代码拖进前端包）。ready/start/leave/落子
 *   全走 WS（REST 只开放 create/join/state/close）。
 *
 * 身份：沿用 identityHeaders()（./api.ts）这一套凭证——浏览器 WebSocket API
 * 不允许自定义请求头，所以升级请求把 identityHeaders() 打进
 * Sec-WebSocket-Protocol 子协议（game-auth.<base64url(JSON)>），Worker 侧
 * handleRoomSocket 解回同一套头再走 resolveParticipant。没有新身份体系，
 * 只是同一批凭证为 WS 握手换了个传输面。
 *
 * 断线恢复：连接断开按 1s→2s→4s…15s 封顶自动重连；重连成功后先拉一次
 * REST /state 兜底补齐断线期间错过的变更，再交给 WS 推送维持实时。
 */
import type { GameClientMessage, GamePlayerView, GamePublicView } from "../../../src/game/multiplayer/engine-types";
import { identityHeaders } from "./api";
import { sessionParticipantIdentity } from "./participant-token";
import { gameErrorText, roomCodeToId } from "./game-room-logic";
import { parseGameTypes, type GameConnectionStatus, type GameTypeInfo } from "./game-lobby-logic";

/** 动作（落子/悔棋/求和/认输）等待 action_result 的超时：超过即提示连接不稳。 */
const ACTION_TIMEOUT_MS = 8000;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;

// ---------------------------------------------------------------------------
// REST 辅助
// ---------------------------------------------------------------------------

export interface GameApiFailure {
  code: string;
  message: string;
}

export type GameApiResult<T> = { ok: true; data: T } | { ok: false; error: GameApiFailure };

/** 进入房间时随 create/join 带上的展示名（来自 pt 链接的 Telegram 资料）。 */
export function selfDisplayName(): string | null {
  const identity = sessionParticipantIdentity();
  const name = (identity?.firstName ?? identity?.username ?? "").trim();
  return name ? name.slice(0, 24) : null;
}

async function callGameApi(
  path: string,
  init: { method: "GET" | "POST"; body?: string },
): Promise<GameApiResult<Record<string, unknown>>> {
  try {
    const response = await fetch(path, {
      method: init.method,
      headers: {
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...identityHeaders(),
      },
      ...(init.body !== undefined ? { body: init.body } : {}),
    });
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return { ok: false, error: { code: "network_error", message: gameErrorText("network_error") } };
    if (body.ok !== true) {
      const code = typeof body.code === "string" ? body.code : "unknown_error";
      return {
        ok: false,
        error: {
          code,
          // 错误码统一收敛成中文可读文案：服务端 message 缺失/不可读时按
          // code 映射（gameErrorText），不再裸抛英文码。
          message: gameErrorText(code, typeof body.message === "string" ? body.message : null),
        },
      };
    }
    return { ok: true, data: body };
  } catch {
    return { ok: false, error: { code: "network_error", message: gameErrorText("network_error") } };
  }
}

export interface GameRoomSnapshot {
  roomId: number;
  roomRef: string;
  view: GamePlayerView | GamePublicView;
  role: "player" | "spectator";
  /** 查看者自己的 participantHash（REST 信封 you 字段）：定位信封 players 里的「我的行」。 */
  selfParticipantHash: string | null;
  /** 满员/已开局坐不下，服务端自动降级为观战（屏层据此提示）。 */
  spectatorFallback?: boolean;
}

function snapshotFromResponse(payload: Record<string, unknown>): GameApiResult<GameRoomSnapshot> {
  const roomRef = typeof payload.roomRef === "string" ? payload.roomRef : "";
  const roomId = roomCodeToId(roomRef);
  const view = (payload.view ?? null) as GamePlayerView | GamePublicView | null;
  if (roomId === null || view === null) {
    return { ok: false, error: { code: "bad_response", message: gameErrorText("bad_response") } };
  }
  return {
    ok: true,
    data: {
      roomId,
      roomRef,
      view,
      role: payload.role === "player" ? "player" : "spectator",
      selfParticipantHash: typeof payload.you === "string" ? payload.you : null,
      ...(payload.spectatorFallback === true ? { spectatorFallback: true } : {}),
    },
  };
}

/**
 * 创建房间（房主）。gameType 由调用方从玩法列表（GET /api/game/types）选择
 * 传入——本层不再硬编码玩法；未注册的 gameType 由服务端以 unknown_game_type
 * 拒绝（错误文案经 gameErrorText 收敛成中文）。
 */
export async function createGameRoom(
  gameType: string,
  displayName: string | null,
): Promise<GameApiResult<GameRoomSnapshot>> {
  const result = await callGameApi("/api/game/rooms", {
    method: "POST",
    body: JSON.stringify({ gameType, ...(displayName ? { displayName } : {}) }),
  });
  if (!result.ok) return result;
  return snapshotFromResponse(result.data);
}

/**
 * 已注册玩法列表（GET /api/game/types）。响应只有玩法元数据、不含任何房间
 * 或玩家信息；解析失败/空列表返回错误，调用方回退到 FALLBACK_GAME_TYPES。
 */
export async function fetchGameTypes(): Promise<GameApiResult<GameTypeInfo[]>> {
  const result = await callGameApi("/api/game/types", { method: "GET" });
  if (!result.ok) return result;
  const types = parseGameTypes(result.data);
  if (types === null) {
    return { ok: false, error: { code: "bad_response", message: gameErrorText("bad_response") } };
  }
  return { ok: true, data: types };
}

/** 加入（或重入）房间：已是玩家时服务端幂等返回当前视图。 */
export async function joinGameRoom(
  roomId: number,
  displayName: string | null,
): Promise<GameApiResult<GameRoomSnapshot>> {
  const result = await callGameApi(`/api/game/rooms/${roomId}/join`, {
    method: "POST",
    body: JSON.stringify({ ...(displayName ? { displayName } : {}) }),
  });
  if (!result.ok) return result;
  return snapshotFromResponse(result.data);
}

/** 当前裁剪视图（REST 读）：WS 重连后与进入房间前都用它兜底。 */
export async function fetchGameRoomState(roomId: number): Promise<GameApiResult<GameRoomSnapshot>> {
  const result = await callGameApi(`/api/game/rooms/${roomId}/state`, { method: "GET" });
  if (!result.ok) return result;
  return snapshotFromResponse(result.data);
}

/** 房主关闭房间（终态，审计与目录表由服务端收口）。 */
export async function closeGameRoom(roomId: number): Promise<GameApiResult<{ roomRef: string }>> {
  const result = await callGameApi(`/api/game/rooms/${roomId}/close`, { method: "POST", body: "{}" });
  if (!result.ok) return result;
  return {
    ok: true,
    data: { roomRef: typeof result.data.roomRef === "string" ? result.data.roomRef : "" },
  };
}

// ---------------------------------------------------------------------------
// WebSocket 连接
// ---------------------------------------------------------------------------

// 连接状态类型移到 game-lobby-logic.ts（纯层）以供 Board 注册表复用，这里
// 原样再导出保持既有 import 路径不变。
export type { GameConnectionStatus };

export interface GameRoomConnectionOptions {
  roomId: number;
  /** 每条 state 推送/REST 兜底都会回调；屏层以此为准渲染。 */
  onState: (view: GamePlayerView | GamePublicView, role: "player" | "spectator") => void;
  /** 可继续使用的错误（非致命）：屏层弹提示，连接保持。 */
  onNotice: (message: string) => void;
  /** 房间没了（回收/不存在）：屏层退出房间视图，连接停止重连。 */
  onFatal: (message: string) => void;
  /** 连接状态变化（attempt 从 1 起，首次连接为 1，重连依次递增）。 */
  onStatus: (status: GameConnectionStatus, attempt: number) => void;
  /** 在线人数推送（presence）：对手掉线提示的信号源。缺省忽略。 */
  onPresence?: (counts: { players: number; spectators: number }) => void;
}

/** WS 升级地址：同源 /api/game/rooms/:id/ws（Worker 鉴权后转发到房间 DO）。 */
export function gameRoomSocketUrl(roomId: number): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/game/rooms/${roomId}/ws`;
}

/**
 * 把 identityHeaders() 编进 WS 子协议（game-auth.<base64url(JSON)>）。
 * 子协议必须是 RFC 6455 token（无空格/=），所以用 base64url 并去 padding；
 * Worker 侧解回时补 padding。TextEncoder 走一遍保证 UTF-8 安全。
 */
export function gameAuthSubprotocol(): string {
  const json = JSON.stringify(identityHeaders());
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return `game-auth.${encoded}`;
}

interface PendingAction {
  resolve: () => void;
  reject: (message: string) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class GameRoomConnection {
  private socket: WebSocket | null = null;
  private disposed = false;
  /** 当前这次断线后的第几次重连尝试（首次连接为 0）。 */
  private attempts = 0;
  /** 已经成功连上过至少一次（用于区分「首连」与「重连后兜底拉状态」）。 */
  private everOpened = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pending = new Map<string, PendingAction>();

  constructor(private readonly options: GameRoomConnectionOptions) {}

  /** 开始连接。重复调用是空操作（已连接/已在重连排队时不叠加）。 */
  connect(): void {
    if (this.disposed || this.socket !== null) return;
    this.openSocket();
  }

  /** 彻底关闭：停止重连，挂起的动作全部失败。组件卸载/退出房间时调用。 */
  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject("连接已关闭");
    }
    this.pending.clear();
    this.socket?.close();
    this.socket = null;
  }

  /**
   * 发送一个玩家动作（move/resign/offer_draw/accept_draw/request_undo/accept_undo），
   * 等待对应 action_result：成功 resolve，被服务端拒绝时以中文原因 reject。
   */
  sendAction(action: string, payload?: unknown, baseVersion?: number): Promise<void> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject("连接断开了，正在重连，请稍后再试");
    }
    const actionId =
      typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `act-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(actionId);
        reject("连接不稳定，操作没有收到回应，请稍后再试");
      }, ACTION_TIMEOUT_MS);
      this.pending.set(actionId, { resolve, reject, timer });
      this.send({
        type: "action",
        actionId,
        action,
        ...(payload === undefined ? {} : { payload }),
        ...(baseVersion === undefined ? {} : { baseVersion }),
      } satisfies GameClientMessage);
    });
  }

  /** 准备切换（大厅阶段）。结果靠广播回来的 state 更新。 */
  sendReady(ready: boolean): void {
    this.send({ type: "ready", ready });
  }

  /** 开局（仅房主，引擎校验双方已准备）。 */
  sendStart(): void {
    this.send({ type: "start" });
  }

  /** 离开房间。 */
  sendLeave(): void {
    this.send({ type: "leave" });
  }

  // ------------------------------------------------------------------
  // 内部
  // ------------------------------------------------------------------

  private send(message: GameClientMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    try {
      this.socket.send(JSON.stringify(message));
    } catch {
      // 发送失败等价于断开：onclose 会接手重连。
    }
  }

  private openSocket(): void {
    if (this.disposed) return;
    this.options.onStatus("connecting", Math.max(1, this.attempts));
    let socket: WebSocket;
    try {
      socket = new WebSocket(gameRoomSocketUrl(this.options.roomId), gameAuthSubprotocol());
    } catch {
      this.socket = null;
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.everOpened = true;
      const wasReconnect = this.attempts > 0;
      this.attempts = 0;
      this.options.onStatus("open", 0);
      // 重连成功后先拉一次 REST 视图兜底（getState 恢复）：断线期间错过的
      // 状态变更由它补齐，此后的 WS 推送维持实时。
      if (wasReconnect) void this.restoreAfterReconnect();
    };
    socket.onmessage = (event: MessageEvent) => this.handleMessage(event.data);
    socket.onclose = () => {
      if (this.socket === socket) this.socket = null;
      this.failPending("连接已断开，操作没有完成");
      if (this.disposed) {
        this.options.onStatus("closed", this.attempts);
        return;
      }
      this.options.onStatus("closed", this.attempts);
      this.scheduleReconnect();
    };
    socket.onerror = () => {
      try {
        socket.close();
      } catch {
        // close 在某些 readyState 下抛错；onclose 仍会触发。
      }
    };
  }

  private async restoreAfterReconnect(): Promise<void> {
    const result = await fetchGameRoomState(this.options.roomId);
    if (this.disposed) return;
    if (!result.ok) {
      if (result.error.code === "room_not_found") {
        this.options.onFatal(gameErrorText("room_not_found"));
        this.dispose();
      }
      return; // 其它错误交给后续 WS 推送与下一次重连兜底。
    }
    this.options.onState(result.data.view, result.data.role);
  }

  private handleMessage(data: unknown): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(data));
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    const message = parsed as Record<string, unknown>;
    if (message.type === "state") {
      this.options.onState(
        message.view as GamePlayerView | GamePublicView,
        message.role === "player" ? "player" : "spectator",
      );
      return;
    }
    if (message.type === "action_result") {
      const actionId = typeof message.actionId === "string" ? message.actionId : "";
      const pending = actionId ? this.pending.get(actionId) : undefined;
      if (pending) {
        this.pending.delete(actionId);
        clearTimeout(pending.timer);
        if (message.ok === true) {
          pending.resolve();
        } else {
          pending.reject(actionErrorText(message.error));
        }
        return;
      }
      // ready/start/leave 等一次性消息的失败也提示（无挂起 promise 可 reject）。
      if (message.ok !== true) this.options.onNotice(actionErrorText(message.error));
      return;
    }
    if (message.type === "error") {
      const text = gameErrorText(typeof message.code === "string" ? message.code : null, message.message as string);
      if (message.code === "room_not_found") {
        this.options.onFatal(text);
        this.dispose();
        return;
      }
      this.options.onNotice(text);
    }
    if (message.type === "presence") {
      const players = typeof message.onlinePlayers === "number" ? message.onlinePlayers : null;
      const spectators = typeof message.onlineSpectators === "number" ? message.onlineSpectators : null;
      if (players !== null && spectators !== null) this.options.onPresence?.({ players, spectators });
    }
  }

  private failPending(message: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(message);
    }
    this.pending.clear();
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer !== null) return;
    this.attempts += 1;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** (this.attempts - 1), RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }
}

function actionErrorText(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const record = error as { code?: unknown; message?: unknown };
    return gameErrorText(
      typeof record.code === "string" ? record.code : null,
      typeof record.message === "string" ? record.message : null,
    );
  }
  return gameErrorText("unknown_error", "操作没有成功，请稍后再试");
}
