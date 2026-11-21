import type { Env } from "../index";
import type { GameRoomDO } from "../durable-objects/game-room";
import { fail, json, resolveParticipant } from "./survey-api";
import { checkRateLimit, rateLimitResponse } from "../services/rate-limit.service";
import { writeAudit } from "./admin/helpers";
import { listGameEngines } from "../game/multiplayer/engine-registry";
import {
  GAME_ROOM_REF_PREFIX,
  gameRoomDOName,
  type GamePlayerView,
  type GamePublicView,
} from "../game/multiplayer/engine-types";

/**
 * 多人对局房间 REST 入口（P0 批次 G1）。
 *
 * 职责只有四类：身份（resolveParticipant）、限流（checkRateLimit）、D1 索引
 * （game_rooms 只存目录与终态，0105）、转发 DO（实时态全在 GameRoomDO storage，
 * "每步棋不触 D1"）。WS 握手在 Worker 鉴权后转发到 DO stub——非鉴权用户在
 * 这里就被 401 拒掉，永远到不了升级。
 *
 * 房间标识锁定：自增数字 id 即唯一标识，深链接格式
 * `https://t.me/<bot>?startapp=room_<id>`（room_ 前缀 + 数字 id），与 DO 实例
 * 名（gameRoomDOName）一致；G3 的生成器与 GameScreen 消费本格式。响应里的
 * `roomRef` 即该 startapp 值。
 *
 * 协议不变量三的边界：DO 返回里的 `state` 是 Worker ⇄ DO 内部契约，这里只把
 * 裁剪后的 `view`（GamePlayerView/GamePublicView）透传给客户端。
 */

/** 创建限流：10 次/小时/身份（建房是重操作，目录表每次都要写 D1）。 */
const CREATE_LIMIT = 10;
/** 加入限流：30 次/小时/身份（重连重试友好于批量扫房）。 */
const JOIN_LIMIT = 30;
/** WS 握手限流：60 次/小时/身份（断线重连场景，高于加入）。 */
const WS_LIMIT = 60;

const ROOM_PATH = /^\/api\/game\/rooms\/(\d+)\/(join|close|state|ws)$/;

/**
 * 路由分发。除本文件的端点外返回 null，落回 router 后续兜底（web-app-api.ts
 * 先例：显式 405 由各端点自己返回）。
 */
export async function handleGameApiRequest(request: Request, env: Env, url: URL): Promise<Response | null> {
  // GET /api/game/types：已注册玩法列表（读 engine 注册表的 meta，纯内存、
  // 无身份/无 D1）。公开只读——响应只有玩法名与元数据，不含任何房间或玩家
  // 信息；/trial 入口卡与 /game 大厅都消费它。未知/缺 meta 的引擎按 label
  // 兜底，注册表空时返回空列表（调用方回退到本地静态入口）。
  if (url.pathname === "/api/game/types") {
    if (request.method !== "GET") return fail(405, "method_not_allowed", "玩法列表只支持 GET");
    return json({
      ok: true,
      games: listGameEngines().map((engine) => ({
        name: engine.gameType,
        displayName: engine.meta?.displayName ?? engine.label,
        description: engine.meta?.description ?? "",
        minPlayers: engine.meta?.minPlayers ?? null,
        maxPlayers: engine.meta?.maxPlayers ?? null,
      })),
    });
  }

  if (!url.pathname.startsWith("/api/game/rooms")) return null;

  const roomMatch = ROOM_PATH.exec(url.pathname);

  if (url.pathname === "/api/game/rooms") {
    if (request.method === "POST") return handleCreateRoom(request, env, url);
    if (request.method === "GET") return handleListRooms(request, env, url);
    return fail(405, "method_not_allowed", "房间端点支持 GET（列表）与 POST（创建）");
  }

  if (roomMatch) {
    const id = Number(roomMatch[1]);
    if (!Number.isInteger(id) || id <= 0) return fail(400, "validation_failed", "无效的房间 id");
    const sub = roomMatch[2];
    if (sub === "join" && request.method === "POST") return handleJoinRoom(request, env, id);
    if (sub === "close" && request.method === "POST") return handleCloseRoom(request, env, id);
    if (sub === "state" && request.method === "GET") return handleRoomState(request, env, id);
    if (sub === "ws" && request.method === "GET") return handleRoomSocket(request, env, id);
    return fail(405, "method_not_allowed", "该房间子端点不支持此方法");
  }

  return null;
}

