import type { SurveyQuestion } from "../db/schema";

/**
 * Graph-level validation for publishing branching surveys.
 *
 * The runtime engine silently ignores broken jumps (missing targets, backward
 * targets) and falls back to linear order — acceptable for a plain form, but
 * for a branching story a broken edge silently rewrites the plot. These checks
 * run at publish time so a broken graph is refused with actionable locations.
 *
 * Checks (errors block publishing):
 *  - a jump rule references an option that does not exist on the question
 *  - a jump target points to a missing question or backwards in order
 *  - a question is unreachable from the first question (orphaned branch)
 *  - condition_json is not parseable
 *
 * Reachability over-approximates: state-driven `answerRules` targets count as
 * edges even though their guard may be unsatisfiable, so conditional content
 * is never falsely reported unreachable.
 */

export type SurveyGraphNode = Pick<SurveyQuestion, "id" | "order" | "type" | "conditionJson" | "skipToQuestionId"> & {
  options: Array<{ id: number }>;
};

export interface SurveyGraphIssue {
  level: "error" | "warning";
  questionId: number | null;
  message: string;
}

interface ParsedCondition {
  kind?: string;
  optionId?: unknown;
  skipToQuestionId?: unknown;
  rules?: Array<{ optionId?: unknown; targetQuestionId?: unknown }>;
  answerRules?: Array<{ questionId?: unknown; equals?: unknown; targetQuestionId?: unknown }>;
  flagJumps?: Array<{ flag?: unknown; gte?: unknown; targetQuestionId?: unknown }>;
}

