import { describe, expect, it } from "vitest";
import {
  gameTypeLabel,
  isAdultGamePack,
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

  it("isAdultGamePack（0106 切分点）：爬塔读 adult 列，插件读清单 capabilities.adult", () => {
    // 爬塔：列值即判定（0106 默认 0 = 全年龄，管理员勾选才 18+）。
    expect(isAdultGamePack({ gameType: "tower", adult: false })).toBe(false);
    expect(isAdultGamePack({ gameType: "tower", adult: true })).toBe(true);
    // 插件：包行上的列值不参与判定，只看清单声明（quest=true、flip-card=false）。
    expect(isAdultGamePack({ gameType: "quest", adult: false })).toBe(true);
    expect(isAdultGamePack({ gameType: "flip-card", adult: true })).toBe(false);
    // 未知玩法按非 adult 处理（开局入口本来就拒绝未知玩法）。
    expect(isAdultGamePack({ gameType: "mystery", adult: true })).toBe(false);
  });
});
