import { memo, useState } from "react";
import { Handle, Position } from "@xyflow/react";
import { BookOpen, Flag, MousePointerClick, PartyPopper, Play, Puzzle, X } from "lucide-react";
import { nodeTypeOf, SYNTHETIC_NODES } from "../../../../editor/node-graph/registry";
import { useNodeActions } from "./node-actions";
import type { GraphNode } from "../../../../editor/node-graph/types";

/**
 * 节点外观（批1）：题目卡沿用列表模式摘要卡的信息密度（标题 + meta 一行），
 * 左侧强调色条 = registry accent。端口（Handle）在 graph 模式显示、
 * linear 模式由 CSS 隐藏（.flow-canvas.is-linear .react-flow__handle）。
 */

function questionIcon(questionType: string) {
  if (questionType === "note") return BookOpen;
  if (questionType === "scene") return MousePointerClick;
  if (questionType === "game") return Puzzle;
  return Flag;
}

export const QuestionNode = memo(function QuestionNode({ id, data, selected }: { id?: string; data: GraphNode["data"]; selected?: boolean }) {
  const type = nodeTypeOf(data.questionType ?? "");
  const Icon = questionIcon(data.questionType ?? "");
  const { removeBranch } = useNodeActions();
  const [menuOpen, setMenuOpen] = useState(false);
  const questionId = typeof id === "string" && id.startsWith("q") ? Number(id.slice(1)) : null;
  return (
    <div
      className={`flow-node${selected ? " is-selected" : ""}`}
      style={{ ["--flow-accent" as string]: type.accent }}
      aria-label={data.title}
    >
      <Handle type="target" position={Position.Top} isConnectable />
      <div className="flow-node-head">
        <span className="flow-node-icon" aria-hidden="true">
          <Icon className="h-3.5 w-3.5" />
        </span>
        <span className="flow-node-title">{data.title}</span>
        {data.branching && questionId !== null ? (
          <span className="flow-node-branch-wrap">
            <button
              type="button"
              className="flow-node-branch-badge"
              title="查看/移除该节点的分支跳转"
              aria-expanded={menuOpen}
              onClick={(event) => {
                event.stopPropagation();
                setMenuOpen((open) => !open);
              }}
            >
              分支
            </button>
            {menuOpen ? (
              <span className="flow-node-branch-menu" onClick={(event) => event.stopPropagation()}>
                {(data.branches ?? []).map((branch) => (
                  <span key={branch.targetId} className="flow-node-branch-item">
                    <span className="flow-node-branch-label">{branch.label}</span>
                    <button
                      type="button"
                      className="flow-node-branch-remove"
                      aria-label={`移除${branch.label}`}
                      onClick={() => {
                        removeBranch(questionId, branch.targetId);
                        setMenuOpen(false);
                      }}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </span>
            ) : null}
          </span>
        ) : null}
      </div>
      <div className="flow-node-meta">
        {data.required ? <span className="flow-node-required">必答</span> : null}
        <span>{data.meta}</span>
      </div>
      <Handle type="source" position={Position.Bottom} isConnectable />
    </div>
  );
});

export const EntryNode = memo(function EntryNode() {
  return (
    <div className="flow-node is-synthetic" style={{ ["--flow-accent" as string]: SYNTHETIC_NODES.entry.accent }}>
      <div className="flow-node-head">
        <span className="flow-node-icon" aria-hidden="true">
          <Play className="h-3.5 w-3.5" />
        </span>
        <span className="flow-node-title">开始作答</span>
      </div>
      <div className="flow-node-meta">
        <span>entry</span>
      </div>
      <Handle type="source" position={Position.Bottom} isConnectable />
    </div>
  );
});

export const PageNode = memo(function PageNode({ data }: { data: GraphNode["data"] }) {
  return (
    <div className="flow-node is-synthetic is-page" style={{ ["--flow-accent" as string]: SYNTHETIC_NODES.page.accent }}>
      <div className="flow-node-head">
        <span className="flow-node-title">{data.title}</span>
      </div>
      <Handle type="target" position={Position.Top} isConnectable />
      <Handle type="source" position={Position.Bottom} isConnectable />
    </div>
  );
});

export const EndingNode = memo(function EndingNode() {
  return (
    <div className="flow-node is-synthetic" style={{ ["--flow-accent" as string]: SYNTHETIC_NODES.ending.accent }}>
      <Handle type="target" position={Position.Top} isConnectable />
      <div className="flow-node-head">
        <span className="flow-node-icon" aria-hidden="true">
          <PartyPopper className="h-3.5 w-3.5" />
        </span>
        <span className="flow-node-title">结束幕</span>
      </div>
      <div className="flow-node-meta">
        <span>提交问卷 · 认证卡挂钩</span>
      </div>
    </div>
  );
});
