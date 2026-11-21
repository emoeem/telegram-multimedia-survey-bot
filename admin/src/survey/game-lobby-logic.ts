/**
 * 多人对局「大厅层」的纯逻辑（批次：Lobby/Board 分层）。
 *
 * 与 game-room-logic.ts 的分工：那份是五子棋玩法私有（棋盘几何/黑白/悔棋），
 * 这份只放 **gameType 无关** 的大厅逻辑——玩家列表行、准备/开局可用性、
 * 创建/加入入口与玩法列表（GET /api/game/types）的收敛。供 GameLobby.tsx 与
 * MultiplayerGameScreen 引用，也可在 vitest node 环境直接单测（不碰 DOM、
 * 不发请求、不 import 带副作用的模块）。
 *
 * 分层纪律：本文件绝不出现 黑白/棋盘/悔棋 等具体玩法的词——玩法私有渲染
 * 全部走 Board 注册表（game-board-registry.ts）。
 */
import type { GamePlayerView, GamePublicView } from "../../../src/game/multiplayer/engine-types";

/**
 * WS 连接状态（房间壳/Board/连接器共用的一组取值）。定义在纯逻辑层是为了
 * 依赖方向：Board 注册表只依赖纯层，不 import 带副作用的 game-room-client。
 */
export type GameConnectionStatus = "connecting" | "open" | "closed";

// ---------------------------------------------------------------------------
// 玩家列表（信封 players 的通用收敛）
// ---------------------------------------------------------------------------

/** 玩家/公开两种视图的玩家行公共字段（ready 只在玩家视图里有）。 */
export type RoomPlayerRow = GamePlayerView["players"][number] | GamePublicView["players"][number];

/**
 * 在座玩家（leftAt 为空的行）。离开过的玩家保留在信封里（战绩/回放需要），
 * 大厅列表只展示仍在座的。
 */
export function activeRoomPlayers(players: readonly RoomPlayerRow[] | undefined | null): RoomPlayerRow[] {
  return (players ?? []).filter((player) => player.leftAt === null);
}

/**
 * 玩家行是否已准备。观战视图的玩家行没有 ready 字段：有就取，没有按未
 * 准备处理（观战者本就不参与准备）。
 */
export function isRoomPlayerReady(player: RoomPlayerRow): boolean {
  return "ready" in player ? player.ready : false;
}

/** 全员已准备（空表返回 false——没人谈不上全员）。 */
export function allRoomPlayersReady(players: readonly RoomPlayerRow[]): boolean {
  return players.length > 0 && players.every(isRoomPlayerReady);
}

/** 玩家行展示名：displayName 优先（trim 后仍为空视为没填），否则按序号兜底。 */
export function playerRowLabel(player: RoomPlayerRow, index: number): string {
  const name = player.displayName?.trim();
  return name || `玩家${index + 1}`;
}

/**
 * 玩家行的状态行文案：离座 > 房主/玩家 > lobby 阶段附加准备态。开局后不再
 * 显示准备态（对局中「准备」没有语义）。
 */
export function playerRowState(player: RoomPlayerRow | null, status: string | null): string {
  if (player === null) return "等待加入…";
  if (player.leftAt !== null) return "已离开房间";
  const role = player.isHost ? "房主" : "玩家";
  if (status !== "lobby") return role;
  return `${role} · ${isRoomPlayerReady(player) ? "已准备" : "未准备"}`;
}

/**
 * 开局按钮可用性：全员已准备且人数达到玩法下限。minPlayers 来自玩法元数据
 * （GET /api/game/types），未知玩法（null）只要求「全员已准备」——人数门槛
 * 由服务端引擎开局校验兜底，客户端绝不替服务端做权威判定。
 */
export function canStartMatch(activeCount: number, allReady: boolean, minPlayers: number | null): boolean {
  if (!allReady) return false;
  return minPlayers === null ? true : activeCount >= minPlayers;
}

/**
 * 大厅提示文案（人数/准备态三态）。文案按 minPlayers 参数化，不出现具体
 * 玩法名；minPlayers 未知（null）时按通用口径「人齐」处理。
 */
