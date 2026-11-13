import type { PropField } from "../../types";

/**
 * 大小猜牌玩法：清单与属性 Schema。
 *
 * 牌面（下一张）只在服务端 state 里，提交只有方向（up/down）；结果与连击
 * 由引擎判定。点数 1–13（A 到 K），平局不吃分也不掉命——只推进轮次。
 */

export const highLowProps = [
  {
    key: "rounds",
    label: "总轮数",
    kind: "number",
    default: 10,
    min: 5,
    max: 20,
    integer: true,
    basic: true,
    help: "一共猜几轮；猜错即终局。",
  },
  {
    key: "score",
    label: "单次分值",
    kind: "number",
    default: 3,
    collects: true,
    min: 1,
    max: 20,
    integer: true,
    help: "每猜对一次得的分数。",
  },
  {
    key: "streakBonus",
    label: "连击奖励",
    kind: "number",
    default: 5,
    collects: true,
    min: 0,
    max: 50,
    integer: true,
    help: "每连续猜对 3 次，额外奖励一次这个分数。",
  },
] as const satisfies readonly PropField[];

export const highLowManifest = {
  id: "high-low",
  name: "high-low",
  title: "大小猜牌",
  icon: "Shuffle",
  description: "猜下一张牌比当前大还是小；连对 3 次有额外奖励，猜错即终局。",
  category: "random",
  version: "1.0.0",
  author: "survey-platform",
  hostApi: 1,
  capabilities: { adult: false, persona: false },
} as const;

export interface HighLowConfig {
  rounds: number;
  score: number;
  streakBonus: number;
}
