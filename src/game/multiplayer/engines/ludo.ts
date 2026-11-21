/**
 * 飞行棋(ludo)多人引擎(游戏批次 X2-B)——MultiplayerGameEngine 的第三个真实实现。
 *
 * 规则与协议取舍(自写规则引擎,不引第三方库,与 xiangqi.ts 同款纪律):
 * - 2–4 人,每人 4 架飞机,三种状态:待机(机库,pos=null)/航线上(0..55)/
 *   已到达(56)。
 * - 几何:52 格主环 + 每人 6 格终点跑道。全程 path 0..56:0..50 落在主环
 *   (path 0 = 本方起飞格,主环号 = 13×色号 + pos),51..56 为本方终点跑道
 *   (56 = 终点)。主环按 4 色循环着色(loopCell % 4 = 座位色),由起飞格
 *   13×色号 推出:自己颜色的格子恰好是 path 上每 4 格一个(pos % 4 === 0)。
 *   座位分配:2 人对局取对角座位(色号 0/2),3/4 人取 0..n-1。
 * - 掷骰:服务端权威——引擎内确定性 RNG(mulberry32 变体),种子存
 *   engineState 并随每次掷骰演进;初始种子由 roomId 哈希派生,不提供任何
 *   config 覆盖口子——建房 config 会被 REST 层原样透传(game-api → DO
 *   handleCreate),接受外部种子等于给建房者一个离线复现整局骰点的作弊
 *   通道。客户端只发 "roll" 动作,永不提交骰值——同状态重放同骰点。
 * - 六点起飞:待机飞机只有掷出 6 点才能起飞(落本方起飞格 path 0);起飞
 *   是「落位」不算「落点」,不触发跳跃/飞行,但同样判撞(起飞格上的敌机
 *   被撞回待机,经典规则)。
 * - 连六再掷与三连惩罚:掷出 6 点走子后同一玩家再掷一次
 *   (rules.extraRollOnSix 默认开);连续掷出 rules.maxConsecutiveSixes
 *   (默认 3)次 6 点 → 惩罚:第三个 6 点作废不走,直接轮换下家。
 * - 走子与反弹:终点需要精确步数,超出即反弹(final = 2×56 − target);
 *   反弹只发生在终点跑道(51..55),永远不会弹回主环。
 * - 跳跃/飞越虚线:走子落定在自己颜色格 → 跳 rules.jumpStep(默认 4)格;
 *   落点恰是本方飞行格(rules.flyPos 默认 20)→ 沿虚线飞 rules.flyStep
 *   (默认 12)格,飞完若落点仍是自己颜色可再跳一次。每回合至多一跳一飞,
 *   链条至多 3 段(经典:跳4→飞12→再跳4)。跳跃只在本方主环段内
 *   (目标 ≤ 50,不越过终点入口);反弹落点在跑道内不触发链条。
 * - 撞机:最终落点(含链条后的落点)在主环上时,同格敌机全部回待机;
 *   同格己机可叠(无影响)。跳跃/飞行的中间途经格不判撞。
 * - 无子可动:掷骰后无任何合法走法 → 自动跳过并写提示事件,轮换下家。
 *   (掷 6 时必有机可动:机库可起飞,或航线上飞机因反弹规则任意掷点都
 *   能走;因此「无子可动」只出现在掷非 6 且无机在航线。)
 * - 超时:alarm 触发 handleTimeout,按 brief「超时视为跳过」——作废当前
 *   回合(含未走的骰点),轮换下家并重设倒计时,不判负。
 * - 胜负:先送满 4 架到达者胜;结算快照按到达数(其次主环进度)给其余玩家
 *   排名。中途认输(resign;DO 离席路径会自动调)飞机清回待机并跳过其
 *   回合;在座非认输玩家不足 2 人时终局,最后在场者胜。
 * - 无隐藏信息:getPlayerView 与 getPublicView 同一载荷,玩家视图仅多
 *   yourSeat。rngSeed/actionIds 等内部簿记绝不进视图——种子外泄 = 未来
 *   骰点可预测,属于隐藏信息泄漏(单测有泄漏断言)。
 *
 * version 与 actionId 去重的协议主人是 GameRoomDO(engine-types.ts):
 * 引擎绝不 bump version,只做 baseVersion/重复 actionId 的防御性校验。
 *
 * 所有方法均为纯函数(不原地修改 state/engineState),可在 vitest 里脱离
 * DO 直接对局;时间读取只有 deadlineAt 与 Date.now()(重放比较时排除)。
 */
import type {
  EngineOutcome,
  GameEngineMeta,
  GameProtocolErrorCode,
  GameRoomAction,
  GameRoomPlayer,
  GameRoomState,
  GameSettlement,
  MultiplayerGameEngine,
} from "../engine-types";

// ---------------------------------------------------------------------------
// 几何常量
// ---------------------------------------------------------------------------

/** 主环格数(四色循环着色,loopCell % 4 = 座位色)。 */
export const LUDO_LOOP_CELLS = 52;
/** 主环上可走的最后 path 值:起飞格后绕行 50 格抵达跑道口(起飞格背后的
 * 主环格 13×色号−1 被跑道入口跳过,故主环 path 共 51 个)。 */
