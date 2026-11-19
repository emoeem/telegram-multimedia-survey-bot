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
 * + `settlement` 结算快照）。**DO 与引擎绝不触碰 D1**——"每步棋不触 D1"，
 * 索引与终态由 HTTP 层写进 game_rooms / game_matches（0105）。
 *
 * 身份信任模型：Worker（src/http/game-api.ts）用 resolveParticipant 鉴权后，
 * 把身份放进 `x-game-viewer-hash` / `x-game-role` 头转发进来；DO 内部绑定
 * 不对外网暴露，头即可信。引擎收到 participantHash 仍做房间成员校验
 * （协议不变量：所有玩家动作服务端校验）。
 */
import { DurableObject } from "cloudflare:workers";

import { resolveGameEngine } from "../game/multiplayer/engine-registry";
import {
  gameRoomDOName,
  parseGameRoomRef,
  type GameActionRecord,
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

const ROOM_KEY = "room";
const SETTLEMENT_KEY = "settlement";
const ACTION_KEY_PREFIX = "act:";

/** lobby 空房间（无任何在线连接且全员未开局）的回收时延。 */
const EMPTY_ROOM_TTL_MS = 30 * 60 * 1000;
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

function protocolError(
  code: GameProtocolErrorCode,
  message: string,
): { ok: false; error: { code: GameProtocolErrorCode; message: string } } {
  return { ok: false, error: { code, message } };
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
    return Response.json({ ok: true, view, role: isPlayer ? "player" : "spectator" });
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
          displayName: typeof host.displayName === "string" ? host.displayName : null,
          isHost: true,
          ready: false,
          joinedAt: now,
          leftAt: null,
        },
      ],
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
      ? { ...existing, leftAt: null } // 曾离开的玩家重新入座，房主身份随行保留
      : {
          participantHash: hash,
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
    if (!outcome.ok) return this.engineErrorResponse(outcome);
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
    // leave 不进引擎协议（引擎只管玩法本身）：默认实现标记 leftAt，
    // 全员走光即 closed（commitState 兜回收时间）。
    const outcome = leaveRoomDefault(room, identity.participantHash);
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
   */
  private async withView(
    state: GameRoomState,
    viewerHash: string,
    extra: Record<string, unknown> = {},
  ): Promise<Response> {
    if (!viewerHash) return Response.json({ ok: true, ...extra, state });
    const isPlayer = state.players.some((p) => p.participantHash === viewerHash && p.leftAt === null);
    const view = isPlayer ? await this.buildPlayerView(state, viewerHash) : await this.buildPublicView(state);
    return Response.json({ ok: true, ...extra, state, view, role: isPlayer ? "player" : "spectator" });
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
    // 消息/断开由 webSocketMessage/Close/Error 唤醒）。
    return new Response(null, { status: 101, webSocket: pair[0] });
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
    const result = await this.dispatchClientMessage(parsed, attachment);
    ws.send(JSON.stringify(result.message));
    if (result.stateChanged) await this.broadcastState();
  }

  /** 断开（含休眠超时清理）：presence 衰减 + 空房间回收倒计时。 */
  async webSocketClose(ws: WebSocket): Promise<void> {
    const room = await this.loadRoom();
    if (!room) return;
    await this.armPresenceRecycle(room, ws);
  }

  /** 发送失败（客户端半开等）：等同断开处理。 */
  async webSocketError(ws: WebSocket): Promise<void> {
    const room = await this.loadRoom();
    if (!room) return;
    await this.armPresenceRecycle(room, ws);
  }

  /**
   * WS 客户端消息分发（与 REST 控制面同一套引擎调用，保证两条路径行为一致）。
   * 返回值直接回给发送者；stateChanged 时再向全房间广播。
   */
  private async dispatchClientMessage(
    message: GameClientMessage,
    attachment: SocketAttachment | null,
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
        const outcome = leaveRoomDefault(room, attachment.participantHash);
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
      default:
        return { message: { type: "error", code: "invalid_payload", message: "未知消息类型" }, stateChanged: false };
    }
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
    return (await this.ctx.storage.get<GameRoomState>(ROOM_KEY)) ?? null;
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

/** 视图里的玩家投影：只暴露展示字段，绝不带内部态。 */
function toPublicPlayer(
  player: GameRoomPlayer,
): Pick<GameRoomPlayer, "participantHash" | "displayName" | "isHost" | "ready" | "leftAt"> {
  return {
    participantHash: player.participantHash,
    displayName: player.displayName,
    isHost: player.isHost,
    ready: player.ready,
    leftAt: player.leftAt,
  };
}

function remainingMs(room: GameRoomState): number | null {
  if (room.status !== "playing" || room.deadlineAt === null) return null;
  return Math.max(0, room.deadlineAt - Date.now());
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
