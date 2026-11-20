import { beforeEach, describe, expect, it } from "vitest";

import { clearGameEnginesForTest, resolveGameEngine } from "../../../../src/game/multiplayer/engine-registry";
import type {
  EngineOutcome,
  GameRoomAction,
  GameRoomPlayer,
  GameRoomState,
} from "../../../../src/game/multiplayer/engine-types";
import { gomokuEngine } from "../../../../src/game/multiplayer/engines/gomoku";
import { registerBuiltinMultiplayerEngines } from "../../../../src/game/multiplayer/server-engines";

/**
 * 五子棋引擎单测（P0 批次 G2）：脱离 GameRoomDO 直接驱动引擎，覆盖
 * 横/竖/斜五连、满盘和棋、非法落子、回合校验、悔棋与求和、actionId/
 * stateVersion 防御、认输/超时结算，以及 server-engines 的注册结果。
 *
 * version 语义按协议由 DO 唯一递增（engine-types.ts / game-room.ts:819），
 * 测试里的 `commit` 显式模拟 DO 的 bump，引擎自身永远不碰 version。
 */

const HOST = "hash-host";
const GUEST = "hash-guest";

function roomPlayer(participantHash: string, isHost: boolean): GameRoomPlayer {
  return {
    participantHash,
    displayName: isHost ? "房主" : "客人",
    isHost,
    ready: false,
    joinedAt: new Date().toISOString(),
    leftAt: null,
  };
}

/** DO handleCreate 构造的初始房间（engineState=null，房主已入座）。 */
function baseRoom(): GameRoomState {
  const now = new Date().toISOString();
  return {
    roomId: "room_1",
    gameType: "gomoku",
    status: "lobby",
    version: 1,
    config: {},
    players: [roomPlayer(HOST, true)],
    engineState: null,
    createdAt: now,
    updatedAt: now,
    deadlineAt: null,
    recycleAt: null,
    closedAt: null,
  };
}

function unwrap(outcome: EngineOutcome): GameRoomState {
  if (!outcome.ok) {
    throw new Error(`引擎拒绝：${outcome.error.code} ${outcome.error.message}`);
  }
  return outcome.state;
}

/** 模拟 GameRoomDO 的 version bump（协议不变量一）。 */
function commit(outcome: EngineOutcome): GameRoomState {
  const state = unwrap(outcome);
  return { ...state, version: state.version + 1 };
}

function created(): GameRoomState {
  return commit(gomokuEngine.createRoom(baseRoom(), { turnMs: 60_000 }));
}

/** 模拟 DO handleJoin：players 先剔除重入者旧行，再交给引擎追加入座。 */
function joined(state: GameRoomState): GameRoomState {
  const players = state.players.filter((player) => player.participantHash !== GUEST);
  return commit(gomokuEngine.joinRoom({ ...state, players }, roomPlayer(GUEST, false)));
}

/** 建房 → 加入 → 双方 ready → 房主开局。 */
function started(): GameRoomState {
  let state = joined(created());
  state = commit(gomokuEngine.setReady(state, HOST, true));
  state = commit(gomokuEngine.setReady(state, GUEST, true));
  return commit(gomokuEngine.start(state, HOST));
}

function action(who: string, name: string, actionId: string, payload?: unknown): GameRoomAction {
  return {
    actionId,
    participantHash: who,
    action: name,
    ...(payload === undefined ? {} : { payload }),
  };
}

function play(state: GameRoomState, who: string, row: number, col: number, actionId: string): GameRoomState {
  return commit(gomokuEngine.applyAction(state, action(who, "move", actionId, { row, col })));
}

function expectRejected(outcome: EngineOutcome, code: string): void {
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) expect(outcome.error.code).toBe(code);
}

/** 读取公开视图里的棋盘（保证引擎视图始终可序列化给客户端）。 */
function boardOf(state: GameRoomState): Array<Array<string | null>> {
  const view = gomokuEngine.getPublicView(state).view as { board: Array<Array<string | null>> };
  return view.board;
}

beforeEach(() => {
  clearGameEnginesForTest();
});

