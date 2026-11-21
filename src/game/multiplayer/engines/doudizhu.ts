/**
 * 斗地主(doudizhu)多人引擎(游戏批次 X3)——MultiplayerGameEngine 的第四个
 * 真实实现,与 ludo.ts/xiangqi.ts 同款纪律:自写规则引擎,不引第三方库。
 *
 * 规则与协议取舍(brief 锁定的规则,全部实现并单测):
 * - 牌:54 张(3..2 各 4 张 + 小王 + 大王)。牌码 "点数:副本"(如 "10:0"、
 *   "2:3"、"16:0" 小王、"17:0" 大王),点数 3..14 = 3..A、15 = 2、16/17 =
 *   双王。洗牌用确定性 RNG(与 ludo 同款 mulberry32 变体),种子由 roomId +
 *   DO 注入的 rngNonce 哈希派生(修复 2:roomId 公开可取,只由它派生 = 离线
 *   可复现整局发牌;nonce 只存 DO storage,绝不外发),也不提供任何 config
 *   覆盖口子——建房 config 会被 REST 层原样透传,接受外部种子等于给建房者
 *   一个预知整局发牌的作弊通道。
 * - 发牌:17×3 + 3 张底牌。每人 17 张,底牌开局(地主确定)后归地主并全场公开。
 * - 叫地主:单人轮一轮(0 = 不叫,1-3 = 叫分,后叫者必须严格高于当前最高分),
 *   三家叫完后最高分者成为地主;全不叫 → 洗牌重发(redealCount 计数,种子
 *   随之演进,重发永远可终止)。
 * - 牌型:单张/对子/三张/三带一/三带二/顺子(≥5 连,不含 2 和双王)/
 *   连对(≥3 连对)/飞机(连三张 ≥2 组,含带单翼/带对翼)/四带二(带两单或
 *   两对)/炸弹/王炸。大小比较:同型同张数比主牌点数;炸弹压一切非王炸;
 *   王炸最大(全副牌只有一副王炸,不存在对王炸)。
 * - 出牌轮转:自由出(上一手为空)不能过;跟牌可过。连续两家过 → 回到
 *   出牌方新一轮自由出。2 不能进顺子/连对/飞机链(点数 15 > A)。
 * - 倍数:底分 × 叫分 × 2^炸弹数 × 春天倍数。春天(地主胜且两农民零出牌)
 *   与反春天(农民胜且地主只出过第一手)各再 ×2。
 * - 结算:积分制(绝无现金/兑换语义):单位分 = 底分×叫分×2^炸弹×春天倍数,
 *   地主 ±2 倍单位分、每农民 ∓1 倍单位分,三方代数和恒为 0。
 * - 私有视图纪律(getPlayerView 是协议不变量三的玩法侧执行点):只发自己的
 *   手牌,其他人只发张数(handCount);底牌在地主确定后全场公开;出牌历史
 *   是公开信息(打出的牌全场可见);rngSeed/actionIds 等内部簿记绝不进视图
 *   ——种子外泄 = 未发的牌可预测,单测有「玩家 A 视图不含 B/C 手牌牌面」
 *   的泄漏断言。
 * - 超时:叫分阶段视为不叫;出牌阶段自由出自动出最小单张、跟牌自动过
 *   (对局不卡死,同 ludo「超时视为跳过」的精神)。
 * - 认输(resign;DO 离席路径自动调):叫分阶段视为不叫,出牌阶段其回合
 *   永久跳过,在座未认输者不足 2 人时终局(中止,不计分)。认输是永久的:
 *   applyAction 对认输座位的任何动作同码拒绝,「两家过→回到出牌方」与
 *   「全不叫重发」都不恢复其回合/叫分权,alarm 绝不代其出牌——离席者不可
 *   能经由任何路径重新拿到回合甚至赢下对局。
 *
 * version 与 actionId 去重的协议主人是 GameRoomDO(engine-types.ts):引擎
 * 绝不 bump version,只做 baseVersion/重复 actionId 的防御性校验。所有方法
 * 均为纯函数(不原地修改),可在 vitest 里脱离 DO 直接驱动。
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
// 牌与牌码
// ---------------------------------------------------------------------------

/** 数字点数:3..14 = 3..A,15 = 2,16 = 小王,17 = 大王(比较与显示的唯一真相)。 */
export const DOU_DIZHU_RANK_MIN = 3;
export const DOU_DIZHU_RANK_MAX = 17;
/** 点数上限(顺子/连对/飞机链只到 A=14,2 与双王不进链)。 */
export const DOU_DIZHU_CHAIN_RANK_MAX = 14;
/** 单副牌点数 3..15(2) 各 4 张,双王各 1 张。 */
export const DOU_DIZHU_JOKER_SMALL = 16;
export const DOU_DIZHU_JOKER_BIG = 17;

/** 牌码 → 点数;非法牌码返回 null(服务端唯一校验,客户端传什么都不可信)。 */
export function doudizhuCardRank(card: string): number | null {
  if (typeof card !== "string") return null;
  const sep = card.indexOf(":");
  if (sep <= 0) return null;
  const rank = Number(card.slice(0, sep));
  const copy = card.slice(sep + 1);
  if (!Number.isInteger(rank) || rank < DOU_DIZHU_RANK_MIN || rank > DOU_DIZHU_RANK_MAX) return null;
  if (!/^\d+$/.test(copy)) return null;
  const copyIndex = Number(copy);
  // 双王只有一副(copy 0),点数 3..2 各 4 副本。
  if (rank >= DOU_DIZHU_JOKER_SMALL ? copyIndex !== 0 : copyIndex < 0 || copyIndex > 3) return null;
  return rank;
}

/** 牌码 → 中文显示名(客户端直接渲染;服务端不解释显示)。 */
export const DOU_DIZHU_RANK_LABELS: Record<number, string> = {
  3: "3",
  4: "4",
  5: "5",
  6: "6",
  7: "7",
  8: "8",
  9: "9",
  10: "10",
  11: "J",
  12: "Q",
  13: "K",
  14: "A",
  15: "2",
  16: "小王",
  17: "大王",
};

export function doudizhuCardLabel(card: string): string {
  const rank = doudizhuCardRank(card);
  return rank === null ? card : (DOU_DIZHU_RANK_LABELS[rank] ?? card);
}

/** 54 张整副牌(Fisher-Yates 洗牌前的初始序)。 */
export function buildDoudizhuDeck(): string[] {
  const deck: string[] = [];
  for (let rank = 3; rank <= 15; rank += 1) {
    for (let copy = 0; copy < 4; copy += 1) deck.push(`${rank}:${copy}`);
  }
  deck.push(`${DOU_DIZHU_JOKER_SMALL}:0`);
  deck.push(`${DOU_DIZHU_JOKER_BIG}:0`);
  return deck;
}

/** 手牌排序(点数降序、副本升序;发牌/进底牌后统一整理,展示稳定)。 */
export function sortDoudizhuHand(cards: string[]): string[] {
  return [...cards].sort((a, b) => {
    const ra = doudizhuCardRank(a) ?? 0;
    const rb = doudizhuCardRank(b) ?? 0;
    return rb - ra || a.localeCompare(b);
  });
}

// ---------------------------------------------------------------------------
// 确定性 RNG(mulberry32 变体,与 ludo.ts 同款数学,只用于洗牌)
// ---------------------------------------------------------------------------

