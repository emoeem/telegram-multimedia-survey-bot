import { beforeEach, describe, expect, it } from "vitest";

import {
  clearGameEnginesForTest,
  listGameEngines,
  resolveGameEngine,
} from "../../../../src/game/multiplayer/engine-registry";
import type {
  EngineOutcome,
  GameRoomAction,
  GameRoomPlayer,
  GameRoomState,
} from "../../../../src/game/multiplayer/engine-types";
import {
  DOU_DIZHU_JOKER_BIG,
  DOU_DIZHU_JOKER_SMALL,
  buildDoudizhuDeck,
  classifyDoudizhuPlay,
  doudizhuCardRank,
  doudizhuDeltas,
  doudizhuEngine,
  doudizhuScoreBreakdown,
  beatsDoudizhuPlay,
  shuffleDoudizhuDeck,
  sortDoudizhuHand,
  type DoudizhuEngineState,
  type DoudizhuPlayShape,
} from "../../../../src/game/multiplayer/engines/doudizhu";
import { registerBuiltinMultiplayerEngines } from "../../../../src/game/multiplayer/server-engines";

/**
 * 斗地主引擎单测(游戏批次 X3):脱离 GameRoomDO 直接驱动引擎。
 *
 * 覆盖:54 张发牌(17×3+3,确定性洗牌)、牌型识别矩阵、大小比较、叫地主流转
 * (含 all 不叫重发)、过牌与轮转(连续两家过 → 出牌方新一轮自由出)、炸弹
 * 翻倍与幂等、春天/反春天计分与积分代数和、私有视图泄漏断言(玩家 A 视图
 * 不含 B/C 手牌牌面;底牌地主确定前隐藏)、超时兜底、开局门禁(不足三人不开)、
 * actionId/baseVersion 协议防御、注册表断言。
 *
 * version 语义按协议由 DO 唯一递增:测试里的 `commit` 显式模拟 DO 的 bump,
 * 引擎自身永远不碰 version。对局走向通过直接摆盘 engineState(替换手牌/
 * 阶段字段)控制,与 xiangqi/ludo 单测同款手法。
 */

const P = ["hash-host", "hash-p2", "hash-p3"];

function roomPlayer(participantHash: string, isHost: boolean): GameRoomPlayer {
  return {
    participantHash,
    // 座位令牌按身份确定性派生(测试内恒定);生产由 DO 随机铸造。
    seatToken: `seat-${participantHash}`,
    displayName: isHost ? "房主" : `玩家${P.indexOf(participantHash) + 1}`,
    isHost,
    ready: false,
    joinedAt: new Date().toISOString(),
    leftAt: null,
  };
}

/** DO handleCreate 构造的初始房间(engineState=null,房主已入座)。 */
function baseRoom(roomId = "room_91"): GameRoomState {
  const now = new Date().toISOString();
  return {
    roomId,
    gameType: "doudizhu",
    status: "lobby",
    version: 1,
    config: {},
    rngNonce: "nonce-doudizhu",
    players: [roomPlayer(P[0]!, true)],
    engineState: null,
    createdAt: now,
    updatedAt: now,
    deadlineAt: null,
    recycleAt: null,
    closedAt: null,
  };
}

function unwrap(outcome: EngineOutcome): GameRoomState {
  if (!outcome.ok) throw new Error(`引擎拒绝:${outcome.error.code} ${outcome.error.message}`);
  return outcome.state;
}

/** 模拟 GameRoomDO 的 version bump(协议不变量一)。 */
function commit(outcome: EngineOutcome): GameRoomState {
  const state = unwrap(outcome);
  return { ...state, version: state.version + 1 };
}

function expectRejected(outcome: EngineOutcome, code: string): void {
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) expect(outcome.error.code).toBe(code);
}

/** 建房 → 依序加入另两位 → 全员 ready → 房主开局(发牌,进入叫分阶段)。 */
function started(roomId = "room_91"): GameRoomState {
  let state = commit(doudizhuEngine.createRoom(baseRoom(roomId), {}));
  for (let i = 1; i < 3; i += 1) {
    const players = state.players.filter((p) => p.participantHash !== P[i]);
    state = commit(doudizhuEngine.joinRoom({ ...state, players }, roomPlayer(P[i]!, false)));
  }
  for (const player of state.players) {
    state = commit(doudizhuEngine.setReady(state, player.participantHash, true));
  }
  return commit(doudizhuEngine.start(state, P[0]!));
}

function action(who: string, name: string, actionId: string, payload?: unknown): GameRoomAction {
  return {
    actionId,
    participantHash: who,
    action: name,
    ...(payload === undefined ? {} : { payload }),
  };
}

function engineOf(state: GameRoomState): DoudizhuEngineState {
  return state.engineState as DoudizhuEngineState;
}

/** 手工摆盘:直接替换引擎私有状态字段(与 xiangqi/ludo 单测同款手法)。 */
function withEngineState(state: GameRoomState, patch: Partial<DoudizhuEngineState>): GameRoomState {
  return { ...state, engineState: { ...engineOf(state), ...patch } };
}

/** 叫分直到 landlord 以 bidScore 成为地主(摆盘前先把叫分阶段走完)。 */
function bidToLandlord(state: GameRoomState, scores: [number, number, number], landlordSeat: number): GameRoomState {
  let next = state;
  scores.forEach((score, seat) => {
    next = commit(doudizhuEngine.applyAction(next, action(P[seat]!, "bid", `bid-${seat}`, { score })));
  });
  expect(engineOf(next).landlordSeat).toBe(landlordSeat);
  return next;
}

const c = (rank: number, copy = 0) => `${rank}:${copy}`;

beforeEach(() => {
  clearGameEnginesForTest();
  registerBuiltinMultiplayerEngines();
});

// ---------------------------------------------------------------------------
// 注册表与元数据
// ---------------------------------------------------------------------------

