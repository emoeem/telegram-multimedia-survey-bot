import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { GameRoomPlayer, GameRoomState } from "../../../src/game/multiplayer/engine-types";
import { doudizhuEngine } from "../../../src/game/multiplayer/engines/doudizhu";
import {
  doudizhuHandSort,
  doudizhuPlayHint,
  doudizhuSeatName,
  parseDoudizhuView,
  type DoudizhuView,
} from "../../../admin/src/survey/game-room-logic";

/**
 * 斗地主客户端纯逻辑单测(游戏批次 F2 客户端):视图收敛 parseDoudizhuView
 * (服务端可能返回任何 JSON,形状不对整包拒绝)、手牌排序 doudizhuHandSort
 * (desc/asc 两档切换)、牌型即时预判文案 doudizhuPlayHint(客户端预判 +
 * 服务端裁决的提示口径)、座位名收敛,以及 Board 注册与「3 人开局」入口
 * 标注的接线守护。
 */

const c = (rank: number, copy = 0) => `${rank}:${copy}`;

/** 与 doudizhuEngine.viewPayload 同形的合法载荷(叫分阶段)。 */
function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    seats: [
      {
        seatIndex: 0,
        seatToken: "seat-host",
        handCount: 17,
        isLandlord: false,
        isBidTurn: true,
        resigned: false,
        playedCount: 0,
      },
      {
        seatIndex: 1,
        seatToken: "seat-p2",
        handCount: 17,
        isLandlord: false,
        isBidTurn: false,
        resigned: false,
        playedCount: 0,
      },
      {
        seatIndex: 2,
        seatToken: "seat-p3",
        handCount: 17,
        isLandlord: false,
        isBidTurn: false,
        resigned: false,
        playedCount: 0,
      },
    ],
    hand: [c(16), c(14, 2), c(10, 1), c(3, 0)],
    bottomCount: 3,
    bottomCards: null,
    phase: "bidding",
    bidTurn: 0,
    bids: [],
    currentBid: null,
    landlordSeat: null,
    bidScore: 0,
    currentTurn: 0,
    lastPlay: null,
    canPass: false,
    bombCount: 0,
    multiplier: { base: 1, bid: 0, bombs: 0, spring: 1 },
    history: [],
    events: [],
    outcome: null,
    redealCount: 0,
    yourSeat: 0,
    ...overrides,
  };
}

