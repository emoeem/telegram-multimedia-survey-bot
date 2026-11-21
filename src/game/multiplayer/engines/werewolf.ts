/**
 * 狼人杀(werewolf)多人引擎(游戏批次 R2)——MultiplayerGameEngine 的第五个
 * 真实实现,与 doudizhu.ts/ludo.ts 同款纪律:自写规则引擎,不引第三方库,
 * 纯函数(输入状态 → 返回新状态,绝不原地改),可在 vitest 里脱离 DO 直接驱动。
 *
 * 规则与协议取舍(brief 锁定的规则,全部实现并单测):
 * - 人数与身份:6–12 人开局。身份板默认「标准预女猎守板」(按人数推导:
 *   狼 6-7 人 2 狼 / 8-10 人 3 狼 / 11-12 人 4 狼;预言家、女巫恒有,猎人
 *   ≥7 人、守卫 ≥9 人,其余村民);config.rolePlan 可覆盖(见 readRules,
 *   总数必须恰等于座位数、狼 < 好人,否则 invalid_action)。座位 → 身份在
 *   开局时用确定性 RNG(mulberry32 变体,种子只由 roomId 哈希派生,不提供
 *   任何 config 覆盖口子)随机分配。
 * - 夜晚阶段顺序:守卫守护(不可连守同一人,可守自己)→ 狼人刀(群狼一致,
 *   窗口内可重复提交,后提交覆盖前者;无人出刀 = 空刀)→ 预言家查验(结果
 *   只回查验者)→ 女巫救/毒(各一瓶全局仅一次,同夜不可双用,不可自救/
 *   自毒)→ 结算公布死讯(座位名单,不公布死因与身份;无人死 = 平安夜)。
 *   阶段跳链:某身份全灭/双药用尽时该阶段直接跳过;行动者掉线托管留给
 *   alarm 超时兜底。
 * - 白天:发言阶段(按座位序每人一次限时文本发言,超时视为放弃)→ 投票放逐
 *   (在座活人各一票,可弃票;超时未投视为弃票)→ 平票进入 PK 轮(PK 恰一
 *   次,PK 者不能投自己)→ 再平票则无人出局。
 * - 猎人:被狼刀或被放逐死亡时可开枪带走一人(身份随枪声公示);被毒死亡
 *   不能开枪(毒杀无枪声,连开枪窗口都没有)。开枪后再判胜负。
 * - 胜利判定:狼人全灭 = 好人胜;存活狼人数 ≥ 存活好人数 = 狼胜(屠城)。
 *   每次死亡结算(夜损/放逐/枪响)后都复查一次。
 * - 私有视图纪律(getPlayerView 是协议不变量三的玩法侧执行点,本引擎的重中
 *   之重):只发自己的角色与自己的技能结果(狼人另发队友座位与当夜刀口——
 *   同为狼人技能面);夜晚动作结果只发给动作者(查验结果只有预言家可见、
 *   刀口只有狼人可见、守护只有守卫可见、用药只有女巫可见);死亡不揭示身份
 *   (死讯只有座位名单,除猎人开枪公示);广播帧(getPublicView)不含任何
 *   角色表;事件流水分公开/私有两档,按 audience 裁剪后进视图;rngSeed/
 *   actionIds/seats 角色表等内部簿记绝不进视图。单测有「玩家 A 视图不含
 *   B 的角色」全对泄漏断言。
 * - 掉线托管:超时未行动视为弃票/放弃发言/放弃技能;狼人全员超时出刀时按
 *   rules.autoWolfKill(可配置,默认开)随机刀一名活好人。离席(DO leave
 *   路径先调 resign)后其一切动作被拒,由 alarm 按托管兜底,对局不卡死。
 * - 复盘:事件流水(公开+私有)记入 engineState.events,settle 时全量输出
 *   (终局复盘亮身份,对局中绝不)。
 * - 聊天频道(chatMembership 钩子):存活狼人 → wolves 频道(仅狼可见,预言
 *   家/村民/观战不可见);死亡玩家退到 dead 频道(不再出现在活人的 all 里)。
 *   对局结束(settle/close)的聊天即焚由 GameRoomDO.commitState 负责
 *   (chatPurgeRequired → clearChat),引擎不触碰聊天存储。
 *
 * version 与 actionId 去重的协议主人是 GameRoomDO(engine-types.ts):引擎
 * 绝不 bump version,只做 baseVersion/重复 actionId 的防御性校验。
 */
import type {
  EngineOutcome,
  GameChatMembership,
  GameEngineMeta,
  GameProtocolErrorCode,
  GameRoomPlayer,
  GameRoomState,
  GameSettlement,
  MultiplayerGameEngine,
} from "../engine-types";

// ---------------------------------------------------------------------------
// 身份与身份板
// ---------------------------------------------------------------------------

export type WerewolfRole = "werewolf" | "villager" | "seer" | "witch" | "guard" | "hunter";

/** 身份中文名(客户端渲染用;服务端视图只在「自己的角色」字段里出现)。 */
export const WEREWOLF_ROLE_LABELS: Record<WerewolfRole, string> = {
  werewolf: "狼人",
  villager: "村民",
  seer: "预言家",
  witch: "女巫",
  guard: "守卫",
  hunter: "猎人",
};

/** 全部身份键(泄漏断言/rolePlan 校验用)。 */
export const WEREWOLF_ALL_ROLES: WerewolfRole[] = ["werewolf", "villager", "seer", "witch", "guard", "hunter"];

/** 发言文本上限(字数):超限返回 illegal_move。 */
export const WEREWOLF_SPEECH_MAX_CHARS = 200;

export interface WerewolfRolePlan {
  wolves: number;
  seer: boolean;
  witch: boolean;
  hunter: boolean;
  guard: boolean;
  villagers: number;
}

/**
 * 标准预女猎守板:按座位数推导身份构成。6-7 人 2 狼、8-10 人 3 狼、11-12
 * 人 4 狼;预言家/女巫恒有,猎人 ≥7 人、守卫 ≥9 人(人少时神位让位给民),
 * 其余村民。返回值按「狼→神→民」排好序,由开局洗牌打散到座位。
 */
export function werewolfBoard(seatCount: number): WerewolfRolePlan {
  const wolves = seatCount <= 7 ? 2 : seatCount <= 10 ? 3 : 4;
  const hunter = seatCount >= 7;
  const guard = seatCount >= 9;
  const villagers = seatCount - wolves - 2 - (hunter ? 1 : 0) - (guard ? 1 : 0);
  return { wolves, seer: true, witch: true, hunter, guard, villagers };
}

function planRoles(plan: WerewolfRolePlan): WerewolfRole[] {
  const roles: WerewolfRole[] = [];
  for (let i = 0; i < plan.wolves; i += 1) roles.push("werewolf");
  if (plan.seer) roles.push("seer");
  if (plan.witch) roles.push("witch");
  if (plan.guard) roles.push("guard");
  if (plan.hunter) roles.push("hunter");
  for (let i = 0; i < plan.villagers; i += 1) roles.push("villager");
  return roles;
}

/**
 * rolePlan 校验(config.rolePlan 覆盖):总数必须恰等于座位数,狼 ≥1 且
 * 狼 < 好人数(狼 ≥ 好人的开局按屠城口径直接狼胜,不构成对局)。非法返回
 * null(建房/开局返回 invalid_action)。
 */
function validatePlan(plan: WerewolfRolePlan, seatCount: number): WerewolfRolePlan | null {
  const total =
    plan.wolves +
    (plan.seer ? 1 : 0) +
    (plan.witch ? 1 : 0) +
    (plan.guard ? 1 : 0) +
    (plan.hunter ? 1 : 0) +
    plan.villagers;
  if (total !== seatCount) return null;
  if (plan.wolves < 1) return null;
  if (plan.wolves >= seatCount - plan.wolves) return null;
  return plan;
}

// ---------------------------------------------------------------------------
// 规则配置(建房 config → 引擎内快照)
// ---------------------------------------------------------------------------

export interface WerewolfRules {
  /** 每阶段时限(ms):夜行动作/每人发言/一轮投票/开枪各算一个阶段。 */
  turnMs: number;
  /** 狼人全员超时未出刀时是否随机刀一名活好人(掉线托管,默认开)。 */
  autoWolfKill: boolean;
  /** 身份板覆盖(null = 按标准板推导)。 */
  rolePlan: WerewolfRolePlan | null;
}

const DEFAULT_TURN_MS = 60_000;
const MIN_TURN_MS = 5_000;
const MAX_TURN_MS = 10 * 60_000;
const MIN_SEATS = 6;
const MAX_SEATS = 12;