export const LUDO_LOOP_TOP = 50;
/** 每人终点跑道格数(path 51..56,56 = 终点)。 */
export const LUDO_STRETCH_CELLS = 6;
/** 终点 path 值:精确落在此才算到达(LUDO_LOOP_TOP + LUDO_STRETCH_CELLS)。 */
export const LUDO_FINISH_POS = LUDO_LOOP_TOP + LUDO_STRETCH_CELLS;
/** 每人飞机数。 */
export const LUDO_PLANES_PER_PLAYER = 4;
/** 座位色名(经典红黄蓝绿;色号即主环着色相位)。 */
export const LUDO_SEAT_COLORS = ["红", "黄", "蓝", "绿"] as const;
/** 自己颜色格的 path 周期:由起飞格 13×色号 推出的恒等关系(pos % 4 === 0)。 */
const OWN_COLOR_PERIOD = 4;

/**
 * path(0..50)→ 主环格号;跑道/终点返回 null(私有几何,不与他人共享)。
 * 起飞格 = 13×色号,保证各座位起飞格互异且同色间隔恒为 4。
 */
export function ludoLoopCell(colorIndex: number, pos: number): number | null {
  if (pos < 0 || pos > LUDO_LOOP_TOP) return null; // 跑道/终点不在共享主环
  return (13 * colorIndex + pos) % LUDO_LOOP_CELLS;
}

// ---------------------------------------------------------------------------
// 规则配置(建房 config → 引擎内快照;默认值即 brief 规则)
// ---------------------------------------------------------------------------

export interface LudoRules {
  /** 每步时限(ms):掷骰与走子各算一步,超时按跳过处理。 */
  turnMs: number;
  /** 掷出 6 点走子后再掷一次(经典规则,可关)。 */
  extraRollOnSix: boolean;
  /** 连续掷出这么多次 6 点即惩罚(第三个 6 作废并轮换),默认 3。 */
  maxConsecutiveSixes: number;
  /** 落自己颜色格的跳跃步数(经典 4)。 */
  jumpStep: number;
  /** 飞行格虚线飞行步数(经典 12)。 */
  flyStep: number;
  /** 本方飞行格的 path 值(必须是自己颜色格:4 的倍数且 ≤ 44)。 */
  flyPos: number;
}

const DEFAULT_RULES: LudoRules = {
  turnMs: 60_000,
  extraRollOnSix: true,
  maxConsecutiveSixes: 3,
  jumpStep: 4,
  flyStep: 12,
  flyPos: 20,
};

const MIN_TURN_MS = 5_000;
const MAX_TURN_MS = 10 * 60_000;

/**
 * 建房 config 校验:缺省用默认值,任一字段非法返回 null(invalid_action)。
 * 约束:flyPos 是自己颜色格(4 的倍数、4..44)且 flyPos+flyStep ≤ 50
 * (飞完仍落在主环);maxConsecutiveSixes ≥ 2 才有「连续」语义。
 */
function readRules(config: Record<string, unknown>): LudoRules | null {
  const rules: LudoRules = { ...DEFAULT_RULES };
  const turnMs = config.turnMs;
  if (turnMs !== undefined) {
    if (typeof turnMs !== "number" || !Number.isFinite(turnMs) || turnMs < MIN_TURN_MS || turnMs > MAX_TURN_MS) {
      return null;
    }
    rules.turnMs = Math.round(turnMs);
  }
  const extra = config.extraRollOnSix;
  if (extra !== undefined) {
    if (typeof extra !== "boolean") return null;
    rules.extraRollOnSix = extra;
  }
  const sixes = config.maxConsecutiveSixes;
  if (sixes !== undefined) {
    if (typeof sixes !== "number" || !Number.isInteger(sixes) || sixes < 2 || sixes > 6) return null;
    rules.maxConsecutiveSixes = sixes;
  }
  const jump = config.jumpStep;
  if (jump !== undefined) {
    if (typeof jump !== "number" || !Number.isInteger(jump) || jump < 1 || jump > 12) return null;
    rules.jumpStep = jump;
  }
  const fly = config.flyStep;
  if (fly !== undefined) {
    if (typeof fly !== "number" || !Number.isInteger(fly) || fly < 1 || fly > 24) return null;
    rules.flyStep = fly;
  }
  const flyPos = config.flyPos;
  if (flyPos !== undefined) {
    if (typeof flyPos !== "number" || !Number.isInteger(flyPos)) return null;
    rules.flyPos = flyPos;
  }
  if (rules.flyPos < OWN_COLOR_PERIOD || rules.flyPos > LUDO_LOOP_TOP - 6) return null;
  if (rules.flyPos % OWN_COLOR_PERIOD !== 0) return null; // 必须是自己颜色格
  if (rules.flyPos + rules.flyStep > LUDO_LOOP_TOP) return null; // 飞完须仍在主环
  return rules;
}

// ---------------------------------------------------------------------------
// 确定性 RNG(mulberry32 变体):种子随状态演进,重放一致
// ---------------------------------------------------------------------------

/**
 * 由种子推导下一颗骰点(1..6)与下一状态种子。纯函数、跨平台一致:
 * 只用 Math.imul/移位,不依赖 Math.random。导出供单测反推种子。
 */