describe("parseDoudizhuView(视图收敛)", () => {
  it("合法载荷收敛:手牌/座位/倍数/yourSeat 逐字段还原", () => {
    const view = parseDoudizhuView(validPayload());
    expect(view).not.toBeNull();
    const dd = view as DoudizhuView;
    expect(dd.phase).toBe("bidding");
    expect(dd.hand).toEqual([c(16), c(14, 2), c(10, 1), c(3, 0)]);
    expect(dd.seats).toHaveLength(3);
    expect(dd.seats[0]!.seatToken).toBe("seat-host");
    expect(dd.seats[0]!.isBidTurn).toBe(true);
    expect(dd.yourSeat).toBe(0);
    expect(dd.bottomCards).toBeNull();
    expect(dd.bottomCount).toBe(3);
    expect(dd.multiplier).toEqual({ base: 1, bid: 0, bombs: 0, spring: 1 });
    expect(dd.canPass).toBe(false);
  });

  it("地主确定后:底牌公开、lastPlay 与 canPass 还原", () => {
    const view = parseDoudizhuView(
      validPayload({
        phase: "playing",
        landlordSeat: 1,
        bidScore: 2,
        bottomCards: [c(15, 0), c(15, 1), c(7, 3)],
        lastPlay: { seatIndex: 1, cards: [c(13, 0), c(13, 1)], type: "pair" },
        canPass: true,
        currentTurn: 2,
        multiplier: { base: 2, bid: 2, bombs: 1, spring: 1 },
      }),
    );
    const dd = view as DoudizhuView;
    expect(dd.bottomCards).toEqual([c(15, 0), c(15, 1), c(7, 3)]);
    expect(dd.lastPlay).toEqual({ seatIndex: 1, cards: [c(13, 0), c(13, 1)], type: "pair" });
    expect(dd.canPass).toBe(true);
    expect(dd.multiplier.base).toBe(2);
  });

  it("观战/公开视图(yourSeat 缺失):hand 为空、yourSeat 为 null", () => {
    const payload = validPayload();
    delete (payload as Record<string, unknown>).yourSeat;
    (payload as Record<string, unknown>).hand = [];
    const view = parseDoudizhuView(payload);
    expect(view).not.toBeNull();
    expect((view as DoudizhuView).yourSeat).toBeNull();
    expect((view as DoudizhuView).hand).toEqual([]);
  });

  it("形状不对整包拒绝(返回 null):非对象/坏 phase/坏 seats/坏手牌牌码/坏上一手牌码", () => {
    expect(parseDoudizhuView(null)).toBeNull();
    expect(parseDoudizhuView("nope")).toBeNull();
    expect(parseDoudizhuView(validPayload({ phase: "waiting" }))).toBeNull();
    expect(parseDoudizhuView(validPayload({ seats: "three" }))).toBeNull();
    expect(parseDoudizhuView(validPayload({ seats: [] }))).toBeNull();
    // 手牌里混入非法牌码(协议损坏)→ 整包拒绝。
    expect(parseDoudizhuView(validPayload({ hand: [c(3), "99:0"] }))).toBeNull();
    expect(parseDoudizhuView(validPayload({ hand: ["3"] }))).toBeNull();
    // 上一手牌码非法 → 整包拒绝。
    expect(parseDoudizhuView(validPayload({ lastPlay: { seatIndex: 1, cards: ["x:9"], type: "pair" } }))).toBeNull();
    // 底牌非法 → 整包拒绝。
    expect(parseDoudizhuView(validPayload({ bottomCards: [c(3), "2:4", c(5)] }))).toBeNull();
  });

  it("历史与事件逐条容错:脏条目丢弃不炸屏", () => {
    const view = parseDoudizhuView(
      validPayload({
        history: [
          { ply: 1, seatIndex: 0, kind: "bid", score: 2, text: "房主 叫 2 分" },
          { ply: "x", seatIndex: 0, kind: "bid", text: "脏条目" },
          { ply: 2, seatIndex: 1, kind: "play", cards: [c(5, 0)], playType: "single", text: "玩家2 出 单张 5" },
          { ply: 3, seatIndex: 2, kind: "play", cards: ["bad"], text: "脏牌码" },
        ],
        events: [{ ply: 1, seatIndex: null, kind: "landlord", text: "房主 以 2 分成为地主" }, "dirty"],
      }),
    );
    const dd = view as DoudizhuView;
    expect(dd.history).toHaveLength(2);
    expect(dd.history[0]!.score).toBe(2);
    expect(dd.history[1]!.cards).toEqual([c(5, 0)]);
    expect(dd.events).toHaveLength(1);
    expect(dd.events[0]!.text).toContain("成为地主");
  });
});

