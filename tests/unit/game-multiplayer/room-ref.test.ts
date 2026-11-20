import { describe, expect, it } from "vitest";

import {
  clearGameEnginesForTest,
  listMultiplayerGameTypes,
  registerGameEngine,
  resolveGameEngine,
} from "../../../src/game/multiplayer/engine-registry";
import { GAME_ROOM_REF_PREFIX, gameRoomDOName, parseGameRoomRef } from "../../../src/game/multiplayer/engine-types";
import { stubEngine } from "../../helpers/game-engine-stub";

/**
 * 房间标识与深链接格式锁定测试（P0 批次 G1 复核修订）：
 * 自增数字 id 即房间唯一标识，深链接格式 `https://t.me/<bot>?startapp=room_<id>`
 * （room_ 前缀 + 数字 id），与 DO 实例名一一对应。G3 的生成器与 GameScreen
 * 消费本格式——这三条断言就是锁，改格式会在这里红。
 */
describe("房间标识锁定（room_<id>）", () => {
  it("gameRoomDOName：数字 id → room_<id>，与深链接 startapp 同源", () => {
    expect(GAME_ROOM_REF_PREFIX).toBe("room_");
    expect(gameRoomDOName(7)).toBe("room_7");
    expect(gameRoomDOName(12345)).toBe("room_12345");
    // `https://t.me/<bot>?startapp=` + gameRoomDOName(id) 即深链接全值。
    expect(`https://t.me/examplebot?startapp=${gameRoomDOName(42)}`).toBe("https://t.me/examplebot?startapp=room_42");
  });

  it("parseGameRoomRef：只接受 room_<正整数>，拒绝裸数字与任意串", () => {
    expect(parseGameRoomRef("room_7")).toBe(7);
    expect(parseGameRoomRef("room_0")).toBeNull();
    expect(parseGameRoomRef("room_-3")).toBeNull();
    expect(parseGameRoomRef("room_abc")).toBeNull();
    expect(parseGameRoomRef("17")).toBeNull(); // 裸数字：旧行为，明确不收
    expect(parseGameRoomRef("ROOM_7")).toBeNull();
    expect(parseGameRoomRef("room_7x")).toBeNull();
    expect(parseGameRoomRef("")).toBeNull();
  });

  it("parseGameRoomRef：只认规范十进制，Number() 能宽松解析的串一律拒绝", () => {
    // 回归：这些串过去会被 Number() 解析成另一个 id（room_1e3→1000 等），
    // 与 gameRoomDOName 的 canonical 形态不 roundtrip。
    for (const value of [
      "room_1e3",
      "room_1.0",
      "room_ 7",
      "room_+7",
      "room_07",
      "room_0x10",
      "room_9007199254740993", // 超出 safe integer，精度已丢
    ]) {
      expect(parseGameRoomRef(value), value).toBeNull();
    }
  });

  it("roundtrip：id → DO 名 → id 无损", () => {
    for (const id of [1, 9, 1000]) {
      expect(parseGameRoomRef(gameRoomDOName(id))).toBe(id);
    }
  });
});

describe("引擎注册表", () => {
  it("注册后可解析、未注册返回 null", () => {
    clearGameEnginesForTest();
    expect(resolveGameEngine("stub-guess")).toBeNull();
    registerGameEngine(stubEngine);
    expect(resolveGameEngine("stub-guess")).toBe(stubEngine);
    expect(listMultiplayerGameTypes()).toContain("stub-guess");
    // 重复注册以最后一次为准（测试桩可覆盖）。
    const override = { ...stubEngine, label: "覆盖版" };
    registerGameEngine(override);
    expect(resolveGameEngine("stub-guess")!.label).toBe("覆盖版");
    clearGameEnginesForTest();
  });
});
