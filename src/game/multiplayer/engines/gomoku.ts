/**
 * 五子棋多人引擎（P0 批次 G2）——MultiplayerGameEngine 的第一个真实实现。
 *
 * 规则与协议取舍：
 * - 15×15 棋盘，自由规则（无禁手）：横/竖/两条斜线任一方向连成 5 子及以上
 *   即胜；满盘仍无五连判和棋。
 * - 黑白按入座顺序自动分配：房主执黑先手，第二位玩家执白；每步只允许
 *   当前行棋方落子（not_your_turn），坐标/占用在服务端校验（illegal_move）。
 * - 无隐藏信息：getPlayerView 与 getPublicView 返回同一公开局面，玩家视图
 *   额外带 yourColor（客户端高亮己方棋子用）；协议强制按人裁剪的路径不变。
 * - 回合时限默认 60s（建房 config.turnMs 可调，范围 5s–10min）：start 与
 *   每次落子后写 deadlineAt；alarm 超时由 handleTimeout 判当前行棋方负。
 * - 悔棋是「申请 + 对方同意」两步：只有刚落下最后一手的一方能申请，同意后
 *   撤回该手并把回合交还申请人；求和/同意（offer_draw/accept_draw）同理。
 *   悔棋申请在对方落子后自动失效（落子即拒绝）。
 * - version 与 actionId 去重的协议主人是 GameRoomDO（见 engine-types.ts）：
 *   引擎绝不 bump version；这里只做两道防御性校验——携带的 baseVersion 与
 *   当前 version 不一致返回 stale_action、同一 actionId 再次进入引擎返回
 *   invalid_action。DO 在调用引擎前已按 storage 去重表拦掉重放，因此正常
 *   链路不会走到第二条。
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

const BOARD_SIZE = 15;
const WIN_LENGTH = 5;
const DEFAULT_TURN_MS = 60_000;
const MIN_TURN_MS = 5_000;
const MAX_TURN_MS = 10 * 60_000;
/** 引擎侧 actionId 去重窗口：权威去重表在 DO storage，这里只留最近若干条兜底。 */
const MAX_TRACKED_ACTION_IDS = 64;

export type GomokuColor = "black" | "white";

type Cell = GomokuColor | null;

interface GomokuSeat {
  participantHash: string;
  /** 座位令牌（DO 座位分配处铸造）：视图/结算对位的唯一公开标识（修复 1）。 */
  seatToken: string;
  color: GomokuColor;
}

interface GomokuMove {
  row: number;
  col: number;
  color: GomokuColor;
  /** 落子者座位令牌（随棋谱进视图/结算，公开标识；participantHash 绝不外发）。 */
  seatToken: string;
}

type GomokuResult = "win" | "draw" | "timeout" | "resign" | "aborted";

interface GomokuOutcome {
  result: GomokuResult;
  /** 胜者座位令牌（进视图与结算，公开标识）。 */
  winnerSeatToken: string | null;
}

/** 引擎私有状态（DO 不解释，只有本引擎读写）。 */
interface GomokuEngineState {
  board: Cell[][];
  seats: GomokuSeat[];
  turn: GomokuColor;
  moves: GomokuMove[];
  outcome: GomokuOutcome | null;
  /** 待对方同意的和棋申请（申请人座位令牌——随公开视图下发，不能存哈希）。 */
  pendingDrawFrom: string | null;
  /** 待对方同意的悔棋申请（申请人座位令牌——随公开视图下发，不能存哈希）。 */
  pendingUndoFrom: string | null;
  /** 最近处理过的 actionId（有界）——协议权威去重表在 DO storage。 */
  actionIds: string[];
  /** 每步时限（ms），开局时写进 deadlineAt。 */
  turnMs: number;
  /** 获胜连线（结算快照用；无胜负为 null）。 */
  winningLine: Array<{ row: number; col: number }> | null;
}

// ---------------------------------------------------------------------------
// 纯函数辅助
// ---------------------------------------------------------------------------

