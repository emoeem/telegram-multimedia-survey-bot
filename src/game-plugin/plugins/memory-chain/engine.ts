import type { GameEngine, GameGrade, GamePluginServer } from "../../types";
import { memoryChainManifest, memoryChainProps, type MemoryChainConfig } from "./manifest";

/**
 * 记忆序列玩法的服务端引擎（权威判定）。
 *
 * 四条硬约束：
 *  1. 序列只存在于服务端 state；复现阶段（phase="input"）的视图不下发序列，
 *     客户端没有可读的正确答案，按了什么只能由服务端判定；
 *  2. 展示阶段（phase="show"）带出当前轮完整序列供客户端动画，随后客户端
 *     发 ready 切到复现——就绪时机由客户端控制，但不影响判定与计分；
 *  3. 每轮序列恰好比上一轮长一格（追加），visible 长度 = startLength + round - 1；
 *  4. 点错即败局终局（并带出完整序列揭晓）；全部轮次完成即通关。
 */

export type MemoryChainPhase = "show" | "input";

export interface MemoryChainState {
  cells: number;
  /** 完整序列（下标指向 0..cells-1 的格子）；长度 = startLength + 已开启轮数 - 1。 */
  sequence: number[];
  /** 当前轮（1 基）。 */
  round: number;
  phase: MemoryChainPhase;
  /** 复现阶段已按对的数量（只在 phase="input" 时推进）。 */
  inputIndex: number;
  score: number;
  finished: boolean;
}

export type MemoryChainAction = { kind: "ready" } | { kind: "press"; index: number };

function asConfig(raw: Record<string, unknown>): MemoryChainConfig {
  return raw as unknown as MemoryChainConfig;
}

function maxScoreOf(config: MemoryChainConfig): number {
  let total = 0;
  for (let round = 1; round <= config.rounds; round += 1) total += config.roundScore * round;
  return total;
}

function viewOf(state: MemoryChainState, config: MemoryChainConfig) {
  const visibleLength = config.startLength + state.round - 1;
  const base = {
    score: state.score,
    maxScore: maxScoreOf(config),
    step: Math.min(state.round, config.rounds),
    total: config.rounds,
  };
  if (state.finished) {
    // 终局揭晓完整序列（client 拿它画失败回放）。
    return {
      ...base,
      status: (state.score >= maxScoreOf(config) ? ("won" as const) : ("lost" as const)) as "won" | "lost",
      payload: {
        phase: "done",
        cells: state.cells,
        round: state.round,
        rounds: config.rounds,
        sequence: state.sequence,
      },
    };
  }
  if (state.phase === "show") {
    return {
      ...base,
      status: "active" as const,
      payload: {
        phase: "show",
        cells: state.cells,
        round: state.round,
        rounds: config.rounds,
        sequence: state.sequence.slice(0, visibleLength),
      },
    };
  }
  // 复现阶段：绝不带出序列，只有进度。
  return {
    ...base,
    status: "active" as const,
    payload: {
      phase: "input",
      cells: state.cells,
      round: state.round,
      rounds: config.rounds,
      progress: state.inputIndex,
      length: visibleLength,
    },
  };
}

function gradeOf(state: MemoryChainState, config: MemoryChainConfig) {
  const maxScore = maxScoreOf(config);
  const ratio = maxScore === 0 ? 0 : state.score / maxScore;
  // 显式标 GameGrade：三元串不标注会被放宽成 string，喂不进 GameEngine.grade。
  const grade: GameGrade = ratio >= 0.9 ? "S" : ratio >= 0.7 ? "A" : ratio >= 0.5 ? "B" : "C";
  return { grade, maxScore };
}

export const memoryChainEngine: GameEngine<MemoryChainState, MemoryChainAction> = {
  createRun({ config, random }) {
    const cfg = asConfig(config);
    const cells = Math.max(2, cfg.cells);
    const state: MemoryChainState = {
      cells,
      sequence: [],
      round: 1,
      phase: "show",
      inputIndex: 0,
      score: 0,
      finished: false,
    };
    for (let index = 0; index < cfg.startLength; index += 1) {
      state.sequence.push(Math.floor(random() * cells));
    }
    return { state, view: viewOf(state, cfg) };
  },

  apply({ state, config, action, random }) {
    const cfg = asConfig(config);
    if (state.finished) return { state, view: viewOf(state, cfg), finished: true };

    if (action.kind === "ready") {
      if (state.phase !== "show") {
        return { state, view: viewOf(state, cfg), finished: false };
      }
      const next: MemoryChainState = { ...state, phase: "input", inputIndex: 0 };
      return { state: next, view: viewOf(next, cfg), finished: false };
    }

    // press：非法格子一律不推进（幂等）。
    if (state.phase !== "input") return { state, view: viewOf(state, cfg), finished: false };
    if (!Number.isInteger(action.index) || action.index < 0 || action.index >= state.cells) {
      return { state, view: viewOf(state, cfg), finished: false };
    }
    const visibleLength = cfg.startLength + state.round - 1;
    const expected = state.sequence[state.inputIndex];
    if (action.index !== expected) {
      const next: MemoryChainState = { ...state, finished: true };
      return { state: next, view: viewOf(next, cfg), finished: true };
    }
    const inputIndex = state.inputIndex + 1;
    if (inputIndex < visibleLength) {
      const next: MemoryChainState = { ...state, inputIndex };
      return { state: next, view: viewOf(next, cfg), finished: false };
    }
    // 本轮复现完成：计分并开下一轮（序列追加一格）；最后一轮则通关。
    const score = state.score + cfg.roundScore * state.round;
    if (state.round >= cfg.rounds) {
      const next: MemoryChainState = { ...state, inputIndex, score, finished: true };
      return { state: next, view: viewOf(next, cfg), finished: true };
    }
    const nextSequence = [...state.sequence, Math.floor(random() * state.cells)];
    const next: MemoryChainState = {
      ...state,
      sequence: nextSequence,
      round: state.round + 1,
      phase: "show",
      inputIndex: 0,
      score,
    };
    return { state: next, view: viewOf(next, cfg), finished: false };
  },

  grade({ state, config }) {
    return gradeOf(state, asConfig(config));
  },

  view({ state, config }) {
    return viewOf(state, asConfig(config));
  },

  isAction(value): value is MemoryChainAction {
    if (!value || typeof value !== "object") return false;
    const raw = value as Record<string, unknown>;
    if (raw.kind === "ready") return true;
    return raw.kind === "press" && Number.isInteger(raw.index) && Number(raw.index) >= 0;
  },
};

/**
 * 服务端半身。引擎按 GameEngine<unknown, unknown> 收口；畸形 state 由
 * trial-plugin-api 的 try/catch 按「放弃」结算。
 */
export const memoryChainPlugin: GamePluginServer = {
  manifest: memoryChainManifest,
  props: memoryChainProps,
  engine: memoryChainEngine as unknown as GamePluginServer["engine"],
};