describe("doudizhuHandSort(手牌排序,可切换)", () => {
  const hand = [c(10, 2), c(3, 1), c(15, 0), c(3, 0), c(14, 2), c(17, 0)];

  it("desc = 点数大在前(默认档),同点数按牌码稳定排列", () => {
    expect(doudizhuHandSort(hand, "desc")).toEqual([c(17, 0), c(15, 0), c(14, 2), c(10, 2), c(3, 0), c(3, 1)]);
  });

  it("asc = 点数小在前(切换档),点数序与 desc 互为逆序(同点数副本序两档一致)", () => {
    const asc = doudizhuHandSort(hand, "asc");
    expect(asc).toEqual([c(3, 0), c(3, 1), c(10, 2), c(14, 2), c(15, 0), c(17, 0)]);
    const rankOf = (card: string) => Number(card.slice(0, card.indexOf(":")));
    expect(asc.map(rankOf)).toEqual(doudizhuHandSort(hand, "desc").map(rankOf).reverse());
  });

  it("纯函数:不改原数组;空表/单张原样返回", () => {
    const original = [c(5, 1), c(4, 0)];
    const sorted = doudizhuHandSort(original, "asc");
    expect(original).toEqual([c(5, 1), c(4, 0)]);
    expect(sorted).not.toBe(original);
    expect(doudizhuHandSort([], "desc")).toEqual([]);
    expect(doudizhuHandSort([c(9, 0)], "asc")).toEqual([c(9, 0)]);
  });

  it("与服务端引擎的默认序(desc)一致,客户端切换只影响展示", () => {
    // 服务端 sortDoudizhuHand 的口径是「点数降序、副本升序」——desc 档与之恒等。
    const mixed = [c(7, 3), c(7, 0), c(7, 1)];
    expect(doudizhuHandSort(mixed, "desc")).toEqual([c(7, 0), c(7, 1), c(7, 3)]);
  });
});

describe("doudizhuPlayHint(牌型即时预判文案;服务端裁决为准)", () => {
  it("未选牌不给提示(null)", () => {
    expect(doudizhuPlayHint([], null)).toBeNull();
  });

  it("自由出:合法牌型提示「· 可出」;不合法提示牌型错误", () => {
    expect(doudizhuPlayHint([c(3, 0)], null)).toBe("单张 · 可出");
    expect(doudizhuPlayHint([c(3, 0), c(3, 1)], null)).toBe("对子 · 可出");
    expect(doudizhuPlayHint([c(3, 0), c(5, 1), c(7, 2)], null)).toBe("不是合法的斗地主牌型");
    expect(doudizhuPlayHint([c(16, 0), c(17, 0)], null)).toBe("王炸 · 可出");
    // 2 不能进顺子(点数 15 > A)。
    expect(doudizhuPlayHint([c(11, 0), c(12, 0), c(13, 0), c(14, 0), c(15, 0)], null)).toBe("不是合法的斗地主牌型");
  });

  it("跟牌:压得过提示可出,压不过提示上一手牌型", () => {
    const lastPairK = { seatIndex: 1, cards: [c(13, 0), c(13, 1)], type: "pair" };
    expect(doudizhuPlayHint([c(14, 0), c(14, 1)], lastPairK)).toBe("对子 · 可出");
    expect(doudizhuPlayHint([c(3, 0), c(3, 1)], lastPairK)).toBe("对子 · 压不过上一手（pair）");
    // 型不同张数不同(三带一 vs 对子)→ 压不过。
    expect(doudizhuPlayHint([c(5, 0), c(5, 1), c(5, 2), c(9, 0)], lastPairK)).toBe("三带一 · 压不过上一手（pair）");
    // 炸弹压非炸弹;王炸压一切。
    expect(doudizhuPlayHint([c(9, 0), c(9, 1), c(9, 2), c(9, 3)], lastPairK)).toBe("炸弹 · 可出");
    const lastBomb = { seatIndex: 2, cards: [c(9, 0), c(9, 1), c(9, 2), c(9, 3)], type: "bomb" };
    expect(doudizhuPlayHint([c(16, 0), c(17, 0)], lastBomb)).toBe("王炸 · 可出");
    // 炸弹比点数:10 炸压 9 炸可出,3 炸压不过。
    expect(doudizhuPlayHint([c(10, 0), c(10, 1), c(10, 2), c(10, 3)], lastBomb)).toBe("炸弹 · 可出");
    expect(doudizhuPlayHint([c(3, 0), c(3, 1), c(3, 2), c(3, 3)], lastBomb)).toBe("炸弹 · 压不过上一手（bomb）");
  });
});