/** GAME_ROOM 绑定缺失（客户部署/旧部署）：明确语义，不静默 500。 */
function gameDisabled(): Response {
  return fail(404, "game_disabled", "多人对局未在本部署启用");
}

function roomNamespace(env: Env): DurableObjectNamespace<GameRoomDO> | null {
  return env.GAME_ROOM ?? null;
}

// ---------------------------------------------------------------------------
// POST /api/game/rooms —— 创建房间
// ---------------------------------------------------------------------------

async function handleCreateRoom(request: Request, env: Env, _url: URL): Promise<Response> {
  const participant = await resolveParticipant(request, env);
  if (participant instanceof Response) return participant;
  const namespace = roomNamespace(env);
  if (!namespace) return gameDisabled();

  const limited = await checkRateLimit(env.CACHE, "game-room-create", participant.participantHash, CREATE_LIMIT, 3600);
  if (!limited.allowed) return rateLimitResponse(limited.retryAfterSeconds);

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const gameType = typeof body?.gameType === "string" ? body.gameType.trim() : "";
  if (!gameType) return fail(400, "validation_failed", "缺少 gameType");
  // 展示名只作展示：长度收口，内容不参与任何鉴权。
  const displayName = typeof body?.displayName === "string" ? body.displayName.trim().slice(0, 24) : null;
  const config = (body?.config ?? null) as Record<string, unknown> | null;

  const now = new Date().toISOString();
  const insert = await env.DB.prepare(
    "INSERT INTO game_rooms (game_type, status, host_participant_hash, created_at, updated_at) VALUES (?1, 'lobby', ?2, ?3, ?3)",
  )
    .bind(gameType, participant.participantHash, now)
    .run();
  const roomId = insert.meta.last_row_id;
  if (!Number.isInteger(roomId) || roomId <= 0) {
    return fail(500, "internal_error", "房间创建失败");
  }

  const roomRef = gameRoomDOName(roomId);
  const stub = namespace.get(namespace.idFromName(roomRef));
  const response = await stub.fetch("https://game-room/create", {
    method: "POST",
    body: JSON.stringify({
      gameType,
      roomId: roomRef,
      config: config ?? {},
      host: { participantHash: participant.participantHash, displayName },
    }),
    headers: { "Content-Type": "application/json", "x-game-viewer-hash": participant.participantHash },
  });
  if (!response.ok) {
    // DO 建房失败：目录行一并回收，避免留下无 DO 实体的孤儿索引行。
    await env.DB.prepare("DELETE FROM game_rooms WHERE id = ?1").bind(roomId).run();
    return relayDoError(response);
  }

  await writeAudit(env.DB, {
    actorUserId: participant.dbUserId,
    action: "game_room_create",
    entityType: "game_room",
    entityId: String(roomId),
    after: { gameType, roomRef },
  });

  // 深链接格式锁定（G1）：https://t.me/<bot>?startapp=room_<id>，
  // roomRef 即 startapp 值，G3 生成器直接拼接。
  const payload = (await response.json()) as { view?: GamePlayerView | GamePublicView; state?: { status?: string } };
  return json({
    ok: true,
    room: { id: roomId, gameType, status: payload.state?.status ?? "lobby" },
    roomRef: `${GAME_ROOM_REF_PREFIX}${roomId}`,
    view: payload.view,
    // 查看者自己的 participantHash（Lobby/Board 层用它在信封 players 里定位
    // 「我的行」）。只回本人哈希——他人哈希已在按人裁剪的信封 players 里，
    // 这里不新增任何他人的身份信息。
    you: participant.participantHash,
  });
}

