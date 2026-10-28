import { describe, expect, it } from "vitest";
import { drawEngine } from "../../../src/game-plugin/plugins/draw/engine";
import { drawProps } from "../../../src/game-plugin/plugins/draw/manifest";
import { defaultConfig, normalizeConfig } from "../../../src/game-plugin/props";

/**
 * 抽取玩法引擎：确定性随机、幂等、不泄露未揭示结果、空奖池容错。
 * 奖池与权重只存在于 config；视图只发已揭示条目。
 */
function config(overrides: Record<string, unknown> = {}) {
  return normalizeConfig(drawProps, {
    items: [
      { label: "普通 A", weight: 10, rarity: "common", score: 2 },
      { label: "普通 B", weight: 10, rarity: "common", score: 4 },
      { label: "稀有 C", weight: 5, rarity: "rare", score: 8 },
      { label: "传说 D", weight: 1, rarity: "legendary", score: 20 },
    ],
    ...overrides,
  }) as Record<string, unknown>;
}

/** 可复现的随机源（mulberry32 风格简版）。 */
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

describe("draw engine · createRun", () => {
  it("按 drawCount 抽取且不放回；结果可由同 seed 复现", () => {
    const first = drawEngine.createRun({ config: config(), persona: "male", mode: "normal", random: seededRandom(42) });
    const second = drawEngine.createRun({ config: config(), persona: "male", mode: "normal", random: seededRandom(42) });
    expect(first.state.order).toHaveLength(3);
    expect(new Set(first.state.order).size).toBe(3);
    expect(first.state.order).toEqual(second.state.order);

    const other = drawEngine.createRun({ config: config(), persona: "male", mode: "normal", random: seededRandom(7) });
    expect(first.state.order).not.toEqual(other.state.order);
  });

  it("maxScore 是抽中条目分值之和；初始视图不泄露任何条目", () => {
    const run = drawEngine.createRun({ config: config(), persona: "male", mode: "normal", random: seededRandom(42) });
    const items = config().items as Array<{ score: number }>;
    const expected = run.state.order.reduce((sum, index) => sum + items[index]!.score, 0);
    expect(run.state.maxScore).toBe(expected);
    expect(run.view.payload.revealed).toEqual([]);
    expect(run.view.total).toBe(3);
    expect(JSON.stringify(run.view)).not.toContain("weight");
    expect(JSON.stringify(run.view)).not.toContain("传说 D");
  });
});

describe("draw engine · apply（幂等与揭示）", () => {
  it("reveal 推进指针并累加分数；视图逐张带出已揭示条目", () => {
    const initial = drawEngine.createRun({ config: config(), persona: "male", mode: "normal", random: seededRandom(42) });
    const items = config().items as Array<{ label: string; score: number }>;
    let state = initial.state;
    for (let step = 0; step < 3; step += 1) {
      const result = drawEngine.apply({ state, config: config(), action: { kind: "reveal", step }, random: Math.random });
      state = result.state;
      expect(state.revealed).toBe(step + 1);
      expect(state.score).toBe(
        state.order.slice(0, step + 1).reduce((sum, index) => sum + items[index]!.score, 0),
      );
      const revealed = result.view.payload.revealed as Array<{ label: string }>;
      expect(revealed).toHaveLength(step + 1);
      expect(revealed[step]!.label).toBe(items[state.order[step]!]!.label);
      if (step < 2) expect(result.finished).toBe(false);
      else expect(result.finished).toBe(true);
    }
  });

  it("陈旧 step（网络重试）不推进指针、不重复计分", () => {
    const initial = drawEngine.createRun({ config: config(), persona: "male", mode: "normal", random: seededRandom(42) });
    const once = drawEngine.apply({ state: initial.state, config: config(), action: { kind: "reveal", step: 0 }, random: Math.random });
    const replay = drawEngine.apply({ state: once.state, config: config(), action: { kind: "reveal", step: 0 }, random: Math.random });
    const future = drawEngine.apply({ state: once.state, config: config(), action: { kind: "reveal", step: 5 }, random: Math.random });
    expect(replay.state.revealed).toBe(1);
    expect(replay.state.score).toBe(once.state.score);
    expect(future.state.revealed).toBe(1);
    expect(future.state.score).toBe(once.state.score);
  });

  it("isAction 只放行 reveal；未知动作拒绝", () => {
    expect(drawEngine.isAction({ kind: "reveal", step: 0 })).toBe(true);
    expect(drawEngine.isAction({ kind: "answer", optionIndex: 0, step: 0 })).toBe(false);
    expect(drawEngine.isAction({ kind: "reveal" })).toBe(false);
    expect(drawEngine.isAction(null)).toBe(false);
  });
});

describe("draw engine · 边界", () => {
  it("空奖池：total 0，立即结束，grade 兜底", () => {
    const empty = normalizeConfig(drawProps, { items: [], drawCount: 3 }) as Record<string, unknown>;
    const run = drawEngine.createRun({ config: empty, persona: "female", mode: "normal", random: Math.random });
    expect(run.state.order).toHaveLength(0);
    expect(run.view.total).toBe(0);
    expect(run.view.payload.remaining).toBe(0);
    const result = drawEngine.apply({ state: run.state, config: empty, action: { kind: "reveal", step: 0 }, random: Math.random });
    expect(result.finished).toBe(true);
    expect(drawEngine.grade({ state: run.state, config: empty }).grade).toBe("C");
  });

  it("drawCount 超过奖池大小时封顶；全 0 权重退化为不放回均匀抽取", () => {
    const big = drawEngine.createRun({
      config: config({ drawCount: 99 }),
      persona: "male",
      mode: "normal",
      random: seededRandom(1),
    });
    expect(big.state.order).toHaveLength(4);

    const zeroWeights = normalizeConfig(drawProps, {
      items: [
        { label: "A", weight: 0, rarity: "common", score: 1 },
        { label: "B", weight: 0, rarity: "common", score: 1 },
      ],
      drawCount: 2,
    }) as Record<string, unknown>;
    const run = drawEngine.createRun({ config: zeroWeights, persona: "male", mode: "normal", random: seededRandom(3) });
    expect(run.state.order).toHaveLength(2);
    expect(new Set(run.state.order).size).toBe(2);
  });

  it("defaultConfig 归一化补齐全部键", () => {
    const defaults = defaultConfig(drawProps) as Record<string, unknown>;
    expect(defaults.drawCount).toBe(3);
    expect(Array.isArray(defaults.items)).toBe(true);
    expect(defaults.cover).toBeNull();
  });
});
