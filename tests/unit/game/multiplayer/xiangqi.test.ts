import { beforeEach, describe, expect, it } from "vitest";

import { clearGameEnginesForTest, resolveGameEngine } from "../../../../src/game/multiplayer/engine-registry";
import type {
  EngineOutcome,
  GameRoomAction,
  GameRoomPlayer,
  GameRoomState,
} from "../../../../src/game/multiplayer/engine-types";
import { xiangqiEngine } from "../../../../src/game/multiplayer/engines/xiangqi";
import { registerBuiltinMultiplayerEngines } from "../../../../src/game/multiplayer/server-engines";

/**
 * 象棋引擎单测（多人玩法批次 X1）：脱离 GameRoomDO 直接驱动引擎。
 *
 * 覆盖：七类棋子走法合法/非法、蹩马腿/塞象眼/炮架/将帅照面各专项、将军
 * 旗标与应将、将死、困毙、长将判和、走棋历史、红黑自动分配（房主红先手）、
 * actionId/baseVersion 协议防御、认输/求和/超时结算、注册表断言、以及
 * 视图泄漏断言（公开视图不带玩家私有字段、内部簿记不进视图）。
 *
 * version 语义按协议由 DO 唯一递增（engine-types.ts），测试里的 `commit`
 * 显式模拟 DO 的 bump，引擎自身永远不碰 version。
 * 规则专项用手工摆盘（boardRows，"." 为空格）构造引擎私有状态——与服务端
 * xiangqi.ts 的 XiangqiEngineState 形状一致；positionKey 格式亦与引擎相同
 * （`${turn}|${rows.join("/")}`），长将重复计数的初盘由此对齐。
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
    gameType: "xiangqi",
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
  return commit(xiangqiEngine.createRoom(baseRoom(), { turnMs: 60_000 }));
}

/** 模拟 DO handleJoin：players 先剔除重入者旧行，再交给引擎追加入座。 */
function joined(state: GameRoomState): GameRoomState {
  const players = state.players.filter((player) => player.participantHash !== GUEST);
  return commit(xiangqiEngine.joinRoom({ ...state, players }, roomPlayer(GUEST, false)));
}

/** 建房 → 加入 → 双方 ready → 房主开局。 */
function started(): GameRoomState {
  let state = joined(created());
  state = commit(xiangqiEngine.setReady(state, HOST, true));
  state = commit(xiangqiEngine.setReady(state, GUEST, true));
  return commit(xiangqiEngine.start(state, HOST));
}

function action(who: string, name: string, actionId: string, payload?: unknown): GameRoomAction {
  return {
    actionId,
    participantHash: who,
    action: name,
    ...(payload === undefined ? {} : { payload }),
  };
}

type Pair = [row: number, col: number];

function moveAction(who: string, from: Pair, to: Pair, actionId: string): GameRoomAction {
  return {
    actionId,
    participantHash: who,
    action: "move",
    payload: { from: { row: from[0], col: from[1] }, to: { row: to[0], col: to[1] } },
  };
}

function play(state: GameRoomState, who: string, from: Pair, to: Pair, actionId: string): GameRoomState {
  return commit(xiangqiEngine.applyAction(state, moveAction(who, from, to, actionId)));
}

function expectRejected(outcome: EngineOutcome, code: string): void {
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) expect(outcome.error.code).toBe(code);
}

// ---------------------------------------------------------------------------
// 手工摆盘（规则专项）
// ---------------------------------------------------------------------------

/** 行字符串 → 棋盘（"." 为空）；row 0 在黑方顶端，与服务端编码一致。 */
function boardFrom(rows: string[]): Array<Array<string | null>> {
  return rows.map((line) => [...line].map((ch) => (ch === "." ? null : ch)));
}

interface CraftedEngineState {
  board: Array<Array<string | null>>;
  seats: Array<{ participantHash: string; color: "red" | "black" }>;
  turn: "red" | "black";
  moves: unknown[];
  outcome: null;
  pendingDrawFrom: null;
  actionIds: string[];
  turnMs: number;
  positions: string[];
  checkStreaks: { red: number; black: number };
}

/**
 * 手工摆盘的对局中状态：红=HOST、黑=GUEST 双方在座、status=playing、
 * 引擎簿记（positions 初盘/actionIds/checkStreaks）与引擎开局后的形状一致。
 */