function readPlan(config: Record<string, unknown>): WerewolfRolePlan | null {
  const raw = config.rolePlan;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object") return null;
  const plan = raw as Record<string, unknown>;
  const wolves = plan.wolves;
  const villagers = plan.villagers;
  if (typeof wolves !== "number" || !Number.isInteger(wolves) || wolves < 1 || wolves > 11) return null;
  if (typeof villagers !== "number" || !Number.isInteger(villagers) || villagers < 0 || villagers > 11) return null;
  return {
    wolves,
    seer: plan.seer !== false,
    witch: plan.witch !== false,
    hunter: plan.hunter === true,
    guard: plan.guard === true,
    villagers,
  };
}

function readRules(config: Record<string, unknown>): WerewolfRules | null {
  const rules: WerewolfRules = { turnMs: DEFAULT_TURN_MS, autoWolfKill: true, rolePlan: null };
  const turnMs = config.turnMs;
  if (turnMs !== undefined) {
    if (typeof turnMs !== "number" || !Number.isFinite(turnMs) || turnMs < MIN_TURN_MS || turnMs > MAX_TURN_MS) {
      return null;
    }
    rules.turnMs = Math.round(turnMs);
  }
  const autoWolfKill = config.autoWolfKill;
  if (autoWolfKill !== undefined) {
    if (typeof autoWolfKill !== "boolean") return null;
    rules.autoWolfKill = autoWolfKill;
  }
  rules.rolePlan = readPlan(config);
  return rules;
}

// ---------------------------------------------------------------------------
// 引擎私有状态
// ---------------------------------------------------------------------------

export interface WerewolfSeat {
  participantHash: string;
  role: WerewolfRole;
  alive: boolean;
  /**
   * 死因:knife(狼刀)/poison(毒药)/exile(放逐)/shot(猎人枪)。绝不进任何
   * 视图(死因会拐弯泄露夜晚信息,如「被毒」= 女巫开过毒),只在 settle
   * 复盘快照里公开。
   */
  deathCause: "knife" | "poison" | "exile" | "shot" | null;
}

/** 事件流水的一条:audience = "all" 公开,或座位号数组(仅这些座位可见)。 */
export interface WerewolfEvent {
  seq: number;
  /** 夜数(夜 N 的事件 day = N)。 */
  day: number;
  audience: "all" | number[];
  kind: "night" | "dawn" | "speech" | "vote" | "exile" | "shot" | "resign" | "timeout" | "win";
  text: string;
}

export interface WerewolfSpeech {
  day: number;
  seatIndex: number;
  /** skipped = 超时托管放弃发言(无文本)。 */
  skipped: boolean;
  text: string;
}

export interface WerewolfVoteRecord {
  voterSeat: number;
  /** null = 弃票(含超时托管)。 */
  targetSeat: number | null;
}

export interface WerewolfCheckRecord {
  night: number;
  seatIndex: number;
  isWolf: boolean;
}

export type WerewolfPhase =
  "night_guard" | "night_wolf" | "night_seer" | "night_witch" | "day_speak" | "day_vote" | "day_pk" | "hunter_shot";

export interface WerewolfOutcome {
  result: "good_win" | "wolf_win" | "aborted";
  winnerSide: "good" | "wolves" | null;
  reason: "wipe_wolves" | "wolves_equal_good" | "resign" | null;
}

export interface WerewolfEngineState {
  /** 座位表(开局时按在座顺序固定;role 只在引擎与 settle 复盘里,绝不进视图)。 */
  seats: WerewolfSeat[];
  phase: WerewolfPhase;
  /** 当前夜数(开局 = 夜 1;白天发言/投票沿用同一编号)。 */
  day: number;
  // ---- 当夜簿记(结算后清空) ----
  /** 狼刀目标(后提交覆盖;null = 尚无人出刀 = 空刀候选)。 */
  nightKnife: number | null;
  /** 已提交过刀口的狼人座位(全部存活狼提交完即提前收窗)。 */
  knifeSubmittedSeats: number[];
  /** 守卫本夜守护目标。 */
  nightGuarded: number | null;
  /** 上一夜守护目标(守卫不可连守同一人)。 */
  lastGuarded: number | null;
  /** 女巫本夜解药目标(null = 本夜未用)。 */
  nightSaveSeat: number | null;
  /** 女巫本夜毒药目标(null = 本夜未用)。 */
  nightPoisonSeat: number | null;
  /** 女巫两瓶药的全局一次性标记。 */
  witchSaveUsed: boolean;
  witchPoisonUsed: boolean;
  /** 预言家查验历史(私有技能结果,只有预言家的视图携带)。 */
  checkResults: WerewolfCheckRecord[];
  // ---- 白天簿记 ----
  /** 最新公布的死讯(座位名单,无死因无身份)。 */
  lastNightDeaths: number[];
  /** 本日发言顺序(活人座位升序)。 */
  speakOrder: number[];
  /** speakOrder 的游标(非座位号)。 */
  speakTurn: number;
  speeches: WerewolfSpeech[];
  /** 当前投票轮(白天首轮或 PK 轮)。 */
  votes: WerewolfVoteRecord[];
  /** PK 候选座位(null = 非 PK 轮)。 */
  pkCandidates: number[] | null;
  // ---- 猎人开枪窗口 ----
  /** 可开枪的猎人座位(null = 无)。 */
  pendingShotSeat: number | null;
  /** 开枪结算后的走向:day = 黎明枪(入白天发言),night = 放逐枪(入夜)。 */
  pendingShotThen: "day" | "night" | null;
  // ---- 流水与簿记 ----
  events: WerewolfEvent[];
  outcome: WerewolfOutcome | null;
  /** 确定性 RNG 种子(内部簿记,绝不进视图;身份洗牌/随机刀随用随演进)。 */
  rngSeed: number;
  actionIds: string[];
  rules: WerewolfRules;
}

const MAX_TRACKED_ACTION_IDS = 64;
const MAX_EVENTS = 200;

// ---------------------------------------------------------------------------
// 确定性 RNG(mulberry32 变体,与 ludo/doudizhu 同款数学,只用于洗牌与随机刀)
// ---------------------------------------------------------------------------

/** 由种子推导下一个 32bit 随机值与下一状态种子;纯函数、跨平台一致。 */
export function nextWerewolfRandom(seed: number): { value: number; next: number } {
  const advanced = ((seed + 0x6d2b79f5) | 0) >>> 0;
  let t = advanced | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const out = (t ^ (t >>> 14)) >>> 0;
  return { value: out, next: advanced };
}

/** FNV-1a 32:roomId → 初始种子(唯一来源,不收外部种子)。 */
function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 确定性洗牌(Fisher-Yates,种子随洗牌演进)。 */
export function shuffleWithSeed<T>(items: T[], seed: number): { items: T[]; seed: number } {
  const list = [...items];
  let s = seed >>> 0;
  for (let i = list.length - 1; i > 0; i -= 1) {
    const random = nextWerewolfRandom(s);
    s = random.next;
    const j = random.value % (i + 1);
    const tmp = list[i]!;
    list[i] = list[j]!;
    list[j] = tmp;
  }
  return { items: list, seed: s };
}

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function failure(code: GameProtocolErrorCode, message: string): EngineOutcome {
  return { ok: false, error: { code, message } };
}

function success(state: GameRoomState): EngineOutcome {
  return { ok: true, state };
}

/** 内部状态机辅助的统一返回:挂引擎状态 + 新倒计时(引擎自身绝不碰 version)。 */
function committed(state: GameRoomState, engine: WerewolfEngineState, deadlineAt: number | null): GameRoomState {
  return { ...state, engineState: engine, deadlineAt };
}

function readEngineState(state: GameRoomState): WerewolfEngineState | null {
  const value = state.engineState;
  return value !== null && typeof value === "object" ? (value as WerewolfEngineState) : null;
}

function withEngine(state: GameRoomState, engine: WerewolfEngineState): GameRoomState {
  return { ...state, engineState: engine };
}

function trackActionId(actionIds: string[], actionId: string): string[] {
  return [...actionIds, actionId].slice(-MAX_TRACKED_ACTION_IDS);
}

function activePlayers(state: GameRoomState): GameRoomPlayer[] {
  return state.players.filter((player) => player.leftAt === null);
}

function findActivePlayer(state: GameRoomState, participantHash: string): GameRoomPlayer | null {
  return state.players.find((player) => player.participantHash === participantHash && player.leftAt === null) ?? null;
}

function pushEvent(events: WerewolfEvent[], event: Omit<WerewolfEvent, "seq">): WerewolfEvent[] {
  const seq = (events[events.length - 1]?.seq ?? 0) + 1;
  return [...events, { ...event, seq }].slice(-MAX_EVENTS);
}

