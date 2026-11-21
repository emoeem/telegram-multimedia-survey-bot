/**
 * 多人对局房间 Durable Object（P0 批次 G1 协议底座）。
 *
 * 为什么用 DO：房间是"一个房间的所有玩家对一个状态做并发读写"——与
 * rate-limit.ts 同一个理由（DO 把并发串行化），再加两条它独有的需求：
 * 1. WebSocket Hibernation（本仓库第一个实现）：空闲连接休眠后不计费、
 *   不占内存，消息到达/断开由运行时把 DO 叫醒。玩家/观战连接用 tag 区分，
 *   身份放在 attachment 里——休眠期间内存全丢，presence 只能从
 *   ctx.getWebSockets() + attachment 推导，不能放在实例字段里。
 * 2. alarm() 驱动回合倒计时 / 整局超时 / 空房间回收（survey-session.ts 的
 *   setAlarm 先例：终态即停闹，不做常驻心跳）。
 *
 * 存储纪律：房间实时态只写 DO storage（键 `room` + `act:<actionId>` 去重表
 * + `settlement` 结算快照 + 聊天暂存 `chat:*`）。**DO 与引擎绝不触碰
 * D1/KV/R2**——"每步棋不触 D1"，索引与终态由 HTTP 层写进 game_rooms /
 * game_matches（0105）。聊天只暂存文字（环形 50 条，断线重连补发），语音/
 * 图片收到即中继、不落任何存储；settle/close/回收三条路径全部清空 `chat:*`
 * （对局结束即焚）。
 *
 * 身份信任模型：Worker（src/http/game-api.ts）用 resolveParticipant 鉴权后，
 * 把身份放进 `x-game-viewer-hash` / `x-game-role` 头转发进来；DO 内部绑定
 * 不对外网暴露，头即可信。引擎收到 participantHash 仍做房间成员校验
 * （协议不变量：所有玩家动作服务端校验）。
 */
import { DurableObject } from "cloudflare:workers";

import { resolveGameEngine } from "../game/multiplayer/engine-registry";
import {
  CHAT_HISTORY_LIMIT,
  gameRoomDOName,
  parseGameRoomRef,
  type ChatClientMessage,
  type GameActionRecord,
  type GameChatMessage,
  type GameClientMessage,
  type GameProtocolErrorCode,
  type GamePublicView,
  type GamePlayerView,
  type GameRoomAction,
  type GameRoomPlayer,
  type GameRoomState,
  type GameServerMessage,
  type GameSettlement,
  type EngineOutcome,
} from "../game/multiplayer/engine-types";
import {
  canAccessChannel,
  chatChannelAccess,
  chatPurgeRequired,
  chatRateFilter,
  chatRingEvictionSeq,
  chatSeqKey,
  type ChatChannelAccess,
  validateChatImage,
  validateChatText,
  validateChatVoice,
  visibleChatHistory,
} from "../game/multiplayer/chat-logic";

const ROOM_KEY = "room";
const SETTLEMENT_KEY = "settlement";
const ACTION_KEY_PREFIX = "act:";
/** 聊天序号计数器（单调整数，文字暂存键由它派生）。 */
const CHAT_SEQ_KEY = "chat:seq";
/** 每参与者速率窗口键：值 = 最近成功发送的时间戳数组（滑动窗口，休眠不丢）。 */
const CHAT_RATE_KEY_PREFIX = "chat:rate:";
/** 文字聊天暂存键前缀（值 = GameChatMessage；语音/图片绝不落这个前缀）。 */
const CHAT_MSG_KEY_PREFIX = "chat:m:";
/** 聊天全部键的公共前缀（即焚清理与回收兜底的删除范围）。 */
const CHAT_KEY_PREFIX = "chat:";

/** lobby 空房间（无任何在线连接且全员未开局）的回收时延。 */
const EMPTY_ROOM_TTL_MS = 30 * 60 * 1000;
/** seatToken / rngNonce 的随机字节数（hex 后 32 字符；随机性与冒充成本对齐）。 */
const ROOM_TOKEN_BYTES = 16;
/** 已结算/已关闭房间的保留时延：终态快照留给 REST 层捞进 game_matches，之后清空。 */
const SETTLED_ROOM_TTL_MS = 24 * 60 * 1000;
/** 房主走光等极端情况下 closed 房间的兜底清理时延。 */
const CLOSED_ROOM_TTL_MS = 5 * 60 * 1000;

/** WS 连接 attachment：休眠唤醒后从这里恢复身份（内存字段不可靠）。 */
interface SocketAttachment {
  participantHash: string;
  role: "player" | "spectator";
}

/** DO 内部 HTTP 协议的错误响应（与 src/http/api-response.ts 的 fail 同形状）。 */
function doFail(status: number, code: GameProtocolErrorCode, message: string): Response {
  return Response.json({ ok: false, code, message }, { status });
}

/**
 * 随机令牌（hex）：seatToken 与 rngNonce 共用的唯一随机源。Workers 与 vitest
 * （Node webcrypto）都提供全局 crypto.getRandomValues，无部署差异。
 */
