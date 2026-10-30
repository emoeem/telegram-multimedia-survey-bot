import type { EdgeQuestion } from "../canvas-edges";
import { buildCanvasEdges } from "../canvas-edges";
import { nodeTypeOf, SYNTHETIC_NODES } from "./registry";
import type { GraphEdge, GraphNode, GraphNodeData } from "./types";

/**
 * 问卷 JSON → 节点图（A1 双向映射的读向）。
 *
 * 只读不写：输入是最小题目形状 + 页列表，输出 React Flow 可直接消费的
 * 节点/边。条件边完全复用 buildCanvasEdges（与 LogicLayer 同一真相源），
 * 线性边按 order 相邻生成——纯文字问卷因此是一条直线链。
 *
 * round-trip 的另一半在 commands.ts（图操作 → 问卷命令），单测见
 * tests/unit/editor/node-graph.test.ts。
 */

/** 转换器输入：结构上等同 EditableQuestion，但不 import 编辑器（纯函数可单测）。 */
export interface GraphQuestionInput extends EdgeQuestion {
  type: string;
  title: string;
  required: boolean;
  pageId: number | null;
  options: Array<{ id: number }>;
  speaker?: string | null;
  gamePackId: number | null;
}

export interface GraphPageInput {
  id: number;
  title: string | null;
  order: number;
}

export interface GraphSummaryInput {
  questions: GraphQuestionInput[];
  pages: GraphPageInput[];
  /** game 题的任务包名（id → 名称），由调用方从已加载的任务包清单传入。 */
  gamePackNames?: Record<number, string>;
}

/** 节点尺寸常量：layout.ts 与 CSS 的 .flow-node 保持一致。 */
export const NODE_WIDTH = 240;
export const NODE_HEIGHT = 96;

export interface SurveyGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

function truncate(text: string, max = 24): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export function surveyToGraph(input: GraphSummaryInput): SurveyGraph {
  const questions = [...input.questions].sort((a, b) => a.order - b.order);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  // 题目节点：统一 kind=question，外观由 registry 决定。
  for (const question of questions) {
    const descriptor = nodeTypeOf(question.type);
    let meta = "";
    if (question.type === "note") {
      meta = question.speaker ? `说话人 ${question.speaker}` : "文本幕";
    } else if (question.type === "scene") {
      meta = "热点场景";
    } else if (question.type === "game") {
      const packName = question.gamePackId !== null ? input.gamePackNames?.[question.gamePackId] : undefined;
      meta = packName ? `任务包 ${packName}` : "小游戏挑战";
    } else if (question.options.length > 0) {
      meta = `${question.options.length} 个选项`;
    }
    nodes.push({
      id: `q${question.id}`,
      type: "question",
      position: { x: 0, y: 0 }, // 布局由 layout.ts 统一计算

      data: {
        kind: "question",
        questionId: question.id,
        questionType: question.type,
        title: truncate(question.title || "(未命名题面)") || descriptor.desc,
        meta: meta || descriptor.group,
        required: question.required,
        branching: false,
      } satisfies GraphNodeData,
    });
  }

  // 线性链：entry → q1 → q2 → … → ending（引擎的默认顺序流）。
  nodes.unshift({
    id: "entry",
    type: "entry",
    position: { x: 0, y: 0 },
    data: { kind: "entry", title: SYNTHETIC_NODES.entry.desc, meta: "开始" } satisfies GraphNodeData,
  });
  nodes.push({
    id: "ending",
    type: "ending",
    position: { x: 0, y: 0 },
    data: { kind: "ending", title: SYNTHETIC_NODES.ending.desc, meta: "提交问卷" } satisfies GraphNodeData,
  });

  const chain = ["entry", ...questions.map((question) => `q${question.id}`), "ending"];
  for (let index = 0; index < chain.length - 1; index += 1) {
    edges.push({ id: `seq-${index}`, source: chain[index]!, target: chain[index + 1]!, data: { kind: "sequence" } });
  }

  // 条件边（选项跳转 / flag / 答案规则 / 默认跳转）：与 LogicLayer 同一真相源。
  for (const edge of buildCanvasEdges(questions)) {
    edges.push({
      id: `cond-${edge.fromId}-${edge.toId}-${edge.kind}-${edges.length}`,
      source: `q${edge.fromId}`,
      target: `q${edge.toId}`,
      label: edge.label,
      data: { kind: edge.kind, label: edge.label },
    });
    const node = nodes.find((item) => item.id === `q${edge.fromId}`);
    if (node) {
      node.data.branching = true;
      // 分支角标的快捷菜单数据：该题的每条条件跳转都可从节点上直接移除
      // （同列布局下分支边会被中间节点遮挡，右键命中不可靠——见走查记录）。
      const targetNode = nodes.find((item) => item.id === `q${edge.toId}`);
      (node.data.branches ??= []).push({
        targetId: edge.toId,
        label: `${edge.label} → ${targetNode?.data.title ?? `第 ${edge.toId} 题`}`,
      });
    }
  }

  // 分页标记：只有一页时不渲染（纯噪声）；多页时按 order 插进链的分组间隙。
  if (input.pages.length > 1) {
    const sortedPages = [...input.pages].sort((a, b) => a.order - b.order);
    for (const page of sortedPages) {
      nodes.push({
        id: `p${page.id}`,
        type: "page",
        position: { x: 0, y: 0 },
        width: 200,
        height: 44,
        data: {
          kind: "page",
          pageId: page.id,
          title: page.title || `第 ${page.order + 1} 页`,
          meta: "分页",
        } satisfies GraphNodeData,
      });
    }
  }

  return { nodes, edges };
}