describe("doudizhuSeatName(座位名收敛,座位令牌对位)", () => {
  /** 信封行(与 GamePlayerView.players 同形)。 */
  const row = (token: string, name: string | null, leftAt: string | null = null) => ({
    seatToken: token,
    displayName: name,
    leftAt,
  });

  it("按座位载荷的 seatToken 对位昵称;displayName 缺名回退「玩家N」", () => {
    const view = { players: [row("seat-host", "房主"), row("seat-p2", null), row("seat-p3", "  ")] };
    expect(doudizhuSeatName(view, parseDoudizhuView(validPayload())!, 0)).toBe("房主");
    expect(doudizhuSeatName(view, parseDoudizhuView(validPayload())!, 1)).toBe("玩家2");
    expect(doudizhuSeatName(view, parseDoudizhuView(validPayload())!, 2)).toBe("玩家3");
  });

  it("中途离席不错位:信封 [A 在座, B 离席, C 在座] 时,座位 1 仍是 B、座位 2 仍是 C", () => {
    // 复核代理的实测路径:3 人局进行中 B 走「离开房间」,DO 保留 B 的行并置
    // leftAt,在座行序变 [A,C] 而引擎座位开局固定 [A,B,C]——按在座行序对位
    // 会把 C 的昵称挂到座位 1(离席者)上。
    const view = { players: [row("seat-host", "甲"), row("seat-p2", "乙", "t"), row("seat-p3", "丙")] };
    const dd = parseDoudizhuView(validPayload())!;
    expect(doudizhuSeatName(view, dd, 1)).toBe("乙");
    expect(doudizhuSeatName(view, dd, 2)).toBe("丙");
    expect(doudizhuSeatName(view, dd, 0)).toBe("甲");
  });

  it("旧部署兜底(无座位令牌):全在座且行数=座位数时按行序对位;有离席行时回退「玩家N」绝不错挂", () => {
    const seatsNoHash = (payload: Record<string, unknown>): Record<string, unknown> => ({
      ...payload,
      seats: (payload.seats as Array<Record<string, unknown>>).map((seat) => {
        const { seatToken: _drop, ...rest } = seat;
        return rest;
      }),
    });
    // 全在座:行序 = 座位序,昵称照常显示。
    const allActive = { players: [row("seat-host", "甲"), row("seat-p2", "乙"), row("seat-p3", "丙")] };
    const ddNoHash = parseDoudizhuView(seatsNoHash(validPayload()))!;
    expect(ddNoHash.seats.every((seat) => seat.seatToken === null)).toBe(true);
    expect(doudizhuSeatName(allActive, ddNoHash, 1)).toBe("乙");
    // 有离席行:在座行序对不上座位序 → 回退「玩家N」,不取别人的名字。
    const withLeft = { players: [row("seat-host", "甲"), row("seat-p2", "乙", "t"), row("seat-p3", "丙")] };
    expect(doudizhuSeatName(withLeft, ddNoHash, 1)).toBe("玩家2");
    expect(doudizhuSeatName(withLeft, ddNoHash, 2)).toBe("玩家3");
    // 哈希缺失且找不到行:同样回退座位号名。
    expect(doudizhuSeatName({ players: [] }, ddNoHash, 0)).toBe("玩家1");
  });
});

