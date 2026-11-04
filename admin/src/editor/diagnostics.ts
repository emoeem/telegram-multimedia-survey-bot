/**
 * 编辑器「问卷体检」：把引擎会静默失败、但保存不会报错的结构问题提前找出来。
 *
 * 纯函数、无 React 依赖，输入是编辑器快照里和结构相关的字段。规则与
 * `src/survey/engine.ts` 的运行时语义对齐：
 *  - 跳转目标必须存在，且只能是向后（forwardTarget 会丢弃 index <= 当前题）；
 *  - answerRules / flagRules 引用的 questionId 必须存在；
 *  - flagJumps 消费的 flag 必须真的会被某条 flagRules 产出，否则永不触发。
 *
 * 这里只报告、不自动修复：所有修复都走编辑器既有的 patch/undo 队列，避免
 * 体检悄悄改数据。
 */

export type DiagnosticSeverity = "error" | "warning" | "info";

export interface DiagnosticQuestion {
  id: number;
  type: string;
  title: string;
  required: boolean;
  order: number;
  options: Array<{ id: number; label: string }>;
  columns: string[];
  condition: Record<string, unknown> | null;
  gamePackId?: number | null;
}

export interface DiagnosticIssue {
  /** 稳定 key：同一问题在多次体检之间保持不变，供列表 key / 后续定位。 */
  key: string;
  severity: DiagnosticSeverity;
  /** 人话标题，列表主行。 */
  title: string;
  /** 展开后的细节：为什么、引擎会怎样。 */
  detail: string;
  questionId: number | null;
  questionTitle: string;
}

interface RawRule {
  optionId?: unknown;
  questionId?: unknown;
  equals?: unknown;
  targetQuestionId?: unknown;
  flag?: unknown;
  gte?: unknown;
}

const OPTION_REQUIRED_TYPES = new Set(["single", "multiple"]);

