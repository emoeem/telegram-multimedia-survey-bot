import type { GameEngine, GamePluginServer } from "../../types";
import { guessManifest, guessProps, type GuessConfig, type GuessHistoryEntry } from "./manifest";

/**
 * 猜数字玩法的服务端引擎（权威判定）。
 *
 * 四条硬约束：
 *  1. secret 只存在于服务端 state；终局前的视图永远不含 secret（含历史提示
 *     也推不出越界收缩后的剩余区间之外的任何信息——提示只回 up/down）；
 *  2. 猜错扣机会、猜中按剩余机会比例计分；机会用尽即败局终局；
 *  3. 区间外的猜测视为无效输入：不扣机会、不推进（防手滑毁局）；
 *  4. 终局视图带出 secret，供客户端揭晓谜底。
 */

export interface GuessState {
  secret: number;
  attemptsLeft: number;
  score: number;
  /** 已提交且有效的猜测（含猜中那一发），按提交顺序。 */
  history: GuessHistoryEntry[];
  finished: boolean;
}

export interface GuessAction {
  kind: "guess";
  value: number;
}

// type alias（而非 interface）才有对 Record<string, unknown> 的隐式索引签名
// 兼容；GameRunView.payload 要求这个形状，写成 interface 会被 tsc 拒收。
type GuessViewPayload = {
  range: [number, number];
  attempts: number;
  attemptsLeft: number;
  history: GuessHistoryEntry[];
  /** 仅终局时下发。 */
  secret?: number;
};

function asConfig(raw: Record<string, unknown>): GuessConfig {
  return raw as unknown as GuessConfig;
}

function viewOf(state: GuessState, config: GuessConfig) {
  const won = state.finished && state.history[state.history.length - 1]?.hint === "hit";
  const payload: GuessViewPayload = {
    range: [config.rangeMin, config.rangeMax],
    attempts: config.attempts,
    attemptsLeft: state.attemptsLeft,
    history: state.history,
  };
  if (state.finished) {
    payload.secret = state.secret;
  }
  return {
    status: state.finished ? (won ? ("won" as const) : ("lost" as const)) : ("active" as const),
    score: state.score,
    maxScore: config.score,
    step: Math.min(config.attempts - state.attemptsLeft + 1, config.attempts),
    total: config.attempts,
    payload,
  };
}

function gradeOf(state: GuessState, config: GuessConfig) {
  const won = state.finished && state.history[state.history.length - 1]?.hint === "hit";
  if (!won) return { grade: "C" as const, maxScore: config.score };
  const used = config.attempts - state.attemptsLeft;
  // 一发入取 S，前半程 A，其余 B；败局 C。
  const grade = used <= 1 ? ("S" as const) : used <= Math.ceil(config.attempts / 2) ? ("A" as const) : ("B" as const);
  return { grade, maxScore: config.score };
}

export const guessEngine: GameEngine<GuessState, GuessAction> = {
  createRun({ config, random }) {
    const cfg = asConfig(config);
    const span = Math.max(1, cfg.rangeMax - cfg.rangeMin + 1);
    const secret = cfg.rangeMin + Math.floor(random() * span);
    const state: GuessState = {
      secret: Math.min(cfg.rangeMax, Math.max(cfg.rangeMin, secret)),
      attemptsLeft: cfg.attempts,
      score: 0,
      history: [],
      finished: false,
    };
    return { state, view: viewOf(state, cfg) };
  },

  apply({ state, config, action }) {
    const cfg = asConfig(config);
    if (state.finished) {
      return { state, view: viewOf(state, cfg), finished: true };
    }
    // 区间外 = 无效输入：不扣机会、不推进（幂等，重复提交同值也不重复扣）。
    if (action.value < cfg.rangeMin || action.value > cfg.rangeMax) {
      return { state, view: viewOf(state, cfg), finished: false };
    }
    const alreadyGuessed = state.history.some((entry) => entry.hint !== "hit" && entry.value === action.value);
    if (alreadyGuessed) {
      return { state, view: viewOf(state, cfg), finished: false };
    }
    const hit = action.value === state.secret;
    const next: GuessState = {
      ...state,
      history: [
        ...state.history,
        { value: action.value, hint: hit ? "hit" : action.value < state.secret ? "up" : "down" },
      ],
      attemptsLeft: hit ? state.attemptsLeft : state.attemptsLeft - 1,
      score: hit ? Math.max(1, Math.ceil((cfg.score * state.attemptsLeft) / cfg.attempts)) : state.score,
      finished: hit || state.attemptsLeft - 1 <= 0,
    };
    return { state: next, view: viewOf(next, cfg), finished: next.finished };
  },

  grade({ state, config }) {
    return gradeOf(state, asConfig(config));
  },

  view({ state, config }) {
    return viewOf(state, asConfig(config));
  },

  isAction(value): value is GuessAction {
    if (!value || typeof value !== "object") return false;
    const raw = value as Record<string, unknown>;
    return raw.kind === "guess" && Number.isInteger(raw.value);
  },
};

/**
 * 服务端半身。引擎按 GameEngine<unknown, unknown> 收口；畸形 state 由
 * trial-plugin-api 的 try/catch 按「放弃」结算。
 */
export const guessPlugin: GamePluginServer = {
  manifest: guessManifest,
  props: guessProps,
  engine: guessEngine as unknown as GamePluginServer["engine"],
};
