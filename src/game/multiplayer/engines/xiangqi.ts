/**
 * 象棋多人引擎（多人玩法批次 X1）——MultiplayerGameEngine 的第二个真实实现。
 *
 * 规则与协议取舍（自写规则引擎，不引第三方棋规库——供应链与许可风险）：
 * - 9 列 × 10 行棋盘（board[row][col]，row 0 黑方底线在上、row 9 红方底线在
 *   下），红黑按入座自动分配：房主执红先手，第二位玩家执黑。
 * - 七类棋子走法全覆盖：车（直线滑行）、马（日字 + 蹩马腿）、炮（平移滑行，
 *   吃子必须隔一个炮架）、兵/卒（过河前只进、过河后可平）、象/相（田字 +
 *   塞象眼 + 不得过河）、士/仕（宫内斜一步）、将/帅（宫内直一步）。将帅照面
 *   （同列中间无子）按"任何走法不得造成照面"实现——照面等价于被将。
 * - 将军/将死/困毙判定：走子后对方无合法着法即终局——被将军为将死、未被
 *   将军为困毙，两种都判无着法方负（象棋规则：困毙是输，不是和）。
 * - 长将判和：同一局面（含行棋方）在最近窗口内第 N 次出现（N=3），且有一
 *   方连续 N 手都在将军（该方任何非将军着法即清零计数），判和——按 brief
 *   "长将判和"；无将军的单纯循环走子不判和（本引擎不实现自然限着）。
 * - 走棋历史存 engineState.moves（棋谱：from/to/吃子/是否将军/中文记谱），
 *   settle 时整体进结算快照供回放；引擎不触 D1，落盘由 DO/REST 层负责。
 *   记谱在走子当下用走子前局面生成（前/后 同线消歧需要它），随记录进视图
 *   的 history——棋谱侧栏（批次 X2）直接渲染，客户端不复刻记谱规则。
 * - 无隐藏信息：getPlayerView 双方全知，玩家视图仅多一个 yourColor；协议
 *   强制按人裁剪的路径不变，内部簿记（actionIds/positions/checkStreaks）
 *   永不进视图载荷。
 * - 回合时限默认 60s（建房 config.turnMs 可调，范围 5s–10min）：start 与
 *   每步走子后写 deadlineAt；alarm 超时由 handleTimeout 判当前行棋方负。
 * - version 与 actionId 去重的协议主人是 GameRoomDO（见 engine-types.ts）：
 *   引擎绝不 bump version；这里只做防御性校验——baseVersion 与当前 version
 *   不一致返回 stale_action、同一 actionId 再次进入引擎返回 invalid_action。
 *
 * 所有方法均为纯函数（不原地修改 state/engineState），可在 vitest 里脱离 DO
 * 直接对局；唯一的时间读取是 deadlineAt 的 Date.now()。
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
// 棋盘几何与棋子编码
// ---------------------------------------------------------------------------

/** 棋盘列数（竖线），row 0 在黑方顶端。 */
export const XIANGQI_COLS = 9;
/** 棋盘行数（横线），row 9 在红方底端。 */
export const XIANGQI_ROWS = 10;

export type XiangqiColor = "red" | "black";

/**
 * 棋子码：大写 = 红，小写 = 黑。K 将/帅、A 士/仕、E 象/相、H 马/傌、
 * R 车/車、C 炮/砲、P 兵/卒。客户端按码 + 颜色渲染汉字（见 admin
 * game-room-logic 的 XIANGQI_PIECE_CHARS）。
 */
export type XiangqiPieceCode = "K" | "A" | "E" | "H" | "R" | "C" | "P" | "k" | "a" | "e" | "h" | "r" | "c" | "p";

type Cell = XiangqiPieceCode | null;

interface Point {
  row: number;
  col: number;
}

interface XiangqiSeat {
  participantHash: string;
  /** 座位令牌（DO 座位分配处铸造）：视图/结算对位的唯一公开标识（修复 1）。 */
  seatToken: string;
  color: XiangqiColor;
}

/** 一手棋谱（回放数据源：from/to + 吃子 + 是否将军 + 中文记谱）。 */
export interface XiangqiMoveRecord {
  /** 全局手数（1 起）。 */
  ply: number;
  color: XiangqiColor;
  from: Point;
  to: Point;
  /** 走动前 from 处的棋子码。 */
  piece: XiangqiPieceCode;
  /** 被吃棋子码（无吃子为 null）。 */
  captured: XiangqiPieceCode | null;
  /** 行棋方座位令牌（随棋谱进视图/结算，公开标识；participantHash 绝不外发）。 */
  seatToken: string;
  /** 该手是否使对方被将军。 */
  givesCheck: boolean;
  /** 中文记谱（如「炮二平五」「前車退一」），走子当下用走子前局面生成。 */
  notation: string;
}

export type XiangqiResult = "win" | "draw" | "timeout" | "resign" | "aborted";

interface XiangqiOutcome {
  result: XiangqiResult;
  /** 胜者座位令牌（进视图与结算，公开标识）。 */
  winnerSeatToken: string | null;
  /** 终局原因：checkmate 将死 / stalemate 困毙 / perpetual_check 长将 / resign / timeout / aborted。 */
  reason: string | null;
}

