import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TRIAL_ADULT_CONFIRM_LABEL, trialAdultNoticeLines } from "../../../admin/src/survey/trial-adult-ack";

/**
 * 修复 3 的接线守护：18+ 徽标与门共用同一数据源（pack.adult），三处确认
 * （/trial 包卡弹层、/s 内嵌 GamePlayer、/s 内嵌 PluginGamePlay）文案统一。
 *
 * 仓库无 React DOM 测试环境（无 testing-library/jsdom），组件接线沿用
 * screen-help.test.ts 的静态源码断言先例；纯逻辑（文案常量、包级 adult 查询）
 * 直接跑行为断言。
 */

const trialApiSource = () => readFileSync(join(process.cwd(), "admin", "src", "survey", "trial-api.ts"), "utf8");
const trialScreenSource = () => readFileSync(join(process.cwd(), "admin", "src", "survey", "TrialScreen.tsx"), "utf8");
const gamePlayerSource = () => readFileSync(join(process.cwd(), "admin", "src", "survey", "GamePlayer.tsx"), "utf8");
const pluginPlaySource = () =>
  readFileSync(join(process.cwd(), "admin", "src", "survey", "PluginGamePlay.tsx"), "utf8");

describe("trialAdultNoticeLines / TRIAL_ADULT_CONFIRM_LABEL（三处确认的同一常量）", () => {
  it("警示正文含包名句、合规句与「确认仅对当前包生效」的包级记忆语义句", () => {
    const lines = trialAdultNoticeLines("K9 犬训 · 原典 200 题");
    expect(lines[0]).toContain("K9 犬训 · 原典 200 题");
    expect(lines[0]).toContain("18+ 成人向");
    expect(lines.join("\n")).toContain("确认仅对当前包生效");
    expect(lines.join("\n")).toContain("换一个包需要重新确认");
    // 包名为 null 时退化为通用句（/s 内嵌玩法拿不到包名）。
    const generic = trialAdultNoticeLines(null);
    expect(generic[0]).toContain("该小游戏");
    expect(generic).not.toContain("「null」");
  });

  it("确认按钮文案是单一份常量（三处共用，绝无第二份字面量）", () => {
    expect(TRIAL_ADULT_CONFIRM_LABEL).toBe("我已年满 18 周岁，同意进入");
    // /trial 弹层与 /s 门卡都引用常量，而不是各自硬编码按钮文案。
    expect(trialScreenSource()).toContain("TRIAL_ADULT_CONFIRM_LABEL");
    expect(gamePlayerSource()).toContain("TrialAdultGateCard");
    expect(pluginPlaySource()).toContain("TrialAdultGateCard");
    // 旧的两份硬编码按钮文案已被常量替换（修复 3 前的漂移源）。
    expect(trialScreenSource()).not.toContain("我已年满 18 周岁，开始");
    expect(gamePlayerSource()).not.toContain("我已年满 18 周岁，同意进入</");
    expect(pluginPlaySource()).not.toContain("该小游戏为虚构互动内容，请确认你已年满 18 周岁后开始。");
  });
});

describe("resolveTrialPackAdult（包级 adult 查询，模块级缓存）", () => {
  /** fetch 桩：返回 /api/trial/packs 形状的响应。 */
  function stubFetch(packs: Array<{ id: number; adult: boolean }>, fail = false): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        if (fail) throw new Error("network down");
        return {
          ok: true,
          json: async () => ({
            packs: packs.map((pack) => ({
              ...pack,
              name: `包${pack.id}`,
              gameType: "tower",
              gameLabel: "",
              normalFloors: 1,
              hellFloors: 1,
              prepItems: [],
              prepText: null,
              description: null,
              submissionBotUrl: null,
            })),
          }),
        } as unknown as Response;
      }),
    );
  }

  beforeEach(() => {
    vi.resetModules(); // 模块级缓存按用例隔离
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("返回该包的 adult 标志；一次会话只拉一遍包列表（多包零额外请求）", async () => {
    stubFetch([
      { id: 1, adult: true },
      { id: 2, adult: false },
    ]);
    const mod = await import("../../../admin/src/survey/trial-api");
    expect(await mod.resolveTrialPackAdult(1)).toBe(true);
    expect(await mod.resolveTrialPackAdult(2)).toBe(false);
    // 第二次查询走缓存：fetch 总调用次数仍为 1。
    await mod.resolveTrialPackAdult(1);
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
  });

  it("包不在列表 → null（调用方 fail-closed 弹门）", async () => {
    stubFetch([{ id: 1, adult: false }]);
    const mod = await import("../../../admin/src/survey/trial-api");
    expect(await mod.resolveTrialPackAdult(99)).toBeNull();
    expect(await mod.resolveTrialPackAdult(1)).toBe(false);
  });

  it("请求失败 → null 且清缓存重试（恢复后拿到真实标志）", async () => {
    stubFetch([], true);
    const mod = await import("../../../admin/src/survey/trial-api");
    expect(await mod.resolveTrialPackAdult(1)).toBeNull();
    stubFetch([{ id: 1, adult: true }]);
    expect(await mod.resolveTrialPackAdult(1)).toBe(true);
  });
});

describe("徽标与门同源（静态接线断言）", () => {
  it("/trial 卡面徽标严格渲染 pack.adult，开局门判定同一字段", () => {
    const source = trialScreenSource();
    // 徽标：pack.adult 是唯一判定（无其它 "18+" 徽标来源）。
    expect(source).toMatch(/\{pack\.adult \? \(/);
    // 开局第一道闸与 451 自愈都以 targetPack.adult 为准。
    expect(source).toContain("if (targetPack?.adult && !isAdultPackAckedLocally(effective.packId))");
    expect(source).toContain("...(targetPack?.adult ? { adultAck: true } : {})");
    expect(source).toContain('code === "adult_ack_required"');
    // 全文件只有一处徽标渲染（卡面，pack.adult 三元）：没有第二份写死的
    // 18+ 角标或页级门（0106 已下沉，修复 3 后不得回潮）。
    expect(source.match(/\{pack\.adult \? \(/g) ?? []).toHaveLength(1);
  });

  it("/s 内嵌 GamePlayer/PluginGamePlay 按 pack.adult 分支弹门（adult=false 永不弹）", () => {
    const player = gamePlayerSource();
    expect(player).toContain("resolveTrialPackAdult");
    expect(player).toContain('if (packAdult === false) return "setup";');
    expect(player).toContain('isAdultPackAckedLocally(packId) ? "setup" : "gate"');
    const plugin = pluginPlaySource();
    expect(plugin).toContain("resolveTrialPackAdult");
    expect(plugin).toContain("if (packAdult !== false && !adultAck)");
    // 两处都不再携带手写的 18+ 卡片 DOM（统一走 TrialAdultGateCard）。
    expect(player).not.toContain("18+ 成人向</b>");
    expect(plugin).not.toContain("虚构互动内容");
  });
});
