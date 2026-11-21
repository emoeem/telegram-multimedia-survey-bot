import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { GameRoomPlayer, GameRoomState } from "../../../src/game/multiplayer/engine-types";
import { werewolfEngine, type WerewolfEngineState } from "../../../src/game/multiplayer/engines/werewolf";
import { WEREWOLF_ALL_ROLES } from "../../../src/game/multiplayer/engines/werewolf";
import {
  buildWerewolfRoomConfig,
  chatTabsFor,
  parseWerewolfView,
  WEREWOLF_DEFAULT_HOST_CONFIG,
  WEREWOLF_PHASE_NAMES,
  werewolfBoard,
  werewolfBoardSummary,
  werewolfChatMembership,
  werewolfDayLabel,
  werewolfLocalTargetCheck,
  werewolfSeatName,
  werewolfSeatPoints,
  werewolfSettlementCopy,
  werewolfTallyFromEvents,
  type WerewolfEventView,
  type WerewolfHostConfigForm,
  type WerewolfRolePlan,
  type WerewolfView,
} from "../../../admin/src/survey/game-room-logic";

/**
 * 狼人杀客户端纯逻辑单测（游戏批次 R2 客户端）：视图收敛 parseWerewolfView
 * （服务端可能返回任何 JSON，形状不对整包拒绝）、阶段流转展示
 * （werewolfDayLabel + WEREWOLF_PHASE_NAMES）、票数统计展示
 * （werewolfTallyFromEvents，从亮票事件收敛）、目标选择本地预判
 * （werewolfLocalTargetCheck，只挡必被拒的选择）、座位昵称哈希对位、聊天
 * 频道资格（wolves/dead 页签）、结算文案、圆桌几何、房主配置构建，以及
 * 引擎集成的私有视图泄漏断言（A 视图不含 B 的角色）与 Board 注册/入口
 * 标注的接线守护。
 */

/** 与 werewolfEngine.viewPayload 同形的合法载荷（夜 1 狼人阶段，狼人视角）。 */
function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const seats = Array.from({ length: 9 }, (_, i) => ({
    seatIndex: i,
    participantHash: `hash-p${i + 1}`,
    alive: true,
    isYou: i === 0,
  }));
  return {
    day: 1,
    phase: "night_wolf",
    seats,
    aliveSeats: [0, 1, 2, 3, 4, 5, 6, 7, 8],
    deadSeats: [],
    lastNightDeaths: [],
    speakTurnSeat: null,
    speeches: [],
    votesNeeded: 9,
    votesSubmitted: 0,
    myVoteSubmitted: false,
    pkCandidates: null,
    pendingShotOpen: false,
    events: [{ seq: 1, day: 1, kind: "night", text: "夜幕降临,请闭眼。" }],
    outcome: null,
    yourSeat: 0,
    yourRole: "werewolf",
    yourAlive: true,
    wolfMates: [0, 3],
    nightKnife: null,
    canShoot: false,
    shotTargets: [],
    ...overrides,
  };
}