/** 座位序号 → 昵称(事件文案用);离席兜底「玩家N」。 */
function seatLabel(state: GameRoomState, engine: WerewolfEngineState, seatIndex: number): string {
  const hash = engine.seats[seatIndex]?.participantHash ?? null;
  const player = state.players.find((item) => item.participantHash === hash);
  return player?.displayName?.trim() || `玩家${seatIndex + 1}`;
}

/** 离席(托管中):player 行 leftAt 非空。引擎不维护第二份标记。 */
function isAbandoned(state: GameRoomState, engine: WerewolfEngineState, seatIndex: number): boolean {
  const hash = engine.seats[seatIndex]?.participantHash;
  if (!hash) return true;
  const player = state.players.find((item) => item.participantHash === hash);
  return player === undefined || player.leftAt !== null;
}

/** 可行动座位:在世且未离席(托管座位等 alarm 兜底,不阻塞阶段收窗)。 */
function seatUsable(state: GameRoomState, engine: WerewolfEngineState, seatIndex: number): boolean {
  const seat = engine.seats[seatIndex];
  return seat !== undefined && seat.alive && !isAbandoned(state, engine, seatIndex);
}

function seatByHash(engine: WerewolfEngineState, participantHash: string): number {
  return engine.seats.findIndex((seat) => seat.participantHash === participantHash);
}

function findRoleSeat(engine: WerewolfEngineState, role: WerewolfRole): number | null {
  const index = engine.seats.findIndex((seat) => seat.role === role);
  return index >= 0 ? index : null;
}

function aliveSeats(engine: WerewolfEngineState): number[] {
  return engine.seats.map((seat, index) => (seat.alive ? index : -1)).filter((index) => index >= 0);
}

function aliveCountBySide(engine: WerewolfEngineState): { wolves: number; good: number } {
  let wolves = 0;
  let good = 0;
  for (const seat of engine.seats) {
    if (!seat.alive) continue;
    if (seat.role === "werewolf") wolves += 1;
    else good += 1;
  }
  return { wolves, good };
}

/** 座位列表 → 「玩家A、玩家B」文案。 */
function seatListText(state: GameRoomState, engine: WerewolfEngineState, seats: number[]): string {
  return seats.map((seat) => seatLabel(state, engine, seat)).join("、");
}

// ---------------------------------------------------------------------------
// 胜负判定(每次死亡结算后复查;狼 ≥ 好 = 屠城,狼全灭 = 好人胜)
// ---------------------------------------------------------------------------

function applyVictoryCheck(state: GameRoomState, engine: WerewolfEngineState, now: number): GameRoomState {
  if (engine.outcome !== null) return { ...state, engineState: engine, deadlineAt: null };
  const counts = aliveCountBySide(engine);
  let outcome: WerewolfOutcome | null = null;
  if (counts.wolves === 0) {
    outcome = { result: "good_win", winnerSide: "good", reason: "wipe_wolves" };
  } else if (counts.wolves >= counts.good) {
    outcome = { result: "wolf_win", winnerSide: "wolves", reason: "wolves_equal_good" };
  }
  if (outcome === null) return { ...state, engineState: engine };
  const next: WerewolfEngineState = {
    ...engine,
    outcome,
    events: pushEvent(engine.events, {
      day: engine.day,
      audience: "all",
      kind: "win",
      text: outcome.result === "good_win" ? "狼人全部倒下,好人阵营获胜!" : "狼人人数已不少于好人,狼人阵营屠城获胜!",
    }),
  };
  return { ...state, engineState: next, deadlineAt: null };
}

// ---------------------------------------------------------------------------
// 夜晚阶段机(阶段跳链:身份不在/双药用尽直接跳过)
// ---------------------------------------------------------------------------

function witchStillHasPotion(engine: WerewolfEngineState): boolean {
  return !engine.witchSaveUsed || !engine.witchPoisonUsed;
}

function deadlineFor(engine: WerewolfEngineState, now: number): number | null {
  return engine.outcome !== null ? null : now + engine.rules.turnMs;
}

/** 狼人阶段收窗后的下一阶段:预言家可用(在世、未离席)→ night_seer,否则 null(跳到女巫链)。 */
function nextPhaseAfterWolf(state: GameRoomState, engine: WerewolfEngineState): WerewolfPhase | null {
  const seerSeat = findRoleSeat(engine, "seer");
  if (seerSeat !== null && seatUsable(state, engine, seerSeat)) return "night_seer";
  return null;
}

/** 女巫链:女巫可用(在世、未离席、还有至少一瓶药)才进入,否则直接结算。 */
function enterWitchOrResolve(state: GameRoomState, engine: WerewolfEngineState, now: number): GameRoomState {
  const witchSeat = findRoleSeat(engine, "witch");
  if (witchSeat !== null && seatUsable(state, engine, witchSeat) && witchStillHasPotion(engine)) {
    return committed(state, { ...engine, phase: "night_witch" }, now + engine.rules.turnMs);
  }
  return resolveNight(state, engine, now);
}

/** 开局/放逐后入夜:推进 day,重置当夜簿记,落位第一个可行动阶段。 */
function enterNight(state: GameRoomState, engine: WerewolfEngineState, now: number): GameRoomState {
  const day = engine.day + 1;
  let next: WerewolfEngineState = {
    ...engine,
    day,
    phase: "night_guard",
    nightKnife: null,
    knifeSubmittedSeats: [],
    nightGuarded: null,
    nightSaveSeat: null,
    nightPoisonSeat: null,
    lastNightDeaths: [],
    votes: [],
    pkCandidates: null,
    pendingShotSeat: null,
    pendingShotThen: null,
  };
  // 守卫在世且未离席才给守护阶段(不可行动则跳链,不烧一个 turnMs)。
  const guardSeat = findRoleSeat(next, "guard");
  const guardPhase = guardSeat !== null && seatUsable(state, next, guardSeat);
  next = { ...next, phase: guardPhase ? "night_guard" : "night_wolf" };
  return { ...state, engineState: next, deadlineAt: deadlineFor(next, now) };
}

// ---------------------------------------------------------------------------
// 夜晚结算(公布死讯;猎人开枪窗口;进入白天)
// ---------------------------------------------------------------------------

function beginSpeakPhase(state: GameRoomState, engine: WerewolfEngineState, now: number): GameRoomState {
  const speakOrder = aliveSeats(engine).filter((seat) => seatUsable(state, engine, seat));
  const hasSpeakers = speakOrder.length > 0;
  const next: WerewolfEngineState = {
    ...engine,
    phase: hasSpeakers ? "day_speak" : "day_vote",
    speakOrder,
    speakTurn: 0,
    votes: [],
    pkCandidates: null,
  };
  return { ...state, engineState: next, deadlineAt: deadlineFor(next, now) };
}