function crafted(rows: string[], turn: "red" | "black" = "red"): GameRoomState {
  const engine: CraftedEngineState = {
    board: boardFrom(rows),
    seats: [
      { participantHash: HOST, color: "red" },
      { participantHash: GUEST, color: "black" },
    ],
    turn,
    moves: [],
    outcome: null,
    pendingDrawFrom: null,
    actionIds: [],
    turnMs: 60_000,
    // 与引擎 positionKey 同格式（`${turn}|${rows.join("/")}`），长将重复计数由此对齐初盘。
    positions: [`${turn}|${rows.join("/")}`],
    checkStreaks: { red: 0, black: 0 },
  };
  return {
    ...baseRoom(),
    status: "playing",
    version: 7,
    players: [roomPlayer(HOST, true), roomPlayer(GUEST, false)],
    engineState: engine,
    deadlineAt: Date.now() + 60_000,
  };
}

interface PublicXiangqiView {
  cols: number;
  rows: number;
  board: Array<Array<string | null>>;
  turn: "red" | "black";
  players: Array<{ participantHash: string; color: "red" | "black" }>;
  moveCount: number;
  lastMove: {
    ply: number;
    color: "red" | "black";
    from: { row: number; col: number };
    to: { row: number; col: number };
    piece: string;
    captured: string | null;
    participantHash: string;
    givesCheck: boolean;
  } | null;
  check: "red" | "black" | null;
  outcome: { result: string; winnerParticipantHash: string | null; reason: string | null } | null;
  pendingDrawFrom: string | null;
}

function publicViewOf(state: GameRoomState): PublicXiangqiView {
  return xiangqiEngine.getPublicView(state).view as PublicXiangqiView;
}

function outcomeOf(state: GameRoomState): PublicXiangqiView["outcome"] {
  return publicViewOf(state).outcome;
}

beforeEach(() => {
  clearGameEnginesForTest();
});

// ---------------------------------------------------------------------------
// 注册表与红黑分配
// ---------------------------------------------------------------------------

describe("象棋 注册表与红黑分配", () => {
  it("注册表：server-engines 注册后 resolveGameEngine('xiangqi') 非空，meta 为两人对局", () => {
    expect(resolveGameEngine("xiangqi")).toBeNull();
    registerBuiltinMultiplayerEngines();
    const engine = resolveGameEngine("xiangqi");
    expect(engine).not.toBeNull();
    expect(engine?.gameType).toBe("xiangqi");
    expect(engine?.label).toBe("象棋");
    expect(engine?.meta?.minPlayers).toBe(2);
    expect(engine?.meta?.maxPlayers).toBe(2);
  });

  it("红黑自动分配：房主执红先手，客人执黑；开局后轮到红方", () => {
    const state = started();
    const view = publicViewOf(state);
    expect(view.players).toEqual([
      { participantHash: HOST, color: "red" },
      { participantHash: GUEST, color: "black" },
    ]);
    expect(view.turn).toBe("red");
    expect(state.status).toBe("playing");
    expect(state.deadlineAt).not.toBeNull();
    expect(view.board[0]).toEqual(["r", "h", "e", "a", "k", "a", "e", "h", "r"]);
    expect(view.board[9]).toEqual(["R", "H", "E", "A", "K", "A", "E", "H", "R"]);
    expect(view.board[3]).toEqual(["p", null, "p", null, "p", null, "p", null, "p"]);
    expect(view.board[6]).toEqual(["P", null, "P", null, "P", null, "P", null, "P"]);
    expect(view.board[2]![1]).toBe("c");
    expect(view.board[7]![1]).toBe("C");
  });

  it("玩家视图各带 yourColor；黑方抢先落子被 not_your_turn 拒绝", () => {
    const state = started();
    const hostView = xiangqiEngine.getPlayerView(state, HOST).view as { yourColor: string };
    const guestView = xiangqiEngine.getPlayerView(state, GUEST).view as { yourColor: string };
    expect(hostView.yourColor).toBe("red");
    expect(guestView.yourColor).toBe("black");
    expectRejected(xiangqiEngine.applyAction(state, moveAction(GUEST, [3, 0], [4, 0], "turn-0")), "not_your_turn");
    const after = play(state, HOST, [6, 4], [5, 4], "turn-1");
    expectRejected(xiangqiEngine.applyAction(after, moveAction(HOST, [6, 0], [5, 0], "turn-2")), "not_your_turn");
  });

  it("开局前置：人数不足/未准备不能开局；第三方加入被拒；turnMs 非法建房被拒", () => {
    const room = baseRoom();
    expectRejected(xiangqiEngine.start(commit(xiangqiEngine.createRoom(room, {})), HOST), "invalid_action");

    const one = joined(created());
    const notReady = commit(xiangqiEngine.setReady(one, HOST, true));
    expectRejected(xiangqiEngine.start(notReady, HOST), "invalid_action");

    const full = joined(created());
    expectRejected(xiangqiEngine.joinRoom(full, roomPlayer("hash-third", false)), "invalid_action");

    expectRejected(xiangqiEngine.createRoom(baseRoom(), { turnMs: 1 }), "invalid_action");
  });
});

