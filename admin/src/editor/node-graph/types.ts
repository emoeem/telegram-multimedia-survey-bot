import type { Edge, Node } from "@xyflow/react";

/**
 * 统一节点编辑器的图视图模型（2026-10-30，A1）。
 *
 * 铁律：**画布是视图，问卷 JSON 是唯一存储**。GraphNode/GraphEdge 全部由
 * survey JSON 派生（to-graph.ts），编辑动作不直接改图，而是映射回
 * useSurveyEditor 的既有命令（patchQuestionLocal / reorderQuestions /
 * addQuestionOfType / condition 补丁）——因此存量问卷天然兼容，round-trip
 * 无损在结构上成立（见 tests/unit/editor/node-graph.test.ts）。
 *
 * 两类内容一个模型：
 * - 纯文字问卷 = 一条直线节点链（sequence 边串起来的 question 节点）；
 * - Galgame/互动剧情 = 同一条链 + 条件边（选项跳转/flag/答案规则）分叉。
 * 「剧情文本幕 / 场景幕 / 道具 / 分页 / 结束幕」不是新存储概念：
 * note/scene/game(quest) 题型、pages、提交设置在现有 JSON 里已存在，
 * 这里只是给它们各自的节点外观（见 registry.ts）。
 */

/** 合成节点种类：entry/ending 由问卷首尾派生，page 由 pages 派生，question 是真实题目。 */
export type GraphNodeKind = "entry" | "question" | "page" | "ending";

/** 节点数据（React Flow 要求 Record<string, unknown>）。 */
export interface GraphNodeData extends Record<string, unknown> {
  kind: GraphNodeKind;
  /** question 节点对应的题目 id。 */
  questionId?: number;
  /** question 节点的题型（registry key，如 note/single/scene/game）。 */
  questionType?: string;
  /** 节点标题（题面 title / 页标题 / 固定文案）。 */
  title: string;
  /** 摘要行：选项数、说话人、任务包名等（一行以内）。 */
  meta?: string;
  required?: boolean;
  /** question 节点是否带条件出边（分支），用于节点角标。 */
  branching?: boolean;
  /** page 节点所属页 id。 */
  pageId?: number;
}

export type GraphNode = Node<GraphNodeData>;

/** 边种类：sequence 是线性链（引擎顺序流），其余四类与 buildCanvasEdges 一致。 */
export type GraphEdgeKind = "sequence" | "option" | "flagJump" | "answerRule" | "skipTo";

export interface GraphEdgeData extends Record<string, unknown> {
  kind: GraphEdgeKind;
  /** 悬浮/沿线提示（条件边）。 */
  label?: string;
}

export type GraphEdge = Edge<GraphEdgeData>;

/** 画布视图开关：linear=线性卡片流（隐藏端口/连线，接近表单），graph=完整节点图。 */
export type CanvasViewMode = "list" | "graph";
