import { describe, expect, it } from "vitest";

import {
  FALLBACK_GAME_TYPES,
  activeRoomPlayers,
  allRoomPlayersReady,
  canStartMatch,
  findGameType,
  gameEntryHref,
  isRoomPlayerReady,
  lobbyPlayersHint,
  parseGameTypes,
  playerRowLabel,
  playerRowState,
  type RoomPlayerRow,
} from "../../../admin/src/survey/game-lobby-logic";

/**
 * 大厅层纯逻辑单测（Lobby/Board 分层批次）。
 *
 * Lobby 完全 gameType 无关：这里的断言也只用信封玩家行与玩法元数据，
 * 不出现任何具体玩法的载荷形状。
 */

function row(overrides: Partial<RoomPlayerRow> & { participantHash: string }): RoomPlayerRow {
  // 信封玩家行是 Pick 出来的子集（无 joinedAt）；ready 只在玩家视图行有，
  // 测试统一带上、由被测函数按 in 判定。
  return {
    displayName: null,
    isHost: false,
    ready: false,
    leftAt: null,
    ...overrides,
  } as RoomPlayerRow;
}

describe("在座玩家与准备态（activeRoomPlayers / isRoomPlayerReady / allRoomPlayersReady）", () => {
  it("activeRoomPlayers 过滤掉已离座行；players 缺失/为 null 时给空表（坏帧不白屏）", () => {
    const players = [row({ participantHash: "a" }), row({ participantHash: "b", leftAt: "2026-01-01T01:00:00.000Z" })];
    expect(activeRoomPlayers(players).map((player) => player.participantHash)).toEqual(["a"]);
    expect(activeRoomPlayers(undefined)).toEqual([]);
    expect(activeRoomPlayers(null)).toEqual([]);
  });

  it("isRoomPlayerReady：玩家行取 ready 字段，观战行（无 ready）按未准备", () => {
    expect(isRoomPlayerReady(row({ participantHash: "a", ready: true }))).toBe(true);
    const spectatorRow = {
      participantHash: "b",
      displayName: null,
      isHost: false,
      joinedAt: "",
      leftAt: null,
    } as RoomPlayerRow;
    expect(isRoomPlayerReady(spectatorRow)).toBe(false);
  });

  it("allRoomPlayersReady：全员已准备才为真，空表恒 false（没人谈不上全员）", () => {
    expect(allRoomPlayersReady([])).toBe(false);
    expect(allRoomPlayersReady([row({ participantHash: "a", ready: true })])).toBe(true);
    expect(allRoomPlayersReady([row({ participantHash: "a", ready: true }), row({ participantHash: "b" })])).toBe(
      false,
    );
  });
});

describe("玩家行文案（playerRowLabel / playerRowState）", () => {
  it("label：displayName trim 优先，缺名按序号兜底（玩家1/玩家2）", () => {
    expect(playerRowLabel(row({ participantHash: "a", displayName: " 阿明 " }), 0)).toBe("阿明");
    expect(playerRowLabel(row({ participantHash: "a", displayName: "   " }), 0)).toBe("玩家1");
    expect(playerRowLabel(row({ participantHash: "b" }), 1)).toBe("玩家2");
  });

  it("state：未入座/离座/房主/lobby 准备态/开局后各归各文案", () => {
    expect(playerRowState(null, "lobby")).toBe("等待加入…");
    expect(playerRowState(row({ participantHash: "b", leftAt: "x" }), "lobby")).toBe("已离开房间");
    expect(playerRowState(row({ participantHash: "a", isHost: true, ready: true }), "lobby")).toBe("房主 · 已准备");
    expect(playerRowState(row({ participantHash: "b", ready: false }), "lobby")).toBe("玩家 · 未准备");
    // 开局后不再显示准备态（对局中「准备」没有语义）。
    expect(playerRowState(row({ participantHash: "a", isHost: true }), "playing")).toBe("房主");
    expect(playerRowState(row({ participantHash: "b" }), "settled")).toBe("玩家");
  });
});