describe("parseWerewolfView(视图收敛)", () => {
  it("合法载荷收敛:座位/私有技能面/yourSeat 逐字段还原", () => {
    const w = parseWerewolfView(validPayload())!;
    expect(w.day).toBe(1);
    expect(w.phase).toBe("night_wolf");
    expect(w.seats).toHaveLength(9);
    expect(w.seats[0]).toEqual({ seatIndex: 0, participantHash: "hash-p1", alive: true, isYou: true });
    expect(w.yourSeat).toBe(0);
    expect(w.yourRole).toBe("werewolf");
    expect(w.yourAlive).toBe(true);
    expect(w.wolfMates).toEqual([0, 3]);
    expect(w.votesNeeded).toBe(9);
    expect(w.aliveSeats).toHaveLength(9);
    expect(w.events[0]!.text).toContain("夜幕降临");
  });

  it("预言家/女巫/守卫的私有面只在各自视图载荷里,解析后按字段还原", () => {
    const seer = parseWerewolfView(
      validPayload({
        phase: "night_seer",
        yourRole: "seer",
        wolfMates: null,
        checkResults: [{ night: 1, seatIndex: 2, isWolf: true }],
      }),
    )!;
    expect(seer.checkResults).toEqual([{ night: 1, seatIndex: 2, isWolf: true }]);
    const witch = parseWerewolfView(
      validPayload({
        phase: "night_witch",
        yourRole: "witch",
        potions: { save: true, poison: false },
        tonightKnife: 4,
      }),
    )!;
    expect(witch.potions).toEqual({ save: true, poison: false });
    expect(witch.tonightKnife).toBe(4);
    const guard = parseWerewolfView(validPayload({ phase: "night_guard", yourRole: "guard", lastGuarded: 5 }))!;
    expect(guard.lastGuarded).toBe(5);
  });

  it("观战/公开视图(yourRole 等私有字段缺失):私有面为 null,座位投影保留", () => {
    const payload = validPayload();
    delete payload.yourRole;
    delete payload.yourAlive;
    delete payload.yourSeat;
    delete payload.wolfMates;
    delete payload.nightKnife;
    const w = parseWerewolfView(payload)!;
    expect(w.yourRole).toBeNull();
    expect(w.yourSeat).toBeNull();
    expect(w.yourAlive).toBeNull();
    expect(w.wolfMates).toBeNull();
    expect(w.nightKnife).toBeNull();
    expect(w.checkResults).toBeNull();
    expect(w.potions).toBeNull();
    expect(w.lastGuarded).toBeNull();
    expect(w.canShoot).toBe(false);
    expect(w.seats).toHaveLength(9);
  });

  it("形状不对整包拒绝(返回 null):非对象/坏 phase/座位表缺失", () => {
    expect(parseWerewolfView(null)).toBeNull();
    expect(parseWerewolfView("夜")).toBeNull();
    expect(parseWerewolfView(validPayload({ phase: "midnight" }))).toBeNull();
    expect(parseWerewolfView({ phase: "day_vote" })).toBeNull();
    const payload = validPayload();
    delete payload.seats;
    expect(parseWerewolfView(payload)).toBeNull();
  });

  it("逐字段容错:事件/发言脏条目丢弃、脏座位剔除、yourRole 非法值给 null、day 非法给 0", () => {
    const w = parseWerewolfView(
      validPayload({
        day: -1,
        yourRole: "god",
        seats: [
          { seatIndex: 0, participantHash: "hash-p1", alive: true, isYou: true },
          null,
          { seatIndex: "x", alive: true },
          { seatIndex: 3, participantHash: "", alive: false, isYou: false },
        ],
        events: [{ seq: 1, day: 1, kind: "dawn", text: "天亮了" }, { text: 42 }, null],
        speeches: [{ day: 1, seatIndex: 2, skipped: false, text: "我是好人" }, { seatIndex: "x" }],
        pkCandidates: [2, "x", 5],
        aliveSeats: [0, 3, true],
      }),
    )!;
    expect(w.day).toBe(0);
    expect(w.yourRole).toBeNull();
    expect(w.seats).toHaveLength(2);
    expect(w.seats[1]).toEqual({ seatIndex: 3, participantHash: null, alive: false, isYou: false });
    expect(w.events).toEqual([{ seq: 1, day: 1, kind: "dawn", text: "天亮了" }]);
    expect(w.speeches).toEqual([{ day: 1, seatIndex: 2, skipped: false, text: "我是好人" }]);
    expect(w.pkCandidates).toEqual([2, 5]);
    expect(w.aliveSeats).toEqual([0, 3]);
  });
});

describe("阶段流转展示(日夜横幅)", () => {
  it("夜阶段「第 N 夜」,白天阶段「第 N 天」,开局前「未开局」", () => {
    expect(werewolfDayLabel(0, "day_speak")).toBe("未开局");
    expect(werewolfDayLabel(1, "night_guard")).toBe("第 1 夜");
    expect(werewolfDayLabel(1, "night_wolf")).toBe("第 1 夜");
    expect(werewolfDayLabel(1, "night_seer")).toBe("第 1 夜");
    expect(werewolfDayLabel(1, "night_witch")).toBe("第 1 夜");
    expect(werewolfDayLabel(1, "day_speak")).toBe("第 1 天");
    expect(werewolfDayLabel(1, "day_vote")).toBe("第 1 天");
    expect(werewolfDayLabel(2, "day_pk")).toBe("第 2 天");
    expect(werewolfDayLabel(2, "hunter_shot")).toBe("第 2 天");
    expect(werewolfDayLabel(-1, "night_wolf")).toBe("未开局");
  });

  it("八个阶段都有可读的阶段名(与引擎 phase 枚举一一对应)", () => {
    expect(Object.keys(WEREWOLF_PHASE_NAMES).sort()).toEqual(
      [
        "day_pk",
        "day_speak",
        "day_vote",
        "hunter_shot",
        "night_guard",
        "night_seer",
        "night_witch",
        "night_wolf",
      ].sort(),
    );
    expect(WEREWOLF_PHASE_NAMES.night_guard).toBe("守卫行动");
    expect(WEREWOLF_PHASE_NAMES.night_wolf).toBe("狼人行动");
    expect(WEREWOLF_PHASE_NAMES.day_pk).toBe("PK 投票");
    expect(WEREWOLF_PHASE_NAMES.hunter_shot).toBe("猎人开枪");
  });
});