/** 由种子推导下一个 32bit 随机值与下一状态种子;纯函数、跨平台一致。 */
export function nextDoudizhuRandom(seed: number): { value: number; next: number } {
  const advanced = ((seed + 0x6d2b79f5) | 0) >>> 0;
  let t = advanced | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const out = (t ^ (t >>> 14)) >>> 0;
  return { value: out, next: advanced };
}

/** FNV-1a 32:roomId → 初始种子(与 ludo 同款;唯一来源,不收外部种子)。 */
function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 确定性洗牌(Fisher-Yates,种子随洗牌演进;全不叫重发时种子已前进)。 */
export function shuffleDoudizhuDeck(seed: number): { deck: string[]; seed: number } {
  const deck = buildDoudizhuDeck();
  let s = seed >>> 0;
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const random = nextDoudizhuRandom(s);
    s = random.next;
    const j = random.value % (i + 1);
    const tmp = deck[i]!;
    deck[i] = deck[j]!;
    deck[j] = tmp;
  }
  return { deck, seed: s };
}

// ---------------------------------------------------------------------------
// 牌型识别与比较(纯函数,导出供单测直测)
// ---------------------------------------------------------------------------

export type DoudizhuPlayType =
  | "single"
  | "pair"
  | "triple"
  | "triple_one"
  | "triple_pair"
  | "straight"
  | "pair_straight"
  | "plane"
  | "plane_single"
  | "plane_pair"
  | "four_two_single"
  | "four_two_pair"
  | "bomb"
  | "rocket";

/** 牌型中文名(客户端渲染用;服务端只发 type 键)。 */
export const DOU_DIZHU_TYPE_LABELS: Record<DoudizhuPlayType, string> = {
  single: "单张",
  pair: "对子",
  triple: "三张",
  triple_one: "三带一",
  triple_pair: "三带二",
  straight: "顺子",
  pair_straight: "连对",
  plane: "飞机",
  plane_single: "飞机带单",
  plane_pair: "飞机带对",
  four_two_single: "四带二",
  four_two_pair: "四带两对",
  bomb: "炸弹",
  rocket: "王炸",
};

/** 一次出牌的形状(同型同张数才可比,主牌 keyRank 决定大小)。 */
export interface DoudizhuPlayShape {
  type: DoudizhuPlayType;
  /** 主牌关键点数(链型取链上最高点;炸弹/王炸取自身点数)。 */
  keyRank: number;
  /** 总张数(比较前提之一)。 */
  length: number;
}

function isConsecutive(sortedDistinct: number[]): boolean {
  for (let i = 1; i < sortedDistinct.length; i += 1) {
    const diff = (sortedDistinct[i] ?? 0) - (sortedDistinct[i - 1] ?? 1);
    if (diff !== 1) return false;
  }
  return sortedDistinct.length > 0;
}

/**
 * 飞机链识别:在点数 3..A(≤14)里找 count≥3 的最长连续段,从最长往下试
 * (标准口径:链越长优先;链外牌作翅膀)。带单翼 = 链外恰好 j 张(任意点数,
 * 含拆开的王炸);带对翼 = 链外牌按点数恰好组成 j 个对子。纯 3j 张 = 不带翼
 * 的连三张链(飞机)。
 */
function tryPlaneShape(counts: Map<number, number>, total: number): DoudizhuPlayShape | null {
  let best: number[] = [];
  let run: number[] = [];
  for (let rank = 3; rank <= DOU_DIZHU_CHAIN_RANK_MAX; rank += 1) {
    if ((counts.get(rank) ?? 0) >= 3) {
      run.push(rank);
    } else {
      if (run.length > best.length) best = run;
      run = [];
    }
  }
  if (run.length > best.length) best = run;
  for (let j = best.length; j >= 2; j -= 1) {
    const chain = best.slice(best.length - j);
    const top = chain[chain.length - 1]!;
    if (total === 3 * j) return { type: "plane", keyRank: top, length: total };
    if (total === 4 * j) return { type: "plane_single", keyRank: top, length: total };
    if (total === 5 * j) {
      // 带对翼:扣掉链上每组 3 张后,链外每个点数的张数必须都是偶数
      // (恰好组成 j 个对子;4 张同点可拆两对,允许)。
      const rest = new Map(counts);
      for (const rank of chain) {
        const left = (rest.get(rank) ?? 0) - 3;
        if (left <= 0) rest.delete(rank);
        else rest.set(rank, left);
      }
      const restTotal = [...rest.values()].reduce((sum, value) => sum + value, 0);
      const allEven = [...rest.values()].every((value) => value % 2 === 0);
      if (restTotal === 2 * j && allEven) return { type: "plane_pair", keyRank: top, length: total };
    }
  }
  return null;
}

/**
 * 牌型识别:返回形状(型/主牌点数/张数),不合法返回 null。识别顺序即优先级:
 * 王炸 → 单/对/三 → 炸弹 → 三带一/二 → 顺子 → 连对 → 飞机(含带翼) →
 * 四带二。歧义牌(如 33334444:可读飞机带单也可读四带两对)按上述优先级
 * 取飞机解释——与多数实现一致,识别结果只取决于牌面,与出牌者无关。
 */
export function classifyDoudizhuPlay(cards: string[]): DoudizhuPlayShape | null {
  if (!Array.isArray(cards) || cards.length === 0) return null;
  const counts = new Map<number, number>();
  for (const card of cards) {
    const rank = doudizhuCardRank(card);
    if (rank === null) return null;
    counts.set(rank, (counts.get(rank) ?? 0) + 1);
  }
  const n = cards.length;
  const distinct = [...counts.keys()].sort((a, b) => a - b);
  const top = distinct[distinct.length - 1]!;

  // 王炸:小王 + 大王(全副牌只有一副,不存在更大的)。
  if (
    n === 2 &&
    counts.size === 2 &&
    counts.get(DOU_DIZHU_JOKER_SMALL) === 1 &&
    counts.get(DOU_DIZHU_JOKER_BIG) === 1
  ) {
    return { type: "rocket", keyRank: DOU_DIZHU_JOKER_BIG, length: 2 };
  }
  if (n === 1 && counts.size === 1) return { type: "single", keyRank: top, length: 1 };
  if (n === 2 && counts.size === 1) return { type: "pair", keyRank: top, length: 2 };
  if (n === 3 && counts.size === 1) return { type: "triple", keyRank: top, length: 3 };
  if (n === 4 && counts.size === 1) return { type: "bomb", keyRank: top, length: 4 };
  // 三带一 / 三带二:恰好一组三张 + 其余。
  if ((n === 4 || n === 5) && counts.size === 2) {
    const tripleRank = distinct.find((rank) => counts.get(rank) === 3);
    if (tripleRank !== undefined) {
      return n === 4
        ? { type: "triple_one", keyRank: tripleRank, length: 4 }
        : { type: "triple_pair", keyRank: tripleRank, length: 5 };
    }
  }
  // 顺子:≥5 张单连,不含 2 与双王。
  if (n >= 5 && counts.size === n && top <= DOU_DIZHU_CHAIN_RANK_MAX && isConsecutive(distinct)) {
    return { type: "straight", keyRank: top, length: n };
  }
  // 连对:≥3 组连续对子,不含 2。
  if (n >= 6 && n % 2 === 0 && counts.size === n / 2 && distinct.every((rank) => counts.get(rank) === 2)) {
    if (top <= DOU_DIZHU_CHAIN_RANK_MAX && isConsecutive(distinct)) {
      return { type: "pair_straight", keyRank: top, length: n };
    }
  }
  // 飞机(含带翼)。
  const plane = tryPlaneShape(counts, n);
  if (plane) return plane;
  // 四带二:一组四张 + 两单(n=6)或两对(n=8)。
  const quadRank = distinct.find((rank) => counts.get(rank) === 4);
  if (quadRank !== undefined) {
    if (n === 6) return { type: "four_two_single", keyRank: quadRank, length: 6 };
    if (n === 8) {
      const rest = distinct.filter((rank) => rank !== quadRank);
      const restTotal = rest.reduce((sum, rank) => sum + (counts.get(rank) ?? 0), 0);
      const allEven = rest.every((rank) => (counts.get(rank) ?? 0) % 2 === 0);
      if (restTotal === 4 && allEven) return { type: "four_two_pair", keyRank: quadRank, length: 8 };
    }
  }
  return null;
}

