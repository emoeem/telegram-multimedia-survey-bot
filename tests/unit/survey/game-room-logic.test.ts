import { describe, expect, it } from "vitest";

import {
  BOARD_MARGIN,
  boardGeometry,
  cellFromPoint,
  countdownTone,
  describeSettlement,
  formatCountdown,
  formatRoomRef,
  gameErrorText,
  localMoveCheck,
  normalizeRoomCode,
  opponentLikelyOffline,
  parseGomokuView,
  roomCodeToId,
  starPoints,
  undoRejectedNotice,
} from "../../../admin/src/survey/game-room-logic";
import { GAME_PROTOCOL_ERROR_CODES } from "../../../src/game/multiplayer/engine-types";

/** 15 路空盘（与 gomokuEngine.emptyBoard 同构）。 */
function emptyBoard(cells = 15): Array<Array<"black" | "white" | null>> {
  return Array.from({ length: cells }, () => Array<"black" | "white" | null>(cells).fill(null));
}

describe("房间码解析（roomCodeToId / normalizeRoomCode）", () => {
  it("纯数字与 room_ 前缀两种形态都能解析，且只收规范十进制", () => {
    expect(roomCodeToId("123")).toBe(123);
    expect(roomCodeToId(" room_123 ")).toBe(123);
    expect(roomCodeToId("ROOM_9")).toBe(9);
    // 与 server 侧 parseGameRoomRef 同一条纪律：0 前缀/负数/非数字/超精度拒绝。
    expect(roomCodeToId("0123")).toBeNull();
    expect(roomCodeToId("12a3")).toBeNull();
    expect(roomCodeToId("room_0")).toBeNull();
    expect(roomCodeToId("-5")).toBeNull();
    expect(roomCodeToId("room_")).toBeNull();
    expect(roomCodeToId("99999999999999999999")).toBeNull();
  });

  it("normalizeRoomCode：裸房间码、room_ 引用与三种链接参数都能捞出 id", () => {
    expect(normalizeRoomCode("123")).toBe(123);
    expect(normalizeRoomCode("room_123")).toBe(123);
    expect(normalizeRoomCode("https://t.me/mybot?startapp=room_45")).toBe(45);
    expect(normalizeRoomCode("https://example.com/game?room=77")).toBe(77);
    expect(normalizeRoomCode("https://example.com/game?room=room_77&x=1")).toBe(77);
    expect(normalizeRoomCode("https://example.com/?ref=31")).toBe(31);
  });

  it("normalizeRoomCode：解析不出返回 null，不猜数字", () => {
    expect(normalizeRoomCode("")).toBeNull();
    expect(normalizeRoomCode("   ")).toBeNull();
    expect(normalizeRoomCode("abc")).toBeNull();
    expect(normalizeRoomCode("https://example.com/?foo=room_31")).toBeNull();
    expect(normalizeRoomCode("https://example.com/game")).toBeNull();
  });

  it("formatRoomRef：数字 id → 深链接引用（room_ 前缀锁定格式）", () => {
    expect(formatRoomRef(5)).toBe("room_5");
    // roundtrip：formatRoomRef 的输出可被 roomCodeToId 原样吃回。
    expect(roomCodeToId(formatRoomRef(42))).toBe(42);
  });
});