/** 引擎私有状态（DO 不解释，只有本引擎读写）。 */
interface XiangqiEngineState {
  board: Cell[][];
  seats: XiangqiSeat[];
  turn: XiangqiColor;
  moves: XiangqiMoveRecord[];
  outcome: XiangqiOutcome | null;
  /** 待对方同意的和棋申请（申请人座位令牌——随公开视图下发，不能存哈希）。 */
  pendingDrawFrom: string | null;
  /** 最近处理过的 actionId（有界）——协议权威去重表在 DO storage。 */
  actionIds: string[];
  /** 每步时限（ms），开局时写进 deadlineAt。 */
  turnMs: number;
  /** 每手之后的局面键（board+turn 序列化），长将重复判定用（含开局初盘）。 */
  positions: string[];
  /** 各方连续将军计数：该方任何非将军着法清零（长将判定用）。 */
  checkStreaks: Record<XiangqiColor, number>;
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const DEFAULT_TURN_MS = 60_000;
const MIN_TURN_MS = 5_000;
const MAX_TURN_MS = 10 * 60_000;
/** 引擎侧 actionId 去重窗口：权威去重表在 DO storage，这里只留最近若干条兜底。 */
const MAX_TRACKED_ACTION_IDS = 64;
/** 长将判和的重复局面次数 N：同一局面（含行棋方）第 3 次出现即触发复核。 */
const PERPETUAL_REPEATS = 3;
/** 重复局面计数的回看窗口（手数）："连续"以近期窗口近似，窗口内 3 次即算。 */
const REPEAT_WINDOW_PLIES = 24;

/** 九宫：列 3–5；黑宫 row 0–2，红宫 row 7–9。 */
function inPalace(color: XiangqiColor, row: number, col: number): boolean {
  if (col < 3 || col > 5) return false;
  return color === "black" ? row >= 0 && row <= 2 : row >= 7 && row <= 9;
}

/** 象/士活动半场：黑 row 0–4，红 row 5–9（象不得过河）。 */
function inOwnHalf(color: XiangqiColor, row: number): boolean {
  return color === "black" ? row <= 4 : row >= 5;
}

// ---------------------------------------------------------------------------
// 纯函数辅助
// ---------------------------------------------------------------------------

function failure(code: GameProtocolErrorCode, message: string): EngineOutcome {
  return { ok: false, error: { code, message } };
}

function success(state: GameRoomState): EngineOutcome {
  return { ok: true, state };
}

function readEngineState(state: GameRoomState): XiangqiEngineState | null {
  const value = state.engineState;
  return value !== null && typeof value === "object" ? (value as XiangqiEngineState) : null;
}

function withEngine(state: GameRoomState, engine: XiangqiEngineState): GameRoomState {
  return { ...state, engineState: engine };
}

function activePlayers(state: GameRoomState): GameRoomPlayer[] {
  return state.players.filter((player) => player.leftAt === null);
}

function findActivePlayer(state: GameRoomState, participantHash: string): GameRoomPlayer | null {
  return state.players.find((player) => player.participantHash === participantHash && player.leftAt === null) ?? null;
}

function seatOf(engine: XiangqiEngineState, participantHash: string): XiangqiSeat | null {
  return engine.seats.find((seat) => seat.participantHash === participantHash) ?? null;
}

function seatByColor(engine: XiangqiEngineState, color: XiangqiColor): XiangqiSeat | null {
  return engine.seats.find((seat) => seat.color === color) ?? null;
}

/** 座位对应玩家仍在座（未 leftAt）才算有效对手。 */
function activeSeatByColor(state: GameRoomState, engine: XiangqiEngineState, color: XiangqiColor): XiangqiSeat | null {
  const seat = seatByColor(engine, color);
  if (!seat) return null;
  return findActivePlayer(state, seat.participantHash) ? seat : null;
}

function opponentColor(color: XiangqiColor): XiangqiColor {
  return color === "red" ? "black" : "red";
}

function trackActionId(actionIds: string[], actionId: string): string[] {
  return [...actionIds, actionId].slice(-MAX_TRACKED_ACTION_IDS);
}

function inBounds(row: number, col: number): boolean {
  return row >= 0 && row < XIANGQI_ROWS && col >= 0 && col < XIANGQI_COLS;
}

function isRedPiece(piece: Cell): boolean {
  return piece !== null && piece === piece.toUpperCase();
}

function pieceColor(piece: XiangqiPieceCode): XiangqiColor {
  return piece === piece.toUpperCase() ? "red" : "black";
}

/** 建房 config.turnMs 校验：缺省用默认值，非法返回 null（invalid_action）。 */
function readTurnMs(config: Record<string, unknown>): number | null {
  const value = config.turnMs;
  if (value === undefined) return DEFAULT_TURN_MS;
  if (typeof value !== "number" || !Number.isFinite(value) || value < MIN_TURN_MS || value > MAX_TURN_MS) return null;
  return Math.round(value);
}

// ---------------------------------------------------------------------------
// 初始局面
// ---------------------------------------------------------------------------

/** 标准开局：黑底线 r0、黑卒 r3 偶列、黑炮 r2 的 1/7 列，红侧镜像。 */
function initialBoard(): Cell[][] {
  const backRow: XiangqiPieceCode[] = ["r", "h", "e", "a", "k", "a", "e", "h", "r"];
  const board: Cell[][] = Array.from({ length: XIANGQI_ROWS }, () => Array<Cell>(XIANGQI_COLS).fill(null));
  board[0] = [...backRow];
  for (const col of [1, 7]) board[2]![col] = "c";
  for (const col of [0, 2, 4, 6, 8]) board[3]![col] = "p";
  for (const col of [0, 2, 4, 6, 8]) board[6]![col] = "P";
  for (const col of [1, 7]) board[7]![col] = "C";
  board[9] = backRow.map((piece) => piece.toUpperCase() as XiangqiPieceCode);
  return board;
}

// ---------------------------------------------------------------------------
// 走法生成（伪合法：不考虑走后被将；合法性在 tryMove 里统一复核）
// ---------------------------------------------------------------------------

const ORTHOGONAL = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
] as const;
const DIAGONAL = [
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
] as const;
/** 马的 8 个日字目标 + 腿的相对偏移（|dr|=2 时腿在 (±1,0)，|dc|=2 时腿在 (0,±1)）。 */
const HORSE_OFFSETS = [
  { dr: -2, dc: -1, lr: -1, lc: 0 },
  { dr: -2, dc: 1, lr: -1, lc: 0 },
  { dr: 2, dc: -1, lr: 1, lc: 0 },
  { dr: 2, dc: 1, lr: 1, lc: 0 },
  { dr: -1, dc: -2, lr: 0, lc: -1 },
  { dr: -1, dc: 2, lr: 0, lc: 1 },
  { dr: 1, dc: -2, lr: 0, lc: -1 },
  { dr: 1, dc: 2, lr: 0, lc: 1 },
] as const;