function resolveNight(state: GameRoomState, engine: WerewolfEngineState, now: number): GameRoomState {
  const deaths: number[] = [];
  const knife = engine.nightKnife;
  const blocked = knife !== null && engine.nightGuarded === knife;
  const saved = knife !== null && engine.nightSaveSeat === knife;
  let seats = engine.seats;
  if (knife !== null && !blocked && !saved) {
    seats = seats.map((seat, index) =>
      index === knife && seat.alive ? { ...seat, alive: false, deathCause: "knife" as const } : seat,
    );
    deaths.push(knife);
  }
  if (engine.nightPoisonSeat !== null) {
    const poisonSeat = engine.nightPoisonSeat;
    const alreadyDead = deaths.includes(poisonSeat);
    seats = seats.map((seat, index) =>
      index === poisonSeat && seat.alive && !alreadyDead
        ? { ...seat, alive: false, deathCause: "poison" as const }
        : seat,
    );
    if (!alreadyDead) deaths.push(poisonSeat);
  }
  deaths.sort((a, b) => a - b);

  const savedSeat = engine.nightSaveSeat;
  let events = engine.events;
  // 私有事件:动作结果只发给动作者(守卫/女巫)。狼刀口事件在 applyWolfKill
  // 与超时路径已各自落过,这里不重复。
  const guardSeat = findRoleSeat(engine, "guard");
  if (engine.nightGuarded !== null && guardSeat !== null) {
    events = pushEvent(events, {
      day: engine.day,
      audience: [guardSeat],
      kind: "night",
      text: `你守护了 ${seatLabel(state, engine, engine.nightGuarded)}`,
    });
  }
  if (savedSeat !== null && saved) {
    events = pushEvent(events, {
      day: engine.day,
      audience: [findRoleSeat(engine, "witch") ?? -1],
      kind: "night",
      text: `你的解药救下了 ${seatLabel(state, engine, savedSeat)}`,
    });
  }
  if (engine.nightPoisonSeat !== null) {
    events = pushEvent(events, {
      day: engine.day,
      audience: [findRoleSeat(engine, "witch") ?? -1],
      kind: "night",
      text: `你毒杀了 ${seatLabel(state, engine, engine.nightPoisonSeat)}`,
    });
  }

  // 公开死讯:座位名单,无死因无身份(死亡不揭示身份)。
  let next: WerewolfEngineState = { ...engine, seats };
  if (deaths.length === 0) {
    events = pushEvent(events, {
      day: next.day,
      audience: "all",
      kind: "dawn",
      text: "天亮了,昨夜是平安夜,无人倒下。",
    });
  } else {
    events = pushEvent(events, {
      day: next.day,
      audience: "all",
      kind: "dawn",
      text: `天亮了,昨夜 ${seatListText(state, next, deaths)} 倒下了。`,
    });
  }
  next = {
    ...next,
    lastNightDeaths: deaths,
    // 上一夜守护目标留给守卫的「不可连守」判定(当夜簿记清空)。
    lastGuarded: engine.nightGuarded,
    nightKnife: null,
    knifeSubmittedSeats: [],
    nightGuarded: null,
    nightSaveSeat: null,
    nightPoisonSeat: null,
    events,
  };

  const afterVictory = applyVictoryCheck(state, next, now);
  if (afterVictory.engineState && (afterVictory.engineState as WerewolfEngineState).outcome !== null) {
    return afterVictory;
  }
  const nextEngine = afterVictory.engineState as WerewolfEngineState;

  // 猎人开枪窗口:被狼刀(非毒)的猎人可在黎明开枪(毒杀无枪声)。
  const shotSeat = deaths.find(
    (seat) => nextEngine.seats[seat]?.role === "hunter" && nextEngine.seats[seat]?.deathCause !== "poison",
  );
  if (shotSeat !== undefined) {
    return committed(
      state,
      {
        ...nextEngine,
        phase: "hunter_shot",
        pendingShotSeat: shotSeat,
        pendingShotThen: "day",
      },
      now + nextEngine.rules.turnMs,
    );
  }
  return beginSpeakPhase(state, nextEngine, now);
}

// ---------------------------------------------------------------------------
// 白天:发言 → 投票 → (平票 PK) → 放逐/入夜
// ---------------------------------------------------------------------------

/** 发言游标推进:说完所有人进入投票,否则游标 +1、阶段保持、刷新倒计时。 */
function advanceSpeak(state: GameRoomState, engine: WerewolfEngineState, now: number): GameRoomState {
  const nextTurn = engine.speakTurn + 1;
  if (nextTurn >= engine.speakOrder.length) {
    return committed(state, { ...engine, phase: "day_vote", votes: [], pkCandidates: null }, now + engine.rules.turnMs);
  }
  return committed(state, { ...engine, speakTurn: nextTurn }, now + engine.rules.turnMs);
}

/**
 * 计票(白天首轮与 PK 轮共用)。最高票唯一 → 放逐;首轮平票 → PK 轮
 * (pkCandidates 记录候选,恰一次);PK 轮再平票 → 无人出局。全弃票 →
 * 无人出局。放逐后:猎人开枪窗口(放逐枪可开)→ 胜负 → 入夜。
 */
function tallyVotes(state: GameRoomState, engine: WerewolfEngineState, now: number, isPkRound: boolean): GameRoomState {
  const counts = new Map<number, number>();
  for (const vote of engine.votes) {
    if (vote.targetSeat === null) continue;
    counts.set(vote.targetSeat, (counts.get(vote.targetSeat) ?? 0) + 1);
  }
  let max = 0;
  for (const count of counts.values()) max = Math.max(max, count);

  let events = engine.events;
  // 亮票(公开):投票结束后公示谁投了谁(弃票标注)。
  const ballotText = engine.votes
    .map(
      (vote) =>
        `${seatLabel(state, engine, vote.voterSeat)}→${vote.targetSeat === null ? "弃票" : seatLabel(state, engine, vote.targetSeat)}`,
    )
    .join(", ");
  events = pushEvent(events, {
    day: engine.day,
    audience: "all",
    kind: "vote",
    text: ballotText ? `亮票:${ballotText}` : "无人投票。",
  });

  let next: WerewolfEngineState = { ...engine, events };
  if (max <= 0) {
    next = {
      ...next,
      events: pushEvent(next.events, {
        day: next.day,
        audience: "all",
        kind: "vote",
        text: "无人被放逐,天黑请闭眼。",
      }),
    };
    const afterVictory = applyVictoryCheck(state, next, now);
    if ((afterVictory.engineState as WerewolfEngineState).outcome !== null) return afterVictory;
    return enterNight(state, afterVictory.engineState as WerewolfEngineState, now);
  }
  const tied = [...counts.entries()]
    .filter(([, count]) => count === max)
    .map(([seat]) => seat)
    .sort((a, b) => a - b);
  if (tied.length > 1 && !isPkRound) {
    // 首轮平票 → PK 轮(恰一次):候选即平票者,重新投票。
    next = {
      ...next,
      phase: "day_pk",
      pkCandidates: tied,
      votes: [],
      events: pushEvent(next.events, {
        day: next.day,
        audience: "all",
        kind: "vote",
        text: `${seatListText(state, next, tied)} 平票,进入 PK 轮(再平票则无人出局)。`,
      }),
    };
    return committed(state, next, now + next.rules.turnMs);
  }
  if (tied.length > 1) {
    // PK 轮再平票:无人出局。
    next = {
      ...next,
      events: pushEvent(next.events, {
        day: next.day,
        audience: "all",
        kind: "vote",
        text: "PK 轮仍平票,无人出局,天黑请闭眼。",
      }),
    };
    const afterVictory = applyVictoryCheck(state, next, now);
    if ((afterVictory.engineState as WerewolfEngineState).outcome !== null) return afterVictory;
    return enterNight(state, afterVictory.engineState as WerewolfEngineState, now);
  }

  // 唯一最高票 → 放逐(座位公开,身份不揭示)。
  const exiled = tied[0]!;
  let seats = next.seats.map((seat, index) =>
    index === exiled && seat.alive ? { ...seat, alive: false, deathCause: "exile" as const } : seat,
  );
  next = {
    ...next,
    seats,
    votes: [],
    pkCandidates: null,
    events: pushEvent(next.events, {
      day: next.day,
      audience: "all",
      kind: "exile",
      text: `${seatLabel(state, next, exiled)} 被投票放逐出局。`,
    }),
  };
  const afterVictory = applyVictoryCheck(state, next, now);
  if ((afterVictory.engineState as WerewolfEngineState).outcome !== null) return afterVictory;
  const nextEngine = afterVictory.engineState as WerewolfEngineState;

  // 被放逐的是猎人 → 放逐枪窗口(开枪后入夜)。
  if (nextEngine.seats[exiled]?.role === "hunter") {
    return committed(
      state,
      {
        ...nextEngine,
        phase: "hunter_shot",
        pendingShotSeat: exiled,
        pendingShotThen: "night",
      },
      now + nextEngine.rules.turnMs,
    );
  }
  return enterNight(state, nextEngine, now);
}

/** 猎人开枪结算:带走目标 → 公示枪声 → 胜负 → 按窗口来源走向(白天/入夜)。 */
function resolveHunterShot(
  state: GameRoomState,
  engine: WerewolfEngineState,
  now: number,
  target: number | null,
): GameRoomState {
  const shooter = engine.pendingShotSeat;
  // 防御位(调用方都已保证 pendingShotSeat 非空):原样返回,不改状态。
  if (shooter === null) return { ...state, engineState: engine };
  let next = engine;
  if (target !== null) {
    const seats = next.seats.map((seat, index) =>
      index === target && seat.alive ? { ...seat, alive: false, deathCause: "shot" as const } : seat,
    );
    next = {
      ...next,
      seats,
      events: pushEvent(next.events, {
        day: next.day,
        audience: "all",
        kind: "shot",
        // 猎人开枪允许公示:枪声同时揭示开枪者的猎人身份(死亡不揭示身份的
        // 唯一例外)。
        text: `${seatLabel(state, next, shooter)} 亮出猎人身份,开枪带走了 ${seatLabel(state, next, target)}!`,
      }),
    };
  } else {
    next = {
      ...next,
      events: pushEvent(next.events, {
        day: next.day,
        audience: "all",
        kind: "shot",
        text: `${seatLabel(state, next, shooter)} 亮出猎人身份,选择不开枪。`,
      }),
    };
  }
  next = { ...next, pendingShotSeat: null, pendingShotThen: null };
  const afterVictory = applyVictoryCheck(state, next, now);
  if ((afterVictory.engineState as WerewolfEngineState).outcome !== null) return afterVictory;
  const nextEngine = afterVictory.engineState as WerewolfEngineState;
  const then = engine.pendingShotThen ?? "day";
  return then === "day" ? beginSpeakPhase(state, nextEngine, now) : enterNight(state, nextEngine, now);
}

