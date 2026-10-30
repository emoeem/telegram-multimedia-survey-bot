import { NODE_HEIGHT, NODE_WIDTH, type SurveyGraph } from "./to-graph";
import type { GraphNode } from "./types";

/**
 * 节点图自动布局（纯函数，A2/A4）：给 surveyToGraph 的产物算坐标。
 *
 * - linear 模式：单列纵向流，entry/题目/ending 依次向下——接近现有表单
 *   体验，分页节点插在页分组之间（多页时）。
 * - graph 模式：拓扑分层（最长路径定深度），同层按链序横排——分支向右
 *   展开，主线始终是一条竖列，与 galgame 剧情树的阅读直觉一致。
 *   刻意不引 dagre/elkjs（elkjs gzip ≈80kB）：我们的图只有「向后」边
 *   （buildCanvasEdges 已保证无环、无前向回边），两轮 BFS 分层足够。
 */

const H_GAP = 64;
const V_GAP = 40;

/** 位置的持久化边界：画布不写回 JSON，位置只活在内存（拖动是 UI 状态）。 */
export function layoutGraph(graph: SurveyGraph, mode: "linear" | "layered"): GraphNode[] {
  return mode === "linear" ? layoutLinear(graph) : layoutLayered(graph);
}

function layoutLinear(graph: SurveyGraph): GraphNode[] {
  // 线性顺序：entry → （页标记按分组位置）→ 题目按 order → ending。
  const questionNodes = graph.nodes.filter((node) => node.data.kind === "question");
  const pageById = new Map(
    graph.nodes.filter((node) => node.data.kind === "page").map((node) => [node.data.pageId!, node]),
  );
  const ordered: GraphNode[] = graph.nodes.filter((node) => node.data.kind === "entry");
  let lastPageId: number | null = questionNodes[0]?.data.pageId ?? null;
  if (lastPageId !== null && pageById.has(lastPageId)) {
    // 首页标记省略（起点 entry 已表达）。
    pageById.delete(lastPageId);
  }
  for (const question of questionNodes) {
    const pageId = question.data.pageId ?? null;
    if (pageId !== null && pageId !== lastPageId && pageById.has(pageId)) {
      ordered.push(pageById.get(pageId)!);
      pageById.delete(pageId);
      lastPageId = pageId;
    }
    ordered.push(question);
  }
  ordered.push(...graph.nodes.filter((node) => node.data.kind === "ending"));
  return ordered.map((node, index) => ({
    ...node,
    position: { x: 0, y: index * (NODE_HEIGHT + V_GAP) },
  }));
}

function layoutLayered(graph: SurveyGraph): GraphNode[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const depth = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!outgoing.has(edge.source)) outgoing.set(edge.source, []);
    if (!incoming.has(edge.target)) incoming.set(edge.target, []);
    outgoing.get(edge.source)!.push(edge.target);
    incoming.get(edge.target)!.push(edge.source);
  }
  // Kahn 分层：入度为 0（entry）起，反复剥离。图 guaranteed 无环
  // （条件边只向后 + sequence 链），若出现环（手改 JSON）就退化为线性兜底。
  const indegree = new Map<string, number>();
  for (const id of byId.keys()) indegree.set(id, incoming.get(id)?.length ?? 0);
  const queue: string[] = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of outgoing.get(id) ?? []) {
      depth.set(next, Math.max(depth.get(next) ?? 0, (depth.get(id) ?? 0) + 1));
      indegree.set(next, (indegree.get(next) ?? 1) - 1);
      if ((indegree.get(next) ?? 0) === 0) queue.push(next);
    }
  }
  if (order.length !== byId.size) return layoutLinear(graph); // 有环兜底

  // 分页节点不参与分层（它们是标注不是流程节点）：先移除再插回。
  const flowNodes = [...byId.values()].filter((node) => node.data.kind !== "page");
  const layers = new Map<number, GraphNode[]>();
  for (const node of flowNodes) {
    const layer = depth.get(node.id) ?? 0;
    if (!layers.has(layer)) layers.set(layer, []);
    layers.get(layer)!.push(node);
  }
  // 同层内按「线性链序」排（entry < q(order) < ending），分支并列时顺序稳定。
  const chainRank = new Map<string, number>();
  const questionRank: string[] = flowNodes
    .filter((node) => node.data.kind === "question")
    .sort((a, b) => (a.data.questionId ?? 0) - (b.data.questionId ?? 0))
    .map((node) => node.id);
  chainRank.set("entry", -1);
  questionRank.forEach((id, index) => chainRank.set(id, index));
  chainRank.set("ending", Number.MAX_SAFE_INTEGER);

  const positioned = new Map<string, { x: number; y: number }>();
  for (const [layer, nodes] of [...layers.entries()].sort((a, b) => a[0] - b[0])) {
    nodes.sort((a, b) => (chainRank.get(a.id) ?? 0) - (chainRank.get(b.id) ?? 0));
    nodes.forEach((node, column) => {
      positioned.set(node.id, { x: column * (NODE_WIDTH + H_GAP), y: layer * (NODE_HEIGHT + V_GAP) });
    });
  }
  return flowNodes.map((node) => ({ ...node, position: positioned.get(node.id) ?? { x: 0, y: 0 } }));
}