/**
 * from 处棋子的伪合法落点（含吃子落点）。炮分两段：无炮架时平移到空格，
 * 越过一个炮架后第一个棋子是唯一可吃目标（炮架规则）。
 */
function pseudoDestinations(board: Cell[][], row: number, col: number): Point[] {
  const piece = board[row]?.[col];
  if (!piece) return [];
  const color = pieceColor(piece);
  const dests: Point[] = [];
  const push = (r: number, c: number) => {
    if (!inBounds(r, c)) return false;
    const target = board[r]![c]!;
    if (target !== null && pieceColor(target) === color) return false; // 己方棋子不可落
    dests.push({ row: r, col: c });
    return target === null; // 空格可继续延伸，吃子即止
  };

  const upper = piece.toUpperCase() as "K" | "A" | "E" | "H" | "R" | "C" | "P";
  switch (upper) {
    case "R": {
      for (const [dr, dc] of ORTHOGONAL) {
        let r = row + dr;
        let c = col + dc;
        while (push(r, c)) {
          r += dr!;
          c += dc!;
        }
      }
      break;
    }
    case "C": {
      for (const [dr, dc] of ORTHOGONAL) {
        let r = row + dr;
        let c = col + dc;
        // 第一段：平移（只落空格）
        while (inBounds(r, c) && board[r]![c] === null) {
          dests.push({ row: r, col: c });
          r += dr!;
          c += dc!;
        }
        // 第二段：跳过炮架后的第一个棋子是唯一可吃目标
        let screen = false;
        while (inBounds(r, c)) {
          if (screen) {
            const target = board[r]![c]!;
            if (target !== null) {
              if (pieceColor(target) !== color) dests.push({ row: r, col: c });
              break;
            }
          } else if (board[r]![c] !== null) {
            screen = true;
          }
          r += dr!;
          c += dc!;
        }
      }
      break;
    }
    case "H": {
      for (const { dr, dc, lr, lc } of HORSE_OFFSETS) {
        // 蹩马腿：马腿（与马正交相邻、朝目标方向一格）有子即不能走
        if (board[row + lr]?.[col + lc]) continue;
        const r = row + dr;
        const c = col + dc;
        if (!inBounds(r, c)) continue;
        const target = board[r]![c]!;
        if (target === null || pieceColor(target) !== color) dests.push({ row: r, col: c });
      }
      break;
    }
    case "E": {
      for (const [dr, dc] of DIAGONAL) {
        const r = row + dr! * 2;
        const c = col + dc! * 2;
        if (!inBounds(r, c)) continue;
        if (!inOwnHalf(color, r)) continue; // 象不得过河
        // 塞象眼：田字中心的斜邻格有子即不能走
        if (board[row + dr!]![col + dc!] !== null) continue;
        const target = board[r]![c]!;
        if (target === null || pieceColor(target) !== color) dests.push({ row: r, col: c });
      }
      break;
    }
    case "A": {
      for (const [dr, dc] of DIAGONAL) {
        const r = row + dr!;
        const c = col + dc!;
        if (!inPalace(color, r, c)) continue;
        const target = board[r]![c]!;
        if (target === null || pieceColor(target) !== color) dests.push({ row: r, col: c });
      }
      break;
    }
    case "K": {
      for (const [dr, dc] of ORTHOGONAL) {
        const r = row + dr!;
        const c = col + dc!;
        if (!inPalace(color, r, c)) continue;
        const target = board[r]![c]!;
        if (target === null || pieceColor(target) !== color) dests.push({ row: r, col: c });
      }
      break;
    }
    case "P": {
      // 兵/卒：红进为 row-1、黑进为 row+1；过河后可平移，永不后退。
      const forward = color === "red" ? -1 : 1;
      push(row + forward, col);
      const crossed = color === "red" ? row <= 4 : row >= 5;
      if (crossed) {
        push(row, col - 1);
        push(row, col + 1);
      }
      break;
    }
  }
  return dests;
}