describe("棋盘坐标换算（boardGeometry / cellFromPoint）", () => {
  const cell = (480 - BOARD_MARGIN * 2) / 14;

  it("几何：15 路交点表 225 个，四角对齐 margin", () => {
    const geometry = boardGeometry(15);
    expect(geometry.points).toHaveLength(15 * 15);
    expect(geometry.cell).toBeCloseTo(cell);
    expect(geometry.points[0]).toEqual({ x: BOARD_MARGIN, y: BOARD_MARGIN });
    expect(geometry.points[224]).toEqual({ x: BOARD_MARGIN + 14 * cell, y: BOARD_MARGIN + 14 * cell });
  });

  it("非法棋盘尺寸：geometry 为空表、cellFromPoint 拒绝", () => {
    expect(boardGeometry(1).points).toHaveLength(0);
    expect(cellFromPoint(100, 100, 1)).toBeNull();
  });

  it("点击坐标吸附到最近交点；整格连续热区（格间不留死区，触控友好）", () => {
    const x = BOARD_MARGIN + 3 * cell;
    const y = BOARD_MARGIN + 3 * cell;
    expect(cellFromPoint(x, y, 15)).toEqual({ row: 3, col: 3 });
    expect(cellFromPoint(x + cell * 0.2, y - cell * 0.2, 15)).toEqual({ row: 3, col: 3 });
    // 半格之内吸附到本点；越过半格自动落到相邻点——格与格之间没有点不到的死区。
    expect(cellFromPoint(x + cell * 0.46, y, 15)).toEqual({ row: 3, col: 3 });
    expect(cellFromPoint(x + cell * 0.5, y, 15)).toEqual({ row: 3, col: 4 });
    expect(cellFromPoint(x + cell * 0.5, y - cell * 0.51, 15)).toEqual({ row: 2, col: 4 });
    // 外圈留白（棋盘木边）也吸附到最近的边线交点。
    expect(cellFromPoint(BOARD_MARGIN - 8, BOARD_MARGIN - 8, 15)).toEqual({ row: 0, col: 0 });
  });

  it("棋盘外（越界坐标）返回 null", () => {
    expect(cellFromPoint(-30, 100, 15)).toBeNull();
    expect(cellFromPoint(100, -30, 15)).toBeNull();
    expect(cellFromPoint(500, 100, 15)).toBeNull();
  });

  it("星位：15 路固定五点（天元 + 四星）", () => {
    expect(starPoints(15)).toEqual([
      { row: 3, col: 3 },
      { row: 3, col: 11 },
      { row: 11, col: 3 },
      { row: 11, col: 11 },
      { row: 7, col: 7 },
    ]);
    expect(starPoints(19)).toEqual([]);
  });
});

describe("落子本地预判（localMoveCheck）", () => {
  const board = emptyBoard();

  it("合法落点返回 null", () => {
    expect(localMoveCheck(board, 7, 7, "black", "black")).toBeNull();
    expect(localMoveCheck(board, 0, 0, "white", "white")).toBeNull();
  });

  it("没轮到/观战/占用/越界各自给出中文原因", () => {
    expect(localMoveCheck(board, 7, 7, "white", "black")).toBe("还没轮到你落子");
    expect(localMoveCheck(board, 7, 7, "black", null)).toBe("观战者不能落子");
    const occupied = board.map((line, row) => line.map((cell, col) => (row === 7 && col === 7 ? "white" : cell)));
    expect(localMoveCheck(occupied, 7, 7, "white", "white")).toBe("这个位置已经有棋子了");
    expect(localMoveCheck(board, 15, 0, "black", "black")).toBe("落点不在棋盘内");
    expect(localMoveCheck(board, 0, -1, "black", "black")).toBe("落点不在棋盘内");
  });
});

describe("倒计时格式化（formatCountdown）", () => {
  it("无时限（null/非数）原样返回 null", () => {
    expect(formatCountdown(null)).toBeNull();
    expect(formatCountdown(Number.NaN)).toBeNull();
  });

  it("毫秒 → 分:秒；到点与负数按 00:00 收口", () => {
    expect(formatCountdown(0)).toBe("00:00");
    expect(formatCountdown(-500)).toBe("00:00");
    expect(formatCountdown(59_499)).toBe("00:59");
    expect(formatCountdown(60_000)).toBe("01:00");
    expect(formatCountdown(3_661_000)).toBe("61:01");
    // 分钟封顶 99，异常长的时限不撑破布局。
    expect(formatCountdown(6_000_000)).toBe("99:00");
  });
});

