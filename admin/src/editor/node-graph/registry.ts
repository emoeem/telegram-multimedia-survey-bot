/**
 * 节点类型注册表（A1）：每个可入图的题型在这里声明外观与语义，
 * 画布/物料区/图例统一消费这一份，不再各写各的映射表。
 *
 * 与 game-plugin 协议对齐：game 节点的 meta 由任务包 manifest 补充
 * （见 to-graph.ts 的 gamePackLabel），quest 的 clue/collectible/key
 * 三件套在节点摘要里呈现——插件侧不用改任何画布代码。
 */

export interface NodeTypeDescriptor {
  /** 分组（与 TypePickerSheet 的 TYPE_GROUPS 对齐，新增题型先在那边登记）。 */
  group: "剧情" | "选择" | "填写" | "上传" | "互动" | "系统";
  /** 节点卡片左侧的强调色（hex，画布深浅主题都可读）。 */
  accent: string;
  /** 节点语义的一句话说明（图例 / aria）。 */
  desc: string;
}

/** 题型 → 节点描述。key 与 QUESTION_TYPE_LABELS / TYPE_GROUPS 的 type 一致。 */
export const NODE_TYPE_REGISTRY: Record<string, NodeTypeDescriptor> = {
  // 剧情
  note: { group: "剧情", accent: "#a78bfa", desc: "文本幕：叙事文段（可配图/说话人）" },
  scene: { group: "剧情", accent: "#22d3ee", desc: "场景幕：热点互动画面（立绘/BGM 挂 theme）" },
  // 选择
  single: { group: "选择", accent: "#60a5fa", desc: "单选题，选项可设跳转" },
  multiple: { group: "选择", accent: "#60a5fa", desc: "多选题" },
  yes_no: { group: "选择", accent: "#60a5fa", desc: "是非二选一" },
  rating: { group: "选择", accent: "#60a5fa", desc: "星级评分" },
  matrix: { group: "选择", accent: "#60a5fa", desc: "矩阵题" },
  // 填写
  text: { group: "填写", accent: "#34d399", desc: "单行文本" },
  long_text: { group: "填写", accent: "#34d399", desc: "多行长文本" },
  number: { group: "填写", accent: "#34d399", desc: "数字输入" },
  date: { group: "填写", accent: "#34d399", desc: "日期" },
  time: { group: "填写", accent: "#34d399", desc: "时间" },
  // 上传
  image: { group: "上传", accent: "#fbbf24", desc: "图片上传" },
  video: { group: "上传", accent: "#fbbf24", desc: "视频上传" },
  audio: { group: "上传", accent: "#fbbf24", desc: "音频上传" },
  file: { group: "上传", accent: "#fbbf24", desc: "任意文件上传" },
  // 互动
  game: { group: "互动", accent: "#fb923c", desc: "小游戏（含 quest 道具剧情包）" },
};

/** 未知题型的兜底外观（注册表漏登记时不崩画布）。 */
export const FALLBACK_NODE_TYPE: NodeTypeDescriptor = {
  group: "系统",
  accent: "#94a3b8",
  desc: "未登记题型",
};

export function nodeTypeOf(questionType: string): NodeTypeDescriptor {
  return NODE_TYPE_REGISTRY[questionType] ?? FALLBACK_NODE_TYPE;
}

/** 合成节点（entry/page/ending）的固定外观。 */
export const SYNTHETIC_NODES: Record<"entry" | "page" | "ending", NodeTypeDescriptor> = {
  entry: { group: "系统", accent: "#94a3b8", desc: "开始作答" },
  page: { group: "系统", accent: "#94a3b8", desc: "分页节点" },
  ending: { group: "系统", accent: "#f472b6", desc: "结束幕：提交 + 认证卡挂钩" },
};