/** 在副本上执行走子（吃子即替换）；同行横走时同一行既清起点也落终点。 */
function boardAfter(board: Cell[][], from: Point, to: Point): Cell[][] {
  const piece = board[from.row]![from.col]!;
  return board.map((line, r) => {
    if (r === from.row && r === to.row) {
      return line.map((cell, c) => (c === from.col ? null : c === to.col ? piece : cell));
    }
    if (r === from.row) return line.map((cell, c) => (c === from.col ? null : cell));
    if (r === to.row) return line.map((cell, c) => (c === to.col ? piece : cell));
    return line;
  });
}

function findKing(board: Cell[][], color: XiangqiColor): Point | null {
  const king = color === "red" ? "K" : "k";
  for (let row = 0; row < XIANGQI_ROWS; row += 1) {
    for (let col = 0; col < XIANGQI_COLS; col += 1) {
      if (board[row]![col] === king) return { row, col };
    }
  }
  return null;
}

/** (r,c) 是否被 byColor 的任意棋子攻击（吃子语义 = 走法语义，炮经炮架）。 */
function isSquareAttacked(board: Cell[][], row: number, col: number, byColor: XiangqiColor): boolean {
  for (let r = 0; r < XIANGQI_ROWS; r += 1) {
    for (let c = 0; c < XIANGQI_COLS; c += 1) {
      const piece = board[r]![c]!;
      if (piece === null || pieceColor(piece) !== byColor) continue;
      if (pseudoDestinations(board, r, c).some((dest) => dest.row === row && dest.col === col)) return true;
    }
  }
  return false;
}

/** 将帅照面：同列且中间无子。 */
function kingsFacing(board: Cell[][]): boolean {
  const red = findKing(board, "red");
  const black = findKing(board, "black");
  if (!red || !black || red.col !== black.col) return false;
  const step = red.row < black.row ? 1 : -1;
  for (let row = red.row + step; row !== black.row; row += step) {
    if (board[row]![red.col] !== null) return false;
  }
  return true;
}

/** color 的将是否安全：不被攻击、不照面（任一不满足即 unsafe）。 */
function isKingSafe(board: Cell[][], color: XiangqiColor): boolean {
  const king = findKing(board, color);
  if (!king) return false;
  if (kingsFacing(board)) return false;
  return !isSquareAttacked(board, king.row, king.col, opponentColor(color));
}

/** color 是否正被将军（不含照面——照面走法本身非法，将军旗标只看攻击）。 */
function isInCheck(board: Cell[][], color: XiangqiColor): boolean {
  const king = findKing(board, color);
  return king !== null && isSquareAttacked(board, king.row, king.col, opponentColor(color));
}

/** color 是否还有至少一个合法着法（走后己方将安全）。 */
function hasAnyLegalMove(board: Cell[][], color: XiangqiColor): boolean {
  for (let row = 0; row < XIANGQI_ROWS; row += 1) {
    for (let col = 0; col < XIANGQI_COLS; col += 1) {
      const piece = board[row]![col]!;
      if (piece === null || pieceColor(piece) !== color) continue;
      for (const dest of pseudoDestinations(board, row, col)) {
        if (isKingSafe(boardAfter(board, { row, col }, dest), color)) return true;
      }
    }
  }
  return false;
}

/**
 * color 的全部合法着法（含送将复核，与 applyMove 的权威校验同判据）。
 * 批次 X2：进公开视图的 legalMoves 字段，客户端选中棋子后按 from 过滤画
 * 「可走点」提示。象棋无隐藏信息，合法着法可由公开棋盘完全推导——不构成
 * 任何私有信息泄漏；只算行棋方（提示只在该方回合用到，载荷也小）。
 */
function legalMovesFor(board: Cell[][], color: XiangqiColor): Array<{ from: Point; to: Point }> {
  const moves: Array<{ from: Point; to: Point }> = [];
  for (let row = 0; row < XIANGQI_ROWS; row += 1) {
    for (let col = 0; col < XIANGQI_COLS; col += 1) {
      const piece = board[row]![col]!;
      if (piece === null || pieceColor(piece) !== color) continue;
      for (const dest of pseudoDestinations(board, row, col)) {
        if (isKingSafe(boardAfter(board, { row, col }, dest), color)) {
          moves.push({ from: { row, col }, to: dest });
        }
      }
    }
  }
  return moves;
}

/** 局面键（棋盘 + 行棋方）：长将重复判定用。 */
function positionKey(board: Cell[][], turn: XiangqiColor): string {
  return `${turn}|${board.map((line) => line.map((cell) => cell ?? ".").join("")).join("/")}`;
}

// ---------------------------------------------------------------------------
// 中文记谱（批次 X2：棋谱侧栏的数据源；纯函数，导出供单测直测）
// ---------------------------------------------------------------------------

/** 记谱用棋子汉字（与客户端 game-room-logic 的 XIANGQI_PIECE_CHARS 同表）。 */
const NOTATION_CHARS: Record<XiangqiColor, Record<string, string>> = {
  red: { K: "帥", A: "仕", E: "相", H: "傌", R: "俥", C: "炮", P: "兵" },
  black: { K: "將", A: "士", E: "象", H: "馬", R: "車", C: "砲", P: "卒" },
};