// ---------------------------------------------------------------------------
// POST /api/game/rooms/:id/join —— 加入（或重入）房间
// ---------------------------------------------------------------------------

async function handleJoinRoom(request: Request, env: Env, id: number): Promise<Response> {
  const participant = await resolveParticipant(request, env);
  if (participant instanceof Response) return participant;
  const namespace = roomNamespace(env);
  if (!namespace) return gameDisabled();

  const limited = await checkRateLimit(env.CACHE, "game-room-join", participant.participantHash, JOIN_LIMIT, 3600);
  if (!limited.allowed) return rateLimitResponse(limited.retryAfterSeconds);

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const displayName = typeof body.displayName === "string" ? body.displayName.trim().slice(0, 24) : null;
  const asSpectator = body.asSpectator === true;

  const roomRef = gameRoomDOName(id);
  const stub = namespace.get(namespace.idFromName(roomRef));
  const response = await stub.fetch("https://game-room/join", {
    method: "POST",
    body: JSON.stringify({
      participantHash: participant.participantHash,
      ...(displayName ? { displayName } : {}),
      ...(asSpectator ? { asSpectator: true } : {}),
    }),
    headers: { "Content-Type": "application/json", "x-game-viewer-hash": participant.participantHash },
  });
  if (!response.ok) return relayDoError(response);

  // 加入不写 D1（实时态在 DO，game_rooms 只存目录与终态），也不写审计——
  // 审计只在创建/关闭两个改变房间目录的时机。
  const payload = (await response.json()) as {
    view?: GamePlayerView | GamePublicView;
    role?: "player" | "spectator";
    rejoined?: boolean;
    spectatorFallback?: boolean;
  };
  return json({
    ok: true,
    roomRef,
    view: payload.view,
    role: payload.role ?? (asSpectator ? "spectator" : "player"),
    // 查看者自己的 participantHash（同 create：仅本人哈希，用于定位「我的行」）。
    you: participant.participantHash,
    ...(payload.rejoined ? { rejoined: true } : {}),
    ...(payload.spectatorFallback ? { spectatorFallback: true } : {}),
  });
}

// ---------------------------------------------------------------------------
// POST /api/game/rooms/:id/close —— 房主关闭（审计"创建/关闭"的关闭侧）
// ---------------------------------------------------------------------------

async function handleCloseRoom(request: Request, env: Env, id: number): Promise<Response> {
  const participant = await resolveParticipant(request, env);
  if (participant instanceof Response) return participant;
  const namespace = roomNamespace(env);
  if (!namespace) return gameDisabled();

  const roomRef = gameRoomDOName(id);
  const stub = namespace.get(namespace.idFromName(roomRef));
  const response = await stub.fetch("https://game-room/close", {
    method: "POST",
    body: JSON.stringify({ participantHash: participant.participantHash }),
    headers: { "Content-Type": "application/json", "x-game-viewer-hash": participant.participantHash },
  });
  if (!response.ok) return relayDoError(response);

  // 终态落目录表：status=closed + closed_at（索引与终态，实时态仍只在 DO）。
  const now = new Date().toISOString();
  await env.DB.prepare("UPDATE game_rooms SET status = 'closed', updated_at = ?1, closed_at = ?1 WHERE id = ?2")
    .bind(now, id)
    .run();

  await writeAudit(env.DB, {
    actorUserId: participant.dbUserId,
    action: "game_room_close",
    entityType: "game_room",
    entityId: String(id),
    after: { roomRef },
  });

  const payload = (await response.json()) as { view?: GamePlayerView | GamePublicView };
  return json({ ok: true, roomRef, view: payload.view });
}

// ---------------------------------------------------------------------------
// GET /api/game/rooms —— 房间列表（目录表直读，不触 DO）
// ---------------------------------------------------------------------------