// ---------------------------------------------------------------------------
// 各兵种走法（从开局真实棋盘）
// ---------------------------------------------------------------------------

describe("象棋 兵种走法（开局局面）", () => {
  it("车：直线滑行合法，落到己方棋子非法", () => {
    const state = started();
    expect(play(state, HOST, [9, 0], [8, 0], "r-ok").version).toBeGreaterThan(state.version);
    expectRejected(xiangqiEngine.applyAction(started(), moveAction(HOST, [9, 0], [6, 0], "r-bad")), "illegal_move");
  });

  it("马：日字合法（开局马无蹩）", () => {
    const state = started();
    expect(play(state, HOST, [9, 1], [7, 2], "h-ok").version).toBeGreaterThan(state.version);
  });

  it("象：田字合法（开局象眼无塞）", () => {
    const state = started();
    expect(play(state, HOST, [9, 2], [7, 0], "e-ok").version).toBeGreaterThan(state.version);
  });

  it("士：宫内斜一步合法，出宫非法", () => {
    const state = started();
    expect(play(state, HOST, [9, 3], [8, 4], "a-ok").version).toBeGreaterThan(state.version);
    expectRejected(xiangqiEngine.applyAction(started(), moveAction(HOST, [9, 3], [8, 2], "a-bad")), "illegal_move");
  });

  it("将：宫内直一步合法，出宫非法", () => {
    const state = started();
    expect(play(state, HOST, [9, 4], [8, 4], "k-ok").version).toBeGreaterThan(state.version);
    const corner = crafted([
      "...k.....",
      ".........",
      ".........",
      ".........",
      ".........",
      ".........",
      ".........",
      ".........",
      ".........",
      ".....K...",
    ]);
    expectRejected(xiangqiEngine.applyAction(corner, moveAction(HOST, [9, 5], [9, 6], "k-bad")), "illegal_move");
  });

  it("炮：无炮架平移合法，直吃第一个子（无炮架）非法", () => {
    const state = started();
    expect(play(state, HOST, [7, 1], [7, 4], "c-ok").version).toBeGreaterThan(state.version);
    // 初始盘上红炮 (7,1) 上方第一个子是黑炮 (2,1)：无炮架直吃被拒
    expectRejected(xiangqiEngine.applyAction(started(), moveAction(HOST, [7, 1], [2, 1], "c-bad")), "illegal_move");
  });

  it("兵：过河前只进，后退/平移非法；过河后可平移", () => {
    const state = started();
    expect(play(state, HOST, [6, 4], [5, 4], "p-ok").version).toBeGreaterThan(state.version);
    expectRejected(xiangqiEngine.applyAction(started(), moveAction(HOST, [6, 4], [6, 3], "p-side")), "illegal_move");
    expectRejected(xiangqiEngine.applyAction(started(), moveAction(HOST, [6, 4], [7, 4], "p-back")), "illegal_move");

    // 红兵过河（row ≤ 4）后可平移
    let crossed = play(started(), HOST, [6, 0], [5, 0], "p-1");
    crossed = play(crossed, GUEST, [0, 8], [1, 8], "p-2"); // 黑车进一步
    crossed = play(crossed, HOST, [5, 0], [4, 0], "p-3"); // 红兵过河
    const blackTurn = play(crossed, GUEST, [1, 8], [2, 8], "p-4");
    expect(play(blackTurn, HOST, [4, 0], [4, 1], "p-5").version).toBeGreaterThan(blackTurn.version);
  });

  it("黑方兵种镜像：让一手后黑车/黑马/黑卒可正常走", () => {
    let state = play(started(), HOST, [6, 2], [5, 2], "b-0");
    state = play(state, GUEST, [0, 0], [1, 0], "b-1"); // 黑车进一步
    state = play(state, HOST, [6, 4], [5, 4], "b-2");
    state = play(state, GUEST, [0, 7], [2, 6], "b-3"); // 黑马
    state = play(state, HOST, [6, 6], [5, 6], "b-4");
    state = play(state, GUEST, [3, 4], [4, 4], "b-5"); // 黑卒进一步
    expect(publicViewOf(state).moveCount).toBe(6);
  });

  it("未知动作返回 illegal_move", () => {
    const state = started();
    expectRejected(xiangqiEngine.applyAction(state, action(HOST, "teleport", "unknown-1")), "illegal_move");
  });
});