/**
 * 大小比较:candidate 是否压过 current(current = null 即自由出牌,任意合法
 * 牌型可出)。王炸最大;炸弹压一切非王炸、炸弹之间比点数;其余必须同型同
 * 张数比主牌点数。
 */
export function beatsDoudizhuPlay(candidate: DoudizhuPlayShape, current: DoudizhuPlayShape | null): boolean {
  if (current === null) return true;
  if (candidate.type === "rocket") return true;
  if (current.type === "rocket") return false;
  if (candidate.type === "bomb") return current.type !== "bomb" || candidate.keyRank > current.keyRank;
  if (current.type === "bomb") return false;
  return candidate.type === current.type && candidate.length === current.length && candidate.keyRank > current.keyRank;
}

// ---------------------------------------------------------------------------
// 规则配置(建房 config → 引擎内快照)
// ---------------------------------------------------------------------------

export interface DoudizhuRules {
  /** 每步时限(ms):叫分/出牌/过牌各算一步,超时按文件头的兜底策略处理。 */
  turnMs: number;
  /** 底分(积分制,1..99;结算 = 底分 × 叫分 × 炸弹倍数 × 春天倍数)。 */
  baseScore: number;
}

const DEFAULT_RULES: DoudizhuRules = { turnMs: 60_000, baseScore: 1 };
const MIN_TURN_MS = 5_000;
const MAX_TURN_MS = 10 * 60_000;

function readRules(config: Record<string, unknown>): DoudizhuRules | null {
  const rules = { ...DEFAULT_RULES };
  const turnMs = config.turnMs;
  if (turnMs !== undefined) {
    if (typeof turnMs !== "number" || !Number.isFinite(turnMs) || turnMs < MIN_TURN_MS || turnMs > MAX_TURN_MS) {
      return null;
    }
    rules.turnMs = Math.round(turnMs);
  }
  const baseScore = config.baseScore;
  if (baseScore !== undefined) {
    if (typeof baseScore !== "number" || !Number.isInteger(baseScore) || baseScore < 1 || baseScore > 99) {
      return null;
    }
    rules.baseScore = baseScore;
  }
  return rules;
}

// ---------------------------------------------------------------------------
// 引擎私有状态
// ---------------------------------------------------------------------------

export interface DoudizhuBidRecord {
  seatIndex: number;
  /** 0 = 不叫,1..3 = 叫分。 */
  score: number;
}

export interface DoudizhuLastPlay {
  seatIndex: number;
  shape: DoudizhuPlayShape;
  cards: string[];
}

export interface DoudizhuPlayRecord {
  /** 全局动作序(1 起,含叫分/出牌/过牌)。 */
  ply: number;
  seatIndex: number;
  kind: "bid" | "play" | "pass";
  /** kind=bid 时的叫分(0 = 不叫)。 */
  score?: number;
  /** kind=play 时的牌码与牌型。 */
  cards?: string[];
  playType?: DoudizhuPlayType;
  /** 中文可读一句话,客户端直接渲染。 */
  text: string;
}

export interface DoudizhuEvent {
  ply: number;
  seatIndex: number | null;
  kind: "redeal" | "landlord" | "bomb" | "spring" | "win" | "resign" | "timeout";
  text: string;
}

export interface DoudizhuOutcome {
  result: "win" | "aborted";
  winnerSeat: number | null;
  /** 胜方:地主或农民方(结算计分的依据)。 */
  winnerSide: "landlord" | "farmers" | null;
  reason: "playout" | "resign" | null;
  /** spring = 春天(地主胜,农民零出牌);anti_spring = 反春天(农民胜,地主只出过第一手)。 */
  spring: "none" | "spring" | "anti_spring";
}

export interface DoudizhuEngineState {
  seats: Array<{
    participantHash: string;
    /** 座位令牌（DO 座位分配处铸造）：视图/结算对位的唯一公开标识（修复 1）。 */
    seatToken: string;
  }>;
  /** 每座位手牌(牌码,点数降序);对外只发本座位的这份。 */
  hands: string[][];
  /** 3 张底牌;地主确定前对所有人隐藏,之后全场公开。 */
  bottomCards: string[];
  phase: "bidding" | "playing";
  /** 叫分轮的当前叫分座位。 */
  bidTurn: number;
  /** 本轮已叫过分的座位(每人恰一次)。 */
  bidActedSeats: number[];
  bids: DoudizhuBidRecord[];
  landlordSeat: number | null;
  /** 地主叫分(1..3;= 倍数里的叫分因子)。 */
  bidScore: number;
  /** 出牌阶段的当前出牌方。 */
  currentTurn: number;
  lastPlay: DoudizhuLastPlay | null;
  /** 连续过牌数(到 2 → 出牌方新一轮自由出)。 */
  passStreak: number;
  /** 每座位实际出牌手数(过牌不计;春天判定依据)。 */
  playCounts: number[];
  /** 炸弹 + 王炸累计枚数(每枚总倍数 ×2;只在动作被接受时 +1,天然幂等)。 */
  bombCount: number;
  /** 已认输座位(其回合永久跳过,手牌不再参与)。 */
  resignedSeats: number[];
  history: DoudizhuPlayRecord[];
  events: DoudizhuEvent[];
  outcome: DoudizhuOutcome | null;
  /** 确定性 RNG 种子(内部簿记,绝不进视图;随洗牌演进)。 */
  rngSeed: number;
  /** 全不叫重发次数(诊断用,可进结算 summary)。 */
  redealCount: number;
  actionIds: string[];
  rules: DoudizhuRules;
}

const MAX_TRACKED_ACTION_IDS = 64;
const MAX_EVENTS = 50;
const HAND_SIZE = 17;
const BOTTOM_SIZE = 3;
const SEAT_COUNT = 3;

function failure(code: GameProtocolErrorCode, message: string): EngineOutcome {
  return { ok: false, error: { code, message } };
}

function success(state: GameRoomState): EngineOutcome {
  return { ok: true, state };
}

function readEngineState(state: GameRoomState): DoudizhuEngineState | null {
  const value = state.engineState;
  return value !== null && typeof value === "object" ? (value as DoudizhuEngineState) : null;
}