function positiveInt(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function optionLabel(question: DiagnosticQuestion, optionId: unknown): string {
  const id = positiveInt(optionId);
  if (id === null) return "选项";
  const option = question.options.find((item) => item.id === id);
  return option?.label?.trim() || `选项 #${id}`;
}

function questionLabel(question: DiagnosticQuestion | undefined, id: number): string {
  return question?.title?.trim() || `第 ${id} 题`;
}

/** 收集整卷体检结果，按题目顺序 + 严重度排序。 */
export function collectDiagnostics(questions: readonly DiagnosticQuestion[]): DiagnosticIssue[] {
  const issues: DiagnosticIssue[] = [];
  const indexById = new Map(questions.map((question, index) => [question.id, index]));
  const questionById = new Map(questions.map((question) => [question.id, question]));
  const producedFlags = new Set<string>();

  const push = (
    question: DiagnosticQuestion,
    severity: DiagnosticSeverity,
    code: string,
    title: string,
    detail: string,
    suffix = "",
  ) => {
    issues.push({
      key: `${code}:${question.id}${suffix}`,
      severity,
      title,
      detail,
      questionId: question.id,
      questionTitle: questionLabel(question, question.id),
    });
  };

  // 第一遍：先收齐所有 flagRules 产出的 flag 名，第二遍的 flagJumps 才能校验。
  for (const question of questions) {
    if (!question.condition) continue;
    const rules = question.condition.flagRules;
    if (!Array.isArray(rules)) continue;
    for (const rule of rules as RawRule[]) {
      if (typeof rule.flag === "string" && rule.flag.trim()) producedFlags.add(rule.flag.trim());
    }
  }

  for (const question of questions) {
    const order = indexById.get(question.id) ?? question.order;

    if (!question.title.trim()) {
      push(
        question,
        "warning",
        "empty-title",
        "题面为空",
        "答题者会看到一张没有标题的卡片；补一句题面或改成叙述节点。",
      );
    }

    if (OPTION_REQUIRED_TYPES.has(question.type)) {
      if (question.options.length === 0) {
        push(question, "error", "no-options", "选择题没有选项", "引擎没有可渲染的选项，答题者无法作答。");
      }
      const seen = new Map<string, number>();
      for (const option of question.options) {
        const label = option.label.trim();
        if (!label) {
          push(
            question,
            "warning",
            "empty-option",
            "选项文案为空",
            `选项 #${option.id} 没有文字，答题者只会看到一个空行。`,
            `:${option.id}`,
          );
          continue;
        }
        const first = seen.get(label);
        if (first !== undefined) {
          push(
            question,
            "warning",
            "duplicate-option",
            "选项文案重复",
            `「${label}」出现了两次（#${first} 与 #${option.id}）；按文案计分的规则会合并这两项。`,
            `:${option.id}`,
          );
        } else {
          seen.set(label, option.id);
        }
      }
    }

    if (question.type === "matrix" && question.columns.length === 0) {
      push(question, "error", "no-columns", "矩阵题没有列", "矩阵题至少要有一列评分项，否则表格是空的。");
    }
    if (question.type === "game" && !question.gamePackId) {
      push(question, "error", "no-game-pack", "小游戏题未绑定任务包", "没有任务包时这道题无法开局。");
    }
    if (question.type === "note" && question.required) {
      push(question, "info", "note-required", "叙述节点被设为必答", "叙述节点不收集答案，必答开关在这里没有效果。");
    }

    if (!question.condition) continue;
    const condition = question.condition;
    const checkTarget = (targetRaw: unknown, label: string, suffix: string) => {
      const targetId = positiveInt(targetRaw);
      if (targetId === null) return;
      const target = questionById.get(targetId);
      if (!target) {
        push(
          question,
          "error",
          "dangling-target",
          "跳转目标不存在",
          `${label}指向第 ${targetId} 题，但这份问卷里没有这道题；引擎会静默回落到下一题。`,
          suffix,
        );
        return;
      }
      const targetOrder = indexById.get(targetId) ?? target.order;
      if (targetOrder <= order) {
        push(
          question,
          "warning",
          "backward-target",
          "跳转目标不会生效",
          `${label}指向「${questionLabel(target, targetId)}」，但它不在当前题之后；引擎只接受向后跳转，会忽略这条规则。`,
          suffix,
        );
      }
    };

    if (Array.isArray(condition.rules)) {
      for (const rule of condition.rules as RawRule[]) {
        checkTarget(
          rule.targetQuestionId,
          `选项「${optionLabel(question, rule.optionId)}」的跳转`,
          `:rule:${String(rule.optionId ?? "?")}`,
        );
      }
    }
    if (condition.skipToQuestionId !== undefined) {
      checkTarget(condition.skipToQuestionId, condition.optionId === undefined ? "默认跳转" : "选项跳转", ":skip");
    }
    if (Array.isArray(condition.answerRules)) {
      for (const rule of condition.answerRules as RawRule[]) {
        const sourceId = positiveInt(rule.questionId);
        if (sourceId !== null && !questionById.has(sourceId)) {
          push(
            question,
            "error",
            "missing-answer-source",
            "答案条件引用了不存在的题",
            `条件读取第 ${sourceId} 题的答案，但这份问卷里没有这道题；这条跳转永远不会触发。`,
            `:answer:${sourceId}`,
          );
        }
        checkTarget(
          rule.targetQuestionId,
          `答案条件（第 ${sourceId ?? "?"} 题）的跳转`,
          `:answer:${sourceId ?? "?"}:${String(rule.equals ?? "?")}`,
        );
      }
    }
    if (Array.isArray(condition.flagRules)) {
      for (const rule of condition.flagRules as RawRule[]) {
        if (rule.flag !== undefined && !String(rule.flag).trim()) {
          push(question, "warning", "empty-flag", "flag 名为空", "这条计分规则不会产出任何 flag。");
        }
        const sourceId = positiveInt(rule.questionId);
        if (sourceId !== null && !questionById.has(sourceId)) {
          push(
            question,
            "error",
            "missing-flag-source",
            "flag 规则引用了不存在的题",
            `规则读取第 ${sourceId} 题的答案，但这份问卷里没有这道题；这个 flag 永远拿不到分。`,
            `:flag:${sourceId}:${String(rule.flag ?? "?")}`,
          );
        }
      }
    }
    if (Array.isArray(condition.flagJumps)) {
      for (const jump of condition.flagJumps as RawRule[]) {
        const flag = typeof jump.flag === "string" ? jump.flag.trim() : "";
        if (!flag) {
          push(question, "warning", "empty-flag-jump", "flag 跳转缺少 flag 名", "没有 flag 名时这条跳转不会被评估。");
        } else if (!producedFlags.has(flag)) {
          push(
            question,
            "warning",
            "unknown-flag",
            "flag 没有来源",
            `没有任何 flagRules 会产出「${flag}」；这条跳转永远不会满足。`,
            `:${flag}`,
          );
        }
        checkTarget(
          jump.targetQuestionId,
          `flag「${flag || "?"}」的跳转`,
          `:flagjump:${flag}:${String(jump.gte ?? "?")}`,
        );
      }
    }
  }

  // 重复题面：只标后出现的那一道，避免两条互相指着对方。
  const seenTitle = new Map<string, number>();
  for (const question of questions) {
    const title = question.title.trim();
    if (!title) continue;
    const first = seenTitle.get(title);
    if (first !== undefined) {
      push(
        question,
        "warning",
        "duplicate-title",
        "题面重复",
        `和第 ${first} 题用了同一个题面；列表和报告里容易看混。`,
        `:${first}`,
      );
    } else {
      seenTitle.set(title, question.id);
    }
  }

  const severityRank: Record<DiagnosticSeverity, number> = { error: 0, warning: 1, info: 2 };
  return issues.sort((a, b) => {
    const aOrder = a.questionId === null ? Number.MAX_SAFE_INTEGER : (indexById.get(a.questionId) ?? a.questionId);
    const bOrder = b.questionId === null ? Number.MAX_SAFE_INTEGER : (indexById.get(b.questionId) ?? b.questionId);
    if (aOrder !== bOrder) return aOrder - bOrder;
    return severityRank[a.severity] - severityRank[b.severity];
  });
}

export function countDiagnostics(issues: readonly DiagnosticIssue[]): {
  total: number;
  errors: number;
  warnings: number;
} {
  let errors = 0;
  let warnings = 0;
  for (const issue of issues) {
    if (issue.severity === "error") errors += 1;
    else if (issue.severity === "warning") warnings += 1;
  }
  return { total: issues.length, errors, warnings };
}
