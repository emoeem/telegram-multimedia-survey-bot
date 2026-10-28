/**
 * S5 命令日志的合并判定（纯函数，可单测）。
 *
 * 快照式 undo 的语义目标：一串连续同类编辑（打字）只产生一个撤销步骤——
 * Ctrl+Z 一次回到这串编辑开始之前。判定规则（交接文档 S5 的 coalesceKey
 * 800ms 窗口）：
 *  - 同一目标（同 questionId 的同 label 操作）且距上一条 < 800ms → 合并；
 *  - label 不同、间隔超窗、或中间插入过结构性命令 → 不合并。
 */

export const HISTORY_COALESCE_WINDOW_MS = 800;

export function shouldCoalesceHistory(last: { label: string; at: number } | null, label: string, now: number): boolean {
  if (!last) return false;
  return last.label === label && now - last.at < HISTORY_COALESCE_WINDOW_MS;
}

/** 相邻同路径 PATCH 是否可合并为一条待保存操作（后写字段胜出）。 */
export function canMergePendingPatch(
  last: { method: string; path: string } | null,
  next: { method: string; path: string },
): boolean {
  return Boolean(last && last.method === "PATCH" && next.method === "PATCH" && last.path === next.path);
}