describe("票数统计展示(werewolfTallyFromEvents)", () => {
  const reveal = (text: string, seq = 10): WerewolfEventView => ({ seq, day: 1, kind: "vote", text });

  it("亮票事件收敛成计票摘要:得票降序、弃票单独计数", () => {
    const events = [
      { seq: 1, day: 1, kind: "night", text: "夜幕降临" },
      reveal("亮票:张三→李四, 王五→李四, 赵六→弃票"),
    ];
    expect(werewolfTallyFromEvents(events)).toEqual({
      entries: [{ name: "李四", votes: 2 }],
      abstained: 1,
    });
  });

  it("平票按票数并列,同名同票按稳定次序排列(并列时次序确定)", () => {
    // 次序断言用拉丁名:latin 名在码点序与 locale 序下一致,避免 CJK collation
    // 因运行环境(ICU 数据)差异把展示序断言变成环境相关。
    const tally = werewolfTallyFromEvents([reveal("亮票:甲→Alice, 乙→Bob, 丙→Alice, 丁→Bob")])!;
    expect(tally.entries).toEqual([
      { name: "Alice", votes: 2 },
      { name: "Bob", votes: 2 },
    ]);
    // 得票数恒为降序(这条与 collation 无关)。
    const votes = werewolfTallyFromEvents([reveal("亮票:甲→乙, 丙→甲, 丁→甲, 戊→乙")])!;
    expect(votes.entries.map((entry) => entry.votes)).toEqual([2, 2]);
  });

  it("取最近一次亮票(新一轮投票覆盖上一轮摘要)", () => {
    const events = [reveal("亮票:甲→乙", 1), reveal("亮票:甲→丙, 乙→丙", 2)];
    expect(werewolfTallyFromEvents(events)).toEqual({ entries: [{ name: "丙", votes: 2 }], abstained: 0 });
  });

  it("非亮票事件不参与;「无人投票。」不给摘要;解析不出的段丢弃(展示尽力而为)", () => {
    expect(werewolfTallyFromEvents([{ seq: 1, day: 1, kind: "vote", text: "无人投票。" }])).toBeNull();
    expect(werewolfTallyFromEvents([{ seq: 1, day: 1, kind: "dawn", text: "亮票:甲→乙" }])).toBeNull();
    expect(werewolfTallyFromEvents([reveal("亮票:甲→乙, 脏段, 甲→")])).toEqual({
      entries: [{ name: "乙", votes: 1 }],
      abstained: 0,
    });
    expect(werewolfTallyFromEvents([])).toBeNull();
  });
});