function emptyBoard(): Cell[][] {
  return Array.from({ length: BOARD_SIZE }, () => Array<Cell>(BOARD_SIZE).fill(null));
}

function failure(code: GameProtocolErrorCode, message: string): EngineOutcome {
  return { ok: false, error: { code, message } };
}

function success(state: GameRoomState): EngineOutcome {
  return { ok: true, state };
}

function readEngineState(state: GameRoomState): GomokuEngineState | null {
  const value = state.engineState;
  return value !== null && typeof value === "object" ? (value as GomokuEngineState) : null;
}

function activePlayers(state: GameRoomState): GameRoomPlayer[] {
  return state.players.filter((player) => player.leftAt === null);
}

function findActivePlayer(state: GameRoomState, participantHash: string): GameRoomPlayer | null {
  return state.players.find((player) => player.participantHash === participantHash && player.leftAt === null) ?? null;
}

function seatOf(engine: GomokuEngineState, participantHash: string): GomokuSeat | null {
  return engine.seats.find((seat) => seat.participantHash === participantHash) ?? null;
}

function seatByColor(engine: GomokuEngineState, color: GomokuColor): GomokuSeat | null {
  return engine.seats.find((seat) => seat.color === color) ?? null;
}

/** 座位对应玩家仍在座（未 leftAt）才算有效对手。 */
function activeSeatByColor(state: GameRoomState, engine: GomokuEngineState, color: GomokuColor): GomokuSeat | null {
  const seat = seatByColor(engine, color);
  if (!seat) return null;
  return findActivePlayer(state, seat.participantHash) ? seat : null;
}

function opponentColor(color: GomokuColor): GomokuColor {
  return color === "black" ? "white" : "black";
}

/** 建房 config.turnMs 校验：缺省用默认值，非法返回 null（invalid_action）。 */
function readTurnMs(config: Record<string, unknown>): number | null {
  const value = config.turnMs;
  if (value === undefined) return DEFAULT_TURN_MS;
  if (typeof value !== "number" || !Number.isFinite(value) || value < MIN_TURN_MS || value > MAX_TURN_MS) return null;
  return Math.round(value);
}

function trackActionId(actionIds: string[], actionId: string): string[] {
  return [...actionIds, actionId].slice(-MAX_TRACKED_ACTION_IDS);
}

function inBounds(row: number, col: number): boolean {
  return row >= 0 && row < BOARD_SIZE && col >= 0 && col < BOARD_SIZE;
}

/** 落子 payload 的服务端校验：{ row, col } 且必须是棋盘内整数。 */
function parseMovePayload(payload: unknown): { row: number; col: number } | null {
  if (payload === null || typeof payload !== "object") return null;
  const candidate = payload as { row?: unknown; col?: unknown };
  if (typeof candidate.row !== "number" || typeof candidate.col !== "number") return null;
  if (!Number.isInteger(candidate.row) || !Number.isInteger(candidate.col)) return null;
  if (!inBounds(candidate.row, candidate.col)) return null;
  return { row: candidate.row, col: candidate.col };
}

const DIRECTIONS = [
  [0, 1], // 横
  [1, 0], // 竖
  [1, 1], // 主斜线
  [1, -1], // 副斜线
] as const;

/**
 * 以刚落下的子为中心，沿四个方向找连续同色串；长度 ≥ 5 即胜。
 * 返回完整连线（含两端延伸），供结算摘要与客户端高亮。
 */
function findWinningLine(
  board: Cell[][],
  row: number,
  col: number,
  color: GomokuColor,
): Array<{ row: number; col: number }> | null {
  for (const [dr, dc] of DIRECTIONS) {
    const line: Array<{ row: number; col: number }> = [{ row, col }];
    for (const sign of [-1, 1] as const) {
      let r = row + dr * sign;
      let c = col + dc * sign;
      while (inBounds(r, c) && board[r]?.[c] === color) {
        line.push({ row: r, col: c });
        r += dr * sign;
        c += dc * sign;
      }
    }
    if (line.length >= WIN_LENGTH) {
      line.sort((a, b) => a.row - b.row || a.col - b.col);
      return line;
    }
  }
  return null;
}

