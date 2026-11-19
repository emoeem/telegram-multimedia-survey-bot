/**
 * 多人对局协议测试桩引擎（P0 批次 G1）。
 *
 * 一个最小但完整的 MultiplayerGameEngine 实现：两位玩家轮流"落子"（move），
 * 每位玩家有一个仅自己可见的私密字段（secret）用于断言视图裁剪；累计满 3
 * 步或超时即终局。够覆盖三条协议不变量（version 单调、actionId 幂等、
 * 私有视图裁剪）与 WS/alarm 的引擎交互，又不引入真实玩法逻辑。
 */
import type {
  EngineOutcome,
  GameRoomAction,
  GameRoomPlayer,
  GameRoomState,
  GameSettlement,
  MultiplayerGameEngine,
} from "../../src/game/multiplayer/engine-types";

/** 桩引擎私有状态：DO 不解释，只有本引擎读写。 */
interface StubEngineState {
  /** participantHash → 累计步数。 */
  moves: Record<string, number>;
  /** participantHash → 仅本人可见的私密串（裁剪断言用）。 */
  secrets: Record<string, string>;
  /** 全桌累计步数；>= maxMoves 即终局。 */
  movesTotal: number;
  /** alarm 超时标记（handleTimeout 设置，checkGameOver 命中）。 */
  timedOut: boolean;
}

const MAX_PLAYERS = 2;
const MAX_MOVES = 3;

function activePlayers(state: GameRoomState): GameRoomPlayer[] {
  return state.players.filter((player) => player.leftAt === null);
}

export const stubEngine: MultiplayerGameEngine = {
  gameType: "stub-guess",
  label: "协议测试桩",

  createRoom(state, _config): EngineOutcome {
    const engineState: StubEngineState = { moves: {}, secrets: {}, movesTotal: 0, timedOut: false };
    // 初始在座者（房主）的私密信息也在这里铸造——私密信息只由引擎持有。
    for (const player of state.players) {
      engineState.secrets[player.participantHash] = `secret-of-${player.participantHash}`;
    }
    return { ok: true, state: { ...state, engineState } };
  },

  joinRoom(state, player): EngineOutcome {
    if (state.status !== "lobby") {
      return { ok: false, error: { code: "invalid_action", message: "对局已开始，无法加入" } };
    }
    if (activePlayers(state).length >= MAX_PLAYERS) {
      return { ok: false, error: { code: "invalid_action", message: "房间已满" } };
    }
    const engineState = { ...(state.engineState as StubEngineState) };
    // 私密信息在入座时铸造：这是"按玩家裁剪"要保护的东西。
    engineState.secrets[player.participantHash] = `secret-of-${player.participantHash}`;
    // 协议契约：players 此刻不含该玩家（DO 已剔除旧行），引擎负责追加入座。
    return { ok: true, state: { ...state, engineState, players: [...state.players, player] } };
  },

  setReady(state, participantHash, ready): EngineOutcome {
    if (state.status !== "lobby") {
      return { ok: false, error: { code: "invalid_action", message: "对局已开始" } };
    }
    const player = state.players.find((p) => p.participantHash === participantHash);
    if (!player || player.leftAt) {
      return { ok: false, error: { code: "not_a_player", message: "你还不是本房间玩家" } };
    }
    const players = state.players.map((p) => (p.participantHash === participantHash ? { ...p, ready } : p));
    return { ok: true, state: { ...state, players } };
  },

  start(state, participantHash): EngineOutcome {
    if (state.status !== "lobby") {
      return { ok: false, error: { code: "invalid_action", message: "对局已开始" } };
    }
    const player = state.players.find((p) => p.participantHash === participantHash);
    if (!player?.isHost) {
      return { ok: false, error: { code: "not_host", message: "只有房主可以开局" } };
    }
    return {
      ok: true,
      state: { ...state, status: "playing", deadlineAt: Date.now() + 60_000 },
    };
  },

  applyAction(state, action: GameRoomAction): EngineOutcome {
    const player = state.players.find((p) => p.participantHash === action.participantHash && p.leftAt === null);
    if (!player) {
      return { ok: false, error: { code: "not_a_player", message: "你还不是本房间玩家" } };
    }
    if (state.status !== "playing") {
      return { ok: false, error: { code: "game_over", message: "对局不在进行中" } };
    }
    if (action.action !== "move") {
      return { ok: false, error: { code: "illegal_move", message: "未知动作" } };
    }
    // 服务端校验：载荷必须带数字步值（客户端传什么都不可信）。
    const value = (action.payload as { value?: unknown } | undefined)?.value;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return { ok: false, error: { code: "illegal_move", message: "步值必须是数字" } };
    }
    const engineState = { ...(state.engineState as StubEngineState) };
    engineState.moves[action.participantHash] = (engineState.moves[action.participantHash] ?? 0) + value;
    engineState.movesTotal += 1;
    return { ok: true, state: { ...state, engineState } };
  },

  /** 私有视图：只有自己的 secret 与步数——裁剪断言的核心。 */
  getPlayerView(state, participantHash): { view: unknown } {
    const engineState = state.engineState as StubEngineState;
    return {
      view: {
        mySecret: engineState.secrets[participantHash] ?? null,
        myMoves: engineState.moves[participantHash] ?? 0,
        movesTotal: engineState.movesTotal,
      },
    };
  },

  /** 公开视图：绝不带任何玩家的私密字段。 */
  getPublicView(state): { view: unknown } {
    const engineState = state.engineState as StubEngineState;
    return {
      view: {
        movesTotal: engineState.movesTotal,
        playerCount: activePlayers(state).length,
      },
    };
  },

  checkGameOver(state): boolean {
    const engineState = state.engineState as StubEngineState;
    return engineState.movesTotal >= MAX_MOVES || engineState.timedOut;
  },

  settle(state): GameSettlement {
    const engineState = state.engineState as StubEngineState;
    const host = state.players.find((p) => p.isHost);
    return {
      result: engineState.timedOut ? "timeout" : "draw",
      winnerParticipantHash: null,
      summary: { moves: engineState.moves, movesTotal: engineState.movesTotal, host: host?.participantHash ?? null },
      settledAt: new Date().toISOString(),
      version: state.version,
    };
  },

  handleTimeout(state): EngineOutcome {
    const engineState = { ...(state.engineState as StubEngineState), timedOut: true };
    return { ok: true, state: { ...state, engineState } };
  },
};