function randomRoomToken(): string {
  const bytes = new Uint8Array(ROOM_TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * 存量状态兜底（修复 1/2 的部署兼容）：旧部署写下的房间行没有 seatToken /
 * rngNonce（新协议字段），loadRoom 时在这里补铸——引擎在本次请求里就能拿到
 * 完整字段，补铸结果随后续 commitState 落盘，同一座位跨请求保持同一令牌。
 * 有值的一律原样保留（重入不换牌，客户端对位稳定）。
 */
function withRoomInvariants(state: GameRoomState): GameRoomState {
  let changed = false;
  const players = state.players.map((player) => {
    if (typeof player.seatToken === "string" && player.seatToken !== "") return player;
    changed = true;
    return { ...player, seatToken: randomRoomToken() };
  });
  const rngNonce = typeof state.rngNonce === "string" && state.rngNonce !== "" ? state.rngNonce : randomRoomToken();
  if (rngNonce !== state.rngNonce) changed = true;
  return changed ? { ...state, players, rngNonce } : state;
}

function protocolError(
  code: GameProtocolErrorCode,
  message: string,
): { ok: false; error: { code: GameProtocolErrorCode; message: string } } {
  return { ok: false, error: { code, message } };
}

/** 聊天被拒的统一回帧形状（type:"error" 帧不含 ok 字段）。 */
function chatErrorFrame(
  code: GameProtocolErrorCode,
  message: string,
): { message: GameServerMessage; stateChanged: false } {
  return { message: { type: "error", code, message }, stateChanged: false };
}

export class GameRoomDO extends DurableObject {
  // ------------------------------------------------------------------
  // HTTP 入口：REST 转发的控制面 + WS 握手
  // ------------------------------------------------------------------
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // WS 握手：Worker 已鉴权（非鉴权用户在 HTTP 层就被 401/403 拦下，到不了
    // 这里）。DO 生成 WebSocketPair 并 acceptWebSocket 挂上 Hibernation。
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      return this.handleWebSocketUpgrade(request);
    }

    if (request.method !== "POST") {
      if (request.method === "GET" && url.pathname === "/state") {
        return this.handleGetState(request);
      }
      return doFail(405, "invalid_payload", "房间控制面仅接受 POST（WS 握手除外）");
    }

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return doFail(400, "invalid_payload", "请求体必须是 JSON");
    }

    // 查看者身份（Worker 鉴权后注入）：携带时 OK 响应附带按人裁剪的视图，
    // REST 层只透传视图给客户端。
    const viewerHash = request.headers.get("x-game-viewer-hash") ?? "";

    switch (url.pathname) {
      case "/create":
        return this.handleCreate(body, viewerHash);
      case "/join":
        return this.handleJoin(body, viewerHash);
      case "/ready":
        return this.handleReady(body, viewerHash);
      case "/start":
        return this.handleStart(body, viewerHash);
      case "/leave":
        return this.handleLeave(body, viewerHash);
      case "/close":
        return this.handleClose(body, viewerHash);
      case "/action":
        return this.handleAction(body, viewerHash);
      default:
        return doFail(404, "invalid_payload", `未知控制面路径 ${url.pathname}`);
    }
  }

  /** GET /state：按查看者身份返回裁剪视图（REST 只透传视图，绝不透传裸 state）。 */
  private async handleGetState(request: Request): Promise<Response> {
    const viewerHash = request.headers.get("x-game-viewer-hash") ?? "";
    const room = await this.loadRoom();
    if (!room) return doFail(404, "room_not_found", "房间不存在或已被回收");
    const isPlayer =
      viewerHash !== "" && room.players.some((p) => p.participantHash === viewerHash && p.leftAt === null);
    const view = isPlayer ? await this.buildPlayerView(room, viewerHash) : await this.buildPublicView(room);
    return Response.json({
      ok: true,
      view,
      role: isPlayer ? "player" : "spectator",
      ...youSeatTokenField(room, viewerHash),
    });
  }

  // ------------------------------------------------------------------
  // 房间生命周期
  // ------------------------------------------------------------------

  /** 创建房间：POST /create {gameType, roomId, config, host}。 */
  private async handleCreate(body: Record<string, unknown>, viewerHash = ""): Promise<Response> {
    const gameType = typeof body.gameType === "string" ? body.gameType : "";
    const roomId = typeof body.roomId === "string" ? body.roomId : "";
    const host = body.host as { participantHash?: unknown; displayName?: unknown } | undefined;
    if (!roomId || !gameType) {
      return doFail(400, "invalid_payload", "缺少 roomId 或 gameType");
    }
    if (!parseGameRoomRef(roomId)) {
      // 房间标识锁定：只接受 room_<数字> 形态（与深链接 startapp 一致）。
      return doFail(400, "invalid_payload", "roomId 必须是 room_<数字id> 格式");
    }
    if (!host || typeof host.participantHash !== "string" || !host.participantHash) {
      return doFail(401, "invalid_payload", "缺少房主身份");
    }
    if (await this.ctx.storage.get(ROOM_KEY)) {
      return doFail(409, "invalid_action", "房间已存在");
    }
    const engine = resolveGameEngine(gameType);
    if (!engine) {
      return doFail(400, "unknown_game_type", `未登记的玩法 ${gameType}`);
    }

    const now = new Date().toISOString();
    const state: GameRoomState = {
      roomId,
      gameType,
      status: "lobby",
      version: 1,
      config: (body.config as Record<string, unknown> | undefined) ?? {},
      players: [
        {
          participantHash: host.participantHash,
          // 座位令牌在座位分配处铸造（修复 1）：对外载荷的唯一玩家标识。
          seatToken: randomRoomToken(),
          displayName: typeof host.displayName === "string" ? host.displayName : null,
          isHost: true,
          ready: false,
          joinedAt: now,
          leftAt: null,
        },
      ],
      // RNG 盐（修复 2）：随机铸造、只存 DO storage，绝不进任何对外载荷。
      rngNonce: randomRoomToken(),
      engineState: null,
      createdAt: now,
      updatedAt: now,
      deadlineAt: null,
      recycleAt: Date.now() + EMPTY_ROOM_TTL_MS,
      closedAt: null,
    };
    const outcome = engine.createRoom(state, state.config);
    if (!outcome.ok) return this.engineErrorResponse(outcome);
    await this.commitState(outcome.state);
    return this.withView(outcome.state, viewerHash);
  }

  /** 加入：POST /join {participantHash, displayName?, asSpectator?}。 */
  private async handleJoin(body: Record<string, unknown>, viewerHash = ""): Promise<Response> {
    const identity = requireIdentity(body);
    if (!identity.ok) return doFail(401, "invalid_payload", "缺少玩家身份");
    const room = await this.loadRoom();
    if (!room) return doFail(404, "room_not_found", "房间不存在或已被回收");

    const hash = identity.participantHash;
    const displayName = typeof body.displayName === "string" ? body.displayName : null;
    const asSpectator = body.asSpectator === true;

    // 观战：不改房间状态，直接放行（连接升级时再挂 tag）。
    if (asSpectator) {
      return this.withView(room, viewerHash, { role: "spectator" });
    }

    // 重入（刷新页面/断线重连）：幂等返回当前状态，不动 version。
    const existing = room.players.find((player) => player.participantHash === hash);
    if (existing && !existing.leftAt) {
      return this.withView(room, viewerHash, { rejoined: true });
    }

    const engine = resolveGameEngine(room.gameType);
    if (!engine) return doFail(500, "internal_error", "玩法引擎未注册");
    const player: GameRoomPlayer = existing
      ? // 曾离开的玩家重新入座，房主身份与座位令牌随行保留（客户端对位稳定；
        // 存量行缺 seatToken 时补铸一次，与本房间其他座位不再冲突）。
        { ...existing, leftAt: null, ...(existing.seatToken ? {} : { seatToken: randomRoomToken() }) }
      : {
          participantHash: hash,
          // 座位令牌在座位分配处铸造（修复 1）：与房主同源、互不关联。
          seatToken: randomRoomToken(),
          displayName,
          isHost: false, // 房主只有创建者一人，后来者一律非房主
          ready: false,
          joinedAt: new Date().toISOString(),
          leftAt: null,
        };
    // players 不含该玩家（重入者旧行也剔除）交给引擎：由引擎追加并铸造
    // 私密信息——满员判定与座位表都是引擎的职责。
    const players = room.players.filter((p) => p.participantHash !== hash);
    const outcome = engine.joinRoom({ ...room, players }, player);
    if (!outcome.ok) {
      // 第三人进入房间 = 只读观战：坐不下（满员/已开局）不报错，降级为
      // 公开视图放行——不占座位、不碰房间状态，HTTP 层带 spectatorFallback
      // 让客户端提示“已进入观战”。仍坐着的玩家重入失败属于身份/状态异常，
      // 保持协议错误不静默降级。
      const seatedActive = room.players.some((p) => p.participantHash === hash && p.leftAt === null);
      if (!seatedActive) {
        return this.withView(room, viewerHash, { spectatorFallback: true });
      }
      return this.engineErrorResponse(outcome);
    }
    const next = bumpVersion(outcome.state);
    await this.commitState(next);
    await this.broadcastState();
    return this.withView(next, viewerHash);
  }

  /** 准备切换：POST /ready {participantHash, ready}。 */
  private async handleReady(body: Record<string, unknown>, viewerHash = ""): Promise<Response> {
    const identity = requireIdentity(body);
    if (!identity.ok) return doFail(401, "invalid_payload", "缺少玩家身份");
    const room = await this.loadRoom();
    if (!room) return doFail(404, "room_not_found", "房间不存在或已被回收");
    const engine = resolveGameEngine(room.gameType);
    if (!engine) return doFail(500, "internal_error", "玩法引擎未注册");
    const outcome = engine.setReady(room, identity.participantHash, body.ready === true);
    if (!outcome.ok) return this.engineErrorResponse(outcome);
    const next = bumpVersion(outcome.state);
    await this.commitState(next);
    await this.broadcastState();
    return this.withView(next, viewerHash);
  }

  /** 开局：POST /start {participantHash}（引擎决定 ready 门禁）。 */
  private async handleStart(body: Record<string, unknown>, viewerHash = ""): Promise<Response> {
    const identity = requireIdentity(body);
    if (!identity.ok) return doFail(401, "invalid_payload", "缺少玩家身份");
    const room = await this.loadRoom();
    if (!room) return doFail(404, "room_not_found", "房间不存在或已被回收");
    const engine = resolveGameEngine(room.gameType);
    if (!engine) return doFail(500, "internal_error", "玩法引擎未注册");
    const outcome = engine.start(room, identity.participantHash);
    if (!outcome.ok) return this.engineErrorResponse(outcome);
    const next = bumpVersion(outcome.state);
    await this.commitState(next);
    await this.broadcastState();
    return this.withView(next, viewerHash);
  }

  /** 离开：POST /leave {participantHash}。全员走光则直接进入 closed。 */
  private async handleLeave(body: Record<string, unknown>, viewerHash = ""): Promise<Response> {
    const identity = requireIdentity(body);
    if (!identity.ok) return doFail(401, "invalid_payload", "缺少玩家身份");
    const room = await this.loadRoom();
    if (!room) return doFail(404, "room_not_found", "房间不存在或已被回收");
    const outcome = await this.applyLeave(room, identity.participantHash);
    if (!outcome.ok) return this.engineErrorResponse(outcome);
    const next = bumpVersion(outcome.state);
    await this.commitState(next);
    await this.broadcastState();
    return this.withView(next, viewerHash);
  }

  /**
   * 关闭：POST /close {participantHash}（仅房主）。终态 → REST 层写审计与
   * D1 closed_at；snapshot 保留至回收。
   */
  private async handleClose(body: Record<string, unknown>, viewerHash = ""): Promise<Response> {
    const identity = requireIdentity(body);
    if (!identity.ok) return doFail(401, "invalid_payload", "缺少玩家身份");
    const room = await this.loadRoom();
    if (!room) return doFail(404, "room_not_found", "房间不存在或已被回收");
    const player = room.players.find((p) => p.participantHash === identity.participantHash);
    if (!player?.isHost) return doFail(403, "not_host", "只有房主可以关闭房间");
    if (room.status === "closed") return this.withView(room, viewerHash);
    const next: GameRoomState = bumpVersion({ ...room, status: "closed" });
    await this.commitState(next);
    await this.broadcastState();
    return this.withView(next, viewerHash);
  }

  /**
   * 离开的共享实现（REST /leave 与 WS {type:"leave"} 同一语义）：
   * 对局中离席 = 认输——先走引擎 resign 结算出胜负，再把人标记离开。否则
   * 剩下的一方会被卡在对方的回合上等到超时判负，这是不公平的结局。
   * 引擎不支持 resign（协议桩等）时退回默认实现，绝不因离开而报错。
   */
  private async applyLeave(room: GameRoomState, participantHash: string): Promise<EngineOutcome> {
    const leaver = room.players.find((player) => player.participantHash === participantHash);
    if (room.status === "playing" && leaver && leaver.leftAt === null) {
      const engine = resolveGameEngine(room.gameType);
      if (engine) {
        // actionId 用房间版本圈定唯一性：leave 不走 DO 去重表，同一 version
        // 重放会被引擎的 actionIds 兜底拒绝，不同 version 各自成立。
        const resign = engine.applyAction(room, {
          actionId: `leave:${participantHash}:${room.version}`,
          participantHash,
          action: "resign",
        });
        if (resign.ok) {
          let state = bumpVersion(resign.state);
          if (engine.checkGameOver(state)) state = await this.settleRoom(state, engine);
          // 结算后再把人标记离开：对局已终不影响胜负，但 leftAt 是"此人不在
          // 座"的唯一事实来源（视图/座位表都靠它）。
          const left = leaveRoomDefault(state, participantHash);
          return left.ok ? left : { ok: true, state };
        }
      }
    }
    return leaveRoomDefault(room, participantHash);
  }

  /**
   * 玩家动作：POST /action {actionId, participantHash, action, payload, baseVersion}。
   *
   * 协议不变量在此收口：
   * - 去重表 `act:<actionId>` 命中 → 原样重放首次结果（幂等，只结算一次）；
   * - baseVersion 落后 → stale_action（防旧状态覆盖）；
   * - 引擎接受 → version +1（唯一 bump 点）并写去重记录。
   */
  private async handleAction(body: Record<string, unknown>, viewerHash = ""): Promise<Response> {
    const identity = requireIdentity(body);
    if (!identity.ok) return doFail(401, "invalid_payload", "缺少玩家身份");
    const actionId = typeof body.actionId === "string" ? body.actionId : "";
    const action = typeof body.action === "string" ? body.action : "";
    if (!actionId || !action) return doFail(400, "invalid_payload", "缺少 actionId 或 action");

    const room = await this.loadRoom();
    if (!room) return doFail(404, "room_not_found", "房间不存在或已被回收");

    // 协议不变量二：幂等重放。去重表在 DO storage，休眠/重启都不丢。
    const record = await this.ctx.storage.get<GameActionRecord>(ACTION_KEY_PREFIX + actionId);
    if (record) {
      return Response.json({
        ok: true,
        duplicate: true,
        version: record.version,
        accepted: record.accepted,
        ...(record.errorCode ? { code: record.errorCode, message: "动作已被处理过" } : {}),
      });
    }

    const baseVersion = typeof body.baseVersion === "number" ? body.baseVersion : null;
    if (baseVersion !== null && baseVersion !== room.version) {
      const error = protocolError("stale_action", "局面已更新，请刷新后重试");
      await this.recordAction(actionId, room.version, false, error.error.code);
      return Response.json({ ok: false, code: error.error.code, message: error.error.message }, { status: 409 });
    }

    const engine = resolveGameEngine(room.gameType);
    if (!engine) return doFail(500, "internal_error", "玩法引擎未注册");
    const actionRequest: GameRoomAction = {
      actionId,
      participantHash: identity.participantHash,
      action,
      payload: body.payload,
      ...(baseVersion !== null ? { baseVersion } : {}),
    };

    let outcome: EngineOutcome;
    try {
      outcome = engine.applyAction(room, actionRequest);
    } catch {
      // 引擎异常不外泄细节：协议层兜成 internal_error（引擎校验应优先返回
      // illegal_move 等可解释错误，这里只兜真正的 bug）。
      outcome = protocolError("internal_error", "动作处理失败");
    }
    if (!outcome.ok) {
      await this.recordAction(actionId, room.version, false, outcome.error.code);
      return Response.json(
        { ok: false, code: outcome.error.code, message: outcome.error.message },
        { status: actionStatusFor(outcome.error.code) },
      );
    }

    let next: GameRoomState = bumpVersion(outcome.state);
    // 结算判定是协议职责（引擎忘了调 checkGameOver 也不会漏终态）。
    if (next.status === "playing" && engine.checkGameOver(next)) {
      next = await this.settleRoom(next, engine);
    }
    await this.commitState(next);
    await this.recordAction(actionId, next.version, true);
    await this.broadcastState();
    return this.withView(next, viewerHash, { version: next.version });
  }

  /**
   * OK 响应统一附加按人裁剪的视图（协议不变量三）：REST 层只把 view/version
   * 透传给客户端；`state` 字段是 Worker ⇄ DO 的内部契约，REST 层不得转发。
   * 另附查看者自己的座位令牌（youSeatToken）：REST 层把它 relay 成 `you`，
   * 客户端拿它对位信封 players / 引擎座位——`you` 不再携带 participantHash。
   */
  private async withView(
    state: GameRoomState,
    viewerHash: string,
    extra: Record<string, unknown> = {},
  ): Promise<Response> {
    if (!viewerHash) return Response.json({ ok: true, ...extra, state });
    const isPlayer = state.players.some((p) => p.participantHash === viewerHash && p.leftAt === null);
    const view = isPlayer ? await this.buildPlayerView(state, viewerHash) : await this.buildPublicView(state);
    return Response.json({
      ok: true,
      ...extra,
      state,
      view,
      role: isPlayer ? "player" : "spectator",
      ...youSeatTokenField(state, viewerHash),
    });
  }

  // ------------------------------------------------------------------
  // WebSocket Hibernation（本仓库首个实现）
  // ------------------------------------------------------------------

  private async handleWebSocketUpgrade(request: Request): Promise<Response> {
    const viewerHash = request.headers.get("x-game-viewer-hash") ?? "";
    if (!viewerHash) {
      // 防御位：Worker 层必须先鉴权；没有身份头的升级请求一律拒绝。
      return doFail(401, "invalid_payload", "缺少已鉴权的观众身份");
    }
    const room = await this.loadRoom();
    if (!room) return doFail(404, "room_not_found", "房间不存在或已被回收");

    const pair = new WebSocketPair();
    await this.registerSocket(pair[1], viewerHash, room);
    // 101 + client 端回给升级方；server 端由 Hibernation 托管（休眠不占内存，
    // 消息/断开由 webSocketMessage/Close/Error 唤醒）。客户端若请求了子协议
    // （game-room-client.ts 用它携带身份），101 必须原样选中其中一个
    // （RFC 6455），否则浏览器判定握手失败直接断连。
    const protocol = (request.headers.get("sec-websocket-protocol") ?? "").split(",")[0]?.trim() ?? "";
    return new Response(null, {
      status: 101,
      webSocket: pair[0],
      ...(protocol !== "" ? { headers: { "Sec-WebSocket-Protocol": protocol } } : {}),
    });
  }

  /**
   * 连接注册（与 101 响应拆开：vitest 没有 workerd 的 101 Response，测试直接
   * 驱动本方法）。tag 区分玩家/观战连接：getWebSockets("player") 直接拿到
   * 玩家连接列表，逐人推送各自的裁剪视图（协议不变量三）。
   */
  private async registerSocket(ws: WebSocket, viewerHash: string, room: GameRoomState): Promise<void> {
    const role: SocketAttachment["role"] = room.players.some(
      (player) => player.participantHash === viewerHash && player.leftAt === null,
    )
      ? "player"
      : "spectator";
    this.ctx.acceptWebSocket(ws, [role]);
    ws.serializeAttachment({ participantHash: viewerHash, role } satisfies SocketAttachment);
    // 连接落地后房间有主：走 commitState 重算 lobby 回收时间（有人在线 = 不回收）。
    await this.commitState(room);
    ws.send(JSON.stringify(await this.buildServerMessage(room, viewerHash, role)));
    // 聊天历史（仅文字，环形 50 条）按查看者频道裁剪补发：断线重连与后进房
    // 的观看者靠它补齐讨论；语音/图片从不暂存，历史里没有它们。
    ws.send(
      JSON.stringify({
        type: "chat_history",
        messages: await this.chatHistoryFor(room, viewerHash),
      } satisfies GameServerMessage),
    );
    // 新连接改变了在线名单：全房推送 presence（对手掉线提示依赖它）。
    await this.broadcastPresence();
  }

  /** 休眠唤醒后的消息入口：与 REST 控制面共用同一分发器（形状见 GameClientMessage）。 */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") {
      ws.send(
        JSON.stringify({
          type: "error",
          code: "invalid_payload",
          message: "仅支持 JSON 文本消息",
        } satisfies GameServerMessage),
      );
      return;
    }
    let parsed: GameClientMessage;
    try {
      parsed = JSON.parse(message) as GameClientMessage;
    } catch {
      ws.send(
        JSON.stringify({
          type: "error",
          code: "invalid_payload",
          message: "消息不是合法 JSON",
        } satisfies GameServerMessage),
      );
      return;
    }
    const attachment = readAttachment(ws);
    const result = await this.dispatchClientMessage(parsed, attachment, ws);
    ws.send(JSON.stringify(result.message));
    if (result.stateChanged) await this.broadcastState();
  }

  /** 断开（含休眠超时清理）：presence 衰减 + 空房间回收倒计时。 */
  async webSocketClose(ws: WebSocket): Promise<void> {
    const room = await this.loadRoom();
    if (!room) return;
    await this.armPresenceRecycle(room, ws);
    await this.broadcastPresence(ws);
  }

  /** 发送失败（客户端半开等）：等同断开处理。 */
  async webSocketError(ws: WebSocket): Promise<void> {
    const room = await this.loadRoom();
    if (!room) return;
    await this.armPresenceRecycle(room, ws);
    await this.broadcastPresence(ws);
  }

  /**
   * WS 客户端消息分发（与 REST 控制面同一套引擎调用，保证两条路径行为一致）。
   * 返回值直接回给发送者；stateChanged 时再向全房间广播。聊天消息额外携带
   * 发送者连接：中继广播要排除它，回显经返回值单发（恰好一份）。
   */
  private async dispatchClientMessage(
    message: GameClientMessage,
    attachment: SocketAttachment | null,
    sender?: WebSocket,
  ): Promise<{ message: GameServerMessage; stateChanged: boolean }> {
    if (!attachment) {
      return { message: { type: "error", code: "invalid_payload", message: "连接缺少身份" }, stateChanged: false };
    }
    const room = await this.loadRoom();
    if (!room) {
      return {
        message: { type: "error", code: "room_not_found", message: "房间不存在或已被回收" },
        stateChanged: false,
      };
    }
    switch (message.type) {
      case "ready": {
        const engine = resolveGameEngine(room.gameType);
        if (!engine)
          return { message: { type: "error", code: "internal_error", message: "玩法引擎未注册" }, stateChanged: false };
        const outcome = engine.setReady(room, attachment.participantHash, message.ready);
        if (!outcome.ok) return { message: { type: "error", ...outcome.error }, stateChanged: false };
        const next = bumpVersion(outcome.state);
        await this.commitState(next);
        return {
          message: { type: "action_result", actionId: "ready", ok: true, version: next.version },
          stateChanged: true,
        };
      }
      case "start": {
        const engine = resolveGameEngine(room.gameType);
        if (!engine)
          return { message: { type: "error", code: "internal_error", message: "玩法引擎未注册" }, stateChanged: false };
        const outcome = engine.start(room, attachment.participantHash);
        if (!outcome.ok) return { message: { type: "error", ...outcome.error }, stateChanged: false };
        const next = bumpVersion(outcome.state);
        await this.commitState(next);
        return {
          message: { type: "action_result", actionId: "start", ok: true, version: next.version },
          stateChanged: true,
        };
      }
      case "leave": {
        const outcome = await this.applyLeave(room, attachment.participantHash);
        if (!outcome.ok) return { message: { type: "error", ...outcome.error }, stateChanged: false };
        const next = bumpVersion(outcome.state);
        await this.commitState(next);
        return {
          message: { type: "action_result", actionId: "leave", ok: true, version: next.version },
          stateChanged: true,
        };
      }
      case "action": {
        const response = await this.handleAction({
          actionId: message.actionId,
          participantHash: attachment.participantHash,
          action: message.action,
          payload: message.payload,
          ...(typeof message.baseVersion === "number" ? { baseVersion: message.baseVersion } : {}),
        });
        const payload = (await response.json()) as Record<string, unknown>;
        if (payload.ok === true) {
          // 去重重放的被拒动作（accepted:false + code）：回 ok:false 的
          // action_result 并带上原错误码——"拒绝也记录：重放同码，客户端不会
          // 对同一动作得到两份真相"（REST 重放同码，WS 路径不得被压成成功）。
          if (payload.accepted === false) {
            return {
              message: {
                type: "action_result",
                actionId: message.actionId,
                ok: false,
                error: {
                  code: (payload.code as GameProtocolErrorCode) ?? "internal_error",
                  message: (payload.message as string) ?? "动作已被处理过",
                },
              },
              stateChanged: false,
            };
          }
          // 首次成功（或成功动作的幂等重放）：handleAction 内部已经
          // broadcastState，这里只回报发起者，stateChanged=false 避免同一帧
          // 推送两次。
          return {
            message: {
              type: "action_result",
              actionId: message.actionId,
              ok: true,
              version: payload.version as number,
            },
            stateChanged: false,
          };
        }
        // 控制面错误已是 {ok:false, code, message} 形状（与 doFail 一致）。
        const error = payload as { code?: GameProtocolErrorCode; message?: string };
        return {
          message: {
            type: "action_result",
            actionId: message.actionId,
            ok: false,
            error: { code: error.code ?? "internal_error", message: error.message ?? "动作处理失败" },
          },
          stateChanged: false,
        };
      }
      case "chat_text":
      case "chat_voice":
      case "chat_image":
        return this.handleChatSend(message, attachment, room, sender);
      default:
        return { message: { type: "error", code: "invalid_payload", message: "未知消息类型" }, stateChanged: false };
    }
  }

  // ------------------------------------------------------------------
  // 房间内聊天（chat_text / chat_voice / chat_image：收到即中继，即焚）
  // ------------------------------------------------------------------

  /**
   * 聊天发送：校验链全部通过才中继——房间状态（结算/关闭即拒）→ 频道资格
   * （wolves 仅狼人、dead 收留死亡与观战）→ 内容大小/审核 → 每参与者速率
   * 窗口。文字入环形暂存（最近 50 条，断线重连补发用）；语音/图片只在内存
   * 里转发，不落任何存储、不进日志。回显经 dispatch 返回值单发给发送者，
   * 其余成员经 broadcastChat 按频道裁剪后收到。
   */
  private async handleChatSend(
    message: ChatClientMessage,
    attachment: SocketAttachment,
    room: GameRoomState,
    sender?: WebSocket,
  ): Promise<{ message: GameServerMessage; stateChanged: boolean }> {
    // 对局结束即焚：结算/关闭的房间不再接受新消息（历史已清空）。
    if (room.status !== "lobby" && room.status !== "playing") {
      return chatErrorFrame("game_over", "对局已结束，聊天已焚毁");
    }
    const access = this.chatAccessFor(room, attachment.participantHash);
    if (!canAccessChannel(access, message.channel)) {
      return chatErrorFrame("chat_channel_forbidden", "你不在该频道的可见范围内");
    }
    // 内容校验先行：被拒的尝试不占速率窗口。
    let kind: GameChatMessage["kind"];
    let payload: Pick<GameChatMessage, "text" | "voice" | "image">;
    if (message.type === "chat_text") {
      const check = validateChatText(message.text);
      if (!check.ok) return chatErrorFrame(check.code, check.message);
      kind = "text";
      payload = { text: check.value };
    } else if (message.type === "chat_voice") {
      const check = validateChatVoice(message.audioBase64, message.durationMs, message.mimeType);
      if (!check.ok) return chatErrorFrame(check.code, check.message);
      kind = "voice";
      payload = { voice: check.value };
    } else {
      const check = validateChatImage(message.dataUrl);
      if (!check.ok) return chatErrorFrame(check.code, check.message);
      kind = "image";
      payload = { image: { dataUrl: check.value } };
    }
    // 速率窗口（每参与者滑动窗口；文字/语音/图片合并计数，状态进 storage 休眠不丢）。
    const rateKey = CHAT_RATE_KEY_PREFIX + attachment.participantHash;
    const decision = chatRateFilter((await this.ctx.storage.get<number[]>(rateKey)) ?? [], Date.now());
    if (!decision.allowed) {
      const seconds = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
      return chatErrorFrame("chat_rate_limited", `发言太频繁了，请 ${seconds} 秒后再试`);
    }
    await this.ctx.storage.put(rateKey, decision.next);

    const seq = ((await this.ctx.storage.get<number>(CHAT_SEQ_KEY)) ?? 0) + 1;
    await this.ctx.storage.put(CHAT_SEQ_KEY, seq);
    // 发送者=座位昵称（观战者无座位行，固定「观战者」）；绝不带 IP/UA。
    const from =
      attachment.role === "player"
        ? (room.players.find((p) => p.participantHash === attachment.participantHash)?.displayName ?? "玩家")
        : "观战者";
    // 署名用座位令牌（修复 1）：participantHash 是身份凭证，从协议形状上就不
    // 允许出现在聊天帧里。观战者无座位，fromSeat 为空串（客户端不把它当
    // 「我发的」对位依据——回显仍按 clientId 匹配）。
    const fromSeat =
      attachment.role === "player"
        ? (room.players.find((p) => p.participantHash === attachment.participantHash)?.seatToken ?? "")
        : "";
    const chat: GameChatMessage = {
      seq,
      channel: message.channel,
      kind,
      from,
      fromSeat,
      at: Date.now(),
      clientId: typeof message.clientId === "string" ? message.clientId.slice(0, 64) : "",
      ...payload,
    };
    // 只有文字入环形暂存；语音/图片不落盘（存储成本与隐私即焚的要求）。
    if (kind === "text") {
      await this.ctx.storage.put(chatSeqKey(seq), chat);
      const evictSeq = chatRingEvictionSeq(seq, CHAT_HISTORY_LIMIT);
      if (evictSeq !== null) await this.ctx.storage.delete(chatSeqKey(evictSeq));
    }
    await this.broadcastChat(chat, sender);
    return { message: { type: "chat", message: chat }, stateChanged: false };
  }

  /** 频道资格：在座与否 + 引擎 chatMembership 钩子（纯判定在 chat-logic）。 */
  private chatAccessFor(room: GameRoomState, participantHash: string): ChatChannelAccess {
    const active = room.players.some((p) => p.participantHash === participantHash && p.leftAt === null);
    const engine = resolveGameEngine(room.gameType);
    const hook = active && engine?.chatMembership ? engine.chatMembership(room, participantHash) : null;
    return chatChannelAccess({ isActivePlayer: active, isSpectator: !active, hook });
  }

  /**
   * 聊天中继：按频道裁剪的定向推送——绝不做全房广播（wolves 帧发给非狼 =
   * 私密信息泄漏）。发送者连接被排除（回显走 dispatch 返回值，恰好一份）；
   * 同一发送者的其他连接（多端/重连期）仍按资格正常收到。
   */
  private async broadcastChat(message: GameChatMessage, exclude?: WebSocket): Promise<void> {
    const room = await this.loadRoom();
    if (!room) return;
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === exclude) continue;
      const attachment = readAttachment(socket);
      if (!attachment) continue;
      if (!canAccessChannel(this.chatAccessFor(room, attachment.participantHash), message.channel)) continue;
      try {
        socket.send(JSON.stringify({ type: "chat", message } satisfies GameServerMessage));
      } catch {
        // 单连接失败不阻断中继；断开由 webSocketClose/Error 收尾。
      }
    }
  }

  /** 断线重连/后进房补发：环形暂存的文字按查看者频道裁剪（语音/图片从不暂存）。 */
  private async chatHistoryFor(room: GameRoomState, viewerHash: string): Promise<GameChatMessage[]> {
    const access = this.chatAccessFor(room, viewerHash);
    const stored = await this.ctx.storage.list<GameChatMessage>({ prefix: CHAT_MSG_KEY_PREFIX });
    // 存量兜底（修复 1）：旧部署写入的暂存消息签名是 fromHash（participantHash），
    // 补发前统一清洗成 fromSeat——历史帧与实时帧走同一条隐私边界。
    return visibleChatHistory([...stored.values()], access).map((message) => sanitizeChatMessage(room, message));
  }

  /** 聊天即焚：删除 chat:* 全部键（文字暂存 / 速率窗口 / 序号计数）。 */
  private async clearChat(): Promise<void> {
    const keys = [...(await this.ctx.storage.list({ prefix: CHAT_KEY_PREFIX })).keys()];
    if (keys.length > 0) await this.ctx.storage.delete(keys);
  }

  // ------------------------------------------------------------------
  // 视图装配（协议不变量三的执行点）
  // ------------------------------------------------------------------

  private async buildServerMessage(
    room: GameRoomState,
    viewerHash: string,
    role: "player" | "spectator",
  ): Promise<GameServerMessage> {
    return {
      type: "state",
      role,
      view: role === "player" ? await this.buildPlayerView(room, viewerHash) : await this.buildPublicView(room),
    };
  }

  /** 玩家视图：信封由 DO 装配，玩法载荷经引擎裁剪（五子棋也走裁剪，为狼人杀留路）。 */
  private async buildPlayerView(room: GameRoomState, viewerHash: string): Promise<GamePlayerView> {
    const engine = resolveGameEngine(room.gameType);
    const view = engine ? engine.getPlayerView(room, viewerHash).view : null;
    const settlement = room.status === "settled" ? await this.loadSettlement() : undefined;
    return {
      roomId: room.roomId,
      gameType: room.gameType,
      status: room.status,
      version: room.version,
      players: room.players.map(toPublicPlayer),
      view,
      remainingMs: remainingMs(room),
      ...(settlement ? { settlement } : {}),
    };
  }

  /** 公开视图（观战/未加入者）：同样走引擎的公开裁剪路径。 */
  private async buildPublicView(room: GameRoomState): Promise<GamePublicView> {
    const engine = resolveGameEngine(room.gameType);
    const view = engine ? engine.getPublicView(room).view : null;
    const settlement = room.status === "settled" ? await this.loadSettlement() : undefined;
    return {
      roomId: room.roomId,
      gameType: room.gameType,
      status: room.status,
      version: room.version,
      players: room.players.map(toPublicPlayer),
      view,
      remainingMs: remainingMs(room),
      ...(settlement ? { settlement } : {}),
    };
  }

  /**
   * 逐连接推送各自的裁剪视图——绝不做"同一条 state 消息全房广播"：那等于把
   * 狼人杀的私密手牌发给所有人，协议不变量三会在广播处被击穿。
   */
  private async broadcastState(): Promise<void> {
    const room = await this.loadRoom();
    if (!room) return;
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = readAttachment(ws);
      if (!attachment) continue;
      const message = await this.buildServerMessage(room, attachment.participantHash, attachment.role);
      try {
        ws.send(JSON.stringify(message));
      } catch {
        // 单个连接发失败不阻断其他人的推送；断开由 webSocketClose/Error 收尾。
      }
    }
  }

  /**
   * 全房推送在线人数（协议里的 presence 消息，state 不带名单）：玩家按身份
   * 去重（同一人多端/重连期会有多条连接），观战同理。断开事件触发时运行时
   * 的连接表未必已摘掉该连接，所以接受 exclude 参数排除正在收尾的连接。
   */
  private async broadcastPresence(exclude?: WebSocket): Promise<void> {
    const sockets = this.ctx.getWebSockets().filter((ws) => ws !== exclude);
    const counts = presenceCounts(sockets.map(readAttachment));
    const message: GameServerMessage = {
      type: "presence",
      onlinePlayers: counts.players,
      onlineSpectators: counts.spectators,
    };
    for (const ws of sockets) {
      try {
        ws.send(JSON.stringify(message));
      } catch {
        // 单个连接发失败不阻断其他人的推送；断开由 webSocketClose/Error 收尾。
      }
    }
  }

  // ------------------------------------------------------------------
  // alarm：回合倒计时 / 整局超时 / 空房间回收
  // ------------------------------------------------------------------

  /**
   * 闹钟只有一个，所以优先级是：回收 > 倒计时；两者都无 → deleteAlarm 收灯
   * （rate-limit.ts 的"不留下常驻心跳"纪律）。
   */
  async alarm(): Promise<void> {
    const room = await this.loadRoom();
    if (!room) {
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const now = Date.now();

    // 1) 空房间/终态回收：整个实例清空（DO storage 是房间唯一载体）。
    if (room.recycleAt !== null && room.recycleAt <= now) {
      await this.ctx.storage.deleteAll();
      // 显式收灯（rate-limit.ts 同款纪律）：运行时会清掉已触发的闹钟，这里
      // 写明白让"回收后彻底安静"可测，不依赖运行时细节。
      await this.ctx.storage.deleteAlarm();
      return;
    }

    // 2) 回合/整局超时：交给引擎判定（判超时方/平局/中止），再走统一结算。
    if (room.status === "playing" && room.deadlineAt !== null && room.deadlineAt <= now) {
      const engine = resolveGameEngine(room.gameType);
      if (engine) {
        let next: EngineOutcome;
        try {
          next = engine.handleTimeout({ ...room }, now);
        } catch {
          next = protocolError("internal_error", "超时处理失败");
        }
        if (next.ok) {
          let state = bumpVersion(next.state);
          if (state.status === "playing" && engine.checkGameOver(state)) {
            state = await this.settleRoom(state, engine);
          }
          await this.commitState(state);
          await this.broadcastState();
        }
      }
    }

    // 3) 重新武装：还有等待中的截止点才续闹。
    await this.ensureAlarm();
  }

  // ------------------------------------------------------------------
  // 状态提交与闹钟编排
  // ------------------------------------------------------------------

  /** 唯一的持久化入口：更新 updatedAt，并按状态重算回收时间、编排闹钟。 */
  private async commitState(state: GameRoomState): Promise<void> {
    const next: GameRoomState = { ...state, updatedAt: new Date().toISOString() };
    const online = this.ctx.getWebSockets().length;
    if (next.status === "closed") {
      next.closedAt = next.closedAt ?? next.updatedAt;
      next.recycleAt = Date.now() + CLOSED_ROOM_TTL_MS;
    } else if (next.status === "playing") {
      // 对局中的房间由 deadlineAt 驱动，绝不能带旧回收时间——否则开局后
      // 第一次 commitState 会把 lobby 阶段的回收闹钟带进对局。
      next.recycleAt = null;
    } else if (next.status === "lobby") {
      next.recycleAt = online === 0 ? Date.now() + EMPTY_ROOM_TTL_MS : null;
    }
    await this.ctx.storage.put(ROOM_KEY, next);
    // 即焚：结算/关闭的房间立刻清空聊天（环形文字 + 速率窗口 + 序号）。回收
    // 路径另有 alarm 的 storage.deleteAll 兜底，但即焚不必等回收 TTL——对局
    // 一结束聊天就该消失。幂等：终态房间的后续 commit（如重连观战）重复清。
    if (chatPurgeRequired(next.status)) await this.clearChat();
    await this.ensureAlarm();
  }

  /** 结算：快照进 `settlement` 键，终态保留留给 REST 层捞进 game_matches。 */
  private async settleRoom(
    state: GameRoomState,
    engine: NonNullable<ReturnType<typeof resolveGameEngine>>,
  ): Promise<GameRoomState> {
    const settlement: GameSettlement = { ...engine.settle(state), version: state.version };
    const next: GameRoomState = {
      ...state,
      status: "settled",
      deadlineAt: null,
      recycleAt: Date.now() + SETTLED_ROOM_TTL_MS,
    };
    await this.ctx.storage.put(SETTLEMENT_KEY, settlement);
    return next;
  }

  private async loadSettlement(): Promise<GameSettlement | undefined> {
    return (await this.ctx.storage.get<GameSettlement>(SETTLEMENT_KEY)) ?? undefined;
  }

  private async loadRoom(): Promise<GameRoomState | null> {
    const stored = await this.ctx.storage.get<GameRoomState>(ROOM_KEY);
    if (!stored) return null;
    // 存量兜底（修复 1/2）：旧部署写下的房间行没有 seatToken/rngNonce，读取
    // 时补铸并立即落盘——保证同一座位跨请求令牌稳定（绝不每次读都换牌）。
    const room = withRoomInvariants(stored);
    if (room !== stored) await this.ctx.storage.put(ROOM_KEY, room);
    return room;
  }

  private async ensureAlarm(): Promise<void> {
    const room = await this.loadRoom();
    const candidates = [room?.recycleAt ?? null, room?.status === "playing" ? (room.deadlineAt ?? null) : null].filter(
      (value): value is number => typeof value === "number",
    );
    const next = candidates.length > 0 ? Math.min(...candidates) : null;
    const current = await this.ctx.storage.getAlarm();
    if (next === null) {
      if (current !== null) await this.ctx.storage.deleteAlarm();
      return;
    }
    // 只在需要提前唤醒时改闹钟；已设的更早闹钟保持不动。
    if (current === null || current > next) {
      await this.ctx.storage.setAlarm(next);
    }
  }

  /**
   * 连接断开/出错后的 presence 收尾：lobby 房间若从此无人在线（全部连接关闭），
   * 从此刻起重新计空房回收倒计时。对局中/终态房间的回收由 commitState /
   * settleRoom 各自负责，这里不碰。closing 的连接要排除——断开事件触发时
   * 运行时的连接表未必已经把它摘掉。
   */
  private async armPresenceRecycle(room: GameRoomState, closing?: WebSocket): Promise<void> {
    if (room.status !== "lobby") return;
    const online = this.ctx.getWebSockets().filter((ws) => ws !== closing).length;
    if (online > 0) return;
    const next: GameRoomState = { ...room, recycleAt: Date.now() + EMPTY_ROOM_TTL_MS };
    await this.ctx.storage.put(ROOM_KEY, next);
    await this.ensureAlarm();
  }

  /** 去重表写入（拒绝也记录：重放同码，客户端不会对同一动作得到两份真相）。 */
  private async recordAction(
    actionId: string,
    version: number,
    accepted: boolean,
    errorCode?: GameProtocolErrorCode,
  ): Promise<void> {
    const record: GameActionRecord = { version, accepted, recordedAt: Date.now(), ...(errorCode ? { errorCode } : {}) };
    await this.ctx.storage.put(ACTION_KEY_PREFIX + actionId, record);
  }

  private engineErrorResponse(outcome: {
    ok: false;
    error: { code: GameProtocolErrorCode; message: string };
  }): Response {
    return Response.json(
      { ok: false, code: outcome.error.code, message: outcome.error.message },
      { status: actionStatusFor(outcome.error.code) },
    );
  }
}

