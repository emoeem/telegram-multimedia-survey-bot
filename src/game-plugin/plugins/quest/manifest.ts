import type { PropField } from "../../types";

/**
 * quest 剧情扩展包 · 清单与属性 Schema。
 *
 * 真正的游戏内容（节点图 + 道具）是**纯数据**，存进 `content`（quest.json
 * 的 JSON 字符串），由扩展包导入器（src/http/admin/pack-import.ts）写入。
 * 手工建包理论上也可行（往 textarea 里粘 JSON），但常规入口永远是导入器。
 */

export const questProps = [
  {
    key: "content",
    label: "扩展包内容（quest.json）",
    kind: "textarea",
    default: "",
    required: true,
    collects: true,
    rows: 5,
    maxLength: 200_000,
    help: "扩展包导入器自动生成；包含节点、道具与跳转表，服务端权威执行。",
  },
  {
    key: "packId",
    label: "扩展包标识",
    kind: "text",
    default: "",
    maxLength: 32,
    help: "来自 manifest.json 的 id，仅用于审计与更新提示。",
  },
  { key: "adult", label: "18+ 内容（答题端先确认年龄）", kind: "boolean", default: false, basic: true },
  { key: "cover", label: "封面图（可选）", kind: "media", accept: "image", default: null },
] as const satisfies readonly PropField[];

export const questManifest = {
  id: "quest",
  name: "quest",
  title: "剧情扩展包",
  icon: "BookOpenCheck",
  description: "数据驱动的剧情小游戏：分支选择、线索收集、道具门控，来自可导入的扩展包。",
  category: "story",
  version: "1.0.0",
  author: "survey-platform",
  hostApi: 1,
  capabilities: { adult: true, persona: false },
} as const;

/** 归一化后的配置形状（props.ts 保证每个键都存在）。 */
export interface QuestConfig {
  content: string;
  packId: string;
  adult: boolean;
  cover: number | null;
}