function withEngine(state: GameRoomState, engine: GomokuEngineState): GameRoomState {
  return { ...state, engineState: engine };
}

// ---------------------------------------------------------------------------
// 动作实现（每个动作返回新 state，不原地改）
// ---------------------------------------------------------------------------

function applyMove(
  state: GameRoomState,
  engine: GomokuEngineState,
  seat: GomokuSeat,
  action: GameRoomAction,
): EngineOutcome {
  if (engine.turn !== seat.color) {
    return failure("not_your_turn", "还没轮到你落子");
  }
  const move = parseMovePayload(action.payload);
  if (!move) {
    return failure("illegal_move", `落子坐标必须是 0–${BOARD_SIZE - 1} 的整数行列`);
  }
  if (engine.board[move.row]![move.col] !== null) {
    return failure("illegal_move", "该位置已有棋子");
  }

  const board = engine.board.map((line, row) =>
    row === move.row ? line.map((cell, col) => (col === move.col ? seat.color : cell)) : line,
  );
  const record: GomokuMove = {
    row: move.row,
    col: move.col,
    color: seat.color,
    seatToken: seat.seatToken,
  };
  const moves = [...engine.moves, record];
  const winningLine = findWinningLine(board, move.row, move.col, seat.color);
  const boardFull = board.every((line) => line.every((cell) => cell !== null));

  let outcome: GomokuOutcome | null = null;
  if (winningLine) {
    outcome = { result: "win", winnerSeatToken: seat.seatToken };
  } else if (boardFull) {
    outcome = { result: "draw", winnerSeatToken: null };
  }

  const next: GomokuEngineState = {
    ...engine,
    board,
    moves,
    turn: opponentColor(seat.color),
    outcome,
    // 对方落子即视为拒绝未决的悔棋申请；和棋申请保留到明确回应。
    pendingUndoFrom: null,
    winningLine,
    actionIds: trackActionId(engine.actionIds, action.actionId),
  };
  return success({ ...state, engineState: next, deadlineAt: outcome ? null : Date.now() + engine.turnMs });
}

function applyResign(
  state: GameRoomState,
  engine: GomokuEngineState,
  seat: GomokuSeat,
  action: GameRoomAction,
): EngineOutcome {
  const opponent = activeSeatByColor(state, engine, opponentColor(seat.color));
  const next: GomokuEngineState = {
    ...engine,
    outcome: opponent
      ? { result: "resign", winnerSeatToken: opponent.seatToken }
      : { result: "aborted", winnerSeatToken: null },
    pendingDrawFrom: null,
    pendingUndoFrom: null,
    winningLine: null,
    actionIds: trackActionId(engine.actionIds, action.actionId),
  };
  return success({ ...state, engineState: next, deadlineAt: null });
}

function agreeDraw(state: GameRoomState, engine: GomokuEngineState, action: GameRoomAction): EngineOutcome {
  const next: GomokuEngineState = {
    ...engine,
    outcome: { result: "draw", winnerSeatToken: null },
    pendingDrawFrom: null,
    pendingUndoFrom: null,
    winningLine: null,
    actionIds: trackActionId(engine.actionIds, action.actionId),
  };
  return success({ ...state, engineState: next, deadlineAt: null });
}

function applyOfferDraw(state: GameRoomState, engine: GomokuEngineState, action: GameRoomAction): EngineOutcome {
  const seat = seatOf(engine, action.participantHash);
  if (!seat) return failure("internal_error", "玩家座次缺失");
  // 对方已求和时，本方再发一次即视为同意（少一个往返，语义不变）。
  if (engine.pendingDrawFrom !== null && engine.pendingDrawFrom !== seat.seatToken) {
    return agreeDraw(state, engine, action);
  }
  if (engine.pendingDrawFrom === seat.seatToken) {
    return failure("invalid_action", "已发出和棋申请，等待对方回应");
  }
  const next: GomokuEngineState = {
    ...engine,
    // 申请记座位令牌（随公开视图下发）；participantHash 只留在 seats 里做
    // 服务端成员校验，绝不外发。
    pendingDrawFrom: seat.seatToken,
    actionIds: trackActionId(engine.actionIds, action.actionId),
  };
  return success(withEngine(state, next));
}