/** 红方纵线号用中文数字（一…九），黑方用阿拉伯数字（1…9）。 */
const CN_NUMERALS = ["一", "二", "三", "四", "五", "六", "七", "八", "九"];

/**
 * 纵线号（各从己方右手数起）：红方 col 8 是一路（col 0 是九路），黑方
 * col 0 是 1 路（col 8 是 9 路）。row 0 在黑方顶端，红从下往上攻。
 */
function fileNumber(color: XiangqiColor, col: number): number {
  return color === "red" ? 9 - col : col + 1;
}

/** 纵线号/步数 → 记谱文本：红中文数字、黑阿拉伯数字。 */
function fileText(color: XiangqiColor, number: number): string {
  return color === "red" ? (CN_NUMERALS[number - 1] ?? String(number)) : String(number);
}

/**
 * 一手棋的中文记谱（如「炮二平五」「前車退一」）。规则：
 * - 纵线号各从己方右手数起；红用中文数字、黑用阿拉伯数字。
 * - 同列同种棋子恰有两枚时用「前/后」替代纵线号（前 = 更靠近敌方的一枚；
 *   红方向上攻，row 小者在前）。三枚及以上（多兵同线）退化为纵线记法。
 * - 同行平移记「平 + 目的纵线号」；同列直进/退记「进/退 + 步数」；
 *   斜走子（马/象/士）进退记「进/退 + 目的纵线号」。
 * 参数 board 是**走子前**的局面（前/后 消歧依赖它）；导出仅为单测直测，
 * 入参放宽为 string|null 网格（棋子码非法时按原样显示，不抛异常）。
 */
export function xiangqiMoveNotation(board: Array<Array<string | null>>, from: Point, to: Point): string {
  const piece = board[from.row]?.[from.col] ?? null;
  if (!piece) return "？？";
  const color: XiangqiColor = piece === piece.toUpperCase() ? "red" : "black";
  const char = NOTATION_CHARS[color][piece.toUpperCase()] ?? piece;

  // 同列同种棋子统计：恰两枚才有确定的 前/后。
  const sameFileRows: number[] = [];
  for (let row = 0; row < XIANGQI_ROWS; row += 1) {
    if (board[row]![from.col] === piece) sameFileRows.push(row);
  }
  let prefix = "";
  if (sameFileRows.length === 2) {
    const frontRow = color === "red" ? Math.min(...sameFileRows) : Math.max(...sameFileRows);
    prefix = frontRow === from.row ? "前" : "后";
  }
  const fileLabel = prefix === "" ? fileText(color, fileNumber(color, from.col)) : "";

  let verb: string;
  let target: string;
  if (to.row === from.row) {
    verb = "平";
    target = fileText(color, fileNumber(color, to.col));
  } else {
    const forward = color === "red" ? to.row < from.row : to.row > from.row;
    verb = forward ? "进" : "退";
    target =
      from.col === to.col
        ? fileText(color, Math.abs(to.row - from.row)) // 直行：步数
        : fileText(color, fileNumber(color, to.col)); // 斜走：目的纵线
  }
  return `${prefix}${char}${fileLabel}${verb}${target}`;
}

// ---------------------------------------------------------------------------
// 走子动作
// ---------------------------------------------------------------------------

/** 走子 payload 的服务端校验：{ from: {row,col}, to: {row,col} }，整数且界内。 */
function parseMovePayload(payload: unknown): { from: Point; to: Point } | null {
  if (payload === null || typeof payload !== "object") return null;
  const candidate = payload as { from?: unknown; to?: unknown };
  const parsePoint = (value: unknown): Point | null => {
    if (value === null || typeof value !== "object") return null;
    const point = value as { row?: unknown; col?: unknown };
    if (typeof point.row !== "number" || typeof point.col !== "number") return null;
    if (!Number.isInteger(point.row) || !Number.isInteger(point.col)) return null;
    if (!inBounds(point.row, point.col)) return null;
    return { row: point.row, col: point.col };
  };
  const from = parsePoint(candidate.from);
  const to = parsePoint(candidate.to);
  if (!from || !to) return null;
  if (from.row === to.row && from.col === to.col) return null;
  return { from, to };
}