describe("目标选择本地预判(werewolfLocalTargetCheck;权威校验在引擎)", () => {
  function viewOf(overrides: Partial<Record<string, unknown>>): WerewolfView {
    return parseWerewolfView(validPayload(overrides))!;
  }

  it("守卫:不能连守上一夜目标,可守自己,目标必须存活", () => {
    const w = viewOf({ phase: "night_guard", yourRole: "guard", lastGuarded: 2 });
    expect(werewolfLocalTargetCheck(w, 2)).toContain("连续两夜");
    expect(werewolfLocalTargetCheck(w, 0)).toBeNull(); // 守自己合法
    expect(werewolfLocalTargetCheck(w, 4)).toBeNull();
    const deadSeat = {
      seats: Array.from({ length: 9 }, (_, i) => ({
        seatIndex: i,
        participantHash: `h${i}`,
        alive: i !== 5,
        isYou: false,
      })),
    };
    const wDead = parseWerewolfView(validPayload({ phase: "night_guard", yourRole: "guard", ...deadSeat }))!;
    expect(werewolfLocalTargetCheck(wDead, 5)).toBe("目标必须存活");
  });

  it("狼人:不能刀队友与非存活目标;预言家不能查自己;女巫不能对自己用药", () => {
    const wolf = viewOf({ phase: "night_wolf", yourRole: "werewolf", wolfMates: [0, 3] });
    expect(werewolfLocalTargetCheck(wolf, 3)).toBe("不能刀自己人");
    expect(werewolfLocalTargetCheck(wolf, 4)).toBeNull();
    const seer = viewOf({ phase: "night_seer", yourRole: "seer", wolfMates: null });
    expect(werewolfLocalTargetCheck(seer, 0)).toBe("预言家不能查验自己");
    expect(werewolfLocalTargetCheck(seer, 4)).toBeNull();
    const witch = viewOf({
      phase: "night_witch",
      yourRole: "witch",
      wolfMates: null,
      potions: { save: true, poison: true },
    });
    expect(werewolfLocalTargetCheck(witch, 0)).toBe("女巫不能对自己用药");
    expect(werewolfLocalTargetCheck(witch, 4)).toBeNull();
  });

  it("投票:不能投自己/已投过;PK 轮只能投候选;出局者不能投", () => {
    const vote = viewOf({ phase: "day_vote", yourRole: "villager", wolfMates: null });
    expect(werewolfLocalTargetCheck(vote, 0)).toBe("不能投自己");
    expect(werewolfLocalTargetCheck(vote, 3)).toBeNull();
    const voted = viewOf({ phase: "day_vote", yourRole: "villager", wolfMates: null, myVoteSubmitted: true });
    expect(werewolfLocalTargetCheck(voted, 3)).toBe("你已经投过票了");
    const pk = viewOf({ phase: "day_pk", yourRole: "villager", wolfMates: null, pkCandidates: [2, 3] });
    expect(werewolfLocalTargetCheck(pk, 5)).toBe("PK 轮只能投 PK 候选");
    expect(werewolfLocalTargetCheck(pk, 2)).toBeNull();
    const dead = viewOf({ phase: "day_vote", yourRole: "villager", wolfMates: null, yourAlive: false });
    expect(werewolfLocalTargetCheck(dead, 3)).toBe("你已出局,不能再投票");
  });

  it("猎人:窗口未开/目标自指被拒;发言阶段不需要目标;非守卫选守护阶段被拒", () => {
    const shot = viewOf({
      phase: "hunter_shot",
      yourRole: "hunter",
      wolfMates: null,
      pendingShotOpen: true,
      canShoot: true,
    });
    expect(werewolfLocalTargetCheck(shot, 0)).toBe("不能枪击自己");
    expect(werewolfLocalTargetCheck(shot, 4)).toBeNull();
    const noShot = viewOf({
      phase: "hunter_shot",
      yourRole: "hunter",
      wolfMates: null,
      pendingShotOpen: true,
      canShoot: false,
    });
    expect(werewolfLocalTargetCheck(noShot, 4)).toContain("开枪窗口");
    const speaking = viewOf({ phase: "day_speak", yourRole: "villager", wolfMates: null });
    expect(werewolfLocalTargetCheck(speaking, 3)).toContain("不需要选择目标");
    const notGuard = viewOf({ phase: "night_guard", yourRole: "villager", wolfMates: null });
    expect(werewolfLocalTargetCheck(notGuard, 3)).toBe("你不是守卫");
  });
});

describe("座位昵称(werewolfSeatName,哈希对位)", () => {
  const players = [
    { participantHash: "h0", displayName: "甲", leftAt: null },
    { participantHash: "h1", displayName: "乙", leftAt: null },
    { participantHash: "h2", displayName: "丙", leftAt: "t" },
  ];
  const seatsWithHash = [0, 1, 2].map((i) => ({ seatIndex: i, participantHash: `h${i}`, alive: true, isYou: false }));
  const seatsNoHash = seatsWithHash.map((seat) => ({ ...seat, participantHash: null }));

  it("按座位载荷的 participantHash 对位昵称;离席座位照样显示其昵称(不回退)", () => {
    const w = { seats: seatsWithHash };
    expect(werewolfSeatName({ players }, w, 0)).toBe("甲");
    expect(werewolfSeatName({ players }, w, 2)).toBe("丙");
    expect(werewolfSeatName({ players }, w, 1)).toBe("乙");
  });

  it("旧部署兜底(无座位哈希):全在座且行数=座位数时按行序;有离席行回退「玩家N」绝不错挂", () => {
    const w = { seats: seatsNoHash };
    const allActive = [
      { participantHash: "h0", displayName: "甲", leftAt: null },
      { participantHash: "h1", displayName: "乙", leftAt: null },
      { participantHash: "h2", displayName: "丙", leftAt: null },
    ];
    expect(werewolfSeatName({ players: allActive }, w, 0)).toBe("甲");
    expect(werewolfSeatName({ players: allActive }, w, 1)).toBe("乙");
    // 行 2 已离席:在座行序对不上座位序 → 回退「玩家N」。
    expect(werewolfSeatName({ players }, w, 2)).toBe("玩家3");
  });

  it("座位缺行时回退「玩家N」", () => {
    expect(werewolfSeatName({ players }, { seats: seatsWithHash }, 5)).toBe("玩家6");
  });
});

