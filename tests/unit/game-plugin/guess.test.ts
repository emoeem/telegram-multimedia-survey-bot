import { describe, expect, it } from "vitest";
import { guessEngine } from "../../../src/game-plugin/plugins/guess/engine";
import { guessProps } from "../../../src/game-plugin/plugins/guess/manifest";
import { normalizeConfig } from "../../../src/game-plugin/props";

/**
 * 猜数字引擎：谜底不泄露、区间外不扣机会、幂等、越早猜中分越高。
 */
function config(overrides: Record<string, unknown> = {}) {
  return normalizeConfig(guessProps, { rangeMin: 1, rangeMax: 100, attempts: 7, score: 20, ...overrides }) as Record<
    string,
    unknown
  >;
}

/** 恒定随机源：secret 落在已知值上。 */
function fixedRandom(value: number): () => number {
  return () => value;
}

/** 用 random 造一个 secret=50 的局。 */
function runWithSecret50() {
  // span = 100，secret = 1 + floor(0.4955... × 100) = 50
  return guessEngine.createRun({ config: config(), persona: "male", mode: "normal", random: fixedRandom(0.495) });
}

describe("guess engine · createRun", () => {
  it("初始视图带区间与机会数，但绝不带谜底", () => {
    const run = runWithSecret50();
    expect(run.view.status).toBe("active");
    expect(run.view.payload.range).toEqual([1, 100]);
    expect(run.view.payload.attemptsLeft).toBe(7);
    expect(run.view.payload.history).toEqual([]);
    expect(JSON.stringify(run.view)).not.toContain("secret");
    expect((run.state as { secret: number }).secret).toBe(50);
  });

  it("secret 始终落在配置区间内", () => {
    for (const seed of [0, 0.2, 0.5, 0.9, 0.9999]) {
      const run = guessEngine.createRun({
        config: config({ rangeMin: 10, rangeMax: 20 }),
        persona: "male",
        mode: "normal",
        random: fixedRandom(seed),
      });
      const secret = (run.state as { secret: number }).secret;
      expect(secret).toBeGreaterThanOrEqual(10);
      expect(secret).toBeLessThanOrEqual(20);
    }
  });
});

describe("guess engine · apply（提示与计分）", () => {
  it("小猜提示 up，大猜提示 down，按提交顺序入历史", () => {
    const initial = runWithSecret50();
    let state = initial.state;
    const first = guessEngine.apply({
      state,
      config: config(),
      action: { kind: "guess", value: 30 },
      random: Math.random,
    });
    state = first.state;
    expect(first.state.history).toEqual([{ value: 30, hint: "up" }]);
    expect(state.attemptsLeft).toBe(6);

    const second = guessEngine.apply({
      state,
      config: config(),
      action: { kind: "guess", value: 80 },
      random: Math.random,
    });
    state = second.state;
    expect(second.state.history[1]).toEqual({ value: 80, hint: "down" });
    expect(state.attemptsLeft).toBe(5);
  });

  it("猜中结算：按剩余机会比例计分并揭晓 secret", () => {
    const initial = runWithSecret50();
    const view = JSON.stringify(initial.view);
    expect(view).not.toContain("secret");
    // 一次猜中：20 × 7/7 = 20 分，评级 S。
    const hit = guessEngine.apply({
      state: initial.state,
      config: config(),
      action: { kind: "guess", value: 50 },
      random: Math.random,
    });
    expect(hit.finished).toBe(true);
    expect(hit.state.score).toBe(20);
    expect(hit.view.payload.secret).toBe(50);
    expect(hit.view.status).toBe("won");
    expect(guessEngine.grade({ state: hit.state, config: config() }).grade).toBe("S");
  });

  it("机会用尽即败局终局（C 级、0 分），同样揭晓谜底", () => {
    const initial = runWithSecret50();
    let state = initial.state;
    // 初始化即带 view：TS 据此推断 result 的完整类型，循环后才能断言 result.view。
    let result = { finished: false, state, view: initial.view };
    for (let i = 0; i < 7; i += 1) {
      result = guessEngine.apply({
        state,
        config: config(),
        action: { kind: "guess", value: i + 1 },
        random: Math.random,
      });
      state = result.state;
    }
    expect(result.finished).toBe(true);
    expect(state.score).toBe(0);
    expect(state.finished).toBe(true);
    expect(result.view.status).toBe("lost");
    expect(result.view.payload.secret).toBe(50);
  });

  it("区间外的猜测不扣机会、不推进（幂等）", () => {
    const initial = runWithSecret50();
    const tooLow = guessEngine.apply({
      state: initial.state,
      config: config(),
      action: { kind: "guess", value: 0 },
      random: Math.random,
    });
    expect(tooLow.state.attemptsLeft).toBe(7);
    expect(tooLow.state.history).toEqual([]);
    const tooHigh = guessEngine.apply({
      state: initial.state,
      config: config(),
      action: { kind: "guess", value: 101 },
      random: Math.random,
    });
    expect(tooHigh.state.attemptsLeft).toBe(7);
    expect(tooHigh.state.history).toEqual([]);
  });

  it("重复提交同一猜测不重复扣机会", () => {
    const initial = runWithSecret50();
    const first = guessEngine.apply({
      state: initial.state,
      config: config(),
      action: { kind: "guess", value: 30 },
      random: Math.random,
    });
    const second = guessEngine.apply({
      state: first.state,
      config: config(),
      action: { kind: "guess", value: 30 },
      random: Math.random,
    });
    expect(second.state.attemptsLeft).toBe(6);
    expect(second.state.history).toHaveLength(1);
  });
});

describe("guess engine · isAction", () => {
  it("只接受 {kind:'guess', value:整数}", () => {
    expect(guessEngine.isAction({ kind: "guess", value: 5 })).toBe(true);
    expect(guessEngine.isAction({ kind: "guess", value: 1.5 })).toBe(false);
    expect(guessEngine.isAction({ kind: "guess", value: "5" })).toBe(false);
    expect(guessEngine.isAction({ kind: "reveal", step: 0 })).toBe(false);
    expect(guessEngine.isAction("abandon")).toBe(false);
    expect(guessEngine.isAction(null)).toBe(false);
  });
});