export function nextLudoRandom(seed: number): { value: number; next: number } {
  const advanced = ((seed + 0x6d2b79f5) | 0) >>> 0;
  let t = advanced | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const out = (t ^ (t >>> 14)) >>> 0;
  return { value: (out % 6) + 1, next: advanced };
}

/** FNV-1a 32:roomId → 初始种子(同一房间重放一致;唯一来源,不收外部种子)。 */
function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// 引擎私有状态
// ---------------------------------------------------------------------------

/** 飞机位置:null = 待机(机库),0..50 主环,51..55 终点跑道,56 = 到达。 */
export type LudoPlanePos = number | null;

export interface LudoSeat {
  participantHash: string;
  /** 座位色号(0红 1黄 2蓝 3绿)= 主环着色相位。 */
  colorIndex: number;
}

/** 一段走子的落点链(客户端棋谱/回放用)。 */
export interface LudoHop {
  kind: "takeoff" | "move" | "jump" | "fly";
  /** 该段落定的 path 值。 */
  to: number;
}

/** 一手走棋记录(回放数据源)。 */
export interface LudoMoveRecord {
  /** 全局手数(1 起)。 */
  ply: number;
  seatIndex: number;
  colorIndex: number;
  /** 本次掷点。 */
  roll: number;
  /** 飞机槽位(0..3)。 */
  planeSlot: number;
  /** 走前位置(null = 机库起飞)。 */
  from: LudoPlanePos;
  /** 最终落定 path(56 = 到达)。 */
  to: number;
  /** 落点链(起飞/掷点前进/跳跃/飞行)。 */
  hops: LudoHop[];
  /** 被撞回待机的敌机(座位/槽位)。 */
  captures: Array<{ seatIndex: number; colorIndex: number; planeSlot: number }>;
  /** 中文可读一句话(如「红1号机 掷5 前进 5→9,跳跃→13,撞回蓝2号机」)。 */
  text: string;
}

/** 系统提示事件(对局流程级:跳过/惩罚/超时/认输/胜局),客户端直接展示。 */
export interface LudoEvent {
  /** 关联手数(0 = 开局前)。 */
  ply: number;
  /** 座位序号(null = 系统)。 */
  seatIndex: number | null;
  kind: "skip" | "penalty" | "timeout" | "resign" | "win";
  text: string;
}

export interface LudoOutcome {
  result: "win" | "aborted";
  winnerSeat: number | null;
  /** finish 先全部到达 / resign 对手走光认输。 */
  reason: "finish" | "resign" | null;
}

/** 引擎私有状态(DO 不解释,只有本引擎读写;rngSeed/actionIds 绝不进视图)。 */
export interface LudoEngineState {
  seats: LudoSeat[];
  /** planes[座位][槽位] = path|null。 */
  planes: LudoPlanePos[][];
  /** 已认输座位(回合永久跳过,飞机已清回机库)。 */
  resigned: number[];
  turnSeat: number;
  phase: "await_roll" | "await_move";
  /** 当前待走的骰点(await_move 时非空)。 */
  lastRoll: number | null;
  /** 本座位连续掷出 6 点的次数(换人/掷出非 6 即清零)。 */
  sixStreak: number;
  /** 确定性 RNG 种子(内部簿记,绝不进视图)。 */
  rngSeed: number;
  history: LudoMoveRecord[];
  /** 提示事件环形暂存(最近 50 条)。 */
  events: LudoEvent[];
  outcome: LudoOutcome | null;
  /** 最近处理过的 actionId(有界)——协议权威去重表在 DO storage。 */
  actionIds: string[];
  rules: LudoRules;
}

// ---------------------------------------------------------------------------
// 纯函数辅助
// ---------------------------------------------------------------------------

const MAX_TRACKED_ACTION_IDS = 64;
const MAX_EVENTS = 50;

function failure(code: GameProtocolErrorCode, message: string): EngineOutcome {
  return { ok: false, error: { code, message } };
}

function success(state: GameRoomState): EngineOutcome {
  return { ok: true, state };
}

function readEngineState(state: GameRoomState): LudoEngineState | null {
  const value = state.engineState;
  return value !== null && typeof value === "object" ? (value as LudoEngineState) : null;
}

function withEngine(state: GameRoomState, engine: LudoEngineState): GameRoomState {
  return { ...state, engineState: engine };
}

function activePlayers(state: GameRoomState): GameRoomPlayer[] {
  return state.players.filter((player) => player.leftAt === null);
}

function findActivePlayer(state: GameRoomState, participantHash: string): GameRoomPlayer | null {
  return state.players.find((player) => player.participantHash === participantHash && player.leftAt === null) ?? null;
}

function trackActionId(actionIds: string[], actionId: string): string[] {
  return [...actionIds, actionId].slice(-MAX_TRACKED_ACTION_IDS);
}

function pushEvent(events: LudoEvent[], event: LudoEvent): LudoEvent[] {
  return [...events, event].slice(-MAX_EVENTS);
}

function colorName(colorIndex: number): string {
  return LUDO_SEAT_COLORS[colorIndex] ?? "?";
}

function planeName(colorIndex: number, slot: number): string {
  return `${colorName(colorIndex)}${slot + 1}号机`;
}

