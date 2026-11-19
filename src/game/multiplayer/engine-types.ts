/**
 * 多人对局协议骨架（P0 批次 G1）——所有多人玩法（G2 五子棋、G3 后续玩法）
 * 共用的类型与引擎接口。
 *
 * 分层约定：
 * - `src/durable-objects/game-room.ts`（GameRoomDO）是**协议执行者**：持有
 *   房间状态与去重表（DO storage）、WebSocket Hibernation、alarm 倒计时，
 *   并强制执行 version 单调递增 / actionId 幂等 / 视图按玩家裁剪三条协议
 *   不变量。DO 不理解任何具体玩法。
 * - `MultiplayerGameEngine` 是**玩法实现者**：纯函数式接口，输入当前房间
 *   状态、返回新状态（不原地改），使引擎可在 vitest 里脱离 DO 单测。
 *   引擎永远不触碰 version（由 DO 统一 bump）与身份（participantHash 由
 *   Worker 鉴权后注入，引擎只做服务端校验）。
 * - `src/http/game-api.ts` 是**入口**：REST 创建/加入/列表 + WS 握手转发。
 *
 * 房间标识锁定（G1 复核修订）：D1 `game_rooms` 的自增数字 id 即房间唯一
 * 标识，深链接格式固定为 `https://t.me/<bot>?startapp=room_<id>`（`room_`
 * 前缀 + 数字 id），与 DO 实例名一一对应（见 gameRoomDOName）。G1 不引入
 * 独立「房间代码」概念；G3 的生成器与 GameScreen 直接消费该格式。
 */

// ---------------------------------------------------------------------------
// 房间状态
// ---------------------------------------------------------------------------

/** 房间生命周期：lobby → playing → settled；closed 仅空房间回收或主动关闭。 */
export type GameRoomStatus = "lobby" | "playing" | "settled" | "closed";

export interface GameRoomPlayer {
  /** 服务端身份哈希（resolveParticipant 的 participantHash），DO/storage 键与去重都基于它。 */
  participantHash: string;
  /** 展示名（可空）：来自 Telegram profile，永不是凭证。 */
  displayName: string | null;
  /** 房主 = 第一个加入的玩家（创建者）。 */
  isHost: boolean;
  ready: boolean;
  joinedAt: string;
  /** 离开过的玩家保留行（战绩/回放需要），leftAt 非空即不再计入对局。 */
  leftAt: string | null;
}

/**
 * DO storage 里的房间全量状态（键 `room`）。`engineState` 对 DO 不透明——
 * DO 只透传给引擎，绝不解释其字段；协议字段全部由 DO 所有。
 */
export interface GameRoomState {
  /** DO 实例名，即深链接的 `room_<id>`（见 gameRoomDOName）。 */
  roomId: string;
  gameType: string;
  status: GameRoomStatus;
  /**
   * 协议不变量一：单调递增的状态版本号。每次成功的状态变更 +1，只由
   * GameRoomDO 的 commitState 写入；引擎与客户端只读。客户端携带的
   * baseVersion 落后时动作会被拒绝（stale_action），防止旧状态覆盖。
   */
  version: number;
  /** 玩法级配置（创建时由房主传入，引擎自行校验）。 */
  config: Record<string, unknown>;
  players: GameRoomPlayer[];
  /** 引擎私有状态（棋盘/手牌/阶段…），DO 不解释。 */
  engineState: unknown;
  createdAt: string;
  updatedAt: string;
  /** 当前倒计时截止时间（epoch ms）：回合时限或整局时限，null = 无时限。 */
  deadlineAt: number | null;
  /** 回收时间（epoch ms）：空房间/终态房间在此之后由 alarm 删除。 */
  recycleAt: number | null;
  closedAt: string | null;
}

// ---------------------------------------------------------------------------
// 协议错误码（客户端按 code 分支处理，message 仅用于直接展示）
// ---------------------------------------------------------------------------

/**
 * 协议错误码全集。新增码只在末尾追加（客户端可能按枚举顺序做兜底判断）。
 * 所有错误响应的 JSON 形状统一为 `{ ok: false, code, message }`（与
 * src/http/api-response.ts 的 fail 一致），WS 消息里包一层
 * `{ type: "error", ... }`。
 */
export const GAME_PROTOCOL_ERROR_CODES = [
  /** 请求体不是合法 JSON 或缺必填字段。 */
  "invalid_payload",
  /** gameType 未在引擎注册表登记。 */
  "unknown_game_type",
  /** 动作/加入/开始的前置条件不满足（房间满、状态不对等）。 */
  "invalid_action",
  /** 操作者不在本房间（或已离开）。 */
  "not_a_player",
  /** 观战者/未加入者试图执行玩家动作。 */
  "spectator_forbidden",
  /** 轮到别人（回合制玩法）。 */
  "not_your_turn",
  /** 动作在当前局面下不合法（引擎校验失败，message 说明原因）。 */
  "illegal_move",
  /** 房间已结算/关闭，动作被拒。 */
  "game_over",
  /** 客户端携带的 baseVersion 落后于服务端 version。 */
  "stale_action",
  /** 非房主试图 start/close。 */
  "not_host",
  /** 房间不存在或已被回收。 */
  "room_not_found",
  /** 内部错误（引擎抛异常等），message 不带细节。 */
  "internal_error",
] as const;