describe("聊天频道资格(werewolfChatMembership × chatTabsFor)", () => {
  it("与引擎 chatMembership 同口径:存活狼人 → wolves;死亡玩家 → dead;活好人只有 all", () => {
    const asView = (payload: Record<string, unknown>) => ({ gameType: "werewolf", view: payload });
    expect(werewolfChatMembership(asView(validPayload()))).toEqual({ wolf: true, dead: false });
    expect(chatTabsFor("player", werewolfChatMembership(asView(validPayload())))).toEqual(["all", "wolves"]);
    const wolfDead = validPayload({ yourAlive: false });
    expect(werewolfChatMembership(asView(wolfDead))).toEqual({ wolf: false, dead: true });
    expect(chatTabsFor("player", werewolfChatMembership(asView(wolfDead)))).toEqual(["all", "dead"]);
    const villager = validPayload({ yourRole: "villager", wolfMates: null });
    expect(werewolfChatMembership(asView(villager))).toEqual({ wolf: false, dead: false });
    expect(chatTabsFor("player", werewolfChatMembership(asView(villager)))).toEqual(["all"]);
  });

  it("非狼人杀视图/解析失败 → 资格全 false,页签集合与其它玩法完全一致", () => {
    expect(werewolfChatMembership(null)).toEqual({ wolf: false, dead: false });
    expect(werewolfChatMembership({ gameType: "gomoku", view: { turn: "black" } })).toEqual({
      wolf: false,
      dead: false,
    });
    expect(werewolfChatMembership({ gameType: "werewolf", view: null })).toEqual({ wolf: false, dead: false });
    expect(chatTabsFor("player", werewolfChatMembership(null))).toEqual(["all"]);
    // 观战者的 dead 页签由 chatTabsFor 按 role 恒给,不依赖 membership。
    expect(chatTabsFor("spectator", werewolfChatMembership(null))).toEqual(["all", "dead"]);
  });
});

describe("结算文案(werewolfSettlementCopy)", () => {
  it("阵营胜负按自己的身份定视角:好人视角狼胜=输,狼人视角狼胜=赢", () => {
    const goodWin = { result: "good_win", winnerSide: "good" as const, reason: "wipe_wolves" as const };
    expect(werewolfSettlementCopy(goodWin, "villager")).toEqual({
      headline: "你赢了！",
      detail: "好人阵营获胜（狼人全部出局）",
      tone: "win",
    });
    expect(werewolfSettlementCopy(goodWin, "werewolf").tone).toBe("lose");
    const wolfWin = { result: "wolf_win", winnerSide: "wolves" as const, reason: "wolves_equal_good" as const };
    expect(werewolfSettlementCopy(wolfWin, "werewolf")).toEqual({
      headline: "你赢了！",
      detail: "狼人阵营获胜（狼人人数已追平好人）",
      tone: "win",
    });
    expect(werewolfSettlementCopy(wolfWin, "seer").tone).toBe("lose");
  });

  it("观战者(身份 null)与中止局给中性文案", () => {
    const goodWin = { result: "good_win", winnerSide: "good" as const, reason: null };
    expect(werewolfSettlementCopy(goodWin, null)).toEqual({
      headline: "对局结束",
      detail: "好人阵营获胜",
      tone: "neutral",
    });
    expect(werewolfSettlementCopy({ result: "aborted", winnerSide: null, reason: null }, "villager")).toEqual({
      headline: "对局结束",
      detail: "对局中止",
      tone: "neutral",
    });
  });
});

