import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeMouseHandler,
  type NodeMouseHandler,
  type NodeChange,
} from "@xyflow/react";
// RF 基础样式表：缺了它 __viewport 不是 absolute，整个画布退化为文档流布局。
import "@xyflow/react/dist/style.css";
import type { BuilderSelection } from "../../StructureTree";
import { layoutGraph } from "../../../../editor/node-graph/layout";
import type { CanvasViewMode, GraphEdge, GraphNode } from "../../../../editor/node-graph/types";
import { NODE_HEIGHT, NODE_WIDTH, type SurveyGraph } from "../../../../editor/node-graph/to-graph";
import { EndingNode, EntryNode, PageNode, QuestionNode } from "./FlowNodes";
import { NodeActionsContext } from "./node-actions";
import "./flow-canvas.css";

/**
 * 节图画布（A4 批1）：surveyToGraph + layoutGraph 的渲染层。
 *
 * - 批1 范围是只读画布：点击节点 = 选中题目（与右栏属性面板联动），
 *   增删改仍走列表模式或右栏——连线编辑在批3 接 onConnect。
 * - list 形态（默认）：单列卡片流布局，端口隐藏——A2「纯问卷用户不该
 *   感到画布的存在」。
 * - 受控模式：nodes 存在本组件 state（useNodesState 语义，手写以复用
 *   GraphNode 类型），图派生变化时整体重置；拖拽位移经 applyNodeChanges
 *   只进 UI 状态，不回写问卷 JSON（画布是视图，见 node-graph/types.ts）。
 */

const nodeTypes = {
  question: QuestionNode,
  entry: EntryNode,
  page: PageNode,
  ending: EndingNode,
};

/** 取景：布局坐标已知，直接求包围盒 + 宿主矩形，setViewport 一步到位
 * （RF 的 fitView 依赖首帧节点测量，实测会取景到错误区域）。 */
function FitOnGraphChange({
  nodes,
  wrapperRef,
  signature,
}: {
  nodes: GraphNode[];
  wrapperRef: React.RefObject<HTMLDivElement | null>;
  signature: string;
}) {
  const { setViewport } = useReactFlow();
  useEffect(() => {
    let cancelled = false;
    // 两帧 raf：等 RF 把节点挂载完成（transform 生效后再覆盖取景）。
    const raf = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (cancelled || !wrapperRef.current) return;
        const pane = wrapperRef.current.getBoundingClientRect();
        if (pane.width < 80 || pane.height < 80) return;
        if (nodes.length === 0) return;
        const minX = Math.min(...nodes.map((n) => n.position.x));
        const maxX = Math.max(...nodes.map((n) => n.position.x + (n.width ?? NODE_WIDTH)));
        const minY = Math.min(...nodes.map((n) => n.position.y));
        const maxY = Math.max(...nodes.map((n) => n.position.y + (n.height ?? NODE_HEIGHT)));
        const raw = Math.min(pane.width / (maxX - minX), pane.height / (maxY - minY)) * 0.88;
        const zoom = Math.min(Math.max(raw, 0.15), 1.15);
        const x = (pane.width - (maxX - minX) * zoom) / 2 - minX * zoom;
        const y = (pane.height - (maxY - minY) * zoom) / 2 - minY * zoom;
        void setViewport({ x, y, zoom });
      }),
    );
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [nodes, wrapperRef, signature, setViewport]);
  return null;
}