// ---------------------------------------------------------------------------
// 规则专项（手工摆盘）：蹩马腿 / 塞象眼 / 炮架 / 照面 / 送将
// ---------------------------------------------------------------------------

describe("象棋 蹩马腿", () => {
  const rows = [
    "....k....", // (0,4) 黑帅
    ".........",
    ".........",
    ".........",
    "....p....", // (4,4) 黑卒 = 马腿
    "....H....", // (5,4) 红马
    ".........",
    ".........",
    ".........",
    "....K....", // (9,4) 红帅
  ];

  it("马腿被塞：朝该方向的两个日字落点都被拒；另一侧日字不受影响", () => {
    const state = crafted(rows);
    expectRejected(xiangqiEngine.applyAction(state, moveAction(HOST, [5, 4], [3, 3], "leg-1")), "illegal_move");
    expectRejected(xiangqiEngine.applyAction(state, moveAction(HOST, [5, 4], [3, 5], "leg-2")), "illegal_move");
    // 目标 (4,2) 的腿在 (5,3)——空 → 合法
    expect(play(state, HOST, [5, 4], [4, 2], "leg-ok").version).toBeGreaterThan(state.version);
  });
});

describe("象棋 塞象眼与象不过河", () => {
  it("象眼被塞：该田字落点被拒；另一田字不受影响", () => {
    const state = crafted([
      "....k....", // (0,4) 黑帅
      ".........",
      ".........",
      ".........",
      ".........",
      ".........",
      ".........",
      ".........",
      ".P.......", // (8,1) 红兵 = 象眼
      "..EK.....", // (9,2) 红相, (9,3) 红帅
    ]);
    expectRejected(xiangqiEngine.applyAction(state, moveAction(HOST, [9, 2], [7, 0], "eye-bad")), "illegal_move");
    expect(play(state, HOST, [9, 2], [7, 4], "eye-ok").version).toBeGreaterThan(state.version);
  });

  it("象不得过河：红相从 (5,2) 去 (3,x) 被拒，留在本方半场的田字合法", () => {
    const state = crafted([
      "...k.....", // (0,3) 黑帅
      ".........",
      ".........",
      ".........",
      ".........",
      "..E......", // (5,2) 红相
      ".........",
      ".........",
      ".........",
      "....K....", // (9,4) 红帅
    ]);
    expectRejected(xiangqiEngine.applyAction(state, moveAction(HOST, [5, 2], [3, 0], "river-bad")), "illegal_move");
    expect(play(state, HOST, [5, 2], [7, 0], "river-ok").version).toBeGreaterThan(state.version);
  });
});

