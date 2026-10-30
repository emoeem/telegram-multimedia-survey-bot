import { createContext, useContext } from "react";

/**
 * 节点动作上下文：React Flow 的 nodeTypes 由 RF 渲染、无法直接传 props，
 * 节点内的交互动作（分支角标菜单 → 移除跳转）经 Context 下发。
 * Shell 侧实现为 disconnectCommand → condition 补丁（见 commands.ts）。
 */
export interface NodeActions {
  removeBranch: (questionId: number, targetId: number) => void;
}

export const NodeActionsContext = createContext<NodeActions>({
  removeBranch: () => undefined,
});

export function useNodeActions(): NodeActions {
  return useContext(NodeActionsContext);
}