describe("五子棋 胜负判定", () => {
  it("横向五连：黑棋连成 5 子即胜，settle 给出 winner 与连线", () => {
    let state = started();
    const opening: Array<[string, number, number]> = [
      [HOST, 7, 0],
      [GUEST, 0, 0],
      [HOST, 7, 1],
      [GUEST, 0, 1],
      [HOST, 7, 2],
      [GUEST, 0, 2],
      [HOST, 7, 3],
      [GUEST, 0, 3],
    ];
    opening.forEach(([who, row, col], index) => {
      state = play(state, who, row, col, `h-${index}`);
    });
    expect(gomokuEngine.checkGameOver(state)).toBe(false);

    state = play(state, HOST, 7, 4, "h-win");
    expect(gomokuEngine.checkGameOver(state)).toBe(true);
    const settlement = gomokuEngine.settle(state);
    expect(settlement.result).toBe("win");
    expect(settlement.winnerParticipantHash).toBe(HOST);
    expect(settlement.summary.winningLine).toHaveLength(5);
    expect(settlement.summary.moveCount).toBe(9);
  });

  it("纵向五连：白棋连成 5 子即胜", () => {
    let state = started();
    const opening: Array<[string, number, number]> = [
      [HOST, 0, 0],
      [GUEST, 7, 0],
      [HOST, 0, 1],
      [GUEST, 7, 1],
      [HOST, 0, 2],
      [GUEST, 7, 2],
      [HOST, 0, 3],
      [GUEST, 7, 3],
      [HOST, 14, 14], // 白方第五手前补一手黑棋，保持回合交替
    ];
    opening.forEach(([who, row, col], index) => {
      state = play(state, who, row, col, `v-${index}`);
    });
    state = play(state, GUEST, 7, 4, "v-win");
    expect(gomokuEngine.checkGameOver(state)).toBe(true);
    const settlement = gomokuEngine.settle(state);
    expect(settlement.result).toBe("win");
    expect(settlement.winnerParticipantHash).toBe(GUEST);
    expect(settlement.summary.winningLine).toHaveLength(5);
  });

  it("斜向五连：黑棋沿主斜线连成 5 子即胜", () => {
    let state = started();
    const opening: Array<[string, number, number]> = [
      [HOST, 0, 0],
      [GUEST, 0, 14],
      [HOST, 1, 1],
      [GUEST, 1, 14],
      [HOST, 2, 2],
      [GUEST, 2, 14],
      [HOST, 3, 3],
      [GUEST, 3, 14],
    ];
    opening.forEach(([who, row, col], index) => {
      state = play(state, who, row, col, `d-${index}`);
    });
    state = play(state, HOST, 4, 4, "d-win");
    expect(gomokuEngine.checkGameOver(state)).toBe(true);
    const settlement = gomokuEngine.settle(state);
    expect(settlement.result).toBe("win");
    expect(settlement.winnerParticipantHash).toBe(HOST);
    expect(settlement.summary.winningLine).toEqual([
      { row: 0, col: 0 },
      { row: 1, col: 1 },
      { row: 2, col: 2 },
      { row: 3, col: 3 },
      { row: 4, col: 4 },
    ]);
  });

  it("满盘无五连判和棋（15×15=225 手，双方各 113/112 子）", () => {
    // 周期为 4 的染色：任意横/竖/斜方向都不可能出现 5 连，用于构造合法满盘。
    const black: Array<[number, number]> = [];
    const white: Array<[number, number]> = [];
    for (let row = 0; row < 15; row += 1) {
      for (let col = 0; col < 15; col += 1) {
        if ((row + 2 * col) % 4 < 2) black.push([row, col]);
        else white.push([row, col]);
      }
    }
    expect(black).toHaveLength(113);
    expect(white).toHaveLength(112);

    let state = started();
    for (let move = 1; move <= 225; move += 1) {
      const isBlack = move % 2 === 1;
      const cell = isBlack ? black[(move - 1) / 2]! : white[move / 2 - 1]!;
      state = play(state, isBlack ? HOST : GUEST, cell[0], cell[1], `full-${move}`);
    }

    expect(gomokuEngine.checkGameOver(state)).toBe(true);
    const settlement = gomokuEngine.settle(state);
    expect(settlement.result).toBe("draw");
    expect(settlement.winnerParticipantHash).toBeNull();
    expect(settlement.summary.moveCount).toBe(225);
    expect(
      boardOf(state)
        .flat()
        .filter((cell) => cell !== null),
    ).toHaveLength(225);
  });
});