// ---------------------------------------------------------------------------
// 纯函数辅助（可被单测直接覆盖）
// ---------------------------------------------------------------------------

/** 身份字段抽取（Worker 转发体里必须带 participantHash）。 */
function requireIdentity(body: Record<string, unknown>): { ok: true; participantHash: string } | { ok: false } {
  const hash = body.participantHash;
  return typeof hash === "string" && hash ? { ok: true, participantHash: hash } : { ok: false };
}

/**
 * 协议不变量一：每次成功的状态变更 version +1。引擎返回的状态不携带可信
 * version（引擎不碰该字段），DO 在提交前统一递增——join/ready/start/leave/
 * close/action/alarm 六条变更路径全部经由这里。
 */
function bumpVersion(state: GameRoomState): GameRoomState {
  return { ...state, version: state.version + 1 };
}

/**
 * 视图里的玩家投影：只暴露展示字段与座位令牌，绝不带内部态——participantHash
 * 是身份凭证（= `web_<participantKey>` 原文），从协议形状上就不允许出现在
 * 任何对外载荷里（修复 1：所有视图/信封/结算统一以 seatToken 对位）。
 */
function toPublicPlayer(
  player: GameRoomPlayer,
): Pick<GameRoomPlayer, "seatToken" | "displayName" | "isHost" | "ready" | "leftAt"> {
  return {
    seatToken: player.seatToken,
    displayName: player.displayName,
    isHost: player.isHost,
    ready: player.ready,
    leftAt: player.leftAt,
  };
}