describe("象棋 炮架", () => {
  it("隔一个炮架可以吃子；不能落在炮架上；不能越过目标子再吃", () => {
    const state = crafted([
      "...k.....", // (0,3) 黑帅
      ".........",
      ".r.......", // (2,1) 黑车
      ".........",
      ".p.......", // (4,1) 黑卒 = 炮架
      ".........",
      ".........",
      ".C.......", // (7,1) 红炮
      ".........",
      "....K....", // (9,4) 红帅
    ]);
    const after = play(state, HOST, [7, 1], [2, 1], "cannon-capture");
    expect(publicViewOf(after).lastMove?.captured).toBe("r");
    expectRejected(xiangqiEngine.applyAction(state, moveAction(HOST, [7, 1], [4, 1], "cannon-screen")), "illegal_move");
    expect(play(state, HOST, [7, 1], [6, 1], "cannon-slide").version).toBeGreaterThan(state.version);
    expectRejected(xiangqiEngine.applyAction(state, moveAction(HOST, [7, 1], [0, 1], "cannon-over")), "illegal_move");
  });

  it("无炮架不能吃子，平移空格不受影响", () => {
    const state = crafted([
      "...k.....", // (0,3) 黑帅
      ".........",
      ".r.......", // (2,1) 黑车
      ".........",
      ".........",
      ".........",
      ".........",
      ".C.......", // (7,1) 红炮
      ".........",
      "....K....", // (9,4) 红帅
    ]);
    expectRejected(xiangqiEngine.applyAction(state, moveAction(HOST, [7, 1], [2, 1], "noscreen-bad")), "illegal_move");
    expect(play(state, HOST, [7, 1], [5, 1], "noscreen-ok").version).toBeGreaterThan(state.version);
  });

  it("两个子时只能吃越过炮架后的第一个子", () => {
    const state = crafted([
      "...k.....", // (0,3) 黑帅
      ".........",
      ".r.......", // (2,1) 黑车
      ".........",
      ".p.......", // (4,1) 黑卒
      ".p.......", // (5,1) 黑卒 = 炮架
      ".........",
      ".C.......", // (7,1) 红炮
      ".........",
      "....K....", // (9,4) 红帅
    ]);
    expectRejected(xiangqiEngine.applyAction(state, moveAction(HOST, [7, 1], [2, 1], "twoscreen-far")), "illegal_move");
    const after = play(state, HOST, [7, 1], [4, 1], "twoscreen-near");
    expect(publicViewOf(after).lastMove?.captured).toBe("p");
    expectRejected(
      xiangqiEngine.applyAction(state, moveAction(HOST, [7, 1], [5, 1], "twoscreen-screen")),
      "illegal_move",
    );
  });
});

describe("象棋 将帅照面", () => {
  it("兵挡在两帅之间：兵横移出线即照面被拒；帅沿同列移动仍被隔不构成照面", () => {
    const state = crafted(
      // 黑卒 (5,4) 已过河可横移；沿列前进（(4,4)）不离开本列，不构成照面
      [
        "....k....",
        ".........",
        ".........",
        ".........",
        ".........",
        "....p....",
        ".........",
        ".........",
        ".........",
        "....K....",
      ],
      "black",
    );
    expectRejected(xiangqiEngine.applyAction(state, moveAction(GUEST, [5, 4], [5, 3], "face-bad")), "illegal_move");
    expect(play(state, GUEST, [0, 4], [1, 4], "face-ok").version).toBeGreaterThan(state.version);
  });

  it("炮挡在两帅之间：炮离开该列被拒，沿列移动不构成照面", () => {
    const state = crafted([
      "....k....", // (0,4) 黑帅
      ".........",
      ".........",
      ".........",
      ".........",
      "....C....", // (5,4) 红炮（挡线）
      ".........",
      ".........",
      ".........",
      "....K....", // (9,4) 红帅
    ]);
    expectRejected(xiangqiEngine.applyAction(state, moveAction(HOST, [5, 4], [5, 3], "face-bad")), "illegal_move");
    expect(play(state, HOST, [5, 4], [6, 4], "face-ok").version).toBeGreaterThan(state.version);
  });
});

describe("象棋 送将（走后己帅被攻击）", () => {
  it("黑车隔着红兵瞄准红帅：兵横移让线即送将被拒；帅横移出线合法", () => {
    const state = crafted([
      "...kr....", // (0,3) 黑帅, (0,4) 黑车
      ".........",
      ".........",
      ".........",
      "....P....", // (4,4) 红兵（过河，可横移；挡住 4 列）
      ".........",
      ".........",
      ".........",
      ".........",
      "....K....", // (9,4) 红帅
    ]);
    // 兵横移离开 4 列 → 黑车直射红帅 → 送将被拒
    expectRejected(xiangqiEngine.applyAction(state, moveAction(HOST, [4, 4], [4, 3], "pin-bad")), "illegal_move");
    expect(play(state, HOST, [9, 4], [9, 5], "pin-ok").version).toBeGreaterThan(state.version);
  });
});

// ---------------------------------------------------------------------------
// 将军 / 将死 / 困毙
// ---------------------------------------------------------------------------

describe("象棋 将军与应将", () => {
  it("红车镇住黑帅：视图 check=black；走后仍被攻击的着法被拒；出线应将合法", () => {
    const state = crafted(
      [
        "....k....",
        ".........",
        ".........",
        "....R....",
        ".........",
        ".........",
        ".........",
        ".........",
        ".........",
        "K........",
      ],
      "black",
    );
    expect(publicViewOf(state).check).toBe("black");
    expectRejected(xiangqiEngine.applyAction(state, moveAction(GUEST, [0, 4], [1, 4], "check-bad")), "illegal_move");
    const escaped = play(state, GUEST, [0, 4], [0, 5], "check-ok");
    expect(publicViewOf(escaped).check).toBeNull();
  });
});