export type GameProtocolErrorCode = (typeof GAME_PROTOCOL_ERROR_CODES)[number];

export interface GameProtocolError {
  code: GameProtocolErrorCode;
  message: string;
}

/** 引擎/DO 统一的结果形状：成功带新状态，失败带协议错误。 */
export type EngineOutcome = { ok: true; state: GameRoomState } | { ok: false; error: GameProtocolError };

// ---------------------------------------------------------------------------
// 动作与视图
// ---------------------------------------------------------------------------

/** 一次玩家动作（进 DO 的 REST/WS 通用形状）。 */
export interface GameRoomAction {
  /**
   * 协议不变量二：客户端生成的幂等键（UUID 或等价随机串）。同一 actionId
   * 重放永远返回首次结算的结果（DO storage 去重表 `act:<actionId>`），
   * 只结算一次——网络重试与旧状态覆盖都被它挡住。
   */
  actionId: string;
  /** 动作发起者（Worker 注入，客户端不可伪造）。 */
  participantHash: string;
  /** 动作类型（引擎自定义：落子/出牌/投票…）。 */
  action: string;
  /** 动作载荷（引擎自定义形状，引擎负责服务端校验）。 */
  payload?: unknown;
  /**
   * 客户端已知的最新 version。缺省不校验；携带且落后时返回 stale_action
   * （协议不变量一的反向保护）。
   */
  baseVersion?: number;
}

/** DO storage 去重表条目（键 `act:<actionId>`）。 */
export interface GameActionRecord {
  /** 该动作结算时产生的状态版本。 */
  version: number;
  /** 结算时该动作是否被引擎接受（拒绝也记录，重放同码）。 */
  accepted: boolean;
  /** 拒绝时的错误码（accepted=false 时存在）。 */
  errorCode?: GameProtocolErrorCode;
  /** 记录写入时间（epoch ms），终态清扫用。 */
  recordedAt: number;
}

/**
 * 按玩家裁剪的视图（线上形状）。协议不变量三：**任何**玩家看到的都是
 * `getPlayerView(state, 自己)` 的输出——没有隐藏信息的玩法（五子棋）也走
 * 裁剪路径，为狼人杀这类隐藏信息玩法留路；DO 永不把裸 state 发给客户端。
 *
 * 信封字段（roomId/status/version/players/remainingMs/settlement）由
 * GameRoomDO 统一装配，引擎只负责裁剪后的 `view`（见 MultiplayerGameEngine）。
 */
export interface GamePlayerView {
  roomId: string;
  gameType: string;
  status: GameRoomStatus;
  version: number;
  players: Array<Pick<GameRoomPlayer, "participantHash" | "displayName" | "isHost" | "ready" | "leftAt">>;
  /** 玩法私有：引擎对“这个玩家”裁剪后的局面（如自己的手牌）。 */
  view: unknown;
  /** 倒计时剩余毫秒（deadlineAt - now，无时限为 null）。 */
  remainingMs: number | null;
  /** 结算后才有：最终战绩快照（见 MultiplayerGameEngine.settle）。 */
  settlement?: GameSettlement;
}

/** 观战/未鉴权可见的公开视图（永远不含任何玩家私有信息）。 */
export interface GamePublicView {
  roomId: string;
  gameType: string;
  status: GameRoomStatus;
  version: number;
  players: Array<Pick<GameRoomPlayer, "participantHash" | "displayName" | "isHost" | "leftAt">>;
  /** 玩法公开局面（不含任何隐藏信息）。 */
  view: unknown;
  remainingMs: number | null;
  settlement?: GameSettlement;
}

/** 结算快照（DO 存 `settlement` 键，终态时经 REST 层写入 D1 game_matches 的 snapshot_json）。 */
export interface GameSettlement {
  /** 'host_win' | 'guest_win' | 'draw' | 'timeout' | 'aborted'… 引擎可扩展，末尾追加。 */
  result: string;
  /** 胜者 participantHash（平局/中止为 null）。 */
  winnerParticipantHash: string | null;
  /** 引擎自由格式的最终战绩（棋谱、比分、回合数…）。 */
  summary: Record<string, unknown>;
  settledAt: string;
  /** 结算依据的状态版本。 */
  version: number;
}

// ---------------------------------------------------------------------------
// 引擎接口
// ---------------------------------------------------------------------------