function arrivedCount(planes: LudoPlanePos[]): number {
  return planes.filter((pos) => pos === LUDO_FINISH_POS).length;
}

function maxProgress(planes: LudoPlanePos[]): number {
  // 只比航线上飞机的最远位置(已到达的 56 不计入:到达数已单独排名,
  // 这里回答的是「还没到的飞机走多远了」)。
  return planes.reduce<number>((max, pos) => Math.max(max, pos !== null && pos < LUDO_FINISH_POS ? pos : 0), 0);
}

/**
 * 座位色号分配:2 人取对角(0/2,避免相邻起飞格的先手偏置),3/4 人按
 * 入座顺序取 0..n-1。
 */
function seatColorIndexFor(playerCount: number, seatOrder: number): number {
  return playerCount === 2 && seatOrder === 1 ? 2 : seatOrder;
}

/** 由在座玩家重建座位表与飞机(lobby 阶段无限外,对局进度由 start 重置)。 */
function syncSeats(engine: LudoEngineState, state: GameRoomState): LudoEngineState {
  const active = activePlayers(state);
  const seats = active.map((player, order) => ({
    participantHash: player.participantHash,
    colorIndex: seatColorIndexFor(active.length, order),
  }));
  const planes = seats.map(() => Array<LudoPlanePos>(LUDO_PLANES_PER_PLAYER).fill(null));
  return { ...engine, seats, planes };
}

/** 下一个有效座位(跳过认输与已离席;找不到时保持原座位兜底)。 */
function nextActiveSeat(state: GameRoomState, engine: LudoEngineState, from: number): number {
  const count = engine.seats.length;
  for (let step = 1; step <= count; step += 1) {
    const idx = (from + step) % count;
    const seat = engine.seats[idx];
    if (!seat || engine.resigned.includes(idx)) continue;
    if (!findActivePlayer(state, seat.participantHash)) continue;
    return idx;
  }
  return from;
}

// ---------------------------------------------------------------------------
// 走子规划(纯函数:掷点 → 落点链;导出供单测直测)
// ---------------------------------------------------------------------------

export interface LudoMovePlan {
  /** 最终落定 path(56 = 到达)。 */
  final: number;
  /** 落点链(起飞/前进/跳跃/飞行,按序)。 */
  hops: LudoHop[];
}

/**
 * 规划一次走子:待机飞机只在掷 6 时起飞(落位不触发链条);航线上飞机
 * 前进 roll,超过终点即反弹;反弹落在跑道不触发链条;主环落点按
 * 「自己颜色跳 4、飞行格飞 12、飞完可再跳一次」结算落点链(每回合至多
 * 一跳一飞)。飞机已到达/掷 6 以外起飞返回 null(无此走法)。
 */
export function planLudoMove(from: LudoPlanePos, roll: number, rules: LudoRules): LudoMovePlan | null {
  if (from === LUDO_FINISH_POS) return null; // 已到达,不能再动
  if (from === null) {
    return roll === 6 ? { final: 0, hops: [{ kind: "takeoff", to: 0 }] } : null; // 六点起飞
  }
  let pos = from + roll;
  const hops: LudoHop[] = [];
  if (pos > LUDO_FINISH_POS) {
    pos = 2 * LUDO_FINISH_POS - pos; // 精确步数:超出即反弹(只发生在跑道)
    hops.push({ kind: "move", to: pos });
    return { final: pos, hops };
  }
  hops.push({ kind: "move", to: pos });
  // 落点链:只在主环(≤ 50)结算;跑道/终点无捷径。
  let jumped = false;
  let flew = false;
  for (;;) {
    if (pos <= LUDO_LOOP_TOP && pos === rules.flyPos && !flew) {
      pos += rules.flyStep;
      flew = true;
      jumped = false; // 飞行后重新获得一次跳跃(经典:飞完可跳)
      hops.push({ kind: "fly", to: pos });
      continue;
    }
    if (pos <= LUDO_LOOP_TOP && pos % OWN_COLOR_PERIOD === 0 && !jumped && pos + rules.jumpStep <= LUDO_LOOP_TOP) {
      pos += rules.jumpStep;
      jumped = true;
      hops.push({ kind: "jump", to: pos });
      continue;
    }
    break;
  }
  return { final: pos, hops };
}

/** 本座位在当前骰点下可动的飞机槽位(机库+掷6=起飞;航线上任意骰点可走)。 */
function legalPlaneSlots(engine: LudoEngineState, seatIndex: number): number[] {
  const roll = engine.lastRoll;
  if (roll === null) return [];
  const planes = engine.planes[seatIndex] ?? [];
  const slots: number[] = [];
  for (let slot = 0; slot < planes.length; slot += 1) {
    if (planLudoMove(planes[slot] ?? null, roll, engine.rules) !== null) slots.push(slot);
  }
  return slots;
}

// ---------------------------------------------------------------------------
// 排名(导出供单测直测):到达数降序 → 主环进度降序 → 座位序
// ---------------------------------------------------------------------------

export interface LudoRankRow {
  rank: number;
  seatIndex: number;
  colorIndex: number;
  color: string;
  participantHash: string;
  arrived: number;
  maxPos: number;
  resigned: boolean;
}