describe("座位令牌与信封同源(引擎集成断言)", () => {
  /** 建房 → 依序入座 → 全员准备 → 房主开局(与引擎单测同款最小驱动)。 */
  function startedReal(): GameRoomState {
    const P = ["hash-real-0", "hash-real-1", "hash-real-2"];
    const player = (hash: string, isHost: boolean): GameRoomPlayer => ({
      participantHash: hash,
      // 座位令牌按身份确定性派生(测试内恒定);生产由 DO 随机铸造。
      seatToken: `seat-${hash}`,
      displayName: isHost ? "房主" : `玩家${P.indexOf(hash) + 1}`,
      isHost,
      ready: false,
      joinedAt: new Date().toISOString(),
      leftAt: null,
    });
    const unwrap = (outcome: ReturnType<typeof doudizhuEngine.createRoom>): GameRoomState => {
      if (!outcome.ok) throw new Error(`引擎拒绝:${outcome.error.code} ${outcome.error.message}`);
      return outcome.state;
    };
    let state = unwrap(
      doudizhuEngine.createRoom(
        {
          roomId: "room_seat_hash",
          gameType: "doudizhu",
          status: "lobby",
          version: 1,
          config: {},
          rngNonce: "nonce-seat-hash",
          players: [player(P[0]!, true)],
          engineState: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          deadlineAt: null,
          recycleAt: null,
          closedAt: null,
        },
        {},
      ),
    );
    for (let i = 1; i < 3; i += 1) {
      const players = state.players.filter((p) => p.participantHash !== P[i]);
      state = unwrap(doudizhuEngine.joinRoom({ ...state, players }, player(P[i]!, false)));
      state = { ...state, version: state.version + 1 };
    }
    for (const p of state.players) {
      state = unwrap(doudizhuEngine.setReady(state, p.participantHash, true));
      state = { ...state, version: state.version + 1 };
    }
    return unwrap(doudizhuEngine.start(state, P[0]!));
  }

  it("引擎视图 seats[].seatToken 与信封 players 行序一致(座位号→昵称对位的数据源)", () => {
    const state = startedReal();
    const view = doudizhuEngine.getPlayerView(state, "hash-real-0").view as Record<string, unknown>;
    const seats = view.seats as Array<{ seatIndex: number; seatToken: string }>;
    expect(seats.map((seat) => seat.seatToken)).toEqual(
      state.players.filter((p) => p.leftAt === null).map((p) => p.seatToken),
    );
    // 客户端解析后可直接按令牌对位。
    const dd = parseDoudizhuView(view)!;
    const rowByToken = new Map(state.players.map((p) => [p.seatToken, p]));
    expect(dd.seats.every((seat) => rowByToken.get(seat.seatToken ?? "") !== undefined)).toBe(true);
  });
});

describe("接线守护(Board 注册与入口标注)", () => {
  it("doudizhu 引擎 meta 标注「3 人开局」,/trial 与 /app 入口卡经 /api/game/types 自动带上", () => {
    expect(doudizhuEngine.meta?.displayName).toBe("斗地主");
    expect(doudizhuEngine.meta?.minPlayers).toBe(3);
    expect(doudizhuEngine.meta?.maxPlayers).toBe(3);
    expect(doudizhuEngine.meta?.description).toContain("3 人开局");
  });

  it("game-boards.tsx 注册了 doudizhu → DouDizhuBoardPanel(静态读源码守卫,node 环境不 import JSX)", () => {
    const source = readFileSync(join(process.cwd(), "admin", "src", "survey", "game-boards.tsx"), "utf8");
    expect(source).toContain('import { DouDizhuBoardPanel } from "./DouDizhuBoard"');
    expect(source).toContain('registerGameBoard("doudizhu", DouDizhuBoardPanel)');
  });

  it("DouDizhuBoard.tsx 存在且消费 GameBoardProps/parseDoudizhuView(静态读源码守卫)", () => {
    const source = readFileSync(join(process.cwd(), "admin", "src", "survey", "DouDizhuBoard.tsx"), "utf8");
    expect(source).toContain("export function DouDizhuBoardPanel");
    expect(source).toContain("parseDoudizhuView(view.view)");
    expect(source).toContain("doudizhuPlayHint");
    expect(source).toContain('sendGameAction("play", { cards: [...selected] })');
    expect(source).toContain('sendGameAction("pass")');
    expect(source).toContain('sendGameAction("bid", { score })');
  });
});