/**
 * 多人玩法引擎统一协议。全部方法为纯函数（输入状态 → 返回新状态），
 * 抛异常视为 internal_error 由 DO 兜底；实现里禁止任何 IO（D1/KV/fetch），
 * 保证“每步棋不触 D1”。
 *
 * 身份与鉴权：participantHash 一律来自 Worker 鉴权注入（resolveParticipant），
 * 引擎收到即视为可信，但仍须校验“是不是本房间玩家”（not_a_player）与
 * 动作合法性（服务端校验是唯一校验，客户端传什么都不可信）。
 */
export interface MultiplayerGameEngine {
  /** 注册表键（src/trial/engine-registry.ts 同风格的小写 id）。 */
  readonly gameType: string;
  /** 展示名（列表/分享用）。 */
  readonly label: string;

  /** 建房：由房主 config 初始化 engineState（config 校验失败抛/返回 invalid_action）。 */
  createRoom(state: GameRoomState, config: Record<string, unknown>): EngineOutcome;
  /**
   * 加入：`state.players` 此刻**不含**该玩家（DO 已剔除旧行），引擎负责把
   * player 追加进 players 并铸造私密信息；满员/状态不符返回 invalid_action。
   */
  joinRoom(state: GameRoomState, player: GameRoomPlayer): EngineOutcome;
  /** 准备切换（lobby 阶段）。 */
  setReady(state: GameRoomState, participantHash: string, ready: boolean): EngineOutcome;
  /** 开局（仅房主）：引擎决定是否要求全员 ready；成功后 status=playing 并可给 deadlineAt。 */
  start(state: GameRoomState, participantHash: string): EngineOutcome;
  /** 执行玩家动作：引擎负责服务端校验与结算判定（checkGameOver/settle 可由引擎内联调用）。 */
  applyAction(state: GameRoomState, action: GameRoomAction): EngineOutcome;
  /**
   * 按玩家裁剪视图（协议强制路径：五子棋无隐藏信息也走这里）。只返回玩法
   * 私有载荷 `view`——信封（status/version/players/倒计时/结算）由 DO 装配，
   * 协议字段永远只有 DO 一个主人。
   */
  getPlayerView(state: GameRoomState, participantHash: string): { view: unknown };
  /** 公开视图（观战/未加入者），同样只供 `view` 载荷。 */
  getPublicView(state: GameRoomState): { view: unknown };
  /** 当前局面是否已分胜负（DO 在动作后调用，负责结算收尾）。 */
  checkGameOver(state: GameRoomState): boolean;
  /** 生成结算快照（checkGameOver 命中后由 DO 调一次并存 storage）。 */
  settle(state: GameRoomState): GameSettlement;
  /**
   * 超时（alarm 触发）：引擎对当前局面做超时处置（判超时方/平局/中止，
   * 通常改 engineState 标记或推进阶段）；DO 随后重查 checkGameOver 并走
   * 统一结算路径（settleRoom），结算快照只有 DO 一个入口。
   */
  handleTimeout(state: GameRoomState, now: number): EngineOutcome;
}

// ---------------------------------------------------------------------------
// 房间标识与 DO 命名（深链接格式的唯一事实来源）
// ---------------------------------------------------------------------------

/** 深链接 startapp 参数前缀：`room_<id>`（G1 锁定，勿改——G3 消费方已按此对齐）。 */
export const GAME_ROOM_REF_PREFIX = "room_";

/** D1 自增 id → DO 实例名（= 深链接的 startapp 值）。 */
export function gameRoomDOName(id: number): string {
  return `${GAME_ROOM_REF_PREFIX}${id}`;
}

/** `room_<id>` 解析回数字 id；非该格式返回 null（拒绝裸数字与任意串）。 */
export function parseGameRoomRef(value: string): number | null {
  if (!value.startsWith(GAME_ROOM_REF_PREFIX)) return null;
  const id = Number(value.slice(GAME_ROOM_REF_PREFIX.length));
  return Number.isInteger(id) && id > 0 ? id : null;
}

// ---------------------------------------------------------------------------
// WS 消息形状（Worker ⇄ DO 的线上协议，G2/G3 客户端按此实现）
// ---------------------------------------------------------------------------

/** 服务端 → 客户端的 WS 消息。 */
export type GameServerMessage =
  | { type: "state"; view: GamePlayerView | GamePublicView; role: "player" | "spectator" }
  | { type: "action_result"; actionId: string; ok: boolean; version?: number; error?: GameProtocolError }
  | { type: "error"; code: GameProtocolErrorCode; message: string }
  /** 对端连接数变化（0 = 空房回收倒计时开始）等元信息，客户端可忽略。 */
  | { type: "presence"; onlinePlayers: number; onlineSpectators: number };

/** 客户端 → 服务端的 WS 消息（与 REST POST 体同形状，走同一分发器）。 */
export type GameClientMessage =
  | { type: "ready"; ready: boolean }
  | { type: "start" }
  | { type: "leave" }
  | { type: "action"; actionId: string; action: string; payload?: unknown; baseVersion?: number };