function applyMove(
  state: GameRoomState,
  engine: XiangqiEngineState,
  seat: XiangqiSeat,
  action: GameRoomAction,
): EngineOutcome {
  if (engine.turn !== seat.color) {
    return failure("not_your_turn", "还没轮到你走棋");
  }
  const move = parseMovePayload(action.payload);
  if (!move) {
    return failure("illegal_move", "payload 必须是 { from: {row,col}, to: {row,col} }，坐标为界内整数");
  }
  const piece = engine.board[move.from.row]![move.from.col]!;
  if (piece === null) {
    return failure("illegal_move", "起点没有棋子");
  }
  if (pieceColor(piece) !== seat.color) {
    return failure("illegal_move", "只能移动自己的棋子");
  }
  const legal = pseudoDestinations(engine.board, move.from.row, move.from.col).some(
    (dest) => dest.row === move.to.row && dest.col === move.to.col,
  );
  if (!legal) {
    return failure("illegal_move", "该棋子不能这样走（含蹩马腿/塞象眼/炮架/越界宫域等规则）");
  }

  const board = boardAfter(engine.board, move.from, move.to);
  // 服务端合法性兜底复核：走后己方将被攻击或照面（送将）一律拒绝。
  if (!isKingSafe(board, seat.color)) {
    return failure("illegal_move", "这一步会让你的将/帅被攻击或将帅照面");
  }
  const captured = engine.board[move.to.row]![move.to.col] ?? null;
  const givesCheck = isInCheck(board, engine.turn === "red" ? "black" : "red");

  const record: XiangqiMoveRecord = {
    ply: engine.moves.length + 1,
    color: seat.color,
    from: move.from,
    to: move.to,
    piece,
    captured,
    seatToken: seat.seatToken,
    givesCheck,
    // 记谱用走子前局面（engine.board 尚未更新），同线前/后 消歧因此准确。
    notation: xiangqiMoveNotation(engine.board, move.from, move.to),
  };
  const nextTurn = opponentColor(seat.color);
  const checkStreaks: Record<XiangqiColor, number> = {
    ...engine.checkStreaks,
    [seat.color]: givesCheck ? engine.checkStreaks[seat.color] + 1 : 0,
  };
  const positions = [...engine.positions, positionKey(board, nextTurn)];

  // 长将判和：局面在近期窗口内第 N 次出现，且有一方连续 N 手将军。
  const window = positions.slice(-REPEAT_WINDOW_PLIES);
  const repeats = window.filter((key) => key === positions[positions.length - 1]).length;
  const perpetual = repeats >= PERPETUAL_REPEATS && Math.max(checkStreaks.red, checkStreaks.black) >= PERPETUAL_REPEATS;

  let outcome: XiangqiOutcome | null = null;
  if (perpetual) {
    outcome = { result: "draw", winnerSeatToken: null, reason: "perpetual_check" };
  } else if (!hasAnyLegalMove(board, nextTurn)) {
    // 对方无合法着法：被将军 = 将死，未被将军 = 困毙（象棋困毙判负）。
    outcome = isInCheck(board, nextTurn)
      ? { result: "win", winnerSeatToken: seat.seatToken, reason: "checkmate" }
      : { result: "win", winnerSeatToken: seat.seatToken, reason: "stalemate" };
  }

  const next: XiangqiEngineState = {
    ...engine,
    board,
    moves: [...engine.moves, record],
    turn: nextTurn,
    outcome,
    checkStreaks,
    positions,
    actionIds: trackActionId(engine.actionIds, action.actionId),
  };
  return success({ ...state, engineState: next, deadlineAt: outcome ? null : Date.now() + engine.turnMs });
}

function applyResign(
  state: GameRoomState,
  engine: XiangqiEngineState,
  seat: XiangqiSeat,
  action: GameRoomAction,
): EngineOutcome {
  const opponent = activeSeatByColor(state, engine, opponentColor(seat.color));
  const next: XiangqiEngineState = {
    ...engine,
    outcome: opponent
      ? { result: "resign", winnerSeatToken: opponent.seatToken, reason: "resign" }
      : { result: "aborted", winnerSeatToken: null, reason: "aborted" },
    pendingDrawFrom: null,
    actionIds: trackActionId(engine.actionIds, action.actionId),
  };
  return success({ ...state, engineState: next, deadlineAt: null });
}

function agreeDraw(state: GameRoomState, engine: XiangqiEngineState, action: GameRoomAction): EngineOutcome {
  const next: XiangqiEngineState = {
    ...engine,
    outcome: { result: "draw", winnerSeatToken: null, reason: "agreed" },
    pendingDrawFrom: null,
    actionIds: trackActionId(engine.actionIds, action.actionId),
  };
  return success({ ...state, engineState: next, deadlineAt: null });
}

function applyOfferDraw(state: GameRoomState, engine: XiangqiEngineState, action: GameRoomAction): EngineOutcome {
  const seat = seatOf(engine, action.participantHash);
  if (!seat) return failure("internal_error", "玩家座次缺失");
  // 对方已求和时，本方再发一次即视为同意（少一个往返，语义不变）。
  if (engine.pendingDrawFrom !== null && engine.pendingDrawFrom !== seat.seatToken) {
    return agreeDraw(state, engine, action);
  }
  if (engine.pendingDrawFrom === seat.seatToken) {
    return failure("invalid_action", "已发出和棋申请，等待对方回应");
  }
  const next: XiangqiEngineState = {
    ...engine,
    // 申请记座位令牌（随公开视图下发）；participantHash 只留在 seats 里做
    // 服务端成员校验，绝不外发。
    pendingDrawFrom: seat.seatToken,
    actionIds: trackActionId(engine.actionIds, action.actionId),
  };
  return success(withEngine(state, next));
}

function applyAcceptDraw(state: GameRoomState, engine: XiangqiEngineState, action: GameRoomAction): EngineOutcome {
  const seat = seatOf(engine, action.participantHash);
  if (!seat) return failure("internal_error", "玩家座次缺失");
  if (engine.pendingDrawFrom === null) {
    return failure("illegal_move", "没有待同意的和棋申请");
  }
  if (engine.pendingDrawFrom === seat.seatToken) {
    return failure("illegal_move", "不能同意自己发起的和棋");
  }
  return agreeDraw(state, engine, action);
}

