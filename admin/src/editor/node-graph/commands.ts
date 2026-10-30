import type { Connection } from "@xyflow/react";

/** 连线端点（Connection 的最小形状，便于命令层单测与合成调用）。 */
export interface EndpointPair {
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

/**
 * 图操作 → 问卷命令（A1 双向映射的写向，纯函数）。
 *
 * 铁律：画布不发明写路径。连线/删线映射为 question 的 **condition 补丁**
 * （`patchQuestionLocal` + `queueQuestionPatch`，与旧壳逻辑面板同一条
 * 持久化语义）；顺序流的增删仍由列表模式排序管理，画布不碰 order。
 *
 * 连线语义（2026-10-30 决策）：source→target = 该题的「默认跳转」
 * （condition.skipToQuestionId）。选项级分支（选 A 跳 X、选 B 跳 Y）
 * 是每题多目标的结构，留在 LogicLayer / 属性面板配置——一条连线只承载
 * 一个语义，才能保证删除时精确可逆。
 */

/** 最小题目形状（编辑器的 EditableQuestion 天然满足）。 */
export interface CommandQuestion {
  id: number;
  condition: Record<string, unknown> | null;
}

export interface ConditionCommand {
  questionId: number;
  /** 下一个 condition 整体（补丁按整字段覆盖，与逻辑面板一致）。 */
  nextCondition: Record<string, unknown>;
  /** 待保存操作的描述（撤销提示 / 操作日志用）。 */
  label: string;
}

function questionIdOf(nodeId: string | null | undefined): number | null {
  if (!nodeId?.startsWith("q")) return null;
  const id = Number(nodeId.slice(1));
  // 负数 id 是「同批创建」的临时实体（保存管线会 remap 成真实 id）。
  return Number.isInteger(id) && id !== 0 ? id : null;
}

/** 连线是否合法：题目→题目，且不允许自环（只许向后跳的校验交给保存端）。 */
export function canConnect(connection: EndpointPair, questions: CommandQuestion[]): boolean {
  const source = questionIdOf(connection.source);
  const target = questionIdOf(connection.target);
  if (source === null || target === null || source === target) return false;
  return questions.some((question) => question.id === source);
}

/** 连线 → 该题 skipToQuestionId 的补丁。 */
export function connectCommand(connection: EndpointPair, questions: CommandQuestion[]): ConditionCommand | null {
  if (!canConnect(connection, questions)) return null;
  const source = questionIdOf(connection.source)!;
  const target = questionIdOf(connection.target)!;
  const question = questions.find((item) => item.id === source);
  const nextCondition = { ...(question?.condition ?? {}), skipToQuestionId: target };
  return { questionId: source, nextCondition, label: `默认跳转 → 第 ${target} 题` };
}

/** 删边 → 条件补丁。只处理条件边（sequence 是顺序流，由排序管理）。 */
export function disconnectCommand(edge: { source: string | null; target: string | null }, questions: CommandQuestion[]): ConditionCommand | null {
  const source = questionIdOf(edge.source);
  const target = questionIdOf(edge.target);
  if (source === null || target === null) return null;
  const question = questions.find((item) => item.id === source);
  const condition = question?.condition ?? null;
  if (!condition) return null;
  const next: Record<string, unknown> = { ...condition };
  let changed = false;
  if (next.skipToQuestionId === target) {
    delete next.skipToQuestionId;
    changed = true;
  }
  if (Array.isArray(next.rules)) {
    const rules = next.rules as Array<Record<string, unknown>>;
    const kept = rules.filter((rule) => Number(rule.targetQuestionId) !== target);
    if (kept.length !== rules.length) {
      next.rules = kept;
      changed = true;
    }
  }
  return changed ? { questionId: source, nextCondition: next, label: `移除 → 第 ${target} 题的跳转` } : null;
}