async function handleListRooms(request: Request, env: Env, url: URL): Promise<Response> {
  // 可选身份：mine=1 需要身份，否则按匿名公开列表处理。
  const participant = await resolveParticipant(request, env).catch(() => null);
  const mine = url.searchParams.get("mine") === "1" && participant !== null && !(participant instanceof Response);
  // 查看者哈希只用于"是不是我的房间"判定，绝不回给客户端——匿名身份的
  // participantHash 就是 `web_<participantKey>`（participant-link.repository.ts
  // participantHashForKey，canonicalizeHash 无映射时原样返回），而
  // participantKey 是 x-participant-key 身份路径的唯一凭证；公开列表回传
  // 他人哈希等于批量泄露凭证（plaza-api 等先例也从不外发他人 participantHash）。
  const viewerHash = participant !== null && !(participant instanceof Response) ? participant.participantHash : null;

  const limitParam = Number(url.searchParams.get("limit"));
  const limit = Math.min(Math.max(Number.isInteger(limitParam) && limitParam > 0 ? limitParam : 20, 1), 50);
  const statusParam = url.searchParams.get("status");
  const allowedStatuses = ["lobby", "playing", "settled", "closed"] as const;
  const status =
    statusParam && (allowedStatuses as readonly string[]).includes(statusParam)
      ? (statusParam as (typeof allowedStatuses)[number])
      : null;

  const conditions: string[] = [];
  const binds: Array<string | number> = [];
  if (mine) {
    conditions.push(`host_participant_hash = ?${binds.length + 1}`);
    binds.push(participant.participantHash);
  }
  if (status) {
    conditions.push(`status = ?${binds.length + 1}`);
    binds.push(status);
  }
  binds.push(limit);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = await env.DB.prepare(
    `SELECT id, game_type, status, host_participant_hash, created_at, updated_at, closed_at FROM game_rooms ${where} ORDER BY created_at DESC, id DESC LIMIT ?${binds.length}`,
  )
    .bind(...binds)
    .all<{
      id: number;
      game_type: string;
      status: string;
      host_participant_hash: string;
      created_at: string;
      updated_at: string;
      closed_at: string | null;
    }>();

  return json({
    rooms: (rows.results ?? []).map((row) => ({
      id: row.id,
      gameType: row.game_type,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      closedAt: row.closed_at,
      roomRef: gameRoomDOName(row.id),
      isMine: viewerHash !== null && row.host_participant_hash === viewerHash,
    })),
  });
}

// ---------------------------------------------------------------------------
// GET /api/game/rooms/:id/state —— 当前裁剪视图（无 WS 场景的 REST 读）
// ---------------------------------------------------------------------------

async function handleRoomState(request: Request, env: Env, id: number): Promise<Response> {
  const participant = await resolveParticipant(request, env);
  if (participant instanceof Response) return participant;
  const namespace = roomNamespace(env);
  if (!namespace) return gameDisabled();

  const roomRef = gameRoomDOName(id);
  const stub = namespace.get(namespace.idFromName(roomRef));
  const response = await stub.fetch("https://game-room/state", {
    headers: { "x-game-viewer-hash": participant.participantHash },
  });
  if (!response.ok) return relayDoError(response);
  const payload = (await response.json()) as { view?: GamePlayerView | GamePublicView; role?: "player" | "spectator" };
  return json({
    ok: true,
    roomRef,
    view: payload.view,
    role: payload.role ?? "spectator",
    // 查看者自己的 participantHash（同 create/join：仅本人哈希）。
    you: participant.participantHash,
  });
}

// ---------------------------------------------------------------------------
// GET /api/game/rooms/:id/ws —— WebSocket 握手（Worker 鉴权后转发 DO）
// ---------------------------------------------------------------------------

/**
 * WS 握手身份头白名单：与 resolveParticipant 的读取顺序一一对应，解出哪条
 * 就带哪条（identityHeaders() 一次只产出一个主身份头）。
 */
const WS_IDENTITY_HEADERS = [
  "x-telegram-init-data",
  "x-participant-token",
  "x-email-session",
  "x-participant-key",
] as const;

