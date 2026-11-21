import { describe, expect, it } from "vitest";
import type { GamePlayerView, GamePublicView } from "../../../src/game/multiplayer/engine-types";
import {
  GAME_SOUND_DEDUP_MS,
  GAME_SOUND_ENABLED_KEY,
  GAME_SOUND_VOLUME_KEY,
  GAME_SOUND_DEFAULT_VOLUME,
  countdownTickDue,
  dbToGain,
  deriveGameSoundEvents,
  isDeduped,
  jitterRate,
  parseStoredVolume,
  volumeSliderToDb,
  volumeSliderToGain,
  type GameSoundEvent,
} from "../../../admin/src/survey/game-sound";
import { LUDO_FINISH_POS } from "../../../admin/src/survey/game-room-logic";

/**
 * 对局音效纯逻辑层（game-sound.ts 的可测部分）：dB 映射、去重窗口、持久化键、
 * 倒计时判定与「状态差分 → 声音事件」。AudioContext 相关的引擎方法不在单测
 * 覆盖范围（jsdom 无真实音频栈）——模块已把可测逻辑全部拆成纯函数，这里
 * 只 import 模块、不触碰 engine 单例的播放路径。
 */

// ---------------------------------------------------------------------------
// 夹具：房间信封与各玩法视图载荷（与 game-room-logic 解析函数的硬前提对齐）
// ---------------------------------------------------------------------------

const ME = "hash-me";
const OPP = "hash-opp";
// 座位令牌（修复 1）：信封 players / 玩法座位统一用它对位，participantHash
// 不再出现在任何载荷里；差分/胜者判定全部改传 seatToken。
const SEAT_ME = "seat-hash-me";
const SEAT_OPP = "seat-hash-opp";

function envelope(overrides: Partial<GamePlayerView> & { view?: unknown }): GamePlayerView {
  return {
    roomId: "room_1",
    gameType: "gomoku",
    status: "playing",
    version: 1,
    players: [
      { seatToken: SEAT_ME, displayName: null, isHost: true, ready: true, leftAt: null },
      { seatToken: SEAT_OPP, displayName: null, isHost: false, ready: true, leftAt: null },
    ],
    remainingMs: null,
    ...overrides,
  } as GamePlayerView;
}

function gomokuPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    boardSize: 15,
    board: Array.from({ length: 15 }, () => Array<string | null>(15).fill(null)),
    turn: "black",
    players: [
      { seatToken: SEAT_ME, color: "black" },
      { seatToken: SEAT_OPP, color: "white" },
    ],
    moveCount: 0,
    lastMove: null,
    winningLine: null,
    outcome: null,
    pendingDrawFrom: null,
    pendingUndoFrom: null,
    yourColor: "black",
    ...overrides,
  };
}

function xiangqiPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cols: 9,
    rows: 10,
    board: Array.from({ length: 10 }, () => Array<string | null>(9).fill(null)),
    turn: "red",
    players: [
      { seatToken: SEAT_ME, color: "red" },
      { seatToken: SEAT_OPP, color: "black" },
    ],
    moveCount: 0,
    lastMove: null,
    legalMoves: [],
    history: [],
    check: null,
    outcome: null,
    pendingDrawFrom: null,
    yourColor: "red",
    ...overrides,
  };
}

function ludoPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    turnSeat: 0,
    phase: "await_roll",
    seats: [
      { seatIndex: 0, colorIndex: 0, planes: [null, null, null, null], arrived: 0, resigned: false },
      { seatIndex: 1, colorIndex: 1, planes: [null, null, null, null], arrived: 0, resigned: false },
    ],
    history: [],
    events: [],
    outcome: null,
    yourSeat: 0,
    ...overrides,
  };
}

function doudizhuPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    phase: "playing",
    seats: [
      { seatIndex: 0, handCount: 17, isLandlord: false, isBidTurn: false, resigned: false },
      { seatIndex: 1, handCount: 17, isLandlord: false, isBidTurn: false, resigned: false },
      { seatIndex: 2, handCount: 20, isLandlord: true, isBidTurn: false, resigned: false },
    ],
    hand: [],
    bottomCards: null,
    currentTurn: 2,
    history: [],
    events: [],
    outcome: null,
    yourSeat: 0,
    ...overrides,
  };
}

function werewolfPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    day: 1,
    phase: "day_speak",
    seats: [
      { seatIndex: 0, seatToken: SEAT_ME, alive: true, isYou: true },
      { seatIndex: 1, seatToken: SEAT_OPP, alive: true, isYou: false },
    ],
    aliveSeats: [0, 1],
    deadSeats: [],
    lastNightDeaths: [],
    speakTurnSeat: null,
    speeches: [],
    votesNeeded: 2,
    votesSubmitted: 0,
    myVoteSubmitted: false,
    pkCandidates: null,
    pendingShotOpen: false,
    events: [],
    outcome: null,
    yourSeat: 0,
    yourRole: null,
    yourAlive: true,
    wolfMates: null,
    nightKnife: null,
    checkResults: null,
    potions: null,
    tonightKnife: null,
    lastGuarded: null,
    canShoot: false,
    shotTargets: [],
    ...overrides,
  };
}

function derive(
  prev: GamePlayerView | null,
  next: GamePlayerView,
  opts: { role?: "player" | "spectator"; myHash?: string | null } = {},
): GameSoundEvent[] {
  return deriveGameSoundEvents({
    gameType: next.gameType,
    role: opts.role ?? "player",
    // myHash 形参语义不变（「我的公开对位键」），缺省给座位令牌。
    myHash: opts.myHash !== undefined ? opts.myHash : SEAT_ME,
    prev,
    next,
  });
}

// ---------------------------------------------------------------------------
// dB 映射（对数感知）
// ---------------------------------------------------------------------------