describe("象棋 将死", () => {
  it("双车错杀：红车沉底将军后黑帅无路可走，判红胜（reason=checkmate）", () => {
    const state = crafted([
      ".....k...", // (0,5) 黑帅
      "........R", // (1,8) 红车（封 row 1）
      ".........",
      ".........",
      ".........",
      "R........", // (5,0) 红车（待沉底）
      ".........",
      ".........",
      ".........",
      "....K....", // (9,4) 红帅
    ]);
    expect(publicViewOf(state).check).toBeNull();
    const mated = play(state, HOST, [5, 0], [0, 0], "mate");
    expect(publicViewOf(mated).check).toBe("black");
    expect(publicViewOf(mated).outcome).toEqual({
      result: "win",
      winnerParticipantHash: HOST,
      reason: "checkmate",
    });
    expect(xiangqiEngine.checkGameOver(mated)).toBe(true);
    const settlement = xiangqiEngine.settle(mated);
    expect(settlement.result).toBe("win");
    expect(settlement.winnerParticipantHash).toBe(HOST);
    expect(settlement.summary.reason).toBe("checkmate");
    expect(settlement.summary.moveCount).toBe(1);
  });
});

describe("象棋 困毙", () => {
  const rows = [
    "....H....", // (0,4) 红马（腿被黑仕塞住 → 黑仕动即开腿送将）
    "R...a....", // (1,0) 红车, (1,4) 黑仕
    "...k.....", // (2,3) 黑帅
    ".........",
    ".........",
    "....P....", // (5,4) 红兵 = 红炮的炮架
    ".........",
    "....C....", // (7,4) 红炮（隔架罩 (2,4)）
    ".........",
    "....K....", // (9,4) 红帅
  ];

  it("黑方每一手都非法（未被将军但无着可走）", () => {
    const state = crafted(rows, "black");
    expect(publicViewOf(state).check).toBeNull();
    expectRejected(xiangqiEngine.applyAction(state, moveAction(GUEST, [2, 3], [1, 3], "stale-1")), "illegal_move");
    expectRejected(xiangqiEngine.applyAction(state, moveAction(GUEST, [2, 3], [2, 4], "stale-2")), "illegal_move");
    expectRejected(xiangqiEngine.applyAction(state, moveAction(GUEST, [2, 3], [1, 4], "stale-3")), "illegal_move");
    expectRejected(xiangqiEngine.applyAction(state, moveAction(GUEST, [1, 4], [0, 3], "stale-4")), "illegal_move");
    expectRejected(xiangqiEngine.applyAction(state, moveAction(GUEST, [1, 4], [0, 5], "stale-5")), "illegal_move");
    expectRejected(xiangqiEngine.applyAction(state, moveAction(GUEST, [1, 4], [2, 5], "stale-6")), "illegal_move");
  });

  it("红方补一手后黑方困毙，判红胜（reason=stalemate）", () => {
    const state = crafted(rows, "red");
    const stuck = play(state, HOST, [9, 4], [9, 5], "stalemate");
    expect(publicViewOf(stuck).outcome).toEqual({
      result: "win",
      winnerParticipantHash: HOST,
      reason: "stalemate",
    });
    expect(xiangqiEngine.checkGameOver(stuck)).toBe(true);
    expect(xiangqiEngine.settle(stuck).summary.reason).toBe("stalemate");
  });
});

// ---------------------------------------------------------------------------
// 长将判和
// ---------------------------------------------------------------------------