function withEngine(state: GameRoomState, engine: DoudizhuEngineState): GameRoomState {
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

function pushEvent(events: DoudizhuEvent[], event: DoudizhuEvent): DoudizhuEvent[] {
  return [...events, event].slice(-MAX_EVENTS);
}

/** 座位序号 → 昵称(事件文案用);离席兜底「玩家N」。 */
function seatLabel(state: GameRoomState, seatIndex: number): string {
  const hash =
    state.engineState && typeof state.engineState === "object"
      ? ((state.engineState as DoudizhuEngineState).seats[seatIndex]?.participantHash ?? null)
      : null;
  const player = state.players.find((item) => item.participantHash === hash);
  return player?.displayName?.trim() || `玩家${seatIndex + 1}`;
}

/** 下一个有效座位(跳过认输;找不到保持原座位兜底)。 */
function nextActiveSeat(engine: DoudizhuEngineState, from: number): number {
  for (let step = 1; step <= engine.seats.length; step += 1) {
    const idx = (from + step) % engine.seats.length;
    if (engine.resignedSeats.includes(idx)) continue;
    return idx;
  }
  return from;
}

/**
 * 回到某个座位本身(「连续两家过 → 出牌方新一轮自由出」的落点):该座位
 * 已认输/离席时,回合交给其后的第一个有效座位——绝不停在已认输座位上。
 * 认输是永久的:被跳过者不得经由任何路径重新拿到回合(applyPass /
 * applyResign / handleTimeout 的 leader 恢复三处共用本函数)。
 */
function activeSeatOrNext(engine: DoudizhuEngineState, seat: number): number {
  return engine.resignedSeats.includes(seat) ? nextActiveSeat(engine, seat) : seat;
}

/**
 * 叫分轮的下一个未叫分且未认输的座位(从 from 的下一家起扫描;全员已处理
 * 返回 -1,由调用方走 resolveBidding 结算)。已认输座位永不重获叫分权,
 * 全不叫重发后同样适用。
 */
function nextBidSeat(engine: DoudizhuEngineState, from: number): number {
  for (let step = 1; step <= engine.seats.length; step += 1) {
    const idx = (from + step) % engine.seats.length;
    if (engine.resignedSeats.includes(idx) || engine.bidActedSeats.includes(idx)) continue;
    return idx;
  }
  return -1;
}

/** 由在座玩家重建座位表(lobby 阶段;开局时按在座顺序固定 3 席)。 */
function syncSeats(engine: DoudizhuEngineState, state: GameRoomState): DoudizhuEngineState {
  const seats = activePlayers(state).map((player) => ({
    participantHash: player.participantHash,
    seatToken: player.seatToken,
  }));
  return { ...engine, seats };
}

// ---------------------------------------------------------------------------
// 计分(纯函数,导出供单测直测;积分制,绝无现金语义)
// ---------------------------------------------------------------------------

export interface DoudizhuScoreBreakdown {
  baseScore: number;
  bidScore: number;
  bombCount: number;
  spring: "none" | "spring" | "anti_spring";
  /** 春天倍数(春天/反春天 ×2,否则 ×1)。 */
  springMultiplier: number;
  /** 总倍数 = 叫分 × 2^炸弹数 × 春天倍数。 */
  totalMultiplier: number;
  /** 单位分 = 底分 × 总倍数(每个农民 ±unit,地主 ±2×unit)。 */
  unit: number;
}

/**
 * 倍数与单位分拆解:底分 × 叫分 × 2^炸弹数 × 春天倍数。炸弹计数在引擎状态里
 * 只随被接受的出牌动作 +1(协议层 actionId 去重挡重放),本函数是纯读——
 * 同一状态反复调用结果恒等(幂等),结算快照不会因重复 settle 而翻倍。
 */
export function doudizhuScoreBreakdown(
  rules: DoudizhuRules,
  bidScore: number,
  bombCount: number,
  spring: "none" | "spring" | "anti_spring",
): DoudizhuScoreBreakdown {
  const springMultiplier = spring === "none" ? 1 : 2;
  const totalMultiplier = bidScore * 2 ** bombCount * springMultiplier;
  return {
    baseScore: rules.baseScore,
    bidScore,
    bombCount,
    spring,
    springMultiplier,
    totalMultiplier,
    unit: rules.baseScore * totalMultiplier,
  };
}

/** 三方积分变动(地主 ±2 倍单位分,每农民 ∓1 倍;代数和恒为 0)。 */
export function doudizhuDeltas(
  breakdown: DoudizhuScoreBreakdown,
  landlordSeat: number,
  winnerSide: "landlord" | "farmers",
): number[] {
  const deltas = [0, 0, 0];
  const sign = winnerSide === "landlord" ? 1 : -1;
  for (let seat = 0; seat < SEAT_COUNT; seat += 1) {
    deltas[seat] = seat === landlordSeat ? sign * 2 * breakdown.unit : -sign * breakdown.unit;
  }
  return deltas;
}

// ---------------------------------------------------------------------------
// 发牌与开局
// ---------------------------------------------------------------------------

/** 洗牌发牌:17×3 + 3 底牌;返回引擎状态需要的牌面切片。 */
function dealHands(seed: number): { hands: string[][]; bottomCards: string[]; seed: number } {
  const { deck, seed: next } = shuffleDoudizhuDeck(seed);
  const hands = [0, 1, 2].map((seat) => sortDoudizhuHand(deck.slice(seat * HAND_SIZE, (seat + 1) * HAND_SIZE)));
  const bottomCards = sortDoudizhuHand(deck.slice(HAND_SIZE * SEAT_COUNT, HAND_SIZE * SEAT_COUNT + BOTTOM_SIZE));
  return { hands, bottomCards, seed: next };
}

/**
 * 叫分轮推进:全部有效座位(未认输者)都叫过后结算地主(最高分者);全不叫
 * → 重发(种子前进,redealCount +1)。已认输座位视为已按「不叫」处理,不
 * 参与结算,也不阻塞叫分轮——重发后他们同样没有叫分权。地主确定:底牌并入
 * 地主手牌并全场公开,进入出牌阶段,地主先出。
 */
function resolveBidding(state: GameRoomState, engine: DoudizhuEngineState): DoudizhuEngineState {
  const ply = engine.history.length;
  const allActed = engine.seats.every(
    (_, seat) => engine.resignedSeats.includes(seat) || engine.bidActedSeats.includes(seat),
  );
  if (!allActed) return engine;

  const best = engine.bids.reduce<DoudizhuBidRecord | null>(
    (acc, bid) => (bid.score > 0 && (acc === null || bid.score > acc.score) ? bid : acc),
    null,
  );
  if (best === null) {
    // 全不叫:重发。种子已随上一次洗牌演进,新的一局必然不同。首个叫分座
    // 位跳过已认输座位(重发不恢复任何人的叫分权);-1 只在全员认输时出现
    // (applyResign 在在座 ≤1 时已中止,这里兜底保持 0)。
    const redealCount = engine.redealCount + 1;
    const dealt = dealHands(engine.rngSeed);
    const firstBidder = nextBidSeat({ ...engine, bidActedSeats: [] }, engine.bidTurn);
    const next: DoudizhuEngineState = {
      ...engine,
      hands: dealt.hands,
      bottomCards: dealt.bottomCards,
      phase: "bidding",
      bidTurn: firstBidder >= 0 ? firstBidder : 0,
      bidActedSeats: [],
      bids: [],
      landlordSeat: null,
      bidScore: 0,
      currentTurn: firstBidder >= 0 ? firstBidder : 0,
      lastPlay: null,
      passStreak: 0,
      playCounts: [0, 0, 0],
      bombCount: 0,
      rngSeed: dealt.seed,
      redealCount,
      events: pushEvent(engine.events, {
        ply,
        seatIndex: null,
        kind: "redeal",
        text: "三家都不叫,重新发牌",
      }),
    };
    return next;
  }

  const landlord = best.seatIndex;
  const bottom = engine.bottomCards;
  const hands = engine.hands.map((hand, seat) => (seat === landlord ? sortDoudizhuHand([...hand, ...bottom]) : hand));
  const bottomText = bottom.map((card) => doudizhuCardLabel(card)).join(" ");
  return {
    ...engine,
    hands,
    phase: "playing",
    landlordSeat: landlord,
    bidScore: best.score,
    currentTurn: landlord,
    lastPlay: null,
    passStreak: 0,
    playCounts: [0, 0, 0],
    events: pushEvent(engine.events, {
      ply,
      seatIndex: landlord,
      kind: "landlord",
      text: `${seatLabel(state, landlord)} 以 ${best.score} 分成为地主,底牌:${bottomText}`,
    }),
  };
}

// ---------------------------------------------------------------------------
// 视图载荷(私有视图纪律的执行点)
// ---------------------------------------------------------------------------

/**
 * 按查看者裁剪的玩法载荷。铁律:
 * - `hand` 只有查看者自己的手牌(观战/公开视图为空表);
 * - 其他座位永远只有 `handCount`(张数),牌面绝不出现在载荷任何字段里;
 * - 底牌在地主确定后全场公开(bottomCards),此前只发张数;
 * - rngSeed/actionIds 等内部簿记绝不进视图(种子外泄 = 未发的牌可预测)。
 * 出牌历史与叫分记录是公开信息(打出的牌全场可见),原样携带。
 */
function viewPayload(
  state: GameRoomState,
  engine: DoudizhuEngineState,
  viewerSeat: number | null,
): Record<string, unknown> {
  const landlordDecided = engine.landlordSeat !== null;
  const currentBid = engine.bids.reduce<DoudizhuBidRecord | null>(
    (acc, bid) => (bid.score > 0 && (acc === null || bid.score > acc.score) ? bid : acc),
    null,
  );
  return {
    seats: engine.seats.map((seatRow, seat) => ({
      seatIndex: seat,
      // 座位 → 座位令牌(修复 1:与信封 players 同一公开标识体系;原来的
      // participantHash 是身份凭证,绝不进任何对外载荷)。客户端靠它把座位号
      // 对回昵称——中途离席后信封的「在座行序 ≠ 座位序」(离席行保留、座位
      // 开局即固定),没有这个字段客户端只能按行序猜,会把别人的昵称挂错座位。
      seatToken: seatRow.seatToken,
      handCount: engine.hands[seat]?.length ?? 0,
      isLandlord: engine.landlordSeat === seat,
      isBidTurn: engine.phase === "bidding" && engine.bidTurn === seat && engine.outcome === null,
      resigned: engine.resignedSeats.includes(seat),
      playedCount: engine.playCounts[seat] ?? 0,
    })),
    // 私有视图纪律:只有自己的手牌,绝没有别人的牌面。
    hand: viewerSeat !== null ? [...(engine.hands[viewerSeat] ?? [])] : [],
    bottomCount: engine.bottomCards.length,
    bottomCards: landlordDecided ? [...engine.bottomCards] : null,
    phase: engine.phase,
    bidTurn: engine.bidTurn,
    bids: engine.bids.map((bid) => ({ ...bid })),
    currentBid: currentBid ? { ...currentBid } : null,
    landlordSeat: engine.landlordSeat,
    bidScore: engine.bidScore,
    currentTurn: engine.currentTurn,
    lastPlay: engine.lastPlay
      ? { seatIndex: engine.lastPlay.seatIndex, cards: [...engine.lastPlay.cards], type: engine.lastPlay.shape.type }
      : null,
    /** 跟牌才能过;自由出必须出牌(客户端据此裁剪「过」按钮)。 */
    canPass: engine.phase === "playing" && engine.lastPlay !== null && engine.outcome === null,
    bombCount: engine.bombCount,
    /** 当前倍数拆解(春天倍数只在结算时落定,进行中对局恒 1)。 */
    multiplier: { base: engine.rules.baseScore, bid: engine.bidScore, bombs: engine.bombCount, spring: 1 },
    history: engine.history.map((record) => ({ ...record })),
    events: [...engine.events],
    outcome: engine.outcome,
    redealCount: engine.redealCount,
    yourSeat: viewerSeat,
  };
}

// ---------------------------------------------------------------------------
// 动作实现
// ---------------------------------------------------------------------------

/** 叫分:0 = 不叫,1..3 = 叫分(必须严格高于当前最高分);每人恰一次。 */
function applyBid(
  state: GameRoomState,
  engine: DoudizhuEngineState,
  seatIndex: number,
  score: number,
  actionId: string,
): EngineOutcome {
  if (engine.phase !== "bidding") return failure("invalid_action", "叫分阶段已结束");
  if (engine.outcome !== null) return failure("game_over", "对局已结束");
  if (engine.bidTurn !== seatIndex) return failure("not_your_turn", "还没轮到你叫分");
  if (engine.bidActedSeats.includes(seatIndex)) return failure("invalid_action", "你已经叫过分了");
  if (!Number.isInteger(score) || score < 0 || score > 3) {
    return failure("illegal_move", "payload 必须是 { score: 0..3 }(0 = 不叫)");
  }
  const currentBid = engine.bids.reduce<DoudizhuBidRecord | null>(
    (acc, bid) => (bid.score > 0 && (acc === null || bid.score > acc.score) ? bid : acc),
    null,
  );
  if (score > 0 && currentBid !== null && score <= currentBid.score) {
    return failure("illegal_move", `叫分必须高于当前最高分(${currentBid.score} 分)`);
  }
  const seat = engine.seats[seatIndex];
  if (!seat) return failure("internal_error", "座位缺失");
  const label = seatLabel(state, seatIndex);
  const record: DoudizhuPlayRecord = {
    ply: engine.history.length + 1,
    seatIndex,
    kind: "bid",
    score,
    text: score === 0 ? `${label} 不叫` : `${label} 叫 ${score} 分`,
  };
  const bids = score > 0 ? [...engine.bids, { seatIndex, score }] : engine.bids;
  let next: DoudizhuEngineState = {
    ...engine,
    bids,
    bidActedSeats: [...engine.bidActedSeats, seatIndex],
    history: [...engine.history, record],
    actionIds: trackActionId(engine.actionIds, actionId),
  };
  // 轮转到下一个未叫分且未认输的座位(-1 = 全部已处理,交给 resolveBidding)。
  const nextBidder = nextBidSeat(next, seatIndex);
  next = nextBidder >= 0 ? { ...next, bidTurn: nextBidder } : next;
  next = resolveBidding(state, next);
  return success({ ...state, engineState: next, deadlineAt: Date.now() + next.rules.turnMs });
}

/** 出牌:校验手牌持有 + 牌型合法 + 压过上一手(自由出任意合法牌型)。 */
function applyPlay(
  state: GameRoomState,
  engine: DoudizhuEngineState,
  seatIndex: number,
  cards: unknown,
  actionId: string,
): EngineOutcome {
  if (engine.phase !== "playing") return failure("invalid_action", "对局还在叫分阶段");
  if (engine.outcome !== null) return failure("game_over", "对局已结束");
  if (engine.currentTurn !== seatIndex) return failure("not_your_turn", "还没轮到你出牌");
  if (!Array.isArray(cards) || cards.length === 0 || cards.some((card) => typeof card !== "string")) {
    return failure("illegal_move", "payload 必须是 { cards: string[] }");
  }
  const unique = new Set(cards as string[]);
  if (unique.size !== cards.length) return failure("illegal_move", "出牌里重复了同一张牌");
  const hand = engine.hands[seatIndex] ?? [];
  const handSet = new Set(hand);
  for (const card of cards as string[]) {
    if (!handSet.has(card)) return failure("illegal_move", `手里没有这张牌:${doudizhuCardLabel(card)}`);
  }
  const shape = classifyDoudizhuPlay(cards as string[]);
  if (shape === null) return failure("illegal_move", "不是合法的斗地主牌型");
  if (!beatsDoudizhuPlay(shape, engine.lastPlay?.shape ?? null)) {
    return failure("illegal_move", engine.lastPlay === null ? "牌型不合法" : "压不过上一手,换一手或过牌");
  }

  const seat = engine.seats[seatIndex];
  if (!seat) return failure("internal_error", "座位缺失");
  const label = seatLabel(state, seatIndex);
  const playCards = sortDoudizhuHand(cards as string[]);
  const record: DoudizhuPlayRecord = {
    ply: engine.history.length + 1,
    seatIndex,
    kind: "play",
    cards: playCards,
    playType: shape.type,
    text: `${label} 出 ${DOU_DIZHU_TYPE_LABELS[shape.type]} ${playCards.map((card) => doudizhuCardLabel(card)).join(" ")}`,
  };

  const handCodes = new Set(playCards);
  const hands = engine.hands.map((item, idx) =>
    idx === seatIndex ? item.filter((card) => !handCodes.has(card)) : item,
  );
  const playCounts = engine.playCounts.map((count, idx) => (idx === seatIndex ? count + 1 : count));
  const isBomb = shape.type === "bomb" || shape.type === "rocket";
  const bombCount = engine.bombCount + (isBomb ? 1 : 0);

  let next: DoudizhuEngineState = {
    ...engine,
    hands,
    playCounts,
    bombCount,
    lastPlay: { seatIndex, shape, cards: playCards },
    passStreak: 0,
    history: [...engine.history, record],
    actionIds: trackActionId(engine.actionIds, actionId),
    events: isBomb
      ? pushEvent(engine.events, {
          ply: record.ply,
          seatIndex,
          kind: "bomb",
          text: `${label} 打出${DOU_DIZHU_TYPE_LABELS[shape.type]},倍数翻倍!`,
        })
      : engine.events,
  };

  // 出完即胜:春天/反春天在此判定(需要对手的出牌计数,此刻是终局时刻)。
  if (hands[seatIndex]!.length === 0) {
    const landlord = engine.landlordSeat ?? -1;
    const winnerSide = seatIndex === landlord ? ("landlord" as const) : ("farmers" as const);
    const farmers = [0, 1, 2].filter((idx) => idx !== landlord);
    const spring: DoudizhuOutcome["spring"] =
      winnerSide === "landlord" && farmers.every((idx) => (playCounts[idx] ?? 0) === 0)
        ? "spring"
        : winnerSide === "farmers" && (playCounts[landlord] ?? 0) === 1
          ? "anti_spring"
          : "none";
    const springText =
      spring === "spring"
        ? "春天!农民一张都没出过,倍数再翻倍"
        : spring === "anti_spring"
          ? "反春天!地主只出过第一手,倍数再翻倍"
          : "";
    next = {
      ...next,
      outcome: { result: "win", winnerSeat: seatIndex, winnerSide, reason: "playout", spring },
      events: pushEvent(next.events, {
        ply: record.ply,
        seatIndex,
        kind: spring === "none" ? "win" : "spring",
        text: `${label} 手牌出完,${winnerSide === "landlord" ? "地主" : "农民方"}获胜!${springText}`,
      }),
    };
    return success({ ...state, engineState: next, deadlineAt: null });
  }

  next = { ...next, currentTurn: nextActiveSeat(next, seatIndex) };
  return success({ ...state, engineState: next, deadlineAt: Date.now() + next.rules.turnMs });
}

/** 过牌:只有跟牌能过;连续两家过 → 出牌方新一轮自由出。 */
function applyPass(
  state: GameRoomState,
  engine: DoudizhuEngineState,
  seatIndex: number,
  actionId: string,
): EngineOutcome {
  if (engine.phase !== "playing") return failure("invalid_action", "对局还在叫分阶段");
  if (engine.outcome !== null) return failure("game_over", "对局已结束");
  if (engine.currentTurn !== seatIndex) return failure("not_your_turn", "还没轮到你出牌");
  if (engine.lastPlay === null) return failure("invalid_action", "自由出牌不能过,请出牌");
  const label = seatLabel(state, seatIndex);
  const record: DoudizhuPlayRecord = {
    ply: engine.history.length + 1,
    seatIndex,
    kind: "pass",
    text: `${label} 过牌`,
  };
  const passStreak = engine.passStreak + 1;
  let next: DoudizhuEngineState = {
    ...engine,
    passStreak,
    history: [...engine.history, record],
    actionIds: trackActionId(engine.actionIds, actionId),
  };
  if (passStreak >= SEAT_COUNT - 1) {
    // 连续两家过:回到出牌方,新一轮自由出(出牌方已认输则交给其后有效座位)。
    const leader = engine.lastPlay.seatIndex;
    next = { ...next, lastPlay: null, passStreak: 0, currentTurn: activeSeatOrNext(next, leader) };
  } else {
    next = { ...next, currentTurn: nextActiveSeat(next, seatIndex) };
  }
  return success({ ...state, engineState: next, deadlineAt: Date.now() + next.rules.turnMs });
}

/**
 * 认输(DO 离席路径自动以 resign 调用):叫分阶段视为不叫;出牌阶段其回合
 * 永久跳过。在座未认输者不足 2 人 → 终局中止(不计分)。
 */
function applyResign(
  state: GameRoomState,
  engine: DoudizhuEngineState,
  seatIndex: number,
  actionId: string,
): EngineOutcome {
  const seat = engine.seats[seatIndex];
  if (!seat) return failure("internal_error", "座位缺失");
  const label = seatLabel(state, seatIndex);
  let next: DoudizhuEngineState = {
    ...engine,
    resignedSeats: engine.resignedSeats.includes(seatIndex)
      ? engine.resignedSeats
      : [...engine.resignedSeats, seatIndex],
    actionIds: trackActionId(engine.actionIds, actionId),
    events: pushEvent(engine.events, {
      ply: engine.history.length,
      seatIndex,
      kind: "resign",
      text: `${label} 认输,退出对局`,
    }),
  };

  // 叫分阶段的认输者视为不叫:若还没轮到他,把他标记已叫(不叫),否则按正常
  // 叫分 0 处理,保证叫分轮不会卡在这个座位上。
  if (engine.phase === "bidding" && engine.outcome === null && !engine.bidActedSeats.includes(seatIndex)) {
    const record: DoudizhuPlayRecord = {
      ply: next.history.length + 1,
      seatIndex,
      kind: "bid",
      score: 0,
      text: `${label} 不叫(认输)`,
    };
    next = {
      ...next,
      bidActedSeats: [...next.bidActedSeats, seatIndex],
      history: [...next.history, record],
    };
    if (next.bidTurn === seatIndex) {
      const nextBidder = nextBidSeat(next, seatIndex);
      next = nextBidder >= 0 ? { ...next, bidTurn: nextBidder } : next;
    }
    next = resolveBidding(state, next);
  }

  const active = next.seats.map((_, idx) => idx).filter((idx) => !next.resignedSeats.includes(idx));
  if (active.length <= 1) {
    // 在座未认输者不足 2 人:终局中止,不计分(斗地主的计分以地主/农民方为
    // 单位,凑不成对局的中止局没有计分主体)。
    next = {
      ...next,
      outcome: { result: "aborted", winnerSeat: null, winnerSide: null, reason: "resign", spring: "none" },
      events: pushEvent(next.events, {
        ply: next.history.length,
        seatIndex: null,
        kind: "resign",
        text: "在座玩家不足两人,对局中止",
      }),
    };
    return success({ ...state, engineState: next, deadlineAt: null });
  }

  // 出牌阶段认输者正执回合:按过牌语义推进(自由出则直接轮转,不产生过牌记录)。
  if (next.phase === "playing" && next.outcome === null && next.currentTurn === seatIndex) {
    if (next.lastPlay !== null) {
      const passStreak = next.passStreak + 1;
      if (passStreak >= SEAT_COUNT - 1) {
        const leader = next.lastPlay.seatIndex;
        next = { ...next, lastPlay: null, passStreak: 0, currentTurn: activeSeatOrNext(next, leader) };
      } else {
        next = { ...next, passStreak, currentTurn: nextActiveSeat(next, seatIndex) };
      }
    } else {
      next = { ...next, currentTurn: nextActiveSeat(next, seatIndex) };
    }
  }
  return success({ ...state, engineState: next, deadlineAt: next.outcome ? null : Date.now() + next.rules.turnMs });
}

// ---------------------------------------------------------------------------
// 引擎实现
// ---------------------------------------------------------------------------

export const doudizhuEngine: MultiplayerGameEngine = {
  gameType: "doudizhu",
  label: "斗地主",
  meta: {
    displayName: "斗地主",
    description: "3 人开局:叫分抢地主、底牌公开、炸弹王炸翻倍、春天反春天;积分制对战。",
    minPlayers: 3,
    maxPlayers: 3,
  } satisfies GameEngineMeta,

  createRoom(state, config): EngineOutcome {
    const rules = readRules(config);
    if (!rules) {
      return failure("invalid_action", "config 非法:turnMs 5s–10min,baseScore 1–99");
    }
    // 初始种子由 DO 注入的 rngNonce + roomId 派生(修复 2,与 ludo 同一纪律):
    // roomId 是公开值(深链接即可得),只由它派生种子等于任何人都可离线复现
    // 整局发牌;建房 config 原样透传,这里不收外部种子。rngNonce 由 DO 建房时
    // 随机铸造、只存 DO storage,绝不进任何对外载荷。重发时种子前进。
    const rngSeed = hashSeed(`${state.roomId}:${state.rngNonce}`);
    const engine = syncSeats(
      {
        seats: [],
        hands: [],
        bottomCards: [],
        phase: "bidding",
        bidTurn: 0,
        bidActedSeats: [],
        bids: [],
        landlordSeat: null,
        bidScore: 0,
        currentTurn: 0,
        lastPlay: null,
        passStreak: 0,
        playCounts: [0, 0, 0],
        bombCount: 0,
        resignedSeats: [],
        history: [],
        events: [],
        outcome: null,
        rngSeed,
        redealCount: 0,
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
    if (activePlayers(state).length >= SEAT_COUNT) {
      return failure("invalid_action", "房间已满(斗地主恰好三人)");
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
    if (active.length < SEAT_COUNT) return failure("invalid_action", "斗地主需要三名玩家才能开局");
    if (active.length > SEAT_COUNT) return failure("invalid_action", "斗地主恰好三人,房间异常");
    if (!active.every((player) => player.ready)) return failure("invalid_action", "全员准备后才能开局");

    // 开局即发牌:座位按在座顺序固定 3 席,叫分从座位 0 开始。
    const seats = active.map((player) => ({
      participantHash: player.participantHash,
      seatToken: player.seatToken,
    }));
    const dealt = dealHands(engine.rngSeed);
    const next: DoudizhuEngineState = {
      ...engine,
      seats,
      hands: dealt.hands,
      bottomCards: dealt.bottomCards,
      phase: "bidding",
      bidTurn: 0,
      bidActedSeats: [],
      bids: [],
      landlordSeat: null,
      bidScore: 0,
      currentTurn: 0,
      lastPlay: null,
      passStreak: 0,
      playCounts: [0, 0, 0],
      bombCount: 0,
      resignedSeats: [],
      history: [],
      events: [],
      outcome: null,
      rngSeed: dealt.seed,
      redealCount: 0,
    };
    return success({ ...state, status: "playing", engineState: next, deadlineAt: Date.now() + engine.rules.turnMs });
  },

  applyAction(state, action): EngineOutcome {
    const engine = readEngineState(state);
    if (!engine) return failure("internal_error", "房间引擎状态未初始化");
    if (!findActivePlayer(state, action.participantHash)) {
      return failure("not_a_player", "你还不是本房间玩家");
    }
    // 防御性幂等:权威去重表在 DO storage;这里兜直连/异常路径。重放同一
    // 动作(含炸弹翻倍)到这里会被拒,倍数不可能翻第二次。
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
    // 认输/离席座位永久退出对局:叫分/出牌/过牌一律拒绝,重复认输同码拒绝。
    // 否则他们可经「两家过 → 回到出牌方」或重发路径重新拿到回合甚至赢下对局,
    // 与引擎自述「其回合永久跳过」矛盾。
    if (engine.resignedSeats.includes(seatIndex)) {
      return failure("invalid_action", "你已认输退出对局");
    }

    const payload = (action.payload ?? {}) as Record<string, unknown>;
    switch (action.action) {
      case "bid": {
        const score = payload.score;
        if (typeof score !== "number") return failure("illegal_move", "payload 必须是 { score: 0..3 }");
        return applyBid(state, engine, seatIndex, score, action.actionId);
      }
      case "play": {
        return applyPlay(state, engine, seatIndex, payload.cards, action.actionId);
      }
      case "pass": {
        return applyPass(state, engine, seatIndex, action.actionId);
      }
      case "resign": {
        return applyResign(state, engine, seatIndex, action.actionId);
      }
      default:
        return failure("illegal_move", `未知动作 ${action.action}`);
    }
  },

  /** 私有视图:只发自己的手牌;其他人只有张数;底牌地主确定后公开。 */
  getPlayerView(state, participantHash): { view: unknown } {
    const engine = readEngineState(state);
    if (!engine) return { view: null };
    const seatIndex = engine.seats.findIndex((seat) => seat.participantHash === participantHash);
    return { view: viewPayload(state, engine, seatIndex >= 0 ? seatIndex : null) };
  },

  /** 公开视图:同样走裁剪路径,viewerSeat = null(无任何手牌牌面)。 */
  getPublicView(state): { view: unknown } {
    const engine = readEngineState(state);
    return { view: engine ? viewPayload(state, engine, null) : null };
  },

  checkGameOver(state): boolean {
    const engine = readEngineState(state);
    return engine !== null && engine.outcome !== null;
  },

  settle(state): GameSettlement {
    const engine = readEngineState(state);
    const outcome = engine?.outcome ?? null;
    const landlordSeat = engine?.landlordSeat ?? null;
    // 计分只用纯函数拆解:同一状态重复结算(幂等)结果恒等。
    const breakdown =
      engine && outcome && outcome.result === "win" && landlordSeat !== null && outcome.winnerSide !== null
        ? doudizhuScoreBreakdown(engine.rules, engine.bidScore, engine.bombCount, outcome.spring)
        : null;
    const deltas =
      breakdown && landlordSeat !== null && outcome?.winnerSide
        ? doudizhuDeltas(breakdown, landlordSeat, outcome.winnerSide)
        : [0, 0, 0];
    return {
      result: outcome?.result ?? "aborted",
      // 结算快照进视图对全房可见(含观战):一律用座位令牌对位(修复 1)。
      winnerSeatToken:
        outcome?.winnerSeat !== undefined && outcome?.winnerSeat !== null
          ? (engine?.seats[outcome.winnerSeat]?.seatToken ?? null)
          : null,
      summary: {
        reason: outcome?.reason ?? null,
        landlordSeat,
        bidScore: engine?.bidScore ?? 0,
        bombCount: engine?.bombCount ?? 0,
        spring: outcome?.spring ?? "none",
        score: breakdown,
        deltas,
        redealCount: engine?.redealCount ?? 0,
        // 终局亮牌:三家的手牌与底牌进结算快照(公开战果,回放需要)。
        hands: engine?.hands.map((hand) => [...hand]) ?? [],
        bottomCards: engine?.bottomCards ?? [],
        history: engine?.history ?? [],
        events: engine?.events ?? [],
        // 显式投影:引擎座位行还持有 participantHash(服务端内部映射用),
        // 展开对象会把它带进快照,必须逐字段挑。
        seats: engine?.seats.map((seat) => ({ seatToken: seat.seatToken })) ?? [],
      },
      settledAt: new Date().toISOString(),
      version: state.version,
    };
  },

  /**
   * 超时兜底(对局不卡死):叫分视为不叫;出牌自由出自动出最小单张(点数
   * 最小的一张,双王最大不在此列——小王点数 16 大于所有数牌,只有手里只剩
   * 王时才会出王);跟牌自动过。已认输/离席的座位绝不代打:叫分自动跳过、
   * 出牌只推进回合——否则 alarm 会一轮轮替离席者把牌出完,把他结算成胜者
   * (DO 离席路径:先 resign 再置 leftAt,本人已收 not_a_player,只剩 alarm
   * 能碰到他的手牌)。
   */
  handleTimeout(state, now): EngineOutcome {
    if (state.status !== "playing") return failure("invalid_action", "对局不在进行中");
    const engine = readEngineState(state);
    if (!engine) return failure("internal_error", "房间引擎状态未初始化");
    if (state.deadlineAt === null) return failure("invalid_action", "当前没有进行中的回合倒计时");
    if (now < state.deadlineAt) return failure("invalid_action", "尚未到超时时间");
    if (engine.outcome !== null) return failure("game_over", "对局已结束");

    if (engine.phase === "bidding") {
      const seatIndex = engine.bidTurn;
      const resigned = engine.resignedSeats.includes(seatIndex);
      const record: DoudizhuPlayRecord = {
        ply: engine.history.length + 1,
        seatIndex,
        kind: "bid",
        score: 0,
        text: resigned
          ? `${seatLabel(state, seatIndex)} 已认输,跳过叫分`
          : `${seatLabel(state, seatIndex)} 超时,视为不叫`,
      };
      let next: DoudizhuEngineState = {
        ...engine,
        bidActedSeats: [...engine.bidActedSeats, seatIndex],
        history: [...engine.history, record],
        events: pushEvent(engine.events, {
          ply: record.ply,
          seatIndex,
          kind: "timeout",
          text: record.text,
        }),
      };
      const nextBidder = nextBidSeat(next, seatIndex);
      next = nextBidder >= 0 ? { ...next, bidTurn: nextBidder } : next;
      next = resolveBidding(state, next);
      return success({ ...state, engineState: next, deadlineAt: now + next.rules.turnMs });
    }

    const seatIndex = engine.currentTurn;
    const label = seatLabel(state, seatIndex);
    // 防御位:轮转不变量保证 currentTurn 不会落在已认输座位上(applyPass /
    // applyResign / handleTimeout 的 leader 恢复都经 activeSeatOrNext 过滤);
    // 这里兜住历史脏数据/直连异常,只推进回合,绝不代打出牌。
    if (engine.resignedSeats.includes(seatIndex)) {
      const skipped: DoudizhuEngineState = {
        ...engine,
        passStreak: engine.lastPlay !== null ? engine.passStreak + 1 : engine.passStreak,
        lastPlay: engine.lastPlay,
        history: [
          ...engine.history,
          { ply: engine.history.length + 1, seatIndex, kind: "pass", text: `${label} 已认输,跳过其回合` },
        ],
        events: pushEvent(engine.events, {
          ply: engine.history.length + 1,
          seatIndex,
          kind: "timeout",
          text: `${label} 已认输,跳过其回合`,
        }),
      };
      if (engine.lastPlay !== null && skipped.passStreak >= SEAT_COUNT - 1) {
        const leader = engine.lastPlay.seatIndex;
        return success({
          ...state,
          engineState: { ...skipped, lastPlay: null, passStreak: 0, currentTurn: activeSeatOrNext(skipped, leader) },
          deadlineAt: now + engine.rules.turnMs,
        });
      }
      return success({
        ...state,
        engineState: { ...skipped, currentTurn: nextActiveSeat(skipped, seatIndex) },
        deadlineAt: now + engine.rules.turnMs,
      });
    }
    if (engine.lastPlay === null) {
      // 自由出:自动出点数最小的单张(手牌已按点数降序,末尾即最小)。
      const hand = engine.hands[seatIndex] ?? [];
      const card = hand[hand.length - 1];
      if (card === undefined) return failure("internal_error", "手牌为空,无法自动出牌");
      const outcome = applyPlay(state, { ...engine }, seatIndex, [card], `timeout:${state.version}:${now}`);
      if (!outcome.ok) return outcome;
      const nextEngine = outcome.state.engineState as DoudizhuEngineState;
      return success({
        ...outcome.state,
        engineState: {
          ...nextEngine,
          events: pushEvent(nextEngine.events, {
            ply: engine.history.length + 1,
            seatIndex,
            kind: "timeout",
            text: `${label} 出牌超时,自动出 ${doudizhuCardLabel(card)}`,
          }),
        },
        deadlineAt: now + engine.rules.turnMs,
      });
    }
    // 跟牌:自动过(过牌/新一轮推进与 applyPass 同一语义,但不落 actionIds
    // ——超时是系统代打,不走玩家动作通道)。
    const passStreak = engine.passStreak + 1;
    let next: DoudizhuEngineState = {
      ...engine,
      passStreak,
      history: [
        ...engine.history,
        { ply: engine.history.length + 1, seatIndex, kind: "pass", text: `${label} 超时,自动过牌` },
      ],
      events: pushEvent(engine.events, {
        ply: engine.history.length + 1,
        seatIndex,
        kind: "timeout",
        text: `${label} 出牌超时,自动过牌`,
      }),
    };
    if (passStreak >= SEAT_COUNT - 1) {
      const leader = engine.lastPlay.seatIndex;
      next = { ...next, lastPlay: null, passStreak: 0, currentTurn: activeSeatOrNext(next, leader) };
    } else {
      next = { ...next, currentTurn: nextActiveSeat(next, seatIndex) };
    }
    return success({ ...state, engineState: next, deadlineAt: now + engine.rules.turnMs });
  },
};
