import { describe, expect, it } from "vitest";
import { memoryChainEngine } from "../../../src/game-plugin/plugins/memory-chain/engine";
import { memoryChainProps } from "../../../src/game-plugin/plugins/memory-chain/manifest";
import { normalizeConfig } from "../../../src/game-plugin/props";

/**
 * 记忆序列引擎：复现阶段不下发序列、每轮加长一格、点错即终局、逐轮计分。
 */
function config(overrides: Record<string, unknown> = {}) {
  return normalizeConfig(memoryChainProps, {
    cells: 9,
    rounds: 3,
    startLength: 2,
    roundScore: 5,
    ...overrides,
  }) as Record<string, unknown>;
}

/** 可复现的随机源（与 draw.test.ts 同款简版 LCG）。 */
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function create() {
  return memoryChainEngine.createRun({ config: config(), persona: "male", mode: "normal", random: seededRandom(42) });
}

describe("memory-chain engine · createRun", () => {
  it("初始为展示阶段，序列长度 = startLength，且序列都在格子范围内", () => {
    const run = create();
    expect(run.view.payload.phase).toBe("show");
    expect(run.view.payload.round).toBe(1);
    expect(run.view.payload.rounds).toBe(3);
    const sequence = run.view.payload.sequence as number[];
    expect(sequence).toHaveLength(2);
    for (const cell of sequence) {
      expect(cell).toBeGreaterThanOrEqual(0);
      expect(cell).toBeLessThan(9);
    }
    expect(run.view.step).toBe(1);
    expect(run.view.total).toBe(3);
  });

  it("同 seed 可复现同一序列", () => {
    const first = create();
    const second = create();
    expect((first.state as { sequence: number[] }).sequence).toEqual((second.state as { sequence: number[] }).sequence);
  });
});

describe("memory-chain engine · apply（ready 与 press）", () => {
  it("ready 从展示切到复现；复现视图不再带序列，只带进度", () => {
    const run = create();
    const ready = memoryChainEngine.apply({
      state: run.state,
      config: config(),
      action: { kind: "ready" },
      random: seededRandom(1),
    });
    expect(ready.state.phase).toBe("input");
    expect(ready.view.payload.phase).toBe("input");
    expect(ready.view.payload.sequence).toBeUndefined();
    expect(ready.view.payload.progress).toBe(0);
    expect(ready.view.payload.length).toBe(2);
    expect(JSON.stringify(ready.view)).not.toContain("sequence");
  });

  it("按对推进进度；本轮走完计分并回到展示（序列加长一格）", () => {
    const run = create();
    const sequence = (run.state as { sequence: number[] }).sequence;
    let state = run.state;
    let applied = memoryChainEngine.apply({
      state,
      config: config(),
      action: { kind: "ready" },
      random: seededRandom(1),
    });
    state = applied.state;
    applied = memoryChainEngine.apply({
      state,
      config: config(),
      action: { kind: "press", index: sequence[0]! },
      random: seededRandom(1),
    });
    state = applied.state;
    expect(state.inputIndex).toBe(1);
    expect(state.score).toBe(0);
    applied = memoryChainEngine.apply({
      state,
      config: config(),
      action: { kind: "press", index: sequence[1]! },
      random: seededRandom(1),
    });
    state = applied.state;
    // 第 1 轮完成：5 × 1 = 5 分，进入第 2 轮展示，序列长度 3。
    expect(state.score).toBe(5);
    expect(state.round).toBe(2);
    expect(state.phase).toBe("show");
    expect((state.sequence as number[]).length).toBe(3);
    expect(applied.finished).toBe(false);
  });

  it("点错即败局终局，终局视图揭晓完整序列", () => {
    const run = create();
    const sequence = (run.state as { sequence: number[] }).sequence;
    const ready = memoryChainEngine.apply({
      state: run.state,
      config: config(),
      action: { kind: "ready" },
      random: seededRandom(1),
    });
    const wrong = sequence[0] === 0 ? 1 : 0;
    const miss = memoryChainEngine.apply({
      state: ready.state,
      config: config(),
      action: { kind: "press", index: wrong },
      random: seededRandom(1),
    });
    expect(miss.finished).toBe(true);
    expect(miss.state.score).toBe(0);
    expect(miss.view.status).toBe("lost");
    expect(miss.view.payload.phase).toBe("done");
    expect(miss.view.payload.sequence).toEqual(sequence);
    expect(memoryChainEngine.grade({ state: miss.state, config: config() }).grade).toBe("C");
  });

  it("全部轮次复现成功即通关（won，S 级，满分）", () => {
    const run = create();
    let state = run.state;
    let finished = false;
    // 3 轮，序列从 2 长到 4。
    for (let round = 0; round < 3; round += 1) {
      const ready = memoryChainEngine.apply({
        state,
        config: config(),
        action: { kind: "ready" },
        random: seededRandom(1),
      });
      state = ready.state;
      const visible = config().startLength as number;
      for (let step = 0; step < visible + round; step += 1) {
        const expected = (state.sequence as number[])[step]!;
        const applied = memoryChainEngine.apply({
          state,
          config: config(),
          action: { kind: "press", index: expected },
          random: seededRandom(1),
        });
        state = applied.state;
        finished = applied.finished;
      }
    }
    expect(finished).toBe(true);
    expect(state.score).toBe(5 * 1 + 5 * 2 + 5 * 3);
    expect(state.round).toBe(3);
    // 第 3 轮完成时 round 未再自增 → 视图 won。
    const finalView = memoryChainEngine.view({ state, config: config() });
    expect(finalView.status).toBe("won");
    expect(finalView.score).toBe(finalView.maxScore);
    expect(memoryChainEngine.grade({ state, config: config() }).grade).toBe("S");
  });

  it("复现阶段按非法格子不推进；展示阶段 press 不推进", () => {
    const run = create();
    const stalled = memoryChainEngine.apply({
      state: run.state,
      config: config(),
      action: { kind: "press", index: 99 },
      random: seededRandom(1),
    });
    expect(stalled.state.inputIndex).toBe(0);
    expect(stalled.state.phase).toBe("show");
    expect(stalled.state.score).toBe(0);
  });

  it("重复 ready 在复现阶段是幂等空转", () => {
    const run = create();
    const first = memoryChainEngine.apply({
      state: run.state,
      config: config(),
      action: { kind: "ready" },
      random: seededRandom(1),
    });
    const second = memoryChainEngine.apply({
      state: first.state,
      config: config(),
      action: { kind: "ready" },
      random: seededRandom(1),
    });
    expect(second.state.phase).toBe("input");
    expect(second.state.inputIndex).toBe(0);
  });
});

describe("memory-chain engine · isAction", () => {
  it("只接受 ready 与合法 press", () => {
    expect(memoryChainEngine.isAction({ kind: "ready" })).toBe(true);
    expect(memoryChainEngine.isAction({ kind: "press", index: 3 })).toBe(true);
    expect(memoryChainEngine.isAction({ kind: "press", index: -1 })).toBe(false);
    expect(memoryChainEngine.isAction({ kind: "press", index: 1.5 })).toBe(false);
    expect(memoryChainEngine.isAction({ kind: "guess", value: 1 })).toBe(false);
  });
});
