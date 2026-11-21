import { beforeEach, describe, expect, it } from "vitest";

import {
  clearGameEnginesForTest,
  listGameEngines,
  resolveGameEngine,
} from "../../../../src/game/multiplayer/engine-registry";
import type { GameRoomAction, GameRoomPlayer, GameRoomState } from "../../../../src/game/multiplayer/engine-types";
import { chatPurgeRequired } from "../../../../src/game/multiplayer/chat-logic";
import {
  WEREWOLF_ALL_ROLES,
  werewolfBoard,
  werewolfEngine,
  type WerewolfEngineState,
  type WerewolfRole,
} from "../../../../src/game/multiplayer/engines/werewolf";
import { registerBuiltinMultiplayerEngines } from "../../../../src/game/multiplayer/server-engines";

/**
 * 狼人杀引擎单测(游戏批次 R2):脱离 GameRoomDO 直接驱动引擎。
 *
 * 覆盖:身份板(6-12 人标准预女猎守板 + rolePlan 覆盖校验)、开局门禁、
 * 一整夜结算矩阵(守卫救/女巫毒/同刀同救/平安夜/连守禁)、查验结果私有性、
 * 投票与平票 PK、猎人开枪条件(被刀可开/被放逐可开/被毒不能开)、胜负判定
 * (狼全灭好人胜/屠城狼胜)、私有视图泄漏断言(玩家 A 视图不含 B 的角色;
 * 公开视图无角色表;死因不外泄)、掉线托管(发言/投票超时弃票、狼刀随机
 * 目标可配置)、频道裁剪(chatMembership:wolves 仅存活狼;对局结束聊天
 * 即焚的纯判定)、幂等(actionId)/版本(baseVersion)协议防御。
 *
 * version 语义按协议由 DO 唯一递增:测试里的 `commit` 显式模拟 DO 的 bump,
 * 引擎自身永远不碰 version。身份由确定性 RNG 洗牌分配,测试通过白盒读取
 * engineState.seats 发现各座位身份后驱动动作(与 doudizhu/ludo 单测的摆盘
 * 手法同源),不硬编码身份位置。夜晚阶段链:守卫(9 人板起)→ 狼 → 预言家
 * → 女巫(窗口开放,witch_pass/超时收窗)→ 天亮。
 */

const P = Array.from({ length: 12 }, (_, i) => `hash-p${i + 1}`);

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

function baseRoom(roomId = "room_r2", players: GameRoomPlayer[] = [roomPlayer(P[0]!, true)]): GameRoomState {
  const now = new Date().toISOString();
  return {
    roomId,
    gameType: "werewolf",
    status: "lobby",
    version: 1,
    config: {},
    rngNonce: "nonce-werewolf",
    players,
    engineState: null,
    createdAt: now,
    updatedAt: now,
    deadlineAt: null,
    recycleAt: null,
    closedAt: null,
  };
}

function unwrap(outcome: ReturnType<typeof werewolfEngine.createRoom>): GameRoomState {
  if (!outcome.ok) throw new Error(`引擎拒绝:${outcome.error.code} ${outcome.error.message}`);
  return outcome.state;
}

/** 模拟 GameRoomDO 的 version bump(协议不变量一)。 */
function commit(outcome: ReturnType<typeof werewolfEngine.createRoom>): GameRoomState {
  const state = unwrap(outcome);
  return { ...state, version: state.version + 1 };
}

function expectRejected(outcome: { ok: boolean; error?: { code: string; message: string } }, code: string): void {
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) expect(outcome.error?.code).toBe(code);
}

let actSeq = 0;

function engineOf(state: GameRoomState): WerewolfEngineState {
  return state.engineState as WerewolfEngineState;
}

/** 以座位号发起动作(座位 i ↔ 第 i 个入座玩家 P[i];身份白盒发现后驱动)。 */
function act(state: GameRoomState, seatIndex: number, name: string, payload?: unknown): GameRoomState {
  actSeq += 1;
  const who = engineOf(state).seats[seatIndex]?.participantHash ?? P[seatIndex]!;
  return commit(
    werewolfEngine.applyAction(state, {
      actionId: `t-${actSeq}`,
      participantHash: who,
      action: name,
      ...(payload === undefined ? {} : { payload }),
    }),
  );
}

function rawAction(
  state: GameRoomState,
  seatIndex: number,
  name: string,
  actionId: string,
  payload?: unknown,
  baseVersion?: number,
): GameRoomAction {
  const who = engineOf(state).seats[seatIndex]?.participantHash ?? P[seatIndex]!;
  return {
    actionId,
    participantHash: who,
    action: name,
    ...(payload === undefined ? {} : { payload }),
    ...(baseVersion === undefined ? {} : { baseVersion }),
  };
}

/** 超时托管一步(alarm 语义:now = deadlineAt 即视为到点)。 */
function tick(state: GameRoomState): GameRoomState {
  const deadline = state.deadlineAt;
  expect(deadline, "对局中应有阶段倒计时").not.toBeNull();
  return commit(werewolfEngine.handleTimeout(state, deadline ?? 0));
}

function roleSeat(state: GameRoomState, role: WerewolfRole): number {
  const index = engineOf(state).seats.findIndex((seat) => seat.role === role);
  expect(index, `身份 ${role} 应存在于该身份板`).toBeGreaterThanOrEqual(0);
  return index;
}

function aliveWolfSeats(state: GameRoomState): number[] {
  const engine = engineOf(state);
  return engine.seats
    .map((seat, index) => {
      if (seat.role !== "werewolf" || !seat.alive) return -1;
      const player = state.players.find((row) => row.participantHash === seat.participantHash);
      return player && player.leftAt === null ? index : -1; // 离席(托管)狼不可提交
    })
    .filter((index) => index >= 0);
}

/** 存活非狼目标(默认避开女巫,便于「女巫救人」类用例的干净目标)。 */
function plainGoodSeat(state: GameRoomState): number {
  const witch = engineOf(state).seats.findIndex((seat) => seat.role === "witch");
  const seat = engineOf(state).seats.findIndex(
    (item, index) => item.alive && item.role !== "werewolf" && index !== witch,
  );
  expect(seat).toBeGreaterThanOrEqual(0);
  return seat;
}

/** 全部存活座位号(投票者/候选按存活动态取,不假设某个身份活着)。 */
function aliveIdx(state: GameRoomState): number[] {
  return engineOf(state)
    .seats.map((seat, index) => (seat.alive ? index : -1))
    .filter((index) => index >= 0);
}

function withEngineState(state: GameRoomState, patch: Partial<WerewolfEngineState>): GameRoomState {
  return { ...state, engineState: { ...engineOf(state), ...patch } };
}

/** 守卫阶段超时跳过(不守护),推进到狼人窗口。 */
function skipGuard(state: GameRoomState): GameRoomState {
  return engineOf(state).phase === "night_guard" ? tick(state) : state;
}

