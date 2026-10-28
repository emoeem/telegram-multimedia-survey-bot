import { describe, expect, it } from "vitest";
import {
  gameTypeLabel,
  isPluginGameType,
  listGameTypes,
  normalizeGameType,
} from "../../../src/trial/engine-registry";

/**
 * 玩法类型清单：内置爬塔 + 已注册插件。
 *
 * 这份测试同时是「插件登记没漏」的守卫：flip-card 在 server-plugins.ts 里
 * 注册后，normalizeGameType 必须立刻认它——否则新建的包存在却开不了局。
 */
describe("engine-registry（玩法类型清单）", () => {
  it("内置爬塔始终在列且被标记为 builtin", () => {
    const tower = listGameTypes().find((type) => type.id === "tower");
    expect(tower).toBeTruthy();
    expect(tower?.builtin).toBe(true);
    expect(normalizeGameType("tower")).toBe("tower");
    expect(isPluginGameType("tower")).toBe(false);
  });

  it("已注册插件自动出现在清单里（无需改注册表代码）", () => {
    const flip = listGameTypes().find((type) => type.id === "flip-card");
    expect(flip).toBeTruthy();
    expect(flip?.builtin).toBe(false);
    expect(flip?.label).toBe("答题翻牌");
    expect(normalizeGameType("flip-card")).toBe("flip-card");
    expect(isPluginGameType("flip-card")).toBe(true);
  });

  it("未知玩法被归一化为 null，展示名回落到爬塔", () => {
    expect(normalizeGameType("quiz")).toBeNull();
    expect(normalizeGameType("")).toBeNull();
    expect(normalizeGameType(42)).toBeNull();
    expect(gameTypeLabel("mystery")).toBe("爬塔挑战");
    expect(gameTypeLabel("flip-card")).toBe("答题翻牌");
  });
});
