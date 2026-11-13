import type { PropField } from "../../types";

/**
 * 记忆序列玩法（Simon 式）：清单与属性 Schema。
 *
 * 序列只存在于服务端 state；「展示阶段」视图带出序列供客户端动画，
 * 「复现阶段」视图不再下发序列——玩家只能凭记忆点格子，正确与否由引擎判定。
 */

export const memoryChainProps = [
  {
    key: "cells",
    label: "格子数量",
    kind: "number",
    default: 9,
    min: 4,
    max: 25,
    integer: true,
    basic: true,
    help: "棋盘格子数（4–25），建议用完全平方数（9=3×3、16=4×4）。",
  },
  {
    key: "rounds",
    label: "总轮数",
    kind: "number",
    default: 6,
    min: 1,
    max: 12,
    integer: true,
    basic: true,
    help: "序列每轮变长一格，全部复现成功即通关。",
  },
  {
    key: "startLength",
    label: "首轮长度",
    kind: "number",
    default: 3,
    min: 2,
    max: 6,
    integer: true,
    help: "第一轮要记的步数；之后每轮 +1。",
  },
  {
    key: "roundScore",
    label: "每轮分值",
    kind: "number",
    default: 5,
    collects: true,
    min: 1,
    max: 20,
    integer: true,
    help: "第 r 轮完成得 roundScore × r 分（越往后越值钱）。",
  },
] as const satisfies readonly PropField[];

export const memoryChainManifest = {
  id: "memory-chain",
  name: "memory-chain",
  title: "记忆序列",
  icon: "Brain",
  description: "看一遍点亮的格子顺序，然后凭记忆复现；序列每轮加长一格。",
  category: "challenge",
  version: "1.0.0",
  author: "survey-platform",
  hostApi: 1,
  capabilities: { adult: false, persona: false },
} as const;

export interface MemoryChainConfig {
  cells: number;
  rounds: number;
  startLength: number;
  roundScore: number;
}
