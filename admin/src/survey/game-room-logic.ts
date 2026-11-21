/**
 * 五子棋联机对局的纯逻辑层（批次 W3 前端）。
 *
 * 本文件只放纯函数与视图类型：不碰 DOM、不发请求、不 import 任何带副作用的
 * 模块，供 MultiplayerGameScreen 与 tests/unit/survey 的 node 单测直接引用。
 * 与服务端的分工：
 * - 权威校验在 GameRoomDO + gomokuEngine（src/game/multiplayer/engines/gomoku.ts）；
 *   这里的 localMoveCheck 只做「挡掉必被拒绝的操作」的本地预判（没轮到自己 /
 *   格子上有子），绝不替代服务端校验——客户端传什么都不可信。
 * - parseGomokuView 按「服务端可能返回任何 JSON」防御收敛：形状对不上返回
 *   null，屏层落错误态，绝不白屏。
 */
import type { GameChatChannel, GameChatMessage } from "../../../src/game/multiplayer/engine-types";
// 飞行棋常量与共享主环几何直接复用服务端引擎（ludo.ts 纯函数、零副作用），
// 客户端绝不复刻第二份恒等式——漂移即错位渲染，单一事实来源在引擎。
import {
  LUDO_FINISH_POS,
  LUDO_LOOP_CELLS,
  LUDO_LOOP_TOP,
  LUDO_PLANES_PER_PLAYER,
  LUDO_SEAT_COLORS,
  ludoLoopCell,
} from "../../../src/game/multiplayer/engines/ludo";
// 斗地主牌码/牌型纯函数直接复用服务端引擎(零副作用),客户端绝不复刻第二份
// 恒等式;`export ... from` 下方再原样转出口供屏层引用。
import {
  DOU_DIZHU_RANK_LABELS,
  DOU_DIZHU_TYPE_LABELS,
  beatsDoudizhuPlay,
  classifyDoudizhuPlay,
  doudizhuCardLabel,
  doudizhuCardRank,
} from "../../../src/game/multiplayer/engines/doudizhu";
// 狼人杀身份键/身份中文名/发言字数上限/标准板推导直接复用服务端引擎的纯函数
// 与常量(零副作用),客户端绝不复刻第二份恒等式——漂移即文案错乱。
import {
  WEREWOLF_ALL_ROLES,
  WEREWOLF_ROLE_LABELS,
  WEREWOLF_SPEECH_MAX_CHARS,
  werewolfBoard,
  type WerewolfPhase,
  type WerewolfRole,
} from "../../../src/game/multiplayer/engines/werewolf";

export type GomokuColor = "black" | "white";

/** 玩法私有视图里的座位（gomokuEngine publicViewPayload.players）。 */
export interface GomokuSeatView {
  /** 座位令牌（修复 1：信封/视图对位的唯一公开标识，participantHash 不再外发）。 */
  seatToken: string;
  color: GomokuColor;
}

export interface GomokuLastMoveView {
  row: number;
  col: number;
  color: GomokuColor;
  /** 落子者座位令牌：悔棋申请的本地预判（只能撤回自己刚落下的一手）用它判定。 */
  seatToken: string;
}

export interface GomokuOutcomeView {
  result: string;
  winnerSeatToken: string | null;
}

/**
 * 五子棋视图载荷（gomokuEngine 的 view 字段）的客户端收敛形状。
 * yourColor 只在玩家视图里出现（观战/公开视图没有），观战者为 null。
 */
export interface GomokuView {
  boardSize: number;
  board: Array<Array<GomokuColor | null>>;
  turn: GomokuColor;
  players: GomokuSeatView[];
  moveCount: number;
  lastMove: GomokuLastMoveView | null;
  winningLine: Array<{ row: number; col: number }> | null;
  outcome: GomokuOutcomeView | null;
  pendingDrawFrom: string | null;
  pendingUndoFrom: string | null;
  yourColor: GomokuColor | null;
}

/** 棋盘渲染几何：SVG 视口 480×480，棋盘线交点从 margin 起步。 */
export const BOARD_VIEW_SIZE = 480;
export const BOARD_MARGIN = 15;

// ---------------------------------------------------------------------------
// 房间码
// ---------------------------------------------------------------------------

/**
 * 房间码 → 数字房间 id。收两种形态：纯数字（用户手动转述的房间码）与
 * `room_<id>`（深链接 startapp 的锁定格式，engine-types.parseGameRoomRef）。
 * 只收规范十进制：与 server 侧同一条纪律，`0123`/`1e3`/负数一律拒绝。
 */
export function roomCodeToId(value: string): number | null {
  const trimmed = value.trim();
  const digits = trimmed.toLowerCase().startsWith("room_") ? trimmed.slice(5) : trimmed;
  if (!/^[1-9]\d*$/.test(digits)) return null;
  const id = Number(digits);
  return Number.isSafeInteger(id) ? id : null;
}

/** 数字房间 id → 深链接引用（复制给好友的完整形态）。 */
export function formatRoomRef(roomId: number): string {
  return `room_${roomId}`;
}

/**
 * 加入输入框的宽容解析：接受「123」「room_123」，也接受整条链接里带的
 * ?room=123 / ?startapp=room_123 / ?ref=room_123（从 bot 深链接直接复制粘贴
 * 是最常见的加入路径）。解析不出就返回 null，屏层提示房间码无效。
 */
