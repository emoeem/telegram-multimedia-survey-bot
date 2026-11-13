import type { GameEngine, GameGrade, GamePluginServer } from "../../types";
import { highLowManifest, highLowProps, type HighLowConfig } from "./manifest";

/**
 * 大小猜牌玩法的服务端引擎（权威判定）。
 *
 * 四条硬约束：
 *  1. 下一张牌只存在于服务端 state；视图只带当前牌与上一手的结果；
 *  2. 猜对按单次分值计分，连续对满 3 次额外加连击奖励；猜错即败局终局；
 *  3. 平局（同点数）按「不吃分不掉命」处理：推进轮次、保留连击；
 *  4. maxScore 是全部轮次都猜对且连击奖励拿满的理论上限，评级按比例算。
 */

/** 点数 1–13（A 到 K）；花色 0–3 只用于展示。 */
export interface HighLowCard {
  rank: number;
  suit: number;
}

export interface HighLowLast {
  direction: "up" | "down";
  prevRank: number;
  nextRank: number;
  /** hit = 猜对，miss = 猜错，tie = 平局。 */
  outcome: "hit" | "miss" | "tie";
  gained: number;
}

export interface HighLowState {
  card: HighLowCard;
  /** 已完成的猜牌次数（1 基：即将进行的是第 round 次猜测）。 */
  round: number;
  score: number;
  streak: number;
  bestStreak: number;
  last: HighLowLast | null;
  finished: boolean;
}

export interface HighLowAction {
  kind: "pick";
  direction: "up" | "down";
}

const RANKS = 13;

function drawCard(random: () => number): HighLowCard {
  return { rank: 1 + Math.floor(random() * RANKS), suit: Math.floor(random() * 4) };
}

function maxScoreOf(config: HighLowConfig): number {
  const bonusWindows = Math.floor(config.rounds / 3);
  return config.rounds * config.score + bonusWindows * config.streakBonus;
}

function asConfig(raw: Record<string, unknown>): HighLowConfig {
  return raw as unknown as HighLowConfig;
}

function viewOf(state: HighLowState, config: HighLowConfig) {
  return {
    status: state.finished
      ? state.last?.outcome === "miss"
        ? ("lost" as const)
        : ("won" as const)
      : ("active" as const),
    score: state.score,
    maxScore: maxScoreOf(config),
    step: Math.min(state.round, config.rounds),
    total: config.rounds,
    payload: {
      card: state.card,
      round: Math.min(state.round, config.rounds),
      rounds: config.rounds,
      streak: state.streak,
      bestStreak: state.bestStreak,
      last: state.last,
    },
  };
}

function gradeOf(state: HighLowState, config: HighLowConfig) {
  const maxScore = maxScoreOf(config);
  const ratio = maxScore === 0 ? 0 : state.score / maxScore;
  // 显式标 GameGrade：三元串不标注会被放宽成 string，喂不进 GameEngine.grade。
  const grade: GameGrade = ratio >= 0.9 ? "S" : ratio >= 0.7 ? "A" : ratio >= 0.5 ? "B" : "C";
  return { grade, maxScore };
}

export const highLowEngine: GameEngine<HighLowState, HighLowAction> = {
  createRun({ config, random }) {
    const cfg = asConfig(config);
    const state: HighLowState = {
      card: drawCard(random),
      round: 1,
      score: 0,
      streak: 0,
      bestStreak: 0,
      last: null,
      finished: false,
    };
    return { state, view: viewOf(state, cfg) };
  },

  apply({ state, config, action, random }) {
    const cfg = asConfig(config);
    if (state.finished) return { state, view: viewOf(state, cfg), finished: true };

    const next = drawCard(random);
    const correct = action.direction === "up" ? next.rank > state.card.rank : next.rank < state.card.rank;
    const tie = next.rank === state.card.rank;

    if (!correct && !tie) {
      // 猜错即终局；last 带出下一张牌，客户端可以做「就差一点」的回放。
      const last: HighLowLast = {
        direction: action.direction,
        prevRank: state.card.rank,
        nextRank: next.rank,
        outcome: "miss",
        gained: 0,
      };
      const next2: HighLowState = { ...state, last, finished: true };
      return { state: next2, view: viewOf(next2, cfg), finished: true };
    }

    const gained = correct ? cfg.score + ((state.streak + 1) % 3 === 0 ? cfg.streakBonus : 0) : 0;
    const streak = correct ? state.streak + 1 : state.streak;
    const last: HighLowLast = {
      direction: action.direction,
      prevRank: state.card.rank,
      nextRank: next.rank,
      outcome: tie ? "tie" : "hit",
      gained,
    };
    const round = state.round + 1;
    const done = round > cfg.rounds;
    const next2: HighLowState = {
      card: next,
      round,
      score: state.score + gained,
      streak,
      bestStreak: Math.max(state.bestStreak, streak),
      last,
      finished: done,
    };
    return { state: next2, view: viewOf(next2, cfg), finished: done };
  },

  grade({ state, config }) {
    return gradeOf(state, asConfig(config));
  },

  view({ state, config }) {
    return viewOf(state, asConfig(config));
  },

  isAction(value): value is HighLowAction {
    if (!value || typeof value !== "object") return false;
    const raw = value as Record<string, unknown>;
    return raw.kind === "pick" && (raw.direction === "up" || raw.direction === "down");
  },
};

/**
 * 服务端半身。引擎按 GameEngine<unknown, unknown> 收口；畸形 state 由
 * trial-plugin-api 的 try/catch 按「放弃」结算。
 */
export const highLowPlugin: GamePluginServer = {
  manifest: highLowManifest,
  props: highLowProps,
  engine: highLowEngine as unknown as GamePluginServer["engine"],
};
