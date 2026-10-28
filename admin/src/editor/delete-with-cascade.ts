import { findDependents, stripReferences, type DependencyRef } from "./dependencies";

/**
 * 删除题目的级联计划（纯函数，两套壳共用同一套语义）：
 * 先算影响面（哪些题的跳转指向它），再生成清引用补丁。
 * 确认后：逐题 patchQuestionLocal + queueQuestionPatch 清引用，
 * 最后 deleteQuestion —— 全部在同一批待保存操作里，Ctrl+Z 可整体回退。
 */
export interface DeleteCascadePlan {
  /** 指向被删题目的引用（选项跳转 / 答案规则 / flag 跳转 / 旧式 skipTo）。 */
  dependents: DependencyRef[];
  /** 清引用补丁：对每道引用方题目给出删除后的 condition。 */
  patches: Array<{ id: number; condition: Record<string, unknown> | null }>;
}

export function planQuestionDeletion(
  questions: Array<{ id: number; title: string; condition: Record<string, unknown> | null }>,
  questionId: number,
): DeleteCascadePlan {
  const dependents = findDependents(questions, questionId);
  const patches = dependents.length > 0 ? stripReferences(questions, questionId) : [];
  return { dependents, patches };
}

/** 影响面确认框的正文（列出前 6 条引用）。 */
export function deletionConfirmMessage(plan: DeleteCascadePlan, targetTitle: string): string {
  const lines = plan.dependents
    .slice(0, 6)
    .map((ref) => `· ${ref.fromTitle}：${ref.detail}`)
    .join("\n");
  return `有 ${plan.dependents.length} 条跳转指向「${targetTitle}」：\n${lines}${
    plan.dependents.length > 6 ? "\n…" : ""
  }\n\n删除后会一并清除这些跳转（可用撤销恢复）。`;
}
