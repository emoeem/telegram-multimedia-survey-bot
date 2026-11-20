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

export type GomokuColor = "black" | "white";

/** 玩法私有视图里的座位（gomokuEngine publicViewPayload.players）。 */
export interface GomokuSeatView {
  participantHash: string;
  color: GomokuColor;
}

export interface GomokuLastMoveView {
  row: number;
  col: number;
  color: GomokuColor;
  /** 落子者：悔棋申请的本地预判（只能撤回自己刚落下的一手）用它判定。 */
  participantHash: string;
}

export interface GomokuOutcomeView {
  result: string;
  winnerParticipantHash: string | null;
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
 * 结算/终局文案。视角由 myParticipantHash 决定（胜者是我 → 你赢了）；
 * 观战者与中止局给中性文案。result 取值来自引擎（win/draw/timeout/resign/aborted）。
 */
export function describeSettlement(
  result: string,
  winnerParticipantHash: string | null,
  myParticipantHash: string | null,
): SettlementCopy {
  if (result === "draw") return { headline: "平局", detail: "双方握手言和", tone: "draw" };
  if (result === "aborted" || !winnerParticipantHash) {
    return { headline: "对局结束", detail: "对局中止", tone: "neutral" };
  }
  const iWon = myParticipantHash !== null && winnerParticipantHash === myParticipantHash;
  const spectating = myParticipantHash === null;
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
      if (typeof entry.participantHash !== "string" || !isGomokuColor(entry.color)) continue;
      players.push({ participantHash: entry.participantHash, color: entry.color });
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
    typeof lastMoveRecord.participantHash === "string"
      ? {
          row: lastMoveRecord.row,
          col: lastMoveRecord.col,
          color: lastMoveRecord.color,
          participantHash: lastMoveRecord.participantHash,
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
        winnerParticipantHash:
          typeof outcomeRecord.winnerParticipantHash === "string" ? outcomeRecord.winnerParticipantHash : null,
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