/**
 * 浏览器 WebSocket API 不允许自定义请求头（identityHeaders 那套身份头带不
 * 上升级请求），客户端把 identityHeaders() 编进 Sec-WebSocket-Protocol 子
 * 协议（game-auth.<base64url(JSON)>）。这里解回同一套头并构造请求交给
 * resolveParticipant——身份体系不变（同批凭证、同一解析函数），只是为 WS
 * 握手换了个传输面。头不可用/形状不对返回 null，走原始请求（依旧会被
 * resolveParticipant 以 401 拒掉）。
 */
function identityRequestFromSubprotocol(request: Request): Request | null {
  const raw = request.headers.get("sec-websocket-protocol") ?? "";
  const token = raw
    .split(",")
    .map((item) => item.trim())
    .find((item) => item.startsWith("game-auth."));
  if (!token) return null;
  try {
    // base64url → 标准 base64（客户端按 RFC 6455 token 规则去了 padding）。
    let base64 = token.slice("game-auth.".length).replaceAll("-", "+").replaceAll("_", "/");
    while (base64.length % 4 !== 0) base64 += "=";
    const parsed = JSON.parse(atob(base64)) as Record<string, unknown>;
    const headers: Array<[string, string]> = [];
    for (const key of WS_IDENTITY_HEADERS) {
      const value = parsed[key];
      if (typeof value === "string" && value !== "") headers.push([key, value]);
    }
    if (headers.length === 0) return null;
    return new Request(request.url, { method: "GET", headers });
  } catch {
    return null;
  }
}

async function handleRoomSocket(request: Request, env: Env, id: number): Promise<Response> {
  // 非鉴权用户在升级前就被拒（401/403），绝不转发升级请求。身份优先从子
  // 协议解（浏览器 WS 带不了自定义头），普通 fetch 升级（内部/测试路径）
  // 仍走原始请求头。
  const participant = await resolveParticipant(identityRequestFromSubprotocol(request) ?? request, env);
  if (participant instanceof Response) return participant;
  const namespace = roomNamespace(env);
  if (!namespace) return gameDisabled();
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return fail(400, "invalid_payload", "需要 WebSocket 升级请求");
  }

  const limited = await checkRateLimit(env.CACHE, "game-room-ws", participant.participantHash, WS_LIMIT, 3600);
  if (!limited.allowed) return rateLimitResponse(limited.retryAfterSeconds);

  // 显式重建升级请求注入身份头（`fetch(request, {headers})` 的 init.headers
  // 是整体替换，会把 Upgrade 头丢掉）：binding 转发的升级请求在 DO 侧与
  // WebSocketPair 对接（Hibernation acceptWebSocket 挂 tag）。子协议头原样
  // 转发——DO 的 101 响应必须回显选中的子协议（RFC 6455），否则浏览器会
  // 直接断开连接（game-room.ts handleWebSocketUpgrade）。
  const protocol = request.headers.get("sec-websocket-protocol") ?? "";
  const upgradeHeaders: Array<[string, string]> = [
    ["Upgrade", "websocket"],
    ["Connection", "Upgrade"],
    ["x-game-viewer-hash", participant.participantHash],
  ];
  if (protocol !== "") upgradeHeaders.push(["Sec-WebSocket-Protocol", protocol]);
  const stub = namespace.get(namespace.idFromName(gameRoomDOName(id)));
  return stub.fetch(
    new Request(request.url, {
      method: "GET",
      headers: upgradeHeaders,
    }),
  );
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/** DO 错误响应透传：DO 的错误 JSON 已是协议形状（ok/code/message），原样转发。 */
async function relayDoError(response: Response): Promise<Response> {
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return fail(502, "game_room_error", "房间服务暂时不可用");
  const code = typeof body.code === "string" ? body.code : "game_room_error";
  const message = typeof body.message === "string" ? body.message : "房间服务暂时不可用";
  return Response.json(
    { ok: false, code, message },
    { status: response.status, headers: { "Cache-Control": "no-store" } },
  );
}