export function validateSurveyGraph(nodes: SurveyGraphNode[]): SurveyGraphIssue[] {
  const issues: SurveyGraphIssue[] = [];
  const ordered = [...nodes].sort((a, b) => a.order - b.order || a.id - b.id);
  const indexById = new Map(ordered.map((node, index) => [node.id, index]));
  const exists = (id: unknown): boolean => indexById.has(Number(id));

  const forwardTarget = (node: SurveyGraphNode, raw: unknown, label: string, edges: number[]): void => {
    const targetId = Number(raw);
    if (!Number.isInteger(targetId) || targetId <= 0) {
      issues.push({ level: "error", questionId: node.id, message: `${label}缺少有效的目标题目` });
      return;
    }
    const targetIndex = indexById.get(targetId);
    if (targetIndex === undefined) {
      issues.push({ level: "error", questionId: node.id, message: `${label}指向不存在的题目 #${targetId}` });
      return;
    }
    if (targetIndex <= indexById.get(node.id)!) {
      issues.push({
        level: "error",
        questionId: node.id,
        message: `${label}指向了当前题或更早的题（# ${targetId}）；跳转只能向前`,
      });
      return;
    }
    edges.push(targetIndex);
  };

  const edgesFrom = (node: SurveyGraphNode): number[] => {
    const index = indexById.get(node.id)!;
    const edges: number[] = [];
    const linearNext = index < ordered.length - 1 ? index + 1 : null;
    const pushLinear = (): void => {
      if (linearNext !== null) edges.push(linearNext);
    };

    let condition: ParsedCondition | null = null;
    if (node.conditionJson) {
      try {
        condition = JSON.parse(node.conditionJson) as ParsedCondition;
      } catch {
        issues.push({ level: "error", questionId: node.id, message: "跳转条件不是合法 JSON，运行时会被忽略" });
      }
    }

    if (!condition) {
      // 无条件：全部路径线性走。孤儿 skip_to 运行时不会生效。
      if (node.skipToQuestionId != null) {
        issues.push({
          level: "warning",
          questionId: node.id,
          message: "配置了 skip_to_question_id 但没有 kind: option_equals 的条件，运行时不会生效",
        });
      }
      pushLinear();
      return edges;
    }

    const optionIds = new Set(node.options.map((option) => option.id));
    const coveredOptions = new Set<number>();

    if (Array.isArray(condition.rules)) {
      for (const rule of condition.rules) {
        const optionId = Number(rule.optionId);
        if (!optionIds.has(optionId)) {
          issues.push({ level: "error", questionId: node.id, message: `跳转规则引用了本题不存在的选项 #${rule.optionId ?? "?"}` });
          continue;
        }
        coveredOptions.add(optionId);
        const before = issues.length;
        forwardTarget(node, rule.targetQuestionId, "跳转规则", edges);
        if (issues.length > before) pushLinear(); // 坏边运行时回退线性
      }
    } else if (condition.kind === "option_equals" && condition.optionId !== undefined) {
      const optionId = Number(condition.optionId);
      if (!optionIds.has(optionId)) {
        issues.push({ level: "error", questionId: node.id, message: `跳转规则引用了本题不存在的选项 #${condition.optionId ?? "?"}` });
      } else if (node.skipToQuestionId != null) {
        coveredOptions.add(optionId);
        const before = issues.length;
        forwardTarget(node, node.skipToQuestionId, "跳转规则", edges);
        if (issues.length > before) pushLinear();
      } else {
        // 没有 skip_to：跳转不生效，全部选项线性兜底
        issues.push({
          level: "warning",
          questionId: node.id,
          message: "单选项跳转缺少 skip_to_question_id，运行时不会生效",
        });
      }
    } else if (node.skipToQuestionId != null) {
      issues.push({
        level: "warning",
        questionId: node.id,
        message: "配置了 skip_to_question_id 但条件缺少 kind: option_equals，运行时不会生效",
      });
    }

    // 未被规则覆盖的选项在运行时线性兜底（同一线性边一条即可）
    for (const optionId of optionIds) {
      if (!coveredOptions.has(optionId)) {
        pushLinear();
        break;
      }
    }

    if (condition.answerRules !== undefined && !Array.isArray(condition.answerRules)) {
      issues.push({ level: "error", questionId: node.id, message: "answerRules 必须是数组" });
    } else if (Array.isArray(condition.answerRules)) {
      for (const rule of condition.answerRules) {
        if (!exists(rule.questionId)) {
          issues.push({ level: "error", questionId: node.id, message: `answerRules 引用了不存在的题目 #${rule.questionId ?? "?"}` });
        }
        const equals = Number(rule.equals);
        if (!Number.isFinite(equals) || equals <= 0) {
          issues.push({ level: "error", questionId: node.id, message: "answerRules 的 equals 必须是正数" });
        }
        forwardTarget(node, rule.targetQuestionId, "answerRules", edges);
      }
      if (node.options.length === 0) pushLinear(); // note：answerRules 不命中时线性兜底
      if (condition.answerRules.length === 0) pushLinear();
    }

    // flagJumps（P2）：门槛型跳转与 answerRules 同一处理——目标作为边进入
    // 可达性近似，门槛不可满足也不误报不可达。
    if (condition.flagJumps !== undefined && !Array.isArray(condition.flagJumps)) {
      issues.push({ level: "error", questionId: node.id, message: "flagJumps 必须是数组" });
    } else if (Array.isArray(condition.flagJumps)) {
      for (const jump of condition.flagJumps) {
        if (typeof jump.flag !== "string" || !jump.flag) {
          issues.push({ level: "error", questionId: node.id, message: "flagJumps 的 flag 必须是非空字符串" });
        }
        const threshold = Number(jump.gte);
        if (!Number.isFinite(threshold)) {
          issues.push({ level: "error", questionId: node.id, message: "flagJumps 的 gte 必须是数字" });
        }
        forwardTarget(node, jump.targetQuestionId, "flagJumps", edges);
      }
    }
    return edges;
  };

  const reachable = new Set<number>();
  const queue: number[] = ordered.length ? [0] : [];
  while (queue.length) {
    const index = queue.shift()!;
    if (reachable.has(index)) continue;
    reachable.add(index);
    for (const next of edgesFrom(ordered[index]!)) {
      if (!reachable.has(next)) queue.push(next);
    }
  }
  for (let index = 0; index < ordered.length; index++) {
    if (reachable.has(index)) continue;
    const node = ordered[index]!;
    const label = node.type === "note" ? "剧情卡" : `第 ${index + 1} 题（${node.type}）`;
    issues.push({
      level: "error",
      questionId: node.id,
      message: `${label}在流程中不可达：没有任何路径会经过它`,
    });
  }
  return issues;
}
