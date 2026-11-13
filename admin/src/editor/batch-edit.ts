/**
 * 结构树多选批量操作（G7b）的纯计划函数：给定选中题与批量字段，算出
 * 「确实要改」的按题 PATCH 列表。跳过无需变更的题（不发空请求），调用方
 * 一次 recordHistory + 一次 setOps 整批入队——一次批量 = 一步撤销。
 */

/** 批量更新的字段：必答开关与所属分页（数据形状与 question PATCH 校验一致）。 */
export interface BatchQuestionPatch {
  required?: boolean;
  /** 正整数 = 分页 id；null = 不分页。 */
  pageId?: number | null;
}

export interface BatchQuestionUpdate {
  id: number;
  body: Record<string, unknown>;
}

export interface BatchPlanQuestion {
  id: number;
  type: string;
  required: boolean;
  pageId: number | null;
}

/**
 * 生成按题 PATCH 计划，按问卷现有题目顺序输出（与结构树展示顺序一致）。
 * 规则与运行时语义对齐：
 *  - note（剧情）题服务端强制 required=false（validateQuestionPayload 的
 *    isNote 分支），批量必答跳过它们，避免本地状态与库里真值漂移；
 *  - pageId 只接受正整数或 null，形状不对的字段不进请求（服务端会整包拒绝）。
 */
export function planBatchQuestionUpdates(
  questions: readonly BatchPlanQuestion[],
  questionIds: readonly number[],
  patch: BatchQuestionPatch,
): BatchQuestionUpdate[] {
  const wanted = new Set(questionIds);
  const updates: BatchQuestionUpdate[] = [];
  for (const question of questions) {
    if (!wanted.has(question.id)) continue;
    const body: Record<string, unknown> = {};
    if (patch.required !== undefined && question.type !== "note" && question.required !== patch.required) {
      body.required = patch.required;
    }
    if (patch.pageId !== undefined && question.pageId !== patch.pageId) {
      const pageId = patch.pageId;
      if (pageId === null || (Number.isInteger(pageId) && pageId > 0)) {
        body.pageId = pageId;
      }
    }
    if (Object.keys(body).length > 0) updates.push({ id: question.id, body });
  }
  return updates;
}