describe("五子棋 落子校验", () => {
  it("非法落子：越界、非整数、占用位置均返回 illegal_move", () => {
    let state = started();
    expectRejected(
      gomokuEngine.applyAction(state, action(HOST, "move", "bad-oob", { row: 15, col: 0 })),
      "illegal_move",
    );
    expectRejected(
      gomokuEngine.applyAction(state, action(HOST, "move", "bad-neg", { row: -1, col: 3 })),
      "illegal_move",
    );
    expectRejected(
      gomokuEngine.applyAction(state, action(HOST, "move", "bad-frac", { row: 1.5, col: 2 })),
      "illegal_move",
    );
    expectRejected(gomokuEngine.applyAction(state, action(HOST, "move", "bad-missing")), "illegal_move");

    state = play(state, HOST, 7, 7, "occ-1");
    expectRejected(gomokuEngine.applyAction(state, action(GUEST, "move", "occ-2", { row: 7, col: 7 })), "illegal_move");
    // 拒绝不落子：棋盘上仍然只有黑棋那一手。
    expect(
      boardOf(state)
        .flat()
        .filter((cell) => cell !== null),
    ).toHaveLength(1);
  });

  it("非当前回合：白方抢先落子、黑方连走两步都被 not_your_turn 拒绝", () => {
    const state = started();
    expectRejected(
      gomokuEngine.applyAction(state, action(GUEST, "move", "turn-1", { row: 7, col: 7 })),
      "not_your_turn",
    );

    const afterBlack = play(state, HOST, 7, 7, "turn-2");
    expectRejected(
      gomokuEngine.applyAction(afterBlack, action(HOST, "move", "turn-3", { row: 7, col: 8 })),
      "not_your_turn",
    );
  });

  it("未知动作返回 illegal_move", () => {
    const state = started();
    expectRejected(gomokuEngine.applyAction(state, action(HOST, "teleport", "unknown-1")), "illegal_move");
  });
});

describe("五子棋 悔棋与求和", () => {
  it("悔棋：只有最后一手本人可申请，对方同意后撤回该手并归还回合", () => {
    let state = started();
    state = play(state, HOST, 7, 7, "u-1"); // 最后一手是黑棋，轮到白方

    // 白方不是最后一手的主人，不能申请撤回黑棋。
    expectRejected(gomokuEngine.applyAction(state, action(GUEST, "request_undo", "u-2")), "illegal_move");

    state = commit(gomokuEngine.applyAction(state, action(HOST, "request_undo", "u-3")));
    const pending = gomokuEngine.getPublicView(state).view as { pendingUndoFrom: string | null; turn: string };
    expect(pending.pendingUndoFrom).toBe(HOST);
    expect(pending.turn).toBe("white");

    // 发起人不能自己同意。
    expectRejected(gomokuEngine.applyAction(state, action(HOST, "accept_undo", "u-4")), "illegal_move");

    state = commit(gomokuEngine.applyAction(state, action(GUEST, "accept_undo", "u-5")));
    const view = gomokuEngine.getPublicView(state).view as {
      board: Array<Array<string | null>>;
      turn: string;
      moveCount: number;
      pendingUndoFrom: string | null;
    };
    expect(view.board[7]![7]).toBeNull();
    expect(view.moveCount).toBe(0);
    expect(view.turn).toBe("black");
    expect(view.pendingUndoFrom).toBeNull();

    // 撤回后黑棋可重新落子（回合确实归还）。
    state = play(state, HOST, 7, 7, "u-6");
    expect(boardOf(state)[7]![7]).toBe("black");
  });

  it("求和：申请 → 对方同意即和棋；自己不能同意自己的申请", () => {
    let state = started();
    state = commit(gomokuEngine.applyAction(state, action(HOST, "offer_draw", "draw-1")));
    expectRejected(gomokuEngine.applyAction(state, action(HOST, "accept_draw", "draw-2")), "illegal_move");

    state = commit(gomokuEngine.applyAction(state, action(GUEST, "accept_draw", "draw-3")));
    expect(gomokuEngine.checkGameOver(state)).toBe(true);
    const settlement = gomokuEngine.settle(state);
    expect(settlement.result).toBe("draw");
    expect(settlement.winnerParticipantHash).toBeNull();
  });

  it("求和：对方申请后本方再发一次视为同意（少一个往返）", () => {
    let state = started();
    state = commit(gomokuEngine.applyAction(state, action(HOST, "offer_draw", "draw-a")));
    state = commit(gomokuEngine.applyAction(state, action(GUEST, "offer_draw", "draw-b")));
    expect(gomokuEngine.settle(state).result).toBe("draw");
  });
});