describe("象棋 长将判和", () => {
  it("红车沿两列连续将军、局面第 3 次重复即判和（reason=perpetual_check）", () => {
    // 初始：黑帅 (0,4)，红车 (3,4) 沿 4 列将军，红帅 (9,0)。
    let state = crafted(
      [
        "....k....",
        ".........",
        ".........",
        "....R....",
        ".........",
        ".........",
        ".........",
        ".........",
        ".........",
        "K........",
      ],
      "black",
    );
    // m1 黑帅避将 → m2 红车跟到 5 列将军 → m3/m4 回到 4 列 → …… 8 手后初盘第 3 次出现。
    state = play(state, GUEST, [0, 4], [0, 5], "p-1");
    state = play(state, HOST, [3, 4], [3, 5], "p-2");
    state = play(state, GUEST, [0, 5], [0, 4], "p-3");
    state = play(state, HOST, [3, 5], [3, 4], "p-4");
    // 前两轮重复后局面计数只有 2 次，不判和；红方连续将军 3 次也不足重复数。
    expect(xiangqiEngine.checkGameOver(state)).toBe(false);
    state = play(state, GUEST, [0, 4], [0, 5], "p-5");
    state = play(state, HOST, [3, 4], [3, 5], "p-6");
    expect(xiangqiEngine.checkGameOver(state)).toBe(false);
    state = play(state, GUEST, [0, 5], [0, 4], "p-7");
    state = play(state, HOST, [3, 5], [3, 4], "p-8");
    expect(publicViewOf(state).outcome).toEqual({
      result: "draw",
      winnerParticipantHash: null,
      reason: "perpetual_check",
    });
    expect(xiangqiEngine.checkGameOver(state)).toBe(true);
    const settlement = xiangqiEngine.settle(state);
    expect(settlement.result).toBe("draw");
    expect(settlement.winnerParticipantHash).toBeNull();
    expect(settlement.summary.reason).toBe("perpetual_check");
  });
});

// ---------------------------------------------------------------------------
// 走棋历史（棋谱）
// ---------------------------------------------------------------------------

describe("象棋 走棋历史", () => {
  it("棋谱记录 from/to/吃子，moveCount 与 lastMove 同步；settle 带完整 history", () => {
    let state = play(started(), HOST, [7, 1], [7, 4], "h-1"); // 红炮平移
    state = play(state, GUEST, [2, 7], [2, 4], "h-2"); // 黑炮平移
    state = play(state, HOST, [6, 2], [5, 2], "h-3"); // 红兵进一步
    state = play(state, GUEST, [3, 2], [4, 2], "h-4"); // 黑卒进一步
    state = play(state, HOST, [5, 2], [4, 2], "h-5"); // 红兵吃黑卒
    const view = publicViewOf(state);
    expect(view.moveCount).toBe(5);
    expect(view.lastMove).toMatchObject({
      ply: 5,
      color: "red",
      from: { row: 5, col: 2 },
      to: { row: 4, col: 2 },
      piece: "P",
      captured: "p",
      participantHash: HOST,
      givesCheck: false,
    });

    // 黑方认输触发结算，settle 快照应带完整棋谱。
    const settledState = commit(xiangqiEngine.applyAction(state, action(GUEST, "resign", "h-6")));
    const settlement = xiangqiEngine.settle(settledState);
    expect(settlement.summary.moveCount).toBe(5);
    expect(settlement.summary.history).toHaveLength(5);
    const lastRecord = (settlement.summary.history as Array<Record<string, unknown>>).at(-1);
    expect(lastRecord).toMatchObject({ ply: 5, captured: "p", participantHash: HOST });
  });
});

// ---------------------------------------------------------------------------
// 协议防御（actionId / stateVersion）
// ---------------------------------------------------------------------------