// ---------------------------------------------------------------------------
// 视图载荷(私有视图纪律的执行点——本引擎的重中之重)
// ---------------------------------------------------------------------------

/**
 * 按查看者裁剪的玩法载荷。铁律(单测逐条泄漏断言):
 * - `yourRole` 只有查看者自己的角色;任何座位表/角色表字段都不存在;
 * - 狼人另发 wolfMates(队友座位,技能面)与 nightKnife(当夜刀口);
 * - 预言家的 checkResults 只在预言家视图里;
 * - 女巫的药瓶状态只在女巫视图里;tonightKnife 只在 night_witch 阶段给女巫;
 * - 守卫的 lastGuarded(不可连守依据)只在守卫视图里;
 * - 死讯只有座位名单(lastNightDeaths),死因与身份字段不存在;
 * - 事件流水按 audience 裁剪(私有事件只进相关座位视图);
 * - rngSeed/actionIds/seats 等内部簿记绝不进视图。
 */
function viewPayload(
  state: GameRoomState,
  engine: WerewolfEngineState,
  viewerSeat: number | null,
): Record<string, unknown> {
  const viewerRole: WerewolfRole | null = viewerSeat !== null ? (engine.seats[viewerSeat]?.role ?? null) : null;
  const viewerAlive = viewerSeat !== null ? (engine.seats[viewerSeat]?.alive ?? false) : false;
  const isWolfViewer = viewerRole === "werewolf";
  const isSeerViewer = viewerRole === "seer";
  const isWitchViewer = viewerRole === "witch";
  const isGuardViewer = viewerRole === "guard";

  // 事件按 audience 裁剪:公开事件人人可见,私有事件只进相关座位视图。
  const visibleEvents = engine.events.filter(
    (event) => event.audience === "all" || (viewerSeat !== null && event.audience.includes(viewerSeat)),
  );

  const usableAlive = aliveSeats(engine).filter((seat) => seatUsable(state, engine, seat));
  const seatsPublic = engine.seats.map((seat, index) => ({
    seatIndex: index,
    alive: seat.alive,
    isYou: index === viewerSeat,
  }));

  const payload: Record<string, unknown> = {
    day: engine.day,
    phase: engine.phase,
    seats: seatsPublic,
    aliveSeats: aliveSeats(engine),
    deadSeats: engine.seats.map((seat, index) => (seat.alive ? -1 : index)).filter((index) => index >= 0),
    lastNightDeaths: [...engine.lastNightDeaths],
    speakTurnSeat: engine.phase === "day_speak" ? (engine.speakOrder[engine.speakTurn] ?? null) : null,
    speeches: engine.speeches.map((speech) => ({ ...speech })),
    votesNeeded: usableAlive.length,
    votesSubmitted: engine.votes.length,
    myVoteSubmitted: viewerSeat !== null && engine.votes.some((vote) => vote.voterSeat === viewerSeat),
    pkCandidates: engine.pkCandidates === null ? null : [...engine.pkCandidates],
    pendingShotOpen: engine.pendingShotSeat !== null,
    events: visibleEvents,
    outcome: engine.outcome,
    yourSeat: viewerSeat,
  };
  // 私有视图纪律:自己的角色与存活态只在玩家视图里出现;公开视图(观战/
  // 广播帧)不含任何角色字段——广播帧不含任何角色表。
  if (viewerSeat !== null) {
    payload.yourRole = viewerRole;
    payload.yourAlive = viewerAlive;
  }

  if (isWolfViewer) {
    payload.wolfMates = engine.seats
      .map((seat, index) => (seat.role === "werewolf" ? index : -1))
      .filter((index) => index >= 0);
    payload.nightKnife = engine.nightKnife;
  }
  if (isSeerViewer) {
    payload.checkResults = engine.checkResults.map((record) => ({ ...record }));
  }
  if (isWitchViewer) {
    payload.potions = { save: !engine.witchSaveUsed, poison: !engine.witchPoisonUsed };
    // 刀口只在女巫的行动窗口里可见(标准:女巫用药前获知今夜刀口)。
    payload.tonightKnife = engine.phase === "night_witch" ? engine.nightKnife : null;
  }
  if (isGuardViewer) {
    payload.lastGuarded = engine.lastGuarded;
  }
  if (viewerSeat !== null && engine.pendingShotSeat === viewerSeat) {
    payload.canShoot = true;
    payload.shotTargets = aliveSeats(engine).filter((seat) => seat !== viewerSeat);
  }
  return payload;
}

// ---------------------------------------------------------------------------
// 动作实现
// ---------------------------------------------------------------------------

function requirePhaseTurn(
  state: GameRoomState,
  engine: WerewolfEngineState,
  participantHash: string,
  expectedPhase: WerewolfPhase,
  expectedSeat: number | null,
): { seatIndex: number } | { error: ReturnType<typeof failure> } {
  if (engine.phase !== expectedPhase) return { error: failure("invalid_action", "不在该行动阶段") };
  const seatIndex = seatByHash(engine, participantHash);
  if (seatIndex < 0) return { error: failure("not_a_player", "你还不是本房间玩家") };
  if (engine.outcome !== null) return { error: failure("game_over", "对局已结束") };
  if (expectedSeat !== null && seatIndex !== expectedSeat) return { error: failure("not_your_turn", "还没轮到你行动") };
  const seat = engine.seats[seatIndex]!;
  if (!seat.alive) return { error: failure("invalid_action", "你已出局,不能再行动") };
  if (isAbandoned(state, engine, seatIndex)) return { error: failure("invalid_action", "你已离席,对局托管中") };
  return { seatIndex };
}

/** 守卫守护:目标必须存活,且不可连守上一夜的目标(可守自己)。 */
function applyGuard(
  state: GameRoomState,
  engine: WerewolfEngineState,
  seatIndex: number,
  target: unknown,
  actionId: string,
  now: number,
): EngineOutcome {
  const guardSeat = findRoleSeat(engine, "guard");
  if (guardSeat !== seatIndex) return failure("not_your_turn", "你不是守卫");
  if (typeof target !== "number" || !Number.isInteger(target) || target < 0 || target >= engine.seats.length) {
    return failure("illegal_move", "payload 必须是 { target: 座位号 }");
  }
  const targetSeat = engine.seats[target];
  if (!targetSeat?.alive) return failure("illegal_move", "守护目标必须存活");
  if (engine.lastGuarded !== null && target === engine.lastGuarded) {
    return failure("illegal_move", "守卫不能连续两夜守护同一人");
  }
  const next: WerewolfEngineState = {
    ...engine,
    nightGuarded: target,
    actionIds: trackActionId(engine.actionIds, actionId),
  };
  // 守护后固定进入狼人阶段(守卫 → 狼 → 预言家 → 女巫 的链头)。
  return success({
    ...state,
    engineState: { ...next, phase: "night_wolf" },
    deadlineAt: now + next.rules.turnMs,
  });
}

/**
 * 狼人刀:群狼一致,窗口内可重复提交,后提交覆盖前者(brief 口径:意见不一
 * 取窗口内最后一次提交);目标必须是存活的好人(不可刀狼、不可刀死人)。
 * 全部存活狼(未离席者)提交完即提前收窗,进入下一阶段。
 */
function applyWolfKill(
  state: GameRoomState,
  engine: WerewolfEngineState,
  seatIndex: number,
  target: unknown,
  actionId: string,
  now: number,
): EngineOutcome {
  const seat = engine.seats[seatIndex]!;
  if (seat.role !== "werewolf") return failure("not_your_turn", "你不是狼人");
  if (typeof target !== "number" || !Number.isInteger(target) || target < 0 || target >= engine.seats.length) {
    return failure("illegal_move", "payload 必须是 { target: 座位号 }");
  }
  const targetSeat = engine.seats[target];
  if (!targetSeat?.alive) return failure("illegal_move", "刀口目标必须存活");
  if (targetSeat.role === "werewolf") return failure("illegal_move", "不能刀自己人");
  const wolfSeats = engine.seats
    .map((item, index) => (item.role === "werewolf" && item.alive && !isAbandoned(state, engine, index) ? index : -1))
    .filter((index) => index >= 0);
  const submitted = engine.knifeSubmittedSeats.includes(seatIndex)
    ? engine.knifeSubmittedSeats
    : [...engine.knifeSubmittedSeats, seatIndex];
  let next: WerewolfEngineState = {
    ...engine,
    nightKnife: target,
    knifeSubmittedSeats: submitted,
    actionIds: trackActionId(engine.actionIds, actionId),
  };
  const allSubmitted = wolfSeats.every((wolf) => submitted.includes(wolf));
  if (!allSubmitted) {
    return success({ ...state, engineState: next, deadlineAt: now + next.rules.turnMs });
  }
  // 全狼已提交:提前收窗 → 预言家链(预言家不可用则直落女巫/结算)。
  const advanced = nextPhaseAfterWolf(state, next);
  if (advanced === null) return success(enterWitchOrResolve(state, next, now));
  return success({
    ...state,
    engineState: { ...next, phase: advanced },
    deadlineAt: now + next.rules.turnMs,
  });
}