/** 全体可行动狼各提交一次刀口(群狼一致,后提交覆盖前者;提交满即收窗)。 */
function wolfKnife(state: GameRoomState, target: number): GameRoomState {
  let next = skipGuard(state);
  for (const wolf of aliveWolfSeats(next)) next = act(next, wolf, "wolf_kill", { target });
  return next;
}

/** 推进到女巫窗口(守卫/狼/预言家均按超时跳过)。 */
function toWitchPhase(state: GameRoomState): GameRoomState {
  let next = skipGuard(state);
  if (engineOf(next).phase === "night_wolf") next = tick(next); // 狼窗超时(空刀或随机刀)
  if (engineOf(next).phase === "night_seer") next = tick(next);
  expect(engineOf(next).phase).toBe("night_witch");
  return next;
}

/** 夜晚阶段一路超时到天亮(守卫/狼/预言家/女巫均放弃行动);终局即停。 */
function nightToDawn(state: GameRoomState): GameRoomState {
  let next = state;
  while (engineOf(next).phase.startsWith("night_") && engineOf(next).outcome === null) next = tick(next);
  return next;
}

/** 发言阶段一路超时(每人放弃发言)到投票。 */
function skipSpeeches(state: GameRoomState): GameRoomState {
  let next = state;
  while (engineOf(next).phase === "day_speak") next = tick(next);
  return next;
}

/** 从夜里推进到投票阶段(过完一整夜 + 发言全弃)。 */
function toVote(state: GameRoomState): GameRoomState {
  const next = skipSpeeches(nightToDawn(state));
  expect(engineOf(next).phase).toBe("day_vote");
  return next;
}

/** 建房 → 依序入座 n 人 → 全员准备 → 房主开局(进入夜 1)。 */
function started(n: number, roomId = "room_r2", config: Record<string, unknown> = {}): GameRoomState {
  let state = commit(werewolfEngine.createRoom(baseRoom(roomId), config));
  for (let i = 1; i < n; i += 1) {
    const players = state.players.filter((p) => p.participantHash !== P[i]);
    state = commit(werewolfEngine.joinRoom({ ...state, players }, roomPlayer(P[i]!, false)));
  }
  for (const player of state.players) {
    state = commit(werewolfEngine.setReady(state, player.participantHash, true));
  }
  return commit(werewolfEngine.start(state, P[0]!));
}

/** 组好 n 人全员准备的 lobby(不开局;开局失败类用例用)。 */
function readyLobby(n: number, roomId: string, config: Record<string, unknown> = {}): GameRoomState {
  let state = commit(werewolfEngine.createRoom(baseRoom(roomId), config));
  for (let i = 1; i < n; i += 1) {
    const players = state.players.filter((p) => p.participantHash !== P[i]);
    state = commit(werewolfEngine.joinRoom({ ...state, players }, roomPlayer(P[i]!, false)));
  }
  for (const player of state.players) {
    state = commit(werewolfEngine.setReady(state, player.participantHash, true));
  }
  return state;
}

function viewJson(state: GameRoomState, seatIndex: number | null): string {
  const view =
    seatIndex === null
      ? werewolfEngine.getPublicView(state).view
      : werewolfEngine.getPlayerView(state, P[seatIndex]!).view;
  return JSON.stringify(view);
}

beforeEach(() => {
  clearGameEnginesForTest();
  registerBuiltinMultiplayerEngines();
  actSeq = 0;
});

// ---------------------------------------------------------------------------
// 注册表与元数据
// ---------------------------------------------------------------------------

