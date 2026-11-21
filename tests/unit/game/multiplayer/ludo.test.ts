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
  LUDO_FINISH_POS,
  LUDO_LOOP_TOP,
  ludoEngine,
  ludoLoopCell,
  ludoRanking,
  nextLudoRandom,
  planLudoMove,
  type LudoEngineState,
  type LudoRules,
} from "../../../../src/game/multiplayer/engines/ludo";
import { registerBuiltinMultiplayerEngines } from "../../../../src/game/multiplayer/server-engines";

/**
 * 飞行棋引擎单测(游戏批次 X2-B):脱离 GameRoomDO 直接驱动引擎。
 *
 * 覆盖:座位分配(2 人对角)、六点起飞(含起飞判撞)、连六再掷与三连惩罚、
 * 跳跃/飞越虚线落点链、终点精确反弹、撞机与叠机、无子可动自动跳过、超时
 * 跳过、认输与终局、胜负排名、确定性 RNG 与重放一致、actionId/baseVersion
 * 协议防御、注册表断言、以及视图泄漏断言(rngSeed/actionIds 绝不进视图,
 * 种子外泄 = 未来骰点可预测,属隐藏信息)。
 *
 * version 语义按协议由 DO 唯一递增:测试里的 `commit` 显式模拟 DO 的 bump,
 * 引擎自身永远不碰 version。骰点是服务端权威——测试通过直接设置
 * engineState.rngSeed(用 nextLudoRandom 反推能掷出目标点数的种子)来控制
 * 掷点,引擎不提供任何客户端提交骰值的通道。
 */

const P = ["hash-host", "hash-p2", "hash-p3", "hash-p4"];

function roomPlayer(participantHash: string, isHost: boolean): GameRoomPlayer {
  return {
    participantHash,
    displayName: isHost ? "房主" : `玩家${P.indexOf(participantHash)}`,
    isHost,
    ready: false,
    joinedAt: new Date().toISOString(),
    leftAt: null,
  };
}

