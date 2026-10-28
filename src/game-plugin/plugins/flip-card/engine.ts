import type { GameEngine, GamePluginServer } from "../../types";
import { flipCardManifest, flipCardProps, type FlipCardConfig } from "./manifest";

/**
 * 答题翻牌的服务端引擎（权威计分）。
 *
 * 三条硬约束：
 *  1. 正确项只存在于这里读到的 config（options[0]），视图永不下发；
 *  2. 一题只记一次答案：重复提交幂等返回，不改变分数（断线重连安全）；
 *  3. 所有随机性走注入的 random()，同 seed 可复现（测试与重放）。
 */

export interface FlipCardState {
  /** 抽好的卡序（下标指向 config.cards）。 */
  order: number[];
  /** 当前该答第几张。 */
  cursor: number;
  /** 每张的作答下标；null = 未答。 */
  answers: Array<number | null>;
  score: number;
  maxScore: number;
}

export interface FlipCardAction {
  kind: "answer";
  optionIndex: number;
  /**
   * 客户端正在回答的第几张（0 基，等于当前 view.step - 1）。
   * 服务端据此识别"重发/重连"的旧提交：只有等于 state.cursor 才生效，
   * 否则原样返回——否则一次网络重试会把下一张卡也答掉。
   */
  step: number;
}

function isFinished(state: FlipCardState): boolean {
  return state.answers.every((answer) => answer !== null);
}

/** 输出给客户端的帧：只带当前卡面的可见字段（不含正确性）。 */
function viewOf(state: FlipCardState, config: FlipCardConfig) {
  const cardIndex = state.order[state.cursor];
  const card = cardIndex === undefined ? null : (config.cards[cardIndex] ?? null);
  const ratio = state.maxScore === 0 ? 0 : (state.score / state.maxScore) * 100;
  return {
    status: isFinished(state) ? (ratio >= config.passRatio ? ("won" as const) : ("lost" as const)) : ("active" as const),
    score: state.score,
    maxScore: state.maxScore,
    step: Math.min(state.cursor + 1, Math.max(1, state.order.length)),
    total: state.order.length,
    payload: {
      // 注意：这里永不输出 options[0] 的正确性标记。
      card: card
        ? { front: card.front, back: card.back, options: card.options.map((option) => option.label) }
        : null,
      cover: config.cover,
    },
  };
}

function asConfig(raw: Record<string, unknown>): FlipCardConfig {
  return raw as unknown as FlipCardConfig;
}

export const flipCardEngine: GameEngine<FlipCardState, FlipCardAction> = {
  createRun({ config, random }) {
    const cfg = asConfig(config);
    const order = cfg.cards.map((_, index) => index);
    if (cfg.shuffle) {
      for (let i = order.length - 1; i > 0; i -= 1) {
        const j = Math.floor(random() * (i + 1));
        const a = order[i]!;
        const b = order[j]!;
        order[i] = b;
        order[j] = a;
      }
    }
    const state: FlipCardState = {
      order,
      cursor: 0,
      answers: order.map(() => null),
      score: 0,
      maxScore: cfg.cards.reduce((sum, card) => sum + card.score, 0),
    };
    return { state, view: viewOf(state, cfg) };
  },

  apply({ state, config, action }) {
    const cfg = asConfig(config);
    const cardIndex = state.order[state.cursor];
    if (cardIndex === undefined) {
      return { state, view: viewOf(state, cfg), finished: true };
    }
    if (action.step !== state.cursor || state.answers[state.cursor] !== null) {
      // 幂等：同一张卡重复提交（网络重试/重连）不改变分数，也不推进指针。
      return { state, view: viewOf(state, cfg), finished: isFinished(state) };
    }
    const card = cfg.cards[cardIndex];
    if (!card) {
      return { state, view: viewOf(state, cfg), finished: true };
    }
    const optionIndex = Math.max(0, Math.min(card.options.length - 1, Math.round(action.optionIndex)));
    const answers = [...state.answers];
    answers[state.cursor] = optionIndex;
    const next: FlipCardState = {
      ...state,
      answers,
      cursor: state.cursor + 1,
      score: state.score + (optionIndex === 0 ? card.score : 0),
    };
    return { state: next, view: viewOf(next, cfg), finished: isFinished(next) };
  },

  grade({ state }) {
    const ratio = state.maxScore === 0 ? 0 : state.score / state.maxScore;
    const grade = ratio >= 0.9 ? "S" : ratio >= 0.7 ? "A" : ratio >= 0.5 ? "B" : "C";
    return { grade, maxScore: state.maxScore };
  },

  view({ state, config }) {
    return viewOf(state, asConfig(config));
  },

  isAction(value): value is FlipCardAction {
    if (!value || typeof value !== "object") return false;
    const raw = value as Record<string, unknown>;
    return (
      raw.kind === "answer" &&
      Number.isInteger(raw.optionIndex) &&
      Number(raw.optionIndex) >= 0 &&
      Number.isInteger(raw.step) &&
      Number(raw.step) >= 0
    );
  },
};

/**
 * 服务端半身。这里有一次边界类型断言：注册表按 GameEngine<unknown, unknown>
 * 收口（它不认识各插件的具体 state），而调用方（trial-api）拿到的就是
 * state_json 里的未知 JSON——所以断言发生在"反序列化边界"，并由 API 侧的
 * try/catch 把畸形 state 结算为放弃，不会把错形状传进引擎内部。
 */
export const flipCardPlugin: GamePluginServer = {
  manifest: flipCardManifest,
  props: flipCardProps,
  engine: flipCardEngine as unknown as GamePluginServer["engine"],
};