export function FlowCanvas({
  graph,
  viewMode,
  selection,
  onSelect,
  onConnectEdge,
  onEdgesDelete,
  onConnectEnd,
  onRemoveBranch,
}: {
  graph: SurveyGraph;
  viewMode: CanvasViewMode;
  selection: BuilderSelection;
  onSelect: (selection: BuilderSelection) => void;
  /** 端口连线完成：映射为该题 skipToQuestionId 补丁（node-graph/commands）。 */
  onConnectEdge?: (connection: Connection) => void;
  /** 右键条件边 / 选中后按 Delete：移除对应跳转（顺序流边由排序管理，不可删）。 */
  onEdgesDelete?: (edges: Edge[]) => void;
  /** 从端口拖到空白处松手：由壳弹题型选择并接新题（one-shot 建分支）。 */
  onConnectEnd?: (event: { source: string; screenX: number; screenY: number }) => void;
  /** 分支角标菜单的「移除」：映射为该题 condition 补丁（等价删边）。 */
  onRemoveBranch?: (questionId: number, targetId: number) => void;
}) {
  // 图派生布局（每次 graph/viewMode 变化重算）。
  const layout = useMemo(() => layoutGraph(graph, viewMode === "list" ? "linear" : "layered"), [graph, viewMode]);
  // 受控节点状态：初始 = 布局结果；之后拖拽位移走 applyNodeChanges。
  const [nodes, setNodes] = useState<GraphNode[]>(layout);
  const layoutKey = useMemo(
    () => `${viewMode}:${graph.nodes.map((n) => n.id).join(",")}:${graph.edges.length}`,
    [graph, viewMode],
  );
  useEffect(() => {
    setNodes(layout);
  }, [layoutKey]); // eslint-disable-line react-hooks/exhaustive-deps -- layoutKey 是布局结果的指纹

  const onNodesChange = useCallback((changes: NodeChange<GraphNode>[]) => {
    setNodes((current) => applyNodeChanges(changes, current));
  }, []);

  const edges = useMemo(
    () =>
      graph.edges.map((edge) => ({
        ...edge,
        // list 形态下条件边降权为虚线（仍可见——「线性模式不撒谎」：
        // 分支存在但不强调，端口藏起来）。
        className: edge.data?.kind === "sequence" ? "flow-edge-sequence" : "flow-edge-condition",
        animated: edge.data?.kind !== "sequence",
      })),
    [graph.edges],
  );

  const handleNodeClick = useCallback<NodeMouseHandler>(
    (_event, node) => {
      const questionId = node.data.questionId;
      if (typeof questionId === "number") onSelect({ kind: "question", id: questionId });
    },
    [onSelect],
  );

  const selectedId = selection.kind === "question" ? `q${selection.id}` : undefined;
  // 右栏选中的题目在画布上同步高亮（React Flow 12 选中态在节点对象上）。
  useEffect(() => {
    setNodes((current) =>
      current.map((node) => ({ ...node, selected: node.id === selectedId ? true : undefined })),
    );
  }, [selectedId]);

  // 取景签名：节点集合或形态变化才重新取景（选中/拖动不触发）。
  const fitSignature = `${viewMode}:${graph.nodes.length}:${graph.edges.length}`;
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const nodeActions = useMemo(
    () => ({ removeBranch: (questionId: number, targetId: number) => onRemoveBranch?.(questionId, targetId) }),
    [onRemoveBranch],
  );

  return (
    <div ref={wrapperRef} className={`flow-canvas is-${viewMode}`} data-canvas-view={viewMode}>
      <NodeActionsContext.Provider value={nodeActions}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        nodesDraggable
        nodesConnectable={viewMode === "graph"}
        edgesFocusable
        minZoom={0.15}
        maxZoom={1.6}
        proOptions={{ hideAttribution: true }}
        onNodeClick={handleNodeClick}
        onConnect={(connection) => onConnectEdge?.(connection)}
        onEdgesDelete={(edges) => onEdgesDelete?.(edges)}
        // 右键条件边 = 删除分支（顺序流边在 Shell 的 handleEdgesDelete 里
        // 不产生命令，天然只对条件边生效）。
        onEdgeContextMenu={(event, edge) => {
          event.preventDefault();
          onEdgesDelete?.([edge]);
        }}
        onConnectEnd={(event, connectionState) => {
          // 拖到空白处松手（valid=false 表示没落在任何目标端口上）。
          const source = connectionState.fromNode?.id;
          const valid = connectionState.isValid;
          if (!source || valid) return;
          onConnectEnd?.({
            source,
            screenX: (event as PointerEvent).clientX,
            screenY: (event as PointerEvent).clientY,
          });
        }}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1.4} />
        <Controls showInteractive={false} position="bottom-right" />
        <FitOnGraphChange nodes={nodes} wrapperRef={wrapperRef} signature={fitSignature} />
      </ReactFlow>
      </NodeActionsContext.Provider>
      <div className="flow-canvas-legend" aria-hidden="true">
        <span className="flow-legend-item">
          <i className="flow-legend-line is-sequence" />顺序流
        </span>
        <span className="flow-legend-item">
          <i className="flow-legend-line is-condition" />条件分支（右键删除）
        </span>
      </div>
    </div>
  );
}