describe("圆桌几何(werewolfSeatPoints)", () => {
  it("座位 0 固定在正上方,顺时针均布;空表/非法人数返回空", () => {
    expect(werewolfSeatPoints(0)).toEqual([]);
    expect(werewolfSeatPoints(-1)).toEqual([]);
    const six = werewolfSeatPoints(6);
    expect(six).toHaveLength(6);
    expect(six[0]!.x).toBeCloseTo(50, 5);
    expect(six[0]!.y).toBeCloseTo(8, 5);
    const twelve = werewolfSeatPoints(12);
    expect(twelve).toHaveLength(12);
    // 座位 6 与座位 0 关于圆心对称(12 等分时正好半圈)。
    expect(twelve[6]!.x).toBeCloseTo(50, 5);
    expect(twelve[6]!.y).toBeCloseTo(88, 5);
  });
});

// ---------------------------------------------------------------------------
// 房主配置(板子预设/时限/托管)
// ---------------------------------------------------------------------------

describe("房主配置(buildWerewolfRoomConfig)", () => {
  it("自动板不下发 rolePlan(引擎按实际开局人数推导);固定板下发该人数标准板", () => {
    const auto = buildWerewolfRoomConfig(WEREWOLF_DEFAULT_HOST_CONFIG);
    expect(auto).toEqual({ turnMs: 60_000, autoWolfKill: true });
    const fixed = buildWerewolfRoomConfig({ turnMs: 120_000, autoWolfKill: false, preset: 9 });
    expect(fixed).toEqual({
      turnMs: 120_000,
      autoWolfKill: false,
      rolePlan: { wolves: 3, seer: true, witch: true, hunter: true, guard: true, villagers: 2 },
    });
  });

  it("板子预设文案与人数一致(狼<好人,神位按人数出现)", () => {
    expect(werewolfBoardSummary(6)).toContain("2 狼");
    expect(werewolfBoardSummary(6)).not.toContain("守卫");
    expect(werewolfBoardSummary(9)).toContain("3 狼");
    expect(werewolfBoardSummary(9)).toContain("守卫");
    expect(werewolfBoardSummary(12)).toContain("4 狼");
    expect(werewolfBoardSummary(5)).toBe("");
    expect(werewolfBoardSummary(13)).toBe("");
  });

  it("引擎接受面板构建的 config:自动板 rolePlan=null,固定板 9 人 rolePlan 合法", () => {
    const baseRoom = (roomId: string, config: Record<string, unknown>): GameRoomState => {
      const now = new Date().toISOString();
      const host: GameRoomPlayer = {
        participantHash: "hash-cfg-host",
        displayName: "房主",
        isHost: true,
        ready: false,
        joinedAt: now,
        leftAt: null,
      };
      return {
        roomId,
        gameType: "werewolf",
        status: "lobby",
        version: 1,
        config,
        players: [host],
        engineState: null,
        createdAt: now,
        updatedAt: now,
        deadlineAt: null,
        recycleAt: null,
        closedAt: null,
      };
    };
    const autoOutcome = werewolfEngine.createRoom(
      baseRoom("room_cfg_auto", buildWerewolfRoomConfig(WEREWOLF_DEFAULT_HOST_CONFIG)),
      buildWerewolfRoomConfig(WEREWOLF_DEFAULT_HOST_CONFIG),
    );
    expect(autoOutcome.ok).toBe(true);
    if (autoOutcome.ok) {
      expect((autoOutcome.state.engineState as WerewolfEngineState).rules.rolePlan).toBeNull();
    }
    const fixedForm: WerewolfHostConfigForm = { turnMs: 180_000, autoWolfKill: false, preset: 9 };
    const fixedOutcome = werewolfEngine.createRoom(
      baseRoom("room_cfg_fixed", buildWerewolfRoomConfig(fixedForm)),
      buildWerewolfRoomConfig(fixedForm),
    );
    expect(fixedOutcome.ok).toBe(true);
    if (fixedOutcome.ok) {
      const plan = (fixedOutcome.state.engineState as WerewolfEngineState).rules.rolePlan;
      expect(plan).toEqual(werewolfBoard(9) satisfies WerewolfRolePlan);
    }
  });
});

// ---------------------------------------------------------------------------
// 引擎集成:私有视图泄漏断言 + 座位哈希同源
// ---------------------------------------------------------------------------