describe("五子棋 协议防御（actionId / stateVersion）", () => {
  it("重复 actionId 被引擎拒绝，局面不二次生效", () => {
    let state = started();
    state = play(state, HOST, 7, 7, "dup-1");
    const before = JSON.stringify(boardOf(state));

    const replay = gomokuEngine.applyAction(state, action(GUEST, "move", "dup-1", { row: 0, col: 0 }));
    expectRejected(replay, "invalid_action");
    expect(JSON.stringify(boardOf(state))).toBe(before);
  });

  it("旧 stateVersion（baseVersion 落后）返回 stale_action，匹配则放行", () => {
    const state = started();
    expectRejected(
      gomokuEngine.applyAction(state, {
        actionId: "stale-1",
        participantHash: HOST,
        action: "move",
        payload: { row: 7, col: 7 },
        baseVersion: state.version - 1,
      }),
      "stale_action",
    );

    const fresh = gomokuEngine.applyAction(state, {
      actionId: "fresh-1",
      participantHash: HOST,
      action: "move",
      payload: { row: 7, col: 7 },
      baseVersion: state.version,
    });
    expect(fresh.ok).toBe(true);
  });
});

describe("五子棋 结算", () => {
  it("认输：对方获胜，settle 快照带 resign", () => {
    const state = started();
    const outcome = gomokuEngine.applyAction(state, action(GUEST, "resign", "resign-1"));
    const after = unwrap(outcome);
    expect(gomokuEngine.checkGameOver(after)).toBe(true);
    const settlement = gomokuEngine.settle(after);
    expect(settlement.result).toBe("resign");
    expect(settlement.winnerParticipantHash).toBe(HOST);
  });

  it("超时：截止前拒绝，到点判当前行棋方（黑/房主）负", () => {
    const state = started();
    const deadline = state.deadlineAt ?? 0;
    expectRejected(gomokuEngine.handleTimeout(state, deadline - 1), "invalid_action");

    const timedOut = unwrap(gomokuEngine.handleTimeout(state, deadline + 1));
    expect(gomokuEngine.checkGameOver(timedOut)).toBe(true);
    const settlement = gomokuEngine.settle(timedOut);
    expect(settlement.result).toBe("timeout");
    expect(settlement.winnerParticipantHash).toBe(GUEST);
    expect(timedOut.deadlineAt).toBeNull();
  });
});

describe("五子棋 视图与注册", () => {
  it("视图：黑白自动分配，玩家视图各带 yourColor，公开视图不带", () => {
    const state = started();
    const hostView = gomokuEngine.getPlayerView(state, HOST).view as { yourColor: string; board: unknown[] };
    const guestView = gomokuEngine.getPlayerView(state, GUEST).view as { yourColor: string };
    expect(hostView.yourColor).toBe("black");
    expect(guestView.yourColor).toBe("white");
    expect(hostView.board).toHaveLength(15);
    expect(JSON.stringify(gomokuEngine.getPublicView(state).view)).not.toContain("yourColor");
  });

  it("注册表：server-engines 注册后 resolveGameEngine('gomoku') 非空", () => {
    expect(resolveGameEngine("gomoku")).toBeNull();
    registerBuiltinMultiplayerEngines();
    const engine = resolveGameEngine("gomoku");
    expect(engine).not.toBeNull();
    expect(engine?.gameType).toBe("gomoku");
    expect(engine?.label).toBe("五子棋");
  });
});