/** 预言家查验:目标必须存活且非自己;结果(是否狼人)只进查验历史(私有)。 */
function applySeerCheck(
  state: GameRoomState,
  engine: WerewolfEngineState,
  seatIndex: number,
  target: unknown,
  actionId: string,
  now: number,
): EngineOutcome {
  if (engine.seats[seatIndex]!.role !== "seer") return failure("not_your_turn", "你不是预言家");
  if (typeof target !== "number" || !Number.isInteger(target) || target < 0 || target >= engine.seats.length) {
    return failure("illegal_move", "payload 必须是 { target: 座位号 }");
  }
  if (target === seatIndex) return failure("illegal_move", "预言家不能查验自己");
  const targetSeat = engine.seats[target];
  if (!targetSeat?.alive) return failure("illegal_move", "查验目标必须存活");
  let next: WerewolfEngineState = {
    ...engine,
    checkResults: [
      ...engine.checkResults,
      { night: engine.day, seatIndex: target, isWolf: targetSeat.role === "werewolf" },
    ],
    actionIds: trackActionId(engine.actionIds, actionId),
  };
  next = {
    ...next,
    events: pushEvent(next.events, {
      day: next.day,
      audience: [seatIndex],
      kind: "night",
      text: `你查验了 ${seatLabel(state, next, target)}:${targetSeat.role === "werewolf" ? "狼人" : "好人"}`,
    }),
  };
  return success(enterWitchOrResolve(state, next, now));
}

/**
 * 女巫用药窗口:witch_save / witch_poison / witch_pass。两瓶药全局各一次;
 * 同夜不可双用(窗口保持开放:用过一瓶后当晚另一瓶直接拒,witch_pass 或
 * 超时才收窗结算);解药不可自救、毒药不可自毒。解药只对当夜刀口生效
 * (守卫已挡的刀口再救也不复活,药照耗——同守同救规则按 brief 的
 * 「同刀同救 = 救活」口径,守卫挡刀在先,救药对已挡刀口无效)。
 */
function applyWitch(
  state: GameRoomState,
  engine: WerewolfEngineState,
  seatIndex: number,
  kind: "witch_save" | "witch_poison" | "witch_pass",
  target: unknown,
  actionId: string,
  now: number,
): EngineOutcome {
  if (engine.seats[seatIndex]!.role !== "witch") return failure("not_your_turn", "你不是女巫");
  let next: WerewolfEngineState = { ...engine, actionIds: trackActionId(engine.actionIds, actionId) };
  if (kind === "witch_save") {
    if (engine.witchSaveUsed) return failure("illegal_move", "解药已经用掉了");
    if (engine.nightPoisonSeat !== null) return failure("illegal_move", "同一夜不能又毒又救");
    if (engine.nightKnife === null) return failure("invalid_action", "今夜无人被刀,解药无处可用");
    if (engine.nightKnife === seatIndex) return failure("illegal_move", "女巫不能自救");
    // 用药后窗口保持开放:当晚另一瓶被「同夜不可双用」挡住,witch_pass 收窗。
    next = { ...next, nightSaveSeat: engine.nightKnife, witchSaveUsed: true };
    return success({ ...state, engineState: next, deadlineAt: now + next.rules.turnMs });
  }
  if (kind === "witch_poison") {
    if (engine.witchPoisonUsed) return failure("illegal_move", "毒药已经用掉了");
    if (engine.nightSaveSeat !== null) return failure("illegal_move", "同一夜不能又救又毒");
    if (typeof target !== "number" || !Number.isInteger(target) || target < 0 || target >= engine.seats.length) {
      return failure("illegal_move", "payload 必须是 { target: 座位号 }");
    }
    if (target === seatIndex) return failure("illegal_move", "女巫不能毒自己");
    const targetSeat = engine.seats[target];
    if (!targetSeat?.alive) return failure("illegal_move", "毒药目标必须存活");
    next = { ...next, nightPoisonSeat: target, witchPoisonUsed: true };
    return success({ ...state, engineState: next, deadlineAt: now + next.rules.turnMs });
  }
  return success(resolveNight(state, next, now));
}

/** 白天发言:当前发言者一次一条文本(≤200 字;空文本视为沉默)。 */
function applySpeak(
  state: GameRoomState,
  engine: WerewolfEngineState,
  seatIndex: number,
  text: unknown,
  actionId: string,
  now: number,
): EngineOutcome {
  const expected = engine.speakOrder[engine.speakTurn] ?? null;
  if (expected !== seatIndex) return failure("not_your_turn", "还没轮到你发言");
  if (typeof text !== "string") return failure("illegal_move", "payload 必须是 { text: string }");
  const trimmed = text.trim().slice(0, WEREWOLF_SPEECH_MAX_CHARS);
  let next: WerewolfEngineState = {
    ...engine,
    speeches: [...engine.speeches, { day: engine.day, seatIndex, skipped: false, text: trimmed }],
    actionIds: trackActionId(engine.actionIds, actionId),
    events: pushEvent(engine.events, {
      day: engine.day,
      audience: "all",
      kind: "speech",
      text: `${seatLabel(state, engine, seatIndex)} 发言:${trimmed === "" ? "(沉默)" : trimmed}`,
    }),
  };
  return success(advanceSpeak(state, next, now));
}

/**
 * 投票(白天首轮 / PK 轮):在座活人各一票,target null = 弃票。普通轮不可
 * 投自己;PK 轮只能投 PK 候选且不能投自己。全员(未离席者)投完即收票计票。
 */
function applyVote(
  state: GameRoomState,
  engine: WerewolfEngineState,
  seatIndex: number,
  target: unknown,
  actionId: string,
  now: number,
): EngineOutcome {
  const isPk = engine.phase === "day_pk";
  if (engine.phase !== "day_vote" && !isPk) return failure("invalid_action", "不在投票阶段");
  if (engine.votes.some((vote) => vote.voterSeat === seatIndex)) {
    return failure("invalid_action", "你已经投过票了");
  }
  let normalized: number | null;
  if (target === null || target === undefined) {
    normalized = null;
  } else {
    if (typeof target !== "number" || !Number.isInteger(target) || target < 0 || target >= engine.seats.length) {
      return failure("illegal_move", "payload 必须是 { target: 座位号 | null }");
    }
    if (target === seatIndex) return failure("illegal_move", isPk ? "PK 轮不能投自己" : "不能投自己");
    if (!engine.seats[target]!.alive) return failure("illegal_move", "投票目标必须存活");
    if (isPk) {
      if (engine.pkCandidates === null || !engine.pkCandidates.includes(target)) {
        return failure("illegal_move", "PK 轮只能投 PK 候选");
      }
    }
    normalized = target;
  }
  const next: WerewolfEngineState = {
    ...engine,
    votes: [...engine.votes, { voterSeat: seatIndex, targetSeat: normalized }],
    actionIds: trackActionId(engine.actionIds, actionId),
  };
  const voters = aliveSeats(next).filter((seat) => seatUsable(state, next, seat));
  const allVoted = voters.every((voter) => next.votes.some((vote) => vote.voterSeat === voter));
  if (!allVoted) return success({ ...state, engineState: next, deadlineAt: now + next.rules.turnMs });
  return success(tallyVotes(state, next, now, isPk));
}

/** 猎人开枪 / 放弃(仅待开枪的猎人;他已出局,例外放行)。 */
function applyHunter(
  state: GameRoomState,
  engine: WerewolfEngineState,
  seatIndex: number,
  kind: "hunter_shot" | "hunter_pass",
  target: unknown,
  actionId: string,
  now: number,
): EngineOutcome {
  if (engine.phase !== "hunter_shot") return failure("invalid_action", "不在开枪阶段");
  if (engine.pendingShotSeat !== seatIndex) return failure("not_your_turn", "没有待你结算的猎人技能");
  if (kind === "hunter_pass") {
    const next: WerewolfEngineState = { ...engine, actionIds: trackActionId(engine.actionIds, actionId) };
    return success(resolveHunterShot(state, next, now, null));
  }
  if (typeof target !== "number" || !Number.isInteger(target) || target < 0 || target >= engine.seats.length) {
    return failure("illegal_move", "payload 必须是 { target: 座位号 }");
  }
  if (target === seatIndex) return failure("illegal_move", "不能枪击自己");
  const targetSeat = engine.seats[target];
  if (!targetSeat?.alive) return failure("illegal_move", "枪击目标必须存活");
  const next: WerewolfEngineState = { ...engine, actionIds: trackActionId(engine.actionIds, actionId) };
  return success(resolveHunterShot(state, next, now, target));
}