export function ludoRanking(engine: LudoEngineState): LudoRankRow[] {
  const rows = engine.seats.map((seat, seatIndex) => ({
    seatIndex,
    colorIndex: seat.colorIndex,
    color: colorName(seat.colorIndex),
    participantHash: seat.participantHash,
    arrived: arrivedCount(engine.planes[seatIndex] ?? []),
    maxPos: maxProgress(engine.planes[seatIndex] ?? []),
    resigned: engine.resigned.includes(seatIndex),
  }));
  rows.sort((a, b) => b.arrived - a.arrived || b.maxPos - a.maxPos || a.seatIndex - b.seatIndex);
  return rows.map((row, index) => ({ ...row, rank: index + 1 }));
}

// ---------------------------------------------------------------------------
// 视图载荷(无隐藏信息:公开与玩家视图同一局面,玩家视图仅多 yourSeat;
// rngSeed/actionIds 等内部簿记绝不进视图——种子外泄等于预知未来骰点)
// ---------------------------------------------------------------------------

function viewPayload(engine: LudoEngineState): Record<string, unknown> {
  return {
    seats: engine.seats.map((seat, seatIndex) => ({
      seatIndex,
      colorIndex: seat.colorIndex,
      color: colorName(seat.colorIndex),
      planes: [...(engine.planes[seatIndex] ?? [])],
      arrived: arrivedCount(engine.planes[seatIndex] ?? []),
      resigned: engine.resigned.includes(seatIndex),
    })),
    planesPerPlayer: LUDO_PLANES_PER_PLAYER,
    loopCells: LUDO_LOOP_CELLS,
    stretchCells: LUDO_STRETCH_CELLS,
    finishPos: LUDO_FINISH_POS,
    turnSeat: engine.turnSeat,
    phase: engine.phase,
    lastRoll: engine.lastRoll,
    sixStreak: engine.sixStreak,
    rules: { ...engine.rules },
    history: engine.history.map((record) => ({ ...record, hops: [...record.hops], captures: [...record.captures] })),
    events: [...engine.events],
    legalPlanes: engine.phase === "await_move" ? legalPlaneSlots(engine, engine.turnSeat) : [],
    outcome: engine.outcome,
  };
}

// ---------------------------------------------------------------------------
// 动作实现
// ---------------------------------------------------------------------------

/** 掷骰(服务端权威,客户端不提交骰值):连六惩罚/无子可动跳过在此结算。 */
function applyRoll(state: GameRoomState, engine: LudoEngineState, seatIndex: number, actionId: string): EngineOutcome {
  const { value: roll, next: seed } = nextLudoRandom(engine.rngSeed);
  const ply = engine.history.length;
  const color = colorName(engine.seats[seatIndex]?.colorIndex ?? 0);
  let next: LudoEngineState = { ...engine, rngSeed: seed, actionIds: trackActionId(engine.actionIds, actionId) };

  // 连六惩罚:本次 6 点作废,直接轮换(经典:三连六该回合不走)。
  if (roll === 6) {
    const streak = engine.sixStreak + 1;
    if (next.rules.extraRollOnSix && streak >= next.rules.maxConsecutiveSixes) {
      next = {
        ...next,
        sixStreak: 0,
        lastRoll: null,
        phase: "await_roll",
        turnSeat: nextActiveSeat(state, next, seatIndex),
        events: pushEvent(engine.events, {
          ply,
          seatIndex,
          kind: "penalty",
          text: `${color}连续掷出 ${streak} 次 6 点,惩罚:本回合作废,轮换下家`,
        }),
      };
      return success({ ...state, engineState: next, deadlineAt: Date.now() + next.rules.turnMs });
    }
    next = { ...next, sixStreak: streak };
  } else {
    next = { ...next, sixStreak: 0 };
  }

  // 无子可动:自动跳过并提示,轮换下家(掷 6 必有机可动,见文件头注释)。
  const movable = next.planes[seatIndex] ?? [];
  const hasMove = movable.some((pos) => planLudoMove(pos ?? null, roll, next.rules) !== null);
  if (!hasMove) {
    next = {
      ...next,
      sixStreak: 0,
      lastRoll: null,
      phase: "await_roll",
      turnSeat: nextActiveSeat(state, next, seatIndex),
      events: pushEvent(next.events, {
        ply,
        seatIndex,
        kind: "skip",
        text: `${color}掷出 ${roll} 点,无子可动,自动跳过`,
      }),
    };
    return success({ ...state, engineState: next, deadlineAt: Date.now() + next.rules.turnMs });
  }

  next = { ...next, lastRoll: roll, phase: "await_move" };
  return success({ ...state, engineState: next, deadlineAt: Date.now() + next.rules.turnMs });
}