describe("开局可用性与提示（canStartMatch / lobbyPlayersHint）", () => {
  it("canStartMatch：未全员准备恒 false；人数达到玩法下限才可开局", () => {
    expect(canStartMatch(2, false, 2)).toBe(false);
    expect(canStartMatch(1, true, 2)).toBe(false);
    expect(canStartMatch(2, true, 2)).toBe(true);
    // 未知玩法（minPlayers=null）：只要求全员已准备，人数门槛交给服务端引擎。
    expect(canStartMatch(1, true, null)).toBe(true);
  });

  it("lobbyPlayersHint：人数未到/全员已准备/待准备三态文案，不出现具体玩法名", () => {
    expect(lobbyPlayersHint(1, false, 2)).toContain("把房间码发给好友");
    expect(lobbyPlayersHint(2, true, 2)).toContain("房主可以开局");
    expect(lobbyPlayersHint(2, false, 2)).toContain("准备");
    // 未知玩法下限（null）：不进「人数未到」分支。
    expect(lobbyPlayersHint(1, false, null)).not.toContain("把房间码发给好友");
  });
});

describe("玩法列表收敛（parseGameTypes / findGameType）", () => {
  const validPayload = {
    ok: true,
    games: [
      { name: "gomoku", displayName: "五子棋", description: "黑白轮流落子", minPlayers: 2, maxPlayers: 2 },
      { name: "werewolf", displayName: "", description: null, minPlayers: "6", maxPlayers: 0 },
    ],
  };

  it("合法响应收敛成条目列表；坏字段逐个给中性默认值", () => {
    const types = parseGameTypes(validPayload);
    expect(types).toEqual([
      { name: "gomoku", displayName: "五子棋", description: "黑白轮流落子", minPlayers: 2, maxPlayers: 2 },
      // displayName 空 → 回退 name；description 非字符串 → ""；人数非正整数 → null。
      { name: "werewolf", displayName: "werewolf", description: "", minPlayers: null, maxPlayers: null },
    ]);
  });

  it("gameType 键格式不对的条目剔除；整体形状不对/空列表返回 null（调用方走静态回退）", () => {
    expect(parseGameTypes({ games: [{ name: "Bad Type!" }, 42, null, { name: "gomoku" }] })).toEqual([
      { name: "gomoku", displayName: "gomoku", description: "", minPlayers: null, maxPlayers: null },
    ]);
    expect(parseGameTypes(null)).toBeNull();
    expect(parseGameTypes({ games: "nope" })).toBeNull();
    expect(parseGameTypes({})).toBeNull();
    expect(parseGameTypes({ games: [] })).toBeNull();
    expect(parseGameTypes({ games: [42] })).toBeNull();
  });

  it("findGameType：命中返回条目，未知玩法返回 null（走「即将上线」兜底）", () => {
    const types = FALLBACK_GAME_TYPES;
    expect(findGameType(types, "gomoku")).toEqual(types[0]);
    expect(findGameType(types, "chess")).toBeNull();
  });
});

describe("静态兜底与入口路由（FALLBACK_GAME_TYPES / gameEntryHref）", () => {
  it("兜底列表包含五子棋，人数元数据与引擎 meta 一致", () => {
    expect(FALLBACK_GAME_TYPES.length).toBeGreaterThanOrEqual(1);
    const gomoku = findGameType(FALLBACK_GAME_TYPES, "gomoku");
    expect(gomoku).not.toBeNull();
    expect(gomoku?.displayName).toBe("五子棋");
    expect(gomoku?.minPlayers).toBe(2);
    expect(gomoku?.maxPlayers).toBe(2);
  });

  it("gameEntryHref：五子棋锁定既有 /game 路径，新玩法带 ?type=，非法键回 /game", () => {
    expect(gameEntryHref("gomoku")).toBe("/game");
    expect(gameEntryHref("werewolf")).toBe("/game?type=werewolf");
    expect(gameEntryHref("Bad Type!")).toBe("/game");
    expect(gameEntryHref("../escape")).toBe("/game");
  });
});