/**
 * 认输/离席(DO leave 路径自动调):记事件,对局不因离席中断——此后其动作
 * 一律被拒(isAbandoned),发言/投票/技能由 alarm 超时托管兜底。离席者正持
 * 开枪窗口:立即按放弃开枪结算(否则整局等一个回不来的人)。
 */
function applyResign(
  state: GameRoomState,
  engine: WerewolfEngineState,
  seatIndex: number,
  actionId: string,
  now: number,
): EngineOutcome {
  let next: WerewolfEngineState = {
    ...engine,
    actionIds: trackActionId(engine.actionIds, actionId),
    events: pushEvent(engine.events, {
      day: engine.day,
      audience: "all",
      kind: "resign",
      text: `${seatLabel(state, engine, seatIndex)} 离席,此后由系统托管(超时弃票/放弃行动)。`,
    }),
  };
  if (engine.phase === "hunter_shot" && engine.pendingShotSeat === seatIndex) {
    // 离席者正持开枪窗口:立即按放弃开枪结算(否则整局等一个回不来的人)。
    return success(resolveHunterShot(state, next, now, null));
  }
  return success({
    ...state,
    engineState: next,
    deadlineAt: engine.outcome === null ? now + engine.rules.turnMs : null,
  });
}

// ---------------------------------------------------------------------------
// 引擎实现
// ---------------------------------------------------------------------------