export function normalizeRoomCode(raw: string): number | null {
  const input = raw.trim();
  if (!input) return null;
  const direct = roomCodeToId(input);
  if (direct !== null) return direct;
  const queryIndex = input.indexOf("?");
  if (queryIndex < 0) return null;
  const params = new URLSearchParams(input.slice(queryIndex + 1));
  for (const key of ["room", "startapp", "ref"]) {
    const value = params.get(key);
    if (value === null) continue;
    const id = roomCodeToId(value);
    if (id !== null) return id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 棋盘坐标换算
// ---------------------------------------------------------------------------

export interface BoardGeometry {
  /** 相邻交点间距（SVG 用户单位）。 */
  cell: number;
  /** 按行优先排列的全部交点坐标（row × col）。 */
  points: Array<{ x: number; y: number }>;
}

/** 交点坐标表：第 (row, col) 手在 `margin + col*cell / margin + row*cell`。 */
export function boardGeometry(boardSize: number): BoardGeometry {
  if (!Number.isInteger(boardSize) || boardSize < 2) return { cell: 0, points: [] };
  const cell = (BOARD_VIEW_SIZE - BOARD_MARGIN * 2) / (boardSize - 1);
  const points: Array<{ x: number; y: number }> = [];
  for (let row = 0; row < boardSize; row += 1) {
    for (let col = 0; col < boardSize; col += 1) {
      points.push({ x: BOARD_MARGIN + col * cell, y: BOARD_MARGIN + row * cell });
    }
  }
  return { cell, points };
}

/**
 * 点击坐标 → 棋盘交点。吸附到最近交点；命中半径 0.71 格（≈ 半格对角线，
 * √2/2）——格与格之间不留死区，交点间距在 390px 视口下约 21px，热区必须
 * 整格连续才够手指点。越界返回 null。
 */
export function cellFromPoint(x: number, y: number, boardSize: number): { row: number; col: number } | null {
  const { cell } = boardGeometry(boardSize);
  if (cell <= 0) return null;
  // `|| 0` 归一 Math.round 的负零（如 x 略小于 margin 时）：-0 当索引没问题，
  // 但会污染返回值形状（toEqual 区分 -0/0）。
  const col = Math.round((x - BOARD_MARGIN) / cell) || 0;
  const row = Math.round((y - BOARD_MARGIN) / cell) || 0;
  if (row < 0 || row >= boardSize || col < 0 || col >= boardSize) return null;
  const distance = Math.hypot(x - (BOARD_MARGIN + col * cell), y - (BOARD_MARGIN + row * cell));
  if (distance > cell * 0.71) return null;
  return { row, col };
}

/** 15 路棋盘的星位（天元 + 四星），画盘装饰用。 */
export function starPoints(boardSize: number): Array<{ row: number; col: number }> {
  if (boardSize !== 15) return [];
  return [
    { row: 3, col: 3 },
    { row: 3, col: 11 },
    { row: 11, col: 3 },
    { row: 11, col: 11 },
    { row: 7, col: 7 },
  ];
}

// ---------------------------------------------------------------------------
// 落子本地预判
// ---------------------------------------------------------------------------

/**
 * 落子合法性本地预判：合法返回 null，非法返回给用户看的中文原因。
 * 只做「不问服务端也知道会被拒」的三类检查；胜负/禁手等权威判定全在引擎。
 */
export function localMoveCheck(
  board: Array<Array<GomokuColor | null>>,
  row: number,
  col: number,
  turn: GomokuColor,
  yourColor: GomokuColor | null,
): string | null {
  if (yourColor === null) return "观战者不能落子";
  if (turn !== yourColor) return "还没轮到你落子";
  const line = board[row];
  if (!Array.isArray(line) || !(col in line)) return "落点不在棋盘内";
  if (line[col] !== null) return "这个位置已经有棋子了";
  return null;
}

// ---------------------------------------------------------------------------
// 倒计时格式化
// ---------------------------------------------------------------------------

/**
 * 回合倒计时 → 「分:秒」。服务端无时限（null）原样返回 null；
 * 已到点（≤0）按 00:00 收口，分钟数超过 99 也不再涨位数。
 */
export function formatCountdown(remainingMs: number | null): string | null {
  if (remainingMs === null || !Number.isFinite(remainingMs)) return null;
  const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000));
  const minutes = Math.min(99, Math.floor(totalSeconds / 60));
  const seconds = totalSeconds % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(minutes)}:${pad(seconds)}`;
}

export type CountdownTone = "normal" | "urgent" | "expired";

/**
 * 倒计时紧迫度：剩 ≤10s 转「紧迫」、到点转「告警」，UI 换色提醒该出手了。
 * 无时限（null/非数）恒为 normal，不进告警分支。
 */
export function countdownTone(remainingMs: number | null): CountdownTone {
  if (remainingMs === null || !Number.isFinite(remainingMs)) return "normal";
  if (remainingMs <= 0) return "expired";
  if (remainingMs <= 10_000) return "urgent";
  return "normal";
}

// ---------------------------------------------------------------------------
// 协议错误码 → 中文文案
// ---------------------------------------------------------------------------

/**
 * 全部协议错误码（engine-types.GAME_PROTOCOL_ERROR_CODES）与 REST/客户端
 * 兜底码的中文可读文案。服务端的 message 已是中文且往往更具体（如
 * “房间已满（五子棋为两人对局）”）——有 message 时优先展示原文，这里兜住
 * 缺失/外语/未知码的情况，保证任何错误最终都落成一句能看懂的人话。
 */
const GAME_ERROR_TEXT: Record<string, string> = {
  // 协议码（src/game/multiplayer/engine-types.ts）
  invalid_payload: "请求内容不对，请刷新页面后重试",
  unknown_game_type: "这个玩法还没有上线",
  invalid_action: "当前状态不能执行这个操作",
  not_a_player: "你还不是本房间的玩家",
  spectator_forbidden: "观战者不能参与对局操作",
  not_your_turn: "还没轮到你",
  illegal_move: "这一步不符合规则",
  game_over: "对局已经结束",
  stale_action: "棋局刚有更新，请按最新棋盘重新操作",
  not_host: "只有房主可以执行这个操作",
  room_not_found: "房间不存在或已被回收",
  internal_error: "服务器开小差了，请稍后再试",
  // REST 层附加码（game-api / rate-limit / api-response）与客户端兜底码
  network_error: "网络异常，请稍后再试",
  rate_limited: "操作太频繁了，休息一下再试",
  game_disabled: "多人对局在当前部署未开放",
  game_room_error: "房间服务暂时不可用，请稍后再试",
  validation_failed: "提交的内容没有通过校验",
  method_not_allowed: "请求方式不支持",
  bad_response: "房间数据加载失败，请稍后再试",
  unknown_error: "请求没有成功，请稍后再试",
  // 房间内聊天（engine-types 末尾追加的聊天码；WS error 帧经 gameErrorText 收敛）
  chat_too_long: "消息最长 500 字，请分几条发送",
  chat_payload_too_large: "语音/图片超过 300KB 上限，压缩后再发",
  chat_rate_limited: "发言太频繁了，休息一下再试",
  chat_channel_forbidden: "你不在该频道的可见范围内",
  chat_content_rejected: "内容包含不允许的字词，请修改后再试",
};

/**
 * 错误文案收敛：message 非空原样用（服务端的具体中文），否则按 code 映射，
 * 双双落空给通用兜底。code/message 都允许空——网络层错误只有兜底文案。
 */
export function gameErrorText(code: string | null | undefined, message?: string | null): string {
  if (typeof message === "string" && message.trim()) return message;
  if (typeof code === "string" && GAME_ERROR_TEXT[code]) return GAME_ERROR_TEXT[code]!;
  return "出了点问题，请稍后再试";
}

// ---------------------------------------------------------------------------
// 对手掉线 / 悔棋被拒 的纯判定（屏层据此弹提示）
// ---------------------------------------------------------------------------

/**
 * 对手掉线风险：对局中在线玩家 < 2（presence 推送的 onlinePlayers，按身份
 * 去重；自己掉线时收不到推送，等重连后由下一条 presence 纠正）。
 * 五子棋固定两人对局，所以阈值取 2；观战人数不参与判定。
 */
export function opponentLikelyOffline(status: string | null, onlinePlayers: number | null): boolean {
  return status === "playing" && onlinePlayers !== null && onlinePlayers < 2;
}

/**
 * 悔棋申请被拒绝的判定：上一帧我的申请还在等待（pendingUndoFrom === 我），
 * 下一帧申请消失且 moveCount 增加 = 对方落子把申请顶掉了（协议语义：落子
 * 即拒绝）。moveCount 减少 = 悔棋被同意，棋盘变化自解释，不需要提示。
 */
export function undoRejectedNotice(
  prevPendingUndoFrom: string | null,
  nextPendingUndoFrom: string | null,
  prevMoveCount: number,
  nextMoveCount: number,
  myHash: string | null,
): string | null {
  if (myHash === null) return null;
  if (prevPendingUndoFrom !== myHash) return null;
  if (nextPendingUndoFrom !== null) return null;
  if (nextMoveCount > prevMoveCount) return "对方落子了，你的悔棋申请已失效";
  return null;
}

// ---------------------------------------------------------------------------
// 结算文案
// ---------------------------------------------------------------------------

export interface SettlementCopy {
  headline: string;
  detail: string;
  tone: "win" | "lose" | "draw" | "neutral";
}

/**
 * 结算/终局文案。视角由 mySeatToken 决定（胜者是我 → 你赢了）；
 * 观战者与中止局给中性文案。result 取值来自引擎（win/draw/timeout/resign/aborted）。
 */
export function describeSettlement(
  result: string,
  winnerSeatToken: string | null,
  mySeatToken: string | null,
): SettlementCopy {
  if (result === "draw") return { headline: "平局", detail: "双方握手言和", tone: "draw" };
  if (result === "aborted" || !winnerSeatToken) {
    return { headline: "对局结束", detail: "对局中止", tone: "neutral" };
  }
  const iWon = mySeatToken !== null && winnerSeatToken === mySeatToken;
  const spectating = mySeatToken === null;
  const how =
    result === "timeout"
      ? iWon
        ? "对方超时"
        : "超时判负"
      : result === "resign"
        ? iWon
          ? "对方认输"
          : "认输"
        : result === "win"
          ? "五子连珠"
          : "";
  if (spectating) return { headline: "对局结束", detail: how, tone: "neutral" };
  return iWon
    ? { headline: "你赢了！", detail: how || "恭喜", tone: "win" }
    : { headline: "对方获胜", detail: how, tone: "lose" };
}

// ---------------------------------------------------------------------------
// 视图收敛
// ---------------------------------------------------------------------------

function isGomokuColor(value: unknown): value is GomokuColor {
  return value === "black" || value === "white";
}

/**
 * 把引擎视图载荷收敛成 GomokuView。board/turn 是棋盘渲染的硬前提，形状
 * 不对整包拒绝（返回 null）；其余字段逐个容错（缺失给中性默认值）。
 */
export function parseGomokuView(payload: unknown): GomokuView | null {
  if (payload === null || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const boardSize = record.boardSize;
  if (typeof boardSize !== "number" || !Number.isInteger(boardSize) || boardSize < 5 || boardSize > 25) return null;
  if (!Array.isArray(record.board) || record.board.length !== boardSize) return null;
  if (!isGomokuColor(record.turn)) return null;
  const board: Array<Array<GomokuColor | null>> = [];
  for (const line of record.board) {
    if (!Array.isArray(line) || line.length !== boardSize) return null;
    const row: Array<GomokuColor | null> = [];
    for (const cell of line) {
      if (cell !== null && !isGomokuColor(cell)) return null;
      row.push(cell);
    }
    board.push(row);
  }

  const players: GomokuSeatView[] = [];
  if (Array.isArray(record.players)) {
    for (const seat of record.players) {
      if (!seat || typeof seat !== "object") continue;
      const entry = seat as Record<string, unknown>;
      if (typeof entry.seatToken !== "string" || !isGomokuColor(entry.color)) continue;
      players.push({ seatToken: entry.seatToken, color: entry.color });
    }
  }

  const lastMoveRecord =
    record.lastMove !== null && typeof record.lastMove === "object"
      ? (record.lastMove as Record<string, unknown>)
      : null;
  const lastMove =
    lastMoveRecord &&
    typeof lastMoveRecord.row === "number" &&
    typeof lastMoveRecord.col === "number" &&
    isGomokuColor(lastMoveRecord.color) &&
    typeof lastMoveRecord.seatToken === "string"
      ? {
          row: lastMoveRecord.row,
          col: lastMoveRecord.col,
          color: lastMoveRecord.color,
          seatToken: lastMoveRecord.seatToken,
        }
      : null;

  const winningLine: Array<{ row: number; col: number }> = [];
  if (Array.isArray(record.winningLine)) {
    for (const point of record.winningLine) {
      if (!point || typeof point !== "object") continue;
      const entry = point as Record<string, unknown>;
      if (typeof entry.row !== "number" || typeof entry.col !== "number") continue;
      winningLine.push({ row: entry.row, col: entry.col });
    }
  }

  const outcomeRecord =
    record.outcome !== null && typeof record.outcome === "object" ? (record.outcome as Record<string, unknown>) : null;
  const outcome = outcomeRecord
    ? {
        result: typeof outcomeRecord.result === "string" ? outcomeRecord.result : "",
        winnerSeatToken: typeof outcomeRecord.winnerSeatToken === "string" ? outcomeRecord.winnerSeatToken : null,
      }
    : null;

  return {
    boardSize,
    board,
    turn: record.turn,
    players,
    moveCount: typeof record.moveCount === "number" ? record.moveCount : 0,
    lastMove,
    winningLine: winningLine.length > 0 ? winningLine : null,
    outcome,
    pendingDrawFrom: typeof record.pendingDrawFrom === "string" ? record.pendingDrawFrom : null,
    pendingUndoFrom: typeof record.pendingUndoFrom === "string" ? record.pendingUndoFrom : null,
    yourColor: isGomokuColor(record.yourColor) ? record.yourColor : null,
  };
}

// ---------------------------------------------------------------------------
// 象棋（多人玩法批次 X1）：类型、棋子汉字表、视图收敛与本地预判
// ---------------------------------------------------------------------------

export type XiangqiColor = "red" | "black";

/** 玩法私有视图里的座位（xiangqiEngine publicViewPayload.players）。 */
export interface XiangqiSeatView {
  /** 座位令牌（修复 1：信封/视图对位的唯一公开标识，participantHash 不再外发）。 */
  seatToken: string;
  color: XiangqiColor;
}

export interface XiangqiPointView {
  row: number;
  col: number;
}

export interface XiangqiLastMoveView {
  ply: number;
  color: XiangqiColor;
  from: XiangqiPointView;
  to: XiangqiPointView;
  /** 走动棋子的棋子码（大写红/小写黑）。 */
  piece: string;
  captured: string | null;
  /** 行棋方座位令牌（公开对位键）。 */
  seatToken: string;
  givesCheck: boolean;
}

/** 可走点提示的一条合法着法（服务端 legalMoves 条目，按选中棋子 from 过滤用）。 */
export interface XiangqiLegalMoveView {
  from: XiangqiPointView;
  to: XiangqiPointView;
}

/** 棋谱侧栏的一手（服务端 history 条目）：坐标 + 服务端生成的中文记谱。 */
export interface XiangqiHistoryEntryView {
  ply: number;
  color: XiangqiColor;
  from: XiangqiPointView;
  to: XiangqiPointView;
  piece: string;
  captured: string | null;
  notation: string;
  givesCheck: boolean;
}

export interface XiangqiOutcomeView {
  result: string;
  winnerSeatToken: string | null;
  /** 终局原因：checkmate/stalemate/perpetual_check/resign/timeout/aborted/agreed。 */
  reason: string | null;
}

/**
 * 象棋视图载荷（xiangqiEngine 的 view 字段）的客户端收敛形状。象棋无隐藏
 * 信息：board/turn 全知；yourColor 只在玩家视图里出现，观战者为 null。
 */
export interface XiangqiView {
  cols: number;
  rows: number;
  board: Array<Array<string | null>>;
  turn: XiangqiColor;
  players: XiangqiSeatView[];
  moveCount: number;
  lastMove: XiangqiLastMoveView | null;
  /** 行棋方的合法着法（可走点提示数据源）；旧部署缺字段时为空表。 */
  legalMoves: XiangqiLegalMoveView[];
  /** 走棋历史（中文记谱由服务端生成）；旧部署缺字段时为空表。 */
  history: XiangqiHistoryEntryView[];
  /** 当前行棋方是否正被将军（红/黑/null）。 */
  check: XiangqiColor | null;
  outcome: XiangqiOutcomeView | null;
  pendingDrawFrom: string | null;
  yourColor: XiangqiColor | null;
}

/** 合法棋子码全集（xiangqi.ts 大写红 / 小写黑）。 */
const XIANGQI_PIECE_CODES = ["K", "A", "E", "H", "R", "C", "P", "k", "a", "e", "h", "r", "c", "p"] as const;

function isXiangqiPieceCode(value: unknown): value is (typeof XIANGQI_PIECE_CODES)[number] {
  return (XIANGQI_PIECE_CODES as readonly string[]).includes(value as string);
}

function isXiangqiColor(value: unknown): value is XiangqiColor {
  return value === "red" || value === "black";
}

/**
 * 棋子码 → 盘面汉字（红帅仕相傌俥炮兵 / 黑將士象馬車砲卒）。
 * 与服务端 xiangqi.ts 的编码注释一一对应，漂移只影响显示不影响协议。
 */
export const XIANGQI_PIECE_CHARS: Record<string, string> = {
  K: "帥",
  A: "仕",
  E: "相",
  H: "傌",
  R: "俥",
  C: "炮",
  P: "兵",
  k: "將",
  a: "士",
  e: "象",
  h: "馬",
  r: "車",
  c: "砲",
  p: "卒",
};

/** 把引擎视图载荷收敛成 XiangqiView；board/turn 形状不对整包拒绝（返回 null）。 */
export function parseXiangqiView(payload: unknown): XiangqiView | null {
  if (payload === null || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const cols = record.cols;
  const rows = record.rows;
  if (cols !== 9 || rows !== 10) return null;
  if (!isXiangqiColor(record.turn)) return null;
  if (!Array.isArray(record.board) || record.board.length !== rows) return null;
  const board: Array<Array<string | null>> = [];
  for (const line of record.board) {
    if (!Array.isArray(line) || line.length !== cols) return null;
    const row: Array<string | null> = [];
    for (const cell of line) {
      if (cell !== null && !isXiangqiPieceCode(cell)) return null;
      row.push(cell);
    }
    board.push(row);
  }

  const players: XiangqiSeatView[] = [];
  if (Array.isArray(record.players)) {
    for (const seat of record.players) {
      if (!seat || typeof seat !== "object") continue;
      const entry = seat as Record<string, unknown>;
      if (typeof entry.seatToken !== "string" || !isXiangqiColor(entry.color)) continue;
      players.push({ seatToken: entry.seatToken, color: entry.color });
    }
  }

  const lastMoveRecord =
    record.lastMove !== null && typeof record.lastMove === "object"
      ? (record.lastMove as Record<string, unknown>)
      : null;
  const parsePoint = (value: unknown): XiangqiPointView | null => {
    if (!value || typeof value !== "object") return null;
    const point = value as Record<string, unknown>;
    return typeof point.row === "number" && typeof point.col === "number" ? { row: point.row, col: point.col } : null;
  };
  let lastMove: XiangqiLastMoveView | null = null;
  if (lastMoveRecord) {
    const from = parsePoint(lastMoveRecord.from);
    const to = parsePoint(lastMoveRecord.to);
    if (
      from &&
      to &&
      isXiangqiPieceCode(lastMoveRecord.piece) &&
      (lastMoveRecord.captured === null || isXiangqiPieceCode(lastMoveRecord.captured)) &&
      typeof lastMoveRecord.seatToken === "string"
    ) {
      lastMove = {
        ply: typeof lastMoveRecord.ply === "number" ? lastMoveRecord.ply : 0,
        color: isXiangqiColor(lastMoveRecord.color) ? lastMoveRecord.color : "red",
        from,
        to,
        piece: lastMoveRecord.piece,
        captured: lastMoveRecord.captured === null ? null : lastMoveRecord.captured,
        seatToken: lastMoveRecord.seatToken,
        givesCheck: lastMoveRecord.givesCheck === true,
      };
    }
  }

  // 可走点提示（X2）：形状不对的条目逐条丢弃，字段缺失整表为空——旧部署
  // 没有该字段时提示不出现，棋盘照常可走（权威校验仍在服务端）。
  const legalMoves: XiangqiLegalMoveView[] = [];
  if (Array.isArray(record.legalMoves)) {
    for (const entry of record.legalMoves) {
      if (!entry || typeof entry !== "object") continue;
      const move = entry as Record<string, unknown>;
      const from = parsePoint(move.from);
      const to = parsePoint(move.to);
      if (from && to) legalMoves.push({ from, to });
    }
  }

  // 走棋历史（X2）：记谱是服务端生成的字符串，客户端只渲染不复刻规则；
  // 脏条目（缺记谱/坐标）整条丢弃，不进侧栏。
  const history: XiangqiHistoryEntryView[] = [];
  if (Array.isArray(record.history)) {
    for (const entry of record.history) {
      if (!entry || typeof entry !== "object") continue;
      const move = entry as Record<string, unknown>;
      const from = parsePoint(move.from);
      const to = parsePoint(move.to);
      if (!from || !to) continue;
      if (!isXiangqiPieceCode(move.piece) || !isXiangqiColor(move.color)) continue;
      history.push({
        ply: typeof move.ply === "number" ? move.ply : 0,
        color: move.color,
        from,
        to,
        piece: move.piece,
        captured: isXiangqiPieceCode(move.captured) ? move.captured : null,
        notation: typeof move.notation === "string" ? move.notation : "",
        givesCheck: move.givesCheck === true,
      });
    }
  }

  const outcomeRecord =
    record.outcome !== null && typeof record.outcome === "object" ? (record.outcome as Record<string, unknown>) : null;
  const outcome = outcomeRecord
    ? {
        result: typeof outcomeRecord.result === "string" ? outcomeRecord.result : "",
        winnerSeatToken: typeof outcomeRecord.winnerSeatToken === "string" ? outcomeRecord.winnerSeatToken : null,
        reason: typeof outcomeRecord.reason === "string" ? outcomeRecord.reason : null,
      }
    : null;

  return {
    cols,
    rows,
    board,
    turn: record.turn,
    players,
    moveCount: typeof record.moveCount === "number" ? record.moveCount : 0,
    lastMove,
    legalMoves,
    history,
    check: isXiangqiColor(record.check) ? record.check : null,
    outcome,
    pendingDrawFrom: typeof record.pendingDrawFrom === "string" ? record.pendingDrawFrom : null,
    yourColor: isXiangqiColor(record.yourColor) ? record.yourColor : null,
  };
}

/**
 * 走棋本地预判（服务端权威校验的“挡掉必被拒”前置）：观战者、未轮到自己、
 * 起点不是己方棋子、原地不动都直接给中文原因；走法是否合规（蹩马腿/炮架/
 * 送将等）交服务端判定，客户端不复刻棋规。
 */
export function localXiangqiMoveCheck(view: XiangqiView, from: XiangqiPointView, to: XiangqiPointView): string | null {
  if (view.yourColor === null) return "观战者不能走棋";
  if (view.turn !== view.yourColor) return "还没轮到你走棋";
  if (from.row === to.row && from.col === to.col) return "起点和终点不能相同";
  const line = view.board[from.row];
  const piece = Array.isArray(line) ? line[from.col] : undefined;
  if (piece === null || piece === undefined) return "起点没有棋子";
  const isRed = piece === piece.toUpperCase();
  if ((isRed ? "red" : "black") !== view.yourColor) return "只能移动自己的棋子";
  return null;
}

/**
 * 象棋终局文案：在通用结算文案（result 视角）之上用 reason 细化“怎么赢的”。
 * reason 取值来自引擎（checkmate/stalemate/perpetual_check/agreed/timeout/…）。
 */
export function xiangqiSettlementCopy(
  result: string,
  winnerSeatToken: string | null,
  mySeatToken: string | null,
  reason: string | null,
): SettlementCopy {
  const base = describeSettlement(result, winnerSeatToken, mySeatToken);
  const iWon = winnerSeatToken !== null && mySeatToken === winnerSeatToken;
  if (result === "win" && reason === "checkmate") return { ...base, detail: iWon ? "将死对方" : "被将死" };
  if (result === "win" && reason === "stalemate") {
    return { ...base, detail: iWon ? "对方困毙（无子可动）" : "己方困毙（无子可动）" };
  }
  if (result === "draw" && reason === "perpetual_check") return { ...base, detail: "长将判和（连续重复局面）" };
  return base;
}

// ---------------------------------------------------------------------------
// 象棋棋盘几何（XiangqiBoard 渲染与点击吸附共用）
// ---------------------------------------------------------------------------

/** SVG 视口宽高与四周留白：9 列 10 行的交点网格，棋子落在交点上。 */
export const XIANGQI_VIEW_W = 468;
export const XIANGQI_VIEW_H = 520;
export const XIANGQI_MARGIN_X = 28;
export const XIANGQI_MARGIN_Y = 28;

export interface XiangqiGeometry {
  cellX: number;
  cellY: number;
  /** 按行优先排列的全部交点坐标（row × col，row 0 在黑方顶端）。 */
  points: Array<{ x: number; y: number }>;
}

export function xiangqiGeometry(): XiangqiGeometry {
  const cellX = (XIANGQI_VIEW_W - XIANGQI_MARGIN_X * 2) / 8;
  const cellY = (XIANGQI_VIEW_H - XIANGQI_MARGIN_Y * 2) / 9;
  const points: Array<{ x: number; y: number }> = [];
  for (let row = 0; row < 10; row += 1) {
    for (let col = 0; col < 9; col += 1) {
      points.push({ x: XIANGQI_MARGIN_X + col * cellX, y: XIANGQI_MARGIN_Y + row * cellY });
    }
  }
  return { cellX, cellY, points };
}

/**
 * 点击坐标 → 棋盘交点。吸附到最近交点，命中半径 0.71 格（≈ 半格对角线，
 * √2/2，与五子棋 cellFromPoint 同款）——390px 视口下交点间距约 36px，
 * 热区必须整格连续不留格角死区，手指才点得准；越界返回 null。
 * `|| 0` 归一 Math.round 的负零（与五子棋同款纪律）。
 */
export function xiangqiCellFromPoint(x: number, y: number): { row: number; col: number } | null {
  const { cellX, cellY } = xiangqiGeometry();
  const col = Math.round((x - XIANGQI_MARGIN_X) / cellX) || 0;
  const row = Math.round((y - XIANGQI_MARGIN_Y) / cellY) || 0;
  if (row < 0 || row >= 10 || col < 0 || col >= 9) return null;
  const dx = Math.abs(x - (XIANGQI_MARGIN_X + col * cellX));
  const dy = Math.abs(y - (XIANGQI_MARGIN_Y + row * cellY));
  if (Math.hypot(dx, dy) > Math.min(cellX, cellY) * 0.71) return null;
  return { row, col };
}

// ---------------------------------------------------------------------------
// 房间内聊天（纯逻辑；批次：房间实时讨论）
// ---------------------------------------------------------------------------

/**
 * 聊天页签的可见性：all 恒在（默认全员频道）；wolves 页签仅狼人可见（资格
 * 由 R2 狼人杀批次从引擎视图传入，五子棋没有狼恒 false）；dead 页签给观战
 * 与出局者（观战频道）。顺序固定：all → wolves → dead，页签渲染稳定。
 */
export function chatTabsFor(
  role: "player" | "spectator",
  membership: { wolf?: boolean; dead?: boolean } = {},
): GameChatChannel[] {
  const tabs: GameChatChannel[] = ["all"];
  if (membership.wolf === true) tabs.push("wolves");
  if (role === "spectator" || membership.dead === true) tabs.push("dead");
  return tabs;
}

/**
 * 服务端推送合入本地列表：按 seq 去重（服务端重复投递/回显与广播竞态的
 * 防御），再按 seq 升序稳定排列。发送端不做乐观上屏——回显即上屏（恰好
 * 一份），被服务端拒绝的消息永远不会出现在列表里。
 */
export function mergeChatMessage(prev: GameChatMessage[], incoming: GameChatMessage): GameChatMessage[] {
  if (prev.some((message) => message.seq === incoming.seq)) return prev;
  return [...prev, incoming].sort((a, b) => a.seq - b.seq);
}

/** 当前频道可见的消息（ChatPanel 列表数据源；切换页签即过滤）。 */
export function filterChatByChannel(messages: GameChatMessage[], channel: GameChatChannel): GameChatMessage[] {
  return messages.filter((message) => message.channel === channel);
}

// ---------------------------------------------------------------------------
// 飞行棋（游戏批次 X2-C 客户端）：视图收敛、棋盘几何与反弹展示
// ---------------------------------------------------------------------------
//
// 与服务端 ludo.ts 的分工：权威判定（掷骰/落点链/撞机/胜负）全在引擎，客户端
// 只做「渲染 + 可点性裁剪」。这里放三块纯逻辑：
// - parseLudoView：服务端载荷防御收敛（形状不对整包拒绝返回 null，屏层落错误态）；
// - 棋盘几何：path(0..56) → 15×15 网格坐标（52 格主环 + 4 条 5 格终点跑道 +
//   中心终点），与引擎 ludoLoopCell(色号, pos) 的主环恒等式严格对齐；
// - 反弹展示：终点需要精确步数、超出即反弹（final = 2×56 − target，引擎同式），
//   客户端独立复算用于「反弹预览」提示，不做任何权威判定。
//
// 飞行棋无隐藏信息：引擎的玩家视图与公开视图同一局面（仅多 yourSeat），这里
// 的收敛对两种视图同构处理。

export { LUDO_FINISH_POS, LUDO_LOOP_CELLS, LUDO_LOOP_TOP, LUDO_PLANES_PER_PLAYER, LUDO_SEAT_COLORS };

export type LudoPhase = "await_roll" | "await_move";

/** 视图里的座位（ludoEngine viewPayload.seats 条目；不含任何私密信息）。 */
export interface LudoSeatView {
  seatIndex: number;
  colorIndex: number;
  color: string;
  /** 每架飞机的 path 位置（null = 待机机库，56 = 已到达）。 */
  planes: Array<number | null>;
  arrived: number;
  resigned: boolean;
}

/** 落点链一段（起飞/前进/跳跃/飞行，客户端只渲染不复算）。 */
export interface LudoHopView {
  kind: "takeoff" | "move" | "jump" | "fly";
  to: number;
}

export interface LudoMoveRecordView {
  ply: number;
  seatIndex: number;
  colorIndex: number;
  roll: number;
  planeSlot: number;
  from: number | null;
  to: number;
  hops: LudoHopView[];
  captures: Array<{ seatIndex: number; colorIndex: number; planeSlot: number }>;
  text: string;
}

export interface LudoEventView {
  ply: number;
  seatIndex: number | null;
  kind: "skip" | "penalty" | "timeout" | "resign" | "win";
  text: string;
}

export interface LudoOutcomeView {
  result: string;
  winnerSeat: number | null;
  reason: string | null;
}

/** 规则快照（引擎 viewPayload.rules 的客户端形状；捷径虚线按它画）。 */
export interface LudoRulesView {
  turnMs: number;
  extraRollOnSix: boolean;
  maxConsecutiveSixes: number;
  jumpStep: number;
  flyStep: number;
  flyPos: number;
}

export interface LudoView {
  seats: LudoSeatView[];
  planesPerPlayer: number;
  loopCells: number;
  stretchCells: number;
  finishPos: number;
  turnSeat: number;
  phase: LudoPhase;
  lastRoll: number | null;
  sixStreak: number;
  /** 当前待走方的可动飞机槽位（await_move 时非空，服务端权威）。 */
  legalPlanes: number[];
  rules: LudoRulesView;
  history: LudoMoveRecordView[];
  events: LudoEventView[];
  outcome: LudoOutcomeView | null;
  /** 玩家视图专属：你的座位号；观战/公开视图为 null。 */
  yourSeat: number | null;
}

function isLudoPhase(value: unknown): value is LudoPhase {
  return value === "await_roll" || value === "await_move";
}

function parseLudoPlanePos(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > LUDO_FINISH_POS) return null;
  return value;
}

/**
 * 把 ludoEngine 的视图载荷收敛成 LudoView。seats/turnSeat/phase 是渲染硬前提，
 * 形状不对整包拒绝（返回 null）；其余字段逐个容错（缺失给中性默认值）。
 */
export function parseLudoView(payload: unknown): LudoView | null {
  if (payload === null || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.turnSeat !== "number" || !Number.isInteger(record.turnSeat)) return null;
  if (!isLudoPhase(record.phase)) return null;
  if (!Array.isArray(record.seats)) return null;

  const seats: LudoSeatView[] = [];
  for (const seat of record.seats) {
    if (!seat || typeof seat !== "object") continue;
    const entry = seat as Record<string, unknown>;
    if (typeof entry.seatIndex !== "number" || !Number.isInteger(entry.seatIndex)) continue;
    if (typeof entry.colorIndex !== "number" || !Number.isInteger(entry.colorIndex)) continue;
    if (!Array.isArray(entry.planes) || entry.planes.length !== LUDO_PLANES_PER_PLAYER) continue;
    const planes: Array<number | null> = [];
    let planesValid = true;
    for (const pos of entry.planes) {
      const parsed = parseLudoPlanePos(pos);
      if (parsed === null && pos !== null) {
        planesValid = false;
        break;
      }
      planes.push(parsed);
    }
    if (!planesValid) continue;
    seats.push({
      seatIndex: entry.seatIndex,
      colorIndex: entry.colorIndex,
      color: typeof entry.color === "string" ? entry.color : (LUDO_SEAT_COLORS[entry.colorIndex] ?? "?"),
      planes,
      arrived: typeof entry.arrived === "number" ? entry.arrived : 0,
      resigned: entry.resigned === true,
    });
  }
  if (seats.length === 0) return null;

  const rulesRecord =
    record.rules !== null && typeof record.rules === "object" ? (record.rules as Record<string, unknown>) : {};
  const rules: LudoRulesView = {
    turnMs: typeof rulesRecord.turnMs === "number" ? rulesRecord.turnMs : 60_000,
    extraRollOnSix: rulesRecord.extraRollOnSix !== false,
    maxConsecutiveSixes: typeof rulesRecord.maxConsecutiveSixes === "number" ? rulesRecord.maxConsecutiveSixes : 3,
    jumpStep: typeof rulesRecord.jumpStep === "number" ? rulesRecord.jumpStep : 4,
    flyStep: typeof rulesRecord.flyStep === "number" ? rulesRecord.flyStep : 12,
    flyPos: typeof rulesRecord.flyPos === "number" ? rulesRecord.flyPos : 20,
  };

  const history: LudoMoveRecordView[] = [];
  if (Array.isArray(record.history)) {
    for (const item of record.history) {
      if (!item || typeof item !== "object") continue;
      const move = item as Record<string, unknown>;
      if (typeof move.ply !== "number" || typeof move.seatIndex !== "number") continue;
      if (typeof move.roll !== "number" || typeof move.planeSlot !== "number") continue;
      if (typeof move.to !== "number" || !Array.isArray(move.hops) || !Array.isArray(move.captures)) continue;
      history.push({
        ply: move.ply,
        seatIndex: move.seatIndex,
        colorIndex: typeof move.colorIndex === "number" ? move.colorIndex : 0,
        roll: move.roll,
        planeSlot: move.planeSlot,
        from: move.from === null ? null : typeof move.from === "number" ? move.from : null,
        to: move.to,
        hops: move.hops.filter(
          (hop): hop is LudoHopView =>
            !!hop &&
            typeof hop === "object" &&
            ["takeoff", "move", "jump", "fly"].includes((hop as Record<string, unknown>).kind as string) &&
            typeof (hop as Record<string, unknown>).to === "number",
        ),
        captures: move.captures.filter(
          (cap): cap is LudoMoveRecordView["captures"][number] =>
            !!cap &&
            typeof cap === "object" &&
            typeof (cap as Record<string, unknown>).seatIndex === "number" &&
            typeof (cap as Record<string, unknown>).planeSlot === "number",
        ),
        text: typeof move.text === "string" ? move.text : "",
      });
    }
  }

  const events: LudoEventView[] = [];
  if (Array.isArray(record.events)) {
    for (const item of record.events) {
      if (!item || typeof item !== "object") continue;
      const event = item as Record<string, unknown>;
      if (typeof event.text !== "string") continue;
      events.push({
        ply: typeof event.ply === "number" ? event.ply : 0,
        seatIndex: typeof event.seatIndex === "number" ? event.seatIndex : null,
        kind:
          event.kind === "skip" ||
          event.kind === "penalty" ||
          event.kind === "timeout" ||
          event.kind === "resign" ||
          event.kind === "win"
            ? event.kind
            : "skip",
        text: event.text,
      });
    }
  }

  const outcomeRecord =
    record.outcome !== null && typeof record.outcome === "object" ? (record.outcome as Record<string, unknown>) : null;
  const outcome = outcomeRecord
    ? {
        result: typeof outcomeRecord.result === "string" ? outcomeRecord.result : "",
        winnerSeat: typeof outcomeRecord.winnerSeat === "number" ? outcomeRecord.winnerSeat : null,
        reason: typeof outcomeRecord.reason === "string" ? outcomeRecord.reason : null,
      }
    : null;

  const legalPlanes: number[] = [];
  if (Array.isArray(record.legalPlanes)) {
    for (const slot of record.legalPlanes) {
      if (typeof slot === "number" && Number.isInteger(slot) && slot >= 0 && slot < LUDO_PLANES_PER_PLAYER) {
        legalPlanes.push(slot);
      }
    }
  }

  return {
    seats,
    planesPerPlayer: typeof record.planesPerPlayer === "number" ? record.planesPerPlayer : LUDO_PLANES_PER_PLAYER,
    loopCells: typeof record.loopCells === "number" ? record.loopCells : LUDO_LOOP_CELLS,
    stretchCells: typeof record.stretchCells === "number" ? record.stretchCells : 6,
    finishPos: typeof record.finishPos === "number" ? record.finishPos : LUDO_FINISH_POS,
    turnSeat: record.turnSeat,
    phase: record.phase,
    lastRoll:
      typeof record.lastRoll === "number" && record.lastRoll >= 1 && record.lastRoll <= 6 ? record.lastRoll : null,
    sixStreak: typeof record.sixStreak === "number" ? record.sixStreak : 0,
    legalPlanes,
    rules,
    history,
    events,
    outcome,
    yourSeat: typeof record.yourSeat === "number" ? record.yourSeat : null,
  };
}

// ---------------------------------------------------------------------------
// 棋盘几何（LudoBoard 渲染用；纯函数可单测）
// ---------------------------------------------------------------------------

/** 15×15 标准飞行棋/Ludo 网格（四角机场 + 十字航线 + 中心终点）。 */
export const LUDO_GRID = 15;

export interface LudoGridPoint {
  row: number;
  col: number;
}

/**
 * 52 格主环的标准网格坐标（顺时针）。下标 = 引擎的 loopCell 号，恒等式：
 * loopCell 0 = 红（色号 0）起飞格 (6,1)，loopCell 13c = 色号 c 的起飞格，
 * 色号 = loopCell % 4（与引擎「主环按 4 色循环着色」一致）。
 */
export const LUDO_TRACK_CELLS: LudoGridPoint[] = [
  { row: 6, col: 1 },
  { row: 6, col: 2 },
  { row: 6, col: 3 },
  { row: 6, col: 4 },
  { row: 6, col: 5 },
  { row: 5, col: 6 },
  { row: 4, col: 6 },
  { row: 3, col: 6 },
  { row: 2, col: 6 },
  { row: 1, col: 6 },
  { row: 0, col: 6 },
  { row: 0, col: 7 },
  { row: 0, col: 8 },
  { row: 1, col: 8 },
  { row: 2, col: 8 },
  { row: 3, col: 8 },
  { row: 4, col: 8 },
  { row: 5, col: 8 },
  { row: 6, col: 9 },
  { row: 6, col: 10 },
  { row: 6, col: 11 },
  { row: 6, col: 12 },
  { row: 6, col: 13 },
  { row: 6, col: 14 },
  { row: 7, col: 14 },
  { row: 8, col: 14 },
  { row: 8, col: 13 },
  { row: 8, col: 12 },
  { row: 8, col: 11 },
  { row: 8, col: 10 },
  { row: 8, col: 9 },
  { row: 9, col: 8 },
  { row: 10, col: 8 },
  { row: 11, col: 8 },
  { row: 12, col: 8 },
  { row: 13, col: 8 },
  { row: 14, col: 8 },
  { row: 14, col: 7 },
  { row: 14, col: 6 },
  { row: 13, col: 6 },
  { row: 12, col: 6 },
  { row: 11, col: 6 },
  { row: 10, col: 6 },
  { row: 9, col: 6 },
  { row: 8, col: 5 },
  { row: 8, col: 4 },
  { row: 8, col: 3 },
  { row: 8, col: 2 },
  { row: 8, col: 1 },
  { row: 8, col: 0 },
  { row: 7, col: 0 },
  { row: 6, col: 0 },
];

/** 主环格号 → 网格坐标（越界 null）。 */
export function ludoTrackPoint(loopCell: number): LudoGridPoint | null {
  const cell = LUDO_TRACK_CELLS[loopCell];
  return cell ? { row: cell.row, col: cell.col } : null;
}

/**
 * 每色 5 格终点跑道（path 51..55）的网格坐标，按行进方向排列。
 * 位置由主环恒等式反推：跑道口在主环格 13c−2（该色航线绕行一周后的转角格），
 * 跑道沿其所在臂的中线向中心延伸——红在左臂第 7 行、黄在顶臂第 7 列，
 * 蓝/绿对角镜像。
 */
export const LUDO_STRETCH_CELLS_BY_COLOR: LudoGridPoint[][] = [
  [
    { row: 7, col: 1 },
    { row: 7, col: 2 },
    { row: 7, col: 3 },
    { row: 7, col: 4 },
    { row: 7, col: 5 },
  ],
  [
    { row: 1, col: 7 },
    { row: 2, col: 7 },
    { row: 3, col: 7 },
    { row: 4, col: 7 },
    { row: 5, col: 7 },
  ],
  [
    { row: 7, col: 13 },
    { row: 7, col: 12 },
    { row: 7, col: 11 },
    { row: 7, col: 10 },
    { row: 7, col: 9 },
  ],
  [
    { row: 13, col: 7 },
    { row: 12, col: 7 },
    { row: 11, col: 7 },
    { row: 10, col: 7 },
    { row: 9, col: 7 },
  ],
];

/** 四角机场（机位）的 4 个停机位坐标（2×2 排布，色号 0红/1黄/2蓝/3绿 对角）。 */
export const LUDO_HANGAR_SLOTS_BY_COLOR: LudoGridPoint[][] = [
  [
    { row: 1, col: 1 },
    { row: 1, col: 3 },
    { row: 3, col: 1 },
    { row: 3, col: 3 },
  ],
  [
    { row: 1, col: 11 },
    { row: 1, col: 13 },
    { row: 3, col: 11 },
    { row: 3, col: 13 },
  ],
  [
    { row: 11, col: 11 },
    { row: 11, col: 13 },
    { row: 13, col: 11 },
    { row: 13, col: 13 },
  ],
  [
    { row: 11, col: 1 },
    { row: 11, col: 3 },
    { row: 13, col: 1 },
    { row: 13, col: 3 },
  ],
];

/**
 * 已到达飞机（path 56）在中心终点的展示位：终点 3×3 区按四色三角分象，
 * 飞机停在各自颜色的三角内，四色同到也不重叠。
 */
export const LUDO_FINISH_POINTS_BY_COLOR: LudoGridPoint[] = [
  { row: 7, col: 6.4 },
  { row: 6.4, col: 7 },
  { row: 7, col: 7.6 },
  { row: 7.6, col: 7 },
];

/**
 * 飞机位置（path 值）→ 网格坐标。主环段（0..50）经引擎 ludoLoopCell 换算成
 * 共享格号；跑道（51..55）与终点（56）是该色私有坐标。null（待机）没有
 * path 语义——机位坐标带槽位信息，由 LudoBoard 用 ludoHangarPoint 直取；
 * 越界/未知道具返回 null（屏层不渲染该机）。
 */
export function ludoPathPoint(colorIndex: number, pos: number | null): LudoGridPoint | null {
  // 色号只有 0..3：脏数据（座位色越界）直接不渲染，绝不静默映射到别的颜色。
  if (!Number.isInteger(colorIndex) || colorIndex < 0 || colorIndex > 3) return null;
  if (pos === null) return null;
  if (pos >= 0 && pos <= LUDO_LOOP_TOP) {
    const cell = ludoLoopCell(colorIndex, pos);
    return cell === null ? null : ludoTrackPoint(cell);
  }
  if (pos >= LUDO_LOOP_TOP + 1 && pos <= LUDO_FINISH_POS - 1) {
    return LUDO_STRETCH_CELLS_BY_COLOR[colorIndex]?.[pos - LUDO_LOOP_TOP - 1] ?? null;
  }
  if (pos === LUDO_FINISH_POS) {
    return LUDO_FINISH_POINTS_BY_COLOR[colorIndex] ?? null;
  }
  return null;
}

/** 机库停机位（色号 + 槽位 0..3）→ 网格坐标。 */
export function ludoHangarPoint(colorIndex: number, planeSlot: number): LudoGridPoint | null {
  return LUDO_HANGAR_SLOTS_BY_COLOR[colorIndex]?.[planeSlot] ?? null;
}

// ---------------------------------------------------------------------------
// 反弹展示（终点精确步数：超出即反弹，与引擎 planLudoMove 同式）
// ---------------------------------------------------------------------------

export interface LudoBouncePreview {
  /** 反弹后的最终落点 path（56 = 恰好到达）。 */
  final: number;
  /** 是否发生反弹（超出终点才弹）。 */
  bounced: boolean;
}

/**
 * 反弹计算展示：航线上飞机走 roll 步后的落点。终点需要精确步数，超出即
 * 反弹 final = 2×终点 − 目标（只发生在终点跑道，永不弹回主环）。
 * 待机（null）/已到达（56）没有前进语义 → 返回 null（屏层不显示预览）。
 * 纯展示辅助：主环段的跳跃/飞行链条由服务端权威结算，这里不复算。
 */
export function ludoBounceLanding(from: number | null, roll: number): LudoBouncePreview | null {
  if (from === null || from >= LUDO_FINISH_POS) return null;
  if (!Number.isInteger(roll) || roll < 1 || roll > 6) return null;
  const target = from + roll;
  if (target > LUDO_FINISH_POS) {
    return { final: 2 * LUDO_FINISH_POS - target, bounced: true };
  }
  return { final: target, bounced: false };
}

/**
 * 一手棋谱的反弹标注：起点在终点跑道（51..55）、掷点越过了终点而最终落点
 * 与反弹公式一致 → 返回「（反弹）」注记，历史行渲染时拼在服务端文案后；
 * 其余情况返回空串。
 */
export function ludoBounceNote(from: number | null, roll: number, to: number): string {
  if (from === null || from < LUDO_LOOP_TOP + 1) return "";
  const preview = ludoBounceLanding(from, roll);
  return preview !== null && preview.bounced && preview.final === to ? "（反弹）" : "";
}

// ---------------------------------------------------------------------------
// 斗地主（游戏批次 F2 客户端）：视图收敛、手牌排序与牌型预判文案
// ---------------------------------------------------------------------------
//
// 与服务端 doudizhu.ts 的分工：权威判定（牌型/大小/持有校验）全在引擎，客户端
// 只做「渲染 + 即时预判提示」。牌码/牌型识别直接复用服务端引擎的纯函数
// （classifyDoudizhuPlay/beatsDoudizhuPlay/doudizhuCardLabel，零副作用），绝不
// 复刻第二份牌型恒等式——漂移即提示错乱，单一事实来源在引擎。服务端仍是唯一
// 裁决者：预判只挡明显不合法的选择，最终以服务端 action_result 为准。

export {
  DOU_DIZHU_RANK_LABELS,
  doudizhuCardLabel,
  doudizhuCardRank,
  classifyDoudizhuPlay,
  beatsDoudizhuPlay,
} from "../../../src/game/multiplayer/engines/doudizhu";

/** 视图里的座位（doudizhuEngine viewPayload.seats 条目；不含任何手牌牌面）。 */
export interface DoudizhuSeatView {
  seatIndex: number;
  /**
   * 座位 → 座位令牌（修复 1：与信封 players 同一公开标识；昵称对位的唯一可靠
   * 依据——中途离席后信封「在座行序 ≠ 座位序」）。旧部署载荷缺该字段时为 null。
   */
  seatToken: string | null;
  handCount: number;
  isLandlord: boolean;
  isBidTurn: boolean;
  resigned: boolean;
  playedCount: number;
}

/** 上一手牌（公开信息：打出的牌全场可见）。 */
export interface DoudizhuLastPlayView {
  seatIndex: number;
  cards: string[];
  type: string;
}

/** 倍数拆解（进行中恒 spring=1；春天倍数只在结算落定）。 */
export interface DoudizhuMultiplierView {
  base: number;
  bid: number;
  bombs: number;
  spring: number;
}

export interface DoudizhuPlayRecordView {
  ply: number;
  seatIndex: number;
  kind: "bid" | "play" | "pass";
  score?: number;
  cards?: string[];
  playType?: string;
  text: string;
}

export interface DoudizhuEventView {
  ply: number;
  seatIndex: number | null;
  kind: string;
  text: string;
}

export interface DoudizhuOutcomeView {
  result: string;
  winnerSeat: number | null;
  winnerSide: "landlord" | "farmers" | null;
  reason: string | null;
  spring: string;
}

/** 斗地主视图载荷（doudizhuEngine 的 view 字段）的客户端收敛形状。 */
export interface DoudizhuView {
  seats: DoudizhuSeatView[];
  /** 只有查看者自己的手牌（观战/公开视图为空表——私有视图纪律）。 */
  hand: string[];
  bottomCount: number;
  /** 底牌：地主确定后全场公开，此前为 null。 */
  bottomCards: string[] | null;
  phase: "bidding" | "playing";
  bidTurn: number;
  bids: Array<{ seatIndex: number; score: number }>;
  currentBid: { seatIndex: number; score: number } | null;
  landlordSeat: number | null;
  bidScore: number;
  currentTurn: number;
  lastPlay: DoudizhuLastPlayView | null;
  /** 跟牌才能过；自由出必须出牌（客户端据此裁剪「不出」按钮）。 */
  canPass: boolean;
  bombCount: number;
  multiplier: DoudizhuMultiplierView;
  history: DoudizhuPlayRecordView[];
  events: DoudizhuEventView[];
  outcome: DoudizhuOutcomeView | null;
  redealCount: number;
  /** 玩家视图专属：你的座位号；观战/公开视图为 null。 */
  yourSeat: number | null;
}

function isDoudizhuPhase(value: unknown): value is "bidding" | "playing" {
  return value === "bidding" || value === "playing";
}

/** 手牌/出牌历史里的牌码逐张校验（脏码整包拒绝——服务端协议损坏时落错误态）。 */
function parseCardCodes(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const cards: string[] = [];
  for (const card of value) {
    if (typeof card !== "string" || doudizhuCardRank(card) === null) return null;
    cards.push(card);
  }
  return cards;
}

/**
 * 把 doudizhuEngine 的视图载荷收敛成 DoudizhuView。seats/phase 是渲染硬前提，
 * 形状不对整包拒绝（返回 null）；手牌逐张过 doudizhuCardRank 校验；其余字段
 * 逐个容错（缺失给中性默认值）。
 */
export function parseDoudizhuView(payload: unknown): DoudizhuView | null {
  if (payload === null || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (!isDoudizhuPhase(record.phase)) return null;
  if (!Array.isArray(record.seats)) return null;
  const hand = parseCardCodes(record.hand);
  if (hand === null) return null;

  const seats: DoudizhuSeatView[] = [];
  for (const seat of record.seats) {
    if (!seat || typeof seat !== "object") continue;
    const entry = seat as Record<string, unknown>;
    if (typeof entry.seatIndex !== "number" || !Number.isInteger(entry.seatIndex)) continue;
    if (typeof entry.handCount !== "number" || !Number.isInteger(entry.handCount) || entry.handCount < 0) continue;
    seats.push({
      seatIndex: entry.seatIndex,
      seatToken: typeof entry.seatToken === "string" && entry.seatToken ? entry.seatToken : null,
      handCount: entry.handCount,
      isLandlord: entry.isLandlord === true,
      isBidTurn: entry.isBidTurn === true,
      resigned: entry.resigned === true,
      playedCount: typeof entry.playedCount === "number" ? entry.playedCount : 0,
    });
  }
  if (seats.length === 0) return null;

  const bids: Array<{ seatIndex: number; score: number }> = [];
  if (Array.isArray(record.bids)) {
    for (const bid of record.bids) {
      if (!bid || typeof bid !== "object") continue;
      const entry = bid as Record<string, unknown>;
      if (typeof entry.seatIndex !== "number" || typeof entry.score !== "number") continue;
      bids.push({ seatIndex: entry.seatIndex, score: entry.score });
    }
  }

  const currentBidRecord =
    record.currentBid !== null && typeof record.currentBid === "object"
      ? (record.currentBid as Record<string, unknown>)
      : null;
  const currentBid =
    currentBidRecord && typeof currentBidRecord.seatIndex === "number" && typeof currentBidRecord.score === "number"
      ? { seatIndex: currentBidRecord.seatIndex, score: currentBidRecord.score }
      : null;

  const lastPlayRecord =
    record.lastPlay !== null && typeof record.lastPlay === "object"
      ? (record.lastPlay as Record<string, unknown>)
      : null;
  let lastPlay: DoudizhuLastPlayView | null = null;
  if (lastPlayRecord) {
    const cards = parseCardCodes(lastPlayRecord.cards);
    if (cards === null) return null;
    if (typeof lastPlayRecord.seatIndex === "number" && typeof lastPlayRecord.type === "string") {
      lastPlay = { seatIndex: lastPlayRecord.seatIndex, cards, type: lastPlayRecord.type };
    }
  }

  const bottomCards =
    record.bottomCards === null
      ? null
      : parseCardCodes(record.bottomCards) === null
        ? null
        : (record.bottomCards as string[]);
  if (record.bottomCards !== null && bottomCards === null) return null;

  const multiplierRecord =
    record.multiplier !== null && typeof record.multiplier === "object"
      ? (record.multiplier as Record<string, unknown>)
      : {};
  const multiplier: DoudizhuMultiplierView = {
    base: typeof multiplierRecord.base === "number" ? multiplierRecord.base : 1,
    bid: typeof multiplierRecord.bid === "number" ? multiplierRecord.bid : 0,
    bombs: typeof multiplierRecord.bombs === "number" ? multiplierRecord.bombs : 0,
    spring: typeof multiplierRecord.spring === "number" ? multiplierRecord.spring : 1,
  };

  const history: DoudizhuPlayRecordView[] = [];
  if (Array.isArray(record.history)) {
    for (const item of record.history) {
      if (!item || typeof item !== "object") continue;
      const move = item as Record<string, unknown>;
      if (typeof move.ply !== "number" || typeof move.seatIndex !== "number") continue;
      if (move.kind !== "bid" && move.kind !== "play" && move.kind !== "pass") continue;
      const cards = move.cards === undefined ? undefined : parseCardCodes(move.cards);
      if (cards === null) continue;
      history.push({
        ply: move.ply,
        seatIndex: move.seatIndex,
        kind: move.kind,
        ...(typeof move.score === "number" ? { score: move.score } : {}),
        ...(cards !== undefined ? { cards } : {}),
        ...(typeof move.playType === "string" ? { playType: move.playType } : {}),
        text: typeof move.text === "string" ? move.text : "",
      });
    }
  }

  const events: DoudizhuEventView[] = [];
  if (Array.isArray(record.events)) {
    for (const item of record.events) {
      if (!item || typeof item !== "object") continue;
      const event = item as Record<string, unknown>;
      if (typeof event.text !== "string") continue;
      events.push({
        ply: typeof event.ply === "number" ? event.ply : 0,
        seatIndex: typeof event.seatIndex === "number" ? event.seatIndex : null,
        kind: typeof event.kind === "string" ? event.kind : "",
        text: event.text,
      });
    }
  }

  const outcomeRecord =
    record.outcome !== null && typeof record.outcome === "object" ? (record.outcome as Record<string, unknown>) : null;
  const winnerSideRaw = outcomeRecord?.winnerSide;
  const winnerSide =
    winnerSideRaw === "landlord" ? ("landlord" as const) : winnerSideRaw === "farmers" ? ("farmers" as const) : null;
  const outcome = outcomeRecord
    ? {
        result: typeof outcomeRecord.result === "string" ? outcomeRecord.result : "aborted",
        winnerSeat:
          typeof outcomeRecord.winnerSeat === "number" && Number.isInteger(outcomeRecord.winnerSeat)
            ? outcomeRecord.winnerSeat
            : null,
        winnerSide,
        reason: typeof outcomeRecord.reason === "string" ? outcomeRecord.reason : null,
        spring: typeof outcomeRecord.spring === "string" ? outcomeRecord.spring : "none",
      }
    : null;

  return {
    seats,
    hand,
    bottomCount: typeof record.bottomCount === "number" ? record.bottomCount : 3,
    bottomCards,
    phase: record.phase,
    bidTurn: typeof record.bidTurn === "number" ? record.bidTurn : 0,
    bids,
    currentBid,
    landlordSeat: typeof record.landlordSeat === "number" ? record.landlordSeat : null,
    bidScore: typeof record.bidScore === "number" ? record.bidScore : 0,
    currentTurn: typeof record.currentTurn === "number" ? record.currentTurn : 0,
    lastPlay,
    canPass: record.canPass === true,
    bombCount: typeof record.bombCount === "number" ? record.bombCount : 0,
    multiplier,
    history,
    events,
    outcome,
    redealCount: typeof record.redealCount === "number" ? record.redealCount : 0,
    yourSeat: typeof record.yourSeat === "number" ? record.yourSeat : null,
  };
}

/** 手牌排序方向：desc = 点数大在前（服务端默认序），asc = 点数小在前（可切换）。 */
export type DoudizhuSortDir = "desc" | "asc";

/**
 * 手牌按点数排序（客户端展示用）：desc/asc 两档切换，同点数按牌码稳定排列。
 * 纯函数（不改原数组）；牌码合法性由 parseDoudizhuView 保证，非法码沉底。
 */
export function doudizhuHandSort(cards: string[], dir: DoudizhuSortDir): string[] {
  return [...cards].sort((a, b) => {
    const ra = doudizhuCardRank(a) ?? -1;
    const rb = doudizhuCardRank(b) ?? -1;
    return dir === "desc" ? rb - ra || a.localeCompare(b) : ra - rb || a.localeCompare(b);
  });
}

/**
 * 牌型即时预判文案（客户端展示辅助；服务端是唯一裁决者）：
 * - 未选牌 → null（不显示提示）；
 * - 不是合法牌型 → 「不是合法的斗地主牌型」；
 * - 自由出 → 「牌型名 · 可出」；
 * - 跟牌压不过 → 「牌型名 · 压不过上一手（上一手牌型名）」；
 * - 跟牌压过 → 「牌型名 · 可出」。
 */
export function doudizhuPlayHint(selected: string[], lastPlay: DoudizhuLastPlayView | null): string | null {
  if (selected.length === 0) return null;
  const shape = classifyDoudizhuPlay(selected);
  if (shape === null) return "不是合法的斗地主牌型";
  const label = DOU_DIZHU_TYPE_LABELS[shape.type] ?? shape.type;
  if (lastPlay === null) return `${label} · 可出`;
  // 上一手的形状从公开牌面复算(视图只发 cards+type,没有 keyRank/length),
  // 识别口径与服务端 applyPlay 完全一致。
  const lastShape = classifyDoudizhuPlay(lastPlay.cards);
  if (lastShape !== null && beatsDoudizhuPlay(shape, lastShape)) return `${label} · 可出`;
  return `${label} · 压不过上一手（${lastPlay.type}）`;
}

/**
 * 座位 → 展示名的共享对位实现（狼人杀 werewolfSeatName 与斗地主
 * doudizhuSeatName 同款纪律）：
 * - 首选：座位载荷的 seatToken（引擎 seats 开局固定，与信封 players 同一
 *   公开标识——修复 1 起对位键从 participantHash 换成座位令牌）→ 精确对回
 *   信封行取昵称。中途离席的座位行被 DO 保留（leftAt 置位、行序不动），引擎
 *   座位开局即固定——按「在座行序 = 座位序」猜会错位（离席者的座位显示后来
 *   者的名字），令牌对位没有这个问题；离席行匹配到时照样显示其昵称。
 * - 兜底：旧部署载荷没有座位令牌时，仅当信封每行都在座且行数与座位数一致
 *   （此时行序 = 座位序恒成立）才按行序对位，否则回退「玩家N」——宁可少
 *   显示昵称，绝不把别人的昵称挂到别的座位上。
 */
function seatDisplayName(
  players: Array<{ displayName: string | null; leftAt: string | null; seatToken: string }>,
  token: string | null,
  seatIndex: number,
  legacyOrderHolds: boolean,
): string {
  const fallback = `玩家${seatIndex + 1}`;
  if (token !== null) {
    const name = players.find((player) => player.seatToken === token)?.displayName?.trim();
    return name || fallback;
  }
  if (!legacyOrderHolds) return fallback;
  const name = players[seatIndex]?.displayName?.trim();
  return name || fallback;
}

/** 斗地主座位 → 展示名（座位令牌对位；座位缺行时回退「玩家N」）。 */
export function doudizhuSeatName(
  view: { players: Array<{ displayName: string | null; leftAt: string | null; seatToken: string }> },
  dd: Pick<DoudizhuView, "seats">,
  seatIndex: number,
): string {
  const seat = dd.seats[seatIndex];
  if (!seat) return `玩家${seatIndex + 1}`;
  const legacyOrderHolds =
    seat.seatToken === null &&
    view.players.length === dd.seats.length &&
    view.players.every((player) => player.leftAt === null);
  return seatDisplayName(view.players, seat.seatToken, seatIndex, legacyOrderHolds);
}

// ---------------------------------------------------------------------------
// 狼人杀（游戏批次 R2 客户端）：视图收敛、阶段/票数展示纯逻辑与房主配置
// ---------------------------------------------------------------------------
//
// 与服务端 werewolf.ts 的分工：权威判定（夜晚结算/计票/胜负/身份）全在引擎，
// 客户端只做「渲染 + 挡掉必被拒的本地预判」。身份键全集/身份中文名/发言字数
// 上限/标准板推导直接复用服务端引擎的纯函数与常量（零副作用），单一事实来源
// 在引擎。
//
// 私有视图纪律（条目 5）：客户端只持有引擎下发的「自己的」角色与技能面
// （yourRole/wolfMates/checkResults/potions/lastGuarded/tonightKnife）——他人
// 身份从协议形状上就不在载荷里，UI 无需任何隐藏逻辑；本解析器也绝不从公开
// 字段反推他人身份（seats 投影只有 seatIndex/哈希/alive/isYou）。

export { WEREWOLF_ALL_ROLES, WEREWOLF_ROLE_LABELS, WEREWOLF_SPEECH_MAX_CHARS, werewolfBoard };
export type { WerewolfPhase, WerewolfRole, WerewolfRolePlan } from "../../../src/game/multiplayer/engines/werewolf";

/** 视图里的座位（werewolfEngine viewPayload.seats 条目；不含任何角色/死因）。 */
export interface WerewolfSeatView {
  seatIndex: number;
  /** 座位 → 座位令牌（修复 1：与信封 players 同一公开标识；旧部署缺该字段时 null）。 */
  seatToken: string | null;
  alive: boolean;
  isYou: boolean;
}

/** 事件流水一条（服务端已按 audience 裁剪，客户端只渲染不复算可见性）。 */
export interface WerewolfEventView {
  seq: number;
  day: number;
  kind: string;
  text: string;
}

/** 一条白天发言（skipped = 超时托管放弃）。 */
export interface WerewolfSpeechView {
  day: number;
  seatIndex: number;
  skipped: boolean;
  text: string;
}

/** 预言家查验记录（仅预言家视图有，公开视图/他人视图为 null）。 */
export interface WerewolfCheckView {
  night: number;
  seatIndex: number;
  isWolf: boolean;
}

export interface WerewolfOutcomeView {
  result: string;
  winnerSide: "good" | "wolves" | null;
  reason: string | null;
}

/**
 * 狼人杀视图载荷（werewolfEngine 的 view 字段）的客户端收敛形状。
 * yourRole/yourAlive 及五个私有技能面只在玩家视图里出现，观战/公开视图为
 * null——「我是谁」从载荷自取，观战者为 null（与 gomoku yourColor 同口径）。
 */
export interface WerewolfView {
  day: number;
  phase: WerewolfPhase;
  seats: WerewolfSeatView[];
  aliveSeats: number[];
  deadSeats: number[];
  /** 最新公布的死讯（座位名单，无死因无身份）。 */
  lastNightDeaths: number[];
  /** 当前发言者座位（仅 day_speak 阶段非空）。 */
  speakTurnSeat: number | null;
  speeches: WerewolfSpeechView[];
  votesNeeded: number;
  votesSubmitted: number;
  myVoteSubmitted: boolean;
  /** PK 候选座位（null = 非 PK 轮）。 */
  pkCandidates: number[] | null;
  /** 猎人开枪窗口是否开着。 */
  pendingShotOpen: boolean;
  events: WerewolfEventView[];
  outcome: WerewolfOutcomeView | null;
  /** 玩家视图专属：你的座位号；观战/公开视图为 null。 */
  yourSeat: number | null;
  // ---- 私有面（玩家视图才有；观战/公开视图恒 null）----
  yourRole: WerewolfRole | null;
  yourAlive: boolean | null;
  /** 队友座位（仅狼人）。 */
  wolfMates: number[] | null;
  /** 当夜狼刀口（仅狼人技能面）。 */
  nightKnife: number | null;
  /** 查验历史（仅预言家）。 */
  checkResults: WerewolfCheckView[] | null;
  /** 两瓶药余量（仅女巫）。 */
  potions: { save: boolean; poison: boolean } | null;
  /** 今夜刀口（仅女巫、仅 night_witch 阶段非 null）。 */
  tonightKnife: number | null;
  /** 上一夜守护目标（仅守卫；「不可连守」的判定依据）。 */
  lastGuarded: number | null;
  /** 我是否正持开枪窗口。 */
  canShoot: boolean;
  /** 开枪可选目标（服务端权威裁剪）。 */
  shotTargets: number[];
}

const WEREWOLF_PHASES = [
  "night_guard",
  "night_wolf",
  "night_seer",
  "night_witch",
  "day_speak",
  "day_vote",
  "day_pk",
  "hunter_shot",
] as const;

function isWerewolfPhase(value: unknown): value is WerewolfPhase {
  return (WEREWOLF_PHASES as readonly string[]).includes(value as string);
}

function isWerewolfRole(value: unknown): value is WerewolfRole {
  return (WEREWOLF_ALL_ROLES as readonly string[]).includes(value as string);
}

/** 数字数组的容错收敛（null/非数组 → 空表；脏条目剔除）。 */
function numberList(value: unknown, fallback: number[]): number[] {
  if (!Array.isArray(value)) return fallback;
  return value.filter((item): item is number => typeof item === "number" && Number.isInteger(item));
}

/**
 * 把 werewolfEngine 的视图载荷收敛成 WerewolfView。phase/seats 是渲染硬前提，
 * 形状不对整包拒绝（返回 null）；其余字段逐个容错（缺失给中性默认值）。
 */
export function parseWerewolfView(payload: unknown): WerewolfView | null {
  if (payload === null || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (!isWerewolfPhase(record.phase)) return null;
  if (!Array.isArray(record.seats)) return null;

  const seats: WerewolfSeatView[] = [];
  for (const seat of record.seats) {
    if (!seat || typeof seat !== "object") continue;
    const entry = seat as Record<string, unknown>;
    if (typeof entry.seatIndex !== "number" || !Number.isInteger(entry.seatIndex) || entry.seatIndex < 0) continue;
    seats.push({
      seatIndex: entry.seatIndex,
      seatToken: typeof entry.seatToken === "string" && entry.seatToken ? entry.seatToken : null,
      alive: entry.alive === true,
      isYou: entry.isYou === true,
    });
  }

  const events: WerewolfEventView[] = [];
  if (Array.isArray(record.events)) {
    for (const item of record.events) {
      if (!item || typeof item !== "object") continue;
      const event = item as Record<string, unknown>;
      if (typeof event.text !== "string") continue;
      events.push({
        seq: typeof event.seq === "number" ? event.seq : 0,
        day: typeof event.day === "number" ? event.day : 0,
        kind: typeof event.kind === "string" ? event.kind : "",
        text: event.text,
      });
    }
  }

  const speeches: WerewolfSpeechView[] = [];
  if (Array.isArray(record.speeches)) {
    for (const item of record.speeches) {
      if (!item || typeof item !== "object") continue;
      const speech = item as Record<string, unknown>;
      if (typeof speech.seatIndex !== "number") continue;
      speeches.push({
        day: typeof speech.day === "number" ? speech.day : 0,
        seatIndex: speech.seatIndex,
        skipped: speech.skipped === true,
        text: typeof speech.text === "string" ? speech.text : "",
      });
    }
  }

  const checkResults: WerewolfCheckView[] | null = Array.isArray(record.checkResults)
    ? record.checkResults
        .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
        .filter((item) => typeof item.night === "number" && typeof item.seatIndex === "number")
        .map((item) => ({
          night: item.night as number,
          seatIndex: item.seatIndex as number,
          isWolf: item.isWolf === true,
        }))
    : null;

  const potionsRecord =
    record.potions !== null && typeof record.potions === "object" ? (record.potions as Record<string, unknown>) : null;
  const potions = potionsRecord ? { save: potionsRecord.save === true, poison: potionsRecord.poison === true } : null;

  const outcomeRecord =
    record.outcome !== null && typeof record.outcome === "object" ? (record.outcome as Record<string, unknown>) : null;
  const winnerSideRaw = outcomeRecord?.winnerSide;
  const outcome: WerewolfOutcomeView | null = outcomeRecord
    ? {
        result: typeof outcomeRecord.result === "string" ? outcomeRecord.result : "aborted",
        winnerSide:
          winnerSideRaw === "good" ? ("good" as const) : winnerSideRaw === "wolves" ? ("wolves" as const) : null,
        reason: typeof outcomeRecord.reason === "string" ? outcomeRecord.reason : null,
      }
    : null;

  return {
    day: typeof record.day === "number" && Number.isInteger(record.day) && record.day >= 0 ? record.day : 0,
    phase: record.phase,
    seats,
    aliveSeats: numberList(record.aliveSeats, []),
    deadSeats: numberList(record.deadSeats, []),
    lastNightDeaths: numberList(record.lastNightDeaths, []),
    speakTurnSeat: typeof record.speakTurnSeat === "number" ? record.speakTurnSeat : null,
    speeches,
    votesNeeded: typeof record.votesNeeded === "number" ? record.votesNeeded : 0,
    votesSubmitted: typeof record.votesSubmitted === "number" ? record.votesSubmitted : 0,
    myVoteSubmitted: record.myVoteSubmitted === true,
    pkCandidates:
      record.pkCandidates === null || record.pkCandidates === undefined ? null : numberList(record.pkCandidates, []),
    pendingShotOpen: record.pendingShotOpen === true,
    events,
    outcome,
    yourSeat: typeof record.yourSeat === "number" ? record.yourSeat : null,
    yourRole: isWerewolfRole(record.yourRole) ? record.yourRole : null,
    yourAlive: typeof record.yourAlive === "boolean" ? record.yourAlive : null,
    wolfMates: Array.isArray(record.wolfMates) ? numberList(record.wolfMates, []) : null,
    nightKnife: typeof record.nightKnife === "number" ? record.nightKnife : null,
    checkResults,
    potions,
    tonightKnife: typeof record.tonightKnife === "number" ? record.tonightKnife : null,
    lastGuarded: typeof record.lastGuarded === "number" ? record.lastGuarded : null,
    canShoot: record.canShoot === true,
    shotTargets: numberList(record.shotTargets, []),
  };
}

// ---------------------------------------------------------------------------
// 阶段流转展示（日夜横幅）
// ---------------------------------------------------------------------------

/** 阶段 → 阶段名（日夜横幅副标题；单一事实来源是引擎 phase 枚举）。 */
export const WEREWOLF_PHASE_NAMES: Record<WerewolfPhase, string> = {
  night_guard: "守卫行动",
  night_wolf: "狼人行动",
  night_seer: "预言家查验",
  night_witch: "女巫用药",
  day_speak: "白天发言",
  day_vote: "投票放逐",
  day_pk: "PK 投票",
  hunter_shot: "猎人开枪",
};

function isWerewolfNight(phase: WerewolfPhase): boolean {
  return phase === "night_guard" || phase === "night_wolf" || phase === "night_seer" || phase === "night_witch";
}

/**
 * 日夜横幅主文案：夜阶段「第 N 夜」、白天阶段「第 N 天」；开局前（day 0）
 * 「未开局」。纯函数——阶段与天数都来自引擎权威状态，客户端只做措辞。
 */
export function werewolfDayLabel(day: number, phase: WerewolfPhase): string {
  if (!Number.isInteger(day) || day <= 0) return "未开局";
  return isWerewolfNight(phase) ? `第 ${day} 夜` : `第 ${day} 天`;
}

// ---------------------------------------------------------------------------
// 票数统计展示（亮票事件 → 计票摘要；纯展示，权威计票在引擎 tallyVotes）
// ---------------------------------------------------------------------------

export interface WerewolfTallyView {
  /** 得票条目（票数降序，平票按名字序；仅统计被投票者）。 */
  entries: Array<{ name: string; votes: number }>;
  /** 弃票数。 */
  abstained: number;
}

/**
 * 从事件流水收敛「最近一次亮票」的计票摘要。服务端在计票时把完整票面公示成
 * 一条 kind=vote、text 以「亮票:」开头的事件（「A→B, C→弃票」），此后 votes
 * 簿记即清空——亮票文本是客户端唯一可见的票面数据，逐段解析计数：
 * - 找不到亮票事件（还没投完/旧部署）→ null，UI 不显示摘要；
 * - 名字里恰好含「, 」或「→」的段落解析不出 → 丢弃该段（展示尽力而为，
 *   权威票面永远以事件原文为准）。
 */
export function werewolfTallyFromEvents(events: WerewolfEventView[]): WerewolfTallyView | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.kind !== "vote" || !event.text.startsWith("亮票:")) continue;
    const counts = new Map<string, number>();
    let abstained = 0;
    let parsedAny = false;
    for (const segment of event.text.slice("亮票:".length).split(", ")) {
      const arrow = segment.indexOf("→");
      if (arrow <= 0 || arrow === segment.length - 1) continue;
      parsedAny = true;
      const target = segment.slice(arrow + 1);
      if (target === "弃票") {
        abstained += 1;
      } else {
        counts.set(target, (counts.get(target) ?? 0) + 1);
      }
    }
    if (!parsedAny) return null;
    const entries = [...counts.entries()]
      .map(([name, votes]) => ({ name, votes }))
      .sort((a, b) => b.votes - a.votes || a.name.localeCompare(b.name));
    return { entries, abstained };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 目标选择本地预判（「挡掉必被拒」；权威校验在引擎 applyAction）
// ---------------------------------------------------------------------------

/**
 * 当前阶段选座目标的本地预判：合法返回 null，非法返回给用户看的中文原因。
 * 只做「不问服务端也知道会被拒」的检查（阶段/身份/存活/自指/连守/PK 候选）；
 * 女巫用药余量冲突、守护目标被挡等时序性规则交服务端判定。
 */
export function werewolfLocalTargetCheck(w: WerewolfView, target: number): string | null {
  const seat = w.seats[target];
  if (!seat) return "目标座位不存在";
  if (!seat.alive) return "目标必须存活";
  const iAmAlive = w.yourAlive === true;
  switch (w.phase) {
    case "night_guard":
      if (w.yourRole !== "guard") return "你不是守卫";
      if (!iAmAlive) return "你已出局,不能再行动";
      if (w.lastGuarded === target) return "守卫不能连续两夜守护同一人";
      return null;
    case "night_wolf":
      if (w.yourRole !== "werewolf") return "你不是狼人";
      if (!iAmAlive) return "你已出局,不能再行动";
      if (w.wolfMates !== null && w.wolfMates.includes(target)) return "不能刀自己人";
      return null;
    case "night_seer":
      if (w.yourRole !== "seer") return "你不是预言家";
      if (!iAmAlive) return "你已出局,不能再行动";
      if (target === w.yourSeat) return "预言家不能查验自己";
      return null;
    case "night_witch":
      if (w.yourRole !== "witch") return "你不是女巫";
      if (!iAmAlive) return "你已出局,不能再行动";
      if (target === w.yourSeat) return "女巫不能对自己用药";
      return null;
    case "day_vote":
    case "day_pk":
      if (!iAmAlive) return "你已出局,不能再投票";
      if (w.myVoteSubmitted) return "你已经投过票了";
      if (target === w.yourSeat) return "不能投自己";
      if (w.phase === "day_pk" && !(w.pkCandidates ?? []).includes(target)) return "PK 轮只能投 PK 候选";
      return null;
    case "hunter_shot":
      if (!w.canShoot) return "当前没有待你结算的开枪窗口";
      if (target === w.yourSeat) return "不能枪击自己";
      return null;
    default:
      return "当前阶段不需要选择目标";
  }
}

// ---------------------------------------------------------------------------
// 座位昵称与聊天频道资格
// ---------------------------------------------------------------------------

/** 狼人杀座位 → 展示名（座位令牌对位，与 doudizhuSeatName 同款纪律）。 */
export function werewolfSeatName(
  view: { players: Array<{ displayName: string | null; leftAt: string | null; seatToken: string }> },
  w: Pick<WerewolfView, "seats">,
  seatIndex: number,
): string {
  const seat = w.seats[seatIndex];
  if (!seat) return `玩家${seatIndex + 1}`;
  const legacyOrderHolds =
    seat.seatToken === null &&
    view.players.length === w.seats.length &&
    view.players.every((player) => player.leftAt === null);
  return seatDisplayName(view.players, seat.seatToken, seatIndex, legacyOrderHolds);
}

/**
 * 狼人杀视图 → 聊天频道资格（chatTabsFor 的 membership 参数）。与引擎
 * chatMembership 同口径：wolves 频道仅「存活狼人」；死亡玩家退到 dead 频道
 * （观战者的 dead 页签由 chatTabsFor 按 role 恒给，不在这里重复）。非狼人杀
 * 视图/解析失败返回 false——其它玩法的页签集合与现在完全一致。
 */
export function werewolfChatMembership(view: { gameType: string; view: unknown } | null): {
  wolf: boolean;
  dead: boolean;
} {
  if (view === null || view.gameType !== "werewolf") return { wolf: false, dead: false };
  const w = parseWerewolfView(view.view);
  if (w === null) return { wolf: false, dead: false };
  return {
    wolf: w.yourRole === "werewolf" && w.yourAlive === true,
    dead: w.yourSeat !== null && w.yourAlive === false,
  };
}

// ---------------------------------------------------------------------------
// 结算文案
// ---------------------------------------------------------------------------

/**
 * 狼人杀终局文案：阵营胜负（result good_win/wolf_win/aborted）。视角由
 * yourRole 决定（狼人视角狼胜 = 你赢了）；观战者（yourRole null）给中性文案。
 */
export function werewolfSettlementCopy(outcome: WerewolfOutcomeView, yourRole: WerewolfRole | null): SettlementCopy {
  if (outcome.result === "aborted" || outcome.winnerSide === null) {
    return { headline: "对局结束", detail: "对局中止", tone: "neutral" };
  }
  const sideText = outcome.winnerSide === "wolves" ? "狼人阵营获胜" : "好人阵营获胜";
  const reasonText =
    outcome.reason === "wipe_wolves"
      ? "狼人全部出局"
      : outcome.reason === "wolves_equal_good"
        ? "狼人人数已追平好人"
        : "";
  const detail = reasonText ? `${sideText}（${reasonText}）` : sideText;
  if (yourRole === null) return { headline: "对局结束", detail, tone: "neutral" };
  const iWon = (yourRole === "werewolf") === (outcome.winnerSide === "wolves");
  return iWon ? { headline: "你赢了！", detail, tone: "win" } : { headline: "对局结束", detail, tone: "lose" };
}

// ---------------------------------------------------------------------------
// 圆桌几何（WerewolfBoard 渲染用；纯函数可单测）
// ---------------------------------------------------------------------------

/**
 * 圆桌座位坐标（容器百分比）：座位 0 固定在正上方，顺时针均布在椭圆上
 * （水平半径 44%、垂直 40%，给座位名牌留出边距）。纯几何，与任何状态无关。
 */
export function werewolfSeatPoints(count: number): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = [];
  if (!Number.isInteger(count) || count <= 0) return points;
  for (let index = 0; index < count; index += 1) {
    const angle = -Math.PI / 2 + (2 * Math.PI * index) / count;
    points.push({ x: 50 + 44 * Math.cos(angle), y: 48 + 40 * Math.sin(angle) });
  }
  return points;
}

// ---------------------------------------------------------------------------
// 房主配置（建房 config：每阶段时限 / 托管自动刀 / 板子预设）
// ---------------------------------------------------------------------------

export interface WerewolfHostConfigForm {
  /** 每阶段时限（毫秒）：夜行动作/每人发言/一轮投票/开枪各算一个阶段。 */
  turnMs: number;
  /** 狼人全员超时未出刀时，托管随机刀一名存活好人（引擎默认开）。 */
  autoWolfKill: boolean;
  /**
   * 板子预设："auto" = 标准预女猎守板按实际开局人数推导（人数 6-12 都能开，
   * 默认）；6..12 = 固定人数板（引擎开局按座位数校验，人数不齐开不了局）。
   */
  preset: "auto" | 6 | 7 | 8 | 9 | 10 | 11 | 12;
}

export const WEREWOLF_DEFAULT_HOST_CONFIG: WerewolfHostConfigForm = {
  turnMs: 60_000,
  autoWolfKill: true,
  preset: "auto",
};

/** 房主可调的每阶段时限档位（引擎约束 5s–10min，这里只给常用三档）。 */
export const WEREWOLF_TURN_MS_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 60_000, label: "1 分钟" },
  { value: 120_000, label: "2 分钟" },
  { value: 180_000, label: "3 分钟" },
];

/** 板子预设选项（auto 放最前；固定档按人数升序）。 */
export const WEREWOLF_PRESET_OPTIONS: Array<{ value: WerewolfHostConfigForm["preset"]; label: string }> = [
  { value: "auto", label: "自动板" },
  { value: 6, label: "6 人" },
  { value: 7, label: "7 人" },
  { value: 8, label: "8 人" },
  { value: 9, label: "9 人" },
  { value: 10, label: "10 人" },
  { value: 11, label: "11 人" },
  { value: 12, label: "12 人" },
];

/**
 * 板子预设的展示文案：复用引擎 werewolfBoard 按人数推导标准板，
 * 「2狼·预言家·女巫·守卫·猎人·3民（共 9 人）」。人数越界返回空串。
 */
export function werewolfBoardSummary(seatCount: number): string {
  if (!Number.isInteger(seatCount) || seatCount < 6 || seatCount > 12) return "";
  const plan = werewolfBoard(seatCount);
  const parts = [`${plan.wolves} 狼`, "预言家", "女巫"];
  if (plan.guard) parts.push("守卫");
  if (plan.hunter) parts.push("猎人");
  parts.push(`${plan.villagers} 民`);
  return `${parts.join("·")}（共 ${seatCount} 人）`;
}

/**
 * 房主配置表单 → POST /api/game/rooms 的 config 载荷（引擎 readRules 的输入）。
 * 自动板不下发 rolePlan（引擎按实际座位数推导，人数 6-12 都能开局）；固定板
 * 下发该人数的标准板，人数不齐时由引擎开局校验拒绝（服务端仍是权威）。
 */
export function buildWerewolfRoomConfig(form: WerewolfHostConfigForm): Record<string, unknown> {
  return {
    turnMs: form.turnMs,
    autoWolfKill: form.autoWolfKill,
    ...(form.preset === "auto" ? {} : { rolePlan: werewolfBoard(form.preset) }),
  };
}