export function lobbyPlayersHint(activeCount: number, allReady: boolean, minPlayers: number | null): string {
  if (minPlayers !== null && activeCount < minPlayers) return "把房间码发给好友，人齐后就能开局。";
  if (allReady) return "全员已准备，房主可以开局。";
  return "所有玩家都点「准备」后，由房主开局。";
}

// ---------------------------------------------------------------------------
// 玩法列表（GET /api/game/types 的客户端收敛 + 静态兜底）
// ---------------------------------------------------------------------------

/** /api/game/types 单个玩法条目的客户端形状。 */
export interface GameTypeInfo {
  /** 注册表键（创建房间时传给 POST /api/game/rooms 的 gameType）。 */
  name: string;
  /** 展示名（入口卡/大厅标题）。 */
  displayName: string;
  /** 一句话玩法说明（服务端 meta，缺省为空串）。 */
  description: string;
  /** 开局最少人数（meta 缺省为 null——未知玩法不设客户端人数门槛）。 */
  minPlayers: number | null;
  /** 座位上限（meta 缺省为 null）。 */
  maxPlayers: number | null;
}

/** 非负整数或 null（人数元数据的容错收敛）。 */
function parsePlayerCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return null;
  return value;
}

/**
 * 把 /api/game/types 响应收敛成 GameTypeInfo[]。防御纪律与 parseGomokuView
 * 同款：服务端可能返回任何 JSON——形状对不上的条目逐个剔除，一个条目都
 * 没有时返回 null（调用方回退到静态入口），绝不把半残数据交给 UI。
 */
export function parseGameTypes(payload: unknown): GameTypeInfo[] | null {
  if (payload === null || typeof payload !== "object") return null;
  const games = (payload as Record<string, unknown>).games;
  if (!Array.isArray(games)) return null;
  const types: GameTypeInfo[] = [];
  for (const game of games) {
    if (!game || typeof game !== "object") continue;
    const record = game as Record<string, unknown>;
    if (typeof record.name !== "string" || !/^[a-z0-9_-]+$/.test(record.name)) continue;
    types.push({
      name: record.name,
      displayName:
        typeof record.displayName === "string" && record.displayName.trim() ? record.displayName : record.name,
      description: typeof record.description === "string" ? record.description : "",
      minPlayers: parsePlayerCount(record.minPlayers),
      maxPlayers: parsePlayerCount(record.maxPlayers),
    });
  }
  return types.length > 0 ? types : null;
}

/**
 * 静态兜底玩法列表：GET /api/game/types 拉不到（部署未升级/网络失败）时，
 * /trial 入口卡与 /game 大厅回退到这套——保证五子棋入口在任何部署下都在。
 * 与 gomokuEngine.meta 手工同步（仅 UI 文案，漂移无协议风险）。
 */
export const FALLBACK_GAME_TYPES: GameTypeInfo[] = [
  {
    name: "gomoku",
    displayName: "五子棋",
    description: "黑白轮流落子，先连成五子的一方获胜；每一步限时一分钟。",
    minPlayers: 2,
    maxPlayers: 2,
  },
  {
    name: "xiangqi",
    displayName: "象棋",
    description: "楚河汉界双人博弈：车马炮兵象士将，将死或困毙对方获胜；每一步限时一分钟。",
    minPlayers: 2,
    maxPlayers: 2,
  },
];

/** 按 gameType 找玩法信息（找不到返回 null——未知玩法走「即将上线」兜底）。 */
export function findGameType(types: readonly GameTypeInfo[], name: string): GameTypeInfo | null {
  return types.find((game) => game.name === name) ?? null;
}

/**
 * 玩法 → 客户端路由。五子棋沿用既有 /game 路径（分享卡/深链接/既有守卫
 * 都按它锁定），后续新玩法用 /game?type=<name> 复用同一块大厅与 Board
 * 分发。name 先过注册表键格式（防注入进 query），不对就回 /game。
 */
export function gameEntryHref(name: string): string {
  if (name === "gomoku") return "/game";
  return /^[a-z0-9_-]+$/.test(name) ? `/game?type=${encodeURIComponent(name)}` : "/game";
}