export const werewolfEngine: MultiplayerGameEngine = {
  gameType: "werewolf",
  label: "狼人杀",
  meta: {
    displayName: "狼人杀",
    description: "6-12 人开局:狼人/村民/预言家/女巫/守卫/猎人,黑夜白昼轮转,票选放逐,猎人一枪定音。",
    minPlayers: 6,
    maxPlayers: 12,
  } satisfies GameEngineMeta,

  createRoom(state, config): EngineOutcome {
    const rules = readRules(config);
    if (!rules) {
      return failure("invalid_action", "config 非法:turnMs 5s–10min,autoWolfKill 布尔,rolePlan 数量须恰等于座位数");
    }
    const engine: WerewolfEngineState = {
      seats: [],
      phase: "day_speak",
      day: 0,
      nightKnife: null,
      knifeSubmittedSeats: [],
      nightGuarded: null,
      lastGuarded: null,
      nightSaveSeat: null,
      nightPoisonSeat: null,
      witchSaveUsed: false,
      witchPoisonUsed: false,
      checkResults: [],
      lastNightDeaths: [],
      speakOrder: [],
      speakTurn: 0,
      speeches: [],
      votes: [],
      pkCandidates: null,
      pendingShotSeat: null,
      pendingShotThen: null,
      events: [],
      outcome: null,
      rngSeed: hashSeed(state.roomId),
      actionIds: [],
      rules,
    };
    return success(withEngine(state, engine));
  },

  joinRoom(state, player): EngineOutcome {
    if (state.status !== "lobby") {
      return failure("invalid_action", "对局已开始,无法加入(可作观战)");
    }
    if (activePlayers(state).length >= MAX_SEATS) {
      return failure("invalid_action", `房间已满(狼人杀最多 ${MAX_SEATS} 人)`);
    }
    // 身份在开局才分配:入座只追加 player 行(协议契约:players 此刻不含该玩家)。
    const players = [...state.players, player];
    return success({ ...state, players });
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
    if (active.length < MIN_SEATS) return failure("invalid_action", `狼人杀需要至少 ${MIN_SEATS} 人才能开局`);
    if (active.length > MAX_SEATS) return failure("invalid_action", `狼人杀最多 ${MAX_SEATS} 人`);
    if (!active.every((player) => player.ready)) return failure("invalid_action", "全员准备后才能开局");

    // 身份板:标准板推导或 config.rolePlan 覆盖(校验失败开局即拒)。
    const plan = engine.rules.rolePlan ?? werewolfBoard(active.length);
    const validated = validatePlan(plan, active.length);
    if (!validated)
      return failure("invalid_action", "身份板与人数不匹配:wolves+神+villagers 必须恰等于座位数且狼<好人");

    // 座位按在座顺序固定;身份用确定性 RNG 洗牌分配(种子只由 roomId 派生,
    // 不提供任何外部覆盖口子——否则建房者可离线推算整局身份)。
    const shuffled = shuffleWithSeed(planRoles(validated), engine.rngSeed);
    const seats: WerewolfSeat[] = active.map((player, index) => ({
      participantHash: player.participantHash,
      role: shuffled.items[index]!,
      alive: true,
      deathCause: null,
    }));
    const next: WerewolfEngineState = {
      ...engine,
      seats,
      phase: "night_guard",
      day: 0,
      nightKnife: null,
      knifeSubmittedSeats: [],
      nightGuarded: null,
      lastGuarded: null,
      nightSaveSeat: null,
      nightPoisonSeat: null,
      witchSaveUsed: false,
      witchPoisonUsed: false,
      checkResults: [],
      lastNightDeaths: [],
      speakOrder: [],
      speakTurn: 0,
      speeches: [],
      votes: [],
      pkCandidates: null,
      pendingShotSeat: null,
      pendingShotThen: null,
      events: [],
      outcome: null,
      rngSeed: shuffled.seed,
    };
    // 入夜(夜 1):守卫可用则从守卫阶段起,否则跳链到狼人阶段。
    return success(enterNight({ ...state, status: "playing" }, next, Date.now()));
  },

  applyAction(state, action): EngineOutcome {
    const engine = readEngineState(state);
    if (!engine) return failure("internal_error", "房间引擎状态未初始化");
    const seatIndex = seatByHash(engine, action.participantHash);
    if (seatIndex < 0) return failure("not_a_player", "你还不是本房间玩家");
    // 防御性幂等:权威去重表在 DO storage;这里兜直连/异常路径。
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
    const now = Date.now();

    // 认输(离席)是唯一在任意阶段都接受的玩家动作;离席座位其余动作同码拒绝。
    if (action.action === "resign") {
      return applyResign(state, engine, seatIndex, action.actionId, now);
    }
    if (isAbandoned(state, engine, seatIndex)) {
      return failure("invalid_action", "你已离席,对局托管中");
    }

    const payload = (action.payload ?? {}) as Record<string, unknown>;
    switch (action.action) {
      case "guard": {
        if (engine.phase !== "night_guard") return failure("invalid_action", "不在守护阶段");
        const checked = requirePhaseTurn(state, engine, action.participantHash, "night_guard", null);
        if ("error" in checked) return checked.error;
        return applyGuard(state, engine, checked.seatIndex, payload.target, action.actionId, now);
      }
      case "wolf_kill": {
        const checked = requirePhaseTurn(state, engine, action.participantHash, "night_wolf", null);
        if ("error" in checked) return checked.error;
        return applyWolfKill(state, engine, checked.seatIndex, payload.target, action.actionId, now);
      }
      case "seer_check": {
        const checked = requirePhaseTurn(state, engine, action.participantHash, "night_seer", null);
        if ("error" in checked) return checked.error;
        return applySeerCheck(state, engine, checked.seatIndex, payload.target, action.actionId, now);
      }
      case "witch_save":
      case "witch_poison":
      case "witch_pass": {
        const checked = requirePhaseTurn(state, engine, action.participantHash, "night_witch", null);
        if ("error" in checked) return checked.error;
        return applyWitch(state, engine, checked.seatIndex, action.action, payload.target, action.actionId, now);
      }
      case "speak": {
        const checked = requirePhaseTurn(state, engine, action.participantHash, "day_speak", null);
        if ("error" in checked) return checked.error;
        return applySpeak(state, engine, checked.seatIndex, payload.text, action.actionId, now);
      }
      case "vote": {
        const checked = requirePhaseTurn(
          state,
          engine,
          action.participantHash,
          engine.phase === "day_pk" ? "day_pk" : "day_vote",
          null,
        );
        if ("error" in checked) return checked.error;
        return applyVote(state, engine, checked.seatIndex, payload.target, action.actionId, now);
      }
      case "hunter_shot":
      case "hunter_pass": {
        // 猎人已出局,requirePhaseTurn 的存活检查不适用:单独校验待开枪座位。
        if (engine.phase !== "hunter_shot") return failure("invalid_action", "不在开枪阶段");
        if (engine.pendingShotSeat !== seatIndex) return failure("not_your_turn", "没有待你结算的猎人技能");
        return applyHunter(state, engine, seatIndex, action.action, payload.target, action.actionId, now);
      }
      default:
        return failure("illegal_move", `未知动作 ${action.action}`);
    }
  },

  /** 私有视图:只发自己的角色与自己的技能结果(见 viewPayload 铁律)。 */
  getPlayerView(state, participantHash): { view: unknown } {
    const engine = readEngineState(state);
    if (!engine) return { view: null };
    const seatIndex = seatByHash(engine, participantHash);
    return { view: viewPayload(state, engine, seatIndex >= 0 ? seatIndex : null) };
  },

  /** 公开视图(观战/未加入者):viewerSeat = null,无任何角色/私有技能字段。 */
  getPublicView(state): { view: unknown } {
    const engine = readEngineState(state);
    return { view: engine ? viewPayload(state, engine, null) : null };
  },

  checkGameOver(state): boolean {
    const engine = readEngineState(state);
    return engine !== null && engine.outcome !== null;
  },

  /** 结算快照:终局复盘亮全部身份 + 完整事件流水(对局中绝不外泄的都在这)。 */
  settle(state): GameSettlement {
    const engine = readEngineState(state);
    const outcome = engine?.outcome ?? null;
    return {
      result: outcome?.result ?? "aborted",
      // 阵营游戏无单一胜者:胜方名单在 summary.winnerSeats 里。
      winnerParticipantHash: null,
      summary: {
        winnerSide: outcome?.winnerSide ?? null,
        reason: outcome?.reason ?? null,
        day: engine?.day ?? 0,
        board:
          engine === null
            ? null
            : {
                wolves: engine.seats.filter((seat) => seat.role === "werewolf").length,
                seer: engine.seats.some((seat) => seat.role === "seer"),
                witch: engine.seats.some((seat) => seat.role === "witch"),
                guard: engine.seats.some((seat) => seat.role === "guard"),
                hunter: engine.seats.some((seat) => seat.role === "hunter"),
                villagers: engine.seats.filter((seat) => seat.role === "villager").length,
              },
        // 复盘:全座位身份/存活/死因 + 完整事件流水(公开+私有)+ 发言与查验。
        seats:
          engine?.seats.map((seat) => ({
            participantHash: seat.participantHash,
            role: seat.role,
            alive: seat.alive,
            deathCause: seat.deathCause,
          })) ?? [],
        checkResults: engine?.checkResults ?? [],
        speeches: engine?.speeches ?? [],
        events: engine?.events ?? [],
        rules: engine?.rules ?? null,
      },
      settledAt: new Date().toISOString(),
      version: state.version,
    };
  },

  /**
   * 超时托管(alarm 触发;对局不卡死):
   * - 守卫/预言家/女巫超时 = 放弃行动(本夜无此技能);
   * - 狼人窗口超时 = 已提交的刀口照算;无人出刀且 autoWolfKill(可配置)时
   *   随机刀一名存活好人,否则空刀;
   * - 发言超时 = 放弃发言(记 skipped);
   * - 投票/PK 超时 = 未投者一律弃票;
   * - 开枪超时 = 放弃开枪。
   */
  handleTimeout(state, now): EngineOutcome {
    if (state.status !== "playing") return failure("invalid_action", "对局不在进行中");
    const engine = readEngineState(state);
    if (!engine) return failure("internal_error", "房间引擎状态未初始化");
    if (state.deadlineAt === null) return failure("invalid_action", "当前没有进行中的阶段倒计时");
    if (now < state.deadlineAt) return failure("invalid_action", "尚未到超时时间");
    if (engine.outcome !== null) return failure("game_over", "对局已结束");

    switch (engine.phase) {
      case "night_guard": {
        const guardSeat = findRoleSeat(engine, "guard");
        let next: WerewolfEngineState =
          guardSeat !== null
            ? {
                ...engine,
                events: pushEvent(engine.events, {
                  day: engine.day,
                  audience: [guardSeat],
                  kind: "timeout",
                  text: "你超时未行动,本夜未守护任何人。",
                }),
              }
            : engine;
        return success({
          ...state,
          engineState: { ...next, phase: "night_wolf" },
          deadlineAt: now + next.rules.turnMs,
        });
      }
      case "night_wolf": {
        let next = engine;
        if (engine.nightKnife === null && engine.rules.autoWolfKill) {
          // 随机刀一名存活好人(确定性 RNG;刀口事件仅狼人可见)。
          const targets = aliveSeats(engine).filter((seat) => engine.seats[seat]!.role !== "werewolf");
          if (targets.length > 0) {
            const random = nextWerewolfRandom(engine.rngSeed);
            const target = targets[random.value % targets.length]!;
            next = {
              ...engine,
              rngSeed: random.next,
              nightKnife: target,
              events: pushEvent(engine.events, {
                day: engine.day,
                audience: engine.seats
                  .map((seat, index) => (seat.role === "werewolf" && seat.alive ? index : -1))
                  .filter((index) => index >= 0),
                kind: "timeout",
                text: `狼人超时未出刀,托管随机刀了 ${seatLabel(state, engine, target)}。`,
              }),
            };
          }
        }
        const advanced = nextPhaseAfterWolf(state, next);
        if (advanced === null) return success(enterWitchOrResolve(state, next, now));
        return success({
          ...state,
          engineState: { ...next, phase: advanced },
          deadlineAt: now + next.rules.turnMs,
        });
      }
      case "night_seer": {
        const seerSeat = findRoleSeat(engine, "seer");
        const next: WerewolfEngineState =
          seerSeat !== null
            ? {
                ...engine,
                events: pushEvent(engine.events, {
                  day: engine.day,
                  audience: [seerSeat],
                  kind: "timeout",
                  text: "你超时未行动,本夜未查验。",
                }),
              }
            : engine;
        return success(enterWitchOrResolve(state, next, now));
      }
      case "night_witch": {
        const witchSeat = findRoleSeat(engine, "witch");
        const next: WerewolfEngineState =
          witchSeat !== null
            ? {
                ...engine,
                events: pushEvent(engine.events, {
                  day: engine.day,
                  audience: [witchSeat],
                  kind: "timeout",
                  text: "你超时未行动,本夜未用药。",
                }),
              }
            : engine;
        return success(resolveNight(state, next, now));
      }
      case "day_speak": {
        // 发言超时:记一条放弃发言,游标推进。
        const seatIndex = engine.speakOrder[engine.speakTurn] ?? null;
        if (seatIndex === null) return success(beginSpeakPhase(state, engine, now));
        const next: WerewolfEngineState = {
          ...engine,
          speeches: [...engine.speeches, { day: engine.day, seatIndex, skipped: true, text: "" }],
          events: pushEvent(engine.events, {
            day: engine.day,
            audience: "all",
            kind: "timeout",
            text: `${seatLabel(state, engine, seatIndex)} 超时,放弃发言。`,
          }),
        };
        return success(advanceSpeak(state, next, now));
      }
      case "day_vote":
      case "day_pk": {
        // 投票超时:未投的活人(含离席托管)一律弃票,收票计票。
        const voters = aliveSeats(engine).filter((seat) => seatUsable(state, engine, seat));
        const missing = voters.filter((voter) => !engine.votes.some((vote) => vote.voterSeat === voter));
        const next: WerewolfEngineState = {
          ...engine,
          votes: [...engine.votes, ...missing.map((voter) => ({ voterSeat: voter, targetSeat: null }))],
        };
        return success(tallyVotes(state, next, now, engine.phase === "day_pk"));
      }
      case "hunter_shot": {
        // 开枪超时:放弃开枪(枪声公示,身份亮出)。
        const next: WerewolfEngineState = { ...engine };
        return success(resolveHunterShot(state, next, now, null));
      }
      default:
        return failure("invalid_action", "当前阶段没有超时语义");
    }
  },

  /**
   * 聊天频道成员资格(wolves 频道仅存活狼人可见;死亡退到 dead 频道):
   * 返回值只用于频道裁剪,绝不进入任何视图载荷。
   */
  chatMembership(state, participantHash): GameChatMembership {
    const engine = readEngineState(state);
    if (!engine) return { isWolf: false, isDead: true };
    const seatIndex = seatByHash(engine, participantHash);
    const seat = seatIndex >= 0 ? engine.seats[seatIndex] : undefined;
    if (!seat) return { isWolf: false, isDead: true };
    return {
      isWolf: seat.role === "werewolf" && seat.alive,
      isDead: !seat.alive,
    };
  },
};
