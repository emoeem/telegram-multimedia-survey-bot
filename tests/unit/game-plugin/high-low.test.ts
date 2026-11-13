import { describe, expect, it } from "vitest";
import { highLowEngine } from "../../../src/game-plugin/plugins/high-low/engine";
import { highLowProps } from "../../../src/game-plugin/plugins/high-low/manifest";
import { normalizeConfig } from "../../../src/game-plugin/props";

/**
 * 大小猜牌引擎：猜错即终局、平局不吃分不掉连击、连击奖励每 3 次一发。
 */
function config(overrides: Record<string, unknown> = {}) {
  return normalizeConfig(highLowProps, { rounds: 10, score: 3, streakBonus: 5, ...overrides }) as Record<
    string,
    unknown
  >;
}

/**
 * 脚本化随机源：奇数次调用返回牌面脚本值，偶数次返回花色。
 * drawCard 每次 drawCard() 调两次 random（先 rank 后 suit）。
 */
function scriptedRandom(ranks: number[]): () => number {
  const queue: number[] = [];
  for (const rank of ranks) {
    queue.push((rank - 1) / 13); // → floor(r × 13) = rank-1
    queue.push(0); // suit 固定 0
  }
  let index = 0;
  return () => {
    const value = queue[index % queue.length]!;
    index += 1;
    return value;
  };
}

function create(ranks: number[]) {
  return highLowEngine.createRun({ config: config(), persona: "male", mode: "normal", random: scriptedRandom(ranks) });
}

describe("high-low engine · createRun", () => {
  it("初始视图带当前牌与轮次，点数落在 1–13", () => {
    const run = create([7, 3]);
    expect(run.view.status).toBe("active");
    expect((run.view.payload.card as { rank: number }).rank).toBe(7);
    expect(run.view.payload.round).toBe(1);
    expect(run.view.payload.rounds).toBe(10);
    expect(run.view.payload.streak).toBe(0);
    expect(run.view.total).toBe(10);
  });
});

describe("high-low engine · apply（方向判定与计分）", () => {
  it("猜对（up）：下一张更大，计分并推进；视图带上一手结果", () => {
    const run = create([5, 9]);
    const pick = highLowEngine.apply({
      state: run.state,
      config: config(),
      action: { kind: "pick", direction: "up" },
      random: scriptedRandom([9]),
    });
    expect(pick.finished).toBe(false);
    expect(pick.state.score).toBe(3);
    expect(pick.state.streak).toBe(1);
    expect(pick.state.round).toBe(2);
    expect(pick.state.last).toMatchObject({ outcome: "hit", prevRank: 5, nextRank: 9, gained: 3 });
    expect((pick.view.payload.card as { rank: number }).rank).toBe(9);
  });

  it("猜错即败局终局（lost，0 分），last 带出下一张牌", () => {
    const run = create([9]);
    const pick = highLowEngine.apply({
      state: run.state,
      config: config(),
      action: { kind: "pick", direction: "up" },
      random: scriptedRandom([3]),
    });
    expect(pick.finished).toBe(true);
    expect(pick.state.score).toBe(0);
    expect(pick.view.status).toBe("lost");
    expect(pick.state.last).toMatchObject({ outcome: "miss", prevRank: 9, nextRank: 3 });
    expect(memoryChainGrade(pick.state)).toBe("C");
  });

  function memoryChainGrade(state: unknown): string {
    return highLowEngine.grade({ state: state as never, config: config() }).grade;
  }

  it("平局不吃分不掉命：round 推进、连击保留", () => {
    const run = create([7]);
    const pick = highLowEngine.apply({
      state: run.state,
      config: config(),
      action: { kind: "pick", direction: "up" },
      random: scriptedRandom([7]),
    });
    expect(pick.finished).toBe(false);
    expect(pick.state.score).toBe(0);
    expect(pick.state.streak).toBe(0);
    expect(pick.state.round).toBe(2);
    expect(pick.state.last).toMatchObject({ outcome: "tie", prevRank: 7, nextRank: 7 });
  });

  it("连击奖励：连续第 3、6 次猜对时额外加分", () => {
    // 初始牌 5，之后牌面递增（8→9→10→11→12→13），每手都猜 up 全对。
    const run = create([5]);
    const ups = scriptedRandom([8, 9, 10, 11, 12, 13]);
    let state = run.state;
    let last = { finished: false, state };
    for (let i = 0; i < 6; i += 1) {
      last = highLowEngine.apply({
        state,
        config: config(),
        action: { kind: "pick", direction: "up" },
        random: ups,
      });
      state = last.state;
    }
    // 每次基础 3 分；第 3、6 次各 +5 连击奖励。
    expect(state.score).toBe(6 * 3 + 2 * 5);
    expect(state.bestStreak).toBe(6);
    // 10 轮只猜了 6 次，还未终局。
    expect(last.finished).toBe(false);
  });

  it("全部轮次走完且未猜错即通关（won）", () => {
    const run = create([5]);
    let state = run.state;
    let last = { finished: false, state, view: run.view };
    for (let i = 0; i < 10; i += 1) {
      last = highLowEngine.apply({
        state,
        config: config(),
        action: { kind: "pick", direction: "up" },
        random: scriptedRandom([6]),
      });
      state = last.state;
    }
    expect(last.finished).toBe(true);
    expect(last.view.status).toBe("won");
    expect(state.round).toBe(11);
  });

  it("终局后重复 apply 是幂等空转", () => {
    const run = create([9]);
    const miss = highLowEngine.apply({
      state: run.state,
      config: config(),
      action: { kind: "pick", direction: "up" },
      random: scriptedRandom([3]),
    });
    const again = highLowEngine.apply({
      state: miss.state,
      config: config(),
      action: { kind: "pick", direction: "down" },
      random: scriptedRandom([2]),
    });
    expect(again.state.score).toBe(0);
    expect(again.state.last).toEqual(miss.state.last);
  });
});

describe("high-low engine · isAction", () => {
  it("只接受 {kind:'pick', direction:'up'|'down'}", () => {
    expect(highLowEngine.isAction({ kind: "pick", direction: "up" })).toBe(true);
    expect(highLowEngine.isAction({ kind: "pick", direction: "down" })).toBe(true);
    expect(highLowEngine.isAction({ kind: "pick", direction: "left" })).toBe(false);
    expect(highLowEngine.isAction({ kind: "pick" })).toBe(false);
    expect(highLowEngine.isAction({ kind: "ready" })).toBe(false);
  });
});