/** 走子/起飞:落点链 + 撞机 + 到达判胜 + 连六再掷或轮换。 */
function applyMove(
  state: GameRoomState,
  engine: LudoEngineState,
  seatIndex: number,
  planeSlot: number,
  actionId: string,
): EngineOutcome {
  const roll = engine.lastRoll;
  if (roll === null) return failure("invalid_action", "当前没有待走的骰点");
  const planes = engine.planes[seatIndex] ?? [];
  const from = planes[planeSlot];
  if (from === undefined) return failure("illegal_move", "飞机槽位不存在");
  const plan = planLudoMove(from, roll, engine.rules);
  if (!plan) return failure("illegal_move", "这架飞机不能按当前骰点移动");

  const seat = engine.seats[seatIndex];
  if (!seat) return failure("internal_error", "座位缺失");
  const color = colorName(seat.colorIndex);

  // 撞机:最终落点在主环时,同格敌机全部回待机(己机可叠)。
  const captures: LudoMoveRecord["captures"] = [];
  const landingCell = ludoLoopCell(seat.colorIndex, plan.final);
  const nextPlanes = engine.planes.map((seatPlanes, idx) => {
    if (idx === seatIndex) return seatPlanes;
    return seatPlanes.map((pos, slot) => {
      if (pos === null || pos > LUDO_LOOP_TOP) return pos; // 跑道/终点私有,不判撞
      if (landingCell !== null && ludoLoopCell(engine.seats[idx]?.colorIndex ?? 0, pos) === landingCell) {
        captures.push({ seatIndex: idx, colorIndex: engine.seats[idx]?.colorIndex ?? 0, planeSlot: slot });
        return null; // 被撞回待机
      }
      return pos;
    });
  });

  const movedPlanes = nextPlanes.map((seatPlanes, idx) =>
    idx === seatIndex ? seatPlanes.map((pos, slot) => (slot === planeSlot ? plan.final : pos)) : seatPlanes,
  );

  const hopText = plan.hops
    .map((hop) =>
      hop.kind === "takeoff"
        ? "起飞"
        : hop.kind === "move"
          ? from === null
            ? "起飞"
            : `前进→${hop.to}格`
          : hop.kind === "jump"
            ? `跳跃→${hop.to}格`
            : `飞行→${hop.to}格`,
    )
    .join(",");
  const captureText =
    captures.length > 0 ? `,撞回${captures.map((c) => planeName(c.colorIndex, c.planeSlot)).join("、")}` : "";
  const arrived = arrivedCount(movedPlanes[seatIndex] ?? []);
  const text = `${planeName(seat.colorIndex, planeSlot)} 掷${roll} ${hopText}${captureText}${
    plan.final === LUDO_FINISH_POS ? ",到达!" : ""
  }`;

  const record: LudoMoveRecord = {
    ply: engine.history.length + 1,
    seatIndex,
    colorIndex: seat.colorIndex,
    roll,
    planeSlot,
    from,
    to: plan.final,
    hops: [...plan.hops],
    captures,
    text,
  };

  let next: LudoEngineState = {
    ...engine,
    planes: movedPlanes,
    history: [...engine.history, record],
    actionIds: trackActionId(engine.actionIds, actionId),
    lastRoll: null,
    phase: "await_roll",
  };

  // 判胜:先送满 4 架到达者胜,立刻终局(即使还有连六再掷权)。
  if (arrived >= LUDO_PLANES_PER_PLAYER) {
    next = {
      ...next,
      outcome: { result: "win", winnerSeat: seatIndex, reason: "finish" },
      events: pushEvent(next.events, { ply: record.ply, seatIndex, kind: "win", text: `${color}全部飞机到达,获胜!` }),
    };
    return success({ ...state, engineState: next, deadlineAt: null });
  }

  // 连六再掷:掷 6 且未触发惩罚 → 同一玩家再掷;否则轮换下家。
  if (roll === 6 && next.rules.extraRollOnSix && next.sixStreak < next.rules.maxConsecutiveSixes) {
    return success({ ...state, engineState: next, deadlineAt: Date.now() + next.rules.turnMs });
  }
  next = { ...next, sixStreak: 0, turnSeat: nextActiveSeat(state, next, seatIndex) };
  return success({ ...state, engineState: next, deadlineAt: Date.now() + next.rules.turnMs });
}

/** 认输(DO 离席路径也会以 resign 调用):飞机清回机库,永久跳过其回合。 */
function applyResign(
  state: GameRoomState,
  engine: LudoEngineState,
  seatIndex: number,
  actionId: string,
): EngineOutcome {
  const seat = engine.seats[seatIndex];
  if (!seat) return failure("internal_error", "座位缺失");
  const color = colorName(seat.colorIndex);
  const planes = engine.planes.map((seatPlanes, idx) => (idx === seatIndex ? seatPlanes.map(() => null) : seatPlanes));
  const resigned = [...engine.resigned, seatIndex];
  const ply = engine.history.length;
  let next: LudoEngineState = {
    ...engine,
    planes,
    resigned,
    actionIds: trackActionId(engine.actionIds, actionId),
    events: pushEvent(engine.events, { ply, seatIndex, kind: "resign", text: `${color}认输,退出对局` }),
  };

  const remaining = next.seats
    .map((_, idx) => idx)
    .filter((idx) => !next.resigned.includes(idx))
    .filter((idx) => {
      const hash = next.seats[idx]?.participantHash;
      return hash !== undefined && findActivePlayer(state, hash) !== null;
    });
  if (remaining.length === 1) {
    const winner = remaining[0]!;
    next = {
      ...next,
      outcome: { result: "win", winnerSeat: winner, reason: "resign" },
      events: pushEvent(next.events, {
        ply,
        seatIndex: winner,
        kind: "win",
        text: `${colorName(next.seats[winner]?.colorIndex ?? 0)}成为最后在场玩家,获胜!`,
      }),
    };
  } else if (remaining.length === 0) {
    next = { ...next, outcome: { result: "aborted", winnerSeat: null, reason: "resign" } };
  } else if (next.turnSeat === seatIndex) {
    // 认输者正执回合:作废未走的骰点,轮换下家。
    next = {
      ...next,
      lastRoll: null,
      sixStreak: 0,
      phase: "await_roll",
      turnSeat: nextActiveSeat(state, next, seatIndex),
    };
  }
  return success({ ...state, engineState: next, deadlineAt: next.outcome ? null : Date.now() + next.rules.turnMs });
}