// ---------------------------------------------------------------------------
// 视图载荷（无隐藏信息：公开与玩家视图同一局面，玩家视图仅多 yourColor；
// actionIds/positions/checkStreaks 等内部簿记绝不进视图）
// ---------------------------------------------------------------------------

function publicViewPayload(engine: XiangqiEngineState): Record<string, unknown> {
  return {
    cols: XIANGQI_COLS,
    rows: XIANGQI_ROWS,
    board: engine.board,
    turn: engine.turn,
    // 显式投影：座位行还持有 participantHash（服务端内部成员校验用），展开
    // 对象会把它带进视图——视图只发座位令牌（修复 1）。
    players: engine.seats.map((seat) => ({ seatToken: seat.seatToken, color: seat.color })),
    moveCount: engine.moves.length,
    lastMove: engine.moves.at(-1) ?? null,
    // 棋谱全量（每手带中文记谱）：客户端棋谱侧栏直接渲染，重连/观战中途
    // 进房也能看到从头开始的完整走棋历史。
    history: engine.moves.map((move) => ({ ...move })),
    // 行棋方的合法着法表（可走点提示）；终局后为空表。只含公开推导信息，
    // 不构成私有信息泄漏（见 legalMovesFor 注释）。
    legalMoves: engine.outcome === null ? legalMovesFor(engine.board, engine.turn) : [],
    check: isInCheck(engine.board, engine.turn) ? engine.turn : null,
    outcome: engine.outcome,
    pendingDrawFrom: engine.pendingDrawFrom,
  };
}

// ---------------------------------------------------------------------------
// 引擎实现
// ---------------------------------------------------------------------------

