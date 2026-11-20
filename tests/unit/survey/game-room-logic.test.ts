import { describe, expect, it } from "vitest";

import {
  BOARD_MARGIN,
  boardGeometry,
  cellFromPoint,
  describeSettlement,
  formatCountdown,
  formatRoomRef,
  localMoveCheck,
  normalizeRoomCode,
  parseGomokuView,
  roomCodeToId,
  starPoints,
} from "../../../admin/src/survey/game-room-logic";

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

  it("点击坐标吸附到最近交点；0.45 格内算命中", () => {
    const x = BOARD_MARGIN + 3 * cell;
    const y = BOARD_MARGIN + 3 * cell;
    expect(cellFromPoint(x, y, 15)).toEqual({ row: 3, col: 3 });
    expect(cellFromPoint(x + cell * 0.2, y - cell * 0.2, 15)).toEqual({ row: 3, col: 3 });
    // 超过 0.45 格视为点空了。
    expect(cellFromPoint(x + cell * 0.46, y, 15)).toBeNull();
    expect(cellFromPoint(x + cell * 0.44, y, 15)).toEqual({ row: 3, col: 3 });
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