describe("音量 dB 映射", () => {
  it("0 → -Infinity（彻底静音），1 → 0 dB，0.8 → -12 dB", () => {
    expect(volumeSliderToDb(0)).toBe(Number.NEGATIVE_INFINITY);
    expect(volumeSliderToDb(1)).toBe(0);
    expect(volumeSliderToDb(0.8)).toBeCloseTo(-12, 10);
  });

  it("滑条越大 dB 单调不降（对数感知：每 +0.1 恒定 +6 dB）", () => {
    let last = volumeSliderToDb(0.1);
    for (let v = 0.1; v <= 1.0001; v += 0.05) {
      expect(volumeSliderToDb(v)).toBeGreaterThanOrEqual(last);
      last = volumeSliderToDb(v);
    }
    expect(volumeSliderToDb(0.2) - volumeSliderToDb(0.1)).toBeCloseTo(6, 10);
    expect(volumeSliderToDb(0.9) - volumeSliderToDb(0.8)).toBeCloseTo(6, 10);
    expect(volumeSliderToGain(0.1)).toBeGreaterThan(0);
  });

  it("越界值收敛到 [0,1]", () => {
    expect(volumeSliderToDb(1.5)).toBe(0);
    expect(volumeSliderToDb(-0.5)).toBe(Number.NEGATIVE_INFINITY);
    expect(volumeSliderToDb(Number.NaN)).toBe(volumeSliderToDb(0));
  });

  it("dB → 线性增益：0 dB = 1，-Infinity = 0，-20 dB = 0.1", () => {
    expect(dbToGain(0)).toBe(1);
    expect(dbToGain(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(dbToGain(-20)).toBeCloseTo(0.1, 12);
    expect(volumeSliderToGain(0)).toBe(0);
    expect(volumeSliderToGain(1)).toBe(1);
    expect(volumeSliderToGain(0.5)).toBeCloseTo(10 ** (-30 / 20), 12);
  });

  it("存储值解析：缺省/脏数据回默认，越界收敛", () => {
    expect(parseStoredVolume(null)).toBe(GAME_SOUND_DEFAULT_VOLUME);
    expect(parseStoredVolume("abc")).toBe(GAME_SOUND_DEFAULT_VOLUME);
    expect(parseStoredVolume("0.3")).toBe(0.3);
    expect(parseStoredVolume("2")).toBe(1);
    expect(parseStoredVolume("-1")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 去重窗口与音高抖动
// ---------------------------------------------------------------------------

describe("去重窗口与音高抖动", () => {
  it("同一事件 200ms 内去重，到点放行", () => {
    expect(GAME_SOUND_DEDUP_MS).toBe(200);
    expect(isDeduped(1000, 1150)).toBe(true);
    expect(isDeduped(1000, 1200)).toBe(false);
    expect(isDeduped(1000, 1300)).toBe(false);
  });

  it("从未播过（-Infinity）不去重", () => {
    expect(isDeduped(Number.NEGATIVE_INFINITY, 0)).toBe(false);
  });

  it("音高抖动限制在 ±6% 内", () => {
    expect(jitterRate(0)).toBeCloseTo(0.94, 12);
    expect(jitterRate(1)).toBeCloseTo(1.06, 12);
    expect(jitterRate(0.5)).toBe(1);
    for (let r = 0; r <= 1; r += 0.1) {
      const rate = jitterRate(r);
      expect(rate).toBeGreaterThanOrEqual(0.94);
      expect(rate).toBeLessThanOrEqual(1.06);
    }
  });
});

// ---------------------------------------------------------------------------
// 持久化键（沿用 settings 约定：扁平 camelCase）
// ---------------------------------------------------------------------------

describe("静音持久化键", () => {
  it("开关与音量键名固定（页头小喇叭与「我的」设置共用同一约定）", () => {
    expect(GAME_SOUND_ENABLED_KEY).toBe("gameSoundEnabled");
    expect(GAME_SOUND_VOLUME_KEY).toBe("gameSoundVolume");
  });
});

// ---------------------------------------------------------------------------
// 倒计时 tick 判定
// ---------------------------------------------------------------------------

describe("倒计时 tick 判定", () => {
  it("只在 ≤10s 紧急窗口内跨秒时响", () => {
    expect(countdownTickDue(9900, 8900)).toBe(true); // 跨过 9s 整数秒
    expect(countdownTickDue(10050, 9900)).toBe(true); // 刚跨进窗口
    expect(countdownTickDue(10500, 10050)).toBe(false); // >10s 不响
    expect(countdownTickDue(9900, 9400)).toBe(false); // 未跨整数秒
  });

  it("未跨秒不响；向上跳变（换手重置）不响；无时限/未同步不响", () => {
    expect(countdownTickDue(9700, 9550)).toBe(false);
    expect(countdownTickDue(8000, 30000)).toBe(false);
    expect(countdownTickDue(null, 5000)).toBe(false);
    expect(countdownTickDue(5000, null)).toBe(false);
    expect(countdownTickDue(0, 100)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 状态差分 → 声音事件
// ---------------------------------------------------------------------------

describe("开局与玩家进出", () => {
  it("大厅 → 对局：开局 stinger（且不重复补放玩家加入）", () => {
    const prev = envelope({ status: "lobby", gameType: "gomoku", view: gomokuPayload() });
    const next = envelope({ status: "playing", gameType: "gomoku", view: gomokuPayload() });
    expect(derive(prev, next)).toEqual(["game_start"]);
  });

  it("玩家加入/离开：信封在座行差分各响一次", () => {
    const prev = envelope({
      status: "lobby",
      players: [{ seatToken: SEAT_ME, displayName: null, isHost: true, ready: true, leftAt: null }],
      view: gomokuPayload(),
    });
    const joined = envelope({
      status: "lobby",
      players: [
        { seatToken: SEAT_ME, displayName: null, isHost: true, ready: true, leftAt: null },
        { seatToken: SEAT_OPP, displayName: null, isHost: false, ready: false, leftAt: null },
      ],
      view: gomokuPayload(),
    });
    expect(derive(prev, joined)).toContain("player_join");

    const left = envelope({
      status: "lobby",
      players: [
        { seatToken: SEAT_ME, displayName: null, isHost: true, ready: true, leftAt: null },
        { seatToken: SEAT_OPP, displayName: null, isHost: false, ready: false, leftAt: "2026-11-21T00:00:00Z" },
      ],
      view: gomokuPayload(),
    });
    expect(derive(joined, left)).toContain("player_leave");
    expect(derive(joined, left)).not.toContain("player_join");
  });

  it("首帧（进房/重连后的第一帧）一律不响", () => {
    expect(derive(null, envelope({ view: gomokuPayload() }))).toEqual([]);
    expect(
      derive(
        null,
        envelope({ status: "settled", view: gomokuPayload({ outcome: { result: "win", winnerSeatToken: SEAT_ME } }) }),
      ),
    ).toEqual([]);
  });
});

describe("结算音", () => {
  const settledGomoku = (result: string, winner: string | null) =>
    envelope({
      status: "settled",
      settlement: { result, winnerSeatToken: winner, summary: {}, settledAt: "x", version: 9 },
      view: gomokuPayload({ outcome: { result, winnerSeatToken: winner } }),
    });

  it("我赢 → victory；对方赢 → defeat；平局 → draw", () => {
    expect(derive(envelope({ view: gomokuPayload() }), settledGomoku("win", SEAT_ME))).toContain("victory");
    expect(derive(envelope({ view: gomokuPayload() }), settledGomoku("win", SEAT_OPP))).toContain("defeat");
    expect(derive(envelope({ view: gomokuPayload() }), settledGomoku("resign", SEAT_OPP))).toContain("defeat");
    expect(derive(envelope({ view: gomokuPayload() }), settledGomoku("draw", null))).toContain("draw");
  });

  it("超时判负（我输）→ timeout_loss；对方超时（我赢）→ victory", () => {
    expect(derive(envelope({ view: gomokuPayload() }), settledGomoku("timeout", SEAT_OPP))).toContain("timeout_loss");
    expect(derive(envelope({ view: gomokuPayload() }), settledGomoku("timeout", SEAT_ME))).toContain("victory");
    expect(derive(envelope({ view: gomokuPayload() }), settledGomoku("timeout", SEAT_OPP))).not.toContain("defeat");
  });

  it("中止局（无赢家）不响；观战者不给胜负音", () => {
    expect(derive(envelope({ view: gomokuPayload() }), settledGomoku("aborted", null))).toEqual([]);
    const spectatorDerive = deriveGameSoundEvents({
      gameType: "gomoku",
      role: "spectator",
      myHash: null,
      prev: envelope({ view: gomokuPayload() }),
      next: settledGomoku("win", SEAT_OPP),
    });
    expect(spectatorDerive).not.toContain("defeat");
    expect(spectatorDerive).not.toContain("victory");
  });

  it("斗地主春天 → dd_spring（替代常规胜负音）；地主方胜负按我的座位判定", () => {
    const landlordWin = envelope({
      gameType: "doudizhu",
      status: "settled",
      view: doudizhuPayload({
        outcome: { result: "win", winnerSeat: 2, winnerSide: "landlord", reason: "playout", spring: "none" },
      }),
    });
    expect(derive(envelope({ gameType: "doudizhu", view: doudizhuPayload() }), landlordWin)).toEqual(["defeat"]);

    const spring = envelope({
      gameType: "doudizhu",
      status: "settled",
      view: doudizhuPayload({
        outcome: { result: "win", winnerSeat: 0, winnerSide: "farmers", reason: "playout", spring: "spring" },
      }),
    });
    expect(derive(envelope({ gameType: "doudizhu", view: doudizhuPayload() }), spring)).toEqual(["dd_spring"]);
  });

  it("狼人杀：好人与狼各按自己的阵营判胜负", () => {
    const wolfWin = envelope({
      gameType: "werewolf",
      status: "settled",
      view: werewolfPayload({ outcome: { result: "wolf_win", winnerSide: "wolves", reason: "wolves_equal_good" } }),
    });
    expect(derive(envelope({ gameType: "werewolf", view: werewolfPayload() }), wolfWin)).toEqual(["defeat"]);
    expect(
      derive(
        envelope({ gameType: "werewolf", view: werewolfPayload() }),
        envelope({
          gameType: "werewolf",
          status: "settled",
          view: werewolfPayload({
            outcome: { result: "wolf_win", winnerSide: "wolves", reason: "x" },
            yourRole: "werewolf",
            wolfMates: [1],
          }),
        }),
      ),
    ).toEqual(["victory"]);
  });
});

describe("五子棋", () => {
  it("对手落子：石子敲击 + 轮到你", () => {
    const prev = envelope({
      view: gomokuPayload({
        moveCount: 1,
        turn: "white",
        lastMove: { row: 7, col: 7, color: "black", seatToken: SEAT_ME },
      }),
    });
    const next = envelope({
      view: gomokuPayload({
        moveCount: 2,
        turn: "black",
        lastMove: { row: 8, col: 8, color: "white", seatToken: SEAT_OPP },
      }),
    });
    expect(derive(prev, next)).toEqual(["gomoku_place", "turn_you"]);
  });

  it("自己落子被服务端接受：只有石子敲击（turn 不转向自己）", () => {
    const prev = envelope({ view: gomokuPayload({ moveCount: 0, turn: "black" }) });
    const next = envelope({
      view: gomokuPayload({
        moveCount: 1,
        turn: "white",
        lastMove: { row: 7, col: 7, color: "black", seatToken: SEAT_ME },
      }),
    });
    expect(derive(prev, next)).toEqual(["gomoku_place"]);
  });

  it("悔棋被接受（步数回退）→ 回退 swish", () => {
    const prev = envelope({ view: gomokuPayload({ moveCount: 2, turn: "black" }) });
    const next = envelope({ view: gomokuPayload({ moveCount: 1, turn: "white" }) });
    expect(derive(prev, next)).toEqual(["gomoku_undo"]);
  });
});

describe("象棋", () => {
  it("落子 → 木质 snap；带将军 → 追加警报双音", () => {
    const base = {
      moveCount: 1,
      turn: "red",
      lastMove: {
        ply: 1,
        color: "black",
        from: { row: 0, col: 0 },
        to: { row: 1, col: 0 },
        piece: "p",
        captured: null,
        seatToken: SEAT_OPP,
        givesCheck: false,
      },
    };
    const noCheck = envelope({ gameType: "xiangqi", view: xiangqiPayload({ ...base }) });
    expect(
      derive(envelope({ gameType: "xiangqi", view: xiangqiPayload({ moveCount: 0, turn: "black" }) }), noCheck),
    ).toEqual(["xiangqi_place", "turn_you"]);

    const check = envelope({
      gameType: "xiangqi",
      view: xiangqiPayload({ ...base, lastMove: { ...base.lastMove, givesCheck: true } }),
    });
    expect(
      derive(envelope({ gameType: "xiangqi", view: xiangqiPayload({ moveCount: 0, turn: "black" }) }), check),
    ).toEqual(["xiangqi_place", "xiangqi_check", "turn_you"]);
  });
});

describe("飞行棋", () => {
  it("新的一手 → 骰子滚筒；撞机追加 capture；到达终点追加 finish", () => {
    const move = {
      ply: 1,
      seatIndex: 1,
      colorIndex: 1,
      roll: 5,
      planeSlot: 0,
      from: 3,
      to: 8,
      hops: [{ kind: "move", to: 8 }],
      captures: [],
      text: "",
    };
    const prev = envelope({ gameType: "ludo", view: ludoPayload({ turnSeat: 1 }) });
    const plain = envelope({ gameType: "ludo", view: ludoPayload({ turnSeat: 0, history: [move] }) });
    expect(derive(prev, plain)).toEqual(["ludo_dice", "turn_you"]);

    const captureMove = { ...move, captures: [{ seatIndex: 0, colorIndex: 0, planeSlot: 0 }] };
    const capture = envelope({ gameType: "ludo", view: ludoPayload({ turnSeat: 0, history: [captureMove] }) });
    expect(derive(prev, capture)).toEqual(["ludo_dice", "ludo_capture", "turn_you"]);

    const finishMove = { ...move, to: LUDO_FINISH_POS };
    const finish = envelope({ gameType: "ludo", view: ludoPayload({ turnSeat: 0, history: [finishMove] }) });
    expect(derive(prev, finish)).toEqual(["ludo_dice", "ludo_finish", "turn_you"]);
  });

  it("我的座位超时事件 → timeout_loss", () => {
    const prev = envelope({ gameType: "ludo", view: ludoPayload() });
    const next = envelope({
      gameType: "ludo",
      view: ludoPayload({ events: [{ ply: 1, seatIndex: 0, kind: "timeout", text: "超时" }] }),
    });
    expect(derive(prev, next)).toContain("timeout_loss");
  });
});

describe("斗地主", () => {
  it("手牌从无到有 → 发牌 riffle", () => {
    const prev = envelope({
      gameType: "doudizhu",
      status: "lobby",
      view: doudizhuPayload({
        phase: "bidding",
        seats: [{ seatIndex: 0, handCount: 0, isLandlord: false, isBidTurn: false, resigned: false }],
        currentTurn: 0,
      }),
    });
    const next = envelope({
      gameType: "doudizhu",
      status: "playing",
      view: doudizhuPayload({ hand: ["3:0", "4:0"] }),
    });
    expect(derive(prev, next)).toEqual(["game_start", "dd_deal"]);
  });

  it("普通出牌 → slap；炸弹/王炸 → boom；他人叫分/过 → 短 tick", () => {
    const prev = envelope({ gameType: "doudizhu", view: doudizhuPayload({ currentTurn: 2 }) });
    const play = (playType: string | undefined, kind: "play" | "bid" | "pass", seatIndex: number) =>
      envelope({
        gameType: "doudizhu",
        view: doudizhuPayload({
          currentTurn: 0,
          history: [{ ply: 1, seatIndex, kind, ...(playType ? { playType } : {}), text: "" }],
        }),
      });
    expect(derive(prev, play(undefined, "play", 2))).toContain("dd_play");
    expect(derive(prev, play("bomb", "play", 2))).toContain("dd_bomb");
    expect(derive(prev, play("rocket", "play", 2))).toContain("dd_bomb");
    expect(derive(prev, play(undefined, "bid", 2))).toContain("opponent_action");
    expect(derive(prev, play(undefined, "pass", 2))).toContain("opponent_action");
  });

  it("轮到我出牌 → turn_you", () => {
    const prev = envelope({ gameType: "doudizhu", view: doudizhuPayload({ currentTurn: 2 }) });
    const next = envelope({ gameType: "doudizhu", view: doudizhuPayload({ currentTurn: 0 }) });
    expect(derive(prev, next)).toContain("turn_you");
  });
});

describe("狼人杀", () => {
  it("天黑 → 下行 sweep；天亮 → 上行；猎人窗口 → 警报", () => {
    const lobby = envelope({ gameType: "werewolf", status: "lobby", view: werewolfPayload({ day: 0 }) });
    const night = envelope({ gameType: "werewolf", view: werewolfPayload({ phase: "night_wolf", day: 1 }) });
    expect(derive(lobby, night)).toEqual(["game_start", "ww_night"]);

    const dawn = envelope({ gameType: "werewolf", view: werewolfPayload({ phase: "day_speak", day: 1 }) });
    expect(derive(night, dawn)).toEqual(["ww_dawn"]);

    const hunter = envelope({
      gameType: "werewolf",
      view: werewolfPayload({ phase: "hunter_shot", pendingShotOpen: true }),
    });
    expect(derive(dawn, hunter)).toEqual(["ww_hunter"]);
  });

  it("死亡座位表增长 → 低音 sting；亮票事件 → 投票结果", () => {
    const prev = envelope({ gameType: "werewolf", view: werewolfPayload({ phase: "day_vote", votesSubmitted: 0 }) });
    const died = envelope({
      gameType: "werewolf",
      view: werewolfPayload({ phase: "day_vote", deadSeats: [1], aliveSeats: [0] }),
    });
    expect(derive(prev, died)).toEqual(["ww_death"]);

    const voted = envelope({
      gameType: "werewolf",
      view: werewolfPayload({
        phase: "day_vote",
        events: [{ seq: 1, day: 1, kind: "vote", text: "亮票: 席1→席2" }],
        votesSubmitted: 2,
      }),
    });
    expect(derive(prev, voted)).toEqual(["ww_vote"]);
  });

  it("轮到我发言 → turn_you", () => {
    const prev = envelope({ gameType: "werewolf", view: werewolfPayload({ speakTurnSeat: 1 }) });
    const next = envelope({ gameType: "werewolf", view: werewolfPayload({ speakTurnSeat: 0 }) });
    expect(derive(prev, next)).toEqual(["turn_you"]);
  });
});

// ---------------------------------------------------------------------------
// 信息纪律：夜间狼刀音只在狼人客户端触发（泄漏断言）
// ---------------------------------------------------------------------------

describe("狼刀音信息纪律（不泄露夜间信息）", () => {
  const knifePayload = (overrides: Record<string, unknown>) =>
    werewolfPayload({ phase: "night_wolf", nightKnife: 1, ...overrides });

  it("观战/公开视图即使异常携带 nightKnife 字段也绝不推 ww_knife", () => {
    const prev = envelope({ gameType: "werewolf", view: werewolfPayload({ phase: "night_wolf" }) });
    const next = envelope({ gameType: "werewolf", view: knifePayload({}) });
    // 观战者：role=spectator 且无 myHash
    const spectatorEvents = deriveGameSoundEvents({
      gameType: "werewolf",
      role: "spectator",
      myHash: null,
      prev,
      next,
    });
    expect(spectatorEvents).not.toContain("ww_knife");
    // 普通玩家（好人客户端）：载荷没有 yourRole/wolfMates（模拟公开视图被错投）
    const normalEvents = deriveGameSoundEvents({
      gameType: "werewolf",
      role: "player",
      myHash: ME,
      prev,
      next: envelope({ gameType: "werewolf", view: knifePayload({ yourRole: null, wolfMates: null }) }),
    });
    expect(normalEvents).not.toContain("ww_knife");
  });

  it("狼人客户端刀口落定（null → 座位）→ ww_knife；重复推送（值不变）不响", () => {
    const prev = envelope({
      gameType: "werewolf",
      view: werewolfPayload({ phase: "night_wolf", yourRole: "werewolf", wolfMates: [0, 1], nightKnife: null }),
    });
    const next = envelope({
      gameType: "werewolf",
      view: knifePayload({ yourRole: "werewolf", wolfMates: [0, 1] }),
    });
    expect(derive(prev, next)).toEqual(["ww_knife"]);

    const repeated = envelope({
      gameType: "werewolf",
      view: knifePayload({ yourRole: "werewolf", wolfMates: [0, 1] }),
    });
    expect(derive(next, repeated)).toEqual([]);
  });

  it("新狼刀音是狼人私有面：好人客户端的载荷即便被错误塞入 nightKnife 也推不出（缺 wolfMates 面）", () => {
    const prev = envelope({ gameType: "werewolf", view: werewolfPayload({ phase: "night_wolf" }) });
    const next = envelope({
      gameType: "werewolf",
      view: knifePayload({ yourRole: "villager", wolfMates: null }),
    });
    const events = derive(prev, next);
    expect(events).not.toContain("ww_knife");
  });
});