export const xiangqiEngine: MultiplayerGameEngine = {
  gameType: "xiangqi",
  label: "象棋",
  meta: {
    displayName: "象棋",
    description: "楚河汉界双人博弈：车马炮兵象士将，将死或困毙对方获胜；每一步限时一分钟。",
    minPlayers: 2,
    maxPlayers: 2,
  } satisfies GameEngineMeta,

  createRoom(state, config): EngineOutcome {
    const turnMs = readTurnMs(config);
    if (turnMs === null) {
      return failure("invalid_action", `config.turnMs 必须是 ${MIN_TURN_MS}–${MAX_TURN_MS} 之间的毫秒数`);
    }
    // 红黑自动分配：房主执红先手，第二位玩家在 joinRoom 时执黑。
    const seats: XiangqiSeat[] = activePlayers(state)
      .slice(0, 2)
      .map((player, index) => ({
        participantHash: player.participantHash,
        seatToken: player.seatToken,
        color: index === 0 ? "red" : "black",
      }));
    const engine: XiangqiEngineState = {
      board: initialBoard(),
      seats,
      turn: "red",
      moves: [],
      outcome: null,
      pendingDrawFrom: null,
      actionIds: [],
      turnMs,
      positions: [positionKey(initialBoard(), "red")],
      checkStreaks: { red: 0, black: 0 },
    };
    return success(withEngine(state, engine));
  },

  joinRoom(state, player): EngineOutcome {
    if (state.status !== "lobby") {
      return failure("invalid_action", "对局已开始，无法加入");
    }
    const engine = readEngineState(state);
    if (!engine) {
      return failure("internal_error", "房间引擎状态未初始化");
    }
    const active = activePlayers(state);
    if (active.length >= 2) {
      return failure("invalid_action", "房间已满（象棋为两人对局）");
    }

    // 只保留仍有效座位的颜色；离开玩家的座位释放给新玩家（仅在 lobby）。
    const activeHashes = new Set(active.map((item) => item.participantHash));
    const seats = engine.seats.filter((seat) => activeHashes.has(seat.participantHash));
    const used = new Set(seats.map((seat) => seat.color));
    if (used.has("red") && used.has("black")) {
      return failure("invalid_action", "房间已满（象棋为两人对局）");
    }
    const color: XiangqiColor = used.has("red") ? "black" : "red";
    const next: XiangqiEngineState = {
      ...engine,
      seats: [...seats, { participantHash: player.participantHash, seatToken: player.seatToken, color }],
    };
    // 协议契约：state.players 此刻不含该玩家，引擎负责追加入座。
    return success(withEngine({ ...state, players: [...state.players, player] }, next));
  },

  setReady(state, participantHash, ready): EngineOutcome {
    if (state.status !== "lobby") {
      return failure("invalid_action", "对局已开始");
    }
    const player = findActivePlayer(state, participantHash);
    if (!player) {
      return failure("not_a_player", "你还不是本房间玩家");
    }
    const players = state.players.map((item) => (item.participantHash === participantHash ? { ...item, ready } : item));
    return success({ ...state, players });
  },

  start(state, participantHash): EngineOutcome {
    if (state.status !== "lobby") {
      return failure("invalid_action", "对局已开始");
    }
    const engine = readEngineState(state);
    if (!engine) {
      return failure("internal_error", "房间引擎状态未初始化");
    }
    const requester = state.players.find((player) => player.participantHash === participantHash);
    if (!requester || requester.leftAt) {
      return failure("not_a_player", "你还不是本房间玩家");
    }
    if (!requester.isHost) {
      return failure("not_host", "只有房主可以开局");
    }
    const active = activePlayers(state);
    if (active.length !== 2) {
      return failure("invalid_action", "象棋需要两名玩家才能开局");
    }
    if (!active.every((player) => player.ready)) {
      return failure("invalid_action", "双方都准备后才能开局");
    }

    // 房主红先手是开局唯一权威：无视 lobby 座位残留，按 isHost 重排红黑。
    const host = active.find((player) => player.isHost) ?? active[0]!;
    const guest = active.find((player) => player.participantHash !== host.participantHash)!;
    const seats: XiangqiSeat[] = [
      { participantHash: host.participantHash, seatToken: host.seatToken, color: "red" },
      { participantHash: guest.participantHash, seatToken: guest.seatToken, color: "black" },
    ];
    const board = initialBoard();
    const next: XiangqiEngineState = {
      ...engine,
      board,
      seats,
      turn: "red",
      moves: [],
      outcome: null,
      pendingDrawFrom: null,
      positions: [positionKey(board, "red")],
      checkStreaks: { red: 0, black: 0 },
    };
    return success({ ...state, status: "playing", deadlineAt: Date.now() + engine.turnMs, engineState: next });
  },

  applyAction(state, action): EngineOutcome {
    const engine = readEngineState(state);
    if (!engine) {
      return failure("internal_error", "房间引擎状态未初始化");
    }
    if (!findActivePlayer(state, action.participantHash)) {
      return failure("not_a_player", "你还不是本房间玩家");
    }
    // 防御性幂等：权威去重表在 DO storage，重放不会走到引擎；这里兜直连/异常路径。
    if (engine.actionIds.includes(action.actionId)) {
      return failure("invalid_action", "动作已处理（重复 actionId）");
    }
    // 防御性版本校验：version 由 DO 唯一递增，引擎只拒绝明显过期的动作。
    if (typeof action.baseVersion === "number" && action.baseVersion !== state.version) {
      return failure("stale_action", "局面已更新，请刷新后重试");
    }
    if (state.status !== "playing") {
      return failure(
        state.status === "lobby" ? "invalid_action" : "game_over",
        state.status === "lobby" ? "对局尚未开始" : "对局已结束",
      );
    }
    if (engine.outcome !== null) {
      return failure("game_over", "对局已结束");
    }
    const seat = seatOf(engine, action.participantHash);
    if (!seat) {
      return failure("internal_error", "玩家座次缺失");
    }

    switch (action.action) {
      case "move":
        return applyMove(state, engine, seat, action);
      case "resign":
        return applyResign(state, engine, seat, action);
      case "offer_draw":
        return applyOfferDraw(state, engine, action);
      case "accept_draw":
        return applyAcceptDraw(state, engine, action);
      default:
        return failure("illegal_move", `未知动作 ${action.action}`);
    }
  },

  getPlayerView(state, participantHash): { view: unknown } {
    const engine = readEngineState(state);
    if (!engine) return { view: null };
    const seat = seatOf(engine, participantHash);
    return { view: { ...publicViewPayload(engine), yourColor: seat?.color ?? null } };
  },

  getPublicView(state): { view: unknown } {
    const engine = readEngineState(state);
    return { view: engine ? publicViewPayload(engine) : null };
  },

  checkGameOver(state): boolean {
    const engine = readEngineState(state);
    return engine !== null && engine.outcome !== null;
  },

  settle(state): GameSettlement {
    const engine = readEngineState(state);
    const outcome = engine?.outcome ?? null;
    const red = engine ? seatByColor(engine, "red") : null;
    const black = engine ? seatByColor(engine, "black") : null;
    return {
      result: outcome?.result ?? "aborted",
      // 结算快照进视图对全房可见（含观战）：一律用座位令牌对位（修复 1）。
      winnerSeatToken: outcome?.winnerSeatToken ?? null,
      summary: {
        reason: outcome?.reason ?? null,
        moveCount: engine?.moves.length ?? 0,
        history: engine?.moves ?? [],
        redSeatToken: red?.seatToken ?? null,
        blackSeatToken: black?.seatToken ?? null,
      },
      settledAt: new Date().toISOString(),
      version: state.version,
    };
  },

  handleTimeout(state, now): EngineOutcome {
    if (state.status !== "playing") {
      return failure("invalid_action", "对局不在进行中");
    }
    const engine = readEngineState(state);
    if (!engine) {
      return failure("internal_error", "房间引擎状态未初始化");
    }
    if (state.deadlineAt === null) {
      return failure("invalid_action", "当前没有进行中的回合倒计时");
    }
    if (now < state.deadlineAt) {
      return failure("invalid_action", "尚未到超时时间");
    }
    if (engine.outcome !== null) {
      return failure("game_over", "对局已结束");
    }

    const loser = activeSeatByColor(state, engine, engine.turn);
    const winner = activeSeatByColor(state, engine, opponentColor(engine.turn));
    const next: XiangqiEngineState = {
      ...engine,
      outcome:
        loser && winner
          ? { result: "timeout", winnerSeatToken: winner.seatToken, reason: "timeout" }
          : { result: "aborted", winnerSeatToken: null, reason: "aborted" },
      pendingDrawFrom: null,
    };
    // 只打标记并清 deadline：checkGameOver 命中后由 DO 走统一 settleRoom。
    return success({ ...state, engineState: next, deadlineAt: null });
  },
};