describe("引擎集成(9 人局驱动)", () => {
  const P = Array.from({ length: 12 }, (_, i) => `hash-real-${i}`);

  function roomPlayer(participantHash: string, isHost: boolean): GameRoomPlayer {
    return {
      participantHash,
      displayName: isHost ? "房主" : `玩家${P.indexOf(participantHash) + 1}`,
      isHost,
      ready: false,
      joinedAt: new Date().toISOString(),
      leftAt: null,
    };
  }

  function unwrap(outcome: { ok: boolean; state?: GameRoomState; error?: { message: string } }): GameRoomState {
    if (!outcome.ok) throw new Error(`引擎拒绝:${outcome.error?.message ?? ""}`);
    return outcome.state!;
  }

  /** 建房 → 依序入座 → 全员准备 → 房主开局(与引擎单测同款最小驱动)。 */
  function startedReal(n: number): GameRoomState {
    const now = new Date().toISOString();
    let state: GameRoomState = {
      roomId: "room_r2_client",
      gameType: "werewolf",
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
    state = unwrap(werewolfEngine.createRoom(state, {}));
    state = { ...state, version: state.version + 1 };
    for (let i = 1; i < n; i += 1) {
      const players = state.players.filter((p) => p.participantHash !== P[i]);
      state = unwrap(werewolfEngine.joinRoom({ ...state, players }, roomPlayer(P[i]!, false)));
      state = { ...state, version: state.version + 1 };
    }
    for (const player of state.players) {
      state = unwrap(werewolfEngine.setReady(state, player.participantHash, true));
      state = { ...state, version: state.version + 1 };
    }
    return unwrap(werewolfEngine.start(state, P[0]!));
  }

  it("泄漏断言:每个座位的解析视图只含自己的角色;广播帧(公开视图)私有面全 null", () => {
    const room = startedReal(9);
    const engine = room.engineState as WerewolfEngineState;
    for (let a = 0; a < 9; a += 1) {
      const parsed = parseWerewolfView(werewolfEngine.getPlayerView(room, P[a]!).view);
      expect(parsed, `座位 ${a} 视图应可解析`).not.toBeNull();
      expect(parsed!.yourSeat).toBe(a);
      expect(parsed!.yourRole).toBe(engine.seats[a]!.role);
      // 客户端收敛后的视图 JSON 不含任何别人的身份键(泄漏即失败)。
      const json = JSON.stringify(parsed);
      for (const role of WEREWOLF_ALL_ROLES) {
        if (role === engine.seats[a]!.role) continue;
        expect(json, `座位 ${a}(=${engine.seats[a]!.role}) 不应泄漏 ${role}`).not.toContain(`"${role}"`);
      }
    }
    const pub = parseWerewolfView(werewolfEngine.getPublicView(room).view)!;
    expect(pub.yourRole).toBeNull();
    expect(pub.yourSeat).toBeNull();
    expect(pub.yourAlive).toBeNull();
    expect(pub.wolfMates).toBeNull();
    expect(pub.checkResults).toBeNull();
    expect(pub.potions).toBeNull();
    expect(pub.lastGuarded).toBeNull();
    expect(pub.tonightKnife).toBeNull();
    expect(pub.nightKnife).toBeNull();
  });

  it("座位哈希与信封同源:seats[].participantHash 按「开局时在座行序」对齐信封玩家", () => {
    const room = startedReal(9);
    const parsed = parseWerewolfView(werewolfEngine.getPlayerView(room, P[0]!).view)!;
    expect(parsed.seats.map((seat) => seat.participantHash)).toEqual(
      room.players.filter((p) => p.leftAt === null).map((p) => p.participantHash),
    );
    // 客户端据此把座位映射到昵称:座位 0 = 房主。
    expect(werewolfSeatName(room, parsed, 0)).toBe("房主");
    expect(parsed.seats[0]!.isYou).toBe(true);
  });

  it("开局即夜 1:阶段展示走「第 1 夜」横幅,日夜横幅数据来自权威状态", () => {
    const room = startedReal(9);
    const parsed = parseWerewolfView(werewolfEngine.getPlayerView(room, P[0]!).view)!;
    expect(parsed.day).toBe(1);
    expect(parsed.phase).toBe("night_guard");
    expect(werewolfDayLabel(parsed.day, parsed.phase)).toBe("第 1 夜");
    expect(WEREWOLF_PHASE_NAMES[parsed.phase]).toBe("守卫行动");
  });
});

// ---------------------------------------------------------------------------
// 接线守护(Board 注册、入口标注、房主配置面板与聊天页签接线)
// ---------------------------------------------------------------------------

describe("接线守护(Board 注册与入口标注)", () => {
  it("werewolf 引擎 meta 标注「6-12 人开局」,/trial 与 /app 入口卡经 /api/game/types 自动带上", () => {
    expect(werewolfEngine.gameType).toBe("werewolf");
    expect(werewolfEngine.meta?.displayName).toBe("狼人杀");
    expect(werewolfEngine.meta?.minPlayers).toBe(6);
    expect(werewolfEngine.meta?.maxPlayers).toBe(12);
    expect(werewolfEngine.meta?.description).toContain("6-12 人开局");
  });

  it("game-boards.tsx 注册了 werewolf → WerewolfBoardPanel(静态读源码守卫,node 环境不 import JSX)", () => {
    const source = readFileSync(join(process.cwd(), "admin", "src", "survey", "game-boards.tsx"), "utf8");
    expect(source).toContain('import { WerewolfBoardPanel } from "./WerewolfBoard"');
    expect(source).toContain('registerGameBoard("werewolf", WerewolfBoardPanel)');
  });

  it("WerewolfBoard.tsx 存在且消费 GameBoardProps/parseWerewolfView,九个动作齐全(静态读源码守卫)", () => {
    const source = readFileSync(join(process.cwd(), "admin", "src", "survey", "WerewolfBoard.tsx"), "utf8");
    expect(source).toContain("export function WerewolfBoardPanel");
    expect(source).toContain("parseWerewolfView(view.view)");
    expect(source).toContain("werewolfLocalTargetCheck");
    expect(source).toContain("werewolfDayLabel(");
    expect(source).toContain("werewolfTallyFromEvents");
    expect(source).toContain("werewolfSeatPoints(");
    expect(source).toContain("仅自己可见");
    // 夜晚按角色动作 + 白天发言投票 + 猎人开枪。
    expect(source).toContain('handleTargetAction("guard")');
    expect(source).toContain('handleTargetAction("wolf_kill")');
    expect(source).toContain('handleTargetAction("seer_check")');
    expect(source).toContain('sendGameAction("witch_save")');
    expect(source).toContain('handleTargetAction("witch_poison")');
    expect(source).toContain('sendGameAction("witch_pass")');
    expect(source).toContain('sendGameAction("speak", { text: speechText })');
    expect(source).toContain('handleTargetAction("vote")');
    expect(source).toContain('sendGameAction("vote", { target: null })');
    expect(source).toContain('handleTargetAction("hunter_shot")');
    expect(source).toContain('sendGameAction("hunter_pass")');
  });

  it("WerewolfBoard.tsx 导出房主配置面板(板子预设/时限/托管)供大厅插槽挂载", () => {
    const source = readFileSync(join(process.cwd(), "admin", "src", "survey", "WerewolfBoard.tsx"), "utf8");
    expect(source).toContain("export function WerewolfHostConfigPanel");
    expect(source).toContain("WEREWOLF_PRESET_OPTIONS");
    expect(source).toContain("WEREWOLF_TURN_MS_OPTIONS");
    expect(source).toContain("autoWolfKill");
  });

  it("MultiplayerGameScreen 把 chatTabsFor 接上狼人资格、把配置面板挂进创建卡并随建房下发 config", () => {
    const source = readFileSync(join(process.cwd(), "admin", "src", "survey", "MultiplayerGameScreen.tsx"), "utf8");
    expect(source).toContain("chatTabsFor(role, werewolfChatMembership(view))");
    expect(source).toContain('effectiveType === "werewolf"');
    expect(source).toContain("<WerewolfHostConfigPanel value={werewolfConfig} onChange={setWerewolfConfig} />");
    expect(source).toContain("buildWerewolfRoomConfig(werewolfConfig)");
  });

  it("GameLobbyEntry 有 configPanel 插槽;createGameRoom 支持可选 config 透传", () => {
    const lobby = readFileSync(join(process.cwd(), "admin", "src", "survey", "GameLobby.tsx"), "utf8");
    expect(lobby).toContain("configPanel?: ReactNode");
    expect(lobby).toContain("{configPanel}");
    const client = readFileSync(join(process.cwd(), "admin", "src", "survey", "game-room-client.ts"), "utf8");
    expect(client).toContain("config?: Record<string, unknown>");
  });
});
