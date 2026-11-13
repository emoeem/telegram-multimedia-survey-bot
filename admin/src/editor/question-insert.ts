import type { QuestionDraft } from "./templates";

/** 可排序实体最小形状（EditableQuestion 满足）；纯函数模块，保持无 React 依赖。 */
export interface InsertableQuestion {
  id: number;
  order: number;
}

/** 与 useSurveyEditor.addQuestion 的入参同形（结构类型，QuestionDraft 可直接赋值）。 */
export interface QuestionInsertDraft {
  type: string;
  title: string;
  options?: { label: string }[];
  columns?: string[];
  gamePackId?: number | null;
  /** 其它 settings（按题型/插件自定义）；与 gamePackId 二选一使用。 */
  settings?: Record<string, unknown>;
}

/**
 * 「在此后插入」（G7a）的纯插入：把新题放到 anchor 之后，并把全量 order
 * 重排为 0..n-1。anchor 不存在（已被删除/未知 id）时返回 null，调用方
 * 回退为「追加到末尾」的既有 addQuestion 路径。
 */
export function insertQuestionAfter<T extends InsertableQuestion>(
  questions: readonly T[],
  anchorId: number,
  inserted: T,
): T[] | null {
  const index = questions.findIndex((question) => question.id === anchorId);
  if (index < 0) return null;
  const next = [...questions.slice(0, index + 1), inserted, ...questions.slice(index + 1)];
  // order 变了才新建对象：未受影响的行保持引用不变，下游 memo 不整体失效。
  return next.map((question, order) => (question.order === order ? question : { ...question, order }));
}

/**
 * 创建题目的 POST body：addQuestion（追加末尾，pageId=null）与
 * insertQuestionAfter（继承锚点分页）共用同一份构造，避免两条路径的
 * settings 持久化约定漂移——settings 只在题型需要时下发（matrix 列 /
 * game 任务包），其余题型留给编辑器写入。
 */
export function questionCreateBody(draft: QuestionInsertDraft, pageId: number | null): Record<string, unknown> {
  return {
    type: draft.type,
    title: draft.title,
    required: true,
    ...(pageId !== null ? { pageId } : {}),
    ...(draft.options?.length ? { options: draft.options } : {}),
    ...(draft.settings
      ? { settings: draft.settings }
      : draft.type === "matrix" && draft.columns?.length
        ? { settings: { columns: draft.columns } }
        : draft.type === "game" && draft.gamePackId
          ? { settings: { game: { packId: draft.gamePackId } } }
          : {}),
  };
}