// ---------------------------------------------------------------------------
// 引擎实现
// ---------------------------------------------------------------------------

export const ludoEngine: MultiplayerGameEngine = {
  gameType: "ludo",
  label: "飞行棋",
  meta: {
    displayName: "飞行棋",
    description: "经典飞行棋 2–4 人:掷六起飞、同色跳跃、虚线飞行、终点精确反弹;先送全部飞机到达者胜。",
    minPlayers: 2,
    maxPlayers: 4,
  } satisfies GameEngineMeta,

  createRoom(state, config): EngineOutcome {
    const rules = readRules(config);
    if (!rules) {
      return failure(
        "invalid_action",
        "config 非法:turnMs 5s–10min,maxConsecutiveSixes 2–6,jumpStep 1–12,flyStep 1–24 且 flyPos+flyStep ≤ 50,flyPos 须为 4 的倍数(4–44)",
      );
    }
    // 初始种子只由 roomId 派生:建房 config 经 REST 层原样透传(game-api.ts
    // /handleCreate),若接受 config.seed,建房者即可离线复现整局骰点序列
    // 预知起飞/撞机时机——作弊通道,故这里没有第二个种子来源;重放一致性
    // 由「同 roomId 同种子 + 确定性 RNG」保证,测试控骰走 engineState 摆盘。
    const rngSeed = hashSeed(state.roomId);
    const engine = syncSeats(
      {
        seats: [],
        planes: [],
        resigned: [],
        turnSeat: 0,
        phase: "await_roll",
        lastRoll: null,
        sixStreak: 0,
        rngSeed,
        history: [],
        events: [],
        outcome: null,
        actionIds: [],
        rules,
      },
      state,
    );
    return success(withEngine(state, engine));
  },

  joinRoom(state, player): EngineOutcome {
    if (state.status !== "lobby") {
      return failure("invalid_action", "对局已开始,无法加入");
    }
    const engine = readEngineState(state);
    if (!engine) return failure("internal_error", "房间引擎状态未初始化");
    if (activePlayers(state).length >= 4) {
      return failure("invalid_action", "房间已满(飞行棋最多四人)");
    }
    // 协议契约:state.players 此刻不含该玩家,引擎负责追加并重建座位表。
    const players = [...state.players, player];
    return success(withEngine({ ...state, players }, syncSeats(engine, { ...state, players })));
  },

  setReady(state, participantHash, ready): EngineOutcome {
    if (state.status !== "lobby") return failure("invalid_action", "对局已开始");
    if (!findActivePlayer(state, participantHash)) return failure("not_a_player", "你还不是本房间玩家");
    const players = state.players.map((item) => (item.participantHash === participantHash ? { ...item, ready } : item));
    return success({ ...state, players });
  },

  start(state, participantHash): EngineOutcome {
    if (state.status !== "lobby") return failure("invalid_action", "对局已开始");
    const engine = readEngineState(state);
    if (!engine) return failure("internal_error", "房间引擎状态未初始化");
    const requester = state.players.find((player) => player.participantHash === participantHash);
    if (!requester || requester.leftAt) return failure("not_a_player", "你还不是本房间玩家");
    if (!requester.isHost) return failure("not_host", "只有房主可以开局");
    const active = activePlayers(state);
    if (active.length < 2) return failure("invalid_action", "飞行棋至少需要两名玩家才能开局");
    if (active.length > 4) return failure("invalid_action", "飞行棋最多四人");
    if (!active.every((player) => player.ready)) return failure("invalid_action", "全员准备后才能开局");

    // 开局是座位分配的唯一权威:按在座顺序重排(2 人对角),对局进度归零。
    const seats = active.map((player, order) => ({
      participantHash: player.participantHash,
      colorIndex: seatColorIndexFor(active.length, order),
    }));
    const next: LudoEngineState = {
      ...engine,
      seats,
      planes: seats.map(() => Array<LudoPlanePos>(LUDO_PLANES_PER_PLAYER).fill(null)),
      resigned: [],
      turnSeat: 0,
      phase: "await_roll",
      lastRoll: null,
      sixStreak: 0,
      history: [],
      events: [],
      outcome: null,
    };
    return success({ ...state, status: "playing", engineState: next, deadlineAt: Date.now() + engine.rules.turnMs });
  },

  applyAction(state, action): EngineOutcome {
    const engine = readEngineState(state);
    if (!engine) return failure("internal_error", "房间引擎状态未初始化");
    if (!findActivePlayer(state, action.participantHash)) {
      return failure("not_a_player", "你还不是本房间玩家");
    }
    // 防御性幂等:权威去重表在 DO storage,重放不会走到引擎;这里兜直连/异常路径。
    if (engine.actionIds.includes(action.actionId)) {
      return failure("invalid_action", "动作已处理(重复 actionId)");
    }
    // 防御性版本校验:version 由 DO 唯一递增,引擎只拒绝明显过期的动作。
    if (typeof action.baseVersion === "number" && action.baseVersion !== state.version) {
      return failure("stale_action", "局面已更新,请刷新后重试");
    }
    if (state.status !== "playing") {
      return failure(
        state.status === "lobby" ? "invalid_action" : "game_over",
        state.status === "lobby" ? "对局尚未开始" : "对局已结束",
      );
    }
    if (engine.outcome !== null) return failure("game_over", "对局已结束");

    const seatIndex = engine.seats.findIndex((seat) => seat.participantHash === action.participantHash);
    if (seatIndex < 0) return failure("internal_error", "玩家座次缺失");

    switch (action.action) {
      case "roll": {
        if (engine.resigned.includes(seatIndex)) return failure("invalid_action", "你已认输退出对局");
        if (engine.turnSeat !== seatIndex) return failure("not_your_turn", "还没轮到你掷骰");
        if (engine.phase !== "await_roll") return failure("invalid_action", "请先走棋,再掷骰");
        return applyRoll(state, engine, seatIndex, action.actionId);
      }
      case "move": {
        if (engine.turnSeat !== seatIndex) return failure("not_your_turn", "还没轮到你走棋");
        if (engine.phase !== "await_move") return failure("invalid_action", "请先掷骰");
        const payload = action.payload as { plane?: unknown } | null | undefined;
        const planeSlot = payload?.plane;
        if (
          typeof planeSlot !== "number" ||
          !Number.isInteger(planeSlot) ||
          planeSlot < 0 ||
          planeSlot >= LUDO_PLANES_PER_PLAYER
        ) {
          return failure("illegal_move", "payload 必须是 { plane: 0..3 }");
        }
        return applyMove(state, engine, seatIndex, planeSlot, action.actionId);
      }
      case "resign": {
        if (engine.resigned.includes(seatIndex)) return failure("invalid_action", "你已认输退出对局");
        return applyResign(state, engine, seatIndex, action.actionId);
      }
      default:
        return failure("illegal_move", `未知动作 ${action.action}`);
    }
  },

  getPlayerView(state, participantHash): { view: unknown } {
    const engine = readEngineState(state);
    if (!engine) return { view: null };
    const seatIndex = engine.seats.findIndex((seat) => seat.participantHash === participantHash);
    return { view: { ...viewPayload(engine), yourSeat: seatIndex >= 0 ? seatIndex : null } };
  },

  getPublicView(state): { view: unknown } {
    const engine = readEngineState(state);
    return { view: engine ? viewPayload(engine) : null };
  },

  checkGameOver(state): boolean {
    const engine = readEngineState(state);
    return engine !== null && engine.outcome !== null;
  },

  settle(state): GameSettlement {
    const engine = readEngineState(state);
    const outcome = engine?.outcome ?? null;
    const ranking = engine ? ludoRanking(engine) : [];
    const winnerSeat = outcome?.winnerSeat ?? null;
    return {
      result: outcome?.result ?? "aborted",
      winnerParticipantHash: winnerSeat !== null ? (engine?.seats[winnerSeat]?.participantHash ?? null) : null,
      summary: {
        reason: outcome?.reason ?? null,
        moveCount: engine?.history.length ?? 0,
        history: engine?.history ?? [],
        ranking,
        seats: engine?.seats.map((seat) => ({ ...seat })) ?? [],
      },
      settledAt: new Date().toISOString(),
      version: state.version,
    };
  },

  /**
   * 超时 = 跳过(brief:超时视为跳过,不判负):作废当前回合(含未走的
   * 骰点),轮换下家并重设倒计时。连续超时会持续轮转,对局不会卡死。
   */
  handleTimeout(state, now): EngineOutcome {
    if (state.status !== "playing") return failure("invalid_action", "对局不在进行中");
    const engine = readEngineState(state);
    if (!engine) return failure("internal_error", "房间引擎状态未初始化");
    if (state.deadlineAt === null) return failure("invalid_action", "当前没有进行中的回合倒计时");
    if (now < state.deadlineAt) return failure("invalid_action", "尚未到超时时间");
    if (engine.outcome !== null) return failure("game_over", "对局已结束");

    const seatIndex = engine.turnSeat;
    const color = colorName(engine.seats[seatIndex]?.colorIndex ?? 0);
    const ply = engine.history.length;
    const next: LudoEngineState = {
      ...engine,
      lastRoll: null,
      sixStreak: 0,
      phase: "await_roll",
      turnSeat: nextActiveSeat(state, engine, seatIndex),
      events: pushEvent(engine.events, { ply, seatIndex, kind: "timeout", text: `${color}超时,本回合作废,自动跳过` }),
    };
    return success({ ...state, engineState: next, deadlineAt: now + engine.rules.turnMs });
  },
};