function applyAcceptDraw(state: GameRoomState, engine: GomokuEngineState, action: GameRoomAction): EngineOutcome {
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

function applyRequestUndo(state: GameRoomState, engine: GomokuEngineState, action: GameRoomAction): EngineOutcome {
  const seat = seatOf(engine, action.participantHash);
  if (!seat) return failure("internal_error", "玩家座次缺失");
  const last = engine.moves.at(-1);
  if (!last) {
    return failure("illegal_move", "还没有可以撤回的落子");
  }
  // 只能撤回自己刚落下的一手：对方已经应手后不允许再翻旧账。
  if (last.seatToken !== seat.seatToken) {
    return failure("illegal_move", "只能申请撤回自己刚落下的一手");
  }
  if (engine.pendingUndoFrom !== null) {
    return failure("invalid_action", "已有待处理的悔棋申请");
  }
  const next: GomokuEngineState = {
    ...engine,
    pendingUndoFrom: seat.seatToken,
    actionIds: trackActionId(engine.actionIds, action.actionId),
  };
  return success(withEngine(state, next));
}

function applyAcceptUndo(state: GameRoomState, engine: GomokuEngineState, action: GameRoomAction): EngineOutcome {
  const seat = seatOf(engine, action.participantHash);
  if (!seat) return failure("internal_error", "玩家座次缺失");
  if (engine.pendingUndoFrom === null) {
    return failure("illegal_move", "没有待同意的悔棋申请");
  }
  if (engine.pendingUndoFrom === seat.seatToken) {
    return failure("illegal_move", "不能同意自己发起的悔棋");
  }
  const last = engine.moves.at(-1);
  if (!last || last.seatToken !== engine.pendingUndoFrom) {
    return failure("invalid_action", "悔棋申请已失效");
  }

  const board = engine.board.map((line, row) =>
    row === last.row ? line.map((cell, col) => (col === last.col ? null : cell)) : line,
  );
  const next: GomokuEngineState = {
    ...engine,
    board,
    moves: engine.moves.slice(0, -1),
    // 撤回的是申请人的最后一手，回合随之交还申请人。
    turn: last.color,
    outcome: null,
    winningLine: null,
    pendingUndoFrom: null,
    actionIds: trackActionId(engine.actionIds, action.actionId),
  };
  return success({ ...state, engineState: next, deadlineAt: Date.now() + engine.turnMs });
}

// ---------------------------------------------------------------------------
// 视图载荷
// ---------------------------------------------------------------------------

function publicViewPayload(engine: GomokuEngineState): Record<string, unknown> {
  return {
    boardSize: BOARD_SIZE,
    board: engine.board,
    turn: engine.turn,
    // 显式投影：座位行还持有 participantHash（服务端内部成员校验用），展开
    // 对象会把它带进视图——视图只发座位令牌（修复 1）。
    players: engine.seats.map((seat) => ({ seatToken: seat.seatToken, color: seat.color })),
    moveCount: engine.moves.length,
    lastMove: engine.moves.at(-1) ?? null,
    winningLine: engine.winningLine,
    outcome: engine.outcome,
    pendingDrawFrom: engine.pendingDrawFrom,
    pendingUndoFrom: engine.pendingUndoFrom,
  };
}

// ---------------------------------------------------------------------------
// 引擎实现
// ---------------------------------------------------------------------------

export const gomokuEngine: MultiplayerGameEngine = {
  gameType: "gomoku",
  label: "五子棋",
  // 玩法元数据（GET /api/game/types 直读）：入口卡/大厅标题与人数规则都从
  // 这里来，客户端不再硬编码玩法名。
  meta: {
    displayName: "五子棋",
    description: "黑白轮流落子，先连成五子的一方获胜；每一步限时一分钟。",
    minPlayers: 2,
    maxPlayers: 2,
  } satisfies GameEngineMeta,

  createRoom(state, config): EngineOutcome {
    const turnMs = readTurnMs(config);
    if (turnMs === null) {
      return failure("invalid_action", `config.turnMs 必须是 ${MIN_TURN_MS}–${MAX_TURN_MS} 之间的毫秒数`);
    }
    // 初始在座者（房主）按入座顺序执黑；第二位玩家在 joinRoom 时执白。
    const seats: GomokuSeat[] = activePlayers(state)
      .slice(0, 2)
      .map((player, index) => ({
        participantHash: player.participantHash,
        seatToken: player.seatToken,
        color: index === 0 ? "black" : "white",
      }));
    const engine: GomokuEngineState = {
      board: emptyBoard(),
      seats,
      turn: "black",
      moves: [],
      outcome: null,
      pendingDrawFrom: null,
      pendingUndoFrom: null,
      actionIds: [],
      turnMs,
      winningLine: null,
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
      return failure("invalid_action", "房间已满（五子棋为两人对局）");
    }

    // 只保留仍有效座位的颜色；离开玩家的座位释放给新玩家（仅在 lobby）。
    const activeHashes = new Set(active.map((item) => item.participantHash));
    const seats = engine.seats.filter((seat) => activeHashes.has(seat.participantHash));
    const used = new Set(seats.map((seat) => seat.color));
    if (used.has("black") && used.has("white")) {
      return failure("invalid_action", "房间已满（五子棋为两人对局）");
    }
    const color: GomokuColor = used.has("black") ? "white" : "black";
    const next: GomokuEngineState = {
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
      return failure("invalid_action", "五子棋需要两名玩家才能开局");
    }
    if (!active.every((player) => player.ready)) {
      return failure("invalid_action", "双方都准备后才能开局");
    }

    // 沿用入座时确定的颜色；缺失座位时按当前顺序补黑白。
    const colorByHash = new Map(engine.seats.map((seat) => [seat.participantHash, seat.color]));
    const seats: GomokuSeat[] = active.map((player, index) => ({
      participantHash: player.participantHash,
      seatToken: player.seatToken,
      color: colorByHash.get(player.participantHash) ?? (index === 0 ? "black" : "white"),
    }));
    // 兜底：两座同色时按顺序重排（create/join 正常路径不会出现）。
    if (seats[0]!.color === seats[1]!.color) {
      seats[0] = { ...seats[0]!, color: "black" };
      seats[1] = { ...seats[1]!, color: "white" };
    }

    const next: GomokuEngineState = {
      ...engine,
      board: emptyBoard(),
      seats,
      turn: "black",
      moves: [],
      outcome: null,
      pendingDrawFrom: null,
      pendingUndoFrom: null,
      winningLine: null,
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
      case "request_undo":
        return applyRequestUndo(state, engine, action);
      case "accept_undo":
        return applyAcceptUndo(state, engine, action);
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
    const black = engine ? seatByColor(engine, "black") : null;
    const white = engine ? seatByColor(engine, "white") : null;
    return {
      result: outcome?.result ?? "aborted",
      // 结算快照进视图对全房可见（含观战）：一律用座位令牌对位（修复 1）。
      winnerSeatToken: outcome?.winnerSeatToken ?? null,
      summary: {
        boardSize: BOARD_SIZE,
        moveCount: engine?.moves.length ?? 0,
        history: engine?.moves ?? [],
        blackSeatToken: black?.seatToken ?? null,
        whiteSeatToken: white?.seatToken ?? null,
        winningLine: engine?.winningLine ?? null,
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
    const next: GomokuEngineState = {
      ...engine,
      outcome:
        loser && winner
          ? { result: "timeout", winnerSeatToken: winner.seatToken }
          : { result: "aborted", winnerSeatToken: null },
      pendingDrawFrom: null,
      pendingUndoFrom: null,
      winningLine: null,
    };
    // 只打标记并清 deadline：checkGameOver 命中后由 DO 走统一 settleRoom。
    return success({ ...state, engineState: next, deadlineAt: null });
  },
};
