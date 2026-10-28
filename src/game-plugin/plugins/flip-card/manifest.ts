import type { PropField } from "../../types";

/**
 * 答题翻牌：清单与属性 Schema。
 *
 * 属性 Schema 是唯一的前后端契约：编辑器据此自动生成属性面板，服务端据此
 * 归一化 settings_json，双方不各写一份表单定义。卡组的正确项固定为
 * options[0]——正确性只存在于服务端配置里，答题端的视图永远不会带出。
 */

export const flipCardProps = [
  {
    key: "cards",
    label: "卡组",
    kind: "list",
    required: true,
    collects: true,
    maxItems: 40,
    default: [],
    help: "每题一张卡：正面提示、背面揭晓、选项（第一个是正确答案）。",
    itemLabel: (item, index) => String(item.front || `第 ${index + 1} 张`),
    itemFields: [
      { key: "front", label: "正面提示", kind: "text", default: "", required: true, maxLength: 60 },
      { key: "back", label: "背面揭晓", kind: "textarea", default: "", maxLength: 300 },
      {
        key: "options",
        label: "选项（第一个为正确答案）",
        kind: "list",
        default: [],
        maxItems: 4,
        required: true,
        itemLabel: (item, index) => String(item.label || `选项 ${index + 1}`),
        itemFields: [{ key: "label", label: "选项文案", kind: "text", default: "", required: true, maxLength: 40 }],
      },
      { key: "score", label: "分值", kind: "number", default: 5, collects: true, min: 1, max: 20, integer: true },
    ],
  },
  { key: "shuffle", label: "打乱顺序", kind: "boolean", default: true, basic: true },
  {
    key: "passRatio",
    label: "通关所需正确率（%）",
    kind: "number",
    default: 60,
    min: 0,
    max: 100,
    integer: true,
    basic: true,
  },
  { key: "cover", label: "封面图（可选）", kind: "media", accept: "image", default: null },
] as const satisfies readonly PropField[];

export const flipCardManifest = {
  id: "flip-card",
  name: "flip-card",
  title: "答题翻牌",
  icon: "Layers",
  description: "翻牌看提示，四选一作答；按正确率评级。",
  category: "quiz",
  version: "1.0.0",
  author: "survey-platform",
  hostApi: 1,
  capabilities: { adult: false, persona: false },
} as const;

export interface FlipCardOption {
  label: string;
}

export interface FlipCardCard {
  front: string;
  back: string;
  options: FlipCardOption[];
  score: number;
}

/** 归一化后的配置形状（props.ts 保证每个键都存在）。 */
export interface FlipCardConfig {
  cards: FlipCardCard[];
  shuffle: boolean;
  passRatio: number;
  cover: number | null;
}