describe("结算文案（describeSettlement）", () => {
  it("胜者视角/败者视角/观战者各归各文案", () => {
    expect(describeSettlement("win", "hash-a", "hash-a")).toEqual({
      headline: "你赢了！",
      detail: "五子连珠",
      tone: "win",
    });
    expect(describeSettlement("win", "hash-a", "hash-b")).toEqual({
      headline: "对方获胜",
      detail: "五子连珠",
      tone: "lose",
    });
    expect(describeSettlement("win", "hash-a", null)).toEqual({
      headline: "对局结束",
      detail: "五子连珠",
      tone: "neutral",
    });
  });

  it("超时/认输/平局/中止各有对应细节", () => {
    expect(describeSettlement("timeout", "hash-a", "hash-a")).toEqual({
      headline: "你赢了！",
      detail: "对方超时",
      tone: "win",
    });
    expect(describeSettlement("timeout", "hash-a", "hash-b")).toEqual({
      headline: "对方获胜",
      detail: "超时判负",
      tone: "lose",
    });
    expect(describeSettlement("resign", "hash-a", "hash-b")).toEqual({
      headline: "对方获胜",
      detail: "认输",
      tone: "lose",
    });
    expect(describeSettlement("resign", "hash-a", "hash-a").detail).toBe("对方认输");
    expect(describeSettlement("draw", null, "hash-a")).toEqual({
      headline: "平局",
      detail: "双方握手言和",
      tone: "draw",
    });
    expect(describeSettlement("aborted", null, "hash-a")).toEqual({
      headline: "对局结束",
      detail: "对局中止",
      tone: "neutral",
    });
  });
});

