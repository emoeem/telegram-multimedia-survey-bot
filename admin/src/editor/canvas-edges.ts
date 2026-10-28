import type { EditableQuestion } from "./useSurveyEditor";

/**
 * S6 画布连线的数据层（纯函数）：从 condition 四区段提取「题目 → 题目」的边。
 * 只保留**向后**的目标（与引擎一致：跳转只允许向后，向前/自环不画）。
 * 跨页连线留 v2——这里不过滤 pageId，由渲染层决定（画布按全序列出，页内页外
 * 用样式区分是下一步；本轮画布按平铺序列呈现，无分页分组）。
 */

export type EdgeKind = "option" | "flagJump" | "answerRule" | "skipTo";

export interface CanvasEdge {
  fromId: number;
  toId: number;
  kind: EdgeKind;
  /** 悬浮提示：说明这条边是什么规则。 */
  label: string;
}

function num(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function buildCanvasEdges(questions: EditableQuestion[]): CanvasEdge[] {
  const byId = new Map(questions.map((question) => [question.id, question]));
  const edges: CanvasEdge[] = [];
  for (const question of questions) {
    const condition = question.condition as Record<string, unknown> | null;
    if (!condition) continue;
    const push = (targetId: unknown, kind: EdgeKind, label: string) => {
      const toId = num(targetId);
      if (toId === null || toId === question.id) return;
      const target = byId.get(toId);
      if (!target || target.order <= question.order) return; // 只向后
      edges.push({ fromId: question.id, toId, kind, label });
    };
    if (Array.isArray(condition.rules)) {
      for (const rule of condition.rules as Array<Record<string, unknown>>) {
        push(rule.targetQuestionId, "option", `选项 #${String(rule.optionId ?? "?")} 选择后跳转`);
      }
    }
    if (num(condition.skipToQuestionId) !== null) {
      push(condition.skipToQuestionId, "skipTo", "默认跳转");
    }
    if (Array.isArray(condition.answerRules)) {
      for (const rule of condition.answerRules as Array<Record<string, unknown>>) {
        push(rule.targetQuestionId, "answerRule", `第 ${String(rule.questionId ?? "?")} 题答案条件跳转`);
      }
    }
    if (Array.isArray(condition.flagJumps)) {
      for (const jump of condition.flagJumps as Array<Record<string, unknown>>) {
        push(jump.targetQuestionId, "flagJump", `flag「${String(jump.flag ?? "?")}」≥ ${String(jump.gte ?? "?")} 跳转`);
      }
    }
  }
  return edges;
}