/**
 * 查看者自己的座位令牌（withView / handleGetState 共用）：在座返回令牌，观战
 * /未加入返回 null。字段名 youSeatToken——REST 层 relay 成 `you`（与旧字段
 * 同名透传，只是值从 participantHash 换成了 seatToken）。
 */
function youSeatTokenField(room: GameRoomState, viewerHash: string): { youSeatToken: string | null } {
  const viewer = viewerHash === "" ? null : (room.players.find((p) => p.participantHash === viewerHash) ?? null);
  return { youSeatToken: viewer && viewer.leftAt === null ? viewer.seatToken : null };
}

/**
 * 存量聊天消息清洗（修复 1）：旧部署写入的环形暂存签名是 fromHash
 * （participantHash），补发给任何成员前统一改写成 fromSeat——发送者是玩家
 * 就换其座位令牌（loadRoom 已兜底补铸），观战者/座位缺失置空串。实时路径
 * （handleChatSend）铸造的就是 fromSeat，本函数只为历史帧兜底。
 */
function sanitizeChatMessage(room: GameRoomState, message: GameChatMessage): GameChatMessage {
  const raw = message as GameChatMessage & { fromHash?: unknown };
  if (typeof raw.fromHash !== "string" || raw.fromHash === "") return message;
  const legacy = raw.fromHash;
  const { fromHash: _legacy, ...rest } = raw;
  void _legacy;
  return { ...rest, fromSeat: room.players.find((p) => p.participantHash === legacy)?.seatToken ?? "" };
}

