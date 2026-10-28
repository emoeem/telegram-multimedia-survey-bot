import type { GameEngine, GamePluginServer } from "../../types";
import { drawManifest, drawProps, type DrawConfig, type DrawItem } from "./manifest";

/**
 * 抽取玩法的服务端引擎（权威抽取）。
 *
 * 四条硬约束：
 *  1. 奖池与权重只存在于 config；createRun 用注入的 random() 一次性抽好整个
 *     结果序列（不放回加权抽样），同 seed 同结果（可测、可重放）；
 *  2. 视图只发「已揭示」条目——未揭示的 order 尾部与权重分布永不离开服务端；
 *  3. reveal 动作带 step（= 已揭示数量，0 基游标）：陈旧提交（网络重试/重连）
 *     不推进指针、不重复计分；
 *  4. 空奖池直接结算（total=0），不让人卡死。
 */

export interface DrawState {
  /** 抽中的条目下标序列（指向 config.items），长度 = 本局揭示目标数。 */
  order: number[];
  /** 已揭示数量（下一个 reveal 的 step）。 */
  revealed: number;
  score: number;
  maxScore: number;
}

export interface DrawAction {
  kind: "reveal";
  /** 客户端要揭示的第几张（0 基，等于当前 view.step - 1）。 */
  step: number;
}

/** 输出给客户端的一帧：只带已揭示条目的可见字段。 */
function viewOf(state: DrawState, config: DrawConfig) {
  const finished = state.revealed >= state.order.length;
  const revealedItems = state.order
    .slice(0, state.revealed)
    .map((index) => config.items[index])
    .filter((item): item is DrawItem => Boolean(item))
    .map((item) => ({ label: item.label, rarity: item.rarity, score: item.score }));
  const ratio = state.maxScore === 0 ? 0 : (state.score / state.maxScore) * 100;
  return {
    status: finished ? (ratio >= 60 ? ("won" as const) : ("lost" as const)) : ("active" as const),
    score: state.score,
    maxScore: state.maxScore,
    step: Math.min(state.revealed + 1, Math.max(1, state.order.length)),
    total: state.order.length,
    payload: {
      revealed: revealedItems,
      remaining: state.order.length - state.revealed,
      cover: config.cover,
    },
  };
}

function asConfig(raw: Record<string, unknown>): DrawConfig {
  return raw as unknown as DrawConfig;
}

/** 不放回加权抽样：每轮按剩余条目的 weight 抽一个。全 0 权重退化为均匀随机。 */
function weightedOrderWithoutReplacement(items: DrawItem[], count: number, random: () => number): number[] {
  const pool = items.map((item, index) => ({ index, weight: Math.max(0, Math.floor(item.weight) || 0) }));
  const order: number[] = [];
  while (order.length < count && pool.length > 0) {
    const total = pool.reduce((sum, entry) => sum + entry.weight, 0);
    let threshold = random() * total;
    let picked = pool.length - 1;
    for (let i = 0; i < pool.length; i += 1) {
      threshold -= pool[i]!.weight;
      if (threshold <= 0) {
        picked = i;
        break;
      }
    }
    order.push(pool[picked]!.index);
    pool.splice(picked, 1);
  }
  return order;
}

export const drawEngine: GameEngine<DrawState, DrawAction> = {
  createRun({ config, random }) {
    const cfg = asConfig(config);
    const count = Math.max(0, Math.min(cfg.items.length, cfg.drawCount));
    const order = weightedOrderWithoutReplacement(cfg.items, count, random);
    const state: DrawState = {
      order,
      revealed: 0,
      score: 0,
      maxScore: order.reduce((sum, index) => sum + (cfg.items[index]?.score ?? 0), 0),
    };
    return { state, view: viewOf(state, cfg) };
  },

  apply({ state, config, action }) {
    const cfg = asConfig(config);
    if (action.step !== state.revealed || state.revealed >= state.order.length) {
      // 幂等：重复/陈旧提交不推进、不重复计分。
      return { state, view: viewOf(state, cfg), finished: state.revealed >= state.order.length };
    }
    const gained = cfg.items[state.order[state.revealed]!]?.score ?? 0;
    const next: DrawState = {
      ...state,
      revealed: state.revealed + 1,
      score: state.score + gained,
    };
    return { state: next, view: viewOf(next, cfg), finished: next.revealed >= next.order.length };
  },

  grade({ state }) {
    const ratio = state.maxScore === 0 ? 0 : state.score / state.maxScore;
    const grade = ratio >= 0.9 ? "S" : ratio >= 0.7 ? "A" : ratio >= 0.5 ? "B" : "C";
    return { grade, maxScore: state.maxScore };
  },

  view({ state, config }) {
    return viewOf(state, asConfig(config));
  },

  isAction(value): value is DrawAction {
    if (!value || typeof value !== "object") return false;
    const raw = value as Record<string, unknown>;
    return raw.kind === "reveal" && Number.isInteger(raw.step) && Number(raw.step) >= 0;
  },
};

/**
 * 服务端半身。引擎按 GameEngine<unknown, unknown> 收口（注册表不认识具体
 * state 形状）；畸形 state 由 trial-plugin-api 的 try/catch 按「放弃」结算。
 */
export const drawPlugin: GamePluginServer = {
  manifest: drawManifest,
  props: drawProps,
  engine: drawEngine as unknown as GamePluginServer["engine"],
};
