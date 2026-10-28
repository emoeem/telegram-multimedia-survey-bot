import { describe, expect, it } from "vitest";
import { flipCardEngine, type FlipCardState } from "../../../src/game-plugin/plugins/flip-card/engine";
import { flipCardProps, type FlipCardConfig } from "../../../src/game-plugin/plugins/flip-card/manifest";
import { normalizeConfig } from "../../../src/game-plugin/props";

function config(overrides: Partial<FlipCardConfig> = {}): Record<string, unknown> {
  const base: FlipCardConfig = {
    cards: [
      { front: "1+1", back: "2", options: [{ label: "2" }, { label: "3" }], score: 5 },
      { front: "2+2", back: "4", options: [{ label: "4" }, { label: "5" }], score: 5 },
    ],
    shuffle: false,
    passRatio: 50,
    cover: null,
  };
  return { ...base, ...overrides } as unknown as Record<string, unknown>;
}

const seq = (values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length]!;
};

/** 按顺序答题：step 跟随 cursor（模拟真实客户端每次都提交当前步）。 */
function answerAll(cfg: Record<string, unknown>, answers: number[]): FlipCardState {
  let { state } = flipCardEngine.createRun({ config: cfg, persona: "male", mode: "normal", random: seq([0]) });
  for (const optionIndex of answers) {
    state = flipCardEngine.apply({
      state,
      config: cfg,
      action: { kind: "answer", optionIndex, step: state.cursor },
      random: seq([0]),
    }).state;
  }
  return state;
}

describe("flip-card engine", () => {
  it("开局：卡序、进度、上限分数", () => {
    const { state, view } = flipCardEngine.createRun({
      config: config(),
      persona: "male",
      mode: "normal",
      random: seq([0]),
    });
    expect(state.order).toEqual([0, 1]);
    expect(state.score).toBe(0);
    expect(state.maxScore).toBe(10);
    expect(view).toMatchObject({ status: "active", step: 1, total: 2, score: 0 });
  });

  it("视图不含正确性信息（只有选项文案）", () => {
    const { view } = flipCardEngine.createRun({ config: config(), persona: "male", mode: "normal", random: seq([0]) });
    const card = view.payload.card as { front: string; back: string; options: string[] };
    expect(card.options).toEqual(["2", "3"]);
    expect(JSON.stringify(view)).not.toContain("correct");
  });

  it("答对加分、答错不加，推进到下一张", () => {
    const run = flipCardEngine.createRun({ config: config(), persona: "male", mode: "normal", random: seq([0]) });
    const right = flipCardEngine.apply({
      state: run.state,
      config: config(),
      action: { kind: "answer", optionIndex: 0, step: 0 },
      random: seq([0]),
    });
    expect(right.view.score).toBe(5);
    expect(right.view.step).toBe(2);
    expect(right.finished).toBe(false);
    const wrong = flipCardEngine.apply({
      state: right.state,
      config: config(),
      action: { kind: "answer", optionIndex: 1, step: 1 },
      random: seq([0]),
    });
    expect(wrong.view.score).toBe(5);
    expect(wrong.finished).toBe(true);
  });

  it("陈旧 step 的提交被忽略（网络重试不会把下一张也答掉）", () => {
    const run = flipCardEngine.createRun({ config: config(), persona: "male", mode: "normal", random: seq([0]) });
    const first = flipCardEngine.apply({
      state: run.state,
      config: config(),
      action: { kind: "answer", optionIndex: 0, step: 0 },
      random: seq([0]),
    });
    // 客户端重发同一条（step 仍是 0），服务端已推进到 cursor=1
    const replay = flipCardEngine.apply({
      state: first.state,
      config: config(),
      action: { kind: "answer", optionIndex: 0, step: 0 },
      random: seq([0]),
    });
    expect(replay.state.score).toBe(5);
    expect(replay.state.cursor).toBe(1);
    expect(replay.finished).toBe(false);
  });

  it("全对 → won + S；全错 → lost + C", () => {
    const win = answerAll(config(), [0, 0]);
    expect(flipCardEngine.view({ state: win, config: config() }).status).toBe("won");
    expect(flipCardEngine.grade({ state: win, config: config() }).grade).toBe("S");

    const lose = answerAll(config(), [1, 1]);
    expect(flipCardEngine.view({ state: lose, config: config() }).status).toBe("lost");
    expect(flipCardEngine.grade({ state: lose, config: config() }).grade).toBe("C");
  });

  it("通关线可配：全对在 passRatio=100 时仍判 won", () => {
    const cfg = config({ passRatio: 100 });
    const state = answerAll(cfg, [0, 0]);
    expect(flipCardEngine.view({ state, config: cfg }).status).toBe("won");
  });

  it("确定性随机：同 seed 同卡序", () => {
    const mk = () =>
      flipCardEngine.createRun({
        config: config({ shuffle: true }),
        persona: "male",
        mode: "normal",
        random: seq([0.3, 0.8]),
      }).state;
    expect(mk().order).toEqual(mk().order);
  });

  it("isAction 只认 answer + 整数下标 + 整数 step", () => {
    expect(flipCardEngine.isAction({ kind: "answer", optionIndex: 1, step: 0 })).toBe(true);
    expect(flipCardEngine.isAction({ kind: "answer", optionIndex: -1, step: 0 })).toBe(false);
    expect(flipCardEngine.isAction({ kind: "answer", optionIndex: 0 })).toBe(false);
    expect(flipCardEngine.isAction({ kind: "skip", step: 0 })).toBe(false);
    expect(flipCardEngine.isAction(null)).toBe(false);
  });

  it("越界选项被夹到合法区间（不崩、不白送分）", () => {
    const run = flipCardEngine.createRun({ config: config(), persona: "male", mode: "normal", random: seq([0]) });
    const out = flipCardEngine.apply({
      state: run.state,
      config: config(),
      action: { kind: "answer", optionIndex: 99, step: 0 },
      random: seq([0]),
    });
    expect(out.view.score).toBe(0);
  });

  it("属性 Schema 归一化后的空配置不会让引擎崩", () => {
    const empty = normalizeConfig(flipCardProps, {});
    const created = flipCardEngine.createRun({ config: empty, persona: "male", mode: "normal", random: seq([0]) });
    expect(created.view.total).toBe(0);
    const after = flipCardEngine.apply({
      state: created.state,
      config: empty,
      action: { kind: "answer", optionIndex: 0, step: 0 },
      random: seq([0]),
    });
    expect(after.finished).toBe(true);
  });
});