function remainingMs(room: GameRoomState): number | null {
  if (room.status !== "playing" || room.deadlineAt === null) return null;
  return Math.max(0, room.deadlineAt - Date.now());
}

/**
 * 在线人数统计（presence 消息载荷）：按 participantHash 去重——同一身份的
 * 重连期新旧连接并存时只算一个人；无身份的连接（防御位）不计入。
 */
function presenceCounts(attachments: Array<SocketAttachment | null>): { players: number; spectators: number } {
  const players = new Set<string>();
  const spectators = new Set<string>();
  for (const attachment of attachments) {
    if (!attachment) continue;
    (attachment.role === "player" ? players : spectators).add(attachment.participantHash);
  }
  return { players: players.size, spectators: spectators.size };
}

/** 引擎未提供 leaveRoom 时的默认实现：标记 leftAt，全员走光即 closed。 */
function leaveRoomDefault(room: GameRoomState, participantHash: string): EngineOutcome {
  const target = room.players.find((player) => player.participantHash === participantHash);
  if (!target || target.leftAt) return { ok: true, state: room };
  const players = room.players.map((player) =>
    player.participantHash === participantHash ? { ...player, leftAt: new Date().toISOString() } : player,
  );
  const everyoneGone = players.every((player) => player.leftAt !== null);
  return {
    ok: true,
    state: { ...room, players, ...(everyoneGone ? { status: "closed" as const } : {}) },
  };
}

/** 协议错误码 → HTTP 状态码（REST 路径使用；WS 路径只透传 code）。 */
function actionStatusFor(code: GameProtocolErrorCode): number {
  switch (code) {
    case "not_a_player":
    case "spectator_forbidden":
      return 403;
    case "room_not_found":
      return 404;
    case "stale_action":
      return 409;
    case "game_over":
    case "not_your_turn":
    case "not_host":
    case "invalid_action":
    case "illegal_move":
    case "unknown_game_type":
      return 400;
    default:
      return 400;
  }
}

/** 读 WS attachment（休眠唤醒后的唯一身份来源）。 */
function readAttachment(ws: WebSocket): SocketAttachment | null {
  try {
    const value = ws.deserializeAttachment() as Partial<SocketAttachment> | undefined;
    if (!value || typeof value.participantHash !== "string" || !value.participantHash) return null;
    return {
      participantHash: value.participantHash,
      role: value.role === "player" ? "player" : "spectator",
    };
  } catch {
    return null;
  }
}

/** 供测试断言用：房间 id → DO 实例名再导出一次（单一事实来源在 engine-types）。 */
export { gameRoomDOName, parseGameRoomRef };