describe("象棋 协议防御（actionId / stateVersion）", () => {
  it("重复 actionId 被引擎拒绝，局面不二次生效", () => {
    let state = started();
    state = play(state, HOST, [6, 4], [5, 4], "dup-1");
    const before = JSON.stringify(publicViewOf(state).board);

    const replay = xiangqiEngine.applyAction(state, moveAction(GUEST, [3, 4], [4, 4], "dup-1"));
    expectRejected(replay, "invalid_action");
    expect(JSON.stringify(publicViewOf(state).board)).toBe(before);
  });

  it("旧 stateVersion（baseVersion 落后）返回 stale_action，匹配则放行", () => {
    const state = started();
    expectRejected(
      xiangqiEngine.applyAction(state, {
        actionId: "stale-1",
        participantHash: HOST,
        action: "move",
        payload: { from: { row: 6, col: 4 }, to: { row: 5, col: 4 } },
        baseVersion: state.version - 1,
      }),
      "stale_action",
    );

    const fresh = xiangqiEngine.applyAction(state, {
      actionId: "fresh-1",
      participantHash: HOST,
      action: "move",
      payload: { from: { row: 6, col: 4 }, to: { row: 5, col: 4 } },
      baseVersion: state.version,
    });
    expect(fresh.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 认输 / 求和 / 超时
// ---------------------------------------------------------------------------

describe("象棋 结算", () => {
  it("认输：对方获胜，settle 快照带 resign", () => {
    const state = started();
    const outcome = xiangqiEngine.applyAction(state, action(GUEST, "resign", "resign-1"));
    const after = unwrap(outcome);
    expect(xiangqiEngine.checkGameOver(after)).toBe(true);
    const settlement = xiangqiEngine.settle(after);
    expect(settlement.result).toBe("resign");
    expect(settlement.winnerParticipantHash).toBe(HOST);
    expect(settlement.summary.reason).toBe("resign");
  });

  it("求和：申请 → 对方同意即和棋；自己不能同意自己的申请", () => {
    let state = started();
    state = commit(xiangqiEngine.applyAction(state, action(HOST, "offer_draw", "draw-1")));
    expect(publicViewOf(state).pendingDrawFrom).toBe(HOST);
    expectRejected(xiangqiEngine.applyAction(state, action(HOST, "accept_draw", "draw-2")), "illegal_move");

    state = commit(xiangqiEngine.applyAction(state, action(GUEST, "accept_draw", "draw-3")));
    expect(xiangqiEngine.checkGameOver(state)).toBe(true);
    const settlement = xiangqiEngine.settle(state);
    expect(settlement.result).toBe("draw");
    expect(settlement.winnerParticipantHash).toBeNull();
  });

  it("超时：截止前拒绝，到点判当前行棋方（红/房主）负", () => {
    const state = started();
    const deadline = state.deadlineAt ?? 0;
    expectRejected(xiangqiEngine.handleTimeout(state, deadline - 1), "invalid_action");

    const timedOut = unwrap(xiangqiEngine.handleTimeout(state, deadline + 1));
    expect(xiangqiEngine.checkGameOver(timedOut)).toBe(true);
    const settlement = xiangqiEngine.settle(timedOut);
    expect(settlement.result).toBe("timeout");
    expect(settlement.winnerParticipantHash).toBe(GUEST);
    expect(settlement.summary.reason).toBe("timeout");
    expect(timedOut.deadlineAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 视图与泄漏断言
// ---------------------------------------------------------------------------

describe("象棋 视图纪律（无隐藏信息但走协议裁剪）", () => {
  it("公开视图不含 yourColor 与任何引擎内部簿记字段；玩家视图仅多 yourColor", () => {
    let state = started();
    state = play(state, HOST, [6, 4], [5, 4], "leak-1");
    const publicView = xiangqiEngine.getPublicView(state).view as Record<string, unknown>;
    const hostView = xiangqiEngine.getPlayerView(state, HOST).view as Record<string, unknown>;
    const guestView = xiangqiEngine.getPlayerView(state, GUEST).view as Record<string, unknown>;

    const publicJson = JSON.stringify(publicView);
    expect(publicJson).not.toContain("yourColor");
    expect(publicJson).not.toContain("actionIds");
    expect(publicJson).not.toContain("checkStreaks");
    expect(publicJson).not.toContain("positions");
    expect(publicJson).not.toContain("turnMs");

    const publicKeys = Object.keys(publicView).sort();
    expect(Object.keys(hostView).sort()).toEqual([...publicKeys, "yourColor"].sort());
    expect(Object.keys(guestView).sort()).toEqual([...publicKeys, "yourColor"].sort());
    expect((hostView as { yourColor: string }).yourColor).toBe("red");
    expect((guestView as { yourColor: string }).yourColor).toBe("black");
    // 双方全知：除 yourColor 外，两个玩家视图与公开视图完全一致。
    expect(JSON.stringify({ ...hostView, yourColor: null })).toBe(JSON.stringify({ ...publicView, yourColor: null }));
    expect(JSON.stringify({ ...guestView, yourColor: null })).toBe(JSON.stringify({ ...publicView, yourColor: null }));
  });

  it("观战/未知身份的玩家视图 yourColor 为 null，不携带任何座次私密信息", () => {
    const state = started();
    const spectatorView = xiangqiEngine.getPlayerView(state, "hash-nobody").view as {
      yourColor: string | null;
      board: Array<Array<string | null>>;
    };
    expect(spectatorView.yourColor).toBeNull();
    expect(spectatorView.board).toEqual(publicViewOf(state).board);
  });

  it("对局已结束后动作返回 game_over，视图仍可读", () => {
    let state = started();
    state = commit(xiangqiEngine.applyAction(state, action(GUEST, "resign", "over-1")));
    expectRejected(xiangqiEngine.applyAction(state, moveAction(HOST, [6, 4], [5, 4], "over-2")), "game_over");
    expect(publicViewOf(state).outcome).not.toBeNull();
  });
});