describe("视图收敛（parseGomokuView）", () => {
  function viewPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      boardSize: 15,
      board: emptyBoard(),
      turn: "black",
      players: [{ participantHash: "hash-a", color: "black" }],
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

  it("合法载荷完整收敛；缺 yourColor 的公开视图按观战处理", () => {
    const parsed = parseGomokuView(viewPayload());
    expect(parsed).not.toBeNull();
    expect(parsed?.boardSize).toBe(15);
    expect(parsed?.turn).toBe("black");
    expect(parsed?.players).toEqual([{ participantHash: "hash-a", color: "black" }]);
    expect(parsed?.yourColor).toBe("black");

    const spectator = parseGomokuView(viewPayload({ yourColor: undefined }));
    expect(spectator?.yourColor).toBeNull();
  });

  it("带最后一手/胜者连线/终局的载荷逐字段保留", () => {
    const board = emptyBoard();
    board[7]![7] = "black";
    const parsed = parseGomokuView(
      viewPayload({
        board,
        moveCount: 1,
        lastMove: { row: 7, col: 7, color: "black", participantHash: "hash-a" },
        winningLine: [{ row: 7, col: 7 }],
        outcome: { result: "win", winnerParticipantHash: "hash-a" },
        pendingUndoFrom: "hash-a",
      }),
    );
    expect(parsed?.lastMove).toEqual({ row: 7, col: 7, color: "black", participantHash: "hash-a" });
    expect(parsed?.winningLine).toEqual([{ row: 7, col: 7 }]);
    expect(parsed?.outcome).toEqual({ result: "win", winnerParticipantHash: "hash-a" });
    expect(parsed?.pendingUndoFrom).toBe("hash-a");
    expect(parsed?.moveCount).toBe(1);
  });

  it("board/turn 形状不对整包拒绝（渲染硬前提）", () => {
    expect(parseGomokuView(null)).toBeNull();
    expect(parseGomokuView(42)).toBeNull();
    expect(parseGomokuView(viewPayload({ boardSize: 14 }))).toBeNull();
    expect(parseGomokuView(viewPayload({ board: emptyBoard(14) }))).toBeNull();
    // 行长不等于 boardSize 同样拒绝。
    expect(parseGomokuView(viewPayload({ board: emptyBoard().map((line) => line.slice(1)) }))).toBeNull();
    expect(parseGomokuView(viewPayload({ turn: "green" }))).toBeNull();
    // 脏棋子值整包拒绝。
    const dirty = emptyBoard();
    dirty[0]![0] = "red" as never;
    expect(parseGomokuView(viewPayload({ board: dirty }))).toBeNull();
  });

  it("非关键字段缺失/形状不对时给中性默认值，不整包拒绝", () => {
    const parsed = parseGomokuView(
      viewPayload({ players: "junk", lastMove: "junk", winningLine: "junk", outcome: "junk", moveCount: "junk" }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.players).toEqual([]);
    expect(parsed?.lastMove).toBeNull();
    expect(parsed?.winningLine).toBeNull();
    expect(parsed?.outcome).toBeNull();
    expect(parsed?.moveCount).toBe(0);
  });
});

describe("倒计时紧迫度（countdownTone）", () => {
  it("无时限（null/非数）恒为 normal，不进告警分支", () => {
    expect(countdownTone(null)).toBe("normal");
    expect(countdownTone(Number.NaN)).toBe("normal");
  });

  it("剩 ≤10s 转 urgent、到点/负数转 expired、其余 normal", () => {
    expect(countdownTone(60_000)).toBe("normal");
    expect(countdownTone(10_001)).toBe("normal");
    expect(countdownTone(10_000)).toBe("urgent");
    expect(countdownTone(9_999)).toBe("urgent");
    expect(countdownTone(1)).toBe("urgent");
    expect(countdownTone(0)).toBe("expired");
    expect(countdownTone(-500)).toBe("expired");
  });
});

describe("错误码中文映射（gameErrorText）", () => {
  it("协议码全集逐个有中文文案，不裸抛英文码", () => {
    for (const code of GAME_PROTOCOL_ERROR_CODES) {
      const text = gameErrorText(code);
      expect(text, `错误码 ${code} 缺中文文案`).not.toBe("出了点问题，请稍后再试");
      expect(text).toMatch(/[\u4e00-\u9fff]/);
    }
  });

  it("REST/客户端兜底码（网络/限流/禁用/坏响应）也有文案", () => {
    for (const code of ["network_error", "rate_limited", "game_disabled", "game_room_error", "bad_response"]) {
      expect(gameErrorText(code)).toMatch(/[\u4e00-\u9fff]/);
    }
  });

  it("message 非空优先原文（服务端具体中文），message 缺失才按 code 映射", () => {
    expect(gameErrorText("not_your_turn", "还没轮到你落子")).toBe("还没轮到你落子");
    expect(gameErrorText("not_your_turn", "")).toBe("还没轮到你");
    expect(gameErrorText("not_your_turn", null)).toBe("还没轮到你");
  });

  it("未知码/空码落到通用兜底，不抛 undefined", () => {
    expect(gameErrorText("mystery_code")).toBe("出了点问题，请稍后再试");
    expect(gameErrorText(null)).toBe("出了点问题，请稍后再试");
    expect(gameErrorText(undefined)).toBe("出了点问题，请稍后再试");
    expect(gameErrorText("mystery_code", "  ")).toBe("出了点问题，请稍后再试");
  });
});

describe("对手掉线判定（opponentLikelyOffline）", () => {
  it("对局中在线玩家 < 2 判掉线风险；未收到 presence（null）不误报", () => {
    expect(opponentLikelyOffline("playing", 1)).toBe(true);
    expect(opponentLikelyOffline("playing", 0)).toBe(true);
    expect(opponentLikelyOffline("playing", 2)).toBe(false);
    expect(opponentLikelyOffline("playing", null)).toBe(false);
  });

  it("非对局状态（lobby/settled/closed）不提示", () => {
    expect(opponentLikelyOffline("lobby", 1)).toBe(false);
    expect(opponentLikelyOffline("settled", 1)).toBe(false);
    expect(opponentLikelyOffline("closed", 0)).toBe(false);
    expect(opponentLikelyOffline(null, 1)).toBe(false);
  });
});

describe("悔棋被拒判定（undoRejectedNotice）", () => {
  const me = "hash-me";

  it("上一帧我的申请在等待 → 下一帧消失且步数增加 = 对方落子顶掉申请", () => {
    expect(undoRejectedNotice(me, null, 5, 6, me)).toBe("对方落子了，你的悔棋申请已失效");
  });

  it("步数不变（同意悔棋棋盘回退）/ 申请仍在 / 不是我的申请 / 观战者：不提示", () => {
    // 同意悔棋：moveCount 减少，棋盘变化自解释。
    expect(undoRejectedNotice(me, null, 5, 4, me)).toBeNull();
    // 申请仍在等待（下一帧还有 pendingUndoFrom）。
    expect(undoRejectedNotice(me, me, 5, 6, me)).toBeNull();
    // 等待中的是别人的申请。
    expect(undoRejectedNotice("hash-other", null, 5, 6, me)).toBeNull();
    // 我没有身份（观战）。
    expect(undoRejectedNotice(me, null, 5, 6, null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 象棋（多人玩法批次 X1）：视图收敛 / 本地预判 / 结算文案 / 棋盘几何
// ---------------------------------------------------------------------------

import {
  XIANGQI_PIECE_CHARS,
  localXiangqiMoveCheck,
  parseXiangqiView,
  xiangqiCellFromPoint,
  xiangqiGeometry,
  xiangqiSettlementCopy,
} from "../../../admin/src/survey/game-room-logic";

/** 10 行 × 9 列空盘（与 xiangqiEngine.initialBoard 同构）。 */
function emptyXiangqiBoard(): Array<Array<string | null>> {
  return Array.from({ length: 10 }, () => Array<string | null>(9).fill(null));
}

describe("象棋视图收敛（parseXiangqiView）", () => {
  function viewPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      cols: 9,
      rows: 10,
      board: emptyXiangqiBoard(),
      turn: "red",
      players: [{ participantHash: "hash-a", color: "red" }],
      moveCount: 0,
      lastMove: null,
      check: null,
      outcome: null,
      pendingDrawFrom: null,
      yourColor: "red",
      ...overrides,
    };
  }

  it("合法载荷完整收敛；缺 yourColor 的公开视图按观战处理", () => {
    const parsed = parseXiangqiView(viewPayload());
    expect(parsed).not.toBeNull();
    expect(parsed?.cols).toBe(9);
    expect(parsed?.rows).toBe(10);
    expect(parsed?.turn).toBe("red");
    expect(parsed?.players).toEqual([{ participantHash: "hash-a", color: "red" }]);
    expect(parsed?.yourColor).toBe("red");

    const spectator = parseXiangqiView(viewPayload({ yourColor: undefined }));
    expect(spectator?.yourColor).toBeNull();
  });

  it("带最后一手/将军旗标/终局的载荷逐字段保留", () => {
    const board = emptyXiangqiBoard();
    board[6]![4] = null;
    board[5]![4] = "P";
    const parsed = parseXiangqiView(
      viewPayload({
        board,
        moveCount: 1,
        lastMove: {
          ply: 1,
          color: "red",
          from: { row: 6, col: 4 },
          to: { row: 5, col: 4 },
          piece: "P",
          captured: null,
          participantHash: "hash-a",
          givesCheck: false,
        },
        check: "black",
        outcome: { result: "win", winnerParticipantHash: "hash-a", reason: "checkmate" },
        pendingDrawFrom: "hash-a",
      }),
    );
    expect(parsed?.lastMove).toEqual({
      ply: 1,
      color: "red",
      from: { row: 6, col: 4 },
      to: { row: 5, col: 4 },
      piece: "P",
      captured: null,
      participantHash: "hash-a",
      givesCheck: false,
    });
    expect(parsed?.check).toBe("black");
    expect(parsed?.outcome).toEqual({ result: "win", winnerParticipantHash: "hash-a", reason: "checkmate" });
    expect(parsed?.pendingDrawFrom).toBe("hash-a");
  });

  it("board/turn/尺寸形状不对整包拒绝（渲染硬前提）", () => {
    expect(parseXiangqiView(null)).toBeNull();
    expect(parseXiangqiView(42)).toBeNull();
    expect(parseXiangqiView(viewPayload({ cols: 8 }))).toBeNull();
    expect(parseXiangqiView(viewPayload({ rows: 9 }))).toBeNull();
    expect(parseXiangqiView(viewPayload({ board: emptyXiangqiBoard().slice(1) }))).toBeNull();
    // 行长不等于 9 同样拒绝。
    expect(parseXiangqiView(viewPayload({ board: emptyXiangqiBoard().map((line) => line.slice(1)) }))).toBeNull();
    expect(parseXiangqiView(viewPayload({ turn: "green" }))).toBeNull();
    // 脏棋子码整包拒绝（合法码全集只有 14 个大小写字母）。
    const dirty = emptyXiangqiBoard();
    dirty[0]![0] = "X";
    expect(parseXiangqiView(viewPayload({ board: dirty }))).toBeNull();
  });

  it("非关键字段缺失/形状不对时给中性默认值，不整包拒绝", () => {
    const parsed = parseXiangqiView(
      viewPayload({ players: "junk", lastMove: "junk", outcome: "junk", moveCount: "junk" }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.players).toEqual([]);
    expect(parsed?.lastMove).toBeNull();
    expect(parsed?.outcome).toBeNull();
    expect(parsed?.moveCount).toBe(0);
    expect(parsed?.check).toBeNull();
  });
});

describe("象棋棋子汉字表（XIANGQI_PIECE_CHARS）", () => {
  it("14 个棋子码全部有汉字映射，红黑两套", () => {
    expect(XIANGQI_PIECE_CHARS).toEqual({
      K: "帥",
      A: "仕",
      E: "相",
      H: "傌",
      R: "俥",
      C: "炮",
      P: "兵",
      k: "將",
      a: "士",
      e: "象",
      h: "馬",
      r: "車",
      c: "砲",
      p: "卒",
    });
  });
});

describe("象棋走棋本地预判（localXiangqiMoveCheck）", () => {
  function parsedView(overrides: Record<string, unknown> = {}) {
    const board = emptyXiangqiBoard();
    board[6]![4] = "P"; // 红兵
    board[3]![4] = "p"; // 黑卒
    const payload = {
      cols: 9,
      rows: 10,
      board,
      turn: "red",
      players: [{ participantHash: "hash-a", color: "red" }],
      moveCount: 0,
      lastMove: null,
      check: null,
      outcome: null,
      pendingDrawFrom: null,
      yourColor: "red",
      ...overrides,
    };
    const parsed = parseXiangqiView(payload);
    if (!parsed) throw new Error("测试载荷必须是合法视图");
    return parsed;
  }

  it("观战者/未轮到/原地/空起点/对方棋子都被本地拦下", () => {
    const view = parsedView();
    expect(localXiangqiMoveCheck({ ...view, yourColor: null }, { row: 6, col: 4 }, { row: 5, col: 4 })).toBe(
      "观战者不能走棋",
    );
    expect(localXiangqiMoveCheck({ ...view, turn: "black" }, { row: 6, col: 4 }, { row: 5, col: 4 })).toBe(
      "还没轮到你走棋",
    );
    expect(localXiangqiMoveCheck(view, { row: 6, col: 4 }, { row: 6, col: 4 })).toBe("起点和终点不能相同");
    expect(localXiangqiMoveCheck(view, { row: 5, col: 5 }, { row: 4, col: 5 })).toBe("起点没有棋子");
    expect(localXiangqiMoveCheck(view, { row: 3, col: 4 }, { row: 4, col: 4 })).toBe("只能移动自己的棋子");
  });

  it("合法走子（红兵前进）本地放行（权威校验在服务端）", () => {
    expect(localXiangqiMoveCheck(parsedView(), { row: 6, col: 4 }, { row: 5, col: 4 })).toBeNull();
  });
});

describe("象棋结算文案（xiangqiSettlementCopy）", () => {
  it("将死/困毙/长将按 reason 细化 detail，其余沿用通用文案", () => {
    expect(xiangqiSettlementCopy("win", "hash-a", "hash-a", "checkmate")).toEqual({
      headline: "你赢了！",
      detail: "将死对方",
      tone: "win",
    });
    expect(xiangqiSettlementCopy("win", "hash-a", "hash-b", "checkmate").detail).toBe("被将死");
    expect(xiangqiSettlementCopy("win", "hash-a", "hash-b", "stalemate").detail).toBe("己方困毙（无子可动）");
    expect(xiangqiSettlementCopy("draw", null, "hash-a", "perpetual_check").detail).toBe("长将判和（连续重复局面）");
    // 其余 reason 沿用 describeSettlement 通用文案。
    expect(xiangqiSettlementCopy("timeout", "hash-b", "hash-a", "timeout")).toEqual({
      headline: "对方获胜",
      detail: "超时判负",
      tone: "lose",
    });
  });
});

describe("象棋棋盘几何（xiangqiGeometry / xiangqiCellFromPoint）", () => {
  it("交点表 10×9=90 个，边距与格距按视口推导", () => {
    const { cellX, cellY, points } = xiangqiGeometry();
    expect(points).toHaveLength(90);
    expect(cellX).toBe((468 - 28 * 2) / 8);
    expect(cellY).toBe((520 - 28 * 2) / 9);
    expect(points[0]).toEqual({ x: 28, y: 28 });
    expect(points[89]).toEqual({ x: 28 + 8 * cellX, y: 28 + 9 * cellY });
  });

  it("点击坐标吸附最近交点；网格之外返回 null", () => {
    expect(xiangqiCellFromPoint(28, 28)).toEqual({ row: 0, col: 0 });
    expect(xiangqiCellFromPoint(28 + 51.5, 28)).toEqual({ row: 0, col: 1 });
    // 吸附到最近交点：格内偏移仍归到最近交点。
    expect(xiangqiCellFromPoint(28, 28 + 40)).toEqual({ row: 1, col: 0 });
    // 交点网格之外（负行列 / 越过最后一行一列）返回 null。
    expect(xiangqiCellFromPoint(1, 1)).toBeNull();
    expect(xiangqiCellFromPoint(28, 520)).toBeNull();
    expect(xiangqiCellFromPoint(470, 28)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 象棋 X2 批次：legalMoves / history 收敛 + 触控热区连续化
// ---------------------------------------------------------------------------

describe("象棋视图收敛（X2 批次字段）", () => {
  function viewPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      cols: 9,
      rows: 10,
      board: emptyXiangqiBoard(),
      turn: "red",
      players: [{ participantHash: "hash-a", color: "red" }],
      moveCount: 1,
      lastMove: null,
      check: null,
      outcome: null,
      pendingDrawFrom: null,
      yourColor: "red",
      ...overrides,
    };
  }

  it("legalMoves/history 合法载荷逐条收敛；脏条目逐条丢弃，不整包拒绝", () => {
    const parsed = parseXiangqiView(
      viewPayload({
        legalMoves: [
          { from: { row: 7, col: 7 }, to: { row: 7, col: 4 } },
          { from: { row: 6, col: 4 }, to: { row: 5, col: 4 } },
          "junk",
          null,
          { from: { row: 0 }, to: { row: 7, col: 4 } }, // 缺 col：丢弃
        ],
        history: [
          {
            ply: 1,
            color: "red",
            from: { row: 7, col: 7 },
            to: { row: 7, col: 4 },
            piece: "C",
            captured: null,
            notation: "炮二平五",
            givesCheck: false,
          },
          "junk",
          { ply: 2, color: "green", from: { row: 0, col: 0 }, to: { row: 1, col: 1 }, piece: "k" }, // 坏颜色：丢弃
        ],
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.legalMoves).toEqual([
      { from: { row: 7, col: 7 }, to: { row: 7, col: 4 } },
      { from: { row: 6, col: 4 }, to: { row: 5, col: 4 } },
    ]);
    expect(parsed?.history).toEqual([
      {
        ply: 1,
        color: "red",
        from: { row: 7, col: 7 },
        to: { row: 7, col: 4 },
        piece: "C",
        captured: null,
        notation: "炮二平五",
        givesCheck: false,
      },
    ]);
  });

  it("缺 legalMoves/history 字段（旧部署）按空表处理，不整包拒绝", () => {
    const parsed = parseXiangqiView(viewPayload({ legalMoves: undefined, history: undefined }));
    expect(parsed).not.toBeNull();
    expect(parsed?.legalMoves).toEqual([]);
    expect(parsed?.history).toEqual([]);
    // 非数组同样给空表。
    const junk = parseXiangqiView(viewPayload({ legalMoves: "junk", history: 42 }));
    expect(junk?.legalMoves).toEqual([]);
    expect(junk?.history).toEqual([]);
  });
});

describe("象棋触控热区（xiangqiCellFromPoint 0.71 连续热区）", () => {
  it("格间中点与格角都命中最近交点，390px 视口下不再有死区", () => {
    const { cellX, cellY } = xiangqiGeometry();
    // 两交点正中间：归到最近交点（五子棋同款连续热区）。
    expect(xiangqiCellFromPoint(28 + cellX / 2, 28)).toEqual({ row: 0, col: 1 });
    // 格角（半格对角线处）：0.5 半径下是死区，0.71 后必命中。
    expect(xiangqiCellFromPoint(28 + cellX / 2, 28 + cellY / 2)).toEqual({ row: 1, col: 1 });
    // 0.71 ≥ 半格对角线（√2/2），网格内部全量覆盖：任意格内点都命中最近
    // 交点（拒绝只发生在网格之外），此处抽查远离原点的格内点。
    expect(xiangqiCellFromPoint(28 + cellX * 4.42, 28 + cellY * 5.43)).toEqual({ row: 5, col: 4 });
    // 网格之外照旧返回 null（负行列/越界）。
    expect(xiangqiCellFromPoint(1, 1)).toBeNull();
    expect(xiangqiCellFromPoint(28, 520)).toBeNull();
    expect(xiangqiCellFromPoint(470, 28)).toBeNull();
  });
});