/** DO handleCreate 构造的初始房间(engineState=null,房主已入座)。 */
function baseRoom(roomId = "room_77"): GameRoomState {
  const now = new Date().toISOString();
  return {
    roomId,
    gameType: "ludo",
    status: "lobby",
    version: 1,
    config: {},
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

/** 建房(带配置)→ 依序加入 n-1 位玩家 → 全员 ready → 房主开局。 */
function started(playerCount: number, config: Record<string, unknown> = {}, roomId = "room_77"): GameRoomState {
  let state = commit(ludoEngine.createRoom(baseRoom(roomId), config));
  for (let i = 1; i < playerCount; i += 1) {
    const players = state.players.filter((p) => p.participantHash !== P[i]);
    state = commit(ludoEngine.joinRoom({ ...state, players }, roomPlayer(P[i]!, false)));
  }
  for (const player of state.players) {
    state = commit(ludoEngine.setReady(state, player.participantHash, true));
  }
  return commit(ludoEngine.start(state, P[0]!));
}

function action(who: string, name: string, actionId: string, payload?: unknown): GameRoomAction {
  return {
    actionId,
    participantHash: who,
    action: name,
    ...(payload === undefined ? {} : { payload }),
  };
}

function engineOf(state: GameRoomState): LudoEngineState {
  return state.engineState as LudoEngineState;
}

/** 手工摆盘:直接替换引擎私有状态字段(与 xiangqi 单测同款手法)。 */
function withEngineState(state: GameRoomState, patch: Partial<LudoEngineState>): GameRoomState {
  return { ...state, engineState: { ...engineOf(state), ...patch } };
}

/** 反推能掷出目标点数的种子(服务端权威骰点:测试只能种种子,不能提交骰值)。 */
function seedFor(roll: number): number {
  for (let seed = 1; seed < 1_000_000; seed += 1) {
    if (nextLudoRandom(seed).value === roll) return seed;
  }
  throw new Error("找不到目标骰点的种子");
}

/** 掷骰前把种子设为能掷出 roll 的值,再执行 roll 动作。 */
function doRoll(state: GameRoomState, who: string, roll: number, actionId: string): GameRoomState {
  const seeded = withEngineState(state, { rngSeed: seedFor(roll) });
  return commit(ludoEngine.applyAction(seeded, action(who, "roll", actionId)));
}

function doMove(state: GameRoomState, who: string, plane: number, actionId: string): GameRoomState {
  return commit(ludoEngine.applyAction(state, action(who, "move", actionId, { plane })));
}

/** 默认规则(planLudoMove 直测用)。 */
const RULES: LudoRules = {
  turnMs: 60_000,
  extraRollOnSix: true,
  maxConsecutiveSixes: 3,
  jumpStep: 4,
  flyStep: 12,
  flyPos: 20,
};

beforeEach(() => {
  clearGameEnginesForTest();
  registerBuiltinMultiplayerEngines();
});

// ---------------------------------------------------------------------------
// 注册表与元数据
// ---------------------------------------------------------------------------

describe("注册表与元数据", () => {
  it("ludo 已注册,/api/game/types 的数据源 listGameEngines 含飞行棋", () => {
    expect(resolveGameEngine("ludo")).toBe(ludoEngine);
    expect(listGameEngines().map((engine) => engine.gameType)).toContain("ludo");
  });

  it("meta:2–4 人,展示名与说明齐备", () => {
    expect(ludoEngine.meta?.minPlayers).toBe(2);
    expect(ludoEngine.meta?.maxPlayers).toBe(4);
    expect(ludoEngine.meta?.displayName).toBe("飞行棋");
    expect((ludoEngine.meta?.description ?? "").length).toBeGreaterThan(0);
  });

  it("几何不变量:终点 56、跑道口 50、起飞格 = 13×色号 且同色格每 4 格一个", () => {
    expect(LUDO_FINISH_POS).toBe(56);
    expect(LUDO_LOOP_TOP).toBe(50);
    for (let color = 0; color < 4; color += 1) {
      expect(ludoLoopCell(color, 0)).toBe((13 * color) % 52);
      for (let pos = 0; pos <= LUDO_LOOP_TOP; pos += 1) {
        const cell = ludoLoopCell(color, pos)!;
        if (pos % 4 === 0) {
          expect(cell % 4).toBe(color); // 自己颜色格恰好每 4 格一个
        } else {
          expect(cell % 4).not.toBe(color);
        }
      }
      expect(ludoLoopCell(color, 51)).toBeNull(); // 跑道是私有几何
    }
  });
});

// ---------------------------------------------------------------------------
// 座位分配与开局门禁
// ---------------------------------------------------------------------------

describe("座位分配与开局门禁", () => {
  it("2 人对角座位(色号 0/2),3/4 人按入座顺序", () => {
    expect(engineOf(started(2)).seats.map((seat) => seat.colorIndex)).toEqual([0, 2]);
    expect(engineOf(started(3)).seats.map((seat) => seat.colorIndex)).toEqual([0, 1, 2]);
    expect(engineOf(started(4)).seats.map((seat) => seat.colorIndex)).toEqual([0, 1, 2, 3]);
  });

  it("开局门禁:不足 2 人 / 未全员 ready / 非房主 拒绝", () => {
    let state = commit(ludoEngine.createRoom(baseRoom(), {}));
    expectRejected(ludoEngine.start(state, P[0]!), "invalid_action");
    state = commit(ludoEngine.joinRoom({ ...state, players: state.players }, roomPlayer(P[1]!, false)));
    state = commit(ludoEngine.setReady(state, P[0]!, true));
    expectRejected(ludoEngine.start(state, P[0]!), "invalid_action"); // P2 未 ready
    state = commit(ludoEngine.setReady(state, P[1]!, true));
    expectRejected(ludoEngine.start(state, P[1]!), "not_host");
    expect(ludoEngine.start(state, P[0]!).ok).toBe(true);
  });

  it("第 5 人加入被拒(房间满),joinRoom 负责把玩家追加进 players", () => {
    let state = started(4);
    const players = state.players.filter((p) => p.participantHash !== "hash-5th");
    const outcome = ludoEngine.joinRoom({ ...state, players }, roomPlayer("hash-5th", false));
    expectRejected(outcome, "invalid_action");
    // 协议契约重申:未满员时 joinRoom 的返回包含新玩家
    let two = commit(ludoEngine.createRoom(baseRoom(), {}));
    const before = two.players.length;
    two = commit(ludoEngine.joinRoom({ ...two, players: two.players }, roomPlayer(P[1]!, false)));
    expect(two.players.length).toBe(before + 1);
  });

  it("config 校验:非法 flyPos / flyStep 越界 / maxConsecutiveSixes 越界 → invalid_action", () => {
    expectRejected(ludoEngine.createRoom(baseRoom(), { flyPos: 6 }), "invalid_action"); // 非自己颜色格
    expectRejected(ludoEngine.createRoom(baseRoom(), { flyPos: 46 }), "invalid_action");
    expectRejected(ludoEngine.createRoom(baseRoom(), { flyPos: 40, flyStep: 20 }), "invalid_action"); // 飞出主环
    expectRejected(ludoEngine.createRoom(baseRoom(), { maxConsecutiveSixes: 1 }), "invalid_action");
    expectRejected(ludoEngine.createRoom(baseRoom(), { turnMs: 1 }), "invalid_action");
    expect(ludoEngine.createRoom(baseRoom(), { flyPos: 40, flyStep: 10 }).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 落点链纯函数:起飞/跳跃/飞行/反弹
// ---------------------------------------------------------------------------

describe("planLudoMove 落点链", () => {
  it("六点起飞:掷 6 落起飞格且不触发链条,掷非 6 不能起飞,已到达不能动", () => {
    expect(planLudoMove(null, 6, RULES)).toEqual({ final: 0, hops: [{ kind: "takeoff", to: 0 }] });
    expect(planLudoMove(null, 3, RULES)).toBeNull();
    expect(planLudoMove(null, 1, RULES)).toBeNull();
    expect(planLudoMove(56, 6, RULES)).toBeNull();
  });

  it("跳跃:落自己颜色格(+4)跳 4 格;普通格不跳", () => {
    expect(planLudoMove(5, 3, RULES)).toEqual({
      final: 12,
      hops: [
        { kind: "move", to: 8 },
        { kind: "jump", to: 12 },
      ],
    });
    expect(planLudoMove(5, 4, RULES)).toEqual({ final: 9, hops: [{ kind: "move", to: 9 }] }); // 9 非自己颜色
  });

  it("飞行格:落 flyPos(20)沿虚线飞 12,飞完落点仍是同色可再跳一次(跳4→飞12→再跳4)", () => {
    expect(planLudoMove(16, 4, RULES)).toEqual({
      final: 36,
      hops: [
        { kind: "move", to: 20 },
        { kind: "fly", to: 32 },
        { kind: "jump", to: 36 },
      ],
    });
    // 直接落在飞行格:飞 12 → 再跳 4
    expect(planLudoMove(19, 1, RULES)?.final).toBe(36);
  });

  it("每回合至多一跳一飞:跳完不再连锁跳(8 仍是同色格但不继续)", () => {
    expect(planLudoMove(4, 4, RULES)).toEqual({
      final: 12,
      hops: [
        { kind: "move", to: 8 },
        { kind: "jump", to: 12 },
      ],
    });
  });

  it("终点反弹:超出 56 即反弹(56−超出步数);反弹落在跑道不触发链条;恰好 56 到达", () => {
    expect(planLudoMove(54, 5, RULES)).toEqual({ final: 53, hops: [{ kind: "move", to: 53 }] }); // 59 → 56−3 = 53
    expect(planLudoMove(55, 2, RULES)?.final).toBe(55); // 57 → 56−1 = 55
    expect(planLudoMove(55, 6, RULES)?.final).toBe(51); // 61 → 56−5 = 51
    expect(planLudoMove(50, 6, RULES)).toEqual({ final: 56, hops: [{ kind: "move", to: 56 }] });
    expect(planLudoMove(48, 2, RULES)?.final).toBe(50); // 50 非同色格,不跳
    expect(planLudoMove(48, 3, RULES)?.final).toBe(51); // 进跑道,无链条
  });

  it("跳跃不越过跑道口:44 掷 4 落 48(同色格)但 48+4=52 已进跑道 → 不跳", () => {
    expect(planLudoMove(44, 4, RULES)).toEqual({
      final: 48,
      hops: [{ kind: "move", to: 48 }],
    });
  });

  it("自定义 flyPos/flyStep 生效;配置约束由 createRoom 校验", () => {
    const rules: LudoRules = { ...RULES, flyPos: 8, flyStep: 8 };
    expect(planLudoMove(4, 4, rules)).toEqual({
      final: 20,
      hops: [
        { kind: "move", to: 8 },
        { kind: "fly", to: 16 },
        { kind: "jump", to: 20 },
      ],
    });
  });
});

// ---------------------------------------------------------------------------
// 起飞与撞机
// ---------------------------------------------------------------------------

describe("六点起飞与撞机", () => {
  it("掷 6 起飞落本方起飞格;起飞后同一玩家继续掷(连六再掷的第一段)", () => {
    let state = started(2);
    expect(engineOf(state).turnSeat).toBe(0);
    state = doRoll(state, P[0]!, 6, "r1");
    state = doMove(state, P[0]!, 0, "m1");
    const engine = engineOf(state);
    expect(engine.planes[0]?.[0]).toBe(0); // 落起飞格(path 0)
    expect(engine.phase).toBe("await_roll"); // 6 点再掷
    expect(engine.turnSeat).toBe(0); // 同一玩家
  });

  it("起飞判撞:起飞格上的敌机被撞回待机", () => {
    let state = started(4);
    // 敌机(座位1,色1)摆到座位0起飞格(path 0 → 主环 0):pos = (0-13) mod 52 = 39
    state = withEngineState(state, {
      planes: [
        [null, null, null, null],
        [39, null, null, null],
        [null, null, null, null],
        [null, null, null, null],
      ],
    });
    state = doRoll(state, P[0]!, 6, "r1");
    state = doMove(state, P[0]!, 0, "m1");
    const engine = engineOf(state);
    expect(engine.planes[1]?.[0]).toBeNull(); // 被撞回待机
    expect(engine.history[0]?.captures).toEqual([{ seatIndex: 1, colorIndex: 1, planeSlot: 0 }]);
    expect(engine.history[0]?.text).toContain("撞回黄1号机");
  });

  it("走子撞机:最终落点(含跳跃后)同格敌机全部回待机;己机可叠", () => {
    let state = started(4);
    // 我机(座位0)在 path 5;敌机(座位1)摆到落点主环格:5+4=9(非同色,无链)
    // 落点主环格 = 9 → 敌机 pos = (9-13) mod 52 = 48
    state = withEngineState(state, {
      planes: [
        [5, 5, null, null], // 己方两机同格(叠机)
        [48, null, null, null],
        [null, null, null, null],
        [null, null, null, null],
      ],
    });
    state = doRoll(state, P[0]!, 4, "r1");
    state = doMove(state, P[0]!, 0, "m1");
    const engine = engineOf(state);
    expect(engine.planes[0]?.[0]).toBe(9);
    expect(engine.planes[0]?.[1]).toBe(5); // 叠机的另一架不受影响
    expect(engine.planes[1]?.[0]).toBeNull(); // 撞回待机
    expect(engine.history[0]?.captures).toEqual([{ seatIndex: 1, colorIndex: 1, planeSlot: 0 }]);
  });

  it("跳跃后的落点同样判撞:飞完再跳的终点撞回敌机", () => {
    let state = started(4);
    // 我机 path 16,掷 4 → 20(飞行格)→ 飞 32 → 跳 36;落点主环格 36
    // → 敌机(座位1)pos = (36-13) mod 52 = 23
    state = withEngineState(state, {
      planes: [
        [16, null, null, null],
        [23, null, null, null],
        [null, null, null, null],
        [null, null, null, null],
      ],
    });
    state = doRoll(state, P[0]!, 4, "r1");
    state = doMove(state, P[0]!, 0, "m1");
    const engine = engineOf(state);
    expect(engine.planes[0]?.[0]).toBe(36);
    expect(engine.planes[1]?.[0]).toBeNull();
    expect(engine.history[0]?.hops.map((hop) => hop.kind)).toEqual(["move", "fly", "jump"]);
  });
});

// ---------------------------------------------------------------------------
// 连六再掷与三连惩罚
// ---------------------------------------------------------------------------

describe("连六再掷与三连惩罚", () => {
  it("掷非 6 走子后轮换下家;掷 6 走子后同一玩家再掷", () => {
    let state = started(4);
    state = withEngineState(state, {
      planes: [
        [12, null, null, null],
        [null, null, null, null],
        [null, null, null, null],
        [null, null, null, null],
      ],
    });
    state = doRoll(state, P[0]!, 3, "r1");
    state = doMove(state, P[0]!, 0, "m1");
    expect(engineOf(state).turnSeat).toBe(1); // 非 6 → 轮换
    // 轮到座位1,掷 6 起飞 → 再掷权
    state = doRoll(state, P[1]!, 6, "r2");
    state = doMove(state, P[1]!, 0, "m2");
    expect(engineOf(state).turnSeat).toBe(1);
    expect(engineOf(state).phase).toBe("await_roll");
  });

  it("默认三连六惩罚:第三个 6 点作废不走,轮换下家", () => {
    let state = started(4);
    state = withEngineState(state, {
      planes: [
        [12, null, null, null],
        [null, null, null, null],
        [null, null, null, null],
        [null, null, null, null],
      ],
    });
    // 第一个 6:12+6=18(非同色,无链)
    state = doRoll(state, P[0]!, 6, "r1");
    state = doMove(state, P[0]!, 0, "m1");
    expect(engineOf(state).planes[0]?.[0]).toBe(18);
    // 第二个 6:18+6=24(同色)→ 跳 28;仍获再掷权
    state = doRoll(state, P[0]!, 6, "r2");
    state = doMove(state, P[0]!, 0, "m2");
    expect(engineOf(state).planes[0]?.[0]).toBe(28);
    expect(engineOf(state).sixStreak).toBe(2);
    // 第三个 6:惩罚,作废并轮换
    state = doRoll(state, P[0]!, 6, "r3");
    const engine = engineOf(state);
    expect(engine.lastRoll).toBeNull();
    expect(engine.phase).toBe("await_roll");
    expect(engine.sixStreak).toBe(0);
    expect(engine.turnSeat).toBe(1);
    expect(engine.events.at(-1)?.kind).toBe("penalty");
    expect(engine.events.at(-1)?.text).toContain("惩罚");
  });

  it("maxConsecutiveSixes=2:第二个 6 点即惩罚(规则写进配置)", () => {
    let state = started(4, { maxConsecutiveSixes: 2 });
    state = withEngineState(state, {
      planes: [
        [12, null, null, null],
        [null, null, null, null],
        [null, null, null, null],
        [null, null, null, null],
      ],
    });
    state = doRoll(state, P[0]!, 6, "r1");
    state = doMove(state, P[0]!, 0, "m1");
    expect(engineOf(state).turnSeat).toBe(0);
    state = doRoll(state, P[0]!, 6, "r2");
    expect(engineOf(state).turnSeat).toBe(1);
    expect(engineOf(state).events.at(-1)?.kind).toBe("penalty");
  });

  it("六点再掷走子后到达不会误判胜(未满 4 架继续)", () => {
    let state = started(2);
    state = withEngineState(state, {
      planes: [
        [56, 56, 56, 55],
        [null, null, null, null],
      ],
    });
    state = doRoll(state, P[0]!, 1, "r1");
    state = doMove(state, P[0]!, 3, "m1");
    const engine = engineOf(state);
    expect(engine.planes[0]?.every((pos) => pos === LUDO_FINISH_POS)).toBe(true);
    expect(engine.outcome).toEqual({ result: "win", winnerSeat: 0, reason: "finish" });
    expect(state.deadlineAt).toBeNull();
    expect(ludoEngine.checkGameOver(state)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 无子可动自动跳过
// ---------------------------------------------------------------------------

describe("无子可动自动跳过", () => {
  it("机库全空 + 掷非 6:自动跳过并提示,轮换下家", () => {
    let state = started(4);
    state = doRoll(state, P[0]!, 3, "r1");
    const engine = engineOf(state);
    expect(engine.lastRoll).toBeNull();
    expect(engine.phase).toBe("await_roll");
    expect(engine.turnSeat).toBe(1);
    expect(engine.events.at(-1)?.kind).toBe("skip");
    expect(engine.events.at(-1)?.text).toContain("无子可动");
  });

  it("跑道上的飞机任意骰点都可走(反弹兜底),不会误跳过", () => {
    let state = started(2);
    state = withEngineState(state, {
      planes: [
        [55, null, null, null],
        [10, null, null, null],
      ],
    });
    state = doRoll(state, P[0]!, 6, "r1");
    expect(engineOf(state).phase).toBe("await_move"); // 55+6=61 → 反弹 51,可走
    state = doMove(state, P[0]!, 0, "m1");
    expect(engineOf(state).planes[0]?.[0]).toBe(51);
  });

  it("机库飞机掷非 6 不能起飞 → 跳过;掷 6 可起飞", () => {
    let state = started(2);
    state = doRoll(state, P[0]!, 2, "r1");
    expect(engineOf(state).turnSeat).toBe(1); // 跳过
    // 轮到座位1(色2,2人局):机库掷 6 起飞
    state = doRoll(state, P[1]!, 6, "r2");
    expect(engineOf(state).phase).toBe("await_move");
  });
});

// ---------------------------------------------------------------------------
// 终点反弹(引擎级)与到达
// ---------------------------------------------------------------------------

describe("引擎级终点反弹与到达", () => {
  it("54 掷 5 → 反弹 53(精确步数)", () => {
    let state = started(2);
    state = withEngineState(state, {
      planes: [
        [54, null, null, null],
        [null, null, null, null],
      ],
    });
    state = doRoll(state, P[0]!, 5, "r1");
    state = doMove(state, P[0]!, 0, "m1");
    expect(engineOf(state).planes[0]?.[0]).toBe(53);
    expect(engineOf(state).turnSeat).toBe(1); // 非 6 轮换
  });

  it("到达一架即记 history 到达标记;全部到达才终局", () => {
    let state = started(2);
    state = withEngineState(state, {
      planes: [
        [50, null, null, null],
        [null, null, null, null],
      ],
    });
    state = doRoll(state, P[0]!, 6, "r1");
    state = doMove(state, P[0]!, 0, "m1");
    const engine = engineOf(state);
    expect(engine.planes[0]?.[0]).toBe(LUDO_FINISH_POS);
    expect(engine.history[0]?.text).toContain("到达");
    expect(engine.outcome).toBeNull(); // 只到达一架,继续
    expect(engine.turnSeat).toBe(0); // 6 点再掷
  });
});

// ---------------------------------------------------------------------------
// 超时(视为跳过)与认输
// ---------------------------------------------------------------------------

describe("超时与认输", () => {
  it("handleTimeout:作废当前回合(含未走骰点),轮换下家并重设倒计时", () => {
    let state = started(4);
    state = withEngineState(state, { phase: "await_move", lastRoll: 4, sixStreak: 1 });
    const armed = { ...state, deadlineAt: 1000 };
    const now = 2000;
    const outcome = ludoEngine.handleTimeout(armed, now);
    const next = unwrap(outcome);
    const engine = engineOf(next);
    expect(engine.lastRoll).toBeNull();
    expect(engine.sixStreak).toBe(0);
    expect(engine.phase).toBe("await_roll");
    expect(engine.turnSeat).toBe(1);
    expect(engine.events.at(-1)?.kind).toBe("timeout");
    expect(next.deadlineAt).toBe(now + engineOf(armed).rules.turnMs);
  });

  it("handleTimeout 未到时不处置", () => {
    const state = started(2);
    const armed = { ...state, deadlineAt: 5000 };
    expectRejected(ludoEngine.handleTimeout(armed, 1000), "invalid_action");
  });

  it("认输:飞机清回机库、回合永久跳过,对局继续;当前回合者认输则轮换", () => {
    let state = started(4);
    state = commit(ludoEngine.applyAction(state, action(P[1]!, "resign", "resign-1")));
    let engine = engineOf(state);
    expect(engine.resigned).toEqual([1]);
    expect(engine.planes[1]).toEqual([null, null, null, null]);
    expect(engine.outcome).toBeNull(); // 仍有 3 人,继续
    expect(engine.turnSeat).toBe(0);
    // 认输者掷骰被拒
    expectRejected(ludoEngine.applyAction(state, action(P[1]!, "roll", "r-x")), "invalid_action");
    // 当前回合者(座位0)认输 → 轮换到下一个未认输座位(2)
    state = commit(ludoEngine.applyAction(state, action(P[0]!, "resign", "resign-2")));
    engine = engineOf(state);
    expect(engine.turnSeat).toBe(2);
  });

  it("只剩一人未认输 → 该玩家获胜,结算含排名", () => {
    let state = started(4);
    state = commit(ludoEngine.applyAction(state, action(P[1]!, "resign", "rs1")));
    state = commit(ludoEngine.applyAction(state, action(P[2]!, "resign", "rs2")));
    state = commit(ludoEngine.applyAction(state, action(P[3]!, "resign", "rs3")));
    const engine = engineOf(state);
    expect(engine.outcome).toEqual({ result: "win", winnerSeat: 0, reason: "resign" });
    expect(ludoEngine.checkGameOver(state)).toBe(true);
    const settlement = ludoEngine.settle(state);
    expect(settlement.result).toBe("win");
    expect(settlement.winnerParticipantHash).toBe(P[0]);
    expect(settlement.summary.reason).toBe("resign");
  });
});

// ---------------------------------------------------------------------------
// 胜负排名
// ---------------------------------------------------------------------------

describe("胜负排名", () => {
  it("先全部到达者胜;其余按到达数、主环进度、座位序排名", () => {
    const state = started(4);
    const engine = withEngineState(state, {
      planes: [
        [56, 56, 56, 56], // 座位0:全到达 → 第 1
        [56, 40, 30, null], // 座位1:1 架到达,maxPos 40
        [null, null, null, null], // 座位2:0 架
        [56, 56, 20, null], // 座位3:2 架到达
      ],
    }).engineState as LudoEngineState;
    const ranking = ludoRanking(engine);
    expect(ranking.map((row) => row.seatIndex)).toEqual([0, 3, 1, 2]);
    expect(ranking.map((row) => row.rank)).toEqual([1, 2, 3, 4]);
    expect(ranking[0]!.participantHash).toBe(P[0]);

    const settlement = ludoEngine.settle(
      withEngineState(state, {
        planes: [
          [56, 56, 56, 56],
          [56, 40, 30, null],
          [null, null, null, null],
          [56, 56, 20, null],
        ],
        outcome: { result: "win", winnerSeat: 0, reason: "finish" },
      }),
    );
    expect(settlement.result).toBe("win");
    expect(settlement.summary.ranking).toEqual(ranking);
    expect(settlement.summary.moveCount).toBe(0);
  });

  it("到达数相同按主环进度(maxPos)分先后", () => {
    const state = started(2);
    const engine = withEngineState(state, {
      planes: [
        [56, 30, 10, null],
        [56, 45, 5, null],
      ],
    }).engineState as LudoEngineState;
    expect(ludoRanking(engine).map((row) => row.seatIndex)).toEqual([1, 0]); // 45 > 30
  });
});

// ---------------------------------------------------------------------------
// 幂等 / 版本 / 协议防御
// ---------------------------------------------------------------------------

describe("幂等、版本与协议防御", () => {
  it("同一 actionId 重放被拒(invalid_action)——权威去重表在 DO storage,引擎兜底", () => {
    let state = started(2);
    state = doRoll(state, P[0]!, 6, "same-id");
    expectRejected(ludoEngine.applyAction(state, action(P[0]!, "move", "same-id", { plane: 0 })), "invalid_action");
  });

  it("baseVersion 落后 → stale_action;引擎成功路径不碰 version(由 DO 统一 bump)", () => {
    const state = started(2);
    const version = state.version;
    const outcome = ludoEngine.applyAction({ ...state }, action(P[0]!, "roll", "r1"));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.state.version).toBe(version); // 引擎不 bump
    expectRejected(
      ludoEngine.applyAction(state, { ...action(P[0]!, "roll", "r2"), baseVersion: version - 1 }),
      "stale_action",
    );
    expect(ludoEngine.applyAction(state, { ...action(P[0]!, "roll", "r3"), baseVersion: version }).ok).toBe(true);
  });

  it("回合/阶段/状态门禁:别人回合 not_your_turn、未掷先走 invalid、非 playing 拒绝", () => {
    let state = started(4);
    expectRejected(ludoEngine.applyAction(state, action(P[1]!, "roll", "r1")), "not_your_turn");
    expectRejected(ludoEngine.applyAction(state, action(P[0]!, "move", "m1", { plane: 0 })), "invalid_action");
    const lobby = commit(ludoEngine.createRoom(baseRoom(), {}));
    expectRejected(ludoEngine.applyAction(lobby, action(P[0]!, "roll", "r3")), "invalid_action");
    const settled = { ...started(2), status: "settled" as const };
    expectRejected(ludoEngine.applyAction(settled, action(P[0]!, "roll", "r4")), "game_over");
  });

  it("骰值服务端权威:客户端在 roll 载荷里塞 value:6 也被忽略,骰点只由种子决定", () => {
    // 摆一架在航线的飞机(否则掷 2 会因无子可动被跳过,lastRoll 为 null)
    const state = withEngineState(started(2), {
      planes: [
        [10, null, null, null],
        [null, null, null, null],
      ],
    });
    const seeded = withEngineState(state, { rngSeed: seedFor(2) });
    const rolled = unwrap(ludoEngine.applyAction(seeded, action(P[0]!, "roll", "r1", { value: 6 })));
    expect(engineOf(rolled).lastRoll).toBe(2); // 不是载荷里的 6
  });

  it("move payload 校验:缺 plane / 越界 / 非整数 → illegal_move", () => {
    let state = started(2);
    state = doRoll(state, P[0]!, 6, "r1");
    expectRejected(ludoEngine.applyAction(state, action(P[0]!, "move", "m1", {})), "illegal_move");
    expectRejected(ludoEngine.applyAction(state, action(P[0]!, "move", "m2", { plane: 4 })), "illegal_move");
    expectRejected(ludoEngine.applyAction(state, action(P[0]!, "move", "m3", { plane: 1.5 })), "illegal_move");
    expectRejected(ludoEngine.applyAction(state, action(P[0]!, "teleport", "m4")), "illegal_move");
  });
});

// ---------------------------------------------------------------------------
// 确定性 RNG 与重放一致
// ---------------------------------------------------------------------------

describe("确定性 RNG 与重放", () => {
  /** 同一 roomId 建两个房(种子由 roomId 派生),驱动同一动作序列,断言引擎状态逐字节一致。 */
  function drive(state: GameRoomState, rounds: number): GameRoomState {
    let current = state;
    for (let i = 0; i < rounds; i += 1) {
      const engine = engineOf(current);
      if (engine.outcome) break;
      const who = engine.seats[engine.turnSeat]!.participantHash;
      if (engine.phase === "await_roll") {
        const rolled = ludoEngine.applyAction({ ...current }, action(who, "roll", `a${i}-roll`));
        if (!rolled.ok) break;
        current = { ...rolled.state, version: current.version + 1 };
      }
      const after = engineOf(current);
      if (after.phase === "await_move") {
        const legal = after.planes[after.turnSeat]!.map((pos, slot) =>
          planLudoMove(pos ?? null, after.lastRoll!, after.rules) !== null ? slot : -1,
        ).filter((slot) => slot >= 0);
        if (legal.length > 0) {
          const moved = ludoEngine.applyAction({ ...current }, action(who, "move", `a${i}-move`, { plane: legal[0] }));
          if (moved.ok) current = { ...moved.state, version: current.version + 1 };
        }
      }
    }
    return current;
  }

  it("同房间 + 同动作序列 → 引擎状态完全一致(重放一致)", () => {
    const initial = engineOf(started(4)).rngSeed; // 种子由 roomId 派生,同房间恒定
    const a = drive(started(4), 40);
    const b = drive(started(4), 40);
    expect(JSON.stringify(engineOf(a))).toBe(JSON.stringify(engineOf(b)));
    expect(engineOf(a).history.length).toBeGreaterThan(0); // 确实走起来了
    expect(engineOf(a).rngSeed).not.toBe(initial); // 种子随每次掷骰演进
  });

  it("种子只由 roomId 派生:同房间恒定、跨房间不同;config.seed 不存在(无外部种子作弊通道)", () => {
    const a = engineOf(started(4));
    expect(a.rngSeed).toBe(engineOf(started(4)).rngSeed); // 同 roomId → 同种子,重放一致的基础
    expect(a.rngSeed).not.toBe(engineOf(started(4, {}, "room_88")).rngSeed); // 跨房间不同
    // 建房 config 里塞 seed 不影响初始种子(REST 会原样透传 config,引擎必须无视它)
    const tricked = engineOf(started(4, { seed: 1 } as Record<string, unknown>));
    expect(tricked.rngSeed).toBe(a.rngSeed);
  });
});

// ---------------------------------------------------------------------------
// 视图泄漏断言(私有视图纪律)
// ---------------------------------------------------------------------------

describe("视图泄漏断言", () => {
  it("rngSeed/actionIds/种子值绝不进任何视图(种子外泄 = 未来骰点可预测)", () => {
    let state = started(4);
    const initialSeed = engineOf(state).rngSeed; // roomId 派生的初值(可由 roomId 重算,更不得进视图)
    state = doRoll(state, P[0]!, 6, "r1");
    state = doMove(state, P[0]!, 0, "m1");
    const seedAfter = engineOf(state).rngSeed;
    for (const hash of [...P.slice(0, 4), "hash-spectator"]) {
      const { view } = ludoEngine.getPlayerView(state, hash);
      const json = JSON.stringify(view);
      expect(json).not.toContain("rngSeed");
      expect(json).not.toContain("actionIds");
      expect(json).not.toContain(String(initialSeed));
      expect(json).not.toContain(String(seedAfter));
      const publicJson = JSON.stringify(ludoEngine.getPublicView(state).view);
      expect(publicJson).not.toContain("rngSeed");
      expect(publicJson).not.toContain("actionIds");
    }
  });

  it("无隐藏信息:玩家视图 = 公开视图 + yourSeat;各玩家看到的局面一致", () => {
    let state = started(4);
    state = doRoll(state, P[0]!, 4, "r1");
    const pv0 = ludoEngine.getPlayerView(state, P[0]!).view as Record<string, unknown>;
    const pv2 = ludoEngine.getPlayerView(state, P[2]!).view as Record<string, unknown>;
    const pub = ludoEngine.getPublicView(state).view as Record<string, unknown>;
    const { yourSeat: seat0, ...rest0 } = pv0;
    const { yourSeat: seat2, ...rest2 } = pv2;
    expect(seat0).toBe(0);
    expect(seat2).toBe(2);
    expect(rest0).toEqual(pub);
    expect(rest2).toEqual(pub);
  });

  it("观战者/离席者 yourSeat 为 null,视图与玩家同一载荷", () => {
    const state = started(2);
    const spectator = ludoEngine.getPlayerView(state, "hash-spectator").view as Record<string, unknown>;
    expect(spectator.yourSeat).toBeNull();
    expect(spectator.turnSeat).toBe(0);
  });
});