describe("注册表与元数据", () => {
  it("doudizhu 已注册,/api/game/types 的数据源 listGameEngines 含斗地主", () => {
    expect(resolveGameEngine("doudizhu")).toBe(doudizhuEngine);
    expect(listGameEngines().map((engine) => engine.gameType)).toContain("doudizhu");
  });

  it("meta:恰好三人开局(min=3/max=3),展示名与说明齐备", () => {
    expect(doudizhuEngine.meta?.minPlayers).toBe(3);
    expect(doudizhuEngine.meta?.maxPlayers).toBe(3);
    expect(doudizhuEngine.meta?.displayName).toBe("斗地主");
    expect((doudizhuEngine.meta?.description ?? "").length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 发牌(54 张,17×3+3,确定性洗牌)
// ---------------------------------------------------------------------------

describe("发牌与确定性洗牌", () => {
  it("整副 54 张:点数 3..2 各 4 副本 + 双王,牌码全部可解析", () => {
    const deck = buildDoudizhuDeck();
    expect(deck).toHaveLength(54);
    expect(new Set(deck).size).toBe(54);
    const ranks = deck.map((card) => doudizhuCardRank(card));
    expect(ranks.every((rank) => rank !== null)).toBe(true);
    for (let rank = 3; rank <= 15; rank += 1) {
      expect(deck.filter((card) => doudizhuCardRank(card) === rank)).toHaveLength(4);
    }
    expect(deck.filter((card) => doudizhuCardRank(card) === DOU_DIZHU_JOKER_SMALL)).toHaveLength(1);
    expect(deck.filter((card) => doudizhuCardRank(card) === DOU_DIZHU_JOKER_BIG)).toHaveLength(1);
  });

  it("非法牌码拒绝:越界点数/副本越界/双王副本非 0/非数字", () => {
    expect(doudizhuCardRank("99:0")).toBeNull();
    expect(doudizhuCardRank("2:4")).toBeNull();
    expect(doudizhuCardRank("16:1")).toBeNull();
    expect(doudizhuCardRank("17:2")).toBeNull();
    expect(doudizhuCardRank("3:x")).toBeNull();
    expect(doudizhuCardRank("3")).toBeNull();
    expect(doudizhuCardRank("x:0")).toBeNull();
    expect(doudizhuCardRank("")).toBeNull();
    expect(doudizhuCardRank(c(16))).toBe(DOU_DIZHU_JOKER_SMALL);
    expect(doudizhuCardRank(c(15, 3))).toBe(15);
  });

  it("同一房间同种子洗牌结果一致(重放基础),不同种子不同序", () => {
    const a = shuffleDoudizhuDeck(12345);
    const b = shuffleDoudizhuDeck(12345);
    expect(a.deck).toEqual(b.deck);
    expect(a.seed).toBe(b.seed);
    const other = shuffleDoudizhuDeck(12346);
    expect(a.deck).not.toEqual(other.deck);
    expect(a.seed).not.toBe(other.seed);
  });

  it("开局发牌 17×3+3:三家手牌与底牌互斥且并集为整副 54 张", () => {
    const state = started();
    const engine = engineOf(state);
    expect(state.status).toBe("playing");
    expect(engine.phase).toBe("bidding");
    expect(engine.hands.map((hand) => hand.length)).toEqual([17, 17, 17]);
    expect(engine.bottomCards).toHaveLength(3);
    const all = [...engine.hands.flat(), ...engine.bottomCards];
    expect(all).toHaveLength(54);
    expect(new Set(all).size).toBe(54);
    const deck = buildDoudizhuDeck();
    expect(new Set(all)).toEqual(new Set(deck));
  });

  it("开局门禁:不足 3 人 / 未全员 ready / 非房主 拒绝;第 4 人加入被拒", () => {
    let state = commit(doudizhuEngine.createRoom(baseRoom(), {}));
    expectRejected(doudizhuEngine.start(state, P[0]!), "invalid_action"); // 只有房主一人
    const players = state.players.filter((p) => p.participantHash !== P[1]);
    state = commit(doudizhuEngine.joinRoom({ ...state, players }, roomPlayer(P[1]!, false)));
    state = commit(doudizhuEngine.setReady(state, P[0]!, true));
    expectRejected(doudizhuEngine.start(state, P[0]!), "invalid_action"); // P2 未 ready 且只有 2 人
    // 第 3 人加入后:非房主开局被拒,全员准备后房主才能开。
    const withThird = state.players.filter((p) => p.participantHash !== P[2]);
    state = commit(doudizhuEngine.joinRoom({ ...state, players: withThird }, roomPlayer(P[2]!, false)));
    expectRejected(doudizhuEngine.start(state, P[1]!), "not_host");
    for (const player of state.players) state = commit(doudizhuEngine.setReady(state, player.participantHash, true));
    expect(doudizhuEngine.start(state, P[0]!).ok).toBe(true);
    // 满员(3 人)后再加入被拒 → DO 层会把它降级为观战。
    const full = started();
    const outsider = full.players.filter((p) => p.participantHash !== "hash-4th");
    expectRejected(
      doudizhuEngine.joinRoom({ ...full, players: outsider }, roomPlayer("hash-4th", false)),
      "invalid_action",
    );
  });
});

// ---------------------------------------------------------------------------
// 牌型识别矩阵
// ---------------------------------------------------------------------------

describe("牌型识别矩阵(classifyDoudizhuPlay)", () => {
  const ok = (cards: string[], type: string, keyRank: number, length: number) => {
    const shape = classifyDoudizhuPlay(cards);
    expect(shape).not.toBeNull();
    expect(shape?.type).toBe(type);
    expect(shape?.keyRank).toBe(keyRank);
    expect(shape?.length).toBe(length);
  };

  it("单张/对子/三张/炸弹/王炸", () => {
    ok([c(3)], "single", 3, 1);
    ok([c(15)], "single", 15, 1); // 2 是最大数牌
    ok([c(17)], "single", 17, 1);
    ok([c(5), c(5, 1)], "pair", 5, 2);
    ok([c(15), c(15, 1)], "pair", 15, 2);
    ok([c(9), c(9, 1), c(9, 2)], "triple", 9, 3);
    ok([c(9), c(9, 1), c(9, 2), c(9, 3)], "bomb", 9, 4);
    ok([c(15), c(15, 1), c(15, 2), c(15, 3)], "bomb", 15, 4);
    ok([c(DOU_DIZHU_JOKER_SMALL), c(DOU_DIZHU_JOKER_BIG)], "rocket", DOU_DIZHU_JOKER_BIG, 2);
  });

  it("三带一/三带二", () => {
    ok([c(3), c(3, 1), c(3, 2), c(4)], "triple_one", 3, 4);
    ok([c(13), c(13, 1), c(13, 2), c(15)], "triple_one", 13, 4); // 带单可以是 2
    ok([c(3), c(3, 1), c(3, 2), c(4), c(4, 1)], "triple_pair", 3, 5);
    ok([c(15), c(15, 1), c(15, 2), c(14), c(14, 1)], "triple_pair", 15, 5);
    // 3334 + 5 = 5 张不是任何牌型
    expect(classifyDoudizhuPlay([c(3), c(3, 1), c(3, 2), c(4), c(5)])).toBeNull();
  });

  it("顺子(≥5 连,2 与双王不进链)", () => {
    ok([c(3), c(4), c(5), c(6), c(7)], "straight", 7, 5);
    ok([c(10), c(11), c(12), c(13), c(14)], "straight", 14, 5); // 10JQKA
    ok([c(5), c(6), c(7), c(8), c(9), c(10), c(11), c(12)], "straight", 12, 8);
    // A2345 不连(2=15 断链)、JQKA2 顶到 2 不合法、4 张不成顺。
    expect(classifyDoudizhuPlay([c(14), c(15), c(3), c(4), c(5)])).toBeNull();
    expect(classifyDoudizhuPlay([c(11), c(12), c(13), c(14), c(15)])).toBeNull();
    expect(classifyDoudizhuPlay([c(3), c(4), c(5), c(6)])).toBeNull();
  });

  it("连对(≥3 连对,2 不进链)", () => {
    ok([c(3), c(3, 1), c(4), c(4, 1), c(5), c(5, 1)], "pair_straight", 5, 6);
    ok([c(10), c(10, 1), c(11), c(11, 1), c(12), c(12, 1), c(13), c(13, 1)], "pair_straight", 13, 8);
    expect(classifyDoudizhuPlay([c(3), c(3, 1), c(4), c(4, 1)])).toBeNull(); // 只有 2 连对
    expect(classifyDoudizhuPlay([c(15), c(15, 1), c(3), c(3, 1), c(4), c(4, 1)])).toBeNull(); // 2 断链
  });

  it("飞机(连三张链,含带单翼/带对翼)", () => {
    ok([c(3), c(3, 1), c(3, 2), c(4), c(4, 1), c(4, 2)], "plane", 4, 6);
    ok([c(3), c(3, 1), c(3, 2), c(4), c(4, 1), c(4, 2), c(5), c(5, 1), c(5, 2)], "plane", 5, 9);
    ok([c(3), c(3, 1), c(3, 2), c(4), c(4, 1), c(4, 2), c(6), c(7)], "plane_single", 4, 8); // 带单翼
    ok([c(3), c(3, 1), c(3, 2), c(4), c(4, 1), c(4, 2), c(6), c(6, 1), c(7), c(7, 1)], "plane_pair", 4, 10); // 带对翼
    // 2 与双王不进链:222 333 不是飞机链(15 > 14 断链)。
    expect(classifyDoudizhuPlay([c(15), c(15, 1), c(15, 2), c(3), c(3, 1), c(3, 2)])).toBeNull();
    // 带单翼可以带双王(拆王炸合法)。
    ok(
      [c(3), c(3, 1), c(3, 2), c(4), c(4, 1), c(4, 2), c(DOU_DIZHU_JOKER_SMALL), c(DOU_DIZHU_JOKER_BIG)],
      "plane_single",
      4,
      8,
    );
    // 带对翼的翅膀必须成对:333444 + 55 6 不是合法带对。
    expect(classifyDoudizhuPlay([c(3), c(3, 1), c(3, 2), c(4), c(4, 1), c(4, 2), c(5), c(5, 1), c(6)])).toBeNull();
  });

  it("四带二(两单或两对)", () => {
    ok([c(9), c(9, 1), c(9, 2), c(9, 3), c(3), c(5)], "four_two_single", 9, 6);
    ok([c(9), c(9, 1), c(9, 2), c(9, 3), c(3), c(3, 1), c(5), c(5, 1)], "four_two_pair", 9, 8);
    // 四带一单一对不合法。
    expect(classifyDoudizhuPlay([c(9), c(9, 1), c(9, 2), c(9, 3), c(3), c(3, 1), c(5)])).toBeNull();
  });

  it("非法输入返回 null:空牌/未知牌码/杂型", () => {
    expect(classifyDoudizhuPlay([])).toBeNull();
    expect(classifyDoudizhuPlay(["99:0"])).toBeNull();
    expect(classifyDoudizhuPlay([c(3), "junk"])).toBeNull();
    expect(classifyDoudizhuPlay([c(3), c(4), c(4, 1)])).toBeNull(); // 1+2 张
    expect(classifyDoudizhuPlay([c(3), c(4), c(5), c(7), c(8)])).toBeNull(); // 断链
  });
});

// ---------------------------------------------------------------------------
// 大小比较
// ---------------------------------------------------------------------------

describe("大小比较(beatsDoudizhuPlay)", () => {
  const shape = (type: string, keyRank: number, length: number) => ({ type, keyRank, length }) as DoudizhuPlayShape;

  it("自由出(current=null)任意合法牌型可出", () => {
    expect(beatsDoudizhuPlay(shape("single", 3, 1), null)).toBe(true);
    expect(beatsDoudizhuPlay(shape("pair", 3, 2), null)).toBe(true);
  });

  it("同型同张数比主牌点数;异型/异张数压不过", () => {
    expect(beatsDoudizhuPlay(shape("single", 5, 1), shape("single", 4, 1))).toBe(true);
    expect(beatsDoudizhuPlay(shape("single", 3, 1), shape("single", 4, 1))).toBe(false);
    expect(beatsDoudizhuPlay(shape("pair", 15, 2), shape("pair", 14, 2))).toBe(true); // 对 2 压对 A
    expect(beatsDoudizhuPlay(shape("straight", 8, 5), shape("straight", 7, 5))).toBe(true);
    expect(beatsDoudizhuPlay(shape("straight", 8, 6), shape("straight", 7, 5))).toBe(false); // 张数不同
    expect(beatsDoudizhuPlay(shape("pair", 15, 2), shape("single", 3, 1))).toBe(false); // 异型
    expect(beatsDoudizhuPlay(shape("plane", 5, 9), shape("plane", 4, 9))).toBe(true);
    expect(beatsDoudizhuPlay(shape("plane", 5, 9), shape("plane", 4, 6))).toBe(false); // 链长不同
  });

  it("炸弹压一切普通牌型,炸弹之间比点数;王炸最大", () => {
    expect(beatsDoudizhuPlay(shape("bomb", 3, 4), shape("rocket", 17, 2))).toBe(false); // 王炸最大
    expect(beatsDoudizhuPlay(shape("rocket", 17, 2), shape("bomb", 15, 4))).toBe(true);
    expect(beatsDoudizhuPlay(shape("bomb", 3, 4), shape("single", 15, 1))).toBe(true);
    expect(beatsDoudizhuPlay(shape("bomb", 3, 4), shape("plane", 14, 12))).toBe(true);
    expect(beatsDoudizhuPlay(shape("bomb", 15, 4), shape("bomb", 3, 4))).toBe(true);
    expect(beatsDoudizhuPlay(shape("bomb", 3, 4), shape("bomb", 15, 4))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 叫地主流转(含 all 不叫重发)
// ---------------------------------------------------------------------------

describe("叫地主流转", () => {
  it("叫分轮转:非本座叫分被拒;叫分必须严格高于当前最高分", () => {
    const state = started();
    expectRejected(doudizhuEngine.applyAction(state, action(P[1]!, "bid", "b1", { score: 2 })), "not_your_turn");
    expectRejected(doudizhuEngine.applyAction(state, action(P[0]!, "bid", "b0", { score: 4 })), "illegal_move");
    let next = commit(doudizhuEngine.applyAction(state, action(P[0]!, "bid", "b0", { score: 2 })));
    expectRejected(doudizhuEngine.applyAction(next, action(P[1]!, "bid", "b1", { score: 2 })), "illegal_move"); // 平分
    expectRejected(doudizhuEngine.applyAction(next, action(P[1]!, "bid", "b1", { score: 1 })), "illegal_move");
    next = commit(doudizhuEngine.applyAction(next, action(P[1]!, "bid", "b1", { score: 3 })));
    next = commit(doudizhuEngine.applyAction(next, action(P[2]!, "bid", "b2", { score: 0 })));
    const engine = engineOf(next);
    expect(engine.landlordSeat).toBe(1); // 最高分 3 分
    expect(engine.bidScore).toBe(3);
    expect(engine.phase).toBe("playing");
    expect(engine.currentTurn).toBe(1); // 地主先出
    expect(engine.hands[1]).toHaveLength(20); // 17 + 3 底牌
    expect(engine.hands[0]).toHaveLength(17);
    expect(engine.events.some((event) => event.kind === "landlord")).toBe(true);
  });

  it("全不叫 → 重发:种子前进、叫分轮归零、redealCount 计数", () => {
    const state = started();
    const before = engineOf(state);
    let next = commit(doudizhuEngine.applyAction(state, action(P[0]!, "bid", "b0", { score: 0 })));
    next = commit(doudizhuEngine.applyAction(next, action(P[1]!, "bid", "b1", { score: 0 })));
    next = commit(doudizhuEngine.applyAction(next, action(P[2]!, "bid", "b2", { score: 0 })));
    const engine = engineOf(next);
    expect(engine.phase).toBe("bidding");
    expect(engine.landlordSeat).toBeNull();
    expect(engine.bidTurn).toBe(0);
    expect(engine.bidActedSeats).toEqual([]);
    expect(engine.bids).toEqual([]);
    expect(engine.redealCount).toBe(1);
    expect(engine.rngSeed).not.toBe(before.rngSeed); // 种子随重发演进
    // 重发仍是 17×3+3。
    expect(engine.hands.map((hand) => hand.length)).toEqual([17, 17, 17]);
    expect(engine.bottomCards).toHaveLength(3);
    expect(engine.events.some((event) => event.kind === "redeal")).toBe(true);
    // 重发后可重新叫分。
    expect(doudizhuEngine.applyAction(next, action(P[0]!, "bid", "b0-2", { score: 1 })).ok).toBe(true);
  });

  it("不叫的座位进 bids 的历史记录但不进最高分竞争", () => {
    const state = started();
    let next = commit(doudizhuEngine.applyAction(state, action(P[0]!, "bid", "b0", { score: 0 })));
    next = commit(doudizhuEngine.applyAction(next, action(P[1]!, "bid", "b1", { score: 1 })));
    next = commit(doudizhuEngine.applyAction(next, action(P[2]!, "bid", "b2", { score: 0 })));
    const engine = engineOf(next);
    expect(engine.landlordSeat).toBe(1);
    expect(engine.bidScore).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 出牌轮转与过牌
// ---------------------------------------------------------------------------

/** 造一手可控对局:地主 seat0(手牌/阶段手工摆),bidScore=2。手牌统一按引擎
 * 不变量(点数降序)重排,与发牌路径的行为一致。 */
function playingRoom(hands: string[][], bottomCards: string[] = [c(6), c(7), c(8)]): GameRoomState {
  const state = bidToLandlord(started(), [1, 0, 0], 0);
  return withEngineState(state, {
    hands: hands.map((hand) => sortDoudizhuHand(hand)),
    bottomCards,
    bidScore: 2,
    currentTurn: 0,
    lastPlay: null,
    passStreak: 0,
  });
}

describe("出牌与过牌轮转", () => {
  it("自由出不能过;出牌后轮转下家", () => {
    const state = playingRoom([
      [c(3), c(4)],
      Array.from({ length: 17 }, (_, i) => c(10, i % 4 === 3 ? 3 : i % 4)),
      Array.from({ length: 17 }, (_, i) => c(12, i % 4 === 3 ? 3 : i % 4)),
    ]);
    expectRejected(doudizhuEngine.applyAction(state, action(P[0]!, "pass", "p0")), "invalid_action");
    // 非本座出牌被拒。
    expectRejected(doudizhuEngine.applyAction(state, action(P[1]!, "play", "p1", { cards: [c(10)] })), "not_your_turn");
    let next = commit(doudizhuEngine.applyAction(state, action(P[0]!, "play", "p0", { cards: [c(3)] })));
    let engine = engineOf(next);
    expect(engine.currentTurn).toBe(1);
    expect(engine.lastPlay?.shape.type).toBe("single");
    expect(engine.hands[0]).toEqual([c(4)]);
    expect(engine.playCounts).toEqual([1, 0, 0]);
    // 重复出同一张牌被拒(手里已经没有了)。
    expectRejected(doudizhuEngine.applyAction(next, action(P[0]!, "play", "p0b", { cards: [c(3)] })), "not_your_turn");
    engine = engineOf(next);
    expect(engine.currentTurn).toBe(1);
  });

  it("跟牌必须压过上一手;连续两家过 → 出牌方新一轮自由出", () => {
    const state = playingRoom([
      [c(9), c(3)],
      [c(10, 1), c(4), c(5, 1)],
      [c(7), c(6)],
    ]);
    let next = commit(doudizhuEngine.applyAction(state, action(P[0]!, "play", "p0", { cards: [c(9)] })));
    // P1 出更小的单张被拒,更大的可出。
    expectRejected(
      doudizhuEngine.applyAction(next, action(P[1]!, "play", "p1-small", { cards: [c(4)] })),
      "illegal_move",
    );
    next = commit(doudizhuEngine.applyAction(next, action(P[1]!, "play", "p1", { cards: [c(10, 1)] })));
    // P2 也压不过单张 10,只能过;P0 同样压不过。
    expectRejected(
      doudizhuEngine.applyAction(next, action(P[2]!, "play", "p2-small", { cards: [c(6)] })),
      "illegal_move",
    );
    next = commit(doudizhuEngine.applyAction(next, action(P[2]!, "pass", "p2")));
    expect(engineOf(next).passStreak).toBe(1);
    expectRejected(
      doudizhuEngine.applyAction(next, action(P[0]!, "play", "p0-small", { cards: [c(3)] })),
      "illegal_move",
    );
    next = commit(doudizhuEngine.applyAction(next, action(P[0]!, "pass", "p0-pass")));
    const engine = engineOf(next);
    expect(engine.lastPlay).toBeNull();
    expect(engine.passStreak).toBe(0);
    expect(engine.currentTurn).toBe(1); // 上一手 P1,新一轮自由出
    // 自由出任意合法牌型(手牌未出完,正常轮转下家)。
    next = commit(doudizhuEngine.applyAction(next, action(P[1]!, "play", "p1-free", { cards: [c(4)] })));
    expect(engineOf(next).lastPlay?.shape.type).toBe("single");
    expect(engineOf(next).currentTurn).toBe(2);
    expect(engineOf(next).outcome).toBeNull();
  });

  it("手牌不足/重复牌/非法牌型被服务端拒绝(客户端传什么都不可信)", () => {
    const state = playingRoom([[c(3), c(4)], [c(5)], [c(6)]]);
    expectRejected(doudizhuEngine.applyAction(state, action(P[0]!, "play", "x1", { cards: [c(10)] })), "illegal_move");
    expectRejected(
      doudizhuEngine.applyAction(state, action(P[0]!, "play", "x2", { cards: [c(3), c(3)] })),
      "illegal_move",
    );
    expectRejected(
      doudizhuEngine.applyAction(state, action(P[0]!, "play", "x3", { cards: [c(3), c(5)] })),
      "illegal_move",
    );
    expectRejected(doudizhuEngine.applyAction(state, action(P[0]!, "play", "x4", {})), "illegal_move");
    expectRejected(doudizhuEngine.applyAction(state, action(P[0]!, "play", "x5", { cards: [] })), "illegal_move");
  });

  it("炸弹翻倍并提示;农民零出牌时地主胜构成春天,与炸弹倍数叠加", () => {
    // 地主 0 手握炸弹+单张;农民全程没出过牌。
    const state = playingRoom([[c(9), c(9, 1), c(9, 2), c(9, 3), c(3)], [c(5)], [c(7), c(8)]]);
    let next = commit(
      doudizhuEngine.applyAction(state, action(P[0]!, "play", "p0-bomb", { cards: [c(9), c(9, 1), c(9, 2), c(9, 3)] })),
    );
    expect(engineOf(next).bombCount).toBe(1);
    expect(engineOf(next).events.some((event) => event.kind === "bomb")).toBe(true);
    next = commit(doudizhuEngine.applyAction(next, action(P[1]!, "pass", "p1")));
    next = commit(doudizhuEngine.applyAction(next, action(P[2]!, "pass", "p2")));
    // 新一轮自由出,地主出最后单张 3 → 手牌空 → 地主胜。
    next = commit(doudizhuEngine.applyAction(next, action(P[0]!, "play", "p0-last", { cards: [c(3)] })));
    const engine = engineOf(next);
    expect(engine.outcome?.result).toBe("win");
    expect(engine.outcome?.winnerSeat).toBe(0);
    expect(engine.outcome?.winnerSide).toBe("landlord");
    expect(engine.outcome?.spring).toBe("spring"); // 农民一张都没出过
    // 倍数:叫分2 × 炸弹2 × 春天2 = 8;地主 +16,农民各 −8(代数和 0)。
    const settlement = doudizhuEngine.settle(next);
    const deltas = settlement.summary.deltas as number[];
    expect(deltas).toEqual([16, -8, -8]);
    expect(deltas.reduce((sum, value) => sum + value, 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 幂等与版本(协议防御)
// ---------------------------------------------------------------------------

describe("幂等与版本", () => {
  it("同一 actionId 重放被拒:炸弹倍数不可能翻第二次", () => {
    const state = playingRoom([[c(9), c(9, 1), c(9, 2), c(9, 3), c(3)], [c(5)], [c(7), c(8)]]);
    const first = commit(
      doudizhuEngine.applyAction(state, action(P[0]!, "play", "same-id", { cards: [c(9), c(9, 1), c(9, 2), c(9, 3)] })),
    );
    expect(engineOf(first).bombCount).toBe(1);
    // 同一 actionId 重放(模拟网络重试):引擎防御位拒绝,倍数不变。
    const replay = doudizhuEngine.applyAction(
      first,
      action(P[0]!, "play", "same-id", { cards: [c(9), c(9, 1), c(9, 2), c(9, 3)] }),
    );
    expectRejected(replay, "invalid_action");
    expect(engineOf(first).bombCount).toBe(1);
    // 换一个 actionId 再打:已不是 P0 的回合 → not_your_turn(重放防御在先,
    // 炸弹已被上一次结算消费,倍数不可能翻第二次)。
    expectRejected(
      doudizhuEngine.applyAction(first, action(P[0]!, "play", "other-id", { cards: [c(3)] })),
      "not_your_turn",
    );
    expect(engineOf(first).bombCount).toBe(1);
  });

  it("baseVersion 落后 → stale_action;引擎绝不 bump version", () => {
    const state = playingRoom([[c(3)], [c(5)], [c(7)]]);
    expectRejected(
      doudizhuEngine.applyAction(state, {
        ...action(P[0]!, "play", "v-old", { cards: [c(3)] }),
        baseVersion: state.version - 1,
      }),
      "stale_action",
    );
    const outcome = doudizhuEngine.applyAction(state, action(P[0]!, "play", "v-ok", { cards: [c(3)] }));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.state.version).toBe(state.version); // bump 是 DO 的职责
  });

  it("结算幂等:同一终局状态重复 settle 的计分快照完全一致", () => {
    const state = playingRoom([[c(3)], [c(5)], [c(7)]]);
    const finished = commit(doudizhuEngine.applyAction(state, action(P[0]!, "play", "p0", { cards: [c(3)] })));
    const a = doudizhuEngine.settle(finished);
    const b = doudizhuEngine.settle(finished);
    expect(a.summary.score).toEqual(b.summary.score);
    expect(a.summary.deltas).toEqual(b.summary.deltas);
    // 地主胜、bidScore=2、无炸弹,但农民零出牌 → 春天 ×2:单位分 = 1×2×1×2 = 4;
    // 地主 +8,农民各 −4(代数和 0)。
    expect(a.summary.deltas).toEqual([8, -4, -4]);
    expect(a.result).toBe("win");
    expect(a.winnerSeatToken).toBe(`seat-${P[0]}`);
  });
});

// ---------------------------------------------------------------------------
// 春天/反春天判定与计分
// ---------------------------------------------------------------------------

describe("春天/反春天判定与计分", () => {
  it("春天:地主胜且两农民零出牌 → 倍数 ×2,地主 ±2 倍单位分", () => {
    const state = playingRoom([
      [c(3)],
      Array.from({ length: 17 }, (_, i) => c(10, i % 4)),
      Array.from({ length: 17 }, (_, i) => c(12, i % 4)),
    ]);
    const finished = commit(doudizhuEngine.applyAction(state, action(P[0]!, "play", "p0", { cards: [c(3)] })));
    const engine = engineOf(finished);
    expect(engine.outcome?.winnerSide).toBe("landlord");
    expect(engine.outcome?.spring).toBe("spring");
    const breakdown = doudizhuScoreBreakdown(engine.rules, engine.bidScore, engine.bombCount, engine.outcome!.spring!);
    expect(breakdown.springMultiplier).toBe(2);
    expect(breakdown.totalMultiplier).toBe(4); // 叫分2 × 炸弹因子1 × 春天2
    expect(breakdown.unit).toBe(4);
    const deltas = doudizhuDeltas(breakdown, 0, "landlord");
    expect(deltas).toEqual([8, -4, -4]);
    expect(deltas.reduce((sum, value) => sum + value, 0)).toBe(0); // 积分代数和恒为 0
  });

  it("反春天:农民胜且地主只出过第一手 → 倍数 ×2", () => {
    const state = playingRoom([[c(3), c(4)], [c(5), c(5, 1)], [c(7)]]);
    let next = commit(doudizhuEngine.applyAction(state, action(P[0]!, "play", "p0", { cards: [c(3)] })));
    next = commit(doudizhuEngine.applyAction(next, action(P[1]!, "play", "p1", { cards: [c(5)] }))); // 农民压过
    next = commit(doudizhuEngine.applyAction(next, action(P[2]!, "pass", "p2-pass")));
    next = commit(doudizhuEngine.applyAction(next, action(P[0]!, "pass", "p0-pass")));
    // 连续两家过 → 回到 P1 自由出:P1 出完最后一手 → 农民胜。
    next = commit(doudizhuEngine.applyAction(next, action(P[1]!, "play", "p1-last", { cards: [c(5, 1)] })));
    const engine = engineOf(next);
    expect(engine.outcome?.winnerSide).toBe("farmers");
    expect(engine.outcome?.winnerSeat).toBe(1);
    expect(engine.outcome?.spring).toBe("anti_spring"); // 地主只出过第一手
    expect(engine.playCounts[0]).toBe(1);
    const breakdown = doudizhuScoreBreakdown(engine.rules, engine.bidScore, engine.bombCount, engine.outcome!.spring!);
    expect(breakdown.unit).toBe(4); // 叫分2 × 无炸弹 × 反春天2
    const deltas = doudizhuDeltas(breakdown, 0, "farmers");
    expect(deltas).toEqual([-8, 4, 4]);
    expect(deltas.reduce((sum, value) => sum + value, 0)).toBe(0);
  });

  it("过牌不计入出牌数:地主只出过第一手仍是反春天", () => {
    const state = playingRoom([[c(3), c(4)], [c(5), c(6)], [c(7)]]);
    let next = commit(doudizhuEngine.applyAction(state, action(P[0]!, "play", "p0", { cards: [c(3)] })));
    next = commit(doudizhuEngine.applyAction(next, action(P[1]!, "play", "p1", { cards: [c(5)] })));
    next = commit(doudizhuEngine.applyAction(next, action(P[2]!, "pass", "p2")));
    next = commit(doudizhuEngine.applyAction(next, action(P[0]!, "pass", "p0-pass")));
    next = commit(doudizhuEngine.applyAction(next, action(P[1]!, "play", "p1-free", { cards: [c(6)] })));
    // P1 出完(摆盘只有 2 张)→ 农民胜;地主出过牌数 = 1(过牌不计),反春天成立。
    const engine = engineOf(next);
    expect(engine.playCounts[0]).toBe(1);
    expect(engine.outcome?.spring).toBe("anti_spring");
  });

  it("地主出过两手且农民出过牌 → 春天/反春天都不成立(普通倍数)", () => {
    const state = playingRoom([
      [c(8), c(10)],
      [c(9), c(5, 1), c(6, 1)],
      [c(3), c(4)],
    ]);
    let next = commit(doudizhuEngine.applyAction(state, action(P[0]!, "play", "p0a", { cards: [c(8)] })));
    next = commit(doudizhuEngine.applyAction(next, action(P[1]!, "play", "p1a", { cards: [c(9)] })));
    next = commit(doudizhuEngine.applyAction(next, action(P[2]!, "pass", "p2a-pass")));
    // P0 用 10 压过 9(第二次出牌)→ 手牌空 → 地主胜;农民出过牌 → 不是春天。
    next = commit(doudizhuEngine.applyAction(next, action(P[0]!, "play", "p0b", { cards: [c(10)] })));
    const engine = engineOf(next);
    expect(engine.outcome?.winnerSide).toBe("landlord");
    expect(engine.playCounts).toEqual([2, 1, 0]);
    expect(engine.outcome?.spring).toBe("none");
    // 普通倍数:叫分2 × 无炸弹 × 无春天 = 2;地主 +4,农民各 −2。
    const settlement = doudizhuEngine.settle(next);
    expect(settlement.summary.deltas).toEqual([4, -2, -2]);
  });
});

// ---------------------------------------------------------------------------
// 私有视图纪律(泄漏断言)
// ---------------------------------------------------------------------------

describe("私有视图纪律(泄漏断言)", () => {
  // 牌码子串会互相污染("13:1" 包含 "3:1"),泄漏断言一律用带引号的整码匹配。
  const code = (card: string) => JSON.stringify(card);

  it("玩家 A 视图不含 B/C 手牌牌面:整份视图 JSON 里搜不到他们的任何牌码", () => {
    const state = started();
    const engine = engineOf(state);
    const bHand = engine.hands[1]!;
    const cHand = engine.hands[2]!;
    const viewA = doudizhuEngine.getPlayerView(state, P[0]!).view as Record<string, unknown>;
    const jsonA = JSON.stringify(viewA);
    // 自己的手牌在(数量与牌面都对),别人的牌面一张都不许出现。
    expect((viewA.hand as string[]).length).toBe(17);
    expect(viewA.hand as string[]).toEqual(engine.hands[0]);
    for (const card of bHand) expect(jsonA).not.toContain(code(card));
    for (const card of cHand) expect(jsonA).not.toContain(code(card));
    // 其他人只有张数,没有牌面字段。
    const seats = viewA.seats as Array<{ seatIndex: number; handCount: number }>;
    expect(seats[1]?.handCount).toBe(17);
    expect(seats[2]?.handCount).toBe(17);
    expect(jsonA).not.toContain('"cards":['); // 无任何人的手牌数组字段(除出牌历史,此刻为空)
    // 叫分阶段底牌隐藏。
    expect(viewA.bottomCards).toBeNull();
    expect(viewA.bottomCount).toBe(3);
  });

  it("地主确定后底牌全场公开(含玩家视图与公开视图),地主手牌 20 张", () => {
    const state = bidToLandlord(started(), [2, 0, 0], 0);
    const engine = engineOf(state);
    const viewP2 = doudizhuEngine.getPlayerView(state, P[2]!).view as Record<string, unknown>;
    expect(viewP2.bottomCards).toEqual(engine.bottomCards);
    const publicView = doudizhuEngine.getPublicView(state).view as Record<string, unknown>;
    expect(publicView.bottomCards).toEqual(engine.bottomCards);
    // 公开视图没有任何人的「手牌」:底牌是公开信息,但地主其余 17 张与两农民
    // 的手牌一张都不许出现(地主手牌含底牌,先剔除公开的 3 张再断言)。
    const publicJson = JSON.stringify(publicView);
    expect(publicView.hand as string[]).toEqual([]);
    const landlordDealt = (engine.hands[0] ?? []).filter((card) => !(engine.bottomCards ?? []).includes(card));
    expect(landlordDealt).toHaveLength(17);
    for (const card of landlordDealt) expect(publicJson).not.toContain(code(card));
    for (const card of engine.hands[1]!) expect(publicJson).not.toContain(code(card));
    for (const card of engine.hands[2]!) expect(publicJson).not.toContain(code(card));
  });

  it("出牌历史里的牌是公开信息(打出的牌全场可见),未打出的仍不外泄", () => {
    const state = playingRoom([[c(3)], [c(5)], [c(7)]]);
    const after = commit(doudizhuEngine.applyAction(state, action(P[0]!, "play", "p0", { cards: [c(3)] })));
    const engine = engineOf(after);
    const viewP3 = doudizhuEngine.getPlayerView(after, P[2]!).view as Record<string, unknown>;
    const json = JSON.stringify(viewP3);
    // P0 打出的 3 是公开信息(历史可见)。
    expect(json).toContain(code(c(3)));
    // P0/P1 手里没打的牌仍不可见。
    for (const card of engine.hands[0]!) expect(json).not.toContain(code(card));
    for (const card of engine.hands[1]!) expect(json).not.toContain(code(card));
    // 自己的手牌在。
    expect(viewP3.hand as string[]).toEqual([c(7)]);
  });

  it("rngNonce 注入(修复 2):同 roomId 不同 nonce → 发牌不同;同 nonce → 重放一致", () => {
    /** 用指定 nonce 走完整开局(发牌进入叫分阶段)。 */
    const startedWithNonce = (nonce: string): DoudizhuEngineState => {
      let state = commit(doudizhuEngine.createRoom({ ...baseRoom("room_91"), rngNonce: nonce }, {}));
      for (let i = 1; i < 3; i += 1) {
        const players = state.players.filter((p) => p.participantHash !== P[i]);
        state = commit(doudizhuEngine.joinRoom({ ...state, players }, roomPlayer(P[i]!, false)));
      }
      for (const player of state.players) {
        state = commit(doudizhuEngine.setReady(state, player.participantHash, true));
      }
      return engineOf(commit(doudizhuEngine.start(state, P[0]!)));
    };
    const nonceA = "nonce-A";
    const a = startedWithNonce(nonceA);
    const b = startedWithNonce("nonce-B");
    // roomId 相同但 nonce 不同:发牌序列必须不同(roomId 是公开值,只由它派生
    // 种子 = 任何人都可离线复现整局)。
    expect(a.hands).not.toEqual(b.hands);
    expect(a.bottomCards).not.toEqual(b.bottomCards);
    // 同 roomId 同 nonce:发牌完全一致(重放一致性的基础)。
    const a2 = startedWithNonce(nonceA);
    expect(a2.hands).toEqual(a.hands);
    expect(a2.rngSeed).toBe(a.rngSeed);
  });

  it("种子与内部簿记绝不进任何视图(种子外泄 = 未发的牌可预测)", () => {
    const state = started();
    for (const hash of P) {
      const json = JSON.stringify(doudizhuEngine.getPlayerView(state, hash).view);
      expect(json).not.toContain("rngSeed");
      expect(json).not.toContain("actionIds");
      expect(json).not.toContain("rngNonce"); // DO 注入的 RNG 盐同样绝不进视图
    }
    const publicJson = JSON.stringify(doudizhuEngine.getPublicView(state).view);
    expect(publicJson).not.toContain("rngSeed");
    expect(publicJson).not.toContain("actionIds");
    expect(publicJson).not.toContain("rngNonce");
    // 引擎私有状态里有种子(确保上面断言不是空转)。
    expect(engineOf(state).rngSeed).toBeGreaterThan(0);
    expect(engineOf(state).actionIds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 超时兜底与认输
// ---------------------------------------------------------------------------

describe("超时兜底(handleTimeout)", () => {
  it("叫分超时视为不叫,轮转继续;三家都超时 → 重发", () => {
    const state = started();
    const after = doudizhuEngine.handleTimeout(state, (state.deadlineAt ?? 0) + 1);
    expect(after.ok).toBe(true);
    let next = unwrap(after);
    expect(engineOf(next).bidActedSeats).toEqual([0]);
    expect(engineOf(next).bidTurn).toBe(1);
    next = unwrap(doudizhuEngine.handleTimeout(next, (next.deadlineAt ?? 0) + 1));
    next = unwrap(doudizhuEngine.handleTimeout(next, (next.deadlineAt ?? 0) + 1));
    expect(engineOf(next).redealCount).toBe(1);
    // 未到时间/无倒计时的调用被拒。
    expectRejected(doudizhuEngine.handleTimeout(state, Date.now()), "invalid_action");
  });

  it("出牌自由出超时自动出最小单张;跟牌超时自动过牌", () => {
    const state = playingRoom([[c(3), c(4)], [c(5)], [c(7)]]);
    // 自由出:自动出最小单张 3(手牌按点数降序,末尾最小)。
    const rolled = unwrap(doudizhuEngine.handleTimeout(state, (state.deadlineAt ?? 0) + 1));
    expect(engineOf(rolled).hands[0]).toEqual([c(4)]);
    expect(engineOf(rolled).lastPlay?.cards).toEqual([c(3)]);
    expect(engineOf(rolled).lastPlay?.shape.type).toBe("single");
    expect(engineOf(rolled).currentTurn).toBe(1);
    // P1 跟牌超时:自动过。
    const passed = unwrap(doudizhuEngine.handleTimeout(rolled, (rolled.deadlineAt ?? 0) + 1));
    expect(engineOf(passed).passStreak).toBe(1);
    expect(engineOf(passed).currentTurn).toBe(2);
    // P2 也超时:两家过 → 回到出牌方 P0 自由出。
    const back = unwrap(doudizhuEngine.handleTimeout(passed, (passed.deadlineAt ?? 0) + 1));
    expect(engineOf(back).lastPlay).toBeNull();
    expect(engineOf(back).currentTurn).toBe(0);
  });
});

describe("认输与终局", () => {
  it("出牌阶段认输:其回合跳过,轮转直接绕开(对局继续)", () => {
    const state = playingRoom([[c(3), c(4)], [c(5)], [c(6), c(7), c(8)]]);
    // 地主出 4(剩 3)后,P1 认输(此时正轮到 P1,P1 的「过」由认输语义代走)。
    let next = commit(doudizhuEngine.applyAction(state, action(P[0]!, "play", "p0", { cards: [c(4)] })));
    next = commit(doudizhuEngine.applyAction(next, action(P[1]!, "resign", "r1")));
    let engine = engineOf(next);
    expect(engine.resignedSeats).toEqual([1]);
    expect(engine.currentTurn).toBe(2); // P1 的回合被跳过
    // P2 出 6 压过 4 后,轮转跳过 P1 直接回到 P0。
    next = commit(doudizhuEngine.applyAction(next, action(P[2]!, "play", "p2", { cards: [c(6)] })));
    engine = engineOf(next);
    expect(engine.currentTurn).toBe(0);
    // P0 压不过 6 → 过(streak 1)→ 轮到 P2;P2 自由出 7 → 又回到 P0。
    next = commit(doudizhuEngine.applyAction(next, action(P[0]!, "pass", "p0-pass")));
    expect(engineOf(next).currentTurn).toBe(2);
    next = commit(doudizhuEngine.applyAction(next, action(P[2]!, "play", "p2b", { cards: [c(7)] })));
    engine = engineOf(next);
    expect(engine.currentTurn).toBe(0);
    expect(engine.outcome).toBeNull(); // 对局仍在继续,认输者不再参与
  });

  it("叫分阶段认输视为不叫;两人认输 → 中止不计分", () => {
    const state = started();
    let next = commit(doudizhuEngine.applyAction(state, action(P[0]!, "resign", "r0")));
    expect(engineOf(next).bidActedSeats).toEqual([0]); // 视为不叫
    expect(engineOf(next).bidTurn).toBe(1);
    next = commit(doudizhuEngine.applyAction(next, action(P[1]!, "resign", "r1")));
    const engine = engineOf(next);
    expect(engine.outcome?.result).toBe("aborted"); // 在座不足两人 → 中止
    const settlement = doudizhuEngine.settle(next);
    expect(settlement.summary.deltas).toEqual([0, 0, 0]); // 中止不计分
  });

  // ---------------------------------------------------------------------------
  // 复核回归:认输/离席语义(三条曾复现的失效路径)
  // ---------------------------------------------------------------------------

  it("复核①:两家过回到已认输的出牌方 → 回合交给其后有效座位,认输者不得再出牌", () => {
    const state = playingRoom([
      [c(9), c(3)],
      [c(5), c(6, 1)],
      [c(7), c(8)],
    ]);
    // P0 出 9 成为出牌方后认输(不执回合,轮转不动)。
    let next = commit(doudizhuEngine.applyAction(state, action(P[0]!, "play", "p0", { cards: [c(9)] })));
    next = commit(doudizhuEngine.applyAction(next, action(P[0]!, "resign", "r0")));
    expect(engineOf(next).resignedSeats).toEqual([0]);
    // P1、P2 连续两家过 → 原本会回到出牌方 P0(已认输),现在交给 P1。
    next = commit(doudizhuEngine.applyAction(next, action(P[1]!, "pass", "p1")));
    next = commit(doudizhuEngine.applyAction(next, action(P[2]!, "pass", "p2")));
    const engine = engineOf(next);
    expect(engine.lastPlay).toBeNull();
    expect(engine.currentTurn).toBe(1); // 不是已认输的 P0
    // 认输者的出牌/过牌/重复认输全部被拒——不可能再拿到牌权,更不可能赢。
    expectRejected(doudizhuEngine.applyAction(next, action(P[0]!, "play", "p0b", { cards: [c(3)] })), "invalid_action");
    expectRejected(doudizhuEngine.applyAction(next, action(P[0]!, "pass", "p0-pass")), "invalid_action");
    expectRejected(doudizhuEngine.applyAction(next, action(P[0]!, "resign", "r0-again")), "invalid_action");
    // P1 自由出,对局继续。
    next = commit(doudizhuEngine.applyAction(next, action(P[1]!, "play", "p1-free", { cards: [c(5)] })));
    expect(engineOf(next).currentTurn).toBe(2);
    expect(engineOf(next).outcome).toBeNull();
  });

  it("复核②:已认输座位执回合时,超时兜底绝不代打,只推进回合(alarm 不会替离席者清牌)", () => {
    // 直接摆出「认输座位执自由出回合」的防御态(轮转不变量下不可达,兜历史
    // 脏数据/直连异常):修复前 alarm 会每轮替他把牌出完并结算为胜者。
    const state = withEngineState(playingRoom([[c(3), c(4)], [c(5)], [c(7), c(8)]]), {
      resignedSeats: [0],
      currentTurn: 0,
      lastPlay: null,
      passStreak: 0,
    });
    const skipped = unwrap(doudizhuEngine.handleTimeout(state, (state.deadlineAt ?? 0) + 1));
    const engine = engineOf(skipped);
    expect(engine.hands[0]).toEqual([c(4), c(3)]); // 手牌分毫未动
    expect(engine.currentTurn).toBe(1); // 回合交给有效座位
    expect(engine.lastPlay).toBeNull();
    expect(engine.history.at(-1)?.text).toContain("已认输,跳过其回合");
    expect(engine.events.at(-1)?.kind).toBe("timeout");
    expect(engine.outcome).toBeNull();
    // 跟牌分支同样不代打:认输座位执跟牌回合 → 跳过并推进。
    const following = withEngineState(playingRoom([[c(3)], [c(5)], [c(7), c(8)]]), {
      resignedSeats: [0],
      currentTurn: 0,
      lastPlay: { seatIndex: 2, shape: { type: "single", keyRank: 8, length: 1 }, cards: [c(8)] },
      passStreak: 0,
    });
    const skipped2 = unwrap(doudizhuEngine.handleTimeout(following, (following.deadlineAt ?? 0) + 1));
    expect(engineOf(skipped2).hands[0]).toEqual([c(3)]);
    expect(engineOf(skipped2).currentTurn).toBe(1);
  });

  it("复核③:叫分阶段认输后全不叫重发 → 认输座位没有叫分权,也不阻塞叫分轮", () => {
    const state = started();
    // P0 认输(视为不叫)→ P1、P2 都不叫 → 有效座位全不叫 → 重发。
    let next = commit(doudizhuEngine.applyAction(state, action(P[0]!, "resign", "r0")));
    next = commit(doudizhuEngine.applyAction(next, action(P[1]!, "bid", "b1", { score: 0 })));
    next = commit(doudizhuEngine.applyAction(next, action(P[2]!, "bid", "b2", { score: 0 })));
    const engine = engineOf(next);
    expect(engine.redealCount).toBe(1);
    expect(engine.resignedSeats).toEqual([0]); // 重发不清认输标记
    expect(engine.bidActedSeats).toEqual([]);
    expect(engine.bidTurn).toBe(1); // 首个叫分位跳过已认输的 P0
    // 重发后认输座位不能再叫分(修复前可重获叫分权甚至成为地主)。
    expectRejected(doudizhuEngine.applyAction(next, action(P[0]!, "bid", "b0-redeal", { score: 3 })), "invalid_action");
    // 有效座位正常叫分即可定地主:叫分轮不等待认输座位(allActed 只看未认输者)。
    next = commit(doudizhuEngine.applyAction(next, action(P[1]!, "bid", "b1-redeal", { score: 2 })));
    next = commit(doudizhuEngine.applyAction(next, action(P[2]!, "bid", "b2-redeal", { score: 0 })));
    const resolved = engineOf(next);
    expect(resolved.landlordSeat).toBe(1);
    expect(resolved.phase).toBe("playing");
    expect(resolved.currentTurn).toBe(1);
    expect(resolved.resignedSeats).toEqual([0]); // 出牌阶段继续跳过
    // 认输座位在出牌阶段同样被拒。
    expectRejected(
      doudizhuEngine.applyAction(
        next,
        action(P[0]!, "play", "p0-after", { cards: [(resolved.hands[0] ?? [])[0] ?? "3:0"] }),
      ),
      "invalid_action",
    );
  });
});

// ---------------------------------------------------------------------------
// config 校验
// ---------------------------------------------------------------------------

describe("建房 config 校验", () => {
  it("turnMs/baseScore 合法区间内生效,越界拒绝", () => {
    const ok = doudizhuEngine.createRoom(baseRoom(), { turnMs: 30_000, baseScore: 5 });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      const engine = ok.state.engineState as DoudizhuEngineState;
      expect(engine.rules).toEqual({ turnMs: 30_000, baseScore: 5 });
    }
    expectRejected(doudizhuEngine.createRoom(baseRoom(), { turnMs: 1000 }), "invalid_action");
    expectRejected(doudizhuEngine.createRoom(baseRoom(), { baseScore: 0 }), "invalid_action");
    expectRejected(doudizhuEngine.createRoom(baseRoom(), { baseScore: 1.5 }), "invalid_action");
  });
});
