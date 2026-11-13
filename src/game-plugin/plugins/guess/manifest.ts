import type { PropField } from "../../types";

/**
 * 猜数字玩法：清单与属性 Schema。
 *
 * 谜底（secret）只在服务端 state 里，视图在终局前永远不下发；客户端提交的
 * 只有猜测值，提示（大了 / 小了 / 中了）由引擎计算后放进 payload。
 */

export const guessProps = [
  {
    key: "rangeMin",
    label: "范围下界",
    kind: "number",
    default: 1,
    min: 0,
    max: 1000,
    integer: true,
    basic: true,
    help: "谜底所在区间的最小值。",
  },
  {
    key: "rangeMax",
    label: "范围上界",
    kind: "number",
    default: 100,
    min: 1,
    max: 1000,
    integer: true,
    basic: true,
    help: "谜底所在区间的最大值，需要大于下界。",
  },
  {
    key: "attempts",
    label: "机会次数",
    kind: "number",
    default: 7,
    min: 3,
    max: 20,
    integer: true,
    basic: true,
    help: "猜错多少次后本局失败。",
  },
  {
    key: "score",
    label: "满分",
    kind: "number",
    default: 20,
    collects: true,
    min: 1,
    max: 100,
    integer: true,
    help: "猜中时的得分 = 满分 × 剩余机会 ÷ 总机会（越早猜中分越高）。",
  },
] as const satisfies readonly PropField[];

export const guessManifest = {
  id: "guess",
  name: "guess",
  title: "猜数字",
  icon: "Hash",
  description: "在区间里猜一个数，每次提示大了或小了；越早猜中得分越高。",
  category: "challenge",
  version: "1.0.0",
  author: "survey-platform",
  hostApi: 1,
  capabilities: { adult: false, persona: false },
} as const;

export interface GuessConfig {
  rangeMin: number;
  rangeMax: number;
  attempts: number;
  score: number;
}

export interface GuessHistoryEntry {
  value: number;
  /** up = 谜底比猜测大，down = 谜底比猜测小，hit = 猜中。 */
  hint: "up" | "down" | "hit";
}
