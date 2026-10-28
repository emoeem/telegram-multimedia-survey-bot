/**
 * 编辑器里的"组件依赖"分析：谁跳向它、它跳向谁。
 *
 * 删除一个题目时，其他题目的 condition 里可能还指着它——直接删会留下悬空
 * 跳转（引擎向前查找落空，答题者被静默送进线性顺序）。这里把引用找出来，
 * 供删除确认弹窗展示影响面，并生成"清掉这些引用"的补丁。
 *
 * 数据形状以 src/survey/schema.ts 的 SurveyCondition 为准，同时兼容管理端
 * 从 DB 读回来的数字 id 形态。
 */

export interface EditableConditionQuestion {
  id: number;
  title: string;
  condition: Record<string, unknown> | null;
}

export type DependencyKind = "option" | "answerRule" | "flagJump" | "skipTo";

export interface DependencyRef {
  /** 引用方（"谁指过来"）的题目 id。 */
  fromId: number;
  fromTitle: string;
  kind: DependencyKind;
  /** 人话描述，用于确认弹窗逐条列出。 */
  detail: string;
}

interface RawRule {
  optionId?: unknown;
  questionId?: unknown;
  equals?: unknown;
  targetQuestionId?: unknown;
}

function num(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function ruleTargets(condition: Record<string, unknown>, questionId: number): DependencyRef[] {
  const refs: DependencyRef[] = [];

  if (Array.isArray(condition.rules)) {
    for (const rule of condition.rules as RawRule[]) {
      if (num(rule.targetQuestionId) === questionId) {
        refs.push({
          fromId: 0,
          fromTitle: "",
          kind: "option",
          detail: `选项 #${String(rule.optionId ?? "?")} 选择后跳转`,
        });
      }
    }
  }
  // 旧版单规则形态：optionId + skipToQuestionId。
  if (num(condition.skipToQuestionId) === questionId) {
    const optionId = condition.optionId;
    refs.push({
      fromId: 0,
      fromTitle: "",
      kind: "skipTo",
      detail: optionId === undefined ? "默认跳转" : `选项 #${String(optionId)} 选择后跳转`,
    });
  }
  if (Array.isArray(condition.answerRules)) {
    for (const rule of condition.answerRules as RawRule[]) {
      if (num(rule.targetQuestionId) === questionId) {
        refs.push({
          fromId: 0,
          fromTitle: "",
          kind: "answerRule",
          detail: `第 ${String(rule.questionId ?? "?")} 题答案 = ${String(rule.equals ?? "?")} 时跳转`,
        });
      }
    }
  }
  if (Array.isArray(condition.flagJumps)) {
    for (const jump of condition.flagJumps as Array<Record<string, unknown>>) {
      if (num(jump.targetQuestionId) === questionId) {
        refs.push({
          fromId: 0,
          fromTitle: "",
          kind: "flagJump",
          detail: `flag「${String(jump.flag ?? "?")}」≥ ${String(jump.gte ?? "?")} 时跳转`,
        });
      }
    }
  }
  return refs;
}

/** 找出所有指向 questionId 的引用（用于删除前的影响面提示）。 */
export function findDependents(
  questions: readonly EditableConditionQuestion[],
  questionId: number,
): DependencyRef[] {
  const refs: DependencyRef[] = [];
  for (const question of questions) {
    if (question.id === questionId || !question.condition) continue;
    for (const ref of ruleTargets(question.condition, questionId)) {
      refs.push({ ...ref, fromId: question.id, fromTitle: question.title || `第 ${question.id} 题` });
    }
  }
  return refs;
}

/** 找出 questionId 自己指向的后继（用于逻辑面板的"去向"列表）。 */
export function findTargets(question: EditableConditionQuestion): Array<{ targetId: number; detail: string }> {
  if (!question.condition) return [];
  const out: Array<{ targetId: number; detail: string }> = [];
  const push = (targetId: number | null, detail: string) => {
    if (targetId !== null) out.push({ targetId, detail });
  };
  if (Array.isArray(question.condition.rules)) {
    for (const rule of question.condition.rules as RawRule[]) {
      push(num(rule.targetQuestionId), `选项 #${String(rule.optionId ?? "?")} →`);
    }
  }
  push(num(question.condition.skipToQuestionId), "默认跳转 →");
  if (Array.isArray(question.condition.answerRules)) {
    for (const rule of question.condition.answerRules as RawRule[]) {
      push(num(rule.targetQuestionId), `答案条件（第 ${String(rule.questionId ?? "?")} 题）→`);
    }
  }
  if (Array.isArray(question.condition.flagJumps)) {
    for (const jump of question.condition.flagJumps as Array<Record<string, unknown>>) {
      push(num(jump.targetQuestionId), `flag「${String(jump.flag ?? "?")}」→`);
    }
  }
  return out;
}

/**
 * 删除 questionId 后要写回的补丁：清掉所有指向它的规则。
 * 返回只包含"确实要改"的题目，避免无谓的保存请求。
 */
export function stripReferences(
  questions: readonly EditableConditionQuestion[],
  questionId: number,
): Array<{ id: number; condition: Record<string, unknown> | null }> {
  const patches: Array<{ id: number; condition: Record<string, unknown> | null }> = [];
  for (const question of questions) {
    if (question.id === questionId || !question.condition) continue;
    if (ruleTargets(question.condition, questionId).length === 0) continue;

    const next: Record<string, unknown> = { ...question.condition };
    if (Array.isArray(next.rules)) {
      next.rules = (next.rules as RawRule[]).filter((rule) => num(rule.targetQuestionId) !== questionId);
      if ((next.rules as unknown[]).length === 0) delete next.rules;
    }
    if (Array.isArray(next.answerRules)) {
      next.answerRules = (next.answerRules as RawRule[]).filter((rule) => num(rule.targetQuestionId) !== questionId);
      if ((next.answerRules as unknown[]).length === 0) delete next.answerRules;
    }
    if (Array.isArray(next.flagJumps)) {
      next.flagJumps = (next.flagJumps as Array<Record<string, unknown>>).filter(
        (jump) => num(jump.targetQuestionId) !== questionId,
      );
      if ((next.flagJumps as unknown[]).length === 0) delete next.flagJumps;
    }
    if (num(next.skipToQuestionId) === questionId) delete next.skipToQuestionId;

    // 只剩 kind 之类的空壳时整体置空，避免引擎读到"有 condition 但没规则"。
    const empty = !next.rules && !next.answerRules && !next.flagJumps && next.skipToQuestionId === undefined;
    patches.push({ id: question.id, condition: empty ? null : next });
  }
  return patches;
}