describe("注册表与元数据", () => {
  it("werewolf 已注册,/api/game/types 的数据源含狼人杀", () => {
    expect(resolveGameEngine("werewolf")).toBe(werewolfEngine);
    expect(listGameEngines().map((engine) => engine.gameType)).toContain("werewolf");
  });

  it("meta:6-12 人开局,展示名与说明齐备", () => {
    expect(werewolfEngine.meta?.minPlayers).toBe(6);
    expect(werewolfEngine.meta?.maxPlayers).toBe(12);
    expect(werewolfEngine.meta?.displayName).toBe("狼人杀");
    expect((werewolfEngine.meta?.description ?? "").length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 身份板(标准预女猎守板 + rolePlan 覆盖)
// ---------------------------------------------------------------------------

describe("rngNonce 注入(修复 2)", () => {
  /** 用指定 nonce 走 9 人完整开局,取座位 → 身份序列。 */
  const rolesWithNonce = (nonce: string): WerewolfRole[] => {
    let state = commit(werewolfEngine.createRoom({ ...baseRoom("room_r2"), rngNonce: nonce }, {}));
    for (let i = 1; i < 9; i += 1) {
      const players = state.players.filter((p) => p.participantHash !== P[i]);
      state = commit(werewolfEngine.joinRoom({ ...state, players }, roomPlayer(P[i]!, false)));
    }
    for (const player of state.players) {
      state = commit(werewolfEngine.setReady(state, player.participantHash, true));
    }
    const started = commit(werewolfEngine.start(state, P[0]!));
    return (started.engineState as WerewolfEngineState).seats.map((seat) => seat.role);
  };

  it("同 roomId 不同 nonce → 身份序列不同;同 nonce → 重放一致", () => {
    const a = rolesWithNonce("nonce-A");
    const b = rolesWithNonce("nonce-B");
    // roomId 是公开值(深链接即可得),只由它派生种子 = 审计实测的离线复现
    // (room_456 两次开局身份序列完全相同)。nonce 打破这一通道。
    expect(a).not.toEqual(b);
    expect(rolesWithNonce("nonce-A")).toEqual(a); // 同 nonce 重放一致
    // 身份板构成不变(只是洗牌序不同):标准 9 人板 = 3 狼 + 预女猎守 + 3 民。
    const count = (roles: WerewolfRole[], role: WerewolfRole) => roles.filter((r) => r === role).length;
    for (const roles of [a, b]) {
      expect(count(roles, "werewolf")).toBe(3);
      expect(count(roles, "villager")).toBe(2); // 9 人标准板:3狼+预女猎守+2民
    }
  });

  it("rngNonce 与种子绝不进任何视图(含玩家私有视图与公开视图)", () => {
    const state = started(9);
    for (const seatIndex of [0, 1, null]) {
      const json = viewJson(state, seatIndex);
      expect(json).not.toContain("rngSeed");
      expect(json).not.toContain("rngNonce");
    }
  });
});

describe("身份板(werewolfBoard)", () => {
  it("标准板:狼数 6-7 人 2 狼 / 8-10 人 3 狼 / 11-12 人 4 狼;猎人 ≥7 人、守卫 ≥9 人", () => {
    const expectations: Array<[number, number, boolean, boolean]> = [
      [6, 2, false, false],
      [7, 2, true, false],
      [8, 3, true, false],
      [9, 3, true, true],
      [10, 3, true, true],
      [11, 4, true, true],
      [12, 4, true, true],
    ];
    for (const [seats, wolves, hunter, guard] of expectations) {
      const plan = werewolfBoard(seats);
      const total =
        plan.wolves +
        (plan.seer ? 1 : 0) +
        (plan.witch ? 1 : 0) +
        (plan.hunter ? 1 : 0) +
        (plan.guard ? 1 : 0) +
        plan.villagers;
      expect(total, `${seats} 人板总数`).toBe(seats);
      expect(plan.wolves).toBe(wolves);
      expect(plan.hunter).toBe(hunter);
      expect(plan.guard).toBe(guard);
      // 屠城口径:开局狼必须严格少于好人。
      expect(plan.wolves).toBeLessThan(seats - plan.wolves);
    }
  });

  it("开局后各身份数量与身份板一致,全员在世,夜 1 开局", () => {
    const state = started(9);
    const engine = engineOf(state);
    const plan = werewolfBoard(9);
    for (const role of WEREWOLF_ALL_ROLES) {
      const expected =
        role === "werewolf"
          ? plan.wolves
          : role === "villager"
            ? plan.villagers
            : (plan as unknown as Record<string, boolean>)[role]
              ? 1
              : 0;
      expect(engine.seats.filter((seat) => seat.role === role)).toHaveLength(expected);
    }
    expect(engine.seats.every((seat) => seat.alive && seat.deathCause === null)).toBe(true);
    expect(engine.day).toBe(1);
  });

  it("rolePlan 覆盖:合法板按配置分配;总数不匹配/狼≥好人开局被拒", () => {
    const ok = started(8, "room_plan_ok", {
      rolePlan: { wolves: 2, seer: true, witch: true, hunter: true, guard: true, villagers: 2 },
    });
    const engine = engineOf(ok);
    expect(engine.seats.filter((seat) => seat.role === "werewolf")).toHaveLength(2);
    expect(engine.seats.filter((seat) => seat.role === "villager")).toHaveLength(2);
    expect(engine.seats.filter((seat) => seat.role === "guard")).toHaveLength(1);

    // 总数不匹配(5 人板给了 5 个身份但坐 6 人)。
    const badTotal = readyLobby(6, "room_plan_bad", {
      rolePlan: { wolves: 2, seer: true, witch: true, hunter: false, guard: false, villagers: 1 },
    });
    expectRejected(werewolfEngine.start(badTotal, P[0]!), "invalid_action");

    // 狼 ≥ 好人的板 = 开局即屠城,不构成对局。
    const wolfHeavy = readyLobby(6, "room_plan_heavy", {
      rolePlan: { wolves: 3, seer: true, witch: false, hunter: false, guard: false, villagers: 2 },
    });
    expectRejected(werewolfEngine.start(wolfHeavy, P[0]!), "invalid_action");
  });
});

// ---------------------------------------------------------------------------
// 开局门禁与加入上限
// ---------------------------------------------------------------------------

describe("开局门禁与加入上限", () => {
  it("不足 6 人开局被拒;第 13 人加入被拒(满 12 上限)", () => {
    const lobby5 = readyLobby(5, "room_gate");
    expectRejected(werewolfEngine.start(lobby5, P[0]!), "invalid_action");

    // 补到 12 人后,新身份(第 13 人)加入被拒。
    let state = lobby5;
    for (let i = 5; i < 12; i += 1) {
      const players = state.players.filter((p) => p.participantHash !== P[i]);
      state = commit(werewolfEngine.joinRoom({ ...state, players }, roomPlayer(P[i]!, false)));
    }
    expect(state.players).toHaveLength(12);
    expectRejected(
      werewolfEngine.joinRoom(
        { ...state, players: state.players.filter((p) => p.participantHash !== "hash-13th") },
        roomPlayer("hash-13th", false),
      ),
      "invalid_action",
    );
  });

  it("非房主开局被拒(not_host);未全员准备开局被拒", () => {
    let state = commit(werewolfEngine.createRoom(baseRoom("room_host"), {}));
    const players = state.players.filter((p) => p.participantHash !== P[1]);
    state = commit(werewolfEngine.joinRoom({ ...state, players }, roomPlayer(P[1]!, false)));
    expectRejected(werewolfEngine.start(state, P[1]!), "not_host");
    state = commit(werewolfEngine.setReady(state, P[0]!, true));
    expectRejected(werewolfEngine.start(state, P[0]!), "invalid_action");
  });
});

// ---------------------------------------------------------------------------
// 私有视图纪律(泄漏断言——本引擎的重中之重)
// ---------------------------------------------------------------------------

describe("私有视图纪律(泄漏断言)", () => {
  it("玩家 A 视图不含 B 的角色:每个座位的视图 JSON 里只出现自己的角色键", () => {
    const room = started(9, "room_leak");
    const engine = engineOf(room);
    for (let a = 0; a < engine.seats.length; a += 1) {
      const json = viewJson(room, a);
      expect(json, `座位 ${a} 应看到自己的角色`).toContain(`"yourRole":"${engine.seats[a]!.role}"`);
      for (const role of WEREWOLF_ALL_ROLES) {
        if (role === engine.seats[a]!.role) continue;
        expect(json, `座位 ${a}(=${engine.seats[a]!.role}) 不应泄漏 ${role}`).not.toContain(`"${role}"`);
      }
      // 座位表投影只有 seatIndex/alive/isYou,没有角色字段。
      expect(json).not.toContain('"role":');
    }
  });

  it("广播帧(公开视图)不含任何角色表与角色键", () => {
    const room = started(9, "room_leak_pub");
    const publicJson = viewJson(room, null);
    for (const role of WEREWOLF_ALL_ROLES) expect(publicJson).not.toContain(`"${role}"`);
    expect(publicJson).not.toContain('"yourRole"');
    expect(publicJson).not.toContain('"yourAlive"');
    expect(publicJson).not.toContain('"role":');
    // 座位投影只有 seatIndex/alive/isYou。
    expect(publicJson).toContain('"alive":');
  });

  it("死亡不揭示身份:夜损公布座位名单,公开视图无死因无角色;狼刀口不进非狼视图", () => {
    let room = started(9, "room_leak_dead");
    const victim = plainGoodSeat(room);
    room = nightToDawn(wolfKnife(room, victim));
    const engine = engineOf(room);
    expect(engine.seats[victim]!.alive).toBe(false);
    // 公开死讯:座位名单在 lastNightDeaths,无死因无身份。
    const publicView = werewolfEngine.getPublicView(room).view as Record<string, unknown>;
    expect(publicView.lastNightDeaths).toEqual([victim]);
    const publicJson = JSON.stringify(publicView);
    expect(publicJson).not.toContain('"deathCause"');
    for (const role of WEREWOLF_ALL_ROLES) expect(publicJson).not.toContain(`"${role}"`);
    // 刀口字段只属于狼人技能面:公开视图/非狼视图都没有 nightKnife 键。
    expect(publicJson).not.toContain('"nightKnife"');
    for (let seat = 0; seat < engine.seats.length; seat += 1) {
      if (engine.seats[seat]!.role === "werewolf") continue;
      expect(viewJson(room, seat)).not.toContain('"nightKnife"');
    }
    // 狼人视图携带当夜刀口(群狼技能面)——此刻已是白天,刀口已清空。
    const wolfSeat = aliveWolfSeats(room)[0]!;
    expect((werewolfEngine.getPlayerView(room, P[wolfSeat]!).view as Record<string, unknown>).nightKnife).toBeNull();
  });

  it("夜晚动作结果只发给动作者:查验/守护/用药事件按 audience 裁剪", () => {
    let room = started(9, "room_leak_priv");
    const seer = roleSeat(room, "seer");
    const guard = roleSeat(room, "guard");
    const guardTarget = plainGoodSeat(room);
    if (engineOf(room).phase === "night_guard") {
      room = act(room, guard, "guard", { target: guardTarget });
    }
    room = wolfKnife(room, plainGoodSeat(room));
    if (engineOf(room).phase === "night_seer") {
      room = act(room, seer, "seer_check", { target: aliveWolfSeats(room)[0]! });
    }
    if (engineOf(room).phase === "night_witch") {
      room = act(room, roleSeat(room, "witch"), "witch_pass");
    }
    const seerJson = viewJson(room, seer);
    expect(seerJson).toContain('"checkResults"');
    expect(seerJson).toContain("你查验了");
    for (let seat = 0; seat < engineOf(room).seats.length; seat += 1) {
      if (seat === seer) continue;
      const json = viewJson(room, seat);
      expect(json).not.toContain('"checkResults"');
      expect(json).not.toContain("你查验了");
    }
    // 守护事件只有守卫可见。
    const guardJson = viewJson(room, guard);
    expect(guardJson).toContain("你守护了");
    for (let seat = 0; seat < engineOf(room).seats.length; seat += 1) {
      if (seat === guard) continue;
      expect(viewJson(room, seat)).not.toContain("你守护了");
    }
    // 女巫药瓶状态只有女巫可见;刀口只在女巫的行动窗口可见。
    const witch = roleSeat(room, "witch");
    expect(viewJson(room, witch)).toContain('"potions"');
    for (let seat = 0; seat < engineOf(room).seats.length; seat += 1) {
      if (seat === witch) continue;
      const json = viewJson(room, seat);
      expect(json).not.toContain('"potions"');
      expect(json).not.toContain('"tonightKnife"');
    }
  });

  it("种子与内部簿记绝不进任何视图", () => {
    const room = started(9, "room_leak_book");
    for (let seat = 0; seat < engineOf(room).seats.length; seat += 1) {
      const json = viewJson(room, seat);
      expect(json).not.toContain("rngSeed");
      expect(json).not.toContain("actionIds");
      expect(json).not.toContain('"deathCause"');
    }
    expect(viewJson(room, null)).not.toContain("rngSeed");
    expect(engineOf(room).rngSeed).toBeGreaterThan(0);
    expect(engineOf(room).actionIds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 一整夜结算矩阵(守卫救/女巫救/同刀同救/女巫毒/平安夜)
// ---------------------------------------------------------------------------

describe("一整夜结算矩阵(9 人板:预女猎守齐备)", () => {
  it("守卫守护狼刀目标 → 平安夜(守卫救)", () => {
    let room = started(9, "room_n1");
    const guard = roleSeat(room, "guard");
    const victim = plainGoodSeat(room);
    expect(engineOf(room).phase).toBe("night_guard");
    room = act(room, guard, "guard", { target: victim });
    room = nightToDawn(wolfKnife(room, victim));
    expect(engineOf(room).seats[victim]!.alive).toBe(true);
    expect(engineOf(room).lastNightDeaths).toEqual([]);
    expect(viewJson(room, null)).toContain("平安夜");
  });

  it("女巫解药救狼刀目标 → 平安夜(女巫救)", () => {
    let room = started(9, "room_n2");
    const witch = roleSeat(room, "witch");
    const victim = plainGoodSeat(room);
    room = wolfKnife(room, victim);
    expect(engineOf(room).phase).toBe("night_seer");
    room = tick(room); // 预言家超时
    expect(engineOf(room).phase).toBe("night_witch");
    room = act(room, witch, "witch_save");
    room = act(room, witch, "witch_pass");
    expect(engineOf(room).seats[victim]!.alive).toBe(true);
    expect(engineOf(room).witchSaveUsed).toBe(true);
    expect(engineOf(room).lastNightDeaths).toEqual([]);
  });

  it("同刀同救(守卫守护 + 女巫解药同一目标)→ 平安夜,解药照耗", () => {
    let room = started(9, "room_n3");
    const guard = roleSeat(room, "guard");
    const witch = roleSeat(room, "witch");
    const victim = plainGoodSeat(room);
    room = act(room, guard, "guard", { target: victim });
    room = wolfKnife(room, victim);
    room = tick(room); // 预言家超时
    expect(engineOf(room).phase).toBe("night_witch");
    room = act(room, witch, "witch_save");
    room = act(room, witch, "witch_pass");
    expect(engineOf(room).seats[victim]!.alive).toBe(true);
    expect(engineOf(room).witchSaveUsed).toBe(true);
    expect(engineOf(room).lastNightDeaths).toEqual([]);
  });

  it("女巫毒杀 → 目标死亡;死讯公布座位,不公布死因", () => {
    let room = started(9, "room_n4");
    const witch = roleSeat(room, "witch");
    const knifeVictim = plainGoodSeat(room);
    const poisonTarget = engineOf(room).seats.findIndex(
      (seat, index) => seat.alive && seat.role !== "werewolf" && index !== knifeVictim && index !== witch,
    );
    expect(poisonTarget).toBeGreaterThanOrEqual(0);
    room = wolfKnife(room, knifeVictim);
    room = tick(room); // 预言家超时
    room = act(room, witch, "witch_poison", { target: poisonTarget });
    room = act(room, witch, "witch_pass");
    const engine = engineOf(room);
    expect(engine.seats[knifeVictim]!.alive).toBe(false);
    expect(engine.seats[poisonTarget]!.alive).toBe(false);
    expect(engine.witchPoisonUsed).toBe(true);
    expect([...engine.lastNightDeaths].sort((a, b) => a - b)).toEqual(
      [knifeVictim, poisonTarget].sort((a, b) => a - b),
    );
    // 公开视图无死因字段。
    expect(viewJson(room, null)).not.toContain('"deathCause"');
  });

  it("守卫不可连守同一人(第二夜重复守护被拒,换目标可守)", () => {
    let room = started(9, "room_n5");
    const guard = roleSeat(room, "guard");
    const first = plainGoodSeat(room);
    room = act(room, guard, "guard", { target: first });
    room = nightToDawn(wolfKnife(room, plainGoodSeat(room)));
    // 白天:全员放弃发言,投票全弃票 → 无人放逐 → 入夜。
    room = skipSpeeches(room);
    room = tick(room); // 投票超时:全弃票
    expect(engineOf(room).day).toBe(2);
    expect(engineOf(room).phase).toBe("night_guard");
    expect(engineOf(room).lastGuarded).toBe(first);
    expectRejected(
      werewolfEngine.applyAction(room, rawAction(room, guard, "guard", "g-repeat", { target: first })),
      "illegal_move",
    );
    const second = engineOf(room).seats.findIndex((seat, index) => seat.alive && index !== first && index !== guard);
    room = act(room, guard, "guard", { target: second });
    expect(engineOf(room).nightGuarded).toBe(second);
  });

  it("狼刀规则:不可刀狼;群狼提交后提交覆盖前者;提交满即收窗", () => {
    let room = skipGuard(started(9, "room_n6"));
    const wolves = aliveWolfSeats(room);
    const good = plainGoodSeat(room);
    expectRejected(
      werewolfEngine.applyAction(room, rawAction(room, wolves[0]!, "wolf_kill", "w-self", { target: wolves[0]! })),
      "illegal_move",
    );
    // 后提交覆盖:狼1/狼2 → good,狼3 → 最终目标。
    const witch = roleSeat(room, "witch");
    const finalTarget = engineOf(room).seats.findIndex(
      (seat, index) => seat.alive && seat.role !== "werewolf" && index !== witch && index !== good,
    );
    expect(finalTarget).toBeGreaterThanOrEqual(0);
    room = act(room, wolves[0]!, "wolf_kill", { target: good });
    room = act(room, wolves[1]!, "wolf_kill", { target: good });
    expect(engineOf(room).nightKnife).toBe(good);
    expect(engineOf(room).phase).toBe("night_wolf"); // 还有狼没提交,窗口开着
    room = act(room, wolves[2]!, "wolf_kill", { target: finalTarget });
    expect(engineOf(room).nightKnife).toBe(finalTarget);
    // 全狼已提交 → 窗口立即收(进入预言家阶段)。
    expect(engineOf(room).phase).toBe("night_seer");
    room = nightToDawn(room);
    expect(engineOf(room).seats[finalTarget]!.alive).toBe(false);
    expect(engineOf(room).seats[good]!.alive).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 预言家查验(结果私有)
// ---------------------------------------------------------------------------

describe("预言家查验", () => {
  it("查验狼人/好人结果只进查验者视图(checkResults 与事件都私有);不能自查", () => {
    let room = started(9, "room_seer");
    const seer = roleSeat(room, "seer");
    const wolf = aliveWolfSeats(room)[0]!;
    const good = plainGoodSeat(room);
    room = wolfKnife(room, good);
    expect(engineOf(room).phase).toBe("night_seer");
    // 自查被拒(阶段未推进,可继续查验)。
    expectRejected(
      werewolfEngine.applyAction(room, rawAction(room, seer, "seer_check", "s-self", { target: seer })),
      "illegal_move",
    );
    room = act(room, seer, "seer_check", { target: wolf });
    // 查验立即进入女巫链;女巫超时放弃。
    room = tick(room);
    const engine = engineOf(room);
    expect(engine.checkResults).toEqual([{ night: 1, seatIndex: wolf, isWolf: true }]);
    const seerJson = viewJson(room, seer);
    expect(seerJson).toContain('"isWolf":true');
    for (let seat = 0; seat < engine.seats.length; seat += 1) {
      if (seat === seer) continue;
      expect(viewJson(room, seat)).not.toContain('"checkResults"');
    }
  });
});

// ---------------------------------------------------------------------------
// 女巫用药规则(各一瓶/同夜不可双用/不可自救/空刀无解药)
// ---------------------------------------------------------------------------

describe("女巫用药规则", () => {
  it("同夜不可双用:救后当晚毒被拒、毒后当晚救被拒;两瓶跨夜各用一次后第三夜女巫阶段跳过", () => {
    let room = started(9, "room_w1");
    const witch = roleSeat(room, "witch");
    const guard = roleSeat(room, "guard");
    /** 目标池:存活非狼、非女巫、非猎人、非守卫(预言家+村民,守卫要活到夜 3 挡刀)。 */
    const pool = (state: GameRoomState): number[] =>
      aliveIdx(state).filter((index) => {
        const role = engineOf(state).seats[index]!.role;
        return role !== "werewolf" && role !== "witch" && role !== "hunter" && role !== "guard";
      });
    // 夜 1:刀 A,女巫救(A 活);当晚再毒被拒(同夜不可双用)。
    const a = pool(room)[0]!;
    room = wolfKnife(room, a);
    room = tick(room); // 预言家超时
    expect(engineOf(room).phase).toBe("night_witch");
    room = act(room, witch, "witch_save");
    const b = pool(room)[1]!;
    expectRejected(
      werewolfEngine.applyAction(room, rawAction(room, witch, "witch_poison", "w-same1", { target: b })),
      "illegal_move",
    );
    room = act(room, witch, "witch_pass");
    expect(engineOf(room).seats[a]!.alive).toBe(true);
    expect(engineOf(room).witchSaveUsed).toBe(true);
    expect(engineOf(room).witchPoisonUsed).toBe(false);
    // 白天 → 夜 2:毒杀 B(跨夜);当晚再救被拒。
    room = skipSpeeches(room);
    room = tick(room); // 投票全弃票 → 入夜
    const knifeTarget = pool(room)[0]!;
    room = wolfKnife(room, knifeTarget);
    room = tick(room); // 预言家超时
    room = act(room, witch, "witch_poison", { target: b });
    expectRejected(werewolfEngine.applyAction(room, rawAction(room, witch, "witch_save", "w-same2")), "illegal_move");
    room = act(room, witch, "witch_pass");
    expect(engineOf(room).witchSaveUsed).toBe(true);
    expect(engineOf(room).witchPoisonUsed).toBe(true);
    expect(engineOf(room).seats[b]!.alive).toBe(false);
    // 白天 → 夜 3:两瓶都已用 → 女巫阶段整体跳过;守卫挡刀保平安夜
    // (好人 4 vs 狼 3,不触发屠城,对局继续)。
    room = skipSpeeches(room);
    room = tick(room);
    const c = pool(room).find((seat) => seat !== knifeTarget)!;
    expect(c).toBeDefined();
    room = act(room, guard, "guard", { target: c });
    room = wolfKnife(room, c);
    expect(engineOf(room).phase).toBe("night_seer");
    room = tick(room);
    expect(engineOf(room).phase).not.toBe("night_witch");
    expect(engineOf(room).phase).toBe("day_speak");
    expect(engineOf(room).seats[c]!.alive).toBe(true);
  });

  it("解药不可自救:女巫被刀时不能自救(弃权则死亡)", () => {
    let room = started(9, "room_w2");
    const witch = roleSeat(room, "witch");
    const wolves = aliveWolfSeats(room);
    room = skipGuard(room);
    for (const wolf of wolves) room = act(room, wolf, "wolf_kill", { target: witch });
    expect(engineOf(room).phase).toBe("night_seer");
    room = tick(room);
    expect(engineOf(room).phase).toBe("night_witch");
    expectRejected(
      werewolfEngine.applyAction(room, rawAction(room, witch, "witch_save", "w-self-save")),
      "illegal_move",
    );
    room = act(room, witch, "witch_pass");
    expect(engineOf(room).seats[witch]!.alive).toBe(false);
  });

  it("空刀(autoWolfKill=false)时解药无处可用;平安夜直接公布", () => {
    let room = started(9, "room_w3", { autoWolfKill: false });
    const witch = roleSeat(room, "witch");
    room = skipGuard(room);
    room = tick(room); // 狼窗超时:无人出刀且 autoWolfKill=false → 空刀
    expect(engineOf(room).phase).toBe("night_seer");
    room = tick(room);
    expect(engineOf(room).phase).toBe("night_witch");
    expect(engineOf(room).nightKnife).toBeNull();
    expectRejected(
      werewolfEngine.applyAction(room, rawAction(room, witch, "witch_save", "w-no-knife")),
      "invalid_action",
    );
    room = act(room, witch, "witch_pass");
    expect(engineOf(room).lastNightDeaths).toEqual([]);
    expect(viewJson(room, null)).toContain("平安夜");
  });
});

// ---------------------------------------------------------------------------
// 投票与平票 PK
// ---------------------------------------------------------------------------

describe("投票与平票 PK(9 人板)", () => {
  /** 两个可被投票的存活好人(避开女巫/猎人,保证投票者可用)。 */
  function twoCandidates(room: GameRoomState): [number, number] {
    const witch = roleSeat(room, "witch");
    const hunter = roleSeat(room, "hunter");
    const pool = engineOf(room)
      .seats.map((seat, index) =>
        seat.alive && seat.role !== "werewolf" && index !== witch && index !== hunter ? index : -1,
      )
      .filter((index) => index >= 0)
      .sort((a, b) => a - b);
    expect(pool.length).toBeGreaterThanOrEqual(2);
    return [pool[0]!, pool[1]!];
  }

  it("唯一最高票放逐(座位公开,身份不揭示);放逐后入夜", () => {
    let room = toVote(started(9, "room_v1"));
    const witchSeat = roleSeat(room, "witch");
    const hunterSeat = roleSeat(room, "hunter");
    // 目标避开女巫/猎人(放逐猎人会开枪窗,另有用例);夜里随机刀可能命中
    // 任一好人,目标与投票者都按存活动态取。
    const target = engineOf(room).seats.findIndex(
      (seat, index) => seat.alive && seat.role !== "werewolf" && index !== witchSeat && index !== hunterSeat,
    );
    expect(target).toBeGreaterThanOrEqual(0);
    for (const seat of aliveIdx(room)) {
      if (seat === target) continue;
      room = act(room, seat, "vote", { target });
    }
    room = tick(room); // 目标本人弃票 → 收票计票
    const engine = engineOf(room);
    expect(engine.seats[target]!.alive).toBe(false);
    expect(engine.seats[target]!.deathCause).toBe("exile");
    expect(viewJson(room, null)).toContain("被投票放逐");
    // 放逐后入夜(目标不是猎人,无开枪窗口);白天簿记重置。
    expect(engine.phase).toMatch(/^night_/);
    expect(engine.lastNightDeaths).toEqual([]);
    expect(engine.pkCandidates).toBeNull();
  });

  it("平票 → PK 轮恰一次;PK 再平票 → 无人出局;PK 只能投候选且不能投自己", () => {
    let room = toVote(started(9, "room_v2"));
    const [candA, candB] = twoCandidates(room);
    // 2:2 平票:两个存活非候选座位投 A,另两个投 B,其余超时弃票。
    const voters = aliveIdx(room).filter((seat) => seat !== candA && seat !== candB);
    expect(voters.length).toBeGreaterThanOrEqual(4);
    room = act(room, voters[0]!, "vote", { target: candA });
    room = act(room, voters[1]!, "vote", { target: candA });
    room = act(room, voters[2]!, "vote", { target: candB });
    room = act(room, voters[3]!, "vote", { target: candB });
    room = tick(room);
    expect(engineOf(room).phase).toBe("day_pk");
    expect(engineOf(room).pkCandidates).toEqual([candA, candB].sort((a, b) => a - b));
    // PK 轮:只能投候选、不能投自己。
    expectRejected(
      werewolfEngine.applyAction(room, rawAction(room, voters[0]!, "vote", "pk-bad", { target: voters[2]! })),
      "illegal_move",
    );
    expectRejected(
      werewolfEngine.applyAction(room, rawAction(room, candA, "vote", "pk-self", { target: candA })),
      "illegal_move",
    );
    // PK 再平票:A→B、B→A、两名非候选分投 A/B,其余弃票 → 2:2 → 无人出局。
    room = act(room, candA, "vote", { target: candB });
    room = act(room, candB, "vote", { target: candA });
    room = act(room, voters[0]!, "vote", { target: candA });
    room = act(room, voters[1]!, "vote", { target: candB });
    room = tick(room);
    expect(engineOf(room).seats[candA]!.alive).toBe(true);
    expect(engineOf(room).seats[candB]!.alive).toBe(true);
    expect(viewJson(room, null)).toContain("无人出局");
    // 天黑请闭眼:进入夜 2。
    expect(engineOf(room).day).toBe(2);
    expect(engineOf(room).phase).toMatch(/^night_/);
  });

  it("投票目标必须存活且不能投自己;重复投票被拒", () => {
    let room = toVote(started(9, "room_v3"));
    const voter = aliveIdx(room)[0]!;
    const target = aliveIdx(room).find((seat) => seat !== voter)!;
    expect(target).toBeDefined();
    expectRejected(
      werewolfEngine.applyAction(room, rawAction(room, voter, "vote", "v-self", { target: voter })),
      "illegal_move",
    );
    expectRejected(
      werewolfEngine.applyAction(room, rawAction(room, voter, "vote", "v-dead", { target: 99 })),
      "illegal_move",
    );
    room = act(room, voter, "vote", { target });
    expectRejected(
      werewolfEngine.applyAction(room, rawAction(room, voter, "vote", "v-again", { target })),
      "invalid_action",
    );
  });
});

// ---------------------------------------------------------------------------
// 猎人开枪条件(被刀可开/被放逐可开/被毒不能开)
// ---------------------------------------------------------------------------

describe("猎人开枪条件", () => {
  it("猎人被狼刀 → 黎明开枪窗口;开枪带走一人且身份公示", () => {
    let room = started(7, "room_h1"); // 7 人板:2 狼 + 预女猎 + 2 民
    const hunter = roleSeat(room, "hunter");
    room = nightToDawn(wolfKnife(room, hunter));
    expect(engineOf(room).phase).toBe("hunter_shot");
    expect(engineOf(room).pendingShotSeat).toBe(hunter);
    // 开枪窗口只有猎人本人能动;枪口必须指向存活者。
    expectRejected(
      werewolfEngine.applyAction(
        room,
        rawAction(room, roleSeat(room, "seer"), "hunter_shot", "h-other", { target: aliveWolfSeats(room)[0]! }),
      ),
      "not_your_turn",
    );
    const wolfTarget = aliveWolfSeats(room)[0]!;
    room = act(room, hunter, "hunter_shot", { target: wolfTarget });
    const engine = engineOf(room);
    expect(engine.seats[wolfTarget]!.alive).toBe(false);
    expect(engine.seats[wolfTarget]!.deathCause).toBe("shot");
    expect(engine.pendingShotSeat).toBeNull();
    // 枪声公示猎人身份(死亡不揭示身份的唯一例外)。
    expect(viewJson(room, null)).toContain("亮出猎人身份");
    // 开枪后走白天(黎明枪)。
    expect(engine.phase).toBe("day_speak");
  });

  it("猎人被毒杀 → 没有开枪窗口(毒杀无枪声),直接进入白天", () => {
    let room = started(9, "room_h2");
    const hunter = roleSeat(room, "hunter");
    const witch = roleSeat(room, "witch");
    const knifeVictim = plainGoodSeat(room);
    room = wolfKnife(room, knifeVictim);
    room = tick(room); // 预言家超时
    room = act(room, witch, "witch_poison", { target: hunter });
    room = act(room, witch, "witch_pass");
    const engine = engineOf(room);
    expect(engine.seats[hunter]!.alive).toBe(false);
    expect(engine.seats[hunter]!.deathCause).toBe("poison");
    expect(engine.pendingShotSeat).toBeNull();
    expect(engine.phase).toBe("day_speak");
    // 猎人(已死)视图无 canShoot。
    expect(viewJson(room, hunter)).not.toContain('"canShoot"');
  });

  it("猎人被投票放逐 → 放逐枪窗口;放弃开枪(hunter_pass)后入夜", () => {
    // autoWolfKill=false:夜 1 空刀,保证猎人活着走到白天投票。
    let room = started(7, "room_h3", { autoWolfKill: false });
    const hunter = roleSeat(room, "hunter");
    room = skipSpeeches(nightToDawn(room));
    expect(engineOf(room).phase).toBe("day_vote");
    // 除猎人本人外全部存活者投猎人 → 唯一最高票放逐。
    for (const seat of aliveIdx(room)) {
      if (seat === hunter) continue;
      room = act(room, seat, "vote", { target: hunter });
    }
    room = tick(room); // 猎人本人弃票 → 收票计票
    expect(engineOf(room).seats[hunter]!.alive).toBe(false);
    expect(engineOf(room).phase).toBe("hunter_shot");
    expect(engineOf(room).pendingShotThen).toBe("night");
    room = act(room, hunter, "hunter_pass");
    expect(engineOf(room).pendingShotSeat).toBeNull();
    expect(viewJson(room, null)).toContain("选择不开枪");
    // 放逐枪结算后入夜。
    expect(engineOf(room).phase).toMatch(/^night_/);
    expect(engineOf(room).day).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 胜负判定(狼全灭好人胜 / 屠城狼胜)与结算复盘
// ---------------------------------------------------------------------------

describe("胜负判定与结算复盘", () => {
  it("放逐最后一狼 → 好人胜;settle 输出身份复盘与完整事件流水", () => {
    let room = started(6, "room_win1"); // 6 人板:2 狼 + 预女 + 2 民
    // 白盒摆盘:一位狼人已在此前被放逐(仅剩一狼)。
    const wolves = aliveWolfSeats(room);
    const deadWolf = wolves[1]!;
    room = withEngineState(room, {
      seats: engineOf(room).seats.map((seat, index) =>
        index === deadWolf ? { ...seat, alive: false, deathCause: "exile" as const } : seat,
      ),
    });
    room = nightToDawn(wolfKnife(room, plainGoodSeat(room)));
    room = skipSpeeches(room);
    const lastWolf = aliveWolfSeats(room)[0]!;
    // 好人们票最后一狼;狼不能投自己 → 弃票。
    for (let seat = 0; seat < engineOf(room).seats.length; seat += 1) {
      const info = engineOf(room).seats[seat]!;
      if (!info.alive || seat === lastWolf) continue;
      room = act(room, seat, "vote", { target: lastWolf });
    }
    const settled = commit(
      werewolfEngine.applyAction(room, rawAction(room, lastWolf, "vote", "w-abstain", { target: null })),
    );
    expect(engineOf(settled).outcome).toMatchObject({ result: "good_win", winnerSide: "good", reason: "wipe_wolves" });
    expect(werewolfEngine.checkGameOver(settled)).toBe(true);
    // 结算快照:复盘亮全部身份 + 事件流水(对局中绝不外泄的都在 settle 里)。
    const settlement = werewolfEngine.settle(settled);
    expect(settlement.result).toBe("good_win");
    expect(settlement.winnerSeatToken).toBeNull();
    const summary = settlement.summary as Record<string, unknown>;
    const seatsSummary = summary.seats as Array<{ role: WerewolfRole; deathCause: string | null }>;
    expect(seatsSummary.filter((seat) => seat.role === "werewolf")).toHaveLength(2);
    expect((summary.events as unknown[]).length).toBeGreaterThan(0);
    expect(summary.checkResults).toEqual([]);
  });

  it("狼人数 ≥ 好人数 → 狼胜(屠城)", () => {
    let room = started(6, "room_win2");
    // 白盒摆盘:两名好人已中毒出局(2 狼 vs 2 好)。
    const goods = engineOf(room)
      .seats.map((seat, index) => (seat.alive && seat.role !== "werewolf" ? index : -1))
      .filter((index) => index >= 0);
    const casualties = [goods[0]!, goods[1]!];
    room = withEngineState(room, {
      seats: engineOf(room).seats.map((seat, index) =>
        casualties.includes(index) ? { ...seat, alive: false, deathCause: "poison" as const } : seat,
      ),
    });
    // 夜 1:狼刀一名好人 → 好 1 人 vs 狼 2 → 屠城。
    const remaining = engineOf(room).seats.findIndex((seat, index) => seat.alive && seat.role !== "werewolf");
    expect(remaining).toBeGreaterThanOrEqual(0);
    room = nightToDawn(wolfKnife(room, remaining));
    const engine = engineOf(room);
    expect(engine.outcome).toMatchObject({ result: "wolf_win", winnerSide: "wolves", reason: "wolves_equal_good" });
    expect(viewJson(room, null)).toContain("屠城");
    expect(werewolfEngine.settle(room).result).toBe("wolf_win");
    // 终局后 deadline 收灯、动作全拒。
    expect(room.deadlineAt).toBeNull();
    expectRejected(
      werewolfEngine.applyAction(room, rawAction(room, aliveWolfSeats(room)[0]!, "wolf_kill", "post", { target: 0 })),
      "game_over",
    );
  });
});

// ---------------------------------------------------------------------------
// 掉线托管(超时弃票/放弃发言/狼刀随机目标可配置)
// ---------------------------------------------------------------------------

describe("掉线托管(handleTimeout)", () => {
  it("狼刀超时随机目标(autoWolfKill 默认开);发言超时记放弃;投票超时视为弃票", () => {
    let room = started(6, "room_afk");
    room = nightToDawn(room);
    // 狼超时 → 随机刀:有人倒下,且死因只进 settle 不进视图。
    expect(engineOf(room).lastNightDeaths.length).toBeGreaterThan(0);
    // 发言超时:逐个放弃。
    room = skipSpeeches(room);
    expect(engineOf(room).phase).toBe("day_vote");
    expect(engineOf(room).speeches.filter((speech) => speech.skipped).length).toBe(engineOf(room).speakOrder.length);
    // 投票超时:全员弃票 → 无人放逐 → 入夜。
    room = tick(room);
    expect(viewJson(room, null)).toContain("无人被放逐");
    expect(engineOf(room).day).toBe(2);
  });

  it("autoWolfKill=false:狼人全员超时 → 空刀平安夜(可配置托管)", () => {
    let room = started(6, "room_afk2", { autoWolfKill: false });
    room = nightToDawn(room);
    expect(engineOf(room).nightKnife).toBeNull();
    expect(engineOf(room).lastNightDeaths).toEqual([]);
    expect(viewJson(room, null)).toContain("平安夜");
  });

  it("开枪超时 = 放弃开枪(枪声公示)", () => {
    let room = started(7, "room_afk3");
    room = nightToDawn(wolfKnife(room, roleSeat(room, "hunter")));
    expect(engineOf(room).phase).toBe("hunter_shot");
    room = tick(room);
    expect(engineOf(room).pendingShotSeat).toBeNull();
    expect(viewJson(room, null)).toContain("选择不开枪");
  });

  it("离席(leave→resign)后其动作被拒、事件公示托管;离席狼不阻塞狼窗", () => {
    let room = started(6, "room_afk4");
    const wolf = aliveWolfSeats(room)[0]!;
    room = commit(werewolfEngine.applyAction(room, rawAction(room, wolf, "resign", "rs-1")));
    expect(JSON.stringify(engineOf(room).events)).toContain("托管");
    // 模拟 DO 的 leaveRoomDefault:标记 leftAt 后,该座位一切动作被拒。
    const who = engineOf(room).seats[wolf]!.participantHash;
    room = {
      ...room,
      players: room.players.map((player) =>
        player.participantHash === who ? { ...player, leftAt: new Date().toISOString() } : player,
      ),
    };
    expectRejected(
      werewolfEngine.applyAction(room, rawAction(room, wolf, "wolf_kill", "rs-dead", { target: plainGoodSeat(room) })),
      "invalid_action",
    );
    // 另一狼提交即收窗(离席狼不阻塞),对局继续。
    const otherWolf = aliveWolfSeats(room)[0]!;
    room = act(room, otherWolf, "wolf_kill", { target: plainGoodSeat(room) });
    expect(engineOf(room).phase).not.toBe("night_wolf");
  });
});

// ---------------------------------------------------------------------------
// 协议防御(幂等 / 版本 / 未知动作)
// ---------------------------------------------------------------------------

describe("协议防御(幂等 / 版本)", () => {
  it("重复 actionId 被拒(动作已处理);baseVersion 落后返回 stale_action;未知动作拒绝", () => {
    const room = started(6, "room_proto");
    const wolf = aliveWolfSeats(room)[0]!;
    // 首次提交成功;actionIds 记在返回的新状态里。
    const after = commit(
      werewolfEngine.applyAction(room, rawAction(room, wolf, "wolf_kill", "dup-1", { target: plainGoodSeat(room) })),
    );
    expect(after.status).toBe("playing");
    // 同一 actionId 在新状态上重放被拒。
    expectRejected(
      werewolfEngine.applyAction(after, rawAction(after, wolf, "wolf_kill", "dup-1", { target: plainGoodSeat(after) })),
      "invalid_action",
    );
    // baseVersion 落后(≠ 当前 version)拒绝,version 不动。
    expectRejected(
      werewolfEngine.applyAction(
        room,
        rawAction(room, wolf, "wolf_kill", "stale-1", { target: plainGoodSeat(room) }, room.version + 5),
      ),
      "stale_action",
    );
    // 未知动作码拒绝。
    expectRejected(werewolfEngine.applyAction(room, rawAction(room, wolf, "teleport", "u-1")), "illegal_move");
  });
});

// ---------------------------------------------------------------------------
// 聊天频道裁剪与对局结束即焚(纯判定;DO 层用例在 game-room-chat.test.ts)
// ---------------------------------------------------------------------------

describe("聊天频道裁剪(chatMembership)", () => {
  it("wolves 频道仅存活狼人可见;死亡退 dead 频道;预言家/村民/观战不可见", () => {
    let room = started(9, "room_chat");
    const wolf = aliveWolfSeats(room)[0]!;
    const seer = roleSeat(room, "seer");
    const villager = plainGoodSeat(room);
    expect(werewolfEngine.chatMembership!(room, P[wolf]!)).toEqual({ isWolf: true, isDead: false });
    expect(werewolfEngine.chatMembership!(room, P[seer]!)).toEqual({ isWolf: false, isDead: false });
    expect(werewolfEngine.chatMembership!(room, P[villager]!)).toEqual({ isWolf: false, isDead: false });
    // 死亡狼人:不再是狼(不能在狼频道发言),退到 dead 频道。
    room = withEngineState(room, {
      seats: engineOf(room).seats.map((seat, index) =>
        index === wolf ? { ...seat, alive: false, deathCause: "exile" as const } : seat,
      ),
    });
    expect(werewolfEngine.chatMembership!(room, P[wolf]!)).toEqual({ isWolf: false, isDead: true });
    // 非座位身份(观战):dead 频道。
    expect(werewolfEngine.chatMembership!(room, "hash-stranger")).toEqual({ isWolf: false, isDead: true });
  });

  it("对局结束聊天即焚的纯判定:settled/closed 都要求清空 chat:*(storage 无残留由 DO 用例保证)", () => {
    expect(chatPurgeRequired("settled")).toBe(true);
    expect(chatPurgeRequired("closed")).toBe(true);
    expect(chatPurgeRequired("playing")).toBe(false);
    expect(chatPurgeRequired("lobby")).toBe(false);
  });
});
