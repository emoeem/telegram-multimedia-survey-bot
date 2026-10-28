import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { buildCanvasEdges, type CanvasEdge } from "../../../editor/canvas-edges";
import type { EditableQuestion } from "../../../editor/useSurveyEditor";

/**
 * S6 画布连线层：同序列卡片之间的贝塞尔边，覆盖在摘要卡列表上。
 * - 只画向后的目标（buildCanvasEdges 已过滤，与引擎一致）；
 * - 选中题：出边琥珀、入边蓝，其余降饱和；
 * - 点击边滚动到目标题并选中；
 * - 坐标以 block-list 容器为基准，滚动/尺寸变化时重算。
 */

interface EdgeGeometry {
  edge: CanvasEdge;
  /** path d 属性（容器内坐标）。 */
  d: string;
  /** 边中点（点击跳转的高亮定位用）。 */
  midX: number;
  midY: number;
}

const EDGE_COLORS: Record<CanvasEdge["kind"], string> = {
  option: "var(--color-primary)",
  flagJump: "#d97706",
  answerRule: "#0ea5e9",
  skipTo: "#64748b",
};

function cardRect(base: HTMLElement, questionId: number): { top: number; left: number; width: number; height: number } | null {
  const element = base.querySelector(`[data-block-id="${questionId}"]`);
  if (!(element instanceof HTMLElement)) return null;
  const card = element.querySelector(".q-row") ?? element;
  const cardRect = card.getBoundingClientRect();
  const baseRect = base.getBoundingClientRect();
  return {
    width: cardRect.width,
    height: cardRect.height,
    top: cardRect.top - baseRect.top,
    left: cardRect.left - baseRect.left,
  };
}

function edgePath(base: HTMLElement, edge: CanvasEdge): EdgeGeometry | null {
  const from = cardRect(base, edge.fromId);
  const to = cardRect(base, edge.toId);
  if (!from || !to) return null;
  if (to.top <= from.top) return null; // 只画向下的边（目标在源下方）
  const x1 = from.left + from.width;
  const y1 = from.top + from.height / 2;
  const x2 = to.left;
  const y2 = to.top + to.height / 2;
  const bend = Math.max(24, Math.min(120, (y2 - y1) / 2 + 24));
  return {
    edge,
    d: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`,
    midX: (x1 + x2) / 2,
    midY: (y1 + y2) / 2,
  };
}

export function LogicLayer({
  questions,
  selectedId,
  base,
  onSelect,
}: {
  questions: EditableQuestion[];
  selectedId: number | null;
  /** 坐标基准：画布内容区（relative 容器）。 */
  base: HTMLElement | null;
  onSelect: (questionId: number) => void;
}) {
  const edges = useMemo(() => buildCanvasEdges(questions), [questions]);
  const [geometries, setGeometries] = useState<EdgeGeometry[]>([]);
  const frameRef = useRef(0);

  useLayoutEffect(() => {
    if (!base) return;
    const measure = () => {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = requestAnimationFrame(() => {
        setGeometries(
          edges
            .map((edge) => edgePath(base, edge))
            .filter((geometry): geometry is EdgeGeometry => geometry !== null),
        );
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(base);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      cancelAnimationFrame(frameRef.current);
    };
  }, [base, edges]);

  // 题目增删/折叠会改变卡片位置：MutationObserver 触发一次重算。
  useEffect(() => {
    if (!base) return;
    let scheduled = 0;
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(scheduled);
      scheduled = requestAnimationFrame(() => {
        setGeometries(
          edges
            .map((edge) => edgePath(base, edge))
            .filter((geometry): geometry is EdgeGeometry => geometry !== null),
        );
      });
    });
    observer.observe(base, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(scheduled);
    };
  }, [base, edges]);

  if (!base || geometries.length === 0) return null;

  return (
    <svg
      className="pointer-events-none absolute inset-0 z-10"
      width={base.offsetWidth}
      height={base.offsetHeight}
      aria-hidden="true"
      style={{ overflow: "visible" }}
    >
      {geometries.map(({ edge, d }) => {
        const isSelectedEdge = selectedId !== null && (edge.fromId === selectedId || edge.toId === selectedId);
        return (
          <g key={`${edge.fromId}-${edge.toId}-${edge.kind}`} style={{ pointerEvents: "auto" }}>
            <path
              d={d}
              fill="none"
              stroke={EDGE_COLORS[edge.kind]}
              strokeWidth={isSelectedEdge ? 2.5 : 1.5}
              strokeDasharray={edge.kind === "skipTo" ? "6 4" : undefined}
              opacity={selectedId === null ? 0.75 : isSelectedEdge ? 1 : 0.35}
              className="cursor-pointer"
              onClick={() => onSelect(edge.toId)}
            >
              <title>{edge.label}</title>
            </path>
          </g>
        );
      })}
    </svg>
  );
}
