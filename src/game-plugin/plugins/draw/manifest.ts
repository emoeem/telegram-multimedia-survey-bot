import type { PropField } from "../../types";

/**
 * 抽取玩法：清单与属性 Schema。
 *
 * 奖池与权重只存在于服务端配置（settings_json，写入前经 props.ts 白名单归一化）；
 * 答题端的视图只发「已揭示」的条目——未抽中的条目与权重分布永不离开服务端。
 */

export const drawProps = [
  {
    key: "items",
    label: "奖池",
    kind: "list",
    required: true,
    collects: true,
    maxItems: 60,
    default: [],
    help: "每个条目：名称、权重（越大越容易抽中）、稀有度、分值。",
    itemLabel: (item, index) => String(item.label || `条目 ${index + 1}`),
    itemFields: [
      { key: "label", label: "名称", kind: "text", default: "", required: true, maxLength: 40 },
      { key: "weight", label: "权重", kind: "number", default: 10, min: 1, max: 100, integer: true },
      {
        key: "rarity",
        label: "稀有度",
        kind: "select",
        default: "common",
        options: [
          { value: "common", label: "普通" },
          { value: "rare", label: "稀有" },
          { value: "epic", label: "史诗" },
          { value: "legendary", label: "传说" },
        ],
      },
      { key: "score", label: "分值", kind: "number", default: 5, collects: true, min: 0, max: 20, integer: true },
    ],
  },
  {
    key: "drawCount",
    label: "每次抽取张数",
    kind: "number",
    default: 3,
    min: 1,
    max: 10,
    integer: true,
    basic: true,
    help: "一局依次揭示的条目数；超过奖池大小时按奖池大小封顶。",
  },
  { key: "cover", label: "封面图（可选）", kind: "media", accept: "image", default: null },
] as const satisfies readonly PropField[];

export const drawManifest = {
  id: "draw",
  name: "draw",
  title: "幸运抽取",
  icon: "Gift",
  description: "按权重抽取奖池条目，逐张揭示；分数由抽中的条目决定。",
  category: "random",
  version: "1.0.0",
  author: "survey-platform",
  hostApi: 1,
  capabilities: { adult: false, persona: false },
} as const;

export type DrawRarity = "common" | "rare" | "epic" | "legendary";

export interface DrawItem {
  label: string;
  weight: number;
  rarity: DrawRarity;
  score: number;
}

/** 归一化后的配置形状（props.ts 保证每个键都存在）。 */
export interface DrawConfig {
  items: DrawItem[];
  drawCount: number;
  cover: number | null;
}
